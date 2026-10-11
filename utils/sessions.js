const crypto = require("crypto");

const COOKIE_NAME = "mnq_session";
const DAY_MS = 24 * 60 * 60 * 1000;
// "Keep me logged in" lasts 30 days; otherwise the cookie ends with the browser,
// and the server gives up on it after a day either way
const REMEMBER_MS = 30 * DAY_MS;
const BROWSER_SESSION_MS = DAY_MS;
// last_seen_at is refreshed at most this often
const TOUCH_MS = 5 * 60 * 1000;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

function cookieOptions(remember) {
  return {
    httpOnly: true,
    // Browsers treat http://localhost as secure, so this is on for local dev too
    secure: process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
    path: "/",
    ...(remember ? { maxAge: REMEMBER_MS } : {}),
  };
}

async function createSession(db, userId, { remember, userAgent, ip }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (remember ? REMEMBER_MS : BROWSER_SESSION_MS));
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, remember, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, hashToken(token), Boolean(remember), (userAgent || "").slice(0, 300), ip || null, expiresAt],
  );
  return token;
}

// The live session for a cookie token, with its user, or null
async function findSession(db, token) {
  if (typeof token !== "string" || token.length < 20) return null;
  const result = await db.query(
    `SELECT s.id, s.user_id, s.last_seen_at, u.name, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(token)],
  );
  const session = result.rows[0];
  if (session && Date.now() - new Date(session.last_seen_at).getTime() > TOUCH_MS) {
    db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [session.id]).catch(() => {});
  }
  return session || null;
}

function revokeSession(db, token) {
  return db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [
    hashToken(token),
  ]);
}

module.exports = { COOKIE_NAME, cookieOptions, createSession, findSession, revokeSession, hashToken };
