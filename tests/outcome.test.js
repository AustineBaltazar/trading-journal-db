const { tradeOutcome, withPnl, summarize } = require("../utils/outcome");

const trade = (overrides) => ({
  symbol: "MNQ",
  direction: "long",
  contracts: 2,
  entry_price: "21000.00",
  exit_price: "21010.00",
  fees: "2.50",
  result: null,
  ...overrides,
});

describe("tradeOutcome", () => {
  test("follows net P/L", () => {
    expect(tradeOutcome(trade())).toBe("win");
    expect(tradeOutcome(trade({ exit_price: "20990.00" }))).toBe("loss");
    expect(tradeOutcome(trade({ direction: "short", exit_price: "20990.00" }))).toBe("win");
  });

  test("exit at entry is break-even even though fees make it slightly negative", () => {
    expect(tradeOutcome(trade({ exit_price: "21000" }))).toBe("be");
  });

  test("a picked result overrides the prices", () => {
    expect(tradeOutcome(trade({ result: "be" }))).toBe("be");
    expect(tradeOutcome(trade({ exit_price: "21000.25", result: "be" }))).toBe("be");
    expect(tradeOutcome(trade({ exit_price: "20990", result: "win" }))).toBe("win");
  });

  test("zero net P/L is break-even", () => {
    expect(tradeOutcome(trade({ exit_price: "21000.50", fees: "2.00" }))).toBe("be");
  });
});

test("withPnl adds net P/L and outcome", () => {
  expect(withPnl(trade())).toMatchObject({ netPnl: 37.5, outcome: "win" });
});

test("summarize leaves break-evens out of the win rate", () => {
  const trades = [
    trade(),
    trade(),
    trade({ exit_price: "20990" }),
    trade({ exit_price: "21000" }),
  ].map(withPnl);
  expect(summarize(trades)).toEqual({
    totalTrades: 4,
    totalPnl: 37.5 + 37.5 - 42.5 - 2.5,
    wins: 2,
    losses: 1,
    breakEvens: 1,
    winRate: 67,
  });
  expect(summarize([]).winRate).toBe(0);
});
