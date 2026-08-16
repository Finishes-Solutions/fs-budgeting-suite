// Input validation for release 1. Hard errors are field-keyed so the UI can
// highlight them; unsupported Analyst Pro branches are rejected explicitly
// rather than approximated — a wrong number is worse than a refused one.
const C = require('./constants');
const { isValidMonth } = require('./dates');

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const inRange01 = v => isNum(v) && v >= 0 && v <= 1;

function validate(input) {
  const errors = {};
  const err = (k, m) => { if (!errors[k]) errors[k] = m; };

  if (!input || typeof input !== 'object') return { ok: false, errors: { input: 'Body must be an analysis input object.' } };

  if (input.schemaVersion !== C.SCHEMA_VERSION)
    err('schemaVersion', 'Unsupported input schema version — expected ' + C.SCHEMA_VERSION + '.');

  if (typeof input.analysisName !== 'string' || !input.analysisName.trim())
    err('analysisName', 'Analysis Name is required.');
  else if (input.analysisName.length > C.MAX_TEXT) err('analysisName', 'Analysis Name is too long.');

  // ---- projection: five or ten years, before tax
  const proj = input.projection || {};
  if (!C.ALLOWED_YEARS.includes(proj.years))
    err('projection.years', 'Projection must be ' + C.ALLOWED_YEARS.join(' or ') + ' years.');
  if (proj.taxMode !== C.SUPPORTED_TAX_MODE)
    err('projection.taxMode', 'Only before-tax analysis is supported in this release.');
  const horizon = C.ALLOWED_YEARS.includes(proj.years) ? proj.years : C.ALLOWED_YEARS[0];

  // ---- property
  const prop = input.property || {};
  if (typeof prop.name !== 'string' || !prop.name.trim()) err('property.name', 'Property Name is required.');
  const size = prop.size || {};
  if (!['squareFeet', 'acres', 'units'].includes(size.unit))
    err('property.size.unit', 'Property size unit must be Square Feet, Acres, or Units.');
  if (!isNum(size.value) || size.value <= 0) err('property.size.value', 'Property size must be greater than zero.');
  if (!isValidMonth(prop.purchaseMonth)) err('property.purchaseMonth', 'Purchase Month is required (YYYY-MM).');

  // ---- acquisition
  const acq = input.acquisition || {};
  const basis = acq.basis || {};
  if (!['purchasePrice', 'acquisitionCapRate'].includes(basis.mode))
    err('acquisition.basis.mode', 'Choose Purchase Price or Acquisition Cap Rate.');
  else if (!isNum(basis.value) || basis.value <= 0)
    err('acquisition.basis.value', basis.mode === 'acquisitionCapRate'
      ? 'Acquisition Cap Rate must be greater than zero.' : 'Purchase Price must be greater than zero.');
  if (acq.costPercent !== undefined && !inRange01(acq.costPercent))
    err('acquisition.costPercent', 'Acquisition Costs must be between 0% and 100%.');

  // ---- income
  const inc = input.income || {};
  if (inc.mode !== 'aggregate')
    err('income.mode', 'Only aggregate Year-1 potential income is supported in this release.');
  if (!isNum(inc.year1PotentialIncome) || inc.year1PotentialIncome < 0)
    err('income.year1PotentialIncome', 'Year-1 Potential Rental Income must be zero or more.');
  const g = inc.growth || {};
  if (g.mode !== 'constant' || !isNum(g.value) || g.value < -1)
    err('income.growth', 'Income growth must be a constant annual rate.');
  const other = inc.otherIncome === undefined ? [] : inc.otherIncome;
  if (!Array.isArray(other) || other.length > C.MAX_OTHER_INCOME_ROWS)
    err('income.otherIncome', 'Too many other-income rows.');
  else other.forEach((row, i) => {
    if (!row || typeof row.label !== 'string' || row.label.length > C.MAX_TEXT)
      err('income.otherIncome.' + i, 'Other-income rows need a label.');
    else if (!isNum(row.year1Amount) || row.year1Amount < 0)
      err('income.otherIncome.' + i, 'Other-income amounts must be zero or more.');
  });

  // ---- vacancy & expenses
  const vac = input.vacancy || {};
  if (vac.mode !== 'constant' || !inRange01(vac.value))
    err('vacancy.value', 'Vacancy / Credit Loss must be between 0% and 100%.');
  const exp = input.expenses || {};
  if (exp.mode === 'percentOfGOI') {
    if (!inRange01(exp.value)) err('expenses.value', 'Operating Expenses must be between 0% and 100% of GOI.');
  } else if (exp.mode === 'annualDollar') {
    if (!isNum(exp.value) || exp.value < 0) err('expenses.value', 'Year-1 Operating Expenses must be zero or more.');
    const eg = exp.growth || {};
    if (eg.mode !== 'constant' || !isNum(eg.value) || eg.value < -1)
      err('expenses.growth', 'Expense growth must be a constant annual rate.');
  } else err('expenses.mode', 'Expenses must be a percent of GOI or an annual dollar amount.');

  // ---- capital expenses
  const capex = input.capitalExpenses === undefined ? [] : input.capitalExpenses;
  if (!Array.isArray(capex) || capex.length > C.MAX_CAPEX_ROWS) err('capitalExpenses', 'Too many capital-expense rows.');
  else capex.forEach((row, i) => {
    if (!row || typeof row.label !== 'string') err('capitalExpenses.' + i, 'Capital-expense rows need a label.');
    else if (!Array.isArray(row.annualAmounts) || row.annualAmounts.length > horizon
             || !row.annualAmounts.every(v => isNum(v) && v >= 0))
      err('capitalExpenses.' + i, 'Capital-expense amounts must be zero or more, one per year.');
  });

  // ---- financing: all-cash (no loans) or exactly one new fully amortizing loan
  const fin = input.financing || {};
  const loans = fin.loans === undefined ? [] : fin.loans;
  if (!Array.isArray(loans)) err('financing.loans', 'Financing must be a list of loans.');
  else if (loans.length > 1) err('financing.loans', 'Only one first mortgage is supported in this release.');
  else if (loans.length === 1) {
    const L = loans[0] || {};
    if (L.kind !== 'newAmortizing')
      err('financing.loans.0.kind', 'Only a new fully amortizing loan is supported — no interest-only, assumed, second, or refinance loans.');
    const amt = L.amount || {};
    if (amt.mode === 'amount') {
      if (!isNum(amt.value) || amt.value < 0) err('financing.loans.0.amount', 'Loan Amount must be zero or more.');
    } else if (amt.mode === 'ltv') {
      if (!inRange01(amt.value)) err('financing.loans.0.amount', 'LTV must be between 0% and 100%.');
    } else err('financing.loans.0.amount', 'Loan amount must be dollars or an LTV percentage.');
    if (!isNum(L.annualRate) || L.annualRate < 0) err('financing.loans.0.annualRate', 'Loan Rate must be zero or more.');
    if (!isNum(L.amortizationYears) || L.amortizationYears <= 0)
      err('financing.loans.0.amortizationYears', 'Amortization must be greater than zero.');
    if (!isNum(L.termYears) || L.termYears <= 0) err('financing.loans.0.termYears', 'Loan Term must be greater than zero.');
    else if (L.termYears < horizon)
      err('financing.loans.0.termYears', 'Loan Term must cover the ' + horizon + '-year projection — maturity and refinance modeling are not supported in this release.');
    if (L.feePercent !== undefined && !inRange01(L.feePercent))
      err('financing.loans.0.feePercent', 'Loan Fees must be between 0% and 100%.');
    if (L.interestCalculation !== undefined && L.interestCalculation !== C.SUPPORTED_INTEREST_CALC)
      err('financing.loans.0.interestCalculation', 'Only 30/360 interest calculation is supported.');
    if (L.interestOnly) err('financing.loans.0.kind', 'Interest-only loans are not supported in this release.');
    if (L.refinance) err('financing.loans.0.kind', 'Refinance schedules are not supported in this release.');
  }

  // ---- disposition
  const disp = input.disposition || {};
  const cap = disp.exitCapRate || {};
  if (cap.mode !== 'constant' || !isNum(cap.value) || cap.value <= 0)
    err('disposition.exitCapRate.value', 'Exit Cap Rate must be greater than zero.');
  if (disp.sellingCostPercent !== undefined && !inRange01(disp.sellingCostPercent))
    err('disposition.sellingCostPercent', 'Selling Costs must be between 0% and 100%.');

  return { ok: Object.keys(errors).length === 0, errors };
}

module.exports = { validate };
