// Login lockout: counted per email (whether or not it has an account),
// from the failures since the last successful login in the past day.
const CAPTCHA_AFTER = 3;
const LOCK_AFTER = 5;
const MAX_LOCK_MINUTES = 60;

// 5 min after 5 failures, 10 after 10, 20 after 15 ... up to an hour
function lockMinutes(failures) {
  if (failures < LOCK_AFTER) return 0;
  return Math.min(5 * 2 ** Math.floor((failures - LOCK_AFTER) / LOCK_AFTER), MAX_LOCK_MINUTES);
}

// What the login form is allowed to do right now
function loginState({ failures, lastFailureAt }, now = Date.now()) {
  const minutes = lockMinutes(failures);
  const lockedUntil = minutes && lastFailureAt ? new Date(lastFailureAt).getTime() + minutes * 60000 : 0;
  return {
    failures,
    captchaRequired: failures >= CAPTCHA_AFTER,
    retryAfter: lockedUntil > now ? Math.ceil((lockedUntil - now) / 1000) : 0,
    attemptsLeft: Math.max(LOCK_AFTER - failures, 0),
  };
}

async function recentFailures(db, email) {
  const result = await db.query(
    `SELECT count(*)::int AS failures, max(created_at) AS "lastFailureAt"
     FROM login_attempts
     WHERE email = $1 AND NOT succeeded AND created_at > now() - interval '1 day'
       AND created_at > coalesce(
         (SELECT max(created_at) FROM login_attempts WHERE email = $1 AND succeeded), '-infinity')`,
    [email],
  );
  return result.rows[0];
}

function recordAttempt(db, { email, userId, succeeded, ip, userAgent }) {
  return db.query(
    `INSERT INTO login_attempts (email, user_id, succeeded, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [email, userId || null, succeeded, ip || null, (userAgent || "").slice(0, 300)],
  );
}

module.exports = { lockMinutes, loginState, recentFailures, recordAttempt, CAPTCHA_AFTER, LOCK_AFTER };
