const SESSIONS = ["Asian", "London", "New York AM", "New York PM"];
const EMOTIONS = ["Confident", "Anxious", "FOMO", "Revenge", "Calm", "Hesitant"];
const GRADES = ["A+", "A", "B+", "B", "C+", "C", "D", "F"];

// 24-hour HH:MM, optionally with :SS (what <input type="time"> can send)
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

// Columns returned for every trade. Times come back as HH:MM so they drop
// straight into <input type="time">.
const TRADE_COLUMNS = `id, user_id, trade_date::text, symbol, direction, contracts, entry_price, exit_price, fees, strategy, screenshot_link, notes,
  to_char(entry_time, 'HH24:MI') AS entry_time, to_char(exit_time, 'HH24:MI') AS exit_time, session, emotion, grade`;

function blankToNull(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

// Validates the optional journal fields from a request body.
// Returns { values } with normalized values, or { error } with a message.
function parseJournalFields(body) {
  const values = {
    entry_time: blankToNull(body.entry_time),
    exit_time: blankToNull(body.exit_time),
    session: blankToNull(body.session),
    emotion: blankToNull(body.emotion),
    grade: blankToNull(body.grade),
  };

  for (const field of ["entry_time", "exit_time"]) {
    const value = values[field];
    if (value !== null && (typeof value !== "string" || !TIME_PATTERN.test(value))) {
      return { error: `${field} must be a time in HH:MM format.` };
    }
  }

  const allowed = { session: SESSIONS, emotion: EMOTIONS, grade: GRADES };
  for (const [field, options] of Object.entries(allowed)) {
    const value = values[field];
    if (value !== null && !options.includes(value)) {
      return { error: `${field} must be one of: ${options.join(", ")}.` };
    }
  }

  return { values };
}

module.exports = {
  SESSIONS,
  EMOTIONS,
  GRADES,
  TRADE_COLUMNS,
  parseJournalFields,
};
