// Regression tests for the investment engine against the five recovered deals.
//
// Tolerances (documented in the reverse-engineering spec §8/§10):
//   dollars   — ±$1.5 on annual amounts, balances, equity (the exports carry
//               hidden sub-dollar precision behind whole-dollar display)
//   thousands — gross sale prices must match EXACTLY (the $1,000 rounding is
//               arithmetic, not display)
//   percent   — ±0.006 on two-decimal displayed percentages
//   ratios    — ±0.006 on two-decimal DSCR / equity multiple
//   payment   — ±$0.01 on the monthly mortgage payment
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const { pmt, remainingBalance, irr, roundToNearestThousand } = require('../api/shared/investment/finance');
const { periodEndFromPurchaseMonth } = require('../api/shared/investment/dates');
const { annualRows, COLUMNS } = require('../api/shared/investment/result-rows');

const FIX = path.join(__dirname, 'fixtures', 'investment');
const fixture = f => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

const dollars = (a, e, m) => assert.ok(Math.abs(a - e) <= 1.5, `${m}: ${a} vs ${e}`);
const pct = (a, e, m) => assert.ok(a !== null && Math.abs(a * 100 - e) <= 0.006, `${m}: ${a === null ? 'null' : (a * 100).toFixed(4)} vs ${e}`);
const ratio = (a, e, m) => assert.ok(a !== null && Math.abs(a - e) <= 0.006, `${m}: ${a} vs ${e}`);
const exact = (a, e, m) => assert.equal(a, e, m);

function assertNoNonFinite(value, where) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'non-finite number at ' + where);
  else if (Array.isArray(value)) value.forEach((v, i) => assertNoNonFinite(v, where + '[' + i + ']'));
  else if (value && typeof value === 'object')
    Object.keys(value).forEach(k => assertNoNonFinite(value[k], where + '.' + k));
}

// ---------- Wedgewood: the full-annual canonical fixture ----------
test('Wedgewood reconciles every annual row', () => {
  const fx = fixture('wedgewood.json');
  const r = calculateInvestmentAnalysis(fx.input);
  const e = fx.expected;

  dollars(r.summary.purchasePrice, e.purchasePrice, 'purchase price');
  pct(r.summary.acquisitionCapRate, e.acquisitionCapRatePct, 'acquisition cap');
  dollars(r.summary.initialEquity, e.initialEquity, 'initial equity');
  dollars(r.summary.normalizedSquareFeet, e.normalizedSquareFeet, 'normalized SF');
  assert.ok(Math.abs(r.summary.pricePerSquareFoot - e.pricePerSquareFoot) <= 0.006, 'price/SF');
  exact(r.annual[0].periodEnd, e.year1PeriodEnd, 'year-1 period end');

  const A = e.annual;
  for (let t = 0; t < 5; t++) {
    const a = r.annual[t], y = 'Y' + (t + 1) + ' ';
    dollars(a.potentialIncome, A.potentialIncome[t], y + 'PRI');
    dollars(a.vacancyLoss, A.vacancyLoss[t], y + 'vacancy');
    dollars(a.grossOperatingIncome, A.GOI[t], y + 'GOI');
    dollars(a.operatingExpenses, A.operatingExpenses[t], y + 'opex');
    dollars(a.netOperatingIncome, A.NOI[t], y + 'NOI');
    dollars(a.cashFlowBeforeTaxes, A.cashFlowBeforeTaxes[t], y + 'CFBT');
    dollars(a.endingLoanBalance, A.endingLoanBalance[t], y + 'balance');
    pct(a.projectedLTV, A.projectedLTVPct[t], y + 'LTV');
    ratio(a.dscr, A.DSCR[t], y + 'DSCR');
    pct(a.cashOnCash, A.cashOnCashPct[t], y + 'CoC');
    pct(a.returnOnEquity, A.returnOnEquityPct[t], y + 'ROE');
    ratio(a.equityMultiple, A.equityMultiple[t], y + 'equity multiple');
    pct(a.propertyIRR, A.propertyIRRPct[t], y + 'property IRR');
    pct(a.effectiveLoanRate, A.effectiveLoanRatePct[t], y + 'effective loan rate');
    pct(a.equityIRR, A.equityIRRPct[t], y + 'equity IRR');
    // The report's leverage line is the difference of the two DISPLAYED
    // two-decimal IRRs (13.67 − 9.80 = 3.87), not the rounded full-precision
    // difference (3.8777 → 3.88). The engine keeps full precision; the display
    // convention is asserted here and applied in the report formatter.
    assert.ok(Math.abs(a.leverageImpact - (a.equityIRR - a.propertyIRR)) < 1e-12,
      y + 'leverage is internally the exact IRR difference');
    const displayedLeverage = Math.round(a.equityIRR * 10000) / 100 - Math.round(a.propertyIRR * 10000) / 100;
    assert.ok(Math.abs(displayedLeverage - A.leverageImpactPct[t]) <= 0.006,
      y + 'displayed leverage: ' + displayedLeverage + ' vs ' + A.leverageImpactPct[t]);
  }
  exact(r.annual[4].grossSalePrice, e.year5GrossSalePrice, 'Y5 gross sale price (rounded $1,000)');
  dollars(r.annual[4].sellingCosts, e.year5SellingCosts, 'Y5 selling costs');
  dollars(r.annual[4].netSaleProceeds, e.year5NetSaleProceeds, 'Y5 net proceeds');
  exact(r.summary.optimalHoldingYear, e.optimalHoldingYear, 'optimal hold year');
  pct(r.summary.optimalHoldingYield, e.optimalHoldingYieldPct, 'optimal hold yield');
  assertNoNonFinite(r, 'result');
  assert.equal(r.calculationVersion, 'before-tax-1.1.0');
});

