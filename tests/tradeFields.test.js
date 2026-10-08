const { parseJournalFields } = require("../utils/tradeFields");

test("accepts valid journal fields", () => {
  const result = parseJournalFields({
    entry_time: "09:30",
    exit_time: "10:15:00",
    session: "New York AM",
    emotion: "FOMO",
    grade: "B+",
  });
  expect(result.error).toBeUndefined();
  expect(result.values).toEqual({
    entry_time: "09:30",
    exit_time: "10:15:00",
    session: "New York AM",
    emotion: "FOMO",
    grade: "B+",
  });
});

test("treats missing or blank fields as null", () => {
  const result = parseJournalFields({ entry_time: "", session: null });
  expect(result.values).toEqual({
    entry_time: null,
    exit_time: null,
    session: null,
    emotion: null,
    grade: null,
  });
});

test.each([
  [{ entry_time: "24:00" }, "entry_time"],
  [{ exit_time: "9:30" }, "exit_time"],
  [{ entry_time: 930 }, "entry_time"],
  [{ session: "Tokyo" }, "session"],
  [{ emotion: "calm" }, "emotion"],
  [{ grade: "E" }, "grade"],
])("rejects invalid input %o", (body, field) => {
  const result = parseJournalFields(body);
  expect(result.error).toMatch(new RegExp(`^${field} `));
});
