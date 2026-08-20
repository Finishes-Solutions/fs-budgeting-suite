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
let FEATURES = { usersAppRole: true, usersSettingsDoc: true,
                 budgetsCreatedBy: true, analysesCreatedBy: true, feedbackTable: true };
stub('../api/shared/schema', { features: async () => FEATURES });
// The mailer is stubbed rather than exercised — test/feedback.test.js drives
// the real one. Here it only has to report an outcome the handler must record.
let MAIL = { ok: true };
let MAIL_CONFIGURED = true;
stub('../api/shared/mailer', { send: async (m) => { MAIL.last = m; return MAIL; },
                               isConfigured: () => MAIL_CONFIGURED });

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


// ---------- feedback ----------

const fbReq = (method, roles, body, uid) => ({
  method, query: { scope: 'feedback' },
  headers: { 'x-ms-client-principal': principalHeader(roles, uid) },
  body
});
const goodReport = () => ({ kind: 'bug', title: 'Export does nothing',
  body: 'I clicked Export and no PDF came.', severity: 'major',
  context: { route: '#/budgets', environment: 'Staging', rows: [['Host', 'x.com']] } });

// ensureUser is the real module talking to the fake pool; give it a row.
const userRow = { UserId: 'admin-1', UserDetails: 'admin@finishessolutions.com',
  DisplayName: 'Matthew', Email: 'matthews@finishessolutions.com', SettingsDoc: '{}',
  LoginCount: 1, PrevLogins: 1 };

test('anyone signed in can file a report, and it is stored before mail is tried', async () => {
  queries.length = 0;
  MAIL = { ok: true };
  nextResult = { recordset: [Object.assign({ FeedbackId: 41, CreatedAt: new Date() }, userRow)],
                 rowsAffected: [1] };
  const r = await call(fbReq('POST', ['authenticated'], goodReport()));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.feedbackId, 41);
  assert.strictEqual(r.body.emailStatus, 'sent');

  const ins = queries.findIndex(q => /INSERT INTO dbo\.Feedback/.test(q.q));
  const upd = queries.findIndex(q => /UPDATE dbo\.Feedback SET EmailStatus/.test(q.q));
  assert.ok(ins >= 0, 'the report was inserted');
  assert.ok(upd > ins, 'delivery is recorded after the row exists, never before');
  assert.strictEqual(queries[ins].inputs.kind, 'bug');
  assert.strictEqual(queries[ins].inputs.route, '#/budgets');
  assert.strictEqual(queries[upd].inputs.st, 'sent');
  // The email carries the reporter so a reply reaches them, not the robot.
  assert.match(MAIL.last.subject, /^\[FS Suite · Bug · major\] Export does nothing/);
  assert.strictEqual(MAIL.last.replyTo, 'matthews@finishessolutions.com');
});

test('a mail failure is recorded on the row and does not fail the submission', async () => {
  queries.length = 0;
  MAIL = { ok: false, error: 'Graph sendMail failed (403): Access denied' };
  nextResult = { recordset: [Object.assign({ FeedbackId: 42, CreatedAt: new Date() }, userRow)],
                 rowsAffected: [1] };
  const r = await call(fbReq('POST', ['authenticated'], goodReport()));
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.emailStatus, 'failed');
  const upd = queries.find(q => /UPDATE dbo\.Feedback SET EmailStatus/.test(q.q));
  assert.strictEqual(upd.inputs.st, 'failed');
  assert.match(upd.inputs.err, /Access denied/);
});

test('unconfigured mail reads as disabled, which is not a failure', async () => {
  MAIL = { ok: false, disabled: true, error: 'Mail is not configured: set GRAPH_TENANT_ID…' };
  nextResult = { recordset: [Object.assign({ FeedbackId: 43, CreatedAt: new Date() }, userRow)],
                 rowsAffected: [1] };
  const r = await call(fbReq('POST', ['authenticated'], goodReport()));
  assert.strictEqual(r.body.emailStatus, 'disabled');
});

test('an incomplete report is refused with wording the reporter can act on', async () => {
  MAIL = { ok: true };
  const r = await call(fbReq('POST', ['authenticated'], { kind: 'bug', title: 'x' }));
  assert.strictEqual(r.status, 400);
  assert.match(r.body.message, /short title/);
});

test('a flood of reports from one account is throttled', async () => {
  queries.length = 0;
  nextResult = { recordset: [{ N: 12 }], rowsAffected: [1] };
  const r = await call(fbReq('POST', ['authenticated'], goodReport()));
  assert.strictEqual(r.status, 429);
  assert.ok(!queries.some(q => /INSERT INTO dbo\.Feedback/.test(q.q)), 'nothing was written');
});

test('the board is super_admin only', async () => {
  const r = await call(fbReq('GET', ['authenticated']));
  assert.strictEqual(r.status, 403);
  const w = await call(fbReq('PUT', ['authenticated'], { feedbackId: 1, status: 'Done' }));
  assert.strictEqual(w.status, 403);
});

