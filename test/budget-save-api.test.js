// Drives the REAL api/budget PUT path against a fake pool, for the refusals
// that decide from the STORED row rather than the submitted document:
//   - a Budget ID changed on an existing budget (D13)
//   - the guard-rail table chosen by a trusted type, never doc.guardrails /
//     doc.type (D7)
//   - a new guard-rail override from an account without the role (D7)
// test/mock-api.js runs the same shared/budget-save-rules.js, so the browser
// suites cover the wiring there; this covers the wiring in the handler the
// deployed host actually runs.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// ---- the database, answered by query shape
let STORED = null;          // { Type, Doc } of dbo.Budgets, or null
let APP_ROLE = 'user';
let FEATURES = { usersAppRole: true };
const queries = [];
const REACHED_SAVE = new Error('reached the save transaction');
const request = () => {
  const inputs = {};
  const rq = {
    input: (k, type, v) => { inputs[k] = v; return rq; },
    query: async (q) => {
      q = String(q).replace(/\s+/g, ' ').trim();
      queries.push({ q, inputs });
      if (/FROM dbo\.Budgets WHERE ProjectId = @id/.test(q) && /SELECT TOP 1 Type, Doc/.test(q))
        return { recordset: STORED ? [STORED] : [] };
      if (/SELECT TOP 1 AppRole FROM dbo\.Users/.test(q))
        return { recordset: [{ AppRole: APP_ROLE }] };
      return { recordset: [], recordsets: [] };
    }
  };
  return rq;
};
class Transaction { async begin() { throw REACHED_SAVE; } async rollback() {} }
const sqlStub = new Proxy({ MAX: -1, Transaction }, {
  get: (t, k) => (k in t ? t[k] : (n => ({ type: String(k), n })))
});
const stub = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, rel));
  const m = new Module(file, null);
  m.filename = file; m.loaded = true; m.exports = exports;
  require.cache[file] = m;
};
stub('../api/shared/db', { getPool: async () => ({ request }), sql: sqlStub, isTransient: () => false });
stub('../api/shared/schema', { features: async () => FEATURES });
stub('../api/shared/users', { recordActivity: async () => {} });

const handler = require('../api/budget');

const header = roles => Buffer.from(JSON.stringify({
  identityProvider: 'aad', userId: 'u-1', userDetails: 'pm@finishessolutions.com', userRoles: roles
})).toString('base64');

// A budget whose expense ratio (20%) breaches the blocking 35–55% rail.
function breachingDoc(id) {
  return {
    projectId: id, type: 'Multifamily', opexSchemaVersion: 2,
    resSF: 50000, amenSF: 2000, siteSF: 120000,
    units: [{ label: '1BR', sf: 800, count: 50, rent: 1600 }],
    other: [], expenses: [{ label: 'Operations', per: 'pctIncome', rate: 20 }],
    lines: [{ scope: 'res', basis: 'sf', auto: true, unit: 160 },
            { scope: 'soft', basis: 'ls', auto: true, unit: 1000000 }],
    companies: [{ name: 'FS', pct: 12 }], contingency: { mode: 'pct', val: 3 },
    projectCosts: { land: 2000000, dev: { mode: 'pct', val: 3 },
                    mkt: { mode: 'pct', val: 1 }, cls: { mode: 'pct', val: 1 } },
    guardrailAcks: []
  };
}
const ACK = { id: 'opexRatio', reason: 'Ground lease covers taxes and insurance' };

async function put(id, body, roles) {
  queries.length = 0;
  const ctx = { bindingData: { id }, log: Object.assign(() => {}, { warn() {}, error() {} }) };
  try {
    await handler(ctx, { method: 'PUT', query: {}, body,
      headers: { 'x-ms-client-principal': header(roles || ['authenticated']) } });
  } catch (e) {
    if (e === REACHED_SAVE) return { reachedSave: true };
    throw e;
  }
  return { status: ctx.res.status, body: JSON.parse(ctx.res.body) };
}
const wrote = () => queries.some(x => /MERGE|UPDATE|INSERT/.test(x.q));

// ---- D13
test('an update whose Budget ID changed is refused before anything is read or written', async () => {
  STORED = { Type: 'Multifamily', Doc: JSON.stringify(breachingDoc('BD-0002')) };
  const doc = breachingDoc('BD-0002');
  const r = await put('BD-0002', { meta: { projectId: 'BD-0002', type: 'Multifamily', originalId: 'BD-0001' }, doc });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'budget_id_changed');
  assert.strictEqual(r.body.field, 'projectId');
  assert.match(r.body.message, /BD-0001/);
  assert.strictEqual(queries.length, 0, 'nothing touched: ' + JSON.stringify(queries.map(q => q.q)));
});

test('a create, or a save with no originalId, is not refused for the id', async () => {
  STORED = null;
  APP_ROLE = 'director';
  const doc = breachingDoc('BD-0003'); doc.guardrailAcks = [ACK];
  const create = await put('BD-0003', { create: true, doc,
    meta: { projectId: 'BD-0003', type: 'Multifamily', projectKey: 'OP-0001', originalId: 'BD-0001' } });
  assert.ok(create.reachedSave, JSON.stringify(create));
  const legacy = await put('BD-0003', { doc, meta: { projectId: 'BD-0003', type: 'Multifamily' } });
  assert.ok(legacy.reachedSave, JSON.stringify(legacy));
  const same = await put('BD-0003', { doc, meta: { projectId: 'BD-0003', type: 'Multifamily', originalId: 'bd-0003' } });
  assert.ok(same.reachedSave, 'the same id in another case is the same budget');
});

