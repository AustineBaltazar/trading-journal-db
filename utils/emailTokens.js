const crypto = require("crypto");
const { hashToken } = require("./sessions");

const TOKEN_MINUTES = 30;
// At most this many links of one kind per account per hour, so nobody can flood an inbox
const MAX_PER_HOUR = 3;

async function recentTokenCount(db, userId, purpose) {
  const result = await db.query(
    `SELECT count(*)::int AS n FROM email_tokens
     WHERE user_id = $1 AND purpose = $2 AND created_at > now() - interval '1 hour'`,
    [userId, purpose],
  );
  return result.rows[0].n;
}

// A new one-time link token, or null when the hourly limit is used up
async function issueToken(db, userId, purpose) {
  if ((await recentTokenCount(db, userId, purpose)) >= MAX_PER_HOUR) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, purpose, hashToken(token), TOKEN_MINUTES],
  );
  return token;
}

const wellFormed = (token) => typeof token === "string" && token.length >= 20 && token.length <= 100;

// The user a live token belongs to, without using it up
async function peekToken(db, token, purpose) {
  if (!wellFormed(token)) return null;
  const result = await db.query(
    `SELECT u.id, u.name, u.email FROM email_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.expires_at > now()`,
    [hashToken(token), purpose],
  );
  return result.rows[0] || null;
}

// Uses up a token. Returns its user, or null when it's unknown, used, or expired.
async function consumeToken(db, token, purpose) {
  if (!wellFormed(token)) return null;
  const result = await db.query(
    `UPDATE email_tokens t SET used_at = now()
     FROM users u
     WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.expires_at > now()
       AND u.id = t.user_id
     RETURNING u.id, u.name, u.email, u.email_verified_at`,
    [hashToken(token), purpose],
  );
  return result.rows[0] || null;
}

// A security notice of this kind wasn't sent to this user in the last hour; records it if so
async function shouldNotify(db, userId, kind) {
  const recent = await db.query(
    `SELECT 1 FROM email_log WHERE user_id = $1 AND kind = $2 AND created_at > now() - interval '1 hour' LIMIT 1`,
    [userId, kind],
  );
  if (recent.rows.length > 0) return false;
  await db.query("INSERT INTO email_log (user_id, kind) VALUES ($1, $2)", [userId, kind]);
  return true;
}

module.exports = { issueToken, peekToken, consumeToken, shouldNotify, TOKEN_MINUTES, MAX_PER_HOUR };
