// sql/publish_multifamily_input_defaults.sql, proved through its JavaScript
// mirror (tools/input-driven-defaults.js). Nothing here can run T-SQL, so the
// mirror carries the transformation and test/fixtures/input-defaults/ carries
// what SQL Server itself produced on the same seed, which pins the two together.
//
// What the publish must guarantee:
//   (a) the template's own default totals do not move
//   (b) with Amenity SF at 0 the pool is gone
//   (c) the per-unit lines follow the unit count
//   (d) the published data uses only scopes and bases the DEPLOYED code knows
// plus the safety property the description change exists for: an existing
// budget repriced against the new library never takes a per-unit rate onto a
// per-SF line.
const { test } = require('node:test');
const assert = require('node:assert');
const calc = require('../api/shared/budget-calc');
const G = require('../api/shared/guardrails');
const { sovRows } = require('../api/shared/sov');
const M = require('../tools/input-driven-defaults');
const pricing = require('./pricing.json');
const sqlOut = require('./fixtures/input-defaults/sql-server-output.json');

// The multifamily template exactly as sql/migrate_budget_history_and_templates.sql
// seeds it (lines from the pricing library: qty 1 / auto false for lump sums,
// else qty 0 / auto true; baseUnit = the library rate), with the expense
// schedule sql/publish_multifamily_opex_template.sql added on top.
function seedTemplate() {
  return {
    templateSchemaVersion: 1, name: 'Multifamily', type: 'Multifamily',
    resSF: 51365, amenSF: 1200, siteSF: 0,
    units: [
      { label: 'Studio (630)', bd: 0, bth: 1, sf: 630, count: 16, rent: 1203 },
      { label: 'Studio (400)', bd: 0, bth: 1, sf: 400, count: 14, rent: 1160 },
      { label: 'Townhome (1,063)', bd: 2, bth: 2, sf: 1063, count: 14, rent: 1520 },
      { label: 'Townhome (1,200)', bd: 2, bth: 2.5, sf: 1200, count: 14, rent: 1500 }],
    other: [{ label: 'Utilities billback', rate: 77, count: 0, auto: true }],
    expenses: [
      { label: 'Property Taxes', per: 'pctIncome', rate: 12, count: 0, auto: false },
      { label: 'Property Insurance', per: 'unit', rate: 65, count: 0, auto: true }],
    lines: pricing.lines.map((l, i) => ({
      lineId: 'tpl-' + i, code: l.code, grp: l.grp, scope: l.scope, desc: l.desc, basis: l.basis,
      unit: l.unit, baseUnit: l.unit, qty: l.basis === 'ls' ? 1 : 0, auto: l.basis !== 'ls' })),
    companies: [{ name: 'Finishes Solutions LLC', pct: 12 }],
    contingency: { mode: 'psf', val: 2 },
    projectCosts: { land: 1200000, dev: 200000, mkt: 75000, cls: 0 },
    status: 'Draft', pricingVersion: pricing.version, opexSchemaVersion: 2
  };
}
const run = (tpl = seedTemplate(), lib = pricing) =>
  M.transform({ pricing: lib, template: tpl, newPricingVersion: '2026.10-v1', effective: '2026-10-15' });
const libKey = l => l.scope + '|' + l.code + '|' + l.desc;
const byNewDesc = (doc, desc) => doc.lines.find(l => l.desc === desc);
const rails = d => {
  const p = calc.parts(d);
  return G.evaluate({ doc: d, parts: p, gross: calc.grossIncome(d), fee: p.fee });
};