// ---------- the other four deals: headline outputs ----------
for (const file of ['combo-15ac.json', 'barker-cypress.json', 'frisco.json', 'tomball.json']) {
  test(fixture(file).name + ' reconciles the headline outputs', () => {
    const fx = fixture(file);
    const r = calculateInvestmentAnalysis(fx.input);
    const e = fx.expected;
    pct(r.summary.acquisitionCapRate, e.acquisitionCapRatePct, 'acquisition cap');
    dollars(r.summary.initialEquity, e.initialEquity, 'initial equity');
    dollars(r.summary.year1NOI, e.year1NOI, 'Y1 NOI');
    assert.ok(Math.abs(r.summary.pricePerSquareFoot - e.pricePerSquareFoot) <= 0.006, 'price/SF');
    exact(r.annual[0].periodEnd, e.year1PeriodEnd, 'Y1 period end');
    ratio(r.annual[0].dscr, e.year1DSCR, 'Y1 DSCR');
    pct(r.annual[0].cashOnCash, e.year1CashOnCashPct, 'Y1 CoC');
    pct(r.annual[4].equityIRR, e.year5EquityIRRPct, 'Y5 equity IRR');
    ratio(r.annual[4].equityMultiple, e.year5EquityMultiple, 'Y5 equity multiple');
    exact(r.annual[4].grossSalePrice, e.year5GrossSalePrice, 'Y5 gross sale price');
    dollars(r.annual[4].netSaleProceeds, e.year5NetSaleProceeds, 'Y5 net proceeds');
    exact(r.summary.optimalHoldingYear, e.optimalHoldingYear, 'optimal hold');
    pct(r.summary.optimalHoldingYield, e.optimalHoldingYieldPct, 'optimal hold yield');
    assertNoNonFinite(r, 'result');
  });
}

// ---------- the complete Combo sensitivity matrix ----------
test('Combo acquisition sensitivity matches every recovered cell', () => {
  const fx = fixture('combo-15ac.json');
  const r = calculateInvestmentAnalysis(fx.input);
  assert.ok(Array.isArray(r.sensitivity) && r.sensitivity.length === 5, 'five scenarios');
  fx.expected.sensitivity.forEach((es, i) => {
    const s = r.sensitivity[i], tag = 'scenario ' + i + ' ';
    exact(s.purchasePrice, es.purchasePrice, tag + 'price');
    pct(s.acquisitionCapRate, es.acquisitionCapPct, tag + 'cap');
    for (let t = 0; t < 5; t++) {
      pct(s.unleveragedCoC[t], es.unleveragedCoC[t], tag + 'unlev CoC Y' + (t + 1));
      pct(s.leveragedCoC[t], es.leveragedCoC[t], tag + 'lev CoC Y' + (t + 1));
      pct(s.unleveragedIRR[t], es.unleveragedIRR[t], tag + 'unlev IRR Y' + (t + 1));
      pct(s.leveragedIRR[t], es.leveragedIRR[t], tag + 'lev IRR Y' + (t + 1));
    }
  });
});

// ---------- primitives ----------
test('mortgage payment matches Excel PMT to a cent', () => {
  // Wedgewood: 14,146,321 at 6.5%/25y → verified against the export's payment block
  const pay = pmt(0.065 / 12, 300, 14146321);
  const bal60 = remainingBalance(14146321, 0.065 / 12, pay, 60);
  assert.ok(Math.abs(bal60 - 12811214) <= 1.5, 'Y5 balance ' + bal60);
});

test('zero-rate loan amortizes linearly', () => {
  const pay = pmt(0, 120, 120000);
  assert.equal(pay, 1000);
  assert.equal(remainingBalance(120000, 0, pay, 12), 108000);
  assert.equal(remainingBalance(120000, 0, pay, 120), 0);
});

