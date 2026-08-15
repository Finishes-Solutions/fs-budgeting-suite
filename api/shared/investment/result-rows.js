// Flatten a canonical result's annual array into the column shape of
// dbo.InvestmentAnnualResults / dbo.InvestmentVersionAnnualResults. One place
// defines the mapping so the current rows, the version rows, and the SQL
// verification script can never disagree about what a column means.
const COLUMNS = [
  'periodEnd', 'potentialIncome', 'vacancyLoss', 'effectiveRentalIncome', 'otherIncome',
  'grossOperatingIncome', 'operatingExpenses', 'netOperatingIncome', 'capitalExpenses',
  'debtService', 'cashFlowBeforeTaxes', 'endingLoanBalance', 'grossSalePrice',
  'sellingCosts', 'netSaleProceeds', 'projectedLTV', 'dscr', 'debtYield', 'cashOnCash',
  'returnOnEquity', 'equityMultiple', 'propertyIRR', 'effectiveLoanRate', 'equityIRR',
  'leverageImpact'
];

function annualRows(result) {
  return result.annual.map(a => {
    const row = { analysisYear: a.year };
    for (const c of COLUMNS) row[c] = a[c] === undefined ? null : a[c];
    return row;
  });
}

module.exports = { annualRows, COLUMNS };
