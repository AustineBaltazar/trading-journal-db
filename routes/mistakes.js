const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { parseMode } = require("../utils/tradeFields");
const { parseMistakeName, parseMistakeIds } = require("../utils/mistakes");

const UNIQUE_VIOLATION = "23505";

// The user's mistakes, each with how many trades in the given mode use it
router.get("/mistakes", requireAuth, async (req, res) => {
  try {
    const { mode, error } = parseMode(req.query.mode);
    if (error) return res.status(400).json({ error });

    const result = await pool.query(
      `SELECT mistakes.id, mistakes.name, count(trades.id)::int AS count
       FROM mistakes
       LEFT JOIN trade_mistakes ON trade_mistakes.mistake_id = mistakes.id
       LEFT JOIN trades ON trades.id = trade_mistakes.trade_id AND trades.mode = $2
       WHERE mistakes.user_id = $1
       GROUP BY mistakes.id
       ORDER BY mistakes.id`,
      [req.userId, mode],
    );
    res.json({ mistakes: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching mistakes." });
  }
});

router.post("/mistakes", requireAuth, async (req, res) => {
  const { name, error } = parseMistakeName(req.body.name);
  if (error) return res.status(400).json({ error });
  try {
    const result = await pool.query(
      "INSERT INTO mistakes (user_id, name) VALUES ($1, $2) RETURNING id, name",
      [req.userId, name],
    );
    res.status(201).json({ ...result.rows[0], count: 0 });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "You already have that mistake." });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the mistake." });
  }
});

router.put("/mistakes/:id", requireAuth, async (req, res) => {
  const { name, error } = parseMistakeName(req.body.name);
  if (error) return res.status(400).json({ error });
  try {
    const result = await pool.query(
      "UPDATE mistakes SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, name",
      [name, req.params.id, req.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Mistake not found." });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      return res.status(409).json({ error: "You already have that mistake." });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the mistake." });
  }
});

// Also removes it from every trade it was tagged on (ON DELETE CASCADE)
router.delete("/mistakes/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM mistakes WHERE id = $1 AND user_id = $2 RETURNING id, name",
      [req.params.id, req.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Mistake not found." });
    }
    res.json({ message: "Mistake deleted.", mistake: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the mistake." });
  }
});

// Replaces a trade's mistakes with exactly the given ids ([] = clean trade)
router.put("/trades/:tradeId/mistakes", requireAuth, async (req, res) => {
  const { ids, error } = parseMistakeIds(req.body.mistake_ids);
  if (error) return res.status(400).json({ error });

  const client = await pool.connect();
  try {
    const trade = await client.query(
      "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
      [req.params.tradeId, req.userId],
    );
    if (trade.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    const owned = await client.query(
      "SELECT id FROM mistakes WHERE user_id = $1 AND id = ANY($2::int[])",
      [req.userId, ids],
    );
    if (owned.rows.length !== ids.length) {
      return res.status(400).json({ error: "Unknown mistake in mistake_ids." });
    }

    await client.query("BEGIN");
    await client.query("DELETE FROM trade_mistakes WHERE trade_id = $1", [req.params.tradeId]);
    if (ids.length > 0) {
      await client.query(
        `INSERT INTO trade_mistakes (trade_id, mistake_id)
         SELECT $1, unnest($2::int[])`,
        [req.params.tradeId, ids],
      );
    }
    await client.query("COMMIT");
    res.json({ tradeId: Number(req.params.tradeId), mistakeIds: ids.sort((a, b) => a - b) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the trade's mistakes." });
  } finally {
    client.release();
  }
});

module.exports = router;
