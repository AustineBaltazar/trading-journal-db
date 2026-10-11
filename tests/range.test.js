const { parseRange, parseRuleDetails } = require("../utils/range");

test("parseRange: optional, validated dates", () => {
  expect(parseRange({})).toEqual({ from: null, to: null });
  expect(parseRange({ from: "2026-09-01", to: "" })).toEqual({ from: "2026-09-01", to: null });
  expect(parseRange({ to: "2026-02-30" }).error).toMatch(/^to must be a date/);
});

describe("parseRuleDetails", () => {
  test("only fields that were sent", () => {
    expect(parseRuleDetails({ name: "IFVG" })).toEqual({ values: {} });
    expect(parseRuleDetails({ description: "  Wait for the retest. ", category: "Entry" })).toEqual({
      values: { description: "Wait for the retest.", category: "Entry" },
    });
  });

  test("blank clears", () => {
    expect(parseRuleDetails({ description: "", category: "" })).toEqual({
      values: { description: null, category: null },
    });
  });

  test("rejects long descriptions and unknown categories", () => {
    expect(parseRuleDetails({ description: "x".repeat(161) }).error).toMatch(/160/);
    expect(parseRuleDetails({ category: "Vibes" }).error).toMatch(/^category must be one of/);
  });
});
