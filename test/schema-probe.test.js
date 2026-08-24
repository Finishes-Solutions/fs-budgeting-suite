// The optional-column probe in api/shared/schema.js is what keeps a deploy
// that lands before its SQL migration from taking the app down: a pending
// migration must read as "feature not on yet", never as a failed request.
//
// These tests drive it with a fake pool so no database is involved.
const { test } = require('node:test');
const assert = require('node:assert');
const schema = require('../api/shared/schema');

// Minimal stand-in for the mssql pool surface schema.js uses.
const poolReturning = (rows) => ({
  request: () => ({ query: async () => ({ recordset: rows }) })
});
const poolThrowing = (err) => ({
  request: () => ({ query: async () => { throw err; } })
});

const col = (TableName, ColumnName) => ({ TableName, ColumnName });

const MIGRATED = [
  col('Users', 'AppRole'), col('Users', 'SettingsDoc'),
  col('Budgets', 'CreatedById'), col('Budgets', 'CreatedByName'),
  col('InvestmentAnalyses', 'CreatedById'),
  col('Feedback', 'FeedbackId'),
  col('FeeSchedules', 'ScheduleKey'), col('FeeScheduleVersions', 'ScheduleKey')
];

// Every case starts from a clean cache, or one test's answer leaks into the next.
const fresh = () => schema._reset();

test('a migrated database reports every optional column present', async () => {
  fresh();
  const f = await schema.features(poolReturning(MIGRATED));
  assert.strictEqual(f.usersAppRole, true);
  assert.strictEqual(f.usersSettingsDoc, true);
  assert.strictEqual(f.budgetsCreatedBy, true);
  assert.strictEqual(f.analysesCreatedBy, true);
  assert.strictEqual(f.feedbackTable, true);
});

test('a database without the feedback table reports it absent', async () => {
  fresh();
  // A whole table rather than a column, but the consequence is the same: the
  // endpoint must say which script to run instead of failing the request.
  const f = await schema.features(poolReturning(MIGRATED.filter(c => c.TableName !== 'Feedback')));
  assert.strictEqual(f.feedbackTable, false);
  assert.strictEqual(f.usersAppRole, true, 'the other features are unaffected');
});

test('a database without the roles migration reports those columns absent', async () => {
  fresh();
  // Exactly the state that took staging down: Users exists with SettingsDoc,
  // but AppRole and the Budgets ownership columns have not been added.
  const f = await schema.features(poolReturning([
    col('Users', 'SettingsDoc'), col('InvestmentAnalyses', 'CreatedById')
  ]));
  assert.strictEqual(f.usersAppRole, false, 'AppRole must read as absent');
  assert.strictEqual(f.budgetsCreatedBy, false, 'Budgets ownership must read as absent');
  assert.strictEqual(f.usersSettingsDoc, true);
  assert.strictEqual(f.analysesCreatedBy, true);
});

test('CreatedById without CreatedByName still counts as not migrated', async () => {
  fresh();
  // A half-applied migration must not be treated as done, or the INSERT would
  // name a column that is not there.
  const f = await schema.features(poolReturning([col('Budgets', 'CreatedById')]));
  assert.strictEqual(f.budgetsCreatedBy, false);
});

test('a failing probe degrades to all-absent rather than throwing', async () => {
  fresh();
  const f = await schema.features(poolThrowing(new Error('permission denied on sys.columns')));
  assert.deepStrictEqual(f, {
    usersAppRole: false, usersSettingsDoc: false,
    budgetsCreatedBy: false, analysesCreatedBy: false, feedbackTable: false,
    budgetsGuardrail: false, budgetsProjectKey: false, analysesProjectKey: false,
    projectsNumber: false, analysesItemNumber: false,
    projectsTable: false, feeSchedulesTable: false
  });
});

test('projects and guard rails read as absent before their migration runs', async () => {
  fresh();
  // The shape a database has TODAY: roles and ownership migrated, projects not.
  // Every project and guard-rail read path must fall back to today's behaviour,
  // because a deploy lands before its migration.
  const f = await schema.features(poolReturning([
    col('Users', 'AppRole'), col('Users', 'SettingsDoc'),
    col('Budgets', 'CreatedById'), col('Budgets', 'CreatedByName'),
    col('InvestmentAnalyses', 'CreatedById'), col('Feedback', 'FeedbackId')
  ]));
  assert.strictEqual(f.budgetsCreatedBy, true, 'the already-run migration still reads as done');
  assert.strictEqual(f.projectsTable, false);
  assert.strictEqual(f.budgetsProjectKey, false);
  assert.strictEqual(f.analysesProjectKey, false);
  assert.strictEqual(f.budgetsGuardrail, false);
});

