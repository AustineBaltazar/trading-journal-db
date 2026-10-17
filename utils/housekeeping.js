const { cleanStaleUploads } = require("./uploads");

const UNCONFIRMED_DAYS = 7;
const EVERY_MINUTES = 15;

// Sign-ups whose email was never confirmed (and never used Google) can't log in, so
// after a week they're removed. Only accounts with no trades or journal days.
async function removeUnconfirmedAccounts(pool) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      `SELECT id, email FROM users u
       WHERE email_verified_at IS NULL AND google_sub IS NULL
         AND created_at < now() - make_interval(days => $1)
         AND NOT EXISTS (SELECT 1 FROM trades t WHERE t.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.user_id = u.id)
       LIMIT 500
       FOR UPDATE`,
      [UNCONFIRMED_DAYS],
    );
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      // The starter mistakes, tag groups, etc. made at sign-up
      for (const table of ["mistakes", "questions", "rules", "tag_groups"]) {
        await db.query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [ids]);
      }
      await db.query("DELETE FROM login_attempts WHERE email = ANY($1)", [rows.map((r) => r.email)]);
      await db.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
    }
    await db.query("COMMIT");
    return rows.length;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function runHousekeeping(pool, s3) {
  const uploads = s3.imagesConfigured() ? await cleanStaleUploads(pool, s3) : 0;
  const accounts = await removeUnconfirmedAccounts(pool);
  if (uploads || accounts) {
    console.log(`Housekeeping: removed ${uploads} unfinished uploads, ${accounts} unconfirmed accounts`);
  }
  return { uploads, accounts };
}

// Started by server.js (not app.js, so tests don't run it)
function startHousekeeping(pool, s3) {
  const run = () => runHousekeeping(pool, s3).catch((err) => console.error("Housekeeping failed:", err.message));
  setTimeout(run, 60 * 1000);
  return setInterval(run, EVERY_MINUTES * 60 * 1000);
}

module.exports = { UNCONFIRMED_DAYS, removeUnconfirmedAccounts, runHousekeeping, startHousekeeping };
