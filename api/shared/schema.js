// Optional-column probe.
//
// A deploy and its SQL migration are separate acts, and the deploy usually
// lands first. Code that references a column the database does not have yet
// fails the whole request — "Invalid column name 'AppRole'" — which is how a
// pending migration turns into a blank Home page and a red banner rather than
// a feature that is merely not switched on yet.
//
// So the columns added by sql/migrate_roles_and_ownership.sql are treated as
// optional: this module asks the database what actually exists, and the
// callers build SQL that only names real columns. Before the migration the
// app behaves exactly as it did before the feature; after it, ownership
// filtering and roles light up on their own.
//
// The answer is cached briefly rather than forever, so running the migration
// takes effect on its own within a minute instead of needing a restart.
const TTL_MS = 60000;

let cache = null;
let cachedAt = 0;
let inflight = null;

async function probe(pool) {
  const r = await pool.request().query(
    `SELECT o.name AS TableName, c.name AS ColumnName
     FROM sys.columns AS c
     JOIN sys.objects AS o ON o.object_id = c.object_id
     WHERE o.name IN ('Users', 'Budgets', 'InvestmentAnalyses', 'Feedback', 'Projects', 'Entities', 'Contracts')`);
  const has = new Set(r.recordset.map(x => x.TableName + '.' + x.ColumnName));
  return {
    usersAppRole:      has.has('Users.AppRole'),
    usersSettingsDoc:  has.has('Users.SettingsDoc'),
    budgetsCreatedBy:  has.has('Budgets.CreatedById') && has.has('Budgets.CreatedByName'),
    analysesCreatedBy: has.has('InvestmentAnalyses.CreatedById'),
    budgetsGuardrail:  has.has('Budgets.GuardrailStatus') && has.has('Budgets.GuardrailBreachCount'),
    budgetsProjectKey: has.has('Budgets.ProjectKey'),
    analysesProjectKey: has.has('InvestmentAnalyses.ProjectKey'),
    // sql/adopt_project_numbers.sql — the identifier model's first step here.
    projectsNumber: has.has('Projects.ProjectNumber'),
    analysesItemNumber: has.has('InvestmentAnalyses.ItemNumber'),
    // A whole table rather than a column: any column of it proves it exists.
    feedbackTable:     has.has('Feedback.FeedbackId'),
    projectsTable:     has.has('Projects.ProjectId'),
    // Budgeting-suite expansion — each gated by its own migration.
    entitiesTable:     has.has('Entities.EntityId'),        // sql/migrate_entities.sql
    projectsEntityId:  has.has('Projects.EntityId'),        // sql/migrate_entities.sql
    budgetsApproved:   has.has('Budgets.ApprovedVersionId'),// sql/migrate_budget_approval.sql
    contractsTable:    has.has('Contracts.ContractId')      // sql/migrate_contracts.sql
  };
}

// Never throws: if the probe itself fails, every optional column is reported
// absent, which is the conservative answer — the request still succeeds using
// only columns that have always existed.
async function features(pool) {
  const now = Date.now();
  if (cache && (now - cachedAt) < TTL_MS) return cache;
  if (inflight) return inflight;
  inflight = probe(pool)
    .then(f => { cache = f; cachedAt = Date.now(); return f; })
    .catch(() => ({
      usersAppRole: false, usersSettingsDoc: false,
      budgetsCreatedBy: false, analysesCreatedBy: false, feedbackTable: false,
      budgetsGuardrail: false, budgetsProjectKey: false, analysesProjectKey: false,
      projectsNumber: false, analysesItemNumber: false,
      projectsTable: false,
      entitiesTable: false, projectsEntityId: false,
      budgetsApproved: false, contractsTable: false
    }))
    .finally(() => { inflight = null; });
  return inflight;
}

module.exports = { features, _reset: () => { cache = null; cachedAt = 0; } };
