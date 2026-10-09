// Starter tag groups every new account gets (also added for existing users by migration 006)
const DEFAULT_TAG_GROUPS = [
  { name: "Setup", tags: [] },
  { name: "News", tags: ["CPI", "FOMC", "NFP"] },
  { name: "Market", tags: ["Trend day", "Range day", "Gap"] },
];

// A group or tag name from a request body: trimmed, 1-40 characters.
// Returns { name } or { error }.
function parseName(value, what) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { error: `${what} name is required.` };
  if (name.length > 40) return { error: `${what} name must be 40 characters or less.` };
  return { name };
}

// tag_ids from a request body: an array of distinct positive integers.
function parseTagIds(value) {
  if (!Array.isArray(value)) return { error: "tag_ids must be an array." };
  const ids = value.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { error: "tag_ids must contain tag ids." };
  }
  return { ids: [...new Set(ids)] };
}

module.exports = { DEFAULT_TAG_GROUPS, parseName, parseTagIds };
