const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { parseRuleDetails } = require("../utils/range");

router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM rules WHERE user_id = $1 ORDER BY id", [
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
    const details = parseRuleDetails(req.body);
    if (details.error) return res.status(400).json({ error: details.error });
    const result = await pool.query(
      `INSERT INTO rules (user_id, name, description, category) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.userId, name, details.values.description ?? null, details.values.category ?? null],
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
    const details = parseRuleDetails(req.body);
    if (details.error) return res.status(400).json({ error: details.error });
    const v = details.values;
    // Description and category change only when sent, so older clients keep them
    const result = await pool.query(
      `UPDATE rules SET name = $1,
         description = CASE WHEN $4 THEN $5 ELSE description END,
         category = CASE WHEN $6 THEN $7 ELSE category END
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [name, id, req.userId, "description" in v, v.description ?? null, "category" in v, v.category ?? null],
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
