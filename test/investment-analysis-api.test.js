// Drives the REAL api/investment-analysis handler against a fake pool, the
// way test/user-settings-api.test.js does for its endpoint. The browser suites
// talk to test/mock-api.js, so a fault in the real handler could never fail
// one: DELETE read `principal` before the `const` that declared it, threw a
// ReferenceError AFTER the soft-delete had already run, wrote no activity row
// and answered 500 — with every suite green.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const queries = [];
const activity = [];
const sqlStub = new Proxy({ MAX: -1 }, {
  get: (t, k) => (k in t ? t[k] : (n => ({ type: String(k), n })))
});
let nextResult = null;
const request = () => {
  const inputs = {};
  const rq = {
    input: (k, type, v) => { inputs[k] = v; return rq; },
    query: async (q) => { queries.push({ q: String(q).replace(/\s+/g, ' ').trim(), inputs });
                          return nextResult; }
  };
  return rq;
};
const poolStub = { request };
const stub = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, rel));
  const m = new Module(file, null);
  m.filename = file; m.loaded = true; m.exports = exports;
  require.cache[file] = m;
};
stub('../api/shared/db', { getPool: async () => poolStub, sql: sqlStub, isTransient: () => false });
stub('../api/shared/schema', { features: async () => ({}) });
stub('../api/shared/users', {
  recordActivity: async (pool, principal, ev, et, eid, detail) =>
    { activity.push({ principal, ev, et, eid, detail }); }
});

const handler = require('../api/investment-analysis');

const ID = '11111111-1111-1111-1111-111111111111';
const principalHeader = Buffer.from(JSON.stringify({
  identityProvider: 'aad', userId: 'u-1', userDetails: 'analyst@finishessolutions.com',
  userRoles: ['authenticated']
})).toString('base64');

test('DELETE soft-deletes, answers 204 and records who did it', async () => {
  queries.length = 0; activity.length = 0;
  nextResult = { recordset: [], recordsets: [
    [{ Name: 'Waller Phase I', ProjectId: 'BDG-0007-01', ProjectKey: 'OP-0007' }],
    [{ Found: 1 }]] };
  const ctx = { bindingData: { id: ID }, log: Object.assign(() => {}, { warn() {}, error() {} }) };
  await handler(ctx, { method: 'DELETE', query: {}, headers: { 'x-ms-client-principal': principalHeader } });
  assert.strictEqual(ctx.res.status, 204);
  assert.ok(queries.some(x => /UPDATE dbo\.InvestmentAnalyses SET IsDeleted = 1/.test(x.q)),
    'the soft delete ran');
  assert.strictEqual(activity.length, 1, 'one activity row');
  assert.strictEqual(activity[0].ev, 'analysis_delete');
  assert.strictEqual(activity[0].eid, ID);
  assert.strictEqual(activity[0].principal.userId, 'u-1');
  assert.deepStrictEqual(activity[0].detail,
    { name: 'Waller Phase I', budgetId: 'BDG-0007-01', projectKey: 'OP-0007' });
});

test('DELETE of an unknown analysis is a 404 and logs nothing', async () => {
  activity.length = 0;
  nextResult = { recordset: [], recordsets: [[], [{ Found: 0 }]] };
  const ctx = { bindingData: { id: ID }, log: Object.assign(() => {}, { warn() {}, error() {} }) };
  await handler(ctx, { method: 'DELETE', query: {}, headers: {} });
  assert.strictEqual(ctx.res.status, 404);
  assert.strictEqual(activity.length, 0);
});
