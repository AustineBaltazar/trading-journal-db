const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { parseMode } = require("../utils/tradeFields");
const {
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_SECTION,
  parseEntryDate,
  parseMonth,
  parseEntryFields,
  parseImageRequest,
  userImagePrefix,
} = require("../utils/journal");
const s3 = require("../utils/s3");

const ENTRY_COLUMNS = `id, mode, entry_date::text, bias, bias_reason, key_levels, plan, news, focus,
  followed_plan, mood, day_grade, went_well, to_fix, lesson, updated_at`;

// Shared request checks: valid mode and date. Responds and returns null on error.
function dayParams(req, res) {
  const { mode, error } = parseMode(req.query.mode);
  if (error) {
    res.status(400).json({ error });
    return null;
  }
  const date = parseEntryDate(req.params.date);
  if (!date) {
    res.status(400).json({ error: "Date must be YYYY-MM-DD." });
    return null;
  }
  return { mode, date };
}

// The day's entry id, creating an empty entry if needed (images need an entry)
async function ensureEntryId(userId, mode, date) {
  const result = await pool.query(
    `INSERT INTO journal_entries (user_id, mode, entry_date) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, mode, entry_date) DO UPDATE SET updated_at = journal_entries.updated_at
     RETURNING id`,
    [userId, mode, date],
  );
  return result.rows[0].id;
}

async function withViewUrls(images) {
  return Promise.all(
    images.map(async (img) => ({
      id: img.id,
      section: img.section,
      caption: img.caption,
      createdAt: img.created_at,
      url: await s3.viewUrl(img.s3_key),
    })),
  );
}

