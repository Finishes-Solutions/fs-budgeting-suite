// Budget engine v2 — math tests on a fixed synthetic bundle
// (test/fixtures/engine-data.js). Research-data tests live in
// test/research-data.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../app/budget-engine.js');
const D = require('./fixtures/engine-data.js');
const calc = require('../api/shared/budget-calc');

const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= (tol || 0.01), (m || '') + ': ' + a + ' vs ' + b);
const cents = x => Math.round(x * 100);
const sumC = (arr, f) => arr.reduce((s, x) => s + cents(f(x)), 0);

function quick(o) {
  const p = E.newProject(D, Object.assign({ typeId: 'apt', size: 100 }, o || {}));
  p.phases[0].financing.enabled = false;
  return p;
}

test('allocateCents: parts are integers that sum exactly, any weights', () => {
  for (const [T, w] of [[100, [1, 1, 1]], [1000001, [0.3, 0.3, 0.4]], [7, [0, 0, 0]], [-500, [1, 2]], [999, [1e-9, 1, 3]]]) {
    const out = E._.allocateCents(T, w);
    assert.equal(out.reduce((s, x) => s + x, 0), T);
    out.forEach(x => assert.ok(Number.isInteger(x)));
  }
});

test('quick mode: baseline × size, split 100% across divisions, national, no start → no escalation', () => {
  const r = E.calculate(quick(), D);
  const hard = r.lines.filter(l => l.category === 'hard');
  near(hard.reduce((s, l) => s + l.amount, 0), 200000 * 100, 0.001, 'hard = price × units');
  near(r.lines.find(l => l.key === 'c1:div:06').amount, 0.4 * 20000000, 0.001, 'division share');
  // contingency: design 5% of hard; hard 5% of (hard + design)
  near(r.totals.hardContingency, 20000000 * 0.05 + 21000000 * 0.05, 0.01);
  // soft bucket 20% of hard spread over A&E/permits/legal by 6/2/2
  const soft = r.lines.filter(l => l.category === 'soft');
  near(soft.reduce((s, l) => s + l.amount, 0), 4000000, 0.01, 'soft = 20% of hard');
  near(r.lines.find(l => l.key === 'c1@p1:soft:architectureEngineering').amount, 2400000, 0.01);
  near(r.metrics.perPrimaryUnit, r.totals.total / 100, 1e-6);
  near(r.metrics.perSF, r.totals.total / 100000, 1e-6);
});

test('quick mode: regional, quality and escalation factors multiply the baseline', () => {
  const p = quick({ region: 'TX-Austin', startMonth: '2027-07' });
  p.phases[0].months = 12;    // midpoint 2028-01: 6 months at 2026 rate + 12 at 2027
  p.components[0].quality = 'premium';
  const r = E.calculate(p, D);
  const esc = Math.pow(1.04, 0.5) * Math.pow(1.05, 1);
  near(r.phases[0].escalation.factor, esc, 1e-9, 'escalation');
  const hard = r.lines.filter(l => l.category === 'hard').reduce((s, l) => s + l.amount, 0);
  near(hard, 200000 * 100 * 0.95 * 1.25 * esc, 0.05, 'R × Q × E');
});

test('a user baseline with local basis skips the regional factor', () => {
  const p = quick({ region: 'CA' });
  p.components[0].baseline = { price: 250000, basis: 'local' };
  const r = E.calculate(p, D);
  near(r.lines.filter(l => l.category === 'hard').reduce((s, l) => s + l.amount, 0), 25000000, 0.01);
  assert.equal(r.components[0].baselineSource.kind, 'user');
});

