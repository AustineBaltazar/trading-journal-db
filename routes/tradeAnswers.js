const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");

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
