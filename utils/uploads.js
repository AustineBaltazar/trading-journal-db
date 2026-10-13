const { STORAGE_LIMIT_BYTES, usedStorageBytes } = require("./account");

// An upload link that isn't confirmed within this long is treated as abandoned
const PENDING_MINUTES = 30;

// All screenshots on the site together. When it's reached, new uploads stop for
// everyone, so a flood of accounts can't run up the AWS bill. GLOBAL_STORAGE_LIMIT_GB.
const globalLimitBytes = () =>
  Number(process.env.GLOBAL_STORAGE_LIMIT_GB || 20) * 1024 * 1024 * 1024;

async function pendingBytes(db, userId) {
  const result = await db.query(
    "SELECT coalesce(sum(size_bytes), 0) AS n FROM pending_uploads WHERE user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function siteBytes(db) {
  const result = await db.query(
    `SELECT coalesce((SELECT sum(size_bytes) FROM trade_images), 0)
          + coalesce((SELECT sum(size_bytes) FROM journal_images), 0)
          + coalesce((SELECT sum(size_bytes) FROM pending_uploads), 0) AS n`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

// Why `size` more bytes can't be uploaded right now, or null. Uploads still in
// progress count, so asking for many links at once can't get around the limit.
async function uploadProblem(db, userId, size) {
  const mine = (await usedStorageBytes(db, userId)) + (await pendingBytes(db, userId));
  if (mine + Number(size) > STORAGE_LIMIT_BYTES) {
    return "Your screenshots have reached the 200 MB beta limit. Delete some to add more.";
  }
  if ((await siteBytes(db)) + Number(size) > globalLimitBytes()) {
    return "Screenshot uploads are paused for a while. Your journal still works; try again later.";
  }
  return null;
}

// Remember a signed link until its upload is confirmed (or cleaned up)
function reserveUpload(db, userId, key, size) {
  return db.query("INSERT INTO pending_uploads (s3_key, user_id, size_bytes) VALUES ($1, $2, $3)", [
    key,
    userId,
    size,
  ]);
}

function confirmUpload(db, key) {
  return db.query("DELETE FROM pending_uploads WHERE s3_key = $1", [key]);
}

// Delete files whose upload was never confirmed. Returns how many were cleaned up.
async function cleanStaleUploads(db, s3) {
  const stale = await db.query(
    `SELECT s3_key FROM pending_uploads
     WHERE created_at < now() - make_interval(mins => $1)
     ORDER BY created_at LIMIT 500`,
    [PENDING_MINUTES],
  );
  let cleaned = 0;
  for (const { s3_key } of stale.rows) {
    try {
      await s3.deleteObject(s3_key); // fine if nothing was ever uploaded
      await db.query("DELETE FROM pending_uploads WHERE s3_key = $1", [s3_key]);
      cleaned += 1;
    } catch (err) {
      console.error("Couldn't clean up upload", s3_key, err.message);
    }
  }
  return cleaned;
}

module.exports = {
  PENDING_MINUTES,
  globalLimitBytes,
  uploadProblem,
  reserveUpload,
  confirmUpload,
  cleanStaleUploads,
};
