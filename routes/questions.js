const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");

router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM questions WHERE user_id = $1",
      [req.userId],
    );
    res.json({ questions: result.rows, count: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching questions." });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const { question_text } = req.body;
    const result = await pool.query(
      `INSERT INTO questions (user_id, question_text) VALUES ($1, $2) RETURNING *`,
      [req.userId, question_text],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong saving the question." });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { question_text } = req.body;
    const result = await pool.query(
      `UPDATE questions SET question_text = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
      [question_text, id, req.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Question not found." });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong updating the question." });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM questions WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, req.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Question not found." });
    }
    res.json({ message: "Question deleted.", question: result.rows[0] });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "Something went wrong deleting the question." });
  }
});

module.exports = router;
