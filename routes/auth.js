require("dotenv").config();
const express = require("express");
const router = express.Router();
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
const { loginState, recentFailures, recordAttempt, lockMinutes } = require("../utils/loginGuard");
const { turnstileEnabled, verifyTurnstile } = require("../utils/turnstile");
const { loginLimiter, registerLimiter, emailLimiter } = require("../utils/rateLimits");
const { issueToken, peekToken, consumeToken, shouldNotify } = require("../utils/emailTokens");
const { sendMail } = require("../utils/mailer");
const emails = require("../utils/emails");
const { isDemo } = require("../utils/account");

const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, demo: isDemo(user.email) });
const client = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });
const CHECK_EMAIL = { message: "Check your email." };
const BAD_LINK = { error: "This link has expired or was already used.", expired: true };

async function startSession(res, req, userId, remember) {
  const token = await createSession(pool, userId, { remember, ...client(req) });
  res.cookie(COOKIE_NAME, token, cookieOptions(remember));
}

function mail(user, { subject, text, html }) {
  sendMail({ to: user.email, subject, text, html });
}

async function sendVerifyLink(user) {
  const token = await issueToken(pool, user.id, "verify");
  if (token) mail(user, emails.verifyEmail(user.name, token));
}

async function newPasswordProblem(password, email) {
  const problem = passwordProblem(password, email);
  if (problem) return problem;
  if (await isLeakedPassword(password)) {
    return "This password has appeared in a data leak. Please choose a different one.";
  }
  return null;
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

// Sign-up always answers "check your email", so it never shows whether an address has
// an account. A new address gets a confirmation link; a confirmed one gets a heads-up
// that someone tried; an unconfirmed one gets a fresh link.
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
  const basic = passwordProblem(password, email);
  if (basic) return res.status(400).json({ error: basic });
  if (req.body?.acceptTerms !== true) {
    return res.status(400).json({ error: "Please accept the Terms and Privacy policy." });
  }
  if (!(await verifyTurnstile(req.body?.turnstileToken, req.ip))) {
    return res.status(400).json({ error: "Please complete the check below.", captchaRequired: true });
  }
  const problem = await newPasswordProblem(password, email);
  if (problem) return res.status(400).json({ error: problem });

  let db;
  try {
    // Hashed before looking the email up, so both answers take the same time
    const passwordHash = await hashPassword(password);
    db = await pool.connect();
    await db.query("BEGIN");
    const result = await db.query(
      `INSERT INTO users (name, email, password_hash, terms_accepted_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (email) DO NOTHING
       RETURNING id, name, email`,
      [name, email, passwordHash],
    );
    const created = result.rows[0];
    if (created) {
      await addStarterLists(db, created.id);
      await db.query("COMMIT");
      await sendVerifyLink(created);
      return res.status(202).json(CHECK_EMAIL);
    }

    await db.query("ROLLBACK");
    const existing = (
      await pool.query("SELECT id, name, email, email_verified_at FROM users WHERE email = $1", [email])
    ).rows[0];
    if (existing && !existing.email_verified_at) {
      await sendVerifyLink(existing);
    } else if (existing && (await shouldNotify(pool, existing.id, "signup-attempt"))) {
      mail(existing, emails.signupAttempt(existing.name));
    }
    res.status(202).json(CHECK_EMAIL);
  } catch (err) {
    await db?.query("ROLLBACK").catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Something went wrong registering." });
  } finally {
    db?.release();
  }
});

// The link from the confirmation email. Confirms the address and logs in.
router.post("/verify-email", async (req, res) => {
  try {
    const user = await consumeToken(pool, req.body?.token, "verify");
    if (!user) return res.status(400).json(BAD_LINK);
    await pool.query("UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1", [
      user.id,
    ]);
    await startSession(res, req, user.id, true);
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong confirming your email." });
  }
});

router.post("/resend-verification", emailLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (isEmail(email)) {
      const user = (
        await pool.query("SELECT id, name, email, email_verified_at FROM users WHERE email = $1", [email])
      ).rows[0];
      if (user && !user.email_verified_at) await sendVerifyLink(user);
    }
    res.status(202).json(CHECK_EMAIL);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong sending the email." });
  }
});

