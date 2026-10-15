// Pure-logic tests for the save-versioning primitives: canonical JSON, content
// hashing, and the SOV projection. No browser and no database — these are the
// only parts of the versioning path that can be tested in isolation, so they
// use node:test rather than the Playwright harness.
//
//   node --test test/canonical.test.js       (or ./test/run-all.sh, which includes it)
const test = require('node:test');
const assert = require('node:assert');

const { canonical, contentHash, contentEquals, parseDoc } = require('../api/shared/canonical');
const { sovRows, qtyOf } = require('../api/shared/sov');

test('canonical output is independent of key insertion order', () => {
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
});

test('canonical sorts nested object keys too', () => {
  const x = { outer: { z: 1, a: { n: 2, m: 3 } } };
  const y = { outer: { a: { m: 3, n: 2 }, z: 1 } };
  assert.equal(canonical(x), canonical(y));
});

test('array order is content, not noise', () => {
  assert.notEqual(canonical({ l: [1, 2] }), canonical({ l: [2, 1] }));
});

test('the volatile `updated` timestamp is excluded from identity', () => {
  const a = { projectId: 'BD-0001', updated: '2026-08-12T00:00:00.000Z', resSF: 1 };
  const b = { projectId: 'BD-0001', updated: '2026-08-13T09:99:99.999Z', resSF: 1 };
  assert.equal(contentHash(a), contentHash(b), 'a re-save that only restamps `updated` must not create a version');
  assert.ok(contentEquals(a, b));
});

test('`created` is NOT volatile — it is part of the document', () => {
  const a = { created: '2026-01-01T00:00:00.000Z' };
  const b = { created: '2026-02-02T00:00:00.000Z' };
  assert.notEqual(contentHash(a), contentHash(b));
});

test('a real edit changes the hash', () => {
  const base = { resSF: 51365, lines: [{ code: '03 30 00', unit: 5.25 }] };
  const edit = { resSF: 51365, lines: [{ code: '03 30 00', unit: 6.00 }] };
  assert.notEqual(contentHash(base), contentHash(edit));
  assert.ok(!contentEquals(base, edit));
});

test('contentHash is a 64-character lowercase hex SHA-256', () => {
  assert.match(contentHash({ x: 1 }), /^[0-9a-f]{64}$/);
});

test('undefined-valued keys and absent keys canonicalize alike', () => {
  assert.equal(canonical({ a: 1, b: undefined }), canonical({ a: 1 }));
});

test('parseDoc tolerates malformed stored documents', () => {
  assert.deepEqual(parseDoc('{"a":1}'), { a: 1 });
  assert.equal(parseDoc('not json'), null);
  assert.equal(parseDoc(null), null);
});

// ---- SOV projection ----
const doc = {
  resSF: 1000, amenSF: 200,
  units: [{ count: 10 }, { count: 5 }],
  lines: [
    { lineId: 'a', code: '03 30 00', grp: 'Shell', scope: 'res', desc: 'Slab', basis: 'sf', unit: 5 },
    { lineId: 'b', code: '09 60 00', grp: 'Amenity', scope: 'amen', desc: 'Flooring', basis: 'asf', unit: 4 },
    { lineId: 'c', code: '11 31 00', grp: 'Interiors', scope: 'res', desc: 'Appliances', basis: 'unit', unit: 100 },
    { lineId: 'd', code: '99 03 00', grp: 'Markups', scope: 'res', desc: 'Lump', basis: 'ls', unit: 250 }
  ]
};

test('quantity basis follows the frontend rules', () => {
  const r = sovRows(doc);
  assert.equal(r[0].qty, 1000, 'sf uses residential SF');
  assert.equal(r[1].qty, 200, 'asf uses amenity SF');
  assert.equal(r[2].qty, 15, 'unit uses the total unit count');
  assert.equal(r[3].qty, 1, 'lump sum is quantity 1');
});

