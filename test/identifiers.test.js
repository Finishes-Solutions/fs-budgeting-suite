// Row identifiers in stored documents (lineId, impact-fee rowId / feeId) are
// rendered into attributes, so the API refuses any that could carry markup.
// One rule, api/shared/identifiers.js, used by the budget PUT, the fee-schedule
// publish and test/mock-api.js.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const I = require('../api/shared/identifiers');

// api/pricing/index.js pulls in shared/db.js, which needs mssql — an api/
// dependency the root test harness does not install. validateScheduleDoc
// never touches the database, so a stub stands in for the pool.
const dbPath = require.resolve('../api/shared/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { getPool: async () => { throw new Error('no database in unit tests'); }, sql: {} } };
const { validateScheduleDoc } = require('../api/pricing/index.js');

const HOSTILE = 'x" autofocus onfocus="window.__xss=1" data-z="';

test('every id the app generates is a safe row id', () => {
  for (const id of ['3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f6a7b8', 'l-lq2w3e4r-ab12cd34',
                    'tpl-ab12cd34', 'm-4-250', 'm-1p5-50', 'road', 'man-1', 'a_b'])
    assert.ok(I.isSafeRowId(id), id);
});

test('markup, quotes, spaces, empty and over-long ids are not safe', () => {
  for (const id of [HOSTILE, "x');alert(1);('", 'a b', '<img>', 'a.b', '', 'x'.repeat(65), 5, null, {}])
    assert.ok(!I.isSafeRowId(id), JSON.stringify(id));
  assert.ok(I.isSafeRowId('x'.repeat(64)), '64 characters is SovLines.LineKey width and allowed');
});

test('budgetIdentifierProblem names the first bad path, and ignores absent ids', () => {
  const ok = { lines: [{ lineId: 'a-1' }, { code: 'no id yet' }, { lineId: '' }, { lineId: null }],
    impactFees: { meters: [{ rowId: 'm-4-250' }], manual: [{ rowId: 'l-x' }], extras: [{ feeId: 'road' }] } };
  assert.strictEqual(I.budgetIdentifierProblem(ok), null);
  assert.strictEqual(I.budgetIdentifierProblem({}), null, 'a document with no rows is fine');
  assert.strictEqual(I.budgetIdentifierProblem(null), null);

  assert.strictEqual(I.budgetIdentifierProblem({ lines: [{ lineId: 'a' }, { lineId: HOSTILE }] }),
    'lines[1].lineId');
  assert.strictEqual(I.budgetIdentifierProblem({ lines: [], impactFees: { meters: [{ rowId: HOSTILE }] } }),
    'impactFees.meters[0].rowId');
  assert.strictEqual(I.budgetIdentifierProblem({ impactFees: { manual: [{ rowId: "a');alert(1);('" }] } }),
    'impactFees.manual[0].rowId');
  assert.strictEqual(I.budgetIdentifierProblem({ impactFees: { extras: [{ feeId: '<b>' }] } }),
    'impactFees.extras[0].feeId');
  assert.strictEqual(I.budgetIdentifierProblem({ lines: [{ lineId: 42 }] }), 'lines[0].lineId',
    'a present id must be a string');
});

test('scheduleIdentifierProblem checks meters[].rowId and fees[].feeId', () => {
  assert.strictEqual(I.scheduleIdentifierProblem({ meters: [{ rowId: 'm-1-25' }], fees: [{ feeId: 'park' }] }), null);
  assert.strictEqual(I.scheduleIdentifierProblem({ meters: [{ rowId: HOSTILE }] }), 'meters[0].rowId');
  assert.strictEqual(I.scheduleIdentifierProblem({ meters: [], fees: [{ feeId: 'a b' }] }), 'fees[0].feeId');
});

const schedule = over => Object.assign({ scheduleKey: 'tx-test', name: 'Test City',
  meters: [{ rowId: 'm-1-25', edu: 1, meter: { low: 1, high: 2 } }],
  fees: [{ feeId: 'park', label: 'Park', basis: 'unit', amount: { low: 1, high: 2 } }] }, over);

test('validateScheduleDoc accepts a well-formed schedule', () => {
  assert.strictEqual(validateScheduleDoc(schedule()), null);
});

test('validateScheduleDoc refuses a hostile meter rowId', () => {
  const r = validateScheduleDoc(schedule({ meters: [{ rowId: HOSTILE, edu: 1 }] }));
  assert.match(String(r), /malformed identifier at meters\[0\]\.rowId/);
});

test('validateScheduleDoc refuses a hostile fee feeId', () => {
  const r = validateScheduleDoc(schedule({ fees: [{ feeId: "x');alert(1);('", label: 'Bad', basis: 'flat' }] }));
  assert.match(String(r), /malformed identifier at fees\[0\]\.feeId/);
});

test('the client carries the same pattern as the API', () => {
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const m = html.match(/const ROW_ID_RX=(\/.+?\/);/);
  assert.ok(m, 'ROW_ID_RX is declared in app/index.html');
  assert.strictEqual(m[1], String(I.ROW_ID_RX));
});
