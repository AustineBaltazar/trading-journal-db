require("dotenv").config();
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { DEFAULT_MISTAKES } = require("../utils/mistakes");
const { DEFAULT_TAG_GROUPS } = require("../utils/tags");
const {
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  normalizeEmail,
  isEmail,
  passwordProblem,
  isLeakedPassword,
} = require("../utils/passwords");
const { COOKIE_NAME, cookieOptions, createSession, revokeSession } = require("../utils/sessions");
const { loginState, recentFailures, recordAttempt } = require("../utils/loginGuard");
const { turnstileEnabled, verifyTurnstile } = require("../utils/turnstile");
const { loginLimiter, registerLimiter } = require("../utils/rateLimits");

const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email });
const client = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

async function startSession(res, req, userId, remember) {
  const token = await createSession(pool, userId, { remember, ...client(req) });
  res.cookie(COOKIE_NAME, token, cookieOptions(remember));
}

// Starter mistakes and tag groups, so a new journal isn't empty
async function addStarterLists(db, userId) {
  await db.query("INSERT INTO mistakes (user_id, name) SELECT $1, unnest($2::text[])", [userId, DEFAULT_MISTAKES]);
  for (const [position, group] of DEFAULT_TAG_GROUPS.entries()) {
    const created = await db.query(
      "INSERT INTO tag_groups (user_id, name, position) VALUES ($1, $2, $3) RETURNING id",
      [userId, group.name, position],
    );
    if (group.tags.length > 0) {
      await db.query("INSERT INTO tags (group_id, name) SELECT $1, unnest($2::text[])", [
        created.rows[0].id,
        group.tags,
      ]);
    }
  }
}

router.post("/register", registerLimiter, async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;

  if (!name || name.length > 60) {
    return res.status(400).json({ error: "Please enter your name (up to 60 characters)." });
  }
  if (!isEmail(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  const problem = passwordProblem(password, email);
  if (problem) return res.status(400).json({ error: problem });

  if (!(await verifyTurnstile(req.body?.turnstileToken, req.ip))) {
    return res.status(400).json({ error: "Please complete the check below.", captchaRequired: true });
  }
  if (await isLeakedPassword(password)) {
    return res.status(400).json({
      error: "This password has appeared in a data leak. Please choose a different one.",
    });
  }

  let db;
  try {
    const passwordHash = await hashPassword(password);
    db = await pool.connect();
    await db.query("BEGIN");
    const result = await db.query(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, name, email`,
      [name, email, passwordHash],
    );
    const user = result.rows[0];
    if (!user) {
      await db.query("ROLLBACK");
      return res.status(409).json({ error: "Email is already registered." });
    }
    await addStarterLists(db, user.id);
    await db.query("COMMIT");

    await startSession(res, req, user.id, true);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    await db?.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Something went wrong registering." });
  } finally {
    db?.release();
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const remember = req.body?.remember === true;

    if (!email || typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const tooMany = (state) => {
      res.set("Retry-After", String(state.retryAfter));
      return res.status(429).json({
        error: "Too many attempts. Please wait, or reset your password.",
        retryAfter: state.retryAfter,
        captchaRequired: turnstileEnabled(),
      });
    };

    const state = loginState(await recentFailures(pool, email));
    if (state.retryAfter) return tooMany(state);
    if (state.captchaRequired && !(await verifyTurnstile(req.body?.turnstileToken, req.ip))) {
      return res.status(400).json({
        error: "Please complete the check below.",
        captchaRequired: true,
        attemptsLeft: state.attemptsLeft,
      });
    }

    const result = await pool.query("SELECT id, name, email, password_hash FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    let check = { ok: false, needsRehash: false };
    if (user) check = await verifyPassword(user.password_hash, password);
    else await burnPasswordCheck(password);

    if (!check.ok) {
      await recordAttempt(pool, { email, userId: user?.id, succeeded: false, ...client(req) });
      const after = loginState({ failures: state.failures + 1, lastFailureAt: new Date() });
      if (after.retryAfter) return tooMany(after);
      return res.status(401).json({
        error: "Email or password is wrong.",
        attemptsLeft: after.attemptsLeft,
        captchaRequired: after.captchaRequired && turnstileEnabled(),
      });
    }

    if (check.needsRehash) {
      // Upgrade an old bcrypt hash now that we have the password
      const upgraded = await hashPassword(password);
      await pool
        .query("UPDATE users SET password_hash = $1 WHERE id = $2", [upgraded, user.id])
        .catch((err) => console.error("Password upgrade failed:", err.message));
    }
    await recordAttempt(pool, { email, userId: user.id, succeeded: true, ...client(req) });
    await startSession(res, req, user.id, remember);

    // `token` keeps tabs opened before the cookie switch working for one release
    const token = process.env.JWT_SECRET
      ? jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "1d" })
      : undefined;
    res.json({ user: publicUser(user), token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong logging in." });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) await revokeSession(pool, token);
    res.clearCookie(COOKIE_NAME, cookieOptions(false));
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong logging out." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, email FROM users WHERE id = $1", [req.userId]);
    if (!result.rows[0]) return res.status(401).json({ error: "Please log in." });
    res.json({ user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

module.exports = router;
