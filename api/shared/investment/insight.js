// Pro forma insight for the Budget Assistant: what an investment analysis says,
// what is driving its returns, and what a change would do — all computed by
// the engine itself, never estimated by the model.
//
// Three things live here, all pure:
//
//   analysisFacts()   the summary, key assumptions and year-by-year rows the
//                     assistant is shown, plus diagnostics and drivers
//   drivers()         one-at-a-time sensitivity: re-run the engine with each
//                     assumption nudged by a fixed step and rank by how far the
//                     equity IRR moves. This is the computed answer to "what is
//                     making this deal bad".
//   runScenario()     apply a bounded set of changes and re-run the engine, so
//                     "what if we add $40/unit of RUBS" comes back as real
//                     NOI / IRR / multiple deltas.
//
// The engine accepts its own normalizedInput back as input and reproduces the
// identical result (pinned by test/budget-assistant.test.js on all five
// reference deals), which is what lets every variation start from it.
const { calculateInvestmentAnalysis } = require('./calculate');

const r4 = n => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null);
const r2 = n => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const clone = o => JSON.parse(JSON.stringify(o));

function calc(norm) {
  try { return { result: calculateInvestmentAnalysis(norm) }; }
  catch (e) {
    return { error: e && e.validation
      ? 'The changed assumptions do not validate: ' + JSON.stringify(e.validation).slice(0, 400)
      : 'The engine could not calculate this scenario.' };
  }
}

// The headline numbers a person compares across scenarios.
function headline(res) {
  const s = res.summary || {}, y1 = (res.annual || [])[0] || {};
  return {
    purchasePrice: r2(s.purchasePrice), year1NOI: r2(s.year1NOI), initialEquity: r2(s.initialEquity),
    goingInCapRate: r4(s.acquisitionCapRate), finalYearEquityIRR: r4(s.finalYearEquityIRR),
    equityMultiple: r4(s.finalYearEquityMultiple), year1DSCR: r4(y1.dscr), year1CashOnCash: r4(y1.cashOnCash),
    year1DebtYield: r4(y1.debtYield)
  };
}

function delta(a, b) {
  const out = {};
  Object.keys(b).forEach(k => {
    out[k] = (Number.isFinite(a[k]) && Number.isFinite(b[k])) ? r4(b[k] - a[k]) : null;
  });
  return out;
}

/* ------------------------------ drivers ------------------------------ */

// Each nudge is a plausible underwriting step, applied to the normalized input.
// A nudge that does not apply to this deal (no loans, price set by cap rate…)
// returns false and is skipped rather than faked.
const NUDGES = [
  { id: 'rent', label: 'Rental income +5%', apply: n => { n.income.year1PotentialIncome *= 1.05; } },
  { id: 'rentGrowth', label: 'Rent growth +1 pt / yr', apply: n => { n.income.growth.value += 0.01; } },
  { id: 'vacancy', label: 'Vacancy −2 pts', apply: n => { if (n.vacancy.value < 0.02) return false; n.vacancy.value -= 0.02; } },
  // Scaling the value works for both modes: a ratio of GOI or annual dollars.
  { id: 'expenses', label: 'Operating expenses −5%', apply: n => { n.expenses.value *= 0.95; } },
  { id: 'price', label: 'Purchase price / project cost −5%', apply: n => {
      if (n.acquisition.basis.mode !== 'purchasePrice') return false;
      n.acquisition.basis.value *= 0.95; } },
  { id: 'exitCap', label: 'Exit cap rate −0.50 pt', apply: n => {
      if (!(n.disposition.exitCapRate.value > 0.006)) return false;
      n.disposition.exitCapRate.value -= 0.005; } },
  { id: 'rate', label: 'Loan interest rate −0.50 pt', apply: n => {
      if (!n.financing.loans.length) return false;
      n.financing.loans.forEach(L => { L.annualRate = Math.max(0, L.annualRate - 0.005); }); } }
];

function drivers(norm, base) {
  const b = headline(base);
  const out = [];
  NUDGES.forEach(x => {
    const n = clone(norm);
    if (x.apply(n) === false) return;
    const r = calc(n);
    if (r.error) return;
    const h = headline(r.result);
    out.push({ id: x.id, change: x.label, irrChange: delta(b, h).finalYearEquityIRR,
      noiChange: delta(b, h).year1NOI, multipleChange: delta(b, h).equityMultiple,
      dscrChange: delta(b, h).year1DSCR });
  });
  return out.sort((p, q) => Math.abs(q.irrChange || 0) - Math.abs(p.irrChange || 0));
}

/* ---------------------------- diagnostics ---------------------------- */

