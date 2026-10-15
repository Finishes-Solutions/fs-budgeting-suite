// The SOV projection (api/shared/sov.js) against the budget arithmetic it must
// agree with. dbo.SovLines is what the lender-package pipeline reads and
// ContractSum is saved beside it, so the invariant is exact:
//   Σ Total over res + amen = parts(doc).hard,  Σ Total over soft = parts(doc).soft.
// BUDGET-SYSTEM.md §4 (amenity suppression) and §16 D1 / D10.
const { test } = require('node:test');
const assert = require('node:assert');
const { sovRows, qtyOf } = require('../api/shared/sov');
const { parts, lineQty } = require('../api/shared/budget-calc');

const doc = (amenSF) => ({
  resSF: 10000, amenSF,
  units: [{ count: 10 }, { count: 5 }],
  lines: [
    { lineId: 'r1', scope: 'res', grp: 'G', code: '03 30 00', basis: 'sf', auto: true, unit: 5 },
    { lineId: 'r2', scope: 'res', grp: 'G', code: '11 31 00', basis: 'unit', auto: true, unit: 100 },
    { lineId: 'r3', scope: 'res', grp: 'G', code: '12 21 00', basis: 'unit', auto: false, qty: 7, unit: 40 },
    { lineId: 'a1', scope: 'amen', grp: 'A', code: '09 60 00', basis: 'asf', auto: true, unit: 4 },
    // The two shapes suppression exists for: neither follows amenSF to zero.
    { lineId: 'a2', scope: 'amen', grp: 'A', code: '11 40 00', basis: 'ls', auto: false, qty: 1, unit: 15000 },
    { lineId: 'a3', scope: 'amen', grp: 'A', code: '12 50 00', basis: 'unit', auto: false, qty: 3, unit: 900 },
    { lineId: 's1', scope: 'soft', grp: 'S', code: 'SC-01', basis: 'ls', auto: false, qty: 1, unit: 25000 },
    { lineId: 's2', scope: 'soft', grp: 'S', code: 'SC-20', basis: 'ls', auto: false, qty: 1, unit: 637944.36,
      derived: 'impactFees' }
  ]
});

const sum = (rows, scopes) => rows.filter(r => scopes.includes(r.scope)).reduce((s, r) => s + r.total, 0);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

for (const amenSF of [2000, 0]) {
  test(`SovLines totals equal parts() with amenity ${amenSF ? 'on' : 'off'}`, () => {
    const d = doc(amenSF), rows = sovRows(d), p = parts(d);
    close(sum(rows, ['res', 'amen']), p.hard, 'res + amen = hard');
    close(sum(rows, ['soft']), p.soft, 'soft = soft');
    close(sum(rows, ['amen']), p.amen, 'amen = amen');
  });
}

test('a suppressed amenity line keeps its row, at quantity and total 0', () => {
  const on = sovRows(doc(2000)), off = sovRows(doc(0));
  assert.equal(off.length, on.length, 'no row is dropped');
  assert.deepEqual(off.map(r => r.lineKey), on.map(r => r.lineKey), 'LineKey continuity');
  for (const code of ['09 60 00', '11 40 00', '12 50 00']) {
    const r = off.find(x => x.code === code);
    assert.equal(r.qty, 0, code + ' qty');
    assert.equal(r.total, 0, code + ' total');
    assert.equal(r.rate, on.find(x => x.code === code).rate, code + ' keeps its rate');
  }
  // the lump sum and typed quantity are live again the moment amenity SF is
  assert.equal(on.find(x => x.code === '11 40 00').total, 15000);
  assert.equal(on.find(x => x.code === '12 50 00').total, 2700);
});

test('a line with no auto field is a typed quantity, as lineQty() says (D10)', () => {
  const d = { resSF: 10000, amenSF: 0, units: [{ count: 4 }],
    lines: [{ scope: 'res', basis: 'sf', qty: 12, unit: 3 }, { scope: 'res', basis: 'unit', unit: 10 }] };
  const rows = sovRows(d);
  assert.equal(rows[0].qty, 12);
  assert.equal(rows[0].qty, lineQty(d, d.lines[0]));
  assert.equal(rows[1].qty, 0, 'absent auto and absent qty is 0, not the unit count');
  close(sum(rows, ['res', 'amen']), parts(d).hard, 'still equals hard');
});

test('string unit counts are numbers, not concatenated (D10)', () => {
  const d = { resSF: 0, amenSF: 0, units: [{ count: '10' }, { count: '5' }],
    lines: [{ scope: 'res', basis: 'unit', auto: true, unit: '100' }] };
  const r = sovRows(d)[0];
  assert.equal(r.qty, 15);
  assert.equal(r.rate, 100);
  assert.equal(r.total, 1500);
  close(r.total, parts(d).hard, 'equals hard');
});

test('qtyOf is lineQty, ignoring the old trailing units argument', () => {
  const d = doc(2000);
  for (const l of d.lines) assert.equal(qtyOf(l, d, 999), lineQty(d, l));
});