test('overrides flow through: amount, rate/qty, off — and soft/contingency follow', () => {
  const p = quick();
  const r0 = E.calculate(p, D);
  p.overrides = { 'c1:div:03': { amount: 7000000 }, 'c1@p1:soft:legalAccounting': { off: true } };
  const r1 = E.calculate(p, D);
  const d03 = r1.lines.find(l => l.key === 'c1:div:03');
  assert.equal(d03.amount, 7000000); assert.ok(d03.overridden); assert.equal(d03.source.kind, 'user');
  assert.equal(r1.lines.find(l => l.key === 'c1@p1:soft:legalAccounting').amount, 0);
  const dHard = 7000000 - 6000000;
  near(r1.totals.hard - r0.totals.hard, dHard, 0.01, 'hard moved by the override');
  assert.ok(r1.totals.hardContingency > r0.totals.hardContingency, 'contingency follows the hard change');
  // a per-unit item rate override
  const pk = E.newProject(D, { typeId: 'park', size: 10 }); pk.phases[0].financing.enabled = false;
  pk.overrides = { 'c1:item:grease': { rate: 45000 } };
  near(E.calculate(pk, D).lines.find(l => l.key === 'c1:item:grease').amount, 45000, 0.001);
  pk.overrides = { 'c1:item:grease': { qty: 2 } };
  near(E.calculate(pk, D).lines.find(l => l.key === 'c1:item:grease').amount, 60000, 0.001);
});

test('non-scaling items: fixed in-baseline items stay fixed, so cost per pad falls with size', () => {
  const at = n => { const p = E.newProject(D, { typeId: 'park', size: n }); p.phases[0].financing.enabled = false; return E.calculate(p, D); };
  const r10 = at(10), r40 = at(40);
  const base = r => r.lines.filter(l => l.category === 'hard' && !/grease/.test(l.key)).reduce((s, l) => s + l.amount, 0);
  near(base(r10), 100000 * 10, 0.01, 'typical size reproduces the baseline');
  // v = 100000 − 200000/10 = 80000; at 40 pads: 80000 × 40 + 200000
  near(base(r40), 80000 * 40 + 200000, 0.01, 'fixed restroom not multiplied');
  assert.equal(r40.lines.find(l => l.key === 'c1:item:restroom').amount, 200000);
  assert.equal(r40.lines.find(l => l.key === 'c1:item:pedestal').amount, 400000);
  assert.ok(!r10.lines.some(l => l.key === 'c1:item:stage'), 'optional item off by default');
  const p = E.newProject(D, { typeId: 'park', size: 10 }); p.components[0].items = { stage: { on: true } };
  assert.ok(E.calculate(p, D).lines.some(l => l.key === 'c1:item:stage'));
});

test('carve-outs never change the baseline total', () => {
  const r = E.calculate(E.newProject(D, { typeId: 'park', size: 7 }), D);
  const inBase = r.lines.filter(l => l.category === 'hard' && !/grease/.test(l.key));
  // v×size + fixed: 80000 × 7 + 200000
  near(inBase.reduce((s, l) => s + l.amount, 0), 80000 * 7 + 200000, 0.01);
  assert.ok(inBase.every(l => l.amount >= 0));
});

function mixed() {
  const p = E.newProject(D, { startMonth: '2027-01' });
  p.phases = [E.newPhase({ id: 'p1', name: 'Phase 1', months: 18 }), E.newPhase({ id: 'p2', name: 'Phase 2', months: 12 })];
  p.components = [
    E.newComponent(D, 'apt', { id: 'res', phaseId: 'p1', size: 200, revenue: { mode: 'perUnitMonth', rate: 1500 } }),
    E.newComponent(D, 'retail', { id: 'ret', phaseId: 'p1', size: 20000, revenue: { mode: 'perSFYear', rate: 30 } }),
    E.newComponent(D, 'apt', { id: 'res2', phaseId: 'p2', size: 120 })
  ];
  p.shared = [
    { id: 'garage', name: 'Garage', itemId: 'parking-structured-above', qty: 333, phaseId: 'p1', allocation: { method: 'sf' } },
    { id: 'pool', name: 'Pool', itemId: 'pool-residential-amenity', qty: 1, phaseId: 'p1', allocation: { method: 'manual', shares: { res: 0.7, res2: 0.3 } } },
    { id: 'road', name: 'Road', unitCost: 1234567.89, qty: 1, phaseId: 'p2', allocation: { method: 'units' } }
  ];
  p.land = { mode: 'amount', value: 6000000 };
  return p;
}