// The app's two rate-refresh paths, reduced to what they do to a line — see
// stampCurrentPricing() and repriceBudget() in app/index.html. Neither copies
// the library line's BASIS, which is the whole reason the per-unit lines get
// a new description.
function stampCurrentPricing(d, lib) {
  const map = {}; lib.lines.forEach(l => { map[libKey(l)] = l; });
  d.lines.forEach(it => {
    const m = map[libKey(it)]; if (!m) return;
    if (calc.nz(it.unit) === calc.nz(it.baseUnit)) it.unit = m.unit;
    it.baseUnit = m.unit;
  });
  d.pricingVersion = lib.version; return d;
}
function repriceBudget(d, lib) {
  const map = {}; lib.lines.forEach(l => { map[libKey(l)] = l; });
  d.lines.forEach(it => { const m = map[libKey(it)]; if (!m) return; it.unit = m.unit; it.baseUnit = m.unit; });
  d.pricingVersion = lib.version; return d;
}

test('the mirror reproduces what SQL Server published from the seed template', () => {
  const r = run();
  assert.equal(r.pricing.version, sqlOut.pricing.version);
  assert.equal(r.pricing.lines.length, sqlOut.pricing.lineCount);
  for (const { index, line } of sqlOut.pricing.lines) assert.deepStrictEqual(r.pricing.lines[index], line);
  assert.equal(r.template.lines.length, sqlOut.template.lineCount);
  for (const { index, line } of sqlOut.template.lines) {
    const { lineId, ...rest } = r.template.lines[index];
    assert.deepStrictEqual(rest, line, 'template line ' + index);
  }
  assert.deepStrictEqual(r.template.projectCosts, sqlOut.template.projectCosts);
  assert.equal(r.template.pricingVersion, sqlOut.template.pricingVersion);
});

test('rates are back-solved from the template\'s own size (51,365 SF) and unit count (58)', () => {
  const r = run();
  const expect = {
    'Residential Appliances (per Unit)': 3081.90,             // 3.48 x 51365 / 58
    'Casework / Stock Cabinets (per Unit)': 1780.06,          // 2.01 x 51365 / 58 = 1780.0629
    'Countertops (per Unit)': 1000.73,
    'Interior Doors & Frames (per Unit)': 1160.14,
    'Interior Door Hardware (per Unit)': 177.12,
    'Mirrors (per Unit)': 256.83,                             // 256.825 exactly: half rounds UP
    'Toilet, Bath & Laundry Accessories (per Unit)': 549.07,
    'Window Blinds (per Unit)': 292.25,
    'Mailboxes (per Unit)': 221.40
  };
  for (const [desc, rate] of Object.entries(expect)) {
    for (const doc of [r.pricing, r.template]) {
      const l = byNewDesc(doc, desc);
      assert.equal(l.basis, 'unit', desc);
      assert.equal(l.scope, 'res', desc);
      assert.equal(l.unit, rate, desc);
    }
    assert.equal(byNewDesc(r.template, desc).baseUnit, rate, desc + ' baseUnit');
    assert.equal(byNewDesc(r.template, desc).auto, true, desc + ' stays auto');
  }
  const pool = r.template.lines.find(l => l.code === '13 11 00');
  assert.deepStrictEqual(
    { scope: pool.scope, grp: pool.grp, basis: pool.basis, unit: pool.unit, baseUnit: pool.baseUnit, qty: pool.qty, auto: pool.auto },
    { scope: 'amen', grp: 'Amenity Site & Pool', basis: 'ls', unit: 165395.30, baseUnit: 165395.30, qty: 1, auto: false });
  assert.deepStrictEqual(r.template.projectCosts.dev, { mode: 'pct', val: 2.0046 });
  assert.equal(M.halfUpCents(25n, 10n), 3n, 'half rounds up');
  assert.equal(M.halfUpCents(24n, 10n), 2n);
});

test('(a) the template\'s default totals do not move', () => {
  const before = calc.parts(seedTemplate()), r = run(), after = calc.parts(r.template);
  assert.ok(Math.abs(after.contract - before.contract) < 1,
    `contract ${before.contract.toFixed(2)} -> ${after.contract.toFixed(2)}`);
  // The developer fee is a 4-place percentage of a ~$10M total: worth ~$1.39 here.
  assert.ok(Math.abs(after.project - before.project) < 5,
    `project ${before.project.toFixed(2)} -> ${after.project.toFixed(2)}`);
  assert.ok(Math.abs(after.fee.dev - 200000) < 5, 'the fee is still about $200k: ' + after.fee.dev);
  // No other line moved.
  const changed = new Set(M.TARGETS.map(t => t.newScope + '|' + t.code + '|' + t.newDesc));
  const old = new Map(seedTemplate().lines.map(l => [l.lineId, l]));
  for (const l of r.template.lines) if (!changed.has(libKey(l))) assert.deepStrictEqual(l, old.get(l.lineId));
});

