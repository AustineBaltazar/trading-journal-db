const { parseStops } = require("../utils/tradeFields");
const { rValues, withPnl } = require("../utils/outcome");
const { parseName, parseTagIds } = require("../utils/tags");

describe("parseStops", () => {
  const long = { direction: "long", entry_price: 21000 };
  const short = { direction: "short", entry_price: 21085.25 };

  test("optional: nothing sent keeps what's stored", () => {
    expect(parseStops(long)).toEqual({ values: { stop_price: null, target_price: null, stopsSent: false } });
  });

  test("blank clears, numbers are kept", () => {
    expect(parseStops({ ...short, stop_price: "21105.25", target_price: "" }).values).toEqual({
      stop_price: 21105.25,
      target_price: null,
      stopsSent: true,
    });
  });

  test.each([
    [{ ...long, stop_price: 21010 }, /stop for a long must be below/],
    [{ ...long, target_price: 20990 }, /target for a long must be above/],
    [{ ...short, stop_price: 21000 }, /stop for a short must be above/],
    [{ ...short, target_price: 21100 }, /target for a short must be below/],
    [{ ...long, stop_price: "abc" }, /stop_price must be a price/],
    [{ ...long, stop_price: 21000 }, /stop for a long must be below/],
  ])("rejects %o", (body, message) => {
    expect(parseStops(body).error).toMatch(message);
  });
});

describe("rValues", () => {
  const trade = { direction: "short", entry_price: "21085.25", exit_price: "21028.75", stop_price: "21105.25", target_price: "21025.25" };

  test("result and planned R for a short", () => {
    expect(rValues(trade)).toEqual({ rMultiple: 2.83, plannedR: 3 });
  });

  test("a loss at the stop is -1R; past the stop is worse", () => {
    expect(rValues({ ...trade, exit_price: "21105.25" }).rMultiple).toBe(-1);
    expect(rValues({ ...trade, exit_price: "21111.25" }).rMultiple).toBe(-1.3);
  });

  test("no stop, or a stop on the wrong side, means no R", () => {
    expect(rValues({ ...trade, stop_price: null })).toEqual({ rMultiple: null, plannedR: null });
    expect(rValues({ ...trade, stop_price: "21000" })).toEqual({ rMultiple: null, plannedR: null });
    expect(rValues({ ...trade, target_price: null }).plannedR).toBeNull();
  });

  test("withPnl includes R", () => {
    const t = withPnl({ ...trade, symbol: "MNQ", contracts: 4, fees: "4.96", result: null });
    expect(t).toMatchObject({ netPnl: 447.04, outcome: "win", rMultiple: 2.83, plannedR: 3 });
  });
});

describe("tag input", () => {
  test("names are trimmed and limited", () => {
    expect(parseName("  FOMC ", "Tag")).toEqual({ name: "FOMC" });
    expect(parseName("", "Group").error).toBe("Group name is required.");
    expect(parseName("x".repeat(41), "Tag").error).toMatch(/40 characters/);
  });

  test("tag ids are distinct positive integers", () => {
    expect(parseTagIds([3, "3", 5])).toEqual({ ids: [3, 5] });
    expect(parseTagIds("3").error).toBeDefined();
    expect(parseTagIds([0]).error).toBeDefined();
  });
});