test('shared elements: each splits exactly by its method', () => {
  const r = E.calculate(mixed(), D);
  r.shared.forEach(s => assert.equal(sumC(s.shares, x => x.amount), cents(s.amount), s.name + ' adds up'));
  const g = r.shared.find(s => s.id === 'garage');
  const sf = { res: 200000, ret: 20000, res2: 120000 };
  const total = 340000;
  g.shares.forEach(x => near(x.amount, g.amount * sf[x.comp] / total, 0.01, 'by SF'));
  const pool = r.shared.find(s => s.id === 'pool');
  assert.deepEqual(pool.shares.map(x => x.comp), ['res', 'res2']);
  near(pool.shares[0].amount, pool.amount * 0.7, 0.01, 'manual share');
  const road = r.shared.find(s => s.id === 'road');
  assert.equal(cents(road.amount), 123456789);
});

test('mixed use: component totals and phase totals both add up to the project total', () => {
  const r = E.calculate(mixed(), D);
  const T = cents(r.totals.total);
  assert.equal(sumC(r.components, c => c.totals.total) + sumC(r.lines.filter(l => !l.comp), l => l.amount), T);
  assert.equal(sumC(r.phases, p => p.totals.total), T);
  assert.equal(sumC(r.lines, l => l.amount), T);
  for (const k of ['hard', 'soft', 'land', 'financing', 'contingency', 'ffe'])
    assert.equal(sumC(r.components, c => c.totals[k]), cents(r.totals[k]), k);
  near(r.split.hard + r.split.soft + r.split.land, 1, 1e-9, 'split sums to 1');
  assert.equal(cents(r.totals.land), cents(6000000 * 1.02), 'land + researched closing');
  // retail baseline excludes site work → a site-development line appears
  assert.ok(r.lines.some(l => l.key === 'ret:site-work'));
});

test('phases: escalation to each midpoint; phase 2 starts when phase 1 ends', () => {
  const r = E.calculate(mixed(), D);
  assert.equal(r.phases[0].midpoint, '2027-10');
  assert.equal(r.phases[1].start, '2028-07');
  assert.equal(r.phases[1].midpoint, '2029-01');
  near(r.phases[0].escalation.factor, Math.pow(1.04, 0.5) * Math.pow(1.05, 9 / 12), 1e-9);
  near(r.phases[1].escalation.factor, Math.pow(1.04, 0.5) * 1.05 * Math.pow(1.03, 1), 1e-9);
  assert.ok(r.phases[1].escalation.factor > r.phases[0].escalation.factor);
});

test('draw schedule and financing: draws total the phase cost; interest is capitalized and solved', () => {
  const r = E.calculate(mixed(), D);
  r.phases.forEach(p => {
    const outlay = p.draws.reduce((s, d) => s + cents(d.outlay), 0);
    assert.equal(outlay, cents(p.totals.total - p.financing.interest), p.name + ': draws = cost − interest');
    const eq = p.draws.reduce((s, d) => s + cents(d.equity), 0), loan = p.draws.reduce((s, d) => s + cents(d.loan), 0);
    assert.equal(eq + loan, outlay, 'every dollar is equity or loan');
    near(p.financing.loan, p.draws[p.draws.length - 1].balance, 0.01);
    near(p.financing.loan / p.totals.total, 0.6, 0.002, 'loan ≈ LTC × total');
    // equity first: no loan draw while equity remains
    const firstLoan = p.draws.findIndex(d => d.loan > 0);
    assert.ok(p.draws.slice(0, firstLoan).every(d => d.loan === 0));
    assert.ok(p.draws.slice(firstLoan + 1).every(d => d.equity === 0));
    assert.ok(p.financing.interest > 0);
  });
  const w = E._.curveWeights('s', 18);
  near(w.reduce((s, x) => s + x, 0), 1, 1e-12, 'S-curve weights sum to 1');
});

