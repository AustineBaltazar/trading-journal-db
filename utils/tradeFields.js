const SESSIONS = ["Asian", "London", "New York AM", "New York PM"];
const EMOTIONS = ["Confident", "Anxious", "FOMO", "Revenge", "Calm", "Hesitant"];
const GRADES = ["A+", "A", "B+", "B", "C+", "C", "D", "F"];
const MODES = ["live", "backtest"];
const RESULTS = ["win", "loss", "be"];

// 24-hour HH:MM, optionally with :SS (what <input type="time"> can send)
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

// Columns returned for every trade. Times come back as HH:MM so they drop
// straight into <input type="time">.
const TRADE_COLUMNS = `id, user_id, trade_date::text, symbol, direction, contracts, entry_price, exit_price, fees, strategy, screenshot_link, notes,
  to_char(entry_time, 'HH24:MI') AS entry_time, to_char(exit_time, 'HH24:MI') AS exit_time, session, emotions, grade, mode, result, stop_price, target_price`;

function blankToNull(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

// Emotions as a list without repeats. Older clients send a single `emotion`.
// Returns { emotions } (null when neither was sent) or { error }.
function parseEmotions(body) {
  let list;
  if (body.emotions !== undefined && body.emotions !== null) list = body.emotions;
  else if (body.emotion !== undefined) list = blankToNull(body.emotion) === null ? [] : [body.emotion];
  else return { emotions: null };

  if (!Array.isArray(list) || list.some((e) => !EMOTIONS.includes(e))) {
    return { error: `emotions must be a list of: ${EMOTIONS.join(", ")}.` };
  }
  return { emotions: [...new Set(list)] };
}

// Validates the optional journal fields from a request body.
// Returns { values } with normalized values, or { error } with a message.
// emotions is null and resultSent false when the client didn't send them,
// so an update can keep what's stored.
function parseJournalFields(body) {
  const values = {
    entry_time: blankToNull(body.entry_time),
    exit_time: blankToNull(body.exit_time),
    session: blankToNull(body.session),
    grade: blankToNull(body.grade),
    result: blankToNull(body.result),
    resultSent: Object.prototype.hasOwnProperty.call(body, "result"),
  };

  for (const field of ["entry_time", "exit_time"]) {
    const value = values[field];
    if (value !== null && (typeof value !== "string" || !TIME_PATTERN.test(value))) {
      return { error: `${field} must be a time in HH:MM format.` };
    }
  }

  const allowed = { session: SESSIONS, grade: GRADES, result: RESULTS };
  for (const [field, options] of Object.entries(allowed)) {
    const value = values[field];
    if (value !== null && !options.includes(value)) {
      return { error: `${field} must be one of: ${options.join(", ")}.` };
    }
  }

  const parsed = parseEmotions(body);
  if (parsed.error) return { error: parsed.error };
  values.emotions = parsed.emotions;

  return { values };
}

// Optional stop and target. Each must sit on the right side of the entry
// (long: stop below, target above; short: the other way round).
// Returns { values: { stop_price, target_price, stopsSent } } or { error }.
// stopsSent is false when the client sent neither, so an update keeps what's stored.
function parseStops(body) {
  const values = { stop_price: null, target_price: null };
  const stopsSent = ["stop_price", "target_price"].some((k) => Object.prototype.hasOwnProperty.call(body, k));
  for (const field of ["stop_price", "target_price"]) {
    const raw = blankToNull(body[field]);
    if (raw === null) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return { error: `${field} must be a price.` };
    values[field] = value;
  }
  const entry = Number(body.entry_price);
  const long = body.direction === "long";
  if (values.stop_price !== null && Number.isFinite(entry)) {
    if (long ? values.stop_price >= entry : values.stop_price <= entry) {
      return { error: `The stop for a ${long ? "long" : "short"} must be ${long ? "below" : "above"} the entry.` };
    }
  }
  if (values.target_price !== null && Number.isFinite(entry)) {
    if (long ? values.target_price <= entry : values.target_price >= entry) {
      return { error: `The target for a ${long ? "long" : "short"} must be ${long ? "above" : "below"} the entry.` };
    }
  }
  return { values: { ...values, stopsSent } };
}

// Mode from a query string or body. Missing means the fallback (live for
// reads and new trades; the trade's current mode for updates).
// Returns { mode } or { error }.
function parseMode(value, fallback = "live") {
  if (value === undefined || value === null || value === "") return { mode: fallback };
  if (!MODES.includes(value)) {
    return { error: `mode must be one of: ${MODES.join(", ")}.` };
  }
  return { mode: value };
}

module.exports = {
  SESSIONS,
  EMOTIONS,
  GRADES,
  MODES,
  RESULTS,
  TRADE_COLUMNS,
  parseJournalFields,
  parseStops,
  parseMode,
};