test('a super_admin reads the board and sets a status', async () => {
  nextResult = { recordset: [{ FeedbackId: 7, Kind: 'bug', Title: 'T', Body: 'B',
    Severity: 'minor', UserName: 'A', UserEmail: 'a@b.com', PageRoute: '#/home',
    Status: 'New', EmailStatus: 'sent', CreatedAt: new Date(), UpdatedAt: new Date() }],
    rowsAffected: [1] };
  const list = await call(fbReq('GET', ['super_admin']));
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body[0].feedbackId, 7);
  assert.strictEqual(list.body[0].status, 'New');

  queries.length = 0;
  nextResult = { recordset: [], rowsAffected: [1] };
  const set = await call(fbReq('PUT', ['super_admin'], { feedbackId: 7, status: 'Triaged', notes: 'mine' }));
  assert.strictEqual(set.status, 200);
  const upd = queries.find(q => /SET Status = @st/.test(q.q));
  assert.strictEqual(upd.inputs.st, 'Triaged');
  assert.strictEqual(upd.inputs.notes, 'mine');
});

test('a status change for a report that is gone is a 404', async () => {
  nextResult = { recordset: [], rowsAffected: [0] };
  const r = await call(fbReq('PUT', ['super_admin'], { feedbackId: 999, status: 'Done' }));
  assert.strictEqual(r.status, 404);
});

test('before the migration, feedback says what to run rather than failing', async () => {
  FEATURES = Object.assign({}, FEATURES, { feedbackTable: false });
  const r = await call(fbReq('POST', ['authenticated'], goodReport()));
  assert.strictEqual(r.status, 503);
  assert.match(r.body.message, /migrate_feedback\.sql/);
  FEATURES = Object.assign({}, FEATURES, { feedbackTable: true });
});

test('the settings call tells the app what the server can do', async () => {
  nextResult = { recordset: [userRow], rowsAffected: [1] };
  const r = await call({ method: 'GET', query: {},
    headers: { 'x-ms-client-principal': principalHeader(['authenticated']) } });
  assert.strictEqual(r.status, 200);
  // The feedback button reads these to choose between filing a report here and
  // handing one to the user's mail client, so they have to be on this call —
  // there is no second request to fall back on.
  assert.deepStrictEqual(r.body.features, { feedbackStore: true, feedbackMail: true });

  FEATURES = Object.assign({}, FEATURES, { feedbackTable: false });
  const r2 = await call({ method: 'GET', query: {},
    headers: { 'x-ms-client-principal': principalHeader(['authenticated']) } });
  assert.strictEqual(r2.body.features.feedbackStore, false);
  FEATURES = Object.assign({}, FEATURES, { feedbackTable: true });
});

// ---- the settings contract itself (dependency-free, so no stubs needed).
// A theme pack is a stored preference like any other: the whitelist is what
// stops an unknown value ever reaching a browser, and the role check that
// decides whether a pack is painted lives in the client, not here.
const contract = require('../api/shared/user-settings-contract');

test('a theme pack round-trips, and an unknown pack falls back to default', () => {
  assert.strictEqual(contract.sanitizeSettings({ themePack: 'ramp' }).themePack, 'ramp');
  assert.strictEqual(contract.sanitizeSettings({ themePack: 'evergreen' }).themePack, 'default');
  assert.strictEqual(contract.sanitizeSettings({ themePack: 7 }).themePack, 'default');
});

test('an account that never picked a pack gets the default appearance', () => {
  assert.strictEqual(contract.sanitizeSettings({}).themePack, 'default');
  assert.strictEqual(contract.DEFAULT_SETTINGS.themePack, 'default');
});

test('the pack is additive: it disturbs no other stored setting', () => {
  const s = contract.sanitizeSettings({ themePack: 'ramp', accentColor: 'blue',
    theme: 'dark', budgetView: 'cards' });
  assert.strictEqual(s.accentColor, 'blue');
  assert.strictEqual(s.theme, 'dark');
  assert.strictEqual(s.budgetView, 'cards');
});

// The first-run welcome is a stored preference too: the client shows it from
// what boot already loaded, so the only thing that can go wrong here is a
// stored value that is not a strict boolean.
test('the welcome flag defaults to unseen and only a real true dismisses it', () => {
  assert.strictEqual(contract.DEFAULT_SETTINGS.welcomeSeen, false);
  assert.strictEqual(contract.sanitizeSettings({}).welcomeSeen, false);
  assert.strictEqual(contract.sanitizeSettings({ welcomeSeen: true }).welcomeSeen, true);
  assert.strictEqual(contract.sanitizeSettings({ welcomeSeen: 'true' }).welcomeSeen, false);
  assert.strictEqual(contract.sanitizeSettings({ welcomeSeen: 1 }).welcomeSeen, false);
});

test('dismissing the welcome disturbs no other stored setting', () => {
  const s = contract.sanitizeSettings({ welcomeSeen: true, accentColor: 'blue',
    themePack: 'ramp', pinned: { budget: ['OP-1001'], analysis: [] } });
  assert.strictEqual(s.accentColor, 'blue');
  assert.strictEqual(s.themePack, 'ramp');
  assert.deepStrictEqual(s.pinned.budget, ['OP-1001']);
});
