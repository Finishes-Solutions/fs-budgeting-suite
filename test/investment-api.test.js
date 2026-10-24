// API-behavior tests for the investment routes, run against the mock server —
// which itself runs the REAL engine and hash convention. The same scenario was
// integration-proven against SQL Server via the actual Function modules; this
// file keeps the mock honest so the browser suites test true API semantics.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('path');

const PORT = 8140;
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

const budgetDoc = {
  projectId: 'TST-7101', name: 'Mock Tower', address: '2 Mock Way',
  resSF: 80000, amenSF: 0, siteSF: 0,
  units: [{ label: '1BR', count: 30, sf: 700, rent: 1000 }],
  other: [], expenses: [{ label: 'Trash', per: 'unit', rate: 10, auto: true, count: 0 }],
  lines: [{ lineId: 'm1', scope: 'res', grp: 'G', code: '', desc: 'Shell', basis: 'ls', auto: true, qty: 0, unit: 3000000 }],
  companies: [], contingency: { mode: 'fixed', val: 0 },
  projectCosts: { land: 500000, dev: 0, mkt: 0, cls: 0 }
};

let analysisId, fullInput;

test('seed a budget and create an analysis from its exact version', async () => {
  const put = await api('/api/budget/TST-7101', { method: 'PUT',
    body: { meta: { projectId: 'TST-7101', name: 'Mock Tower' }, doc: budgetDoc } });
  assert.equal(put.status, 200);

  const created = await api('/api/investment-analyses', { method: 'POST',
    body: { mode: 'fromBudget', projectId: 'TST-7101', budgetVersionNumber: 1, analysisName: 'Mock Analysis' } });
  assert.equal(created.status, 201);
  analysisId = created.body.analysisId;
  const pre = created.body.input;
  assert.equal(pre.income.year1PotentialIncome, 12 * 30 * 1000, 'gross rent x12, never net income');
  assert.equal(pre.acquisition.basis.value, 3500000, 'project cost suggested as purchase price');
  assert.equal(pre.property.size.value, 80000, 'property size is the BUILDING, res + amen SF');
  // Creation defaults the month to the one it happens in — the common answer,
  // and one step 1 can change. It is set at CREATION only; a saved month is
  // never written over.
  assert.equal(pre.property.purchaseMonth, new Date().toISOString().slice(0, 7),
    'purchase month defaults to the current month');
  assert.ok(pre.source.fieldOrigins['property.size'].includes('Residential + Amenity'),
    'the origin says which measurement it is');
  assert.equal(pre.source.support.annualServiceExpenses, 12 * 10 * 30, 'expenses appear as support data');
  assert.ok(pre.source.fieldOrigins['acquisition.basis'].includes('Total Project Cost'));

  // The expense ratio is DERIVED from the budget, against the same Gross
  // Operating Income the engine multiplies — after vacancy, not gross income.
  const opex = 12 * 10 * 30;                       // $10/unit/mo × 30 units × 12
  const gross = 12 * 30 * 1000;                    // rent only; this budget has no other income
  const goi = gross * (1 - 0.10);                  // the default vacancy
  assert.ok(Math.abs(pre.expenses.value - opex / goi) < 1e-4, 'expense ratio derived from the budget');
  assert.equal(pre.expenses.override, false, 'derived, not overridden');
  assert.equal(pre.expenses.derivedFrom.projectId, 'TST-7101');
  assert.equal(pre.expenses.derivedFrom.budgetVersionNumber, 1);
  assert.equal(pre.expenses.derivedFrom.annualOpex, opex);
  assert.equal(pre.expenses.derivedFrom.grossIncomeYr, gross);
  assert.equal(pre.expenses.derivedFrom.vacancy, 0.10);
  // This budget's rows are ~3.7% of income, which the 35-55% guard rail is
  // exactly what catches. The derivation still reports it honestly rather than
  // inventing a plausible number.
  assert.ok(pre.expenses.value < 0.05, 'a service-only budget derives a visibly low ratio');
  assert.equal(pre.source.support.opexSchemaVersion, 1, 'and says the schedule is the old one');
  assert.equal(pre.source.support.landSquareFeet, null, 'site SF is carried as land, not as size');
  assert.equal(pre.source.support.buildingSquareFeet, 80000);
  assert.equal(pre.source.support.rentableSquareFeet, 30 * 700);

  const missing = await api('/api/investment-analyses', { method: 'POST',
    body: { mode: 'fromBudget', projectId: 'TST-7101', budgetVersionNumber: 99 } });
  assert.equal(missing.status, 404, 'cross-project / nonexistent version cannot be imported');
});