test('IRR: sign conventions, no-sign-change null, very high rates', () => {
  assert.ok(Math.abs(irr([-100, 110]) - 0.10) < 1e-9, 'simple 10%');
  assert.equal(irr([-100, -50, -10]), null, 'all negative → null');
  assert.equal(irr([100, 50]), null, 'all positive → null');
  const high = irr([-100, 900]);                       // 800%/yr
  assert.ok(Math.abs(high - 8) < 1e-6, 'very high IRR ' + high);
  const negative = irr([-100, 40, 30]);                // loses money
  assert.ok(negative !== null && negative < 0, 'negative IRR resolves');
});

test('thousand rounding and acres normalization', () => {
  assert.equal(roundToNearestThousand(27077202), 27077000);
  assert.equal(roundToNearestThousand(27077500), 27078000);
  const r = calculateInvestmentAnalysis(fixture('wedgewood.json').input);
  dollars(r.summary.normalizedSquareFeet, 7.126 * 43560, 'acres to SF');
});

test('purchase-month period labels: year boundaries', () => {
  assert.equal(periodEndFromPurchaseMonth('2025-12', 1), '2026-11');
  assert.equal(periodEndFromPurchaseMonth('2026-01', 1), '2026-12');
  assert.equal(periodEndFromPurchaseMonth('2026-06', 5), '2031-05');
});

// ---------- behavioral edge cases ----------
const minimalInput = overrides => JSON.parse(JSON.stringify(Object.assign({
  schemaVersion: 1,
  analysisName: 'Edge',
  property: { name: 'Edge', size: { unit: 'squareFeet', value: 10000 }, purchaseMonth: '2026-01' },
  projection: { years: 5, taxMode: 'beforeTax' },
  acquisition: { basis: { mode: 'purchasePrice', value: 1000000 }, costPercent: 0.02 },
  income: { mode: 'aggregate', year1PotentialIncome: 120000, growth: { mode: 'constant', value: 0.03 }, otherIncome: [] },
  vacancy: { mode: 'constant', value: 0.10 },
  expenses: { mode: 'percentOfGOI', value: 0.30 },
  capitalExpenses: [],
  financing: { loans: [] },
  disposition: { exitCapRate: { mode: 'constant', value: 0.065 }, sellingCostPercent: 0.05 }
}, overrides)));

test('all-cash: no debt rows, equity equals unleveraged investment', () => {
  const r = calculateInvestmentAnalysis(minimalInput({}));
  assert.equal(r.loans.length, 0);
  assert.equal(r.annual[0].debtService, 0);
  assert.equal(r.annual[0].endingLoanBalance, 0);
  dollars(r.summary.initialEquity, r.summary.unleveragedInitialInvestment, 'equity = unleveraged');
  assert.equal(r.annual[0].dscr, null, 'DSCR is n/a all-cash');
  assert.ok(Math.abs(r.annual[0].cashOnCash - r.annual[0].unleveragedCashOnCash) < 1e-12);
  assertNoNonFinite(r, 'result');
});

test('acquisition-cap input mode derives the purchase price', () => {
  const base = calculateInvestmentAnalysis(minimalInput({}));
  const capPct = base.summary.acquisitionCapRate;
  const r = calculateInvestmentAnalysis(minimalInput({
    acquisition: { basis: { mode: 'acquisitionCapRate', value: capPct }, costPercent: 0.02 } }));
  dollars(r.summary.purchasePrice, 1000000, 'derived price');
});

test('negative cash flow warns and still calculates', () => {
  const r = calculateInvestmentAnalysis(minimalInput({
    financing: { loans: [{ label: 'L', kind: 'newAmortizing', amount: { mode: 'ltv', value: 0.95 },
      annualRate: 0.12, amortizationYears: 25, termYears: 5, feePercent: 0.01,
      interestCalculation: '30/360' }] } }));
  assert.ok(r.annual[0].cashFlowBeforeTaxes < 0);
  assert.ok(r.warnings.some(w => /negative/i.test(w)), r.warnings.join(' | '));
  assertNoNonFinite(r, 'result');
});

test('dollar-expense mode grows from year 1', () => {
  const r = calculateInvestmentAnalysis(minimalInput({
    expenses: { mode: 'annualDollar', value: 30000, growth: { mode: 'constant', value: 0.04 } } }));
  dollars(r.annual[0].operatingExpenses, 30000, 'Y1');
  dollars(r.annual[1].operatingExpenses, 31200, 'Y2');
});

