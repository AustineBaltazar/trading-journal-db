const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");

router.post("/trade-rules", requireAuth, async (req, res) => {
  try {
    const { trade_id, rule_id, followed } = req.body;

    const tradeCheck = await pool.query(
      "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
      [trade_id, req.userId],
    );
    if (tradeCheck.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    const ruleCheck = await pool.query(
      "SELECT id FROM rules WHERE id = $1 AND user_id = $2",
      [rule_id, req.userId],
    );
    if (ruleCheck.rows.length === 0) {
      return res.status(404).json({ error: "Rule not found." });
    }

    const result = await pool.query(
      `INSERT INTO trade_rules (trade_id, rule_id, followed) VALUES ($1, $2, $3) RETURNING *`,
      [trade_id, rule_id, followed],
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong linking the rule to the trade." });
  }
});

router.get("/trades/:tradeId/rules", requireAuth, async (req, res) => {
  try {
    const { tradeId } = req.params;

    const tradeCheck = await pool.query(
      "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
      [tradeId, req.userId],
    );
    if (tradeCheck.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    const result = await pool.query(
      `SELECT rules.id, rules.name, trade_rules.followed
       FROM trade_rules
       JOIN rules ON rules.id = trade_rules.rule_id
       WHERE trade_rules.trade_id = $1`,
      [tradeId],
    );

    res.json({ rules: result.rows });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching the trade's rules." });
  }
});

router.put("/trades/:tradeId/rules/:ruleId", requireAuth, async (req, res) => {
  try {
    const { tradeId, ruleId } = req.params;
    const { followed } = req.body;

    const tradeCheck = await pool.query(
      "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
      [tradeId, req.userId],
    );
    if (tradeCheck.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    const result = await pool.query(
      `UPDATE trade_rules SET followed = $1 WHERE trade_id = $2 AND rule_id = $3 RETURNING *`,
      [followed, tradeId, ruleId],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Rule link not found for this trade." });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating the rule link." });
  }
});

router.delete(
  "/trades/:tradeId/rules/:ruleId",
  requireAuth,
  async (req, res) => {
    try {
      const { tradeId, ruleId } = req.params;

      const tradeCheck = await pool.query(
        "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
        [tradeId, req.userId],
      );
      if (tradeCheck.rows.length === 0) {
        return res.status(404).json({ error: "Trade not found." });
      }

      const result = await pool.query(
        "DELETE FROM trade_rules WHERE trade_id = $1 AND rule_id = $2 RETURNING *",
        [tradeId, ruleId],
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "Rule link not found for this trade." });
      }

      res.json({ message: "Rule link removed.", link: result.rows[0] });
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({ error: "Something went wrong removing the rule link." });
    }
  },
);

module.exports = router;
