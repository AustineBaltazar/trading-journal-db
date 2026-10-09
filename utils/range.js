const { parseEntryDate } = require("./journal");

const RULE_CATEGORIES = ["Entry", "Setup", "Risk", "Market"];

// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD. Returns { from, to } (null = open) or { error }.
function parseRange(query) {
  const range = { from: null, to: null };
  for (const key of ["from", "to"]) {
    if (query[key] === undefined || query[key] === "") continue;
    range[key] = parseEntryDate(query[key]);
    if (!range[key]) return { error: `${key} must be a date (YYYY-MM-DD).` };
  }
  return range;
}

// Description and category from a rule request body. Only fields that were sent come back.
function parseRuleDetails(body) {
  const values = {};
  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    const d = typeof body.description === "string" ? body.description.trim() : "";
    if (d.length > 160) return { error: "Description must be 160 characters or less." };
    values.description = d || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "category")) {
    const c = body.category === "" || body.category === null ? null : body.category;
    if (c !== null && !RULE_CATEGORIES.includes(c)) {
      return { error: `category must be one of: ${RULE_CATEGORIES.join(", ")}.` };
    }
    values.category = c;
  }
  return { values };
}

module.exports = { RULE_CATEGORIES, parseRange, parseRuleDetails };
