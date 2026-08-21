// API-behavior tests for the PROJECT surface, run against the mock — which
// applies the same rules api/shared/projects.js does, off the same contract
// modules where they are shared.
//
// What is being pinned down here is the identifier rule, because it is the one
// thing the rest of the model hangs off: a PROJECT id is OP-#### and is the
// project's own identity; a BUDGET id is BD-#### and is never a project id.
// Before this, a project was keyed by a budget id with its alternate suffix
// stripped, which is why the Projects list showed BD-… in its PROJECT ID
// column.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('path');

const PORT = 8141;
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

const doc = (projectId, over = {}) => Object.assign({
  projectId, name: 'Budget', address: '1 Way',
  resSF: 50000, amenSF: 1000, siteSF: 0,
  units: [{ label: '1BR', count: 20, sf: 700, rent: 1200 }],
  other: [], expenses: [],
  lines: [{ lineId: 'l1', scope: 'res', grp: 'G', code: '', desc: 'Shell', basis: 'ls', auto: true, qty: 0, unit: 2000000 }],
  companies: [], contingency: { mode: 'fixed', val: 0 },
  projectCosts: { land: 0, dev: 0, mkt: 0, cls: 0 }
}, over);

const saveBudget = (id, projectKey, over = {}, create = true) =>
  api('/api/budget/' + id, { method: 'PUT', body: {
    create, meta: { projectId: id, name: over.name || 'Budget', status: 'Draft', projectKey },
    doc: doc(id, over) } });

// ---------------------------------------------------------------- identity

