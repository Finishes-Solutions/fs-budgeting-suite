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
// Basis-driven lines say auto: true. A line with NO auto field is a typed
// quantity (lineQty's rule, BUDGET-SYSTEM.md §3) — this fixture once leaned on
// sov.js's divergent `auto === false` test (D10). test/sov.test.js covers that.
const doc = {
  resSF: 1000, amenSF: 200,
  units: [{ count: 10 }, { count: 5 }],
  lines: [
    { lineId: 'a', code: '03 30 00', grp: 'Shell', scope: 'res', desc: 'Slab', basis: 'sf', auto: true, unit: 5 },
    { lineId: 'b', code: '09 60 00', grp: 'Amenity', scope: 'amen', desc: 'Flooring', basis: 'asf', auto: true, unit: 4 },
    { lineId: 'c', code: '11 31 00', grp: 'Interiors', scope: 'res', desc: 'Appliances', basis: 'unit', auto: true, unit: 100 },
    { lineId: 'd', code: '99 03 00', grp: 'Markups', scope: 'res', desc: 'Lump', basis: 'ls', auto: true, unit: 250 }
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