// Comparisons, not verdicts. The thresholds are common multifamily
// underwriting rules of thumb and are labelled as such everywhere they
// surface — the assistant is told to present them that way.
function diagnostics(norm, res) {
  const s = res.summary || {}, y1 = (res.annual || [])[0] || {};
  const out = [];
  const add = (id, severity, finding) => out.push({ id, severity, finding });
  const pct = v => (v * 100).toFixed(2) + '%';
  const exitCap = norm.disposition.exitCapRate.value;
  if (Number.isFinite(s.acquisitionCapRate) && Number.isFinite(exitCap)) {
    if (exitCap < s.acquisitionCapRate)
      add('exitBelowEntry', 'warn', 'Exit cap ' + pct(exitCap) + ' is BELOW the going-in cap ' + pct(s.acquisitionCapRate)
        + ' — the sale assumes cap-rate compression, which flatters the IRR.');
    else add('capSpread', 'info', 'Exit cap ' + pct(exitCap) + ' vs going-in cap ' + pct(s.acquisitionCapRate)
        + ' (spread ' + ((exitCap - s.acquisitionCapRate) * 10000).toFixed(0) + ' bps).');
  }
  if (Number.isFinite(y1.dscr)) {
    if (y1.dscr < 1.0) add('dscr', 'error', 'Year-1 DSCR ' + y1.dscr.toFixed(2) + ' — NOI does not cover debt service.');
    else if (y1.dscr < 1.25) add('dscr', 'warn', 'Year-1 DSCR ' + y1.dscr.toFixed(2) + ' is under the common 1.25x lender minimum (rule of thumb).');
  }
  const negLev = (res.annual || []).filter(a => Number.isFinite(a.leverageImpact) && a.leverageImpact < 0).length;
  if (negLev) add('negativeLeverage', 'warn', 'Negative leverage in ' + negLev + ' of ' + (res.annual || []).length
    + ' years — the loan costs more than the property yields, so debt lowers the equity return.');
  if (Number.isFinite(y1.cashOnCash) && y1.cashOnCash < 0.05)
    add('cashOnCash', 'warn', 'Year-1 cash-on-cash ' + pct(y1.cashOnCash) + ' (many investors look for 5–8% — rule of thumb).');
  if (Number.isFinite(s.finalYearEquityIRR) && s.finalYearEquityIRR < 0.12)
    add('irr', 'info', 'Equity IRR ' + pct(s.finalYearEquityIRR) + ' over ' + norm.projection.years
      + ' years (value-add / development targets are often 15%+ — rule of thumb).');
  if (norm.vacancy.value < 0.05)
    add('vacancy', 'warn', 'Vacancy ' + pct(norm.vacancy.value) + ' is aggressive for underwriting (5–7% is common).');
  if (norm.expenses.mode === 'percentOfGOI' && (norm.expenses.value < 0.30 || norm.expenses.value > 0.55))
    add('expenseRatio', 'warn', 'Expense ratio ' + pct(norm.expenses.value) + ' of GOI is outside the 30–55% typical for multifamily.');
  if (norm.income.growth.value > 0.04)
    add('rentGrowth', 'warn', 'Rent growth ' + pct(norm.income.growth.value) + '/yr is above the 2–3% often underwritten.');
  if (!(norm.income.otherIncome || []).length)
    add('otherIncome', 'info', 'No other income modelled — ancillary income (RUBS, parking, storage, pet, tech package, fees) is often 5–10% of rent.');
  (res.warnings || []).forEach(w => {
    if (negLev && /leverage is negative/i.test(w)) return;   // already said, with the year count
    add('engine', 'info', 'Engine: ' + w);
  });
  return out;
}

/* ------------------------------ scenarios ------------------------------ */

// A bounded vocabulary of changes. Every value is range-checked; the engine's
// own validation is the second gate. Percentages are decimal fractions.
const SCENARIO_KEYS = {
  rentChangePct:        [-0.5, 1],      // multiply year-1 potential rent by (1 + x)
  rentGrowth:           [-0.05, 0.10],  // set
  vacancy:              [0, 0.5],       // set
  expenseRatio:         [0.05, 0.9],    // set (percent-of-GOI deals only)
  expenseChangePct:     [-0.5, 1],      // multiply expenses by (1 + x)
  purchasePrice:        [1, 1e10],      // set (purchase-price deals only)
  purchasePriceChangePct: [-0.5, 1],
  exitCapRate:          [0.02, 0.15],   // set
  interestRate:         [0, 0.2],       // set on every loan
  addOtherIncome:       null            // [{label, annualAmount, growth?}]
};

