// Server-side budget arithmetic — a faithful port of the browser's CALC block
// (app/index.html: totUnits, lineQty, scopeActive, scopeSum, feeOf, parts,
// grossIncome).
//
// It exists so persisted summary values (ContractSum, ProjectCost) and the
// investment-analysis prefill are derived from the budget document itself
// rather than trusted from client-computed meta. Any change to the browser
// formulas must be mirrored here; test/budget-calc.test.js and the in-suite
// browser parity check exist to catch drift.
//
// Functions take the document as an argument (the browser closes over a global
// `doc`). Every numeric read is nz-coerced: old documents can carry absent
// properties, and absent must mean 0 here exactly as it does in the browser.

const nz = v => (Number.isFinite(+v) ? +v : 0);

// A percentage fee whose rates sum to 1 would divide by zero below. The
// divisor floors at FEE_FLOOR so the summary shows a large-but-finite number
// while the feeSum guard rail (max 95%) is already refusing the save — a
// blocked budget must still render, not print $Infinity.
const FEE_FLOOR = 0.05;

function totUnits(doc) {
  return (doc.units || []).reduce((s, u) => s + nz(u.count), 0);
}

function lineQty(doc, it) {
  if (!it.auto) return nz(it.qty);
  if (it.basis === 'sf') return nz(doc.resSF);
  if (it.basis === 'asf') return nz(doc.amenSF);
  if (it.basis === 'unit') return totUnits(doc);
  return 1;
}

// Amenity suppression is arithmetic, not display: an inactive amenity scope
// contributes zero even for lump-sum or manually-quantified lines.
function scopeActive(doc, sc) {
  return sc !== 'amen' || (+doc.amenSF || 0) > 0;
}

function activeScopes(doc) {
  return ['res', 'amen', 'soft'].filter(sc => scopeActive(doc, sc));
}

function scopeSum(doc, sc) {
  if (!scopeActive(doc, sc)) return 0;
  return (doc.lines || []).filter(l => l.scope === sc)
    .reduce((s, it) => s + lineQty(doc, it) * nz(it.unit), 0);
}

// Developer fee, marketing and closing costs are each EITHER a dollar amount
// or a percentage — {mode:'amt'|'pct', val} — following the shape
// doc.contingency already uses. A bare number is a pre-migration document and
// reads as dollars.
function feeMode(v) { return v && typeof v === 'object' && v.mode === 'pct' ? 'pct' : 'amt'; }
function feeVal(v) { return v && typeof v === 'object' ? nz(v.val) : nz(v); }
function feeRate(v) { return feeMode(v) === 'pct' ? feeVal(v) / 100 : 0; }
function feeFixed(v) { return feeMode(v) === 'pct' ? 0 : feeVal(v); }

function parts(doc) {
  const res = scopeSum(doc, 'res'), amen = scopeSum(doc, 'amen'), soft = scopeSum(doc, 'soft');
  const hard = res + amen;
  const profit = (doc.companies || []).reduce((s, c) => s + hard * nz(c.pct) / 100, 0);
  const c = doc.contingency || {};
  const cont = c.mode === 'pct' ? hard * nz(c.val) / 100
    : c.mode === 'psf' ? (nz(doc.resSF) + nz(doc.amenSF)) * nz(c.val) : nz(c.val);
  const contract = hard + profit + cont;
  const pc = doc.projectCosts || {};

  // "A percentage of the total project cost" is circular — the developer fee
  // is itself part of that total. Resolved in closed form rather than by
  // iteration: with base = contract + soft + land and f the summed percentage
  // rates, project = (base + fixedFees) / (1 - f). So a 3% fee really is 3%
  // of the number printed on the summary line.
  const base = contract + soft + nz(pc.land);
  const rate = feeRate(pc.dev) + feeRate(pc.mkt) + feeRate(pc.cls);
  const fixed = feeFixed(pc.dev) + feeFixed(pc.mkt) + feeFixed(pc.cls);
  const project = (base + fixed) / Math.max(1 - rate, FEE_FLOOR);

  const fee = {
    dev: feeFixed(pc.dev) + feeRate(pc.dev) * project,
    mkt: feeFixed(pc.mkt) + feeRate(pc.mkt) * project,
    cls: feeFixed(pc.cls) + feeRate(pc.cls) * project,
    // null when nothing is on a percentage, so the feeSum rail stays unjudged
    // rather than reporting a meaningless 0%.
    pctRate: rate > 0 || feeMode(pc.dev) === 'pct' || feeMode(pc.mkt) === 'pct' || feeMode(pc.cls) === 'pct'
      ? rate : null
  };
  const fees = fee.dev + fee.mkt + fee.cls;
  return { res, amen, soft, hard, profit, cont, contract, fee, fees, project };
}

function grossIncome(doc) {
  const tu = totUnits(doc);
  const rent = (doc.units || []).reduce((s, u) => s + nz(u.rent) * nz(u.count), 0);
  const other = (doc.other || []).reduce((s, o) => s + nz(o.rate) * (o.auto ? tu : nz(o.count)), 0);
  // Percent-of-income expenses (management fee, often taxes) are NOT circular:
  // income does not depend on expenses, so this is a straight computation off
  // the rent + other-income total.
  const incomeMo = rent + other;
  const exp = (doc.expenses || []).reduce((s, e) => s + expenseMonthly(doc, e, incomeMo), 0);
  const netOther = other - exp;
  return { rentMo: rent, otherMo: other, expMo: exp, netOtherMo: netOther,
           grossYr: 12 * (rent + other), netYr: 12 * (rent + netOther) };
}

// The monthly amount one expense row contributes, and the ONE place the
// per-basis rule lives server-side: grossIncome() sums it and the analysis
// import (investment/from-budget.js) itemises it. The browser's
// expenseMonthly() in app/index.html mirrors it, and every budget export —
// print, engine PDF, legacy PDF, Excel — prints its rows from that mirror, so
// a pctIncome row prints the number it is charged at and the rows add up to
// the expense total. (They once each computed rate x count, which printed $0
// for a % of income row under a correct total: BUDGET-SYSTEM.md §16 D2.)
function expenseMonthly(doc, e, incomeMo) {
  const tu = totUnits(doc);
  if (e.per === 'pctIncome') {
    const g = Number.isFinite(+incomeMo) ? null : grossIncome(doc);
    const inc = g ? g.rentMo + g.otherMo : +incomeMo;
    return inc * nz(e.rate) / 100;
  }
  return nz(e.rate) * (e.per === 'fixed' ? (nz(e.count) || 1) : (e.auto ? tu : nz(e.count)));
}

module.exports = { nz, totUnits, lineQty, scopeActive, activeScopes, scopeSum, parts, grossIncome,
                   expenseMonthly, feeMode, feeVal, feeRate, feeFixed, FEE_FLOOR };