test('(a) the guard rails reach the same verdicts', () => {
  const b = rails(seedTemplate()), a = rails(run().template);
  const ok = (res, id) => { const x = res.rails.find(y => y.id === id); return x ? x.ok : null; };
  assert.equal(ok(a, 'devFee'), ok(b, 'devFee'), 'devFee verdict unchanged');
  assert.equal(ok(a, 'devFee'), true, 'and inside 2-5%');
  assert.equal(ok(b, 'feeSum'), null, 'no percentage fee before: feeSum not judged');
  assert.equal(ok(a, 'feeSum'), true, 'feeSum judged now, and passes');
  assert.equal(a.blocking, b.blocking);
});

test('(b) with Amenity SF at 0 the pool is gone', () => {
  const oldNoAmen = { ...seedTemplate(), amenSF: 0 };
  const newNoAmen = { ...run().template, amenSF: 0 };
  const o = calc.parts(oldNoAmen), n = calc.parts(newNoAmen);
  assert.equal(n.amen, 0);
  // The old template kept ~$165k of pool in the residential scope at 0 SF.
  assert.ok(Math.abs((o.hard - n.hard) - 165395.30) < 1, `hard ${o.hard} -> ${n.hard}`);
  const poolRow = sovRows(newNoAmen).find(x => x.code === '13 11 00');
  assert.equal(poolRow.scope, 'amen');
  assert.equal(poolRow.total, 0, 'and the SOV row the lender package reads agrees');
  // With a clubhouse the pool is back, as a lump sum.
  assert.ok(Math.abs(calc.parts(run().template).amen - (calc.parts(seedTemplate()).amen + 165395.30)) < 0.01);
});

test('(c) the per-unit lines follow the unit count', () => {
  const dbl = d => ({ ...d, units: d.units.map(u => ({ ...u, count: u.count * 2 })) });
  const r = run();
  const oldRes = calc.scopeSum(seedTemplate(), 'res'), oldResDbl = calc.scopeSum(dbl(seedTemplate()), 'res');
  assert.equal(oldResDbl, oldRes, 'before: doubling the units changed nothing');
  const perUnit = r.template.lines.filter(l => l.basis === 'unit').reduce((s, l) => s + l.unit, 0);
  const newRes = calc.scopeSum(r.template, 'res'), newResDbl = calc.scopeSum(dbl(r.template), 'res');
  assert.ok(Math.abs((newResDbl - newRes) - perUnit * 58) < 0.01,
    `after: +${(newResDbl - newRes).toFixed(2)} for 58 more units`);
  assert.ok(newResDbl - newRes > 450000, 'about $8,520 of finishes per added unit');
});

test('(d) only scopes and bases the deployed code understands are published', () => {
  const r = run();
  for (const doc of [r.pricing, r.template]) {
    for (const l of doc.lines) {
      assert.ok(['res', 'amen', 'soft'].includes(l.scope), l.code + ' scope ' + l.scope);
      assert.ok(['sf', 'asf', 'unit', 'ls'].includes(l.basis), l.code + ' basis ' + l.basis);
    }
  }
  const dev = r.template.projectCosts.dev;
  assert.ok(dev.mode === 'pct' && Number.isFinite(dev.val));
  assert.deepStrictEqual(Object.keys(r.template).sort(), Object.keys(seedTemplate()).sort(), 'no new top-level fields');
});

