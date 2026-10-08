const { parseJournalFields } = require("../utils/tradeFields");

test("accepts valid journal fields", () => {
  const result = parseJournalFields({
    entry_time: "09:30",
    exit_time: "10:15:00",
    session: "New York AM",
    emotions: ["FOMO", "Anxious"],
    grade: "B+",
    result: "be",
  });
  expect(result.error).toBeUndefined();
  expect(result.values).toEqual({
    entry_time: "09:30",
    exit_time: "10:15:00",
    session: "New York AM",
    emotions: ["FOMO", "Anxious"],
    grade: "B+",
    result: "be",
    resultSent: true,
  });
});

test("treats missing or blank fields as null", () => {
  const result = parseJournalFields({ entry_time: "", session: null });
  expect(result.values).toEqual({
    entry_time: null,
    exit_time: null,
    session: null,
    emotions: null,
    grade: null,
    result: null,
    resultSent: false,
  });
});

test.each([
  [{ entry_time: "24:00" }, "entry_time"],
  [{ exit_time: "9:30" }, "exit_time"],
  [{ entry_time: 930 }, "entry_time"],
  [{ session: "Tokyo" }, "session"],
  [{ emotion: "calm" }, "emotions"],
  [{ emotions: ["Calm", "Bored"] }, "emotions"],
  [{ emotions: "Calm" }, "emotions"],
  [{ grade: "E" }, "grade"],
  [{ result: "draw" }, "result"],
])("rejects invalid input %o", (body, field) => {
  const result = parseJournalFields(body);
  expect(result.error).toMatch(new RegExp(`^${field} `));
});

describe("parseMode", () => {
  const { parseMode } = require("../utils/tradeFields");

  test("accepts live and backtest", () => {
    expect(parseMode("live")).toEqual({ mode: "live" });
    expect(parseMode("backtest")).toEqual({ mode: "backtest" });
  });

  test("falls back when missing", () => {
    expect(parseMode(undefined)).toEqual({ mode: "live" });
    expect(parseMode("")).toEqual({ mode: "live" });
    expect(parseMode(undefined, null)).toEqual({ mode: null });
  });

  test("rejects anything else", () => {
    expect(parseMode("paper").error).toMatch(/^mode must be one of/);
    expect(parseMode(["live"]).error).toMatch(/^mode must be one of/);
  });
});

describe("emotions", () => {
  test("a single emotion from older clients becomes a list", () => {
    expect(parseJournalFields({ emotion: "Calm" }).values.emotions).toEqual(["Calm"]);
    expect(parseJournalFields({ emotion: "" }).values.emotions).toEqual([]);
  });

  test("repeats are dropped and order kept", () => {
    expect(parseJournalFields({ emotions: ["FOMO", "Calm", "FOMO"] }).values.emotions).toEqual(["FOMO", "Calm"]);
  });

  test("an empty list clears them", () => {
    expect(parseJournalFields({ emotions: [] }).values.emotions).toEqual([]);
  });
});

test("result null means auto, and is still marked as sent", () => {
  expect(parseJournalFields({ result: null }).values).toMatchObject({ result: null, resultSent: true });
});
