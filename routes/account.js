const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const s3 = require("../utils/s3");
const { hashPassword, verifyPassword, passwordProblem, isLeakedPassword } = require("../utils/passwords");
const { COOKIE_NAME, cookieOptions } = require("../utils/sessions");
const { loginState, recentFailures, recordAttempt } = require("../utils/loginGuard");
const { STORAGE_LIMIT_BYTES, usedStorageBytes, maskIp, toCsv } = require("../utils/account");
const { describeDevice } = require("../utils/emails");
const emails = require("../utils/emails");
const { sendMail } = require("../utils/mailer");
const { verifyGoogleCredential } = require("../utils/google");

// Accounts without a password prove it's them by signing in with Google again
async function confirmedWithGoogle(user, credential) {
  if (!user.google_sub) return false;
  const google = await verifyGoogleCredential(credential);
  return Boolean(google && google.sub === user.google_sub);
}

const fail = (res, message) => (err) => {
  console.error(err);
  res.status(500).json({ error: message });
};

async function currentUser(userId) {
  const result = await pool.query(
    "SELECT id, name, email, password_hash, google_sub, google_email, email_verified_at, created_at FROM users WHERE id = $1",
    [userId],
  );
  return result.rows[0];
}

// The account page: profile, storage used
router.get("/account", requireAuth, async (req, res) => {
  try {
    const user = await currentUser(req.userId);
    res.json({
      user: { id: user.id, name: user.name, email: user.email, demo: req.isDemo },
      emailConfirmed: Boolean(user.email_verified_at),
      signIn: { password: Boolean(user.password_hash), google: user.google_email || null },
      createdAt: user.created_at,
      storage: { usedBytes: await usedStorageBytes(pool, req.userId), limitBytes: STORAGE_LIMIT_BYTES },
    });
  } catch (err) {
    fail(res, "Something went wrong loading your account.")(err);
  }
});

router.put("/account/profile", requireAuth, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 60) return res.status(400).json({ error: "Please enter your name (up to 60 characters)." });
  try {
    const result = await pool.query("UPDATE users SET name = $1 WHERE id = $2 RETURNING id, name, email", [
      name,
      req.userId,
    ]);
    res.json({ user: result.rows[0] });
  } catch (err) {
    fail(res, "Something went wrong saving your name.")(err);
  }
});

// Needs the current password. Wrong guesses count toward the same lockout as the login form.
router.post("/account/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body ?? {};
    const user = await currentUser(req.userId);
    const state = loginState(await recentFailures(pool, user.email));
    if (state.retryAfter) {
      return res.status(429).json({ error: "Too many wrong passwords. Please wait a few minutes.", retryAfter: state.retryAfter });
    }
    if (!user.password_hash) {
      // Setting a first password on a Google account
      if (!(await confirmedWithGoogle(user, req.body?.googleCredential))) {
        return res.status(400).json({ error: "Please confirm with Google first.", googleRequired: true });
      }
    } else {
      const check =
        typeof currentPassword === "string" && currentPassword
          ? await verifyPassword(user.password_hash, currentPassword)
          : { ok: false };
      if (!check.ok) {
        await recordAttempt(pool, { email: user.email, userId: user.id, succeeded: false, ip: req.ip, userAgent: req.get("user-agent") });
        return res.status(400).json({ error: "Your current password is wrong." });
      }
    }
    const problem =
      passwordProblem(newPassword, user.email) ||
      (newPassword === currentPassword ? "Choose a password different from your current one." : null) ||
      ((await isLeakedPassword(newPassword)) ? "This password has appeared in a data leak. Please choose a different one." : null);
    if (problem) return res.status(400).json({ error: problem });

    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword(newPassword), user.id]);
    // This browser stays logged in; every other one is logged out
    await pool.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL", [
      user.id,
      req.sessionId,
    ]);
    sendMail({ to: user.email, ...emails.passwordChanged(user.name, new Date()) });
    res.json({ ok: true });
  } catch (err) {
    fail(res, "Something went wrong changing your password.")(err);
  }
});

// Connect a Google account (you're already logged in, so this proves both sides)
router.post("/account/google", requireAuth, async (req, res) => {
  try {
    const google = await verifyGoogleCredential(req.body?.credential);
    if (!google) return res.status(400).json({ error: "Google sign-in didn't work. Please try again." });
    const taken = await pool.query("SELECT id FROM users WHERE google_sub = $1 AND id <> $2", [google.sub, req.userId]);
    if (taken.rows[0]) {
      return res.status(409).json({ error: "That Google account is already connected to another journal." });
    }
    await pool.query("UPDATE users SET google_sub = $1, google_email = $2 WHERE id = $3", [
      google.sub,
      google.email,
      req.userId,
    ]);
    res.json({ google: google.email });
  } catch (err) {
    fail(res, "Something went wrong connecting Google.")(err);
  }
});