// ---- D7: rail table
test('doc.guardrails cannot switch the server rails off', async () => {
  STORED = { Type: 'Multifamily', Doc: JSON.stringify(breachingDoc('BD-0004')) };
  const doc = Object.assign(breachingDoc('BD-0004'), { guardrails: { Multifamily: {} } });
  const r = await put('BD-0004', { meta: { projectId: 'BD-0004', type: 'Multifamily' }, doc });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.error, 'guardrail_breach');
  assert.ok(r.body.breaches.some(b => b.id === 'opexRatio'));
});

test('doc.type cannot claim Blank; the stored type decides, and Blank is not reachable by a save', async () => {
  STORED = { Type: 'Multifamily', Doc: JSON.stringify(breachingDoc('BD-0005')) };
  const doc = Object.assign(breachingDoc('BD-0005'), { type: 'Blank' });
  const r1 = await put('BD-0005', { meta: { projectId: 'BD-0005', type: 'Multifamily' }, doc });
  assert.strictEqual(r1.status, 422, 'judged as the Multifamily row it is');
  const r2 = await put('BD-0005', { meta: { projectId: 'BD-0005', type: 'Blank' }, doc });
  assert.strictEqual(r2.status, 409);
  assert.strictEqual(r2.body.error, 'type_change_not_allowed');
  assert.ok(!wrote());
});

test('a budget created Blank stays judged by the Blank table', async () => {
  STORED = { Type: 'Blank', Doc: JSON.stringify(Object.assign(breachingDoc('BD-0006'), { type: 'Blank' })) };
  const doc = Object.assign(breachingDoc('BD-0006'), { type: 'Blank' });
  const r = await put('BD-0006', { meta: { projectId: 'BD-0006', type: 'Blank' }, doc });
  assert.ok(r.reachedSave, JSON.stringify(r));
  // ...and moving a Blank budget to a real type is allowed (it only tightens).
  const up = await put('BD-0006', { meta: { projectId: 'BD-0006', type: 'Multifamily' },
    doc: Object.assign(breachingDoc('BD-0006'), { guardrailAcks: [] }) });
  assert.strictEqual(up.status, 422, 'now judged by the Multifamily rails');
});

// ---- D7: who may record an override
test('a NEW override from an account without the role is refused with 403', async () => {
  STORED = { Type: 'Multifamily', Doc: JSON.stringify(breachingDoc('BD-0007')) };
  APP_ROLE = 'manager';
  const doc = breachingDoc('BD-0007'); doc.guardrailAcks = [ACK];
  const r = await put('BD-0007', { meta: { projectId: 'BD-0007', type: 'Multifamily' }, doc });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.error, 'override_not_allowed');
  assert.deepStrictEqual(r.body.rails, ['opexRatio']);
  assert.ok(r.body.message);
  assert.ok(!wrote());
  // A changed reason is a new decision too.
  STORED = { Type: 'Multifamily', Doc: JSON.stringify(Object.assign(breachingDoc('BD-0007'), { guardrailAcks: [ACK] })) };
  doc.guardrailAcks = [{ id: 'opexRatio', reason: 'Something else entirely' }];
  assert.strictEqual((await put('BD-0007', { meta: { projectId: 'BD-0007', type: 'Multifamily' }, doc })).status, 403);
});

test('an override already stored keeps saving, whoever saves', async () => {
  APP_ROLE = 'user';
  STORED = { Type: 'Multifamily', Doc: JSON.stringify(Object.assign(breachingDoc('BD-0008'), { guardrailAcks: [ACK] })) };
  const doc = breachingDoc('BD-0008'); doc.guardrailAcks = [Object.assign({ byName: 'Director' }, ACK)];
  const r = await put('BD-0008', { meta: { projectId: 'BD-0008', type: 'Multifamily', name: 'Renamed' }, doc });
  assert.ok(r.reachedSave, JSON.stringify(r));
});

test('director, DB super_admin and platform super_admin may record one', async () => {
  STORED = { Type: 'Multifamily', Doc: JSON.stringify(breachingDoc('BD-0009')) };
  const doc = breachingDoc('BD-0009'); doc.guardrailAcks = [ACK];
  const body = { meta: { projectId: 'BD-0009', type: 'Multifamily' }, doc };
  APP_ROLE = 'director';
  assert.ok((await put('BD-0009', body)).reachedSave);
  APP_ROLE = 'super_admin';
  assert.ok((await put('BD-0009', body)).reachedSave);
  APP_ROLE = 'user';
  assert.ok((await put('BD-0009', body, ['authenticated', 'super_admin'])).reachedSave);
});

test('before the AppRole column exists, overrides behave as they always did', async () => {
  FEATURES = { usersAppRole: false };
  APP_ROLE = 'user';
  STORED = { Type: 'Multifamily', Doc: JSON.stringify(breachingDoc('BD-0010')) };
  const doc = breachingDoc('BD-0010'); doc.guardrailAcks = [ACK];
  const r = await put('BD-0010', { meta: { projectId: 'BD-0010', type: 'Multifamily' }, doc });
  assert.ok(r.reachedSave, JSON.stringify(r));
  assert.ok(!queries.some(x => /AppRole/.test(x.q)), 'the absent column is never named');
  FEATURES = { usersAppRole: true };
});
