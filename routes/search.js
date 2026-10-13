const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { withPnl, summarize } = require("../utils/outcome");
const { TRADE_COLUMNS, parseMode } = require("../utils/tradeFields");
const { parseRange } = require("../utils/range");

const MAX_RESULTS = 200;

// Journal fields that can be searched, and how they're labeled in results
const JOURNAL_FIELDS = [
  ["bias_reason", "Why"],
  ["plan", "Plan"],
  ["news", "News"],
  ["focus", "Focus"],
  ["went_well", "Went well"],
  ["to_fix", "What to fix"],
  ["lesson", "Lesson"],
];

// A short piece of text around the first match, so the result shows the word in context
function snippet(text, q, width = 150) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0 || flat.length <= width) return flat.length <= width ? flat : flat.slice(0, width) + "…";
  const start = Math.max(0, at - 50);
  const end = Math.min(flat.length, start + width);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

const has = (text, q) => typeof text === "string" && text.toLowerCase().includes(q.toLowerCase());

// Everything you've written that mentions q: trade notes, strategy and screenshot
// captions, and journal days (plan, review, key levels, chart captions). The trades
// that match are also summed up next to your overall numbers for the same range.
router.get("/search", requireAuth, async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (q.length < 2) return res.status(400).json({ error: "Type at least 2 characters." });
  const { mode, error } = parseMode(req.query.mode);
  if (error) return res.status(400).json({ error });
  const range = parseRange(req.query);
  if (range.error) return res.status(400).json({ error: range.error });

  // Matched literally: % and _ in the search are not wildcards
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const params = [req.userId, mode, range.from, range.to];
  const inRange = (col) =>
    `($3::date IS NULL OR ${col} >= $3::date) AND ($4::date IS NULL OR ${col} <= $4::date)`;

  try {
    const [tradeRows, captionRows, allTradeRows, entryRows, journalCaptionRows] = await Promise.all([
      pool.query(
        `SELECT ${TRADE_COLUMNS} FROM trades
         WHERE user_id = $1 AND mode = $2 AND ${inRange("trade_date")}
           AND (notes ILIKE $5 OR strategy ILIKE $5
             OR EXISTS (SELECT 1 FROM trade_images i WHERE i.trade_id = trades.id AND i.caption ILIKE $5))
         ORDER BY trade_date DESC, entry_time DESC NULLS LAST, id DESC`,
        [...params, like],
      ),
      pool.query(
        `SELECT i.trade_id, i.caption FROM trade_images i JOIN trades t ON t.id = i.trade_id
         WHERE t.user_id = $1 AND t.mode = $2 AND i.caption ILIKE $3`,
        [req.userId, mode, like],
      ),
      pool.query(
        `SELECT ${TRADE_COLUMNS} FROM trades WHERE user_id = $1 AND mode = $2 AND ${inRange("trade_date")}`,
        params,
      ),
      pool.query(
        `SELECT id, entry_date::text AS date, ${JOURNAL_FIELDS.map(([c]) => c).join(", ")}, key_levels
         FROM journal_entries
         WHERE user_id = $1 AND mode = $2 AND ${inRange("entry_date")}
           AND (${JOURNAL_FIELDS.map(([c]) => `${c} ILIKE $5`).join(" OR ")}
             OR key_levels::text ILIKE $5
             OR EXISTS (SELECT 1 FROM journal_images i WHERE i.entry_id = journal_entries.id AND i.caption ILIKE $5))
         ORDER BY entry_date DESC`,
        [...params, like],
      ),
      pool.query(
        `SELECT i.entry_id, i.section, i.caption FROM journal_images i JOIN journal_entries e ON e.id = i.entry_id
         WHERE e.user_id = $1 AND e.mode = $2 AND i.caption ILIKE $3`,
        [req.userId, mode, like],
      ),
    ]);

    const trades = tradeRows.rows.map(withPnl);
    const tradeCaptions = new Map(captionRows.rows.map((r) => [r.trade_id, r.caption]));
    const tradeResults = trades.map((t) => {
      const field = has(t.notes, q) ? "Notes" : has(t.strategy, q) ? "Strategy" : "Screenshot caption";
      const text = field === "Notes" ? t.notes : field === "Strategy" ? t.strategy : tradeCaptions.get(t.id);
      return {
        type: "trade",
        id: t.id,
        date: t.trade_date,
        time: t.entry_time,
        direction: t.direction,
        netPnl: t.netPnl,
        outcome: t.outcome,
        field,
        snippet: snippet(text ?? "", q),
      };
    });

    // A journal day can match in several places; each one is its own result
    const all = allTradeRows.rows.map(withPnl);
    const dayNet = new Map();
    for (const t of all) dayNet.set(t.trade_date, Math.round(((dayNet.get(t.trade_date) ?? 0) + t.netPnl) * 100) / 100);
    const captionsByEntry = new Map();
    for (const r of journalCaptionRows.rows) {
      if (!captionsByEntry.has(r.entry_id)) captionsByEntry.set(r.entry_id, []);
      captionsByEntry.get(r.entry_id).push(r);
    }
    const journalResults = [];
    for (const e of entryRows.rows) {
      const hit = (field, text) =>
        journalResults.push({ type: "journal", date: e.date, field, snippet: snippet(text, q), dayNet: dayNet.get(e.date) ?? null });
      for (const [col, label] of JOURNAL_FIELDS) if (has(e[col], q)) hit(label, e[col]);
      for (const level of Array.isArray(e.key_levels) ? e.key_levels : []) {
        const text = [level.price, level.label].filter((x) => x !== undefined && x !== null).join(" ");
        if (has(text, q)) hit("Key level", text);
      }
      for (const c of captionsByEntry.get(e.id) ?? []) {
        hit(c.section === "pre" ? "Pre-market chart" : "Post-session chart", c.caption);
      }
    }

    res.json({
      q,
      trades: tradeResults.slice(0, MAX_RESULTS),
      journal: journalResults.slice(0, MAX_RESULTS),
      counts: { trades: tradeResults.length, journal: journalResults.length },
      // How the matching trades went, next to every trade in the same range
      stats: { matched: summarize(trades), overall: summarize(all) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong searching." });
  }
});

module.exports = router;
module.exports.snippet = snippet;
