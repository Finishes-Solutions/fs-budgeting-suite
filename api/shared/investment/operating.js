// Operating projection. Always builds one year beyond the report horizon:
// a sale at the end of Year N is priced on Year N+1 NOI, so a five-year
// report requires six computed operating years. Capital expenses sit below
// NOI (they reduce cash flow, never reported NOI) and exist only for report
// years — the terminal year needs nothing but its NOI.
function buildOperatingYears(norm, totalYears) {
  const g = norm.income.growth.value;
  const years = [];
  for (let t = 1; t <= totalYears; t++) {
    const potentialIncome = norm.income.year1PotentialIncome * Math.pow(1 + g, t - 1);
    const vacancyLoss = potentialIncome * norm.vacancy.value;
    const effectiveRentalIncome = potentialIncome - vacancyLoss;
    const otherIncome = norm.income.otherIncome.reduce(
      (s, r) => s + r.year1Amount * Math.pow(1 + r.growth.value, t - 1), 0);
    const GOI = effectiveRentalIncome + otherIncome;
    const operatingExpenses = norm.expenses.mode === 'percentOfGOI'
      ? GOI * norm.expenses.value
      : norm.expenses.value * Math.pow(1 + norm.expenses.growth.value, t - 1);
    const NOI = GOI - operatingExpenses;
    const capitalExpenses = t <= norm.projection.years
      ? norm.capitalExpenses.reduce((s, r) => s + r.annualAmounts[t - 1], 0)
      : 0;
    years.push({ year: t, potentialIncome, vacancyLoss, effectiveRentalIncome,
                 otherIncome, GOI, operatingExpenses, NOI, capitalExpenses });
  }
  return years;
}

module.exports = { buildOperatingYears };
