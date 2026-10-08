const { DEFAULT_MISTAKES, parseMistakeName, parseMistakeIds } = require("../utils/mistakes");

test("starting list has 8 distinct mistakes", () => {
  expect(DEFAULT_MISTAKES).toHaveLength(8);
  expect(new Set(DEFAULT_MISTAKES.map((m) => m.toLowerCase())).size).toBe(8);
});

describe("parseMistakeName", () => {
  test("trims valid names", () => {
    expect(parseMistakeName("  Didn't wait for SMT ")).toEqual({ name: "Didn't wait for SMT" });
  });

  test.each([[""], ["   "], [undefined], [42], ["x".repeat(81)]])("rejects %p", (value) => {
    expect(parseMistakeName(value).error).toBeDefined();
  });
});

describe("parseMistakeIds", () => {
  test("accepts ids and removes duplicates", () => {
    expect(parseMistakeIds([3, "5", 3])).toEqual({ ids: [3, 5] });
    expect(parseMistakeIds([])).toEqual({ ids: [] });
  });

  test.each([[undefined], ["3"], [[0]], [[-1]], [[1.5]], [["abc"]]])("rejects %p", (value) => {
    expect(parseMistakeIds(value).error).toBeDefined();
  });
});
