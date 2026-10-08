const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { parseMode } = require("../utils/tradeFields");

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

router.get("/rule-adherence", requireAuth, async (req, res) => {
  try {
    const { mode, error } = parseMode(req.query.mode);
    if (error) return res.status(400).json({ error });

    const result = await pool.query(
      `SELECT rules.id AS rule_id, rules.name, trade_rules.followed, trade_rules.trade_id
       FROM trade_rules
       JOIN rules ON rules.id = trade_rules.rule_id
       JOIN trades ON trades.id = trade_rules.trade_id
       WHERE trades.user_id = $1 AND trades.mode = $2`,
      [req.userId, mode],
    );

    const tradesResult = await pool.query(
      "SELECT * FROM trades WHERE user_id = $1 AND mode = $2",
      [req.userId, mode],
    );
    const tradesById = new Map(tradesResult.rows.map((t) => [t.id, t]));

    const ruleMap = new Map();
    const tradeFollowedMap = new Map();

    for (const row of result.rows) {
      if (!ruleMap.has(row.rule_id)) {
        ruleMap.set(row.rule_id, {
          name: row.name,
          total: 0,
          followedCount: 0,
        });
      }
      const ruleEntry = ruleMap.get(row.rule_id);
      ruleEntry.total += 1;
      if (row.followed) ruleEntry.followedCount += 1;

      if (!tradeFollowedMap.has(row.trade_id)) {
        tradeFollowedMap.set(row.trade_id, true);
      }
      if (!row.followed) {
        tradeFollowedMap.set(row.trade_id, false);
      }
    }

    const adherence = Array.from(ruleMap.values()).map((entry) => ({
      name: entry.name,
      total: entry.total,
      followedCount: entry.followedCount,
      percentage: Math.round((entry.followedCount / entry.total) * 100),
    }));

    const tradesWithRules = Array.from(tradeFollowedMap.entries());
    const followedTradesCount = tradesWithRules.filter(
      ([, allFollowed]) => allFollowed,
    ).length;
    const followedAllPercentage =
      tradesWithRules.length > 0
        ? Math.round((followedTradesCount / tradesWithRules.length) * 100)
        : 0;

    const calculateNetPnl = require("../utils/pnl");
    const followedPnls = [];
    const brokenPnls = [];

    for (const [tradeId, allFollowed] of tradesWithRules) {
      const trade = tradesById.get(tradeId);
      if (!trade) continue;
      const pnl = calculateNetPnl(trade);
      if (allFollowed) followedPnls.push(pnl);
      else brokenPnls.push(pnl);
    }

    const avg = (arr) =>
      arr.length > 0
        ? Math.round((arr.reduce((s, n) => s + n, 0) / arr.length) * 100) / 100
        : 0;

    res.json({
      adherence,
      followedAllPercentage,
      followedTradesCount,
      totalTradesWithRules: tradesWithRules.length,
      avgPnlRulesFollowed: avg(followedPnls),
      avgPnlRuleBroken: avg(brokenPnls),
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong calculating rule adherence." });
  }
});

module.exports = router;