// Disconnect Google; only when a password is set, so the account keeps a way in
router.delete("/account/google", requireAuth, async (req, res) => {
  try {
    const user = await currentUser(req.userId);
    if (!user.password_hash) {
      return res.status(400).json({ error: "Set a password first, so you can still log in without Google." });
    }
    await pool.query("UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = $1", [req.userId]);
    res.status(204).end();
  } catch (err) {
    fail(res, "Something went wrong disconnecting Google.")(err);
  }
});

router.get("/account/sessions", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_agent, ip, created_at, last_seen_at, remember FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY last_seen_at DESC`,
      [req.userId],
    );
    res.json({
      sessions: result.rows.map((s) => ({
        id: Number(s.id),
        device: describeDevice(s.user_agent),
        ip: maskIp(s.ip),
        createdAt: s.created_at,
        lastSeenAt: s.last_seen_at,
        current: String(s.id) === String(req.sessionId),
      })),
    });
  } catch (err) {
    fail(res, "Something went wrong loading your devices.")(err);
  }
});

router.delete("/account/sessions/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Unknown device." });
  if (String(id) === String(req.sessionId)) return res.status(400).json({ error: "Use Log out to end this device's session." });
  try {
    const result = await pool.query(
      "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [id, req.userId],
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "That device is already logged out." });
    res.status(204).end();
  } catch (err) {
    fail(res, "Something went wrong logging that device out.")(err);
  }
});

router.post("/account/sessions/logout-others", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
      [req.userId, req.sessionId],
    );
    res.json({ loggedOut: result.rowCount });
  } catch (err) {
    fail(res, "Something went wrong logging out your other devices.")(err);
  }
});

// The last 10 login tries for this account (including wrong passwords)
router.get("/account/login-history", requireAuth, async (req, res) => {
  try {
    const user = await currentUser(req.userId);
    const result = await pool.query(
      `SELECT succeeded, user_agent, ip, created_at FROM login_attempts
       WHERE user_id = $1 OR email = $2 ORDER BY created_at DESC LIMIT 10`,
      [user.id, user.email],
    );
    res.json({
      attempts: result.rows.map((a) => ({
        succeeded: a.succeeded,
        device: a.user_agent ? describeDevice(a.user_agent) : "Unknown browser",
        ip: maskIp(a.ip),
        at: a.created_at,
      })),
    });
  } catch (err) {
    fail(res, "Something went wrong loading your login history.")(err);
  }
});

// Everything the account holds, as one JSON file
router.get("/account/export", requireAuth, async (req, res) => {
  try {
    const q = (sql) => pool.query(sql, [req.userId]).then((r) => r.rows);
    const [user] = await q("SELECT name, email, created_at FROM users WHERE id = $1");
    const data = {
      exportedAt: new Date().toISOString(),
      account: user,
      // Dates as plain text (the later column wins), so no time zone shifts them a day
      trades: await q("SELECT *, trade_date::text AS trade_date FROM trades WHERE user_id = $1 ORDER BY trades.trade_date, trades.id"),
      tradeRules: await q(
        "SELECT tr.trade_id, r.name AS rule, tr.followed FROM trade_rules tr JOIN rules r ON r.id = tr.rule_id WHERE r.user_id = $1",
      ),
      tradeMistakes: await q(
        "SELECT tm.trade_id, m.name AS mistake FROM trade_mistakes tm JOIN mistakes m ON m.id = tm.mistake_id WHERE m.user_id = $1",
      ),
      tradeTags: await q(
        `SELECT tt.trade_id, g.name AS "group", t.name AS tag FROM trade_tags tt
         JOIN tags t ON t.id = tt.tag_id JOIN tag_groups g ON g.id = t.group_id WHERE g.user_id = $1`,
      ),
      reviewAnswers: await q(
        "SELECT a.trade_id, q.question_text, a.choice, a.comment FROM answers a JOIN questions q ON q.id = a.question_id WHERE q.user_id = $1",
      ),
      rules: await q("SELECT name, description, category FROM rules WHERE user_id = $1 ORDER BY id"),
      questions: await q("SELECT question_text FROM questions WHERE user_id = $1 ORDER BY id"),
      mistakes: await q("SELECT name FROM mistakes WHERE user_id = $1 ORDER BY id"),
      tagGroups: await q(
        `SELECT g.name, coalesce(json_agg(t.name ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '[]') AS tags
         FROM tag_groups g LEFT JOIN tags t ON t.group_id = g.id WHERE g.user_id = $1 GROUP BY g.id ORDER BY g.position`,
      ),
      evals: await q(
        "SELECT name, account_size, profit_target, max_drawdown, drawdown_type, daily_loss_limit, min_days, consistency_pct, started_on::text, ended_on::text, result, fail_reason FROM eval_attempts WHERE user_id = $1 ORDER BY eval_attempts.started_on",
      ),
      journal: await q("SELECT *, entry_date::text AS entry_date FROM journal_entries WHERE user_id = $1 ORDER BY journal_entries.entry_date"),
      screenshots: [
        ...(await q(
          "SELECT i.trade_id, i.caption, i.content_type, i.size_bytes, i.created_at FROM trade_images i JOIN trades t ON t.id = i.trade_id WHERE t.user_id = $1",
        )),
        ...(await q(
          "SELECT e.entry_date::text AS journal_date, i.section, i.caption, i.content_type, i.size_bytes, i.created_at FROM journal_images i JOIN journal_entries e ON e.id = i.entry_id WHERE e.user_id = $1",
        )),
      ],
    };
    for (const t of data.trades) delete t.user_id;
    for (const e of data.journal) delete e.user_id;
    res.set("Content-Disposition", `attachment; filename="mnq-journal-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  } catch (err) {
    fail(res, "Something went wrong exporting your data.")(err);
  }
});

