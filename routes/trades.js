const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { withPnl, summarize } = require("../utils/outcome");
const s3 = require("../utils/s3");
const {
  TRADE_COLUMNS,
  parseJournalFields,
  parseMode,
} = require("../utils/tradeFields");

async function withViewUrls(images) {
  return Promise.all(
    images.map(async (img) => ({
      id: img.id,
      caption: img.caption,
      createdAt: img.created_at,
      url: await s3.viewUrl(img.s3_key),
    })),
  );
}

router.get("/summary", requireAuth, async (req, res) => {
  try {
    const { mode, error } = parseMode(req.query.mode);
    if (error) return res.status(400).json({ error });

    const result = await pool.query(
      `SELECT ${TRADE_COLUMNS} FROM trades WHERE user_id = $1 AND mode = $2`,
      [req.userId, mode],
    );
    res.json(summarize(result.rows.map(withPnl)));
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong calculating the summary." });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const { mode, error } = parseMode(req.query.mode);
    if (error) return res.status(400).json({ error });

    const result = await pool.query(
      `SELECT ${TRADE_COLUMNS} FROM trades WHERE user_id = $1 AND mode = $2`,
      [req.userId, mode],
    );

    const ruleStatusResult = await pool.query(
      `SELECT trade_rules.trade_id, bool_and(trade_rules.followed) AS all_followed
       FROM trade_rules
       JOIN trades ON trades.id = trade_rules.trade_id
       WHERE trades.user_id = $1 AND trades.mode = $2
       GROUP BY trade_rules.trade_id`,
      [req.userId, mode],
    );

    const ruleStatusMap = new Map(
      ruleStatusResult.rows.map((row) => [row.trade_id, row.all_followed]),
    );

    const mistakesResult = await pool.query(
      `SELECT trade_mistakes.trade_id, array_agg(trade_mistakes.mistake_id ORDER BY trade_mistakes.mistake_id) AS ids
       FROM trade_mistakes
       JOIN trades ON trades.id = trade_mistakes.trade_id
       WHERE trades.user_id = $1 AND trades.mode = $2
       GROUP BY trade_mistakes.trade_id`,
      [req.userId, mode],
    );
    const mistakesMap = new Map(mistakesResult.rows.map((row) => [row.trade_id, row.ids]));

    const tradesWithPnl = result.rows.map((trade) => ({
      ...withPnl(trade),
      rulesFollowed: ruleStatusMap.has(trade.id)
        ? ruleStatusMap.get(trade.id)
        : null,
      mistakeIds: mistakesMap.get(trade.id) || [],
    }));

    res.json({ trades: tradesWithPnl, count: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching trades." });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const {
      trade_date,
      symbol,
      direction,
      contracts,
      entry_price,
      exit_price,
      fees,
      strategy,
      screenshot_link,
      notes,
    } = req.body;

    const journal = parseJournalFields(req.body);
    if (journal.error) {
      return res.status(400).json({ error: journal.error });
    }
    const { entry_time, exit_time, session, emotions, grade, result: outcome } = journal.values;

    const parsedMode = parseMode(req.body.mode);
    if (parsedMode.error) {
      return res.status(400).json({ error: parsedMode.error });
    }

    const result = await pool.query(
      `INSERT INTO trades (user_id, trade_date, symbol, direction, contracts, entry_price, exit_price, fees, strategy, screenshot_link, notes,
                           entry_time, exit_time, session, emotions, emotion, grade, mode, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, ($15::text[])[1], $16, $17, $18)
       RETURNING ${TRADE_COLUMNS}`,
      [
        req.userId,
        trade_date,
        symbol,
        direction,
        contracts,
        entry_price,
        exit_price,
        fees,
        strategy,
        screenshot_link,
        notes,
        entry_time,
        exit_time,
        session,
        emotions || [],
        grade,
        parsedMode.mode,
        outcome,
      ],
    );

    res.status(201).json({ ...withPnl(result.rows[0]), images: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the trade." });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT ${TRADE_COLUMNS} FROM trades WHERE id = $1 AND user_id = $2`,
      [id, req.userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    const mistakes = await pool.query(
      "SELECT mistake_id FROM trade_mistakes WHERE trade_id = $1 ORDER BY mistake_id",
      [id],
    );

    const images = await pool.query(
      "SELECT id, caption, s3_key, created_at FROM trade_images WHERE trade_id = $1 ORDER BY id",
      [id],
    );

    res.json({
      ...withPnl(result.rows[0]),
      mistakeIds: mistakes.rows.map((row) => row.mistake_id),
      images: s3.imagesConfigured() ? await withViewUrls(images.rows) : [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching the trade." });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      trade_date,
      symbol,
      direction,
      contracts,
      entry_price,
      exit_price,
      fees,
      strategy,
      screenshot_link,
      notes,
    } = req.body;

    const journal = parseJournalFields(req.body);
    if (journal.error) {
      return res.status(400).json({ error: journal.error });
    }
    const { entry_time, exit_time, session, emotions, grade, result: outcome, resultSent } = journal.values;

    const parsedMode = parseMode(req.body.mode, null);
    if (parsedMode.error) {
      return res.status(400).json({ error: parsedMode.error });
    }

    const result = await pool.query(
      `UPDATE trades
       SET trade_date = $1, symbol = $2, direction = $3, contracts = $4,
           entry_price = $5, exit_price = $6, fees = $7, strategy = $8,
           screenshot_link = $9, notes = $10,
           entry_time = $11, exit_time = $12, session = $13,
           emotions = COALESCE($14::text[], emotions),
           emotion = (COALESCE($14::text[], emotions))[1],
           grade = $15,
           mode = COALESCE($16, mode),
           result = CASE WHEN $19 THEN $20 ELSE result END
       WHERE id = $17 AND user_id = $18
       RETURNING ${TRADE_COLUMNS}`,
      [
        trade_date,
        symbol,
        direction,
        contracts,
        entry_price,
        exit_price,
        fees,
        strategy,
        screenshot_link,
        notes,
        entry_time,
        exit_time,
        session,
        emotions,
        grade,
        parsedMode.mode,
        id,
        req.userId,
        resultSent,
        outcome,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    res.json(withPnl(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the trade." });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const ownerCheck = await pool.query(
      "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
      [id, req.userId],
    );
    if (ownerCheck.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    const images = await pool.query("SELECT s3_key FROM trade_images WHERE trade_id = $1", [id]);

    await pool.query("DELETE FROM trade_rules WHERE trade_id = $1", [id]);
    await pool.query("DELETE FROM answers WHERE trade_id = $1", [id]);

    const result = await pool.query(
      "DELETE FROM trades WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, req.userId],
    );

    // Rows are gone with the trade (cascade); clean up the files, logging failures
    for (const { s3_key } of images.rows) {
      s3.deleteObject(s3_key).catch((err) => console.error("S3 delete failed", s3_key, err));
    }

    res.json({ message: "Trade deleted.", trade: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the trade." });
  }
});

module.exports = router;
