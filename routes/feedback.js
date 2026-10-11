const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { sendMail } = require("../utils/mailer");
const { escape } = require("../utils/emails");

const KINDS = { bug: "Bug", idea: "Idea", other: "Other" };
const PER_HOUR = 5;

// The in-app feedback button: saved, and emailed to the journal's inbox
router.post("/feedback", requireAuth, async (req, res) => {
  const kind = req.body?.kind;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const page = typeof req.body?.page === "string" ? req.body.page.slice(0, 200) : null;
  if (!KINDS[kind]) return res.status(400).json({ error: "Pick Bug, Idea or Other." });
  if (!message) return res.status(400).json({ error: "Please write a few words." });
  if (message.length > 2000) return res.status(400).json({ error: "Please keep it under 2000 characters." });

  try {
    const recent = await pool.query(
      "SELECT count(*)::int AS n FROM feedback WHERE user_id = $1 AND created_at > now() - interval '1 hour'",
      [req.userId],
    );
    if (recent.rows[0].n >= PER_HOUR) {
      return res.status(429).json({ error: "Thanks! You've sent a lot already. Try again in a little while." });
    }
    const user = (await pool.query("SELECT name, email FROM users WHERE id = $1", [req.userId])).rows[0];
    await pool.query("INSERT INTO feedback (user_id, kind, message, page, user_agent) VALUES ($1, $2, $3, $4, $5)", [
      req.userId,
      kind,
      message,
      page,
      (req.get("user-agent") || "").slice(0, 300),
    ]);

    const to = process.env.FEEDBACK_TO || process.env.SMTP_USER;
    if (to) {
      const from = `${user.name} <${user.email}>${req.isDemo ? " (demo account)" : ""}`;
      sendMail({
        to,
        subject: `[MNQ Journal] ${KINDS[kind]}: ${message.slice(0, 60).replace(/\s+/g, " ")}`,
        text: `${KINDS[kind]} from ${from}\nPage: ${page || "-"}\n\n${message}`,
        html: `<p><b>${KINDS[kind]}</b> from ${escape(from)}<br>Page: ${escape(page || "-")}</p><p style="white-space:pre-wrap">${escape(message)}</p>`,
      });
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong sending your feedback." });
  }
});

module.exports = router;
