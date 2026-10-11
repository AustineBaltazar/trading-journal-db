const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { requireAdmin } = require("../middleware/auth");
const { describeDevice } = require("../utils/emails");
const { isDemo } = require("../utils/account");

const STATUSES = ["new", "working", "done"];
const KINDS = ["bug", "idea", "other"];
const PAGE_SIZES = [8, 10, 20, 50];

// The feedback inbox, newest first, one page at a time. Filters and search
// apply across every page; counts are for the whole inbox.
router.get("/admin/feedback", requireAuth, requireAdmin, async (req, res) => {
  try {
    const pageSize = PAGE_SIZES.includes(Number(req.query.pageSize)) ? Number(req.query.pageSize) : 8;
    const where = [];
    const params = [];
    if (STATUSES.includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`f.status = $${params.length}`);
    }
    if (KINDS.includes(req.query.kind)) {
      params.push(req.query.kind);
      where.push(`f.kind = $${params.length}`);
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
    if (q) {
      // Matched literally: % and _ in the search are not wildcards
      params.push(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
      where.push(`(f.message ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = Number(
      (await pool.query(`SELECT count(*) FROM feedback f LEFT JOIN users u ON u.id = f.user_id ${filter}`, params)).rows[0]
        .count,
    );
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Number.parseInt(req.query.page, 10) || 1), pages);

    const rows = (
      await pool.query(
        `SELECT f.id, f.kind, f.message, f.page, f.user_agent, f.status, f.admin_note, f.created_at,
                u.id AS user_id, u.name, u.email, u.created_at AS joined,
                (SELECT count(*)::int FROM trades t WHERE t.user_id = u.id) AS trades
         FROM feedback f LEFT JOIN users u ON u.id = f.user_id
         ${filter}
         ORDER BY f.created_at DESC, f.id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params,
      )
    ).rows;

    const counts = (
      await pool.query(
        `SELECT count(*)::int AS all,
                count(*) FILTER (WHERE status = 'new')::int AS new,
                count(*) FILTER (WHERE status = 'working')::int AS working,
                count(*) FILTER (WHERE status = 'done')::int AS done,
                count(*) FILTER (WHERE kind = 'bug')::int AS bug,
                count(*) FILTER (WHERE kind = 'idea')::int AS idea,
                count(*) FILTER (WHERE kind = 'other')::int AS other,
                count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "thisWeek"
         FROM feedback`,
      )
    ).rows[0];
    const users = (
      await pool.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS "newThisWeek" FROM users`,
      )
    ).rows[0];

    res.json({
      items: rows.map((r) => ({
        id: Number(r.id),
        kind: r.kind,
        message: r.message,
        page: r.page,
        device: r.user_agent ? describeDevice(r.user_agent) : null,
        status: r.status,
        note: r.admin_note,
        createdAt: r.created_at,
        user: r.user_id
          ? { id: r.user_id, name: r.name, email: r.email, demo: isDemo(r.email), joinedAt: r.joined, trades: r.trades }
          : null,
      })),
      total,
      page,
      pageSize,
      pages,
      counts,
      users,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong loading feedback." });
  }
});

// Just the number of new messages, for the badge in the menu
router.get("/admin/feedback/new-count", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT count(*)::int AS n FROM feedback WHERE status = 'new'");
    res.json({ new: result.rows[0].n });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

// Move a message along (New → Working on → Done) and/or save a private note
router.patch("/admin/feedback/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: "Not found." });
  const sets = [];
  const params = [];
  if (req.body?.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: "Unknown status." });
    params.push(req.body.status);
    sets.push(`status = $${params.length}`);
  }
  if (req.body?.note !== undefined) {
    const note = typeof req.body.note === "string" ? req.body.note.trim() : "";
    if (note.length > 2000) return res.status(400).json({ error: "Keep the note under 2000 characters." });
    params.push(note || null);
    sets.push(`admin_note = $${params.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to change." });
  try {
    params.push(id);
    const result = await pool.query(
      `UPDATE feedback SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length} RETURNING id, status, admin_note`,
      params,
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found." });
    const row = result.rows[0];
    res.json({ id: Number(row.id), status: row.status, note: row.admin_note });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving that." });
  }
});

module.exports = router;