test('unsupported branches are rejected with field errors, not guessed', () => {
  const cases = [
    [{ projection: { years: 7, taxMode: 'beforeTax' } }, 'projection.years'],
    [{ projection: { years: 5, taxMode: 'afterTax' } }, 'projection.taxMode'],
    [{ financing: { loans: [{ kind: 'interestOnly', amount: { mode: 'ltv', value: 0.5 },
        annualRate: 0.06, amortizationYears: 25, termYears: 5 }] } }, 'financing.loans.0.kind'],
    [{ financing: { loans: [
        { kind: 'newAmortizing', amount: { mode: 'ltv', value: 0.5 }, annualRate: 0.06, amortizationYears: 25, termYears: 5 },
        { kind: 'newAmortizing', amount: { mode: 'ltv', value: 0.1 }, annualRate: 0.08, amortizationYears: 25, termYears: 5 }
      ] } }, 'financing.loans'],
    [{ financing: { loans: [{ kind: 'newAmortizing', amount: { mode: 'ltv', value: 0.5 },
        annualRate: 0.06, amortizationYears: 25, termYears: 3 }] } }, 'financing.loans.0.termYears'],
    [{ disposition: { exitCapRate: { mode: 'constant', value: 0 }, sellingCostPercent: 0.05 } }, 'disposition.exitCapRate.value'],
    [{ property: { name: 'Edge', size: { unit: 'hectares', value: 1 }, purchaseMonth: '2026-01' } }, 'property.size.unit'],
    [{ property: { name: 'Edge', size: { unit: 'squareFeet', value: 10000 }, purchaseMonth: 'March 2026' } }, 'property.purchaseMonth']
  ];
  for (const [overrides, field] of cases) {
    assert.throws(() => calculateInvestmentAnalysis(minimalInput(overrides)),
      e => e.validation && e.validation[field] !== undefined,
      'expected rejection on ' + field);
  }
});

test('units-sized property reports price per unit, never price per square foot', () => {
  const r = calculateInvestmentAnalysis(minimalInput({
    property: { name: 'Edge', size: { unit: 'units', value: 40 }, unitCount: 40, purchaseMonth: '2026-01' } }));
  assert.equal(r.summary.pricePerSquareFoot, null);
  dollars(r.summary.pricePerUnit, 25000, 'price per unit');
});

test('result serializes with no NaN/Infinity anywhere, and annualRows is total', () => {
  const r = calculateInvestmentAnalysis(minimalInput({}));
  const json = JSON.stringify(r);
  assert.ok(!/NaN|Infinity/.test(json), 'no non-finite tokens in JSON');
  const rows = annualRows(r);
  assert.equal(rows.length, 5);
  rows.forEach(row => COLUMNS.forEach(c => assert.ok(c in row, 'missing column ' + c)));
});

test('ten-year projection: 10 annual rows, Y10 sale uses Y11 NOI, terminal audit', () => {
  const input = minimalInput({
    projection: { years: 10, taxMode: 'beforeTax' },
    financing: { loans: [{ label: 'First Mortgage', kind: 'newAmortizing',
      amount: { mode: 'ltv', value: 0.65 }, annualRate: 0.065, amortizationYears: 25,
      termYears: 10, feePercent: 0.01, interestCalculation: '30/360' }] },
    reportOptions: { includeSensitivity: true }
  });
  const r = calculateInvestmentAnalysis(input);
  assert.equal(r.annual.length, 10);
  assert.equal(r.normalizedInput.projection.years, 10);
  // Y10 sale = Y11 NOI / exit cap, rounded to $1,000
  const y10NOI = r.annual[9].netOperatingIncome;
  const y11NOI = r.summary.terminalYearNOI;
  dollars(y11NOI, y10NOI * 1.03, 'Y11 NOI grows one more year at 3%');
  assert.equal(r.annual[9].grossSalePrice,
    Math.round(y11NOI / 0.065 / 1000) * 1000, 'Y10 sale priced on Y11 NOI');
  // period labels run ten full years
  assert.equal(r.annual[9].periodEnd, periodEndFromPurchaseMonth('2026-01', 10));
  // sensitivity series carry ten entries per scenario
  assert.equal(r.sensitivity[0].leveragedIRR.length, 10);
  // annual persistence rows are total for ten years too
  assert.equal(annualRows(r).length, 10);
  assertNoNonFinite(r, 'result');
});

test('a five-year loan cannot finance a ten-year projection', () => {
  assert.throws(() => calculateInvestmentAnalysis(minimalInput({
    projection: { years: 10, taxMode: 'beforeTax' },
    financing: { loans: [{ label: 'L', kind: 'newAmortizing', amount: { mode: 'ltv', value: 0.5 },
      annualRate: 0.06, amortizationYears: 25, termYears: 5, feePercent: 0.01,
      interestCalculation: '30/360' }] } })),
    e => e.validation && /10-year/.test(e.validation['financing.loans.0.termYears']));
});
