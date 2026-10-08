// Starting list every new account gets (also added for existing users by migration 003)
const DEFAULT_MISTAKES = [
  "Entered too early",
  "Moved my stop",
  "Oversized the position",
  "Chased the move",
  "Exited too early",
  "Traded during news",
  "Revenge trade",
  "Outside my session",
];

// Name from a request body: trimmed, 1-80 characters. Returns { name } or { error }.
function parseMistakeName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { error: "Mistake name is required." };
  if (name.length > 80) return { error: "Mistake name must be 80 characters or less." };
  return { name };
}

// mistake_ids from a request body: an array of distinct positive integers.
// Returns { ids } or { error }.
function parseMistakeIds(value) {
  if (!Array.isArray(value)) return { error: "mistake_ids must be an array." };
  const ids = value.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { error: "mistake_ids must contain mistake ids." };
  }
  return { ids: [...new Set(ids)] };
}

module.exports = { DEFAULT_MISTAKES, parseMistakeName, parseMistakeIds };
