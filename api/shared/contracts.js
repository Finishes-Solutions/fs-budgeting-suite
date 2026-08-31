// Budget approval and (Phase 7) contract generation / reconciliation.
//
// Approval is the deliberate act that pins one immutable BudgetVersions row as
// the allocation contracts are cut from. It is director+ only, and it is the
// only thing (besides a project-entity change) that re-checks existing
// contracts — a working-budget save never touches them.
//
// Reads/writes ride scopes on api/budget (a new api/<name>/ folder is not
// reliably picked up by the deployed host), so the in-function role check here
// is the only gate.
const { sql } = require('./db');
const { features } = require('./schema');
const { ensureUser, recordActivity } = require('./users');

function jsonRes(status, body) {
  return { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body) };
}

const APPROVE_ROLES = new Set(['director', 'super_admin']);

// Phase 7 installs the contract reviewer via _setContractReviewer; until then a
// re-approval has no contracts to flag.
let reviewContractsAgainstApproved = null;

async function appRoleOf(pool, principal) {
  if (!principal || !principal.userId) return 'user';
  // A super_admin SWA platform role implies the app privilege even before the
  // Users row is written.
  if (Array.isArray(principal.userRoles) && principal.userRoles.includes('super_admin')) return 'super_admin';
  try { const row = await ensureUser(pool, principal, {}); return (row && row.AppRole) || 'user'; }
  catch (e) { return 'user'; }
}

// PUT /api/budget/{id}?scope=approve  — {} pins the latest version, {clear:true}
// unpins. On a change of the pin, re-checks contracts (Phase 7).
async function approveBudget(pool, id, body, principal) {
  const f = await features(pool);
  if (!f.budgetsApproved) return jsonRes(503, { error: 'not_migrated',
    message: 'Budget approval needs sql/migrate_budget_approval.sql to be run against this database.' });

  const role = await appRoleOf(pool, principal);
  if (!APPROVE_ROLES.has(role)) return jsonRes(403, { error: 'forbidden',
    message: 'Approving a budget requires the director or super_admin role.' });

  const cur = await pool.request().input('id', sql.VarChar(16), id)
    .query('SELECT ProjectId, Name, ProjectKey, ApprovedVersionId FROM dbo.Budgets WHERE ProjectId=@id AND IsDeleted=0');
  if (!cur.recordset.length) return jsonRes(404, { error: 'not_found', message: 'Budget not found.' });
  const row = cur.recordset[0];

  if (body && body.clear === true) {
    await pool.request().input('id', sql.VarChar(16), id)
      .query(`UPDATE dbo.Budgets SET ApprovedVersionId=NULL, ApprovedAt=NULL,
                ApprovedById=NULL, ApprovedByName=NULL, UpdatedAt=SYSUTCDATETIME()
              WHERE ProjectId=@id AND IsDeleted=0`);
    await recordActivity(pool, principal, 'budget_approve', 'budget', id,
      { name: row.Name || null, projectKey: row.ProjectKey || null, cleared: true });
    return jsonRes(200, { ok: true, approvedVersionNumber: null, cleared: true });
  }

  const ver = await pool.request().input('id', sql.VarChar(16), id)
    .query(`SELECT TOP 1 Id, VersionNumber FROM dbo.BudgetVersions
            WHERE ProjectId=@id ORDER BY VersionNumber DESC`);
  if (!ver.recordset.length) return jsonRes(400, { error: 'no_version',
    message: 'Save the budget at least once before approving — there is no version to pin.' });
  const v = ver.recordset[0];

  await pool.request().input('id', sql.VarChar(16), id)
    .input('vid', sql.BigInt, v.Id)
    .input('uid', sql.NVarChar(128), principal ? (principal.userId || null) : null)
    .input('uname', sql.NVarChar(200), principal ? (principal.userDetails || null) : null)
    .query(`UPDATE dbo.Budgets SET ApprovedVersionId=@vid, ApprovedAt=SYSUTCDATETIME(),
              ApprovedById=@uid, ApprovedByName=@uname, UpdatedAt=SYSUTCDATETIME()
            WHERE ProjectId=@id AND IsDeleted=0`);

  // Re-check contracts against the newly approved allocation (Phase 7). Until
  // the contracts table exists there is nothing to flag.
  let contractsFlagged = 0;
  if (f.contractsTable && typeof reviewContractsAgainstApproved === 'function') {
    contractsFlagged = await reviewContractsAgainstApproved(pool, id, v.Id);
  }

  await recordActivity(pool, principal, 'budget_approve', 'budget', id,
    { name: row.Name || null, projectKey: row.ProjectKey || null,
      versionNumber: v.VersionNumber, contractsFlagged: contractsFlagged });
  return jsonRes(200, { ok: true, approvedVersionNumber: v.VersionNumber, contractsFlagged: contractsFlagged });
}

module.exports = { approveBudget, appRoleOf, APPROVE_ROLES, jsonRes,
  _setContractReviewer: fn => { reviewContractsAgainstApproved = fn; } };
