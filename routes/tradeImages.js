const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const pool = require("../db");
const requireAuth = require("../middleware/auth");
const {
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  parseImageFile,
  userTradeImagePrefix,
} = require("../utils/journal");
const s3 = require("../utils/s3");

const MAX_IMAGES_PER_TRADE = 6;

function cleanCaption(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) || null : null;
}

async function ownsTrade(tradeId, userId) {
  const result = await pool.query("SELECT id FROM trades WHERE id = $1 AND user_id = $2", [tradeId, userId]);
  return result.rows.length > 0;
}

// Step 1 of an upload: a short-lived signed link the browser PUTs the file to
router.post("/trades/:id/images/upload-url", requireAuth, async (req, res) => {
  if (!s3.imagesConfigured()) return res.status(503).json({ error: "Image uploads aren't set up yet." });
  const file = parseImageFile(req.body);
  if (file.error) return res.status(400).json({ error: file.error });
  try {
    const tradeId = req.params.id;
    if (!(await ownsTrade(tradeId, req.userId))) return res.status(404).json({ error: "Trade not found." });
    const count = await pool.query("SELECT count(*)::int AS n FROM trade_images WHERE trade_id = $1", [tradeId]);
    if (count.rows[0].n >= MAX_IMAGES_PER_TRADE) {
      return res.status(400).json({ error: `Up to ${MAX_IMAGES_PER_TRADE} screenshots per trade.` });
    }
    const key = `${userTradeImagePrefix(req.userId)}${tradeId}/${crypto.randomUUID()}.${file.ext}`;
    res.json({ key, uploadUrl: await s3.uploadUrl(key, file.contentType, file.size) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong preparing the upload." });
  }
});

// Step 2: after the browser uploaded, check the object really is there and record it
router.post("/trades/:id/images", requireAuth, async (req, res) => {
  if (!s3.imagesConfigured()) return res.status(503).json({ error: "Image uploads aren't set up yet." });
  const key = req.body?.key;
  try {
    const tradeId = req.params.id;
    if (!(await ownsTrade(tradeId, req.userId))) return res.status(404).json({ error: "Trade not found." });
    if (typeof key !== "string" || !key.startsWith(`${userTradeImagePrefix(req.userId)}${tradeId}/`)) {
      return res.status(400).json({ error: "That upload doesn't belong to this trade." });
    }

    const head = await s3.headObject(key);
    if (!head) return res.status(400).json({ error: "The upload didn't finish. Try again." });
    if (head.size > MAX_IMAGE_BYTES || !IMAGE_TYPES[head.contentType]) {
      await s3.deleteObject(key);
      return res.status(400).json({ error: "Images must be PNG, JPG or WebP, 5 MB or smaller." });
    }

    const result = await pool.query(
      `INSERT INTO trade_images (trade_id, s3_key, caption, content_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (s3_key) DO UPDATE SET caption = EXCLUDED.caption
       RETURNING id, caption, created_at`,
      [tradeId, key, cleanCaption(req.body?.caption), head.contentType, head.size],
    );
    const image = result.rows[0];
    res.status(201).json({
      id: image.id,
      caption: image.caption,
      createdAt: image.created_at,
      url: await s3.viewUrl(key),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong saving the screenshot." });
  }
});

// Screenshots are owned through their trade
async function ownedImage(imageId, userId) {
  const result = await pool.query(
    `SELECT i.id, i.s3_key FROM trade_images i
     JOIN trades t ON t.id = i.trade_id
     WHERE i.id = $1 AND t.user_id = $2`,
    [imageId, userId],
  );
  return result.rows[0] || null;
}

router.patch("/trade-images/:id", requireAuth, async (req, res) => {
  try {
    const image = await ownedImage(req.params.id, req.userId);
    if (!image) return res.status(404).json({ error: "Screenshot not found." });
    const caption = cleanCaption(req.body?.caption);
    await pool.query("UPDATE trade_images SET caption = $1 WHERE id = $2", [caption, image.id]);
    res.json({ id: image.id, caption });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong updating the caption." });
  }
});

router.delete("/trade-images/:id", requireAuth, async (req, res) => {
  try {
    const image = await ownedImage(req.params.id, req.userId);
    if (!image) return res.status(404).json({ error: "Screenshot not found." });
    await pool.query("DELETE FROM trade_images WHERE id = $1", [image.id]);
    // Row first: if S3 fails the screenshot is already gone from the trade; log it for cleanup
    s3.deleteObject(image.s3_key).catch((err) => console.error("S3 delete failed", image.s3_key, err));
    res.json({ message: "Screenshot deleted.", id: image.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong deleting the screenshot." });
  }
});

module.exports = router;
