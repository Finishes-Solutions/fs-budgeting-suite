// Server-side budget arithmetic — a faithful port of the browser's CALC block
// (app/index.html: totUnits, lineQty, scopeActive, scopeSum, parts, grossIncome).
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

function parts(doc) {
  const res = scopeSum(doc, 'res'), amen = scopeSum(doc, 'amen'), soft = scopeSum(doc, 'soft');
  const hard = res + amen;
  const profit = (doc.companies || []).reduce((s, c) => s + hard * nz(c.pct) / 100, 0);
  const c = doc.contingency || {};
  const cont = c.mode === 'pct' ? hard * nz(c.val) / 100
    : c.mode === 'psf' ? (nz(doc.resSF) + nz(doc.amenSF)) * nz(c.val) : nz(c.val);
  const contract = hard + profit + cont;
  const pc = doc.projectCosts || {};
  const fees = nz(pc.dev) + nz(pc.mkt) + nz(pc.cls);
  const project = contract + soft + nz(pc.land) + fees;
  return { res, amen, soft, hard, profit, cont, contract, fees, project };
}

function grossIncome(doc) {
  const tu = totUnits(doc);
  const rent = (doc.units || []).reduce((s, u) => s + nz(u.rent) * nz(u.count), 0);
  const other = (doc.other || []).reduce((s, o) => s + nz(o.rate) * (o.auto ? tu : nz(o.count)), 0);
  const exp = (doc.expenses || []).reduce((s, e) =>
    s + nz(e.rate) * (e.per === 'fixed' ? (nz(e.count) || 1) : (e.auto ? tu : nz(e.count))), 0);
  const netOther = other - exp;
  return { rentMo: rent, otherMo: other, expMo: exp, netOtherMo: netOther,
           grossYr: 12 * (rent + other), netYr: 12 * (rent + netOther) };
}

module.exports = { nz, totUnits, lineQty, scopeActive, activeScopes, scopeSum, parts, grossIncome };
