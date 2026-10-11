const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { parseMode } = require("../utils/tradeFields");
const { parseName, parseTagIds } = require("../utils/tags");

const UNIQUE_VIOLATION = "23505";

// The user's tag groups with their tags, each tag with how many trades in the given mode use it
router.get("/tag-groups", requireAuth, async (req, res) => {
  try {
    const { mode, error } = parseMode(req.query.mode);
    if (error) return res.status(400).json({ error });

    const groups = await pool.query(
      "SELECT id, name, position FROM tag_groups WHERE user_id = $1 ORDER BY position, id",
      [req.userId],
    );
    const tags = await pool.query(
      `SELECT tags.id, tags.group_id, tags.name, count(trades.id)::int AS count
       FROM tags
       JOIN tag_groups ON tag_groups.id = tags.group_id
       LEFT JOIN trade_tags ON trade_tags.tag_id = tags.id
       LEFT JOIN trades ON trades.id = trade_tags.trade_id AND trades.mode = $2
       WHERE tag_groups.user_id = $1
       GROUP BY tags.id
       ORDER BY tags.id`,
      [req.userId, mode],
    );
    res.json({
      groups: groups.rows.map((g) => ({
        id: g.id,
        name: g.name,
        tags: tags.rows
          .filter((t) => t.group_id === g.id)
          .map((t) => ({ id: t.id, name: t.name, count: t.count })),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching tags." });
  }
});

router.post("/tag-groups", requireAuth, async (req, res) => {
  const { name, error } = parseName(req.body.name, "Group");
  if (error) return res.status(400).json({ error });
  try {
    const result = await pool.query(
      `INSERT INTO tag_groups (user_id, name, position)
       SELECT $1, $2, coalesce(max(position) + 1, 0) FROM tag_groups WHERE user_id = $1
       RETURNING id, name`,
      [req.userId, name],
    );
    res.status(201).json({ ...result.rows[0], tags: [] });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) return res.status(409).json({ error: "You already have that group." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the group." });
  }
});

router.put("/tag-groups/:id", requireAuth, async (req, res) => {
  const { name, error } = parseName(req.body.name, "Group");
  if (error) return res.status(400).json({ error });
  try {
    const result = await pool.query(
      "UPDATE tag_groups SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, name",
      [name, req.params.id, req.userId],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Group not found." });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) return res.status(409).json({ error: "You already have that group." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the group." });
  }
});

// Also deletes its tags and removes them from trades (ON DELETE CASCADE)
router.delete("/tag-groups/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM tag_groups WHERE id = $1 AND user_id = $2 RETURNING id, name",
      [req.params.id, req.userId],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Group not found." });
    res.json({ message: "Group deleted.", group: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the group." });
  }
});

router.post("/tag-groups/:id/tags", requireAuth, async (req, res) => {
  const { name, error } = parseName(req.body.name, "Tag");
  if (error) return res.status(400).json({ error });
  try {
    const group = await pool.query("SELECT id FROM tag_groups WHERE id = $1 AND user_id = $2", [
      req.params.id,
      req.userId,
    ]);
    if (group.rows.length === 0) return res.status(404).json({ error: "Group not found." });
    const result = await pool.query(
      "INSERT INTO tags (group_id, name) VALUES ($1, $2) RETURNING id, name",
      [req.params.id, name],
    );
    res.status(201).json({ ...result.rows[0], count: 0 });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) return res.status(409).json({ error: "That group already has this tag." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the tag." });
  }
});

// Tags are owned through their group
const OWNED_TAG = "SELECT tags.id FROM tags JOIN tag_groups ON tag_groups.id = tags.group_id WHERE tags.id = $1 AND tag_groups.user_id = $2";

router.put("/tags/:id", requireAuth, async (req, res) => {
  const { name, error } = parseName(req.body.name, "Tag");
  if (error) return res.status(400).json({ error });
  try {
    const owned = await pool.query(OWNED_TAG, [req.params.id, req.userId]);
    if (owned.rows.length === 0) return res.status(404).json({ error: "Tag not found." });
    const result = await pool.query("UPDATE tags SET name = $1 WHERE id = $2 RETURNING id, name", [
      name,
      req.params.id,
    ]);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) return res.status(409).json({ error: "That group already has this tag." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the tag." });
  }
});

router.delete("/tags/:id", requireAuth, async (req, res) => {
  try {
    const owned = await pool.query(OWNED_TAG, [req.params.id, req.userId]);
    if (owned.rows.length === 0) return res.status(404).json({ error: "Tag not found." });
    await pool.query("DELETE FROM tags WHERE id = $1", [req.params.id]);
    res.json({ message: "Tag deleted.", id: Number(req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the tag." });
  }
});

// Replaces a trade's tags with exactly the given ids
router.put("/trades/:tradeId/tags", requireAuth, async (req, res) => {
  const { ids, error } = parseTagIds(req.body.tag_ids);
  if (error) return res.status(400).json({ error });

  const client = await pool.connect();
  try {
    const trade = await client.query("SELECT id FROM trades WHERE id = $1 AND user_id = $2", [
      req.params.tradeId,
      req.userId,
    ]);
    if (trade.rows.length === 0) return res.status(404).json({ error: "Trade not found." });

    const owned = await client.query(
      `SELECT tags.id FROM tags JOIN tag_groups ON tag_groups.id = tags.group_id
       WHERE tag_groups.user_id = $1 AND tags.id = ANY($2::int[])`,
      [req.userId, ids],
    );
    if (owned.rows.length !== ids.length) return res.status(400).json({ error: "Unknown tag in tag_ids." });

    await client.query("BEGIN");
    await client.query("DELETE FROM trade_tags WHERE trade_id = $1", [req.params.tradeId]);
    if (ids.length > 0) {
      await client.query("INSERT INTO trade_tags (trade_id, tag_id) SELECT $1, unnest($2::int[])", [
        req.params.tradeId,
        ids,
      ]);
    }
    await client.query("COMMIT");
    res.json({ tradeId: Number(req.params.tradeId), tagIds: ids.sort((a, b) => a - b) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the trade's tags." });
  } finally {
    client.release();
  }
});

module.exports = router;
