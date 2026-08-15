// Versioning is two independent axes: what shape the input takes, and which
// formulas produced the result. A saved analysis records both, and an old
// version is never silently recalculated with a newer engine.
module.exports = {
  SCHEMA_VERSION: 1,
  // 1.1.0: projections generalized to five OR ten years (Year-N sale still
  // uses Year-N+1 NOI; one extra operating year is always computed).
  CALCULATION_VERSION: 'before-tax-1.1.0',
  SQFT_PER_ACRE: 43560,
  // Sensitivity scenarios: percent of base acquisition price, base LTV preserved.
  SENSITIVITY_FACTORS: [0.90, 0.95, 1.00, 1.05, 1.10],
  // The validator rejects any horizon not in this list.
  ALLOWED_YEARS: [5, 10],
  SUPPORTED_TAX_MODE: 'beforeTax',
  SUPPORTED_INTEREST_CALC: '30/360',
  MAX_OTHER_INCOME_ROWS: 20,
  MAX_CAPEX_ROWS: 20,
  MAX_TEXT: 500
};