test('a manual quantity override wins over the basis', () => {
  assert.equal(qtyOf({ auto: false, qty: 7, basis: 'sf' }, doc, 15), 7);
});

test('totals are quantity times rate', () => {
  const r = sovRows(doc);
  assert.equal(r[0].total, 5000);
  assert.equal(r[2].total, 1500);
  assert.equal(r[3].total, 250);
});

test('LineOrder is 1-based document order', () => {
  assert.deepEqual(sovRows(doc).map(r => r.lineOrder), [1, 2, 3, 4]);
});

test('duplicate or missing lineIds fall back to a null LineKey', () => {
  // The filtered unique index on (ProjectId, LineKey) must never fail a save.
  const dup = { lines: [{ lineId: 'x', basis: 'ls' }, { lineId: 'x', basis: 'ls' }, { basis: 'ls' }] };
  const keys = sovRows(dup).map(r => r.lineKey);
  assert.deepEqual(keys, ['x', null, null]);
});

test('an empty document projects to no rows', () => {
  assert.deepEqual(sovRows({}), []);
});

// ---- inactive scopes: amenity suppression is arithmetic, not filtering ----
const noAmen = {
  resSF: 1000, amenSF: 0,
  units: [{ count: 10 }],
  lines: [
    { lineId: 'r', code: '03 30 00', grp: 'Shell', scope: 'res', desc: 'Slab', basis: 'sf', unit: 5, auto: true },
    { lineId: 'a1', code: '09 60 00', grp: 'Amenity', scope: 'amen', desc: 'Flooring', basis: 'asf', unit: 4, auto: true },
    { lineId: 'a2', code: '13 11 00', grp: 'Amenity', scope: 'amen', desc: 'Pool', basis: 'ls', unit: 250000, qty: 1, auto: false },
    { lineId: 'a3', code: '12 50 00', grp: 'Amenity', scope: 'amen', desc: 'Furniture', basis: 'asf', unit: 3, qty: 900, auto: false },
    { lineId: 's', code: 'SC-01', grp: 'Soft', scope: 'soft', desc: 'Architect', basis: 'sf', unit: 2, auto: true }
  ]
};

test('an inactive amenity scope keeps its rows but contributes nothing', () => {
  // The lump-sum and manual-quantity lines are the ones that matter: they do
  // not follow amenSF to zero on their own, so before this rule they wrote a
  // real Total into dbo.SovLines that ContractSum excluded.
  const r = sovRows(noAmen);
  assert.equal(r.length, 5, 'rows are kept, so LineOrder/LineKey identity survives');
  assert.deepEqual(r.map(x => x.lineKey), ['r', 'a1', 'a2', 'a3', 's']);
  assert.deepEqual(r.map(x => x.lineOrder), [1, 2, 3, 4, 5]);
  for (const x of r.filter(x => x.scope === 'amen')) {
    assert.equal(x.qty, 0, x.descr + ' quantity');
    assert.equal(x.total, 0, x.descr + ' total');
  }
  assert.equal(r[2].rate, 250000, 'the rate is still the rate; only the quantity is suppressed');
  assert.equal(r[0].total, 5000);
  assert.equal(r[4].total, 2000);
});

test('turning the amenity scope back on restores the amenity rows', () => {
  const r = sovRows({ ...noAmen, amenSF: 500 });
  assert.equal(r[1].qty, 500);
  assert.equal(r[2].total, 250000);
  assert.equal(r[3].total, 2700);
});

test('SOV rows add up to the scope sums the contract sum is built from', () => {
  const calc = require('../api/shared/budget-calc');
  for (const d of [noAmen, { ...noAmen, amenSF: 500 }]) {
    const rows = sovRows(d);
    for (const sc of ['res', 'amen', 'soft']) {
      const fromRows = rows.filter(x => x.scope === sc).reduce((s, x) => s + x.total, 0);
      assert.equal(fromRows, calc.scopeSum(d, sc), sc + ' at amenSF ' + d.amenSF);
    }
  }
});