test('materialized into a budget document, parts() equals the engine total to the cent', () => {
  for (const p of [quick(), mixed(), E.newProject(D, { typeId: 'park', size: 13 })]) {
    const r = E.calculate(p, D);
    const bd = Object.assign({ units: [], other: [], expenses: [] }, E.toBudgetDoc(r, p));
    assert.equal(Math.round(calc.parts(bd).project * 100), cents(r.totals.total));
    assert.equal(bd.engineSummary.proforma.components.length, p.components.length);
  }
});

test('pro forma scopes: costs and income per component and phase', () => {
  const r = E.calculate(mixed(), D);
  const pf = r.proforma;
  near(pf.project.totalCost, r.totals.total, 0.01);
  const res = pf.components.find(c => c.id === 'res');
  near(res.income.year1PotentialIncome, 200 * 1500 * 12, 0.01);
  assert.equal(res.unitCount, 200);
  assert.deepEqual(res.size, { unit: 'squareFeet', value: 200000 });
  near(pf.components.find(c => c.id === 'ret').income.year1PotentialIncome, 600000, 0.01);
  near(pf.phases.reduce((s, x) => s + x.totalCost, 0), r.totals.total, 0.05);
  assert.equal(pf.project.unitCount, null, 'mixed units are not one unit count');
});

test('edge cases: zero and huge sizes, missing inputs, a phase with no components, unknown things', () => {
  const z = E.calculate(quick({ size: 0 }), D);
  assert.equal(z.totals.total, 0); assert.equal(z.metrics.perSF, null); assert.equal(z.metrics.perPrimaryUnit, null);
  const huge = E.calculate(quick({ size: 1e7 }), D);
  assert.ok(Number.isFinite(huge.totals.total) && huge.totals.total > 0);
  const empty = E.calculate({}, D);
  assert.equal(empty.totals.total, 0); assert.equal(empty.components.length, 0);
  const p = mixed(); p.phases.push(E.newPhase({ id: 'p3', name: 'Phase 3', months: 6 }));
  const r = E.calculate(p, D);
  const p3 = r.phases.find(x => x.id === 'p3');
  assert.equal(p3.totals.total, 0); assert.equal(p3.financing.loan, 0);
  const u = quick(); u.components[0].typeId = 'nope';
  assert.ok(E.calculate(u, D).warnings.some(w => w.code === 'unknown-type'));
  const reg = E.calculate(quick({ region: 'ZZ-Nowhere' }), D);
  assert.ok(reg.warnings.some(w => w.code === 'region'));
  assert.equal(reg.region.key, 'US');
  const st = quick(); st.overrides = { 'gone:div:01': { amount: 5 } };
  assert.ok(E.calculate(st, D).warnings.some(w => w.code === 'stale-overrides'));
  assert.equal(E.calculate(null, { }).error, 'no research data');
});

test('custom builder: a project assembled only from blocks', () => {
  const p = E.newProject(D, {}); p.phases[0].financing.enabled = false;
  p.components = [E.newComponent(D, 'custom', { id: 'k', size: 1, blocks: [
    { id: 'b1', itemId: 'pool-residential-amenity', qty: 2 },
    { id: 'b2', itemId: 'site-development-light', qty: 3.5 },
    { id: 'b3', itemId: 'my-thing', unitCost: 1000, qty: 7, name: 'Hand-priced item' }] })];
  const r = E.calculate(p, D);
  const hard = r.lines.filter(l => l.category === 'hard');
  near(hard.reduce((s, l) => s + l.amount, 0), 800000 + 1050000 + 7000, 0.01);
  assert.equal(r.lines.find(l => l.key === 'k:block:b3').source.kind, 'user');
});

test('range check flags a component outside the researched range', () => {
  const p = quick(); p.components[0].baseline = { price: 900000, basis: 'national' };
  const r = E.calculate(p, D);
  assert.equal(r.components[0].range.status, 'above');
  assert.ok(r.warnings.some(w => w.code === 'range'));
  assert.equal(E.calculate(quick(), D).components[0].range.status, 'within');
});

