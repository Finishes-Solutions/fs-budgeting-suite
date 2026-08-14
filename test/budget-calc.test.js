// Parity tests for api/shared/budget-calc.js — the server-side port of the
// browser's CALC block. Expected values are computed by hand from the same
// formulas the frontend applies; suite-09 additionally compares this module
// against the live page's parts()/grossIncome() on a real document.
const { test } = require('node:test');
const assert = require('node:assert');
const { nz, totUnits, lineQty, scopeSum, scopeActive, parts, grossIncome } =
  require('../api/shared/budget-calc');

// A small but complete document exercising every arithmetic branch.
const baseDoc = () => ({
  projectId: 'TST-0001',
  resSF: 100000, amenSF: 5000, siteSF: 200000,
  units: [
    { label: '1BR', count: 40, sf: 700, rent: 1200 },
    { label: '2BR', count: 10, sf: 1000, rent: 1600 }
  ],
  lines: [
    // auto sf: qty = resSF = 100000 → 100000 × 2.50 = 250,000
    { scope: 'res',  grp: 'G', code: '09 29 00', desc: 'Drywall', basis: 'sf',   auto: true,  qty: 0,  unit: 2.50 },
    // auto unit: qty = 50 units → 50 × 800 = 40,000
    { scope: 'res',  grp: 'G', code: '10 28 00', desc: 'Accessories', basis: 'unit', auto: true, qty: 0, unit: 800 },
    // manual qty beats basis: 12 × 100 = 1,200
    { scope: 'res',  grp: 'G', code: '12 21 00', desc: 'Blinds', basis: 'unit', auto: false, qty: 12, unit: 100 },
    // amenity, auto asf: 5000 × 4 = 20,000
    { scope: 'amen', grp: 'G', code: '09 68 00', desc: 'Carpet', basis: 'asf',  auto: true,  qty: 0,  unit: 4 },
    // amenity lump-sum (basis 'ls' falls through to qty 1): 15,000
    { scope: 'amen', grp: 'G', code: '11 40 00', desc: 'Kitchen', basis: 'ls',  auto: true,  qty: 0,  unit: 15000 },
    // soft costs: 25,000
    { scope: 'soft', grp: 'Eng', code: 'SC-01', desc: 'Civil', basis: 'ls', auto: true, qty: 0, unit: 25000 }
  ],
  companies: [ { name: 'A', pct: 5 }, { name: 'B', pct: 2.5 } ],
  contingency: { mode: 'pct', val: 2 },
  projectCosts: { land: 1200000, dev: 200000, mkt: 75000, cls: 25000 },
  other: [ { label: 'Parking', rate: 25, auto: true, count: 0 },
           { label: 'Storage', rate: 40, auto: false, count: 10 } ],
  expenses: [ { label: 'Trash', per: 'unit', rate: 12, auto: true, count: 0 },
              { label: 'Internet', per: 'fixed', rate: 500, auto: false, count: 2 } ]
});

// Hand-computed: res = 250000+40000+1200 = 291200; amen = 20000+15000 = 35000
// hard = 326200; profit = 326200×7.5% = 24465; cont = 326200×2% = 6524
// contract = 357189; soft = 25000; fees = 300000; project = 357189+25000+1200000+300000 = 1882189

test('parts: every component on the base document', () => {
  const p = parts(baseDoc());
  assert.equal(p.res, 291200);
  assert.equal(p.amen, 35000);
  assert.equal(p.hard, 326200);
  assert.equal(Math.round(p.profit * 100) / 100, 24465);
  assert.equal(Math.round(p.cont * 100) / 100, 6524);
  assert.equal(Math.round(p.contract * 100) / 100, 357189);
  assert.equal(p.soft, 25000);
  assert.equal(p.fees, 300000);
  assert.equal(Math.round(p.project * 100) / 100, 1882189);
});

test('amenity suppression is arithmetic: amenSF=0 removes amenity money everywhere', () => {
  const d = baseDoc(); d.amenSF = 0;
  const p = parts(d);
  assert.equal(p.amen, 0, 'lump-sum and manual amenity lines must stop contributing');
  assert.equal(p.hard, 291200);
  // profit and contingency shrink with hard cost
  assert.equal(Math.round(p.profit * 100) / 100, 21840);
  assert.equal(Math.round(p.cont * 100) / 100, 5824);
  assert.ok(scopeActive(d, 'res') && !scopeActive(d, 'amen'));
});

test('contingency modes: psf and fixed', () => {
  const d1 = baseDoc(); d1.contingency = { mode: 'psf', val: 2 };
  assert.equal(parts(d1).cont, (100000 + 5000) * 2);
  const d2 = baseDoc(); d2.contingency = { mode: 'fixed', val: 50000 };
  assert.equal(parts(d2).cont, 50000);
});

test('lineQty basis routing and manual override', () => {
  const d = baseDoc();
  assert.equal(lineQty(d, { auto: true, basis: 'sf' }), 100000);
  assert.equal(lineQty(d, { auto: true, basis: 'asf' }), 5000);
  assert.equal(lineQty(d, { auto: true, basis: 'unit' }), 50);
  assert.equal(lineQty(d, { auto: true, basis: 'ls' }), 1);
  assert.equal(lineQty(d, { auto: false, basis: 'sf', qty: 7 }), 7);
});

test('grossIncome: rent, other (auto and manual), fixed and per-unit expenses', () => {
  const g = grossIncome(baseDoc());
  assert.equal(g.rentMo, 40 * 1200 + 10 * 1600);       // 64,000
  assert.equal(g.otherMo, 25 * 50 + 40 * 10);          // 1,650
  assert.equal(g.expMo, 12 * 50 + 500 * 2);            // 1,600
  assert.equal(g.netOtherMo, 50);
  assert.equal(g.grossYr, 12 * (64000 + 1650));
  assert.equal(g.netYr, 12 * (64000 + 50));
});

test('absent properties coerce to zero, never NaN (old documents)', () => {
  const p = parts({ projectId: 'TST-0002' });
  for (const k of Object.keys(p)) assert.ok(Number.isFinite(p[k]), k + ' must be finite');
  const g = grossIncome({ projectId: 'TST-0002' });
  for (const k of Object.keys(g)) assert.ok(Number.isFinite(g[k]), k + ' must be finite');
  assert.equal(totUnits({}), 0);
  assert.equal(scopeSum({ lines: [{ scope: 'res', auto: false, unit: 10 }] }, 'res'), 0);
  assert.equal(nz('abc'), 0);
  assert.equal(nz('12.5'), 12.5);
});
