const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { parseMode } = require("../utils/tradeFields");
const { parseRange } = require("../utils/range");

router.post("/trade-answers", requireAuth, async (req, res) => {
  try {
    const { trade_id, question_id, choice, comment } = req.body;

    const tradeCheck = await pool.query(
      "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
      [trade_id, req.userId],
    );
    if (tradeCheck.rows.length === 0) {
      return res.status(404).json({ error: "Trade not found." });
    }

    const questionCheck = await pool.query(
      "SELECT id FROM questions WHERE id = $1 AND user_id = $2",
      [question_id, req.userId],
    );
    if (questionCheck.rows.length === 0) {
      return res.status(404).json({ error: "Question not found." });
    }

    const result = await pool.query(
      `INSERT INTO answers (trade_id, question_id, choice, comment) VALUES ($1, $2, $3, $4) RETURNING *`,
      [trade_id, question_id, choice, comment],
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the answer." });
  }
});

// How each review question has been answered over a mode and optional date range,
// and how many trades got Yes to every question
router.get("/question-stats", requireAuth, async (req, res) => {
  try {
    const { mode, error } = parseMode(req.query.mode);
    if (error) return res.status(400).json({ error });
    const range = parseRange(req.query);
    if (range.error) return res.status(400).json({ error: range.error });
    const inRange = "($3::date IS NULL OR trades.trade_date >= $3) AND ($4::date IS NULL OR trades.trade_date <= $4)";
    const params = [req.userId, mode, range.from, range.to];

    const questions = await pool.query(
      `SELECT questions.id, questions.question_text,
         count(trades.id)::int AS total,
         count(trades.id) FILTER (WHERE answers.choice = 'yes')::int AS yes,
         count(trades.id) FILTER (WHERE answers.choice = 'no')::int AS no,
         count(trades.id) FILTER (WHERE answers.choice = 'other')::int AS other
       FROM questions
       LEFT JOIN answers ON answers.question_id = questions.id
       LEFT JOIN trades ON trades.id = answers.trade_id AND trades.user_id = $1 AND trades.mode = $2 AND ${inRange}
       WHERE questions.user_id = $1
       GROUP BY questions.id
       ORDER BY questions.id`,
      params,
    );
    const trades = await pool.query(
      `SELECT count(*)::int AS answered, count(*) FILTER (WHERE all_yes)::int AS all_yes
       FROM (
         SELECT answers.trade_id, bool_and(answers.choice = 'yes') AS all_yes
         FROM answers
         JOIN trades ON trades.id = answers.trade_id
         JOIN questions ON questions.id = answers.question_id AND questions.user_id = $1
         WHERE trades.user_id = $1 AND trades.mode = $2 AND ${inRange}
         GROUP BY answers.trade_id
       ) t`,
      params,
    );
    res.json({
      questions: questions.rows,
      tradesAnswered: trades.rows[0].answered,
      tradesAllYes: trades.rows[0].all_yes,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong calculating review answers." });
  }
});

router.get("/trades/:tradeId/answers", requireAuth, async (req, res) => {
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
      `SELECT questions.id AS question_id, questions.question_text, answers.choice, answers.comment
       FROM answers
       JOIN questions ON questions.id = answers.question_id
       WHERE answers.trade_id = $1`,
      [tradeId],
    );

    res.json({ answers: result.rows });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong fetching the trade's answers." });
  }
});

router.put(
  "/trades/:tradeId/answers/:questionId",
  requireAuth,
  async (req, res) => {
    try {
      const { tradeId, questionId } = req.params;
      const { choice, comment } = req.body;

      const tradeCheck = await pool.query(
        "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
        [tradeId, req.userId],
      );
      if (tradeCheck.rows.length === 0) {
        return res.status(404).json({ error: "Trade not found." });
      }

      const result = await pool.query(
        `UPDATE answers SET choice = $1, comment = $2 WHERE trade_id = $3 AND question_id = $4 RETURNING *`,
        [choice, comment, tradeId, questionId],
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "Answer not found for this trade." });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({ error: "Something went wrong updating the answer." });
    }
  },
);

router.delete(
  "/trades/:tradeId/answers/:questionId",
  requireAuth,
  async (req, res) => {
    try {
      const { tradeId, questionId } = req.params;

      const tradeCheck = await pool.query(
        "SELECT id FROM trades WHERE id = $1 AND user_id = $2",
        [tradeId, req.userId],
      );
      if (tradeCheck.rows.length === 0) {
        return res.status(404).json({ error: "Trade not found." });
      }

      const result = await pool.query(
        "DELETE FROM answers WHERE trade_id = $1 AND question_id = $2 RETURNING *",
        [tradeId, questionId],
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "Answer not found for this trade." });
      }

      res.json({ message: "Answer removed.", answer: result.rows[0] });
    } catch (err) {
      console.error(err);
      res
        .status(500)
        .json({ error: "Something went wrong removing the answer." });
    }
  },
);

module.exports = router;
