const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");

router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM rules WHERE user_id = $1", [
      req.userId,
    ]);
    res.json({ rules: result.rows, count: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching rules." });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const result = await pool.query(
      `INSERT INTO rules (user_id, name) VALUES ($1, $2) RETURNING *`,
      [req.userId, name],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the rule." });
  }
});

router.put("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const result = await pool.query(
      `UPDATE rules SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
      [name, id, req.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Rule not found." });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the rule." });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "DELETE FROM rules WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, req.userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Rule not found." });
    }
    res.json({ message: "Rule deleted.", rule: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the rule." });
  }
});

module.exports = router;
