// Versioning is two independent axes: what shape the input takes, and which
// formulas produced the result. A saved analysis records both, and an old
// version is never silently recalculated with a newer engine.
module.exports = {
  SCHEMA_VERSION: 1,
  CALCULATION_VERSION: 'before-tax-5y-1.0.0',
  SQFT_PER_ACRE: 43560,
  // Sensitivity scenarios: percent of base acquisition price, base LTV preserved.
  SENSITIVITY_FACTORS: [0.90, 0.95, 1.00, 1.05, 1.10],
  // Release 1 supports exactly this shape; the validator rejects everything else.
  SUPPORTED_YEARS: 5,
  SUPPORTED_TAX_MODE: 'beforeTax',
  SUPPORTED_INTEREST_CALC: '30/360',
  MAX_OTHER_INCOME_ROWS: 20,
  MAX_CAPEX_ROWS: 20,
  MAX_TEXT: 500
};