const CSV_COLUMNS = [
  "id", "trade_date", "mode", "symbol", "direction", "contracts", "entry_price", "exit_price", "stop_price",
  "target_price", "fees", "result", "strategy", "session", "entry_time", "exit_time", "emotions", "grade", "notes",
];

// Trades as a spreadsheet
router.get("/account/export/trades.csv", requireAuth, async (req, res) => {
  try {
    const columns = CSV_COLUMNS.map((c) => (c === "trade_date" ? "trade_date::text AS trade_date" : c));
    const result = await pool.query(`SELECT ${columns.join(", ")} FROM trades WHERE user_id = $1 ORDER BY trade_date, id`, [
      req.userId,
    ]);
    const rows = result.rows.map((r) => ({
      ...r,
      emotions: Array.isArray(r.emotions) ? r.emotions.join("; ") : r.emotions,
    }));
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="mnq-journal-trades-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + toCsv(CSV_COLUMNS, rows));
  } catch (err) {
    fail(res, "Something went wrong exporting your trades.")(err);
  }
});

// Deletes the account and everything in it, screenshots included. Needs the password
// and the word DELETE typed in.
router.delete("/account", requireAuth, async (req, res) => {
  const { password, confirm } = req.body ?? {};
  if (confirm !== "DELETE") return res.status(400).json({ error: 'Type DELETE to confirm.' });
  let db;
  try {
    const user = await currentUser(req.userId);
    if (!user.password_hash) {
      if (!(await confirmedWithGoogle(user, req.body?.googleCredential))) {
        return res.status(400).json({ error: "Please confirm with Google first.", googleRequired: true });
      }
    } else {
      const check = typeof password === "string" && password ? await verifyPassword(user.password_hash, password) : { ok: false };
      if (!check.ok) {
        await recordAttempt(pool, { email: user.email, userId: user.id, succeeded: false, ip: req.ip, userAgent: req.get("user-agent") });
        return res.status(400).json({ error: "Your password is wrong." });
      }
    }

    const keys = (
      await pool.query(
        `SELECT i.s3_key FROM trade_images i JOIN trades t ON t.id = i.trade_id WHERE t.user_id = $1
         UNION ALL
         SELECT i.s3_key FROM journal_images i JOIN journal_entries e ON e.id = i.entry_id WHERE e.user_id = $1`,
        [user.id],
      )
    ).rows.map((r) => r.s3_key);

    db = await pool.connect();
    await db.query("BEGIN");
    const userTrades = "SELECT id FROM trades WHERE user_id = $1";
    // Children first where the foreign keys don't cascade
    await db.query(`DELETE FROM answers WHERE trade_id IN (${userTrades}) OR question_id IN (SELECT id FROM questions WHERE user_id = $1)`, [user.id]);
    await db.query(`DELETE FROM trade_rules WHERE trade_id IN (${userTrades}) OR rule_id IN (SELECT id FROM rules WHERE user_id = $1)`, [user.id]);
    await db.query("DELETE FROM trades WHERE user_id = $1", [user.id]);
    await db.query("DELETE FROM journal_entries WHERE user_id = $1", [user.id]);
    for (const table of ["mistakes", "questions", "rules", "tag_groups"]) {
      await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [user.id]);
    }
    await db.query("DELETE FROM login_attempts WHERE email = $1", [user.email]);
    await db.query("DELETE FROM users WHERE id = $1", [user.id]);
    await db.query("COMMIT");

    // Screenshots last: the account is already gone if one of these fails
    if (s3.imagesConfigured()) {
      const failed = (await Promise.allSettled(keys.map((k) => s3.deleteObject(k)))).filter((r) => r.status === "rejected");
      if (failed.length) console.error(`Account ${user.id} deleted; ${failed.length} screenshots left in S3`);
    }
    res.clearCookie(COOKIE_NAME, cookieOptions(false));
    res.status(204).end();
  } catch (err) {
    await db?.query("ROLLBACK").catch(() => {});
    fail(res, "Something went wrong deleting your account.")(err);
  } finally {
    db?.release();
  }
});

module.exports = router;
