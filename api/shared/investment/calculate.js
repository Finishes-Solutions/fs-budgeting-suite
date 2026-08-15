// The engine's public boundary. Pure: raw input in, canonical result out.
// The server calls this on every preview and every save; the browser only
// renders what comes back. Throws { validation: errors } for invalid input.
const C = require('./constants');
const { validate } = require('./validation');
const { normalize } = require('./normalize');
const { periodEndFromPurchaseMonth } = require('./dates');
const { buildOperatingYears } = require('./operating');
const { resolveLoanAmount, loanSchedule } = require('./debt');
const { buildSales } = require('./disposition');
const { buildReturns } = require('./returns');
const { buildSensitivity } = require('./sensitivity');

// JSON must never carry NaN or Infinity: any non-finite number becomes null.
function sanitize(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitize(value[k]);
    return out;
  }
  return value;
}

function calculateInvestmentAnalysis(rawInput) {
  const v = validate(rawInput);
  if (!v.ok) { const e = new Error('validation_failed'); e.validation = v.errors; throw e; }
  const norm = normalize(rawInput);
  const warnings = [];
  const years = norm.projection.years;

  // One extra operating year: the Year-N sale needs Year-N+1 NOI.
  const operatingYears = buildOperatingYears(norm, years + 1);
  const year1NOI = operatingYears[0].NOI;

  // Acquisition basis resolves only after Year-1 NOI is known.
  let purchasePrice, acquisitionCapRate;
  if (norm.acquisition.basis.mode === 'purchasePrice') {
    purchasePrice = norm.acquisition.basis.value;
    acquisitionCapRate = year1NOI / purchasePrice;
  } else {
    acquisitionCapRate = norm.acquisition.basis.value;
    purchasePrice = year1NOI / acquisitionCapRate;
  }

  const acquisitionCosts = purchasePrice * norm.acquisition.costPercent;
  const loanInput = norm.financing.loans[0] || null;
  let loan = null;
  if (loanInput) {
    const principal = resolveLoanAmount(loanInput, purchasePrice);
    if (principal > 0) loan = loanSchedule(loanInput, principal, years);
  }
  const unleveragedInitialInvestment = purchasePrice + acquisitionCosts;
  const initialEquity = purchasePrice + acquisitionCosts + (loan ? loan.fees : 0)
    - (loan ? loan.principal : 0);

  const sales = buildSales(operatingYears, norm, loan ? loan.endingBalance : null, years);
  const acquisition = { purchasePrice, acquisitionCosts, initialEquity, unleveragedInitialInvestment };
  const returns = buildReturns({ operatingYears, sales, loan, acquisition, reportYears: years, warnings });

  // ---- non-blocking warnings the report keeps forever
  if (loan && loan.principal > purchasePrice) warnings.push('The loan exceeds the purchase price.');
  if (initialEquity <= 0) warnings.push('Initial equity is zero or negative — the returns divide by it and are not meaningful.');
  returns.rows.forEach(r => {
    if (r.cashFlowBeforeTaxes < 0) warnings.push(`Year ${r.year} cash flow before taxes is negative.`);
  });
  if (loan && returns.rows.some(r => r.dscr !== null && r.dscr < 1))
    warnings.push('DSCR falls below 1.00 in at least one year.');
  if (returns.rows.some(r => r.leverageImpact !== null && r.leverageImpact < 0))
    warnings.push('Leverage is negative in at least one year — borrowing lowers the equity return.');
  if (norm.disposition.exitCapRate.value < acquisitionCapRate * 0.75)
    warnings.push('The exit cap rate is materially below the acquisition cap rate — the sale assumes significant appreciation.');
  if (norm.expenses.mode === 'percentOfGOI' && (norm.expenses.value < 0.05 || norm.expenses.value > 0.75))
    warnings.push('The operating-expense ratio is unusually ' + (norm.expenses.value < 0.05 ? 'low' : 'high') + '.');

  const sensitivity = norm.reportOptions.includeSensitivity
    ? buildSensitivity({
        norm, operatingYears, sales,
        baseLoanInput: loanInput, basePrincipal: loan ? loan.principal : null,
        basePurchasePrice: purchasePrice, reportYears: years
      })
    : null;

  const sizeSF = norm.property.size.normalizedSquareFeet;
  const annual = [];
  for (let t = 1; t <= years; t++) {
    const op = operatingYears[t - 1], sale = sales[t - 1], ret = returns.rows[t - 1];
    annual.push({
      year: t,
      periodEnd: periodEndFromPurchaseMonth(norm.property.purchaseMonth, t),
      potentialIncome: op.potentialIncome,
      vacancyLoss: op.vacancyLoss,
      effectiveRentalIncome: op.effectiveRentalIncome,
      otherIncome: op.otherIncome,
      grossOperatingIncome: op.GOI,
      operatingExpenses: op.operatingExpenses,
      netOperatingIncome: op.NOI,
      capitalExpenses: op.capitalExpenses,
      debtService: loan ? loan.annualDebtService : 0,
      cashFlowBeforeTaxes: ret.cashFlowBeforeTaxes,
      endingLoanBalance: loan ? loan.endingBalance[t - 1] : 0,
      grossSalePrice: sale.grossSalePrice,
      sellingCosts: sale.sellingCosts,
      netSaleProceeds: sale.netSaleProceeds,
      projectedLTV: ret.projectedLTV,
      dscr: ret.dscr,
      debtYield: ret.debtYield,
      cashOnCash: ret.cashOnCash,
      unleveragedCashOnCash: ret.unleveragedCashOnCash,
      returnOnEquity: ret.returnOnEquity,
      equityMultiple: ret.equityMultiple,
      propertyIRR: ret.propertyIRR,
      effectiveLoanRate: ret.effectiveLoanRate,
      equityIRR: ret.equityIRR,
      leverageImpact: ret.leverageImpact
    });
  }

  return sanitize({
    inputSchemaVersion: C.SCHEMA_VERSION,
    calculationVersion: C.CALCULATION_VERSION,
    normalizedInput: norm,
    summary: {
      purchasePrice,
      acquisitionCapRate,
      acquisitionCosts,
      loanFees: loan ? loan.fees : 0,
      unleveragedInitialInvestment,
      initialEquity,
      year1NOI,
      year1PotentialIncome: operatingYears[0].potentialIncome,
      grossRentMultiplier: operatingYears[0].potentialIncome > 0
        ? purchasePrice / operatingYears[0].potentialIncome : null,
      pricePerSquareFoot: sizeSF ? purchasePrice / sizeSF : null,
      pricePerUnit: norm.property.unitCount ? purchasePrice / norm.property.unitCount : null,
      normalizedSquareFeet: sizeSF,
      initialLTV: loan ? loan.principal / purchasePrice : null,
      // The terminal year's NOI is calculation audit data: the Year-5 sale is
      // priced on it, but it is not a report row.
      terminalYearNOI: operatingYears[years].NOI,
      optimalHoldingYear: returns.optimalHoldingYear,
      optimalHoldingYield: returns.optimalHoldingYield,
      finalYearEquityIRR: returns.rows[years - 1].equityIRR,
      finalYearEquityMultiple: returns.rows[years - 1].equityMultiple
    },
    loans: loan ? [{
      label: loanInput.label,
      principal: loan.principal,
      annualRate: loanInput.annualRate,
      amortizationYears: loanInput.amortizationYears,
      termYears: loanInput.termYears,
      feePercent: loanInput.feePercent,
      fees: loan.fees,
      monthlyPayment: loan.monthlyPayment,
      annualDebtService: loan.annualDebtService,
      interestCalculation: loanInput.interestCalculation
    }] : [],
    annual,
    sensitivity,
    warnings
  });
}

module.exports = { calculateInvestmentAnalysis };