// Month overview for the day list: which days have a plan / review
router.get("/journal", requireAuth, async (req, res) => {
  try {
    const { mode, error } = parseMode(req.query.mode);
    if (error) return res.status(400).json({ error });
    const month = parseMonth(req.query.month);
    if (!month) return res.status(400).json({ error: "month must be YYYY-MM." });

    const result = await pool.query(
      `SELECT e.entry_date::text AS date, e.bias, e.followed_plan, e.mood, e.day_grade, e.lesson,
         (e.bias IS NOT NULL OR e.bias_reason IS NOT NULL OR e.plan IS NOT NULL OR e.news IS NOT NULL
           OR e.focus IS NOT NULL OR jsonb_array_length(e.key_levels) > 0) AS "hasPlan",
         (e.followed_plan IS NOT NULL OR e.mood IS NOT NULL OR e.day_grade IS NOT NULL
           OR e.went_well IS NOT NULL OR e.to_fix IS NOT NULL OR e.lesson IS NOT NULL) AS "hasReview",
         count(i.id)::int AS "imageCount"
       FROM journal_entries e
       LEFT JOIN journal_images i ON i.entry_id = e.id
       WHERE e.user_id = $1 AND e.mode = $2 AND e.entry_date BETWEEN $3 AND $4
       GROUP BY e.id
       ORDER BY e.entry_date DESC`,
      [req.userId, mode, month.from, month.to],
    );
    res.json({ entries: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching the journal." });
  }
});

router.get("/journal/:date", requireAuth, async (req, res) => {
  const p = dayParams(req, res);
  if (!p) return;
  try {
    const entry = await pool.query(
      `SELECT ${ENTRY_COLUMNS} FROM journal_entries WHERE user_id = $1 AND mode = $2 AND entry_date = $3`,
      [req.userId, p.mode, p.date],
    );
    if (entry.rows.length === 0) return res.json({ entry: null, images: [] });

    const images = await pool.query(
      "SELECT id, section, caption, s3_key, created_at FROM journal_images WHERE entry_id = $1 ORDER BY id",
      [entry.rows[0].id],
    );
    res.json({
      entry: entry.rows[0],
      images: s3.imagesConfigured() ? await withViewUrls(images.rows) : [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching the entry." });
  }
});

// Creates or updates the day's entry with whichever fields are sent (auto-save)
router.put("/journal/:date", requireAuth, async (req, res) => {
  const p = dayParams(req, res);
  if (!p) return;
  const { values, error } = parseEntryFields(req.body || {});
  if (error) return res.status(400).json({ error });
  try {
    const columns = Object.keys(values);
    const params = [req.userId, p.mode, p.date, ...columns.map((c) =>
      c === "key_levels" ? JSON.stringify(values[c]) : values[c],
    )];
    const insertCols = ["user_id", "mode", "entry_date", ...columns].join(", ");
    const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
    const updates = [...columns.map((c) => `${c} = EXCLUDED.${c}`), "updated_at = now()"].join(", ");
    const result = await pool.query(
      `INSERT INTO journal_entries (${insertCols}) VALUES (${placeholders})
       ON CONFLICT (user_id, mode, entry_date) DO UPDATE SET ${updates}
       RETURNING ${ENTRY_COLUMNS}`,
      params,
    );
    res.json({ entry: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the entry." });
  }
});

// Step 1 of an upload: a short-lived signed link the browser PUTs the file to
router.post("/journal/:date/images/upload-url", requireAuth, async (req, res) => {
  const p = dayParams(req, res);
  if (!p) return;
  if (!s3.imagesConfigured()) return res.status(503).json({ error: "Image uploads aren't set up yet." });
  const img = parseImageRequest(req.body);
  if (img.error) return res.status(400).json({ error: img.error });
  try {
    const entryId = await ensureEntryId(req.userId, p.mode, p.date);
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM journal_images WHERE entry_id = $1 AND section = $2",
      [entryId, img.section],
    );
    if (count.rows[0].n >= MAX_IMAGES_PER_SECTION) {
      return res.status(400).json({ error: `Up to ${MAX_IMAGES_PER_SECTION} images per section.` });
    }
    const key = `${userImagePrefix(req.userId)}${entryId}/${crypto.randomUUID()}.${img.ext}`;
    res.json({ key, uploadUrl: await s3.uploadUrl(key, img.contentType, img.size) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong preparing the upload." });
  }
});

// Step 2: after the browser uploaded, check the object really is there and record it
router.post("/journal/:date/images", requireAuth, async (req, res) => {
  const p = dayParams(req, res);
  if (!p) return;
  if (!s3.imagesConfigured()) return res.status(503).json({ error: "Image uploads aren't set up yet." });
  const { key, section } = req.body || {};
  const caption = typeof req.body?.caption === "string" ? req.body.caption.trim().slice(0, 120) || null : null;
  if (!["pre", "post"].includes(section)) return res.status(400).json({ error: "section must be pre or post." });
  try {
    const entry = await pool.query(
      "SELECT id FROM journal_entries WHERE user_id = $1 AND mode = $2 AND entry_date = $3",
      [req.userId, p.mode, p.date],
    );
    if (entry.rows.length === 0) return res.status(404).json({ error: "Entry not found." });
    const entryId = entry.rows[0].id;
    if (typeof key !== "string" || !key.startsWith(`${userImagePrefix(req.userId)}${entryId}/`)) {
      return res.status(400).json({ error: "That upload doesn't belong to this entry." });
    }

    const head = await s3.headObject(key);
    if (!head) return res.status(400).json({ error: "The upload didn't finish. Try again." });
    if (head.size > MAX_IMAGE_BYTES || !["image/png", "image/jpeg", "image/webp"].includes(head.contentType)) {
      await s3.deleteObject(key);
      return res.status(400).json({ error: "Images must be PNG, JPG or WebP, 5 MB or smaller." });
    }

    const result = await pool.query(
      `INSERT INTO journal_images (entry_id, section, s3_key, caption, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (s3_key) DO UPDATE SET caption = EXCLUDED.caption
       RETURNING id, section, caption, s3_key, created_at`,
      [entryId, section, key, caption, head.contentType, head.size],
    );
    const [image] = await withViewUrls(result.rows);
    res.status(201).json(image);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the image." });
  }
});

// Images are owned through their entry
async function ownedImage(imageId, userId) {
  const result = await pool.query(
    `SELECT i.id, i.s3_key FROM journal_images i
     JOIN journal_entries e ON e.id = i.entry_id
     WHERE i.id = $1 AND e.user_id = $2`,
    [imageId, userId],
  );
  return result.rows[0] || null;
}

router.patch("/journal/images/:id", requireAuth, async (req, res) => {
  try {
    const image = await ownedImage(req.params.id, req.userId);
    if (!image) return res.status(404).json({ error: "Image not found." });
    const caption = typeof req.body?.caption === "string" ? req.body.caption.trim().slice(0, 120) || null : null;
    await pool.query("UPDATE journal_images SET caption = $1 WHERE id = $2", [caption, image.id]);
    res.json({ id: image.id, caption });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the caption." });
  }
});

router.delete("/journal/images/:id", requireAuth, async (req, res) => {
  try {
    const image = await ownedImage(req.params.id, req.userId);
    if (!image) return res.status(404).json({ error: "Image not found." });
    await pool.query("DELETE FROM journal_images WHERE id = $1", [image.id]);
    // Row first: if S3 fails the image is already gone from the journal; log it for cleanup
    s3.deleteObject(image.s3_key).catch((err) => console.error("S3 delete failed", image.s3_key, err));
    res.json({ message: "Image deleted.", id: image.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the image." });
  }
});

module.exports = router;