function runScenario(norm, changes) {
  if (!changes || typeof changes !== 'object') return { error: 'changes must be an object' };
  const n = clone(norm);
  const applied = [];
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in SCENARIO_KEYS)) return { error: 'Unknown change: ' + k + '. Allowed: ' + Object.keys(SCENARIO_KEYS).join(', ') };
    if (k === 'addOtherIncome') {
      if (!Array.isArray(v) || v.length > 10) return { error: 'addOtherIncome must be a list of up to 10 rows' };
      for (const row of v) {
        const amt = +(row && row.annualAmount);
        if (!Number.isFinite(amt) || amt < 0 || amt > 1e9) return { error: 'addOtherIncome rows need annualAmount ≥ 0' };
        const g = row.growth === undefined ? 0.03 : +row.growth;
        if (!Number.isFinite(g) || g < -0.05 || g > 0.1) return { error: 'addOtherIncome growth must be between -5% and 10%' };
        n.income.otherIncome.push({ label: String(row.label || 'Other income').slice(0, 80), year1Amount: amt,
          growth: { mode: 'constant', value: g } });
        applied.push('Other income + $' + Math.round(amt).toLocaleString('en-US') + '/yr (' + String(row.label || 'Other income').slice(0, 80) + ')');
      }
      continue;
    }
    const x = +v, [lo, hi] = SCENARIO_KEYS[k];
    if (!Number.isFinite(x) || x < lo || x > hi) return { error: k + ' must be between ' + lo + ' and ' + hi };
    if (k === 'rentChangePct') n.income.year1PotentialIncome *= (1 + x);
    else if (k === 'rentGrowth') n.income.growth.value = x;
    else if (k === 'vacancy') n.vacancy.value = x;
    else if (k === 'expenseRatio') {
      if (n.expenses.mode !== 'percentOfGOI') return { error: 'expenseRatio applies only to percent-of-GOI expenses; use expenseChangePct' };
      n.expenses.value = x;
    } else if (k === 'expenseChangePct') n.expenses.value *= (1 + x);
    else if (k === 'purchasePrice' || k === 'purchasePriceChangePct') {
      if (n.acquisition.basis.mode !== 'purchasePrice') return { error: 'This deal is priced by acquisition cap rate, not purchase price' };
      n.acquisition.basis.value = k === 'purchasePrice' ? x : n.acquisition.basis.value * (1 + x);
    } else if (k === 'exitCapRate') n.disposition.exitCapRate.value = x;
    else if (k === 'interestRate') {
      if (!n.financing.loans.length) return { error: 'This deal has no loans' };
      n.financing.loans.forEach(L => { L.annualRate = x; });
    }
    applied.push(k + ' = ' + x);
  }
  const base = calc(norm), next = calc(n);
  if (base.error) return { error: base.error };
  if (next.error) return { error: next.error };
  const b = headline(base.result), a = headline(next.result);
  return { applied, before: b, after: a, change: delta(b, a) };
}

/* ------------------------------ the facts ------------------------------ */

// meta: { analysisId, name, status, sourceBudgetId, sourceBudgetVersion,
//         budgetCurrentVersion, projectKey, savedAt, basedOn }
function analysisFacts(input, meta, opts) {
  opts = opts || {};
  const r = calc(input);
  if (r.error) return { meta, input, error: 'Not calculable yet: ' + r.error };
  const res = r.result, norm = res.normalizedInput;
  const facts = {
    meta: Object.assign({}, meta, { calculationVersion: res.calculationVersion }),
    headline: headline(res),
    assumptions: {
      property: { size: norm.property.size, unitCount: norm.property.unitCount, purchaseMonth: norm.property.purchaseMonth },
      years: norm.projection.years,
      acquisition: norm.acquisition,
      year1PotentialRent: r2(norm.income.year1PotentialIncome), rentGrowth: norm.income.growth.value,
      otherIncome: norm.income.otherIncome.map(o => ({ label: o.label, year1Amount: r2(o.year1Amount), growth: o.growth.value })),
      vacancy: norm.vacancy.value,
      expenses: { mode: norm.expenses.mode, value: norm.expenses.value,
        derivedFromBudget: !!norm.expenses.derivedFrom, override: norm.expenses.override },
      capitalExpenses: norm.capitalExpenses,
      loans: res.loans.map(L => ({ label: L.label, principal: r2(L.principal), annualRate: L.annualRate,
        amortizationYears: L.amortizationYears, termYears: L.termYears, annualDebtService: r2(L.annualDebtService) })),
      exitCapRate: norm.disposition.exitCapRate.value, sellingCostPercent: norm.disposition.sellingCostPercent
    },
    summary: Object.fromEntries(Object.entries(res.summary).map(([k, v]) => [k, typeof v === 'number' ? r4(v) : v])),
    diagnostics: diagnostics(norm, res),
    drivers: drivers(norm, res)
  };
  if (!opts.brief) {
    facts.annual = res.annual.map(a => ({ year: a.year, potentialIncome: r2(a.potentialIncome), vacancyLoss: r2(a.vacancyLoss),
      otherIncome: r2(a.otherIncome), grossOperatingIncome: r2(a.grossOperatingIncome), operatingExpenses: r2(a.operatingExpenses),
      netOperatingIncome: r2(a.netOperatingIncome), debtService: r2(a.debtService), cashFlowBeforeTaxes: r2(a.cashFlowBeforeTaxes),
      dscr: r4(a.dscr), cashOnCash: r4(a.cashOnCash), netSaleProceeds: r2(a.netSaleProceeds),
      equityIRR: r4(a.equityIRR), propertyIRR: r4(a.propertyIRR), leverageImpact: r4(a.leverageImpact),
      equityMultiple: r4(a.equityMultiple) }));
  }
  return facts;
}

module.exports = { analysisFacts, drivers, diagnostics, runScenario, headline, SCENARIO_KEYS };
