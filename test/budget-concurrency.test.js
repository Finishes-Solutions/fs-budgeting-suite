// The budget concurrency token, driven through the REAL api/budget/index.js
// with a fake pool — no database. test/projects-api.test.js pins the same
// behaviour on the mock; this pins it where it actually runs, because the
// mock agreeing with itself proves nothing about the SQL path.
//
// What matters: GET hands out the canonical hash of the stored Doc in a
// header (the body stays exactly the document), a PUT whose baseHash no
// longer matches is refused with 409 inside the save transaction — before
// anything is written — and a PUT without one is last-write-wins as before.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { contentHash } = require('../api/shared/canonical');

// ---- the fake: every query is recorded; a few are answered by shape
let stored = null;            // the dbo.Budgets row, or null
let queries = [];
let rolledBack = 0, committed = 0;
function answer(text) {
  queries.push(text);
  if (/FROM dbo\.Budgets WITH \(UPDLOCK, HOLDLOCK\)/.test(text))
    return { recordset: stored ? [stored] : [] };
  if (/SELECT Doc FROM dbo\.Budgets WHERE ProjectId = @id AND IsDeleted = 0/.test(text))
    return { recordset: stored ? [{ Doc: stored.Doc }] : [] };
  if (/INSERT INTO dbo\.BudgetVersions/.test(text)) return { recordset: [{ Id: 1 }] };
  if (/JSON_MODIFY\(Doc,'\$\.status',@st\)/.test(text)) {
    const d = JSON.parse(stored.Doc); d.status = lastInputs.st;
    stored = Object.assign({}, stored, { Status: lastInputs.st, Doc: JSON.stringify(d) });
    return { recordsets: [[{ Was: 'Draft', Name: 'Stored', ProjectKey: null }], [{ N: 1 }], [{ Doc: stored.Doc }]] };
  }
  if (/MERGE dbo\.Budgets/.test(text)) {
    stored = Object.assign({}, stored || {}, { Doc: lastInputs.doc });
    return { recordset: [] };
  }
  return { recordset: [], recordsets: [[]] };
}
let lastInputs = {};
class FakeRequest {
  constructor() { this.inputs = {}; }
  input(name, type, value) { this.inputs[name] = value; return this; }
  async query(text) { lastInputs = this.inputs; return answer(text); }
}
class FakeTransaction {
  async begin() {}
  async commit() { committed++; }
  async rollback() { rolledBack++; }
}
const db = require('../api/shared/db');
db.getPool = async () => ({ request: () => new FakeRequest() });
db.sql.Request = FakeRequest;
db.sql.Transaction = FakeTransaction;
require('../api/shared/schema')._reset();
const handler = require('../api/budget/index.js');

const docOf = (name) => ({
  projectId: 'BD-0201', name, address: '1 Way', resSF: 50000, amenSF: 1000, siteSF: 0,
  units: [{ label: '1BR', count: 20, sf: 700, rent: 1200 }], other: [], expenses: [],
  lines: [{ lineId: 'l1', scope: 'res', grp: 'G', code: '', desc: 'Shell', basis: 'ls', auto: true, qty: 0, unit: 2000000 }],
  companies: [], contingency: { mode: 'fixed', val: 0 },
  projectCosts: { land: 0, dev: 0, mkt: 0, cls: 0 }
});
const call = async (method, body) => {
  const context = { bindingData: { id: 'BD-0201' }, log: Object.assign(() => {}, { warn() {} }) };
  await handler(context, { method, query: {}, headers: {}, body });
  return context.res;
};
const put = (name, baseHash) => call('PUT', {
  meta: { projectId: 'BD-0201', name, status: 'Draft' }, doc: docOf(name), baseHash });

beforeEach(() => {
  // Stored with keys in a different order and a stamped `updated`: neither
  // may count as a change, which is the point of hashing canonically.
  const d = docOf('Stored');
  d.updated = '2026-01-01T00:00:00Z';
  stored = { Name: 'Stored', Type: 'Multifamily', Status: 'Draft', ContractSum: 0, ProjectCost: 0,
    PricingVersion: '', TemplateKey: null, TemplateVersionId: null, IsDeleted: false,
    UpdatedAt: new Date('2026-10-01T12:00:00Z'),
    Doc: JSON.stringify(Object.fromEntries(Object.entries(d).reverse())) };
  queries = []; rolledBack = 0; committed = 0;
});

test('GET hands out the canonical hash of the stored Doc, body unchanged', async () => {
  const res = await call('GET');
  assert.equal(res.body, stored.Doc, 'the body is still exactly the stored document');
  assert.equal(res.headers['X-Budget-Hash'], contentHash(docOf('Stored')));
});

test('a PUT with the current baseHash saves and returns the new token', async () => {
  const res = await put('Edited', contentHash(docOf('Stored')));
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.docHash, contentHash(docOf('Edited')));
  assert.equal(committed, 1);
  assert.ok(queries.some(q => /MERGE dbo\.Budgets/.test(q)));
});

test('a PUT with a stale baseHash is refused before anything is written', async () => {
  const res = await put('Clobber', contentHash(docOf('Something Older')));
  assert.equal(res.status, 409);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'budget_conflict');
  assert.equal(body.currentHash, contentHash(docOf('Stored')));
  assert.equal(body.updatedAt, '2026-10-01T12:00:00.000Z');
  assert.equal(rolledBack, 1, 'the transaction is rolled back exactly once');
  assert.equal(committed, 0);
  assert.ok(!queries.some(q => /MERGE|INSERT/.test(q)), 'nothing was written');
});

test('a PUT without a baseHash is last-write-wins, as before', async () => {
  const res = await put('No Base', undefined);
  assert.equal(res.status, 200, res.body);
  assert.equal(committed, 1);
});

test('a malformed baseHash is ignored rather than trusted or fatal', async () => {
  const res = await put('Junk Base', 'not-a-hash');
  assert.equal(res.status, 200, res.body);
});

test('a quick status change reports the token it moved the stored Doc to', async () => {
  const res = await call('PUT', { status: 'In Review' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'In Review');
  assert.equal(body.docHash, contentHash(Object.assign(docOf('Stored'), { status: 'In Review' })));
  assert.equal(body.docHash, (await call('GET')).headers['X-Budget-Hash'], 'what GET would now hand out');
});