router.post("/forgot-password", emailLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
    if (!(await verifyTurnstile(req.body?.turnstileToken, req.ip))) {
      return res.status(400).json({ error: "Please complete the check below.", captchaRequired: true });
    }
    const user = (await pool.query("SELECT id, name, email FROM users WHERE email = $1", [email])).rows[0];
    if (user) {
      const token = await issueToken(pool, user.id, "reset");
      if (token) mail(user, emails.resetPassword(user.name, token));
    }
    res.status(202).json(CHECK_EMAIL);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong sending the email." });
  }
});

// Lets the reset page say which account it's for, or that the link is dead, before typing
router.post("/reset-password/check", async (req, res) => {
  try {
    const user = await peekToken(pool, req.body?.token, "reset");
    if (!user) return res.status(400).json(BAD_LINK);
    res.json({ email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body ?? {};
    const logoutOthers = req.body?.logoutOthers !== false;
    const linked = await peekToken(pool, token, "reset");
    if (!linked) return res.status(400).json(BAD_LINK);
    const problem = await newPasswordProblem(password, linked.email);
    if (problem) return res.status(400).json({ error: problem });

    const passwordHash = await hashPassword(password);
    const user = await consumeToken(pool, token, "reset");
    if (!user) return res.status(400).json(BAD_LINK);

    // A reset link proves the address, so it also confirms it
    await pool.query(
      "UPDATE users SET password_hash = $1, email_verified_at = coalesce(email_verified_at, now()) WHERE id = $2",
      [passwordHash, user.id],
    );
    await pool.query(
      "UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = 'reset' AND used_at IS NULL",
      [user.id],
    );
    if (logoutOthers) {
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
    }
    // Counts as a successful login, which ends any lockout
    await recordAttempt(pool, { email: user.email, userId: user.id, succeeded: true, ...client(req) });
    await startSession(res, req, user.id, true);
    mail(user, emails.passwordChanged(user.name, new Date()));
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving your password." });
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

    const result = await pool.query(
      "SELECT id, name, email, password_hash, email_verified_at FROM users WHERE email = $1",
      [email],
    );
    const user = result.rows[0];
    let check = { ok: false, needsRehash: false };
    if (user) check = await verifyPassword(user.password_hash, password);
    else await burnPasswordCheck(password);

    if (!check.ok) {
      await recordAttempt(pool, { email, userId: user?.id, succeeded: false, ...client(req) });
      const after = loginState({ failures: state.failures + 1, lastFailureAt: new Date() });
      if (after.retryAfter) {
        if (user && (await shouldNotify(pool, user.id, "locked"))) {
          mail(user, emails.accountLocked(user.name, lockMinutes(after.failures)));
        }
        return tooMany(after);
      }
      return res.status(401).json({
        error: "Email or password is wrong.",
        attemptsLeft: after.attemptsLeft,
        captchaRequired: after.captchaRequired && turnstileEnabled(),
      });
    }

    // Only someone with the right password learns the address isn't confirmed yet
    if (!user.email_verified_at) {
      return res.status(403).json({ error: "Please confirm your email first.", unverified: true });
    }

    if (check.needsRehash) {
      // Upgrade an old bcrypt hash now that we have the password
      const upgraded = await hashPassword(password);
      await pool
        .query("UPDATE users SET password_hash = $1 WHERE id = $2", [upgraded, user.id])
        .catch((err) => console.error("Password upgrade failed:", err.message));
    }

    // A browser this account has never logged in from gets an email, unless it's the first login
    const userAgent = (req.get("user-agent") || "").slice(0, 300);
    const seen = await pool.query(
      `SELECT bool_or(user_agent = $2) AS same_device, count(*)::int AS logins
       FROM login_attempts WHERE user_id = $1 AND succeeded`,
      [user.id, userAgent],
    );
    const { same_device: sameDevice, logins } = seen.rows[0] ?? {};
    if (logins > 0 && !sameDevice && (await shouldNotify(pool, user.id, "new-login"))) {
      mail(user, emails.newLogin(user.name, emails.describeDevice(userAgent), new Date()));
    }

    await recordAttempt(pool, { email, userId: user.id, succeeded: true, ...client(req) });
    await startSession(res, req, user.id, remember);
    res.json({ user: publicUser(user) });
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
