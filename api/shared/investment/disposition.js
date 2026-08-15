// Hypothetical sale at the end of each report year. The critical recovered
// conventions live here and nowhere else:
//   - a Year-t sale is priced on Year t+1 NOI;
//   - the gross sale price is rounded to the nearest $1,000 and that rounded
//     number feeds selling costs and net proceeds (it is arithmetic, not
//     display formatting).
const { roundToNearestThousand } = require('./finance');

function buildSales(operatingYears, norm, endingBalances, reportYears) {
  const capRate = norm.disposition.exitCapRate.value;
  const sellPct = norm.disposition.sellingCostPercent;
  const sales = [];
  for (let t = 1; t <= reportYears; t++) {
    const nextNOI = operatingYears[t].NOI;          // index t = year t+1 (0-based array)
    const grossSalePrice = roundToNearestThousand(nextNOI / capRate);
    const sellingCosts = grossSalePrice * sellPct;
    const loanPayoff = endingBalances ? endingBalances[t - 1] : 0;
    const netSaleProceeds = grossSalePrice - sellingCosts - loanPayoff;
    sales.push({ year: t, grossSalePrice, sellingCosts, loanPayoff, netSaleProceeds });
  }
  return sales;
}

module.exports = { buildSales };
