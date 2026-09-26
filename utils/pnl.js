const POINT_VALUES = {
  MNQ: 2,
  NQ: 20,
};

function calculateNetPnl(trade) {
  const pointValue = POINT_VALUES[trade.symbol] || 0;
  const entry = parseFloat(trade.entry_price);
  const exit = parseFloat(trade.exit_price);
  const fees = parseFloat(trade.fees);

  const priceDifference =
    trade.direction === "long" ? exit - entry : entry - exit;

  const grossPnl = priceDifference * pointValue * trade.contracts;
  const netPnl = grossPnl - fees;

  return Math.round(netPnl * 100) / 100;
}

module.exports = calculateNetPnl;