test('a project ID must match OP-#### exactly', async () => {
  for (const bad of ['BD-0001', 'OP-001', 'OP-00001', 'op-0001x', 'TST-9999', 'AS-0001']) {
    const r = await api('/api/budget/' + bad + '?scope=project',
      { method: 'PUT', body: { create: true, name: 'X', address: 'Y' } });
    assert.equal(r.status, 400, bad + ' should be refused');
    assert.equal(r.body.field, 'projectId');
    assert.match(r.body.message, /OP-####/);
  }
});

test('lowercase is normalised rather than refused', async () => {
  const r = await api('/api/budget/op-0100?scope=project',
    { method: 'PUT', body: { create: true, name: 'Lower', address: '1 Way' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.project.projectId, 'OP-0100');
});

test('every field on the create form is required, and the API says which', async () => {
  const noName = await api('/api/budget/OP-0101?scope=project',
    { method: 'PUT', body: { create: true, name: '  ', address: '1 Way' } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.field, 'name');

  const noAddr = await api('/api/budget/OP-0101?scope=project',
    { method: 'PUT', body: { create: true, name: 'Named', address: '' } });
  assert.equal(noAddr.status, 400);
  assert.equal(noAddr.body.field, 'address');
});

test('project IDs are unique, and a duplicate is refused by the API', async () => {
  const first = await api('/api/budget/OP-0102?scope=project',
    { method: 'PUT', body: { create: true, name: 'First', address: '1 Way' } });
  assert.equal(first.status, 201);

  const second = await api('/api/budget/OP-0102?scope=project',
    { method: 'PUT', body: { create: true, name: 'Second', address: '2 Way' } });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'project_id_taken');
  assert.equal(second.body.field, 'projectId');
  assert.match(second.body.message, /unique/i);

  // and the first is untouched — a refused duplicate is not a silent update
  const got = await api('/api/budgets?scope=project&id=OP-0102');
  assert.equal(got.body.project.name, 'First');
});

test('a project has no type: one property can carry budgets of several types', async () => {
  await api('/api/budget/OP-0103?scope=project',
    { method: 'PUT', body: { create: true, name: 'Mixed', address: '3 Way' } });
  await saveBudget('BD-0103', 'OP-0103', { name: 'MF' });
  await api('/api/budget/BD-0103', { method: 'PUT', body: {
    meta: { projectId: 'BD-0103', name: 'MF', status: 'Draft', type: 'Multifamily', projectKey: 'OP-0103' },
    doc: doc('BD-0103') } });
  await saveBudget('BD-0104', 'OP-0103', { name: 'Comm' });
  await api('/api/budget/BD-0104', { method: 'PUT', body: {
    meta: { projectId: 'BD-0104', name: 'Comm', status: 'Draft', type: 'Commercial', projectKey: 'OP-0103' },
    doc: doc('BD-0104') } });

  const r = await api('/api/budgets?scope=project&id=OP-0103');
  assert.equal(r.body.project.type, undefined, 'a project must not report a type of its own');
  assert.equal(r.body.project.budgetTypes, 'Commercial, Multifamily');

  // the API refuses to store a type on the project even when one is sent
  await api('/api/budget/OP-0103?scope=project', { method: 'PUT', body: { type: 'Industrial' } });
  const after = await api('/api/budgets?scope=project&id=OP-0103');
  assert.equal(after.body.project.type, undefined);
});

test('a budget ID is never a project ID and vice versa', async () => {
  const r = await api('/api/budgets?scope=project&id=OP-0103');
  assert.match(r.body.project.projectId, /^OP-\d{4}$/);
  for (const b of r.body.budgets) {
    assert.match(b.projectId, /^(OP|BD|AS|TST)-\d{4}(-\d{2})?$/);
    assert.notEqual(b.projectId, r.body.project.projectId);
  }
  // a budget cannot claim a project that does not look like a project
  const bad = await api('/api/budget/BD-0105', { method: 'PUT', body: {
    create: true, meta: { projectId: 'BD-0105', name: 'X', status: 'Draft', projectKey: 'BD-0103' },
    doc: doc('BD-0105') } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'projectKey');
});

test('the next free project ID is suggested in the OP-#### namespace', async () => {
  const r = await api('/api/budgets?scope=next-project-id');
  assert.match(r.body.projectId, /^OP-\d{4}$/);
  const taken = await api('/api/budgets?scope=projects');
  assert.ok(!taken.body.projects.some(p => p.projectId === r.body.projectId));
});

// ------------------------------------------------------------ create rules

test('a new budget will not overwrite an existing one', async () => {
  await api('/api/budget/OP-0110?scope=project',
    { method: 'PUT', body: { create: true, name: 'Collide', address: '4 Way' } });
  const first = await saveBudget('BD-0110', 'OP-0110', { name: 'Original' });
  assert.equal(first.status, 200);

  const clash = await saveBudget('BD-0110', 'OP-0110', { name: 'Impostor' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, 'budget_id_taken');
  assert.match(clash.body.suggestion, /^BD-\d{4}$/);

  // the original survives, un-versioned by the refused save
  const got = await api('/api/budget/BD-0110');
  assert.equal(got.body.name, 'Original');
});

test('an ordinary save of an existing budget still updates it', async () => {
  const r = await api('/api/budget/BD-0110', { method: 'PUT', body: {
    meta: { projectId: 'BD-0110', name: 'Renamed', status: 'Draft' },
    doc: doc('BD-0110', { name: 'Renamed' }) } });
  assert.equal(r.status, 200);
  const got = await api('/api/budget/BD-0110');
  assert.equal(got.body.name, 'Renamed');
  // and it kept the project it was already linked to, without resending it
  const pj = await api('/api/budgets?scope=project&id=OP-0110');
  assert.ok(pj.body.budgets.some(b => b.projectId === 'BD-0110'));
});

test('square footage is required and must be greater than zero', async () => {
  await api('/api/budget/OP-0120?scope=project',
    { method: 'PUT', body: { create: true, name: 'Sizeless', address: '5 Way' } });
  const r = await saveBudget('BD-0120', 'OP-0120', { resSF: 0, amenSF: 0 });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'size_required');
  assert.equal(r.body.field, 'resSF');

  // amenity area alone is still a building, so it is enough
  const ok = await saveBudget('BD-0120', 'OP-0120', { resSF: 0, amenSF: 900 });
  assert.equal(ok.status, 200);

  // site area is LAND and has never counted toward the building
  const land = await saveBudget('BD-0121', 'OP-0120', { resSF: 0, amenSF: 0, siteSF: 40000 });
  assert.equal(land.status, 422);
});

// ---------------------------------------------------------- primary budget

test('Make Primary moves the flag and the money, atomically', async () => {
  await api('/api/budget/OP-0130?scope=project',
    { method: 'PUT', body: { create: true, name: 'Primary Test', address: '6 Way' } });
  await saveBudget('BD-0130', 'OP-0130', { name: 'Base' });
  await saveBudget('BD-0130-02', 'OP-0130', { name: 'Alternate',
    lines: [{ lineId: 'l1', scope: 'res', grp: 'G', code: '', desc: 'Shell', basis: 'ls', auto: true, qty: 0, unit: 9000000 }] });

  const before = await api('/api/budgets?scope=project&id=OP-0130');
  assert.equal(before.body.project.primaryBudgetId, 'BD-0130');
  assert.equal(before.body.budgets.filter(b => b.isPrimary).length, 1,
    'exactly one primary, always');
  const basePrimaryCost = before.body.project.liveProjectCost;

  const moved = await api('/api/budget/OP-0130?scope=project',
    { method: 'PUT', body: { primaryBudgetId: 'BD-0130-02' } });
  assert.equal(moved.status, 200);

  const after = await api('/api/budgets?scope=project&id=OP-0130');
  assert.equal(after.body.project.primaryBudgetId, 'BD-0130-02');
  const primaries = after.body.budgets.filter(b => b.isPrimary);
  assert.equal(primaries.length, 1, 'never two primaries, never none');
  assert.equal(primaries[0].projectId, 'BD-0130-02');
  // the project's money followed the primary, and is the primary's ALONE
  assert.notEqual(after.body.project.liveProjectCost, basePrimaryCost);
  const alt = after.body.budgets.find(b => b.projectId === 'BD-0130-02');
  assert.equal(after.body.project.liveProjectCost, alt.projectCost);
  const sumOfAll = after.body.budgets.reduce((s, b) => s + b.projectCost, 0);
  assert.notEqual(after.body.project.liveProjectCost, sumOfAll,
    'an alternate must never be summed into the project total');
});

test('the primary must be a live budget of this project', async () => {
  const foreign = await api('/api/budget/OP-0130?scope=project',
    { method: 'PUT', body: { primaryBudgetId: 'BD-0110' } });
  assert.equal(foreign.status, 400);
  const missing = await api('/api/budget/OP-0130?scope=project',
    { method: 'PUT', body: { primaryBudgetId: 'BD-9999' } });
  assert.equal(missing.status, 400);
  // and the flag did not move
  const still = await api('/api/budgets?scope=project&id=OP-0130');
  assert.equal(still.body.project.primaryBudgetId, 'BD-0130-02');
});

test('an alternate is a suffix, not "an id unlike the project\'s"', async () => {
  const r = await api('/api/budgets?scope=project&id=OP-0130');
  const base = r.body.budgets.find(b => b.projectId === 'BD-0130');
  const alt = r.body.budgets.find(b => b.projectId === 'BD-0130-02');
  assert.equal(base.isAlternate, false);
  assert.equal(alt.isAlternate, true);
});

// ------------------------------------------------------------------ delete

test('deleting a project takes its budgets and analyses with it', async () => {
  await api('/api/budget/OP-0140?scope=project',
    { method: 'PUT', body: { create: true, name: 'Doomed', address: '7 Way' } });
  await saveBudget('BD-0140', 'OP-0140', { name: 'Doomed Budget' });
  const an = await api('/api/investment-analyses',
    { method: 'POST', body: { mode: 'fromBudget', projectId: 'BD-0140', analysisName: 'Doomed Deal' } });
  assert.equal(an.status, 201);

  const gone = await api('/api/budget/OP-0140?scope=project', { method: 'DELETE' });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.budgetsDeleted, 1);
  assert.equal(gone.body.analysesDeleted, 1);

  assert.equal((await api('/api/budgets?scope=project&id=OP-0140')).status, 404);
  assert.equal((await api('/api/budget/BD-0140')).status, 404);
  const list = await api('/api/investment-analyses');
  assert.ok(!list.body.some(a => a.analysisId === an.body.analysisId));
});

test('deleting a project that is already gone is a 404, not a silent success', async () => {
  const again = await api('/api/budget/OP-0140?scope=project', { method: 'DELETE' });
  assert.equal(again.status, 404);
});

// ------------------------------------------------------- analysis inherits

test('an analysis inherits the project name and address, not a budget id', async () => {
  await api('/api/budget/OP-0150?scope=project',
    { method: 'PUT', body: { create: true, name: 'Riverbend', address: '10514 Woodedge Dr' } });
  // a budget with NO name of its own — the case that produced "BD-2108"
  await api('/api/budget/BD-0150', { method: 'PUT', body: {
    create: true, meta: { projectId: 'BD-0150', name: '', status: 'Draft', projectKey: 'OP-0150' },
    doc: doc('BD-0150', { name: '', address: '' }) } });

  const an = await api('/api/investment-analyses',
    { method: 'POST', body: { mode: 'fromBudget', projectId: 'BD-0150' } });
  assert.equal(an.status, 201);
  assert.equal(an.body.input.property.name, 'Riverbend');
  assert.equal(an.body.input.property.address, '10514 Woodedge Dr');
  assert.ok(an.body.input.property.size.value > 0, 'and a real size to calculate from');

  // and it rolls up to the same project the budget belongs to
  const pj = await api('/api/budgets?scope=project&id=OP-0150');
  assert.equal(pj.body.analyses.length, 1);
});

// ------------------------------------------------------------------ audit

test('favoriting is logged against the record, not as "Updated settings"', async () => {
  await api('/api/user-settings', { method: 'PUT', body: {
    settings: { favorites: { budget: ['BD-0150'], analysis: [], project: ['OP-0150'] } } } });
  const log = await api('/api/user-activity');
  const budgetFav = log.body.events.find(e => e.eventType === 'favorite_add' && e.entityType === 'budget');
  const projectFav = log.body.events.find(e => e.eventType === 'favorite_add' && e.entityType === 'project');
  assert.ok(budgetFav, 'a favorited budget is its own event');
  assert.equal(budgetFav.entityId, 'BD-0150');
  assert.ok(projectFav, 'a favorited project is its own event');
  assert.equal(projectFav.entityId, 'OP-0150');
  assert.equal(projectFav.detail.name, 'Riverbend', 'and it names the record');

  // removing one says so too, rather than looking identical to adding it
  await api('/api/user-settings', { method: 'PUT', body: {
    settings: { favorites: { budget: [], analysis: [], project: ['OP-0150'] } } } });
  const after = await api('/api/user-activity');
  assert.ok(after.body.events.some(e => e.eventType === 'favorite_remove' && e.entityId === 'BD-0150'));
});

test('an ordinary preference change still says which setting, and what it became', async () => {
  await api('/api/user-settings', { method: 'PUT', body: { settings: { theme: 'dark' } } });
  const log = await api('/api/user-activity');
  const ev = log.body.events.find(e => e.eventType === 'settings_update');
  assert.ok(ev);
  const themeChange = ev.detail.changed.find(c => c.key === 'theme');
  assert.ok(themeChange, JSON.stringify(ev.detail));
  assert.equal(themeChange.to, 'dark');
});

test('a settings write that changes nothing records nothing', async () => {
  const before = (await api('/api/user-activity')).body.events.length;
  await api('/api/user-settings', { method: 'PUT', body: { settings: { theme: 'dark' } } });
  const after = (await api('/api/user-activity')).body.events.length;
  assert.equal(after, before, 'an audit log full of non-events is an audit log nobody reads');
});

test('budget and project events carry what changed', async () => {
  await api('/api/budget/OP-0160?scope=project',
    { method: 'PUT', body: { create: true, name: 'Audited', address: '8 Way' } });
  await saveBudget('BD-0160', 'OP-0160', { name: 'Audited Budget' });
  await api('/api/budget/BD-0160', { method: 'PUT', body: {
    meta: { projectId: 'BD-0160', name: 'Audited Budget v2', status: 'In Review', projectKey: 'OP-0160' },
    doc: doc('BD-0160', { name: 'Audited Budget v2', resSF: 60000 }) } });

  const log = (await api('/api/user-activity')).body.events;
  const created = log.find(e => e.eventType === 'budget_create' && e.entityId === 'BD-0160');
  assert.ok(created, 'creating a budget is not the same event as saving one');
  assert.equal(created.detail.projectKey, 'OP-0160');

  const saved = log.find(e => e.eventType === 'budget_save' && e.entityId === 'BD-0160');
  assert.ok(saved);
  const keys = saved.detail.changed.map(c => c.key);
  assert.ok(keys.includes('name') && keys.includes('status') && keys.includes('residentialSF'),
    JSON.stringify(saved.detail.changed));
  const nameChange = saved.detail.changed.find(c => c.key === 'name');
  assert.equal(nameChange.from, 'Audited Budget');
  assert.equal(nameChange.to, 'Audited Budget v2');

  const proj = log.find(e => e.eventType === 'project_create' && e.entityId === 'OP-0160');
  assert.ok(proj);
  assert.equal(proj.detail.name, 'Audited');
});
