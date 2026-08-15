// Organization defaults recovered from the reference exports. They live here —
// visible and editable in the UI — never buried inside formulas. All rates are
// decimal fractions (6.5% is 0.065).
module.exports = {
  acquisitionCostPercent: 0.02,
  sellingCostPercent: 0.05,
  loanFeePercent: 0.01,
  incomeGrowth: 0.03,
  otherIncomeGrowth: 0.03,
  dollarExpenseGrowth: 0.03,
  vacancy: 0.10,
  ltv: 0.65,
  amortizationYears: 25,
  termYears: 5,
  interestCalculation: '30/360'
};