test('a budget created from the new template is born on its rates', () => {
  const r = run();
  const born = stampCurrentPricing(JSON.parse(JSON.stringify(r.template)), r.pricing);
  assert.deepStrictEqual(born.lines, r.template.lines, 'every rate already matches the new library');
  assert.equal(born.pricingVersion, '2026.10-v1');
});

test('an EXISTING budget repriced against the new library keeps its per-SF lines', () => {
  // The load-bearing description change: repricing copies a rate, never a
  // basis, so a per-SF line must not find the per-unit library line.
  const existing = seedTemplate();
  const lib = run().pricing;
  const map = new Map(lib.lines.map(l => [libKey(l), l]));
  for (const l of existing.lines) {
    const m = map.get(libKey(l));
    if (m) assert.equal(m.basis, l.basis, 'a matched line never changes basis: ' + libKey(l));
  }
  const before = calc.parts(existing).contract;
  const after = calc.parts(repriceBudget(JSON.parse(JSON.stringify(existing)), lib)).contract;
  assert.equal(after, before, 'nothing else in the library moved, so the reprice is a no-op on money');
  const kept = repriceBudget(seedTemplate(), lib).lines.find(l => l.code === '11 31 00');
  assert.deepStrictEqual([kept.scope, kept.basis, kept.unit], ['res', 'sf', 3.48]);
});

test('the pool sits at the end of the amenity lines, in both documents', () => {
  const r = run();
  for (const doc of [r.pricing, r.template]) {
    const i = doc.lines.findIndex(l => l.code === '13 11 00');
    const lastAmen = doc.lines.map(l => l.scope).lastIndexOf('amen');
    assert.equal(i, lastAmen);
    assert.equal(doc.lines.length, 103);
  }
});

test('re-running on the published result is a no-op', () => {
  const r = run();
  assert.deepStrictEqual(M.transform({ pricing: r.pricing, template: r.template }), { alreadyDone: true });
  assert.equal(M.classify(r.pricing), 'new');
  assert.equal(M.classify(seedTemplate()), 'old');
});

test('it refuses, loudly, anything it did not expect', () => {
  const r = run();
  const refused = (code, fn) => assert.throws(fn, e => e instanceof M.RefusedError && e.code === code);
  refused(50062, () => run(seedTemplate(), r.pricing));                      // library new, template old
  refused(50062, () => run(r.template, pricing));                            // the reverse
  const missing = seedTemplate(); missing.lines = missing.lines.filter(l => l.desc !== 'Window Blinds');
  refused(50062, () => run(missing));
  const dup = seedTemplate(); dup.lines.push({ ...dup.lines.find(l => l.desc === 'Mailboxes'), lineId: 'x' });
  refused(50062, () => run(dup));
  const manual = seedTemplate(); Object.assign(manual.lines.find(l => l.desc === 'Residential Appliances'), { auto: false, qty: 40000 });
  refused(50064, () => run(manual));
  const odd = JSON.parse(JSON.stringify(pricing)); odd.lines.find(l => l.desc === 'Countertops').unit = 1.12345;
  refused(50064, () => run(seedTemplate(), odd));
  refused(50065, () => run({ ...seedTemplate(), resSF: 0 }));
  refused(50066, () => run({ ...seedTemplate(), units: [] }));
  refused(50067, () => run({ ...seedTemplate(), amenSF: 0 }));
});

test('inputs are never mutated', () => {
  const tpl = seedTemplate(), snapT = JSON.stringify(tpl), snapP = JSON.stringify(pricing);
  run(tpl);
  assert.equal(JSON.stringify(tpl), snapT);
  assert.equal(JSON.stringify(pricing), snapP);
});

test('a fee already on a percentage is left alone', () => {
  const t = seedTemplate(); t.projectCosts = { land: 1200000, dev: { mode: 'pct', val: 3 }, mkt: 75000, cls: 0 };
  const r = run(t);
  assert.equal(r.devPct, null);
  assert.deepStrictEqual(r.template.projectCosts.dev, { mode: 'pct', val: 3 });
});