test('preview endpoint calculates without persisting', async () => {
  const wedge = require('./fixtures/investment/wedgewood.json').input;
  const r = await api('/api/investment-calculations', { method: 'POST', body: wedge });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.body.result.summary.initialEquity - 8193984) <= 1.5);
  const bad = await api('/api/investment-calculations', { method: 'POST', body: { schemaVersion: 1 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'validation_failed');
  const list = await api('/api/investment-analyses');
  assert.equal(list.body.length, 1, 'preview persisted nothing');
});

test('save recalculates server-side, ignores client result, versions once', async () => {
  const got = await api('/api/investment-analysis/' + analysisId);
  fullInput = got.body.input;
  fullInput.property.purchaseMonth = '2026-02';
  fullInput.expenses = { mode: 'percentOfGOI', value: 0.30 };
  fullInput.disposition.exitCapRate.value = 0.07;
  fullInput.financing.loans = [{ label: 'First Mortgage', kind: 'newAmortizing',
    amount: { mode: 'ltv', value: 0.65 }, annualRate: 0.065, amortizationYears: 25,
    termYears: 5, feePercent: 0.01, interestCalculation: '30/360' }];

  const saved = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input: fullInput, expectedVersionNumber: 0,
            result: { summary: { purchasePrice: 999 } } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.versionNumber, 1);
  assert.equal(saved.body.versionCreated, true);
  assert.equal(saved.body.result.summary.purchasePrice, 3500000, 'client result ignored');
  assert.equal(saved.body.result.annual.length, 5);

  const noop = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input: fullInput, expectedVersionNumber: 1 } });
  assert.equal(noop.body.versionCreated, false, 'no-op save creates no version');

  const stale = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input: fullInput, expectedVersionNumber: 0 } });
  assert.equal(stale.status, 409, 'stale save conflicts');
  assert.equal(stale.body.currentVersionNumber, 1);

  fullInput.vacancy.value = 0.08;
  const saved2 = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input: fullInput, expectedVersionNumber: 1 } });
  assert.equal(saved2.body.versionNumber, 2);
});

test('invalid input on save returns field-keyed validation errors', async () => {
  const bad = JSON.parse(JSON.stringify(fullInput));
  bad.disposition.exitCapRate.value = 0;
  const r = await api('/api/investment-analysis/' + analysisId, { method: 'PUT', body: { input: bad } });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields['disposition.exitCapRate.value']);
});

test('immutable version history is stored, not recalculated', async () => {
  const list = await api('/api/investment-analysis/' + analysisId + '/versions');
  assert.equal(list.body.versions.length, 2);
  assert.equal(list.body.versions[0].versionNumber, 2);
  assert.equal(list.body.versions[0].isCurrent, true);
  const v1 = await api('/api/investment-analysis/' + analysisId + '/versions/1');
  assert.equal(v1.body.result.normalizedInput.vacancy.value, 0.10, 'version 1 keeps its original vacancy');
  assert.equal(v1.body.version.calculationVersion, 'before-tax-1.1.0');
});

test('soft delete hides, history survives, save restores', async () => {
  const del = await api('/api/investment-analysis/' + analysisId, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal((await api('/api/investment-analyses')).body.length, 0);
  assert.equal((await api('/api/investment-analysis/' + analysisId)).status, 404);

  const restored = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input: fullInput } });
  assert.equal(restored.status, 200);
  const list = await api('/api/investment-analyses');
  assert.equal(list.body.length, 1);
  const versions = await api('/api/investment-analysis/' + analysisId + '/versions');
  assert.equal(versions.body.versions.length, 2, 'history survived the delete/restore cycle');
});

test('malformed IDs and bodies are 400s', async () => {
  assert.equal((await api('/api/investment-analysis/not-a-guid')).status, 400);
  assert.equal((await api('/api/investment-analysis/' + analysisId, { method: 'PUT', body: {} })).status, 400);
  assert.equal((await api('/api/investment-analyses', { method: 'POST', body: { mode: 'nope' } })).status, 400);
  assert.equal((await api('/api/investment-analyses?projectId=DROP TABLE')).status, 400);
});

