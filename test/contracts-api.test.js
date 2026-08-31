// API-behavior tests for approval + contracts, run against the mock — which
// applies the same rules api/shared/contracts.js does and derives the contract
// plan and reconciliation from the SAME budget-finance module the API uses.
//
// The point pinned here is the source-of-truth chain: contracts generate only
// from an approved version, their amounts equal the version-derived allocation,
// a working-budget edit leaves them alone, and a re-approval whose allocation
// differs flags them Requires Review with the variance — never a silent rewrite.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('path');

const PORT = 8144;
const BASE = 'http://127.0.0.1:' + PORT;
let proc;

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, 'mock-api.js')],
    { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/budgets'); return; } catch (_) { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('mock did not start');
});
after(() => { if (proc) proc.kill(); });

const api = async (p, opts = {}) => {
  const r = await fetch(BASE + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
};

function budgetDoc(id, over) {
  return Object.assign({
    projectId: id, name: 'Budget', type: 'Multifamily',
    resSF: 50000, amenSF: 0, siteSF: 0,
    units: [{ label: '1BR', count: 20, sf: 700, rent: 1200 }],
    other: [], expenses: [],
    lines: [{ lineId: 'l1', scope: 'res', grp: 'Concrete', code: '03 30 00', desc: 'Shell', basis: 'ls', auto: false, qty: 1, unit: 4000000, baseUnit: 4000000 }],
    companies: [{ name: 'Finishes Solutions LLC', pct: 12, entityKey: 'finishes-solutions' }],
    contingency: { mode: 'pct', val: 5 },
    projectCosts: { land: 500000, dev: { mode: 'amt', val: 200000 }, mkt: { mode: 'amt', val: 100000 }, cls: { mode: 'amt', val: 0 } }
  }, over || {});
}
const saveBudget = (id, projectKey, over) =>
  api('/api/budget/' + id, { method: 'PUT', body: {
    create: true, meta: { projectId: id, name: 'Budget', status: 'Draft', projectKey },
    doc: budgetDoc(id, over) } });

async function setup(opId, budId, finance) {
  await api('/api/budget/' + opId + '?scope=project', { method: 'PUT', body: { create: true, name: 'P', address: '1 Rd' } });
  await saveBudget(budId, opId, finance ? { finance } : {});
}

test('generate is refused before a version is approved', async () => {
  await setup('OP-8801', 'BDG-8801-01');
  // give the project an entity so the only blocker is approval
  await api('/api/budget/OP-8801?scope=project', { method: 'PUT', body: { entityId: 1 } });
  const r = await api('/api/budget/BDG-8801-01?scope=contracts', { method: 'PUT', body: { generate: true } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'not_approved');
});

test('generate is refused when the project has no entity', async () => {
  await setup('OP-8802', 'BDG-8802-01');
  await api('/api/budget/BDG-8802-01?scope=approve', { method: 'PUT', body: {} });
  const r = await api('/api/budget/BDG-8802-01?scope=contracts', { method: 'PUT', body: { generate: true } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'no_project_entity');
});

test('generated contract amounts equal the version-derived allocation, and reconcile', async () => {
  const finance = { bank: { upliftPct: 10, allocation: [], remainder: 'contingency' }, allocations: [
    { entityKey: 'finishes-solutions', stream: 'companyMarkup', costShare: 1 },
    { entityKey: 'finishes-development', stream: 'devFee' },
    { entityKey: 'finishes-marketing', stream: 'mktFee' }
  ] };
  await setup('OP-8803', 'BDG-8803-01', finance);
  await api('/api/budget/OP-8803?scope=project', { method: 'PUT', body: { entityId: 1 } });
  await api('/api/budget/BDG-8803-01?scope=approve', { method: 'PUT', body: {} });
  const g = await api('/api/budget/BDG-8803-01?scope=contracts', { method: 'PUT', body: { generate: true } });
  assert.equal(g.status, 201);
  assert.ok(g.body.generated >= 2, 'primary + fee contracts');
  const primary = g.body.contracts.find(c => c.allocationKey === 'finishes-solutions:primary');
  assert.ok(primary, 'a Project Entity → Finishes Solutions primary contract exists');
  assert.equal(g.body.reconciliation.status, 'Reconciled');
  g.body.contracts.forEach(c => assert.equal(c.status, 'Generated'));
});

test('editing the working budget after generation leaves contracts untouched', async () => {
  await setup('OP-8804', 'BDG-8804-01');
  await api('/api/budget/OP-8804?scope=project', { method: 'PUT', body: { entityId: 1 } });
  await api('/api/budget/BDG-8804-01?scope=approve', { method: 'PUT', body: {} });
  await api('/api/budget/BDG-8804-01?scope=contracts', { method: 'PUT', body: { generate: true } });
  const before = await api('/api/budget/BDG-8804-01?scope=contracts');
  // Change the working budget substantially (new version) but do NOT re-approve.
  await api('/api/budget/BDG-8804-01', { method: 'PUT', body: {
    create: false, meta: { projectId: 'BDG-8804-01', name: 'Budget', status: 'Draft', projectKey: 'OP-8804' },
    doc: budgetDoc('BDG-8804-01', { companies: [{ name: 'Finishes Solutions LLC', pct: 25, entityKey: 'finishes-solutions' }] }) } });
  const after = await api('/api/budget/BDG-8804-01?scope=contracts');
  assert.deepEqual(after.body.contracts.map(c => c.currentAmount), before.body.contracts.map(c => c.currentAmount),
    'working-budget edits never move a contract');
  assert.equal(after.body.reconciliation.status, 'Reconciled');
});

test('re-approving a changed allocation flags contracts Requires Review with the variance', async () => {
  await setup('OP-8805', 'BDG-8805-01');
  await api('/api/budget/OP-8805?scope=project', { method: 'PUT', body: { entityId: 1 } });
  await api('/api/budget/BDG-8805-01?scope=approve', { method: 'PUT', body: {} });
  await api('/api/budget/BDG-8805-01?scope=contracts', { method: 'PUT', body: { generate: true } });
  // Change and save a new version, then approve it — allocations now differ.
  await api('/api/budget/BDG-8805-01', { method: 'PUT', body: {
    create: false, meta: { projectId: 'BDG-8805-01', name: 'Budget', status: 'Draft', projectKey: 'OP-8805' },
    doc: budgetDoc('BDG-8805-01', { companies: [{ name: 'Finishes Solutions LLC', pct: 30, entityKey: 'finishes-solutions' }] }) } });
  const appr = await api('/api/budget/BDG-8805-01?scope=approve', { method: 'PUT', body: {} });
  assert.ok(appr.body.contractsFlagged >= 1, 'the re-approval flags at least one contract');
  const after = await api('/api/budget/BDG-8805-01?scope=contracts');
  const flagged = after.body.contracts.filter(c => c.status === 'Requires Review');
  assert.ok(flagged.length >= 1);
  assert.match(flagged[0].reviewNote, /variance|allocation/i);
});

test('a flagged contract can be accepted to the new amount or voided', async () => {
  await setup('OP-8806', 'BDG-8806-01');
  await api('/api/budget/OP-8806?scope=project', { method: 'PUT', body: { entityId: 1 } });
  await api('/api/budget/BDG-8806-01?scope=approve', { method: 'PUT', body: {} });
  await api('/api/budget/BDG-8806-01?scope=contracts', { method: 'PUT', body: { generate: true } });
  await api('/api/budget/BDG-8806-01', { method: 'PUT', body: {
    create: false, meta: { projectId: 'BDG-8806-01', name: 'Budget', status: 'Draft', projectKey: 'OP-8806' },
    doc: budgetDoc('BDG-8806-01', { companies: [{ name: 'Finishes Solutions LLC', pct: 20, entityKey: 'finishes-solutions' }] }) } });
  await api('/api/budget/BDG-8806-01?scope=approve', { method: 'PUT', body: {} });
  let list = await api('/api/budget/BDG-8806-01?scope=contracts');
  const flagged = list.body.contracts.find(c => c.status === 'Requires Review');
  assert.ok(flagged);
  const acc = await api('/api/budget/BDG-8806-01?scope=contract', { method: 'PUT', body: { contractId: flagged.contractId, action: 'accept' } });
  assert.equal(acc.status, 200);
  list = await api('/api/budget/BDG-8806-01?scope=contracts');
  const now = list.body.contracts.find(c => c.contractId === flagged.contractId);
  assert.equal(now.status, 'Generated', 'accepting clears the review flag');
  assert.equal(list.body.reconciliation.status, 'Reconciled', 'and the budget now reconciles');
});

test('changing the project entity under live contracts needs confirmation and then flags them', async () => {
  await setup('OP-8807', 'BDG-8807-01');
  await api('/api/budget/OP-8807?scope=project', { method: 'PUT', body: { entityId: 1 } });
  await api('/api/budget/BDG-8807-01?scope=approve', { method: 'PUT', body: {} });
  await api('/api/budget/BDG-8807-01?scope=contracts', { method: 'PUT', body: { generate: true } });
  // change entity — expect 409
  const warn = await api('/api/budget/OP-8807?scope=project', { method: 'PUT', body: { entityId: 2 } });
  assert.equal(warn.status, 409);
  assert.equal(warn.body.error, 'entity_change_requires_confirmation');
  assert.ok(warn.body.contracts >= 1);
  // confirm — contracts get flagged
  const ok = await api('/api/budget/OP-8807?scope=project', { method: 'PUT', body: { entityId: 2, confirmEntityChange: true } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.contractsFlagged >= 1);
});
