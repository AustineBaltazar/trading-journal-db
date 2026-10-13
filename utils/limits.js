const { rateLimit } = require("express-rate-limit");

// Most of anything one account can have. Far above real use; they stop a script
// from filling the database. A tag's account is found through its group.
const MAX_ROWS = {
  trades: { limit: 20000, label: "trades" },
  journal_entries: { limit: 5000, label: "journal days" },
  rules: { limit: 200, label: "rules" },
  mistakes: { limit: 200, label: "mistakes" },
  questions: { limit: 100, label: "review questions" },
  tag_groups: { limit: 30, label: "tag groups" },
  tags: { limit: 500, label: "tags" },
};

const COUNT_SQL = {
  tags: "SELECT count(*)::int AS n FROM tags t JOIN tag_groups g ON g.id = t.group_id WHERE g.user_id = $1",
};

// An error message when the account already has the most it can of `table`, else null
async function rowLimitProblem(db, table, userId) {
  const { limit, label } = MAX_ROWS[table];
  const sql = COUNT_SQL[table] || `SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`;
  const n = (await db.query(sql, [userId])).rows[0]?.n ?? 0;
  return n >= limit ? `You've reached the limit of ${limit.toLocaleString("en-US")} ${label}.` : null;
}

// Limits per logged-in account (after requireAuth), so they follow the account
// across networks and don't punish people who share an IP
function perUser(windowMinutes, limit, error) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.userId}`,
    message: { error },
  });
}

// Every save, edit and delete. A person journaling never gets near it.
const writeLimiter = perUser(10, 300, "You're saving very fast. Please wait a few minutes.");
// Signed upload links (each one can become a 5 MB file)
const uploadLinkLimiter = perUser(60, 60, "Too many uploads in the last hour. Please try again later.");

// Route middleware: refuse to create one more `table` row past the limit
function capRows(table) {
  return async (req, res, next) => {
    try {
      const problem = await rowLimitProblem(require("../db"), table, req.userId);
      if (problem) return res.status(400).json({ error: problem });
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Journal days are created by saving one; only a new day counts toward the limit
async function capNewJournalDay(req, res, next) {
  // A bad date is answered by the route itself
  if (!/^d{4}-d{2}-d{2}$/.test(req.params.date)) return next();
  try {
    const db = require("../db");
    const mode = req.query.mode === "backtest" ? "backtest" : "live";
    const exists = await db.query(
      "SELECT 1 FROM journal_entries WHERE user_id = $1 AND mode = $2 AND entry_date = $3",
      [req.userId, mode, req.params.date],
    );
    if (exists.rows.length) return next();
    const problem = await rowLimitProblem(db, "journal_entries", req.userId);
    if (problem) return res.status(400).json({ error: problem });
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  MAX_ROWS,
  rowLimitProblem,
  perUser,
  writeLimiter,
  uploadLinkLimiter,
  capRows,
  capNewJournalDay,
};
