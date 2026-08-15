// Normalization: apply organization defaults to omitted optional fields and
// produce the canonical numeric shape the engine calculates from. Runs only
// after validation has passed. Rates stay decimal fractions throughout.
const C = require('./constants');
const D = require('./defaults');

function normalizePropertySize(size) {
  if (size.unit === 'acres') return { ...size, normalizedSquareFeet: size.value * C.SQFT_PER_ACRE };
  if (size.unit === 'squareFeet') return { ...size, normalizedSquareFeet: size.value };
  // Units are a count, not an area — price/SF would be a lie. Callers show
  // price per unit instead; normalizedSquareFeet stays null on purpose.
  return { ...size, normalizedSquareFeet: null };
}

function normalize(input) {
  const prop = input.property;
  const loans = (input.financing && input.financing.loans || []).map(L => ({
    label: typeof L.label === 'string' && L.label.trim() ? L.label.trim() : 'First Mortgage',
    kind: 'newAmortizing',
    amount: { mode: L.amount.mode, value: L.amount.value },
    annualRate: L.annualRate,
    amortizationYears: L.amortizationYears,
    termYears: L.termYears,
    feePercent: L.feePercent === undefined ? D.loanFeePercent : L.feePercent,
    interestCalculation: C.SUPPORTED_INTEREST_CALC
  }));

  return {
    schemaVersion: C.SCHEMA_VERSION,
    analysisName: input.analysisName.trim(),
    source: input.source && typeof input.source === 'object' ? input.source : null,
    property: {
      name: prop.name.trim(),
      address: typeof prop.address === 'string' ? prop.address.slice(0, C.MAX_TEXT) : '',
      city: typeof prop.city === 'string' ? prop.city.slice(0, C.MAX_TEXT) : '',
      state: typeof prop.state === 'string' ? prop.state.slice(0, 40) : '',
      postalCode: typeof prop.postalCode === 'string' ? prop.postalCode.slice(0, 20) : '',
      size: normalizePropertySize(prop.size),
      unitCount: Number.isFinite(+prop.unitCount) && +prop.unitCount > 0 ? +prop.unitCount : null,
      purchaseMonth: prop.purchaseMonth
    },
    projection: { years: C.SUPPORTED_YEARS, taxMode: C.SUPPORTED_TAX_MODE },
    acquisition: {
      basis: { mode: input.acquisition.basis.mode, value: input.acquisition.basis.value },
      costPercent: input.acquisition.costPercent === undefined ? D.acquisitionCostPercent : input.acquisition.costPercent
    },
    income: {
      mode: 'aggregate',
      year1PotentialIncome: input.income.year1PotentialIncome,
      growth: { mode: 'constant', value: input.income.growth.value },
      otherIncome: (input.income.otherIncome || []).map(r => ({
        label: r.label.slice(0, C.MAX_TEXT),
        year1Amount: r.year1Amount,
        growth: { mode: 'constant',
          value: r.growth && Number.isFinite(+r.growth.value) ? +r.growth.value : D.otherIncomeGrowth }
      }))
    },
    vacancy: { mode: 'constant', value: input.vacancy.value },
    expenses: input.expenses.mode === 'percentOfGOI'
      ? { mode: 'percentOfGOI', value: input.expenses.value }
      : { mode: 'annualDollar', value: input.expenses.value,
          growth: { mode: 'constant', value: input.expenses.growth.value } },
    capitalExpenses: (input.capitalExpenses || []).map(r => ({
      label: r.label.slice(0, C.MAX_TEXT),
      // Pad to the full horizon so year indexing is total, not partial.
      annualAmounts: Array.from({ length: C.SUPPORTED_YEARS }, (_, i) =>
        Number.isFinite(+r.annualAmounts[i]) ? +r.annualAmounts[i] : 0)
    })),
    financing: { loans },
    disposition: {
      exitCapRate: { mode: 'constant', value: input.disposition.exitCapRate.value },
      sellingCostPercent: input.disposition.sellingCostPercent === undefined
        ? D.sellingCostPercent : input.disposition.sellingCostPercent
    },
    reportOptions: {
      includeSensitivity: !!(input.reportOptions && input.reportOptions.includeSensitivity)
    }
  };
}

module.exports = { normalize, normalizePropertySize };
