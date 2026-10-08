const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const calculateNetPnl = require("../utils/pnl");
const { TRADE_COLUMNS, parseJournalFields } = require("../utils/tradeFields");

router.get("/summary", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${TRADE_COLUMNS} FROM trades WHERE user_id = $1`,
      [req.userId],
    );
    const trades = result.rows.map((trade) => ({
      ...trade,
      netPnl: calculateNetPnl(trade),
    }));

    const totalTrades = trades.length;
    const totalPnl = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
    const wins = trades.filter((trade) => trade.netPnl > 0).length;
    const losses = trades.filter((trade) => trade.netPnl < 0).length;
    const winRate =
      totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;

    res.json({
      totalTrades,
      totalPnl: Math.round(totalPnl * 100) / 100,
      wins,
      losses,
      winRate,
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong calculating the summary." });
  }
});

router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${TRADE_COLUMNS} FROM trades WHERE user_id = $1`,
      [req.userId],
    );

    const ruleStatusResult = await pool.query(
      `SELECT trade_rules.trade_id, bool_and(trade_rules.followed) AS all_followed
       FROM trade_rules
       JOIN trades ON trades.id = trade_rules.trade_id
       WHERE trades.user_id = $1
       GROUP BY trade_rules.trade_id`,
      [req.userId],
    );

    const ruleStatusMap = new Map(
      ruleStatusResult.rows.map((row) => [row.trade_id, row.all_followed]),
    );

    const tradesWithPnl = result.rows.map((trade) => ({
      ...trade,
      netPnl: calculateNetPnl(trade),
      rulesFollowed: ruleStatusMap.has(trade.id)
        ? ruleStatusMap.get(trade.id)
        : null,
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
    const { entry_time, exit_time, session, emotion, grade } = journal.values;

    const result = await pool.query(
      `INSERT INTO trades (user_id, trade_date, symbol, direction, contracts, entry_price, exit_price, fees, strategy, screenshot_link, notes,
                           entry_time, exit_time, session, emotion, grade)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        emotion,
        grade,
      ],
    );

    const trade = result.rows[0];
    res.status(201).json({ ...trade, netPnl: calculateNetPnl(trade) });
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

    const trade = result.rows[0];
    res.json({ ...trade, netPnl: calculateNetPnl(trade) });
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
    const { entry_time, exit_time, session, emotion, grade } = journal.values;

    const result = await pool.query(
      `UPDATE trades
       SET trade_date = $1, symbol = $2, direction = $3, contracts = $4,
           entry_price = $5, exit_price = $6, fees = $7, strategy = $8,
           screenshot_link = $9, notes = $10,
           entry_time = $11, exit_time = $12, session = $13, emotion = $14, grade = $15
       WHERE id = $16 AND user_id = $17
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
        emotion,
        grade,
        id,
        req.userId,
      ],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    const trade = result.rows[0];
    res.json({ ...trade, netPnl: calculateNetPnl(trade) });
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

    await pool.query("DELETE FROM trade_rules WHERE trade_id = $1", [id]);
    await pool.query("DELETE FROM answers WHERE trade_id = $1", [id]);

    const result = await pool.query(
      "DELETE FROM trades WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, req.userId],
    );

    res.json({ message: "Trade deleted.", trade: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the trade." });
  }
});

module.exports = router;
