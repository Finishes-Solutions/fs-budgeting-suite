// Parity tests for api/shared/budget-calc.js — the server-side port of the
// browser's CALC block. Expected values are computed by hand from the same
// formulas the frontend applies; suite-09 additionally compares this module
// against the live page's parts()/grossIncome() on a real document.
const { test } = require('node:test');
const assert = require('node:assert');
const { nz, totUnits, lineQty, scopeSum, scopeActive, parts, grossIncome, expenseMonthly } =
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
  // parts().fee is the resolved {dev,mkt,cls,pctRate} block, not a number;
  // pctRate is deliberately null when nothing is on a percentage.
  for (const k of Object.keys(p)) {
    if (k === 'fee') continue;
    assert.ok(Number.isFinite(p[k]), k + ' must be finite');
  }
  for (const k of ['dev', 'mkt', 'cls']) assert.ok(Number.isFinite(p.fee[k]), 'fee.' + k + ' must be finite');
  assert.equal(p.fee.pctRate, null);
  const g = grossIncome({ projectId: 'TST-0002' });
  for (const k of Object.keys(g)) assert.ok(Number.isFinite(g[k]), k + ' must be finite');
  assert.equal(totUnits({}), 0);
  assert.equal(scopeSum({ lines: [{ scope: 'res', auto: false, unit: 10 }] }, 'res'), 0);
  assert.equal(nz('abc'), 0);
  assert.equal(nz('12.5'), 12.5);
});

test('percentage fees resolve against the FINAL total project cost', () => {
  const base = { lines: [{ scope: 'res', basis: 'ls', auto: false, qty: 1, unit: 1000000 }],
                 companies: [], contingency: { mode: 'amt', val: 0 } };

  // A bare number is a pre-migration document and reads as dollars.
  const legacy = parts({ ...base, projectCosts: { land: 100000, dev: 200000, mkt: 75000, cls: 0 } });
  assert.equal(legacy.project, 1375000);
  assert.equal(legacy.fees, 275000);
  assert.equal(legacy.fee.pctRate, null);

  // 3% dev + 1% closing means 3% and 1% OF THE PRINTED TOTAL, not of a
  // smaller pre-fee base — the closed-form solve project = (base+fixed)/(1-f).
  const mixed = parts({ ...base,
    projectCosts: { land: 100000, dev: { mode: 'pct', val: 3 },
                    mkt: { mode: 'amt', val: 75000 }, cls: { mode: 'pct', val: 1 } } });
  assert.ok(Math.abs(mixed.fee.dev / mixed.project - 0.03) < 1e-12, 'dev fee is 3% of the total');
  assert.ok(Math.abs(mixed.fee.cls / mixed.project - 0.01) < 1e-12, 'closing is 1% of the total');
  assert.equal(mixed.fee.mkt, 75000);
  assert.ok(Math.abs((1000000 + 100000 + mixed.fees) - mixed.project) < 1e-6,
    'contract + soft + land + fees reconciles to the total');
  assert.ok(Math.abs(mixed.fee.pctRate - 0.04) < 1e-12);

  // Rates that sum past the floor still render a finite number; the feeSum
  // guard rail is what refuses the save.
  const absurd = parts({ ...base,
    projectCosts: { land: 0, dev: { mode: 'pct', val: 99 }, mkt: { mode: 'amt', val: 0 }, cls: { mode: 'amt', val: 0 } } });
  assert.ok(Number.isFinite(absurd.project), 'an over-100% fee rate must not print Infinity');
});

test('percent-of-income expenses are charged off rent + other income', () => {
  const doc = {
    units: [{ sf: 800, count: 10, rent: 1500 }],
    other: [{ rate: 50, count: 0, auto: true }],
    expenses: [{ per: 'pctIncome', rate: 4 }, { per: 'unit', rate: 60, auto: true }]
  };
  const g = grossIncome(doc);
  const incomeMo = 10 * 1500 + 10 * 50;      // 15,500
  assert.equal(g.rentMo, 15000);
  assert.equal(g.otherMo, 500);
  assert.equal(g.expMo, incomeMo * 0.04 + 10 * 60);
  assert.equal(expenseMonthly(doc, doc.expenses[0], incomeMo), incomeMo * 0.04);
  assert.equal(expenseMonthly(doc, doc.expenses[1], incomeMo), 600);
});
