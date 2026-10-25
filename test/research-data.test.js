// The shipped research bundle (app/research-data.js) against the engine:
// fresh, complete, internally consistent, and every project type prices
// inside its own researched range.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { build, render } = require('../tools/build-research-data');
const { check } = require('../tools/validate-research');
const E = require('../app/budget-engine.js');
const D = require('../app/research-data.js');
const catalog = require('../data/research/catalog.json');

const ROOT = path.join(__dirname, '..', 'data', 'research');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(x =>
  x.isDirectory() ? walk(path.join(d, x.name)) : x.name.endsWith('.json') && !['catalog.json', 'units.json'].includes(x.name) ? [path.join(d, x.name)] : []);

test('app/research-data.js is rebuilt from data/research (not stale)', () => {
  const { bundle, errors } = build();
  assert.deepEqual(errors, []);
  const cur = fs.readFileSync(path.join(__dirname, '..', 'app', 'research-data.js'), 'utf8');
  assert.ok(cur === render(bundle), 'stale bundle — run node tools/build-research-data.js');
});

test('every research file passes the schema check', () => {
  const bad = walk(ROOT).map(f => [f, check(f).errors]).filter(x => x[1].length);
  assert.deepEqual(bad, []);
});

test('every catalog type has research, and nothing is missing from the bundle', () => {
  assert.deepEqual(D.missingTypes, []);
  catalog.types.forEach(t => assert.ok(D.types[t.id], t.id));
  assert.ok(Object.keys(D.types).length >= 90);
});

test('indices are present: escalation series and forecast, regional factors for every state', () => {
  const esc = D.indices.escalation;
  assert.ok(esc && esc.series['2026'] && esc.series['2015']);
  assert.ok(Object.keys(esc.forecast).length >= 3);
  const f = D.indices.regional.factors;
  const states = Object.keys(f).filter(k => /^[A-Z]{2}$/.test(k) && k !== 'US');
  assert.ok(states.length >= 51, 'states + DC: ' + states.length);
});

test('every type template splits 100% of its baseline across CSI divisions', () => {
  Object.values(D.types).forEach(t => {
    const s = t.systemSplit.lines.reduce((a, l) => a + l.pct, 0);
    assert.ok(Math.abs(s - 1) < 0.0005, t.id + ' split sums to ' + s);
  });
});

test('every evidence item names a real-looking source', () => {
  Object.values(D.evidence).forEach(e => {
    assert.match(e.url, /^https?:\/\//, e.id);
    assert.ok(e.title && e.publisher && e.quote, e.id);
    assert.ok(['high', 'medium', 'low'].includes(e.confidence), e.id);
  });
});

test('quick mode at typical size reproduces baseline price × size exactly (national, no escalation)', () => {
  Object.values(D.types).filter(t => t.id !== 'custom').forEach(t => {
    const p = E.newProject(D, { typeId: t.id });
    p.phases[0].financing.enabled = false;
    const r = E.calculate(p, D);
    const c = r.components[0];
    const baseline = r.lines.filter(l => l.comp === c.id && l.category === 'hard'
      && (/:div:/.test(l.key) || (l.carveOut && /:item:/.test(l.key)))).reduce((s, l) => s + l.amount, 0);
    const q = t.qualityTiers ? t.qualityTiers.standard : 1;
    const expect = t.hardCost.perPrimaryUnit.mid * c.size * q;
    assert.ok(Math.abs(baseline - expect) <= Math.max(0.05, expect * 1e-9), t.id + ': ' + baseline + ' vs ' + expect);
  });
});

test('every project type produces a budget within its researched range check', () => {
  const out = [];
  Object.values(D.types).filter(t => t.rangeCheck && t.id !== 'custom').forEach(t => {
    const r = E.calculate(E.newProject(D, { typeId: t.id, startMonth: '2027-01' }), D);
    const rg = r.components[0].range;
    if (!rg || rg.status !== 'within') out.push(t.id + ' ' + (rg ? rg.status + ' ' + Math.round(rg.value) + ' [' + rg.min + '–' + rg.max + ']' : 'no range'));
  });
  assert.deepEqual(out, []);
});

test('every type prices finitely at zero, small, and huge sizes and in every quality tier', () => {
  Object.values(D.types).forEach(t => {
    [0, 1, 1e6].forEach(size => {
      const r = E.calculate(E.newProject(D, { typeId: t.id, size, startMonth: '2027-06', region: 'CA' }), D);
      assert.ok(Number.isFinite(r.totals.total) && r.totals.total >= 0, t.id + ' @' + size);
    });
    E.QUALITY_TIERS.forEach(q => {
      const p = E.newProject(D, { typeId: t.id }); p.components[0].quality = q;
      assert.ok(Number.isFinite(E.calculate(p, D).totals.total), t.id + ' ' + q);
    });
  });
});

test('materialized into a budget document, every type ties out to the cent and can be saved', () => {
  const calc = require('../api/shared/budget-calc');
  const rules = require('../api/shared/budget-save-rules');
  const ids = require('../api/shared/identifiers');
  Object.values(D.types).filter(t => t.id !== 'custom').forEach(t => {
    const p = E.newProject(D, { typeId: t.id, startMonth: '2027-01' });
    p.land = { mode: 'amount', value: 1000000 };
    const r = E.calculate(p, D);
    const doc = Object.assign({ units: [], other: [], expenses: [], engine: p }, E.toBudgetDoc(r, p));
    assert.equal(Math.round(calc.parts(doc).project * 100), Math.round(r.totals.total * 100), t.id);
    assert.ok(doc.resSF > 0 || rules.engineSized(doc), t.id + ' sized');
    assert.equal(ids.budgetIdentifierProblem(doc), null, t.id);
  });
});