test('scenarios and sensitivity', () => {
  const p = mixed();
  p.scenarios = [{ id: 's1', name: 'Premium', patch: { components: [{ id: 'res', quality: 'premium' }] } }];
  const rows = E.compareScenarios(p, D);
  assert.equal(rows.length, 2); assert.ok(rows[1].delta > 0);
  const s = E.sensitivity(p, D);
  assert.ok(s.drivers.length >= 5);
  s.drivers.forEach(d => assert.ok(Number.isFinite(d.low) && Number.isFinite(d.high), d.id));
  const b = s.drivers.find(d => d.id === 'baseline');
  assert.ok(b.lowDelta < 0 && b.highDelta > 0);
});

test('fsdoc export sheets validate against fs-render', () => {
  const fr = require('../api/shared/fs-render/src');
  const p = mixed(); const r = E.calculate(p, D);
  const fsdoc = { fsdoc: '1', meta: { title: 'Test', eyebrow: 'X', subline: '', rightLines: [], bandLine: 'x', footnote: '', footerRight: '' },
    sheets: E.toFsdocSheets(r, p, D) };
  const v = fr.validate(fsdoc);
  assert.ok(v.ok !== false && !(v.errors && v.errors.length), JSON.stringify(v.errors || v));
  assert.deepEqual(fsdoc.sheets.map(s => s.key), ['engine-summary', 'engine-components', 'engine-phases', 'engine-detail', 'engine-draws', 'engine-sources']);
});

test('pro forma handoff: from-budget reads the engine scope for engine budgets', () => {
  const fb = require('../api/shared/investment/from-budget');
  const p = mixed(); const r = E.calculate(p, D);
  p.components[0].revenue = { mode: 'perUnitMonth', rate: 1500, vacancy: 0.06, expenseRatio: 0.38 };
  const r2 = E.calculate(p, D);
  const doc = Object.assign({ name: 'Station', address: 'x', units: [], other: [], expenses: [] }, E.toBudgetDoc(r2, p));
  const v = { Id: 1, VersionNumber: 1, Name: 'Station' };
  const whole = fb.projectFromBudget(doc, v, { projectId: 'BD-0001' });
  assert.equal(whole.imported.acquisition.basis.value, Math.round(r2.totals.total * 100) / 100);
  assert.deepEqual(whole.scope, { kind: 'project', id: 'project' });
  const comp = fb.projectFromBudget(doc, v, { projectId: 'BD-0001', scope: { kind: 'component', id: 'res' } });
  const rc = r2.components.find(c => c.id === 'res');
  near(comp.imported.acquisition.basis.value, rc.totals.total, 0.01);
  near(comp.imported.income.year1PotentialIncome, 200 * 1500 * 12, 0.01);
  assert.equal(comp.imported.vacancy, 0.06);
  assert.equal(comp.imported.expenses.value, 0.38);
  assert.equal(comp.imported.property.unitCount, 200);
  assert.match(comp.imported.property.name, /— /);
  const ph = fb.projectFromBudget(doc, v, { projectId: 'BD-0001', scope: { kind: 'phase', id: 'p2' } });
  near(ph.imported.acquisition.basis.value, r2.phases.find(x => x.id === 'p2').totals.total, 0.01);
  // A hostile or unknown scope falls back to the whole project.
  assert.deepEqual(fb.projectFromBudget(doc, v, { scope: { kind: 'phase', id: '<x>' } }).scope, { kind: 'project', id: 'project' });
  assert.deepEqual(fb.projectFromBudget(doc, v, { scope: { kind: 'component', id: 'nope' } }).scope, { kind: 'project', id: 'project' });
  // A classic budget still projects exactly as before (no scope).
  assert.equal(fb.projectFromBudget({ units: [], lines: [], other: [], expenses: [] }, v, {}).scope, null);
  void r;
});