test('a half-applied guard-rail migration counts as not migrated', async () => {
  fresh();
  // Naming GuardrailBreachCount when only GuardrailStatus exists would fail
  // every save — both columns or neither.
  const f = await schema.features(poolReturning([col('Budgets', 'GuardrailStatus')]));
  assert.strictEqual(f.budgetsGuardrail, false);
});

test('the full projects migration lights up every project read path', async () => {
  fresh();
  const f = await schema.features(poolReturning([
    col('Projects', 'ProjectId'), col('Budgets', 'ProjectKey'),
    col('InvestmentAnalyses', 'ProjectKey'),
    col('Budgets', 'GuardrailStatus'), col('Budgets', 'GuardrailBreachCount')
  ]));
  assert.strictEqual(f.projectsTable, true);
  assert.strictEqual(f.budgetsProjectKey, true);
  assert.strictEqual(f.analysesProjectKey, true);
  assert.strictEqual(f.budgetsGuardrail, true);
  // The identifier-model columns are a LATER migration: the project paths
  // lighting up must not imply item numbers exist.
  assert.strictEqual(f.projectsNumber, false);
  assert.strictEqual(f.analysesItemNumber, false);
});

test('the identifier-model columns light up with their own migration', async () => {
  fresh();
  const f = await schema.features(poolReturning([
    col('Projects', 'ProjectId'), col('Projects', 'ProjectNumber'),
    col('Budgets', 'ProjectKey'), col('InvestmentAnalyses', 'ProjectKey'),
    col('InvestmentAnalyses', 'ItemNumber')
  ]));
  assert.strictEqual(f.projectsNumber, true);
  assert.strictEqual(f.analysesItemNumber, true);
});

test('the probe is cached, so it does not run per request', async () => {
  fresh();
  let calls = 0;
  const counting = {
    request: () => ({ query: async () => { calls++; return { recordset: MIGRATED }; } })
  };
  await schema.features(counting);
  await schema.features(counting);
  await schema.features(counting);
  assert.strictEqual(calls, 1, 'expected one probe for three calls');
});

test('concurrent first calls share a single probe', async () => {
  fresh();
  let calls = 0;
  const counting = {
    request: () => ({ query: async () => {
      calls++;
      await new Promise(r => setTimeout(r, 10));
      return { recordset: MIGRATED };
    } })
  };
  const [a, b, c] = await Promise.all([
    schema.features(counting), schema.features(counting), schema.features(counting)
  ]);
  assert.strictEqual(calls, 1, 'a cold start must not stampede the probe');
  assert.strictEqual(a.usersAppRole, true);
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(b, c);
});

test('a database without the impact-fee migration reports the fee library absent', async () => {
  fresh();
  // The state the release lands in: the deploy is live, sql/migrate_impact_fees.sql
  // has not been run yet. The fee-schedule scopes must answer with an empty list,
  // which is what "not on yet" looks like — never a failed request, because
  // /api/pricing also serves the pricing library every budget depends on.
  const f = await schema.features(poolReturning(
    MIGRATED.filter(c => !c.TableName.startsWith('FeeSchedule'))));
  assert.strictEqual(f.feeSchedulesTable, false);
  assert.strictEqual(f.usersAppRole, true, 'the other features are unaffected');
});

test('half the impact-fee migration still reads as absent', async () => {
  fresh();
  // Both tables or neither: the read joins versions to schedules, so one without
  // the other would fail the query the probe exists to prevent.
  const f = await schema.features(poolReturning(
    MIGRATED.filter(c => c.TableName !== 'FeeScheduleVersions')));
  assert.strictEqual(f.feeSchedulesTable, false);
});

test('a migrated database reports the fee library present', async () => {
  fresh();
  const f = await schema.features(poolReturning(MIGRATED));
  assert.strictEqual(f.feeSchedulesTable, true);
});
