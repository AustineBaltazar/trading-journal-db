const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const DRAWDOWN_TYPES = ["eod_trailing", "trailing", "static"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COLUMNS = `id, name, account_size, profit_target, max_drawdown, drawdown_type, daily_loss_limit,
  min_days, consistency_pct, started_on::text, ended_on::text, result, fail_reason`;

const money = (v) => (v === null || v === undefined ? null : Number(v));
function toAttempt(row) {
  return {
    id: Number(row.id),
    name: row.name,
    accountSize: money(row.account_size),
    profitTarget: money(row.profit_target),
    maxDrawdown: money(row.max_drawdown),
    drawdownType: row.drawdown_type,
    dailyLossLimit: money(row.daily_loss_limit),
    minDays: row.min_days,
    consistencyPct: row.consistency_pct,
    startedOn: row.started_on,
    endedOn: row.ended_on,
    result: row.result,
    failReason: row.fail_reason,
  };
}

// An optional positive amount: empty means the firm doesn't have that rule
function amount(value, label, required = false) {
  if (value === undefined || value === null || value === "") {
    return required ? { error: `${label} is required.` } : { value: null };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return { error: `${label} must be a positive amount.` };
  return { value: Math.round(n * 100) / 100 };
}
function whole(value, label, min, max) {
  if (value === undefined || value === null || value === "") return { value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return { error: `${label} must be a whole number from ${min} to ${max}.` };
  return { value: n };
}

// The rules from a request body. Returns { values } or { error }.
function parseRules(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 60) return { error: "Give the evaluation a name (up to 60 characters)." };
  const drawdownType = body.drawdownType ?? "eod_trailing";
  if (!DRAWDOWN_TYPES.includes(drawdownType)) return { error: "Unknown drawdown type." };
  if (body.startedOn !== undefined && !(typeof body.startedOn === "string" && DATE.test(body.startedOn))) {
    return { error: "Start date must be YYYY-MM-DD." };
  }
  const fields = [
    ["accountSize", amount(body.accountSize, "Account size", true)],
    ["profitTarget", amount(body.profitTarget, "Profit target")],
    ["maxDrawdown", amount(body.maxDrawdown, "Max drawdown")],
    ["dailyLossLimit", amount(body.dailyLossLimit, "Daily loss limit")],
    ["minDays", whole(body.minDays, "Minimum days", 1, 60)],
    ["consistencyPct", whole(body.consistencyPct, "Consistency", 10, 100)],
  ];
  const values = { name, drawdownType, startedOn: body.startedOn };
  for (const [key, parsed] of fields) {
    if (parsed.error) return { error: parsed.error };
    values[key] = parsed.value;
  }
  return { values };
}

const fail = (res, message) => (err) => {
  console.error(err);
  res.status(500).json({ error: message });
};

// Every attempt, newest first; the open one (if any) is `current`
router.get("/evals", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM eval_attempts WHERE user_id = $1 ORDER BY started_on DESC, id DESC`,
      [req.userId],
    );
    const attempts = rows.map(toAttempt);
    res.json({ current: attempts.find((a) => !a.endedOn) ?? null, attempts });
  } catch (err) {
    fail(res, "Something went wrong loading your evaluation.")(err);
  }
});

// Start an evaluation (only one can be open)
router.post("/evals", requireAuth, async (req, res) => {
  const { values: v, error } = parseRules(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const { rows } = await pool.query(
      `INSERT INTO eval_attempts (user_id, name, account_size, profit_target, max_drawdown, drawdown_type,
         daily_loss_limit, min_days, consistency_pct, started_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::date, current_date))
       RETURNING ${COLUMNS}`,
      [req.userId, v.name, v.accountSize, v.profitTarget, v.maxDrawdown, v.drawdownType, v.dailyLossLimit, v.minDays, v.consistencyPct, v.startedOn ?? null],
    );
    res.status(201).json({ attempt: toAttempt(rows[0]) });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "You already have an evaluation in progress." });
    fail(res, "Something went wrong starting the evaluation.")(err);
  }
});

// Change the rules (or start date) of an attempt
router.put("/evals/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Evaluation not found." });
  const { values: v, error } = parseRules(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const { rows } = await pool.query(
      `UPDATE eval_attempts SET name = $3, account_size = $4, profit_target = $5, max_drawdown = $6,
         drawdown_type = $7, daily_loss_limit = $8, min_days = $9, consistency_pct = $10,
         started_on = coalesce($11::date, started_on), updated_at = now()
       WHERE id = $1 AND user_id = $2 AND (ended_on IS NULL OR coalesce($11::date, started_on) <= ended_on)
       RETURNING ${COLUMNS}`,
      [id, req.userId, v.name, v.accountSize, v.profitTarget, v.maxDrawdown, v.drawdownType, v.dailyLossLimit, v.minDays, v.consistencyPct, v.startedOn ?? null],
    );
    if (!rows[0]) return res.status(404).json({ error: "Evaluation not found." });
    res.json({ attempt: toAttempt(rows[0]) });
  } catch (err) {
    fail(res, "Something went wrong saving the rules.")(err);
  }
});

// End the open attempt as passed or failed; optionally start the next one
// the same day with the same rules
router.post("/evals/:id/end", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Evaluation not found." });
  const result = req.body?.result;
  if (!["passed", "failed"].includes(result)) return res.status(400).json({ error: "Pick Passed or Failed." });
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 200) || null : null;
  const endedOn = req.body?.endedOn;
  if (endedOn !== undefined && !(typeof endedOn === "string" && DATE.test(endedOn))) {
    return res.status(400).json({ error: "End date must be YYYY-MM-DD." });
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const ended = await db.query(
      `UPDATE eval_attempts SET ended_on = greatest(started_on, coalesce($3::date, current_date)), result = $4,
         fail_reason = $5, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND ended_on IS NULL
       RETURNING ${COLUMNS}`,
      [id, req.userId, endedOn ?? null, result, result === "failed" ? reason : null],
    );
    if (!ended.rows[0]) {
      await db.query("ROLLBACK");
      return res.status(404).json({ error: "No evaluation in progress with that id." });
    }
    let next = null;
    if (req.body?.startNext) {
      const r = await db.query(
        `INSERT INTO eval_attempts (user_id, name, account_size, profit_target, max_drawdown, drawdown_type,
           daily_loss_limit, min_days, consistency_pct, started_on)
         SELECT user_id, name, account_size, profit_target, max_drawdown, drawdown_type,
           daily_loss_limit, min_days, consistency_pct, greatest(current_date, ended_on)
         FROM eval_attempts WHERE id = $1
         RETURNING ${COLUMNS}`,
        [id],
      );
      next = toAttempt(r.rows[0]);
    }
    await db.query("COMMIT");
    res.json({ ended: toAttempt(ended.rows[0]), next });
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    fail(res, "Something went wrong ending the evaluation.")(err);
  } finally {
    db.release();
  }
});

// Remove an attempt (its trades stay in the Eval journal)
router.delete("/evals/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Evaluation not found." });
  try {
    const r = await pool.query("DELETE FROM eval_attempts WHERE id = $1 AND user_id = $2", [id, req.userId]);
    if (!r.rowCount) return res.status(404).json({ error: "Evaluation not found." });
    res.status(204).end();
  } catch (err) {
    fail(res, "Something went wrong deleting the evaluation.")(err);
  }
});

module.exports = router;
module.exports.parseRules = parseRules;
