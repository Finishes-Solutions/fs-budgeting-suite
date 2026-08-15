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
  assert.equal(pre.property.size.value, 80000, 'falls back to res+amen SF when siteSF is 0');
  assert.equal(pre.property.purchaseMonth, null, 'no invented purchase month');
  assert.equal(pre.expenses.value, null, 'service expenses are NOT prefilled as complete OPEX');
  assert.equal(pre.source.support.annualServiceExpenses, 12 * 10 * 30, 'they appear as support data');
  assert.ok(pre.source.fieldOrigins['acquisition.basis'].includes('Total Project Cost'));

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