test('list filters by project and carries summary values', async () => {
  const byProject = await api('/api/investment-analyses?projectId=TST-7101');
  assert.equal(byProject.body.length, 1);
  assert.equal(byProject.body[0].purchasePrice, 3500000);
  const other = await api('/api/investment-analyses?projectId=BD-0042');
  assert.equal(other.body.length, 0);
});

test('a full save keeps the stored status, and refuses one that is not a status', async () => {
  const set = await api('/api/investment-analysis/' + analysisId, { method: 'PUT', body: { status: 'In Review' } });
  assert.equal(set.status, 200);
  const before = await api('/api/investment-analysis/' + analysisId);
  const input = before.body.input;
  input.vacancy.value = 0.09;
  const saved = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input, expectedVersionNumber: before.body.currentVersionNumber } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.versionCreated, true);
  const after = await api('/api/investment-analysis/' + analysisId);
  assert.equal(after.body.status, 'In Review', 'saving the assumptions did not reset the status to Draft');
  const named = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input, expectedVersionNumber: after.body.currentVersionNumber, status: 'Completed' } });
  assert.equal(named.status, 200);
  assert.equal((await api('/api/investment-analysis/' + analysisId)).body.status, 'Completed',
    'a status sent with the save is applied');
  const bogus = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input, status: 'Shipped' } });
  assert.equal(bogus.status, 400);
});

test('re-sync is a proposal: it stores nothing, and the save records it', async () => {
  // Move the budget on to v2 so the analysis has something to re-sync to.
  const moved = JSON.parse(JSON.stringify(budgetDoc));
  moved.projectCosts.land = 900000;
  const put = await api('/api/budget/TST-7101', { method: 'PUT',
    body: { meta: { projectId: 'TST-7101', name: 'Mock Tower' }, doc: moved } });
  assert.equal(put.status, 200);

  const before = await api('/api/investment-analysis/' + analysisId);
  assert.equal(before.body.source.budgetVersionNumber, 1);
  assert.equal(before.body.source.drift, true, 'the budget moved past the analysis');

  // The copy on screen carries an unsaved edit outside the imported fields.
  const onScreen = JSON.parse(JSON.stringify(before.body.input));
  onScreen.disposition.exitCapRate.value = 0.071;
  const proposal = await api('/api/investment-analysis/' + analysisId + '?scope=resync', { method: 'PUT',
    body: { input: onScreen } });
  assert.equal(proposal.status, 200);
  assert.equal(proposal.body.source.budgetVersionNumber, 2);
  assert.ok(proposal.body.input.acquisition.basis.value > before.body.input.acquisition.basis.value,
    'the proposal carries the budget’s new purchase price');
  assert.equal(proposal.body.input.disposition.exitCapRate.value, 0.071,
    'and keeps the unsaved edit it was sent');

  const untouched = await api('/api/investment-analysis/' + analysisId);
  assert.deepEqual(untouched.body.input, before.body.input, 'the stored inputs did not move');
  assert.equal(untouched.body.source.budgetVersionNumber, 1, 'nor did the source');
  assert.equal(untouched.body.source.drift, true, 'so the drift is still reported');
  assert.equal(untouched.body.currentVersionNumber, before.body.currentVersionNumber,
    'and no version was written');

  const forged = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input: proposal.body.input, expectedVersionNumber: before.body.currentVersionNumber,
            resyncBudgetVersionId: 99 } });
  assert.equal(forged.status, 400, 'a version that is not this budget’s is refused');

  const saved = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input: proposal.body.input, expectedVersionNumber: before.body.currentVersionNumber,
            resyncBudgetVersionId: proposal.body.source.budgetVersionId } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.versionCreated, true);
  const after = await api('/api/investment-analysis/' + analysisId);
  assert.equal(after.body.source.budgetVersionNumber, 2, 'the save re-pinned the analysis');
  assert.equal(after.body.source.drift, false);
  assert.equal(after.body.input.acquisition.basis.value, proposal.body.input.acquisition.basis.value);
  assert.equal(after.body.result.summary.purchasePrice, proposal.body.input.acquisition.basis.value,
    'and the stored result is the one calculated from the re-synced inputs');

  const backwards = await api('/api/investment-analysis/' + analysisId, { method: 'PUT',
    body: { input: after.body.input, expectedVersionNumber: after.body.currentVersionNumber,
            resyncBudgetVersionId: 1 } });
  assert.equal(backwards.status, 400, 're-syncing can only move forward');
});
