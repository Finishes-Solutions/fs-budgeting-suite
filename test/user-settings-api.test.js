// Drives the REAL api/user-settings handler — the module the deployed host
// runs — against a fake pool. The browser suites exercise test/mock-api.js,
// which re-implements these routes in its own code, so a fault in the real
// handler could never fail a suite. That is exactly how a reference error in
// the role update ("Cannot access 'sql' before initialization", a function-
// scoped re-require shadowing the module-level one) reached production with
// every test green.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// ---- stub the two modules that need a database, before the handler loads.
const queries = [];
const sqlStub = new Proxy({ MAX: -1 }, {
  get: (t, k) => (k in t ? t[k] : (n => ({ type: String(k), n })))
});
let nextResult = { recordset: [], rowsAffected: [1] };
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
stub('../api/shared/db', { getPool: async () => poolStub, sql: sqlStub,
                           isTransient: () => false });
stub('../api/shared/schema', { features: async () => ({
  usersAppRole: true, usersSettingsDoc: true,
  budgetsCreatedBy: true, analysesCreatedBy: true }) });

const handler = require('../api/user-settings');

const principalHeader = (roles, userId) => Buffer.from(JSON.stringify({
  identityProvider: 'aad', userId: userId || 'admin-1',
  userDetails: 'admin@finishessolutions.com', userRoles: roles
})).toString('base64');

const call = async (req) => {
  const ctx = {};
  await handler(ctx, req);
  return { status: ctx.res.status, body: JSON.parse(ctx.res.body) };
};
const roleReq = (roles, body) => ({
  method: 'PUT', query: { scope: 'roles' },
  headers: { 'x-ms-client-principal': principalHeader(roles) },
  body
});

test('a super_admin can set an application role', async () => {
  queries.length = 0;
  nextResult = { recordset: [], rowsAffected: [1] };
  const r = await call(roleReq(['authenticated', 'super_admin'],
    { userId: 'u-2', appRole: 'manager' }));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body, { ok: true, userId: 'u-2', appRole: 'manager' });
  const upd = queries.find(x => /UPDATE dbo\.Users SET AppRole/.test(x.q));
  assert.ok(upd, 'the role update ran: ' + JSON.stringify(queries.map(q => q.q)));
  assert.strictEqual(upd.inputs.uid, 'u-2');
  assert.strictEqual(upd.inputs.role, 'manager');
});

test('a role update accepts a body that arrives as a string', async () => {
  nextResult = { recordset: [], rowsAffected: [1] };
  const r = await call(roleReq(['super_admin'],
    JSON.stringify({ userId: 'u-3', appRole: 'director' })));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
});

test('a user who has never signed in is reported as missing, not as a failure',
  async () => {
    nextResult = { recordset: [], rowsAffected: [0] };
    const r = await call(roleReq(['super_admin'], { userId: 'ghost', appRole: 'user' }));
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error, 'not_found');
  });

test('an unknown role is refused before it reaches the database', async () => {
  nextResult = { recordset: [], rowsAffected: [1] };
  const r = await call(roleReq(['super_admin'], { userId: 'u-2', appRole: 'root' }));
  assert.strictEqual(r.status, 400);
});

test('a signed-in user without super_admin cannot change roles', async () => {
  const r = await call(roleReq(['authenticated'], { userId: 'u-2', appRole: 'director' }));
  assert.strictEqual(r.status, 403);
});

test('listing roles needs super_admin and returns one row per account', async () => {
  nextResult = { recordset: [{ UserId: 'u-1', UserDetails: 'a@b.com', DisplayName: 'A',
    Email: 'a@b.com', AppRole: 'director', LastSeenAt: new Date(), LoginCount: 3 }],
    rowsAffected: [1] };
  const r = await call({ method: 'GET', query: { scope: 'roles' },
    headers: { 'x-ms-client-principal': principalHeader(['super_admin']) } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 1);
  assert.strictEqual(r.body[0].appRole, 'director');
});

test('an unauthenticated request is rejected before any query runs', async () => {
  queries.length = 0;
  const r = await call({ method: 'GET', query: { scope: 'roles' }, headers: {} });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(queries.length, 0);
});
