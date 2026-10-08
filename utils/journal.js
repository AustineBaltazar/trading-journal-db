const BIASES = ["bullish", "neutral", "bearish"];
const FOLLOWED = ["yes", "partly", "no"];
const MOODS = ["Focused", "Calm", "Bored", "Tired", "Frustrated"];
const DAY_GRADES = ["A", "B", "C", "D", "F"];
const SECTIONS = ["pre", "post"];
const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_SECTION = 6;
const MAX_LEVELS = 10;
const MAX_TEXT = 2000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// A real calendar date in YYYY-MM-DD, or null
function parseEntryDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

// "2026-09" -> first and last day, or null
function parseMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [y, m] = value.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${value}-01`, to: `${value}-${String(last).padStart(2, "0")}` };
}

const blank = (v) => v === undefined || v === null || v === "";

// Validates a PUT /journal/:date body. Only fields present in the body are
// returned, so a partial save (auto-save of one field) leaves the rest alone.
// Returns { values } or { error }.
function parseEntryFields(body) {
  const values = {};
  const text = (field) => {
    if (!(field in body)) return null;
    const v = body[field];
    if (blank(v)) values[field] = null;
    else if (typeof v !== "string") return `${field} must be text.`;
    else if (v.length > MAX_TEXT) return `${field} must be ${MAX_TEXT} characters or less.`;
    else values[field] = v.trim() || null;
    return null;
  };
  const choice = (field, options) => {
    if (!(field in body)) return null;
    const v = body[field];
    if (blank(v)) values[field] = null;
    else if (!options.includes(v)) return `${field} must be one of: ${options.join(", ")}.`;
    else values[field] = v;
    return null;
  };

  const errors = [
    choice("bias", BIASES),
    text("bias_reason"),
    text("plan"),
    text("news"),
    text("focus"),
    choice("followed_plan", FOLLOWED),
    choice("mood", MOODS),
    choice("day_grade", DAY_GRADES),
    text("went_well"),
    text("to_fix"),
    text("lesson"),
  ].filter(Boolean);
  if (errors.length) return { error: errors[0] };

  if ("key_levels" in body) {
    const levels = body.key_levels;
    if (!Array.isArray(levels)) return { error: "key_levels must be a list." };
    if (levels.length > MAX_LEVELS) return { error: `Up to ${MAX_LEVELS} key levels.` };
    const cleaned = [];
    for (const level of levels) {
      const price = Number(level?.price);
      const label = typeof level?.label === "string" ? level.label.trim().slice(0, 80) : "";
      if (!Number.isFinite(price) || price <= 0) return { error: "Each key level needs a price." };
      cleaned.push({ price, label });
    }
    values.key_levels = cleaned;
  }
  return { values };
}

// Checks an image upload request. Returns { section, contentType, size, ext } or { error }.
// Type and size of a file the browser wants to upload (journal or trade)
function parseImageFile(body) {
  const contentType = body?.content_type;
  const size = Number(body?.size_bytes);
  if (!IMAGE_TYPES[contentType]) return { error: "Images must be PNG, JPG or WebP." };
  if (!Number.isInteger(size) || size <= 0) return { error: "size_bytes is required." };
  if (size > MAX_IMAGE_BYTES) return { error: "Images must be 5 MB or smaller." };
  return { contentType, size, ext: IMAGE_TYPES[contentType] };
}

function parseImageRequest(body) {
  if (!SECTIONS.includes(body?.section)) return { error: "section must be pre or post." };
  const file = parseImageFile(body);
  return file.error ? file : { section: body.section, ...file };
}

// Every image lives under the owner's prefix, so ownership can be checked from the key
function userImagePrefix(userId) {
  return `users/${userId}/journal/`;
}

function userTradeImagePrefix(userId) {
  return `users/${userId}/trades/`;
}

module.exports = {
  BIASES,
  FOLLOWED,
  MOODS,
  DAY_GRADES,
  SECTIONS,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_SECTION,
  parseEntryDate,
  parseMonth,
  parseEntryFields,
  parseImageFile,
  parseImageRequest,
  userImagePrefix,
  userTradeImagePrefix,
};
