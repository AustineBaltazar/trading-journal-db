const calculateNetPnl = require("./pnl");

const RESULTS = ["win", "loss", "be"];

// win / loss / be for a trade. A result the trader picked always wins.
// Otherwise exit == entry is break-even (fees alone don't make it a loss),
// and anything else follows the sign of net P/L.
function tradeOutcome(trade, netPnl = calculateNetPnl(trade)) {
  if (RESULTS.includes(trade.result)) return trade.result;
  if (parseFloat(trade.entry_price) === parseFloat(trade.exit_price)) return "be";
  if (netPnl > 0) return "win";
  if (netPnl < 0) return "loss";
  return "be";
}

// The trade with its net P/L and outcome, as every endpoint returns it
function withPnl(trade) {
  const netPnl = calculateNetPnl(trade);
  return { ...trade, netPnl, outcome: tradeOutcome(trade, netPnl) };
}

// Totals for the summary card. Win rate leaves break-evens out: wins / (wins + losses).
function summarize(trades) {
  const counts = { win: 0, loss: 0, be: 0 };
  let totalPnl = 0;
  for (const trade of trades) {
    counts[trade.outcome] += 1;
    totalPnl += trade.netPnl;
  }
  const decided = counts.win + counts.loss;
  return {
    totalTrades: trades.length,
    totalPnl: Math.round(totalPnl * 100) / 100,
    wins: counts.win,
    losses: counts.loss,
    breakEvens: counts.be,
    winRate: decided > 0 ? Math.round((counts.win / decided) * 100) : 0,
  };
}

module.exports = { RESULTS, tradeOutcome, withPnl, summarize };
