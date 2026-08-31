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
const { parts } = require('./budget-calc');
const F = require('./budget-finance');

const PROJECT_ENTITY = '__project_entity__';
const STREAM_LABEL = { primary: 'Construction contract', companyMarkup: 'Construction subcontract',
  devFee: 'Developer fee', mktFee: 'Marketing / Brokerage', clsFee: 'Closing costs' };

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
    contractsFlagged = await reviewContractsAgainstApproved(pool, id, v.Id, principal);
  }

  await recordActivity(pool, principal, 'budget_approve', 'budget', id,
    { name: row.Name || null, projectKey: row.ProjectKey || null,
      versionNumber: v.VersionNumber, contractsFlagged: contractsFlagged });
  return jsonRes(200, { ok: true, approvedVersionNumber: v.VersionNumber, contractsFlagged: contractsFlagged });
}

/* ---- shared helpers ---------------------------------------------------- */
async function loadEntities(pool) {
  const r = await pool.request().query('SELECT EntityId, EntityKey, LegalName, DisplayName FROM dbo.Entities');
  const byKey = {}, byId = {};
  r.recordset.forEach(e => {
    byKey[e.EntityKey] = { entityId: e.EntityId, entityKey: e.EntityKey, legalName: e.LegalName, displayName: e.DisplayName };
    byId[e.EntityId] = byKey[e.EntityKey];
  });
  return { byKey, byId, list: r.recordset.map(e => ({ entityKey: e.EntityKey, displayName: e.DisplayName, legalName: e.LegalName })) };
}

// The expected contract plan for a budget's approved version, plus the context
// needed to write or reconcile it. Returns null when not approved.
async function approvedPlan(pool, budgetId) {
  const b = await pool.request().input('id', sql.VarChar(16), budgetId)
    .query(`SELECT ProjectKey, ApprovedVersionId FROM dbo.Budgets WHERE ProjectId=@id AND IsDeleted=0`);
  if (!b.recordset.length) return { notFound: true };
  const row = b.recordset[0];
  if (!row.ApprovedVersionId) return { projectKey: row.ProjectKey, approved: null };
  const v = await pool.request().input('vid', sql.BigInt, row.ApprovedVersionId)
    .query('SELECT Id, VersionNumber, Doc FROM dbo.BudgetVersions WHERE Id=@vid');
  if (!v.recordset.length) return { projectKey: row.ProjectKey, approved: null };
  let doc; try { doc = JSON.parse(v.recordset[0].Doc); } catch (e) { doc = {}; }
  const ents = await loadEntities(pool);
  const p = parts(doc);
  const alloc = F.allocate({ doc: doc, parts: p, finance: F.financeFor(doc), entities: ents.list });
  const plan = F.contractPlan(alloc, p);
  return { projectKey: row.ProjectKey, ents: ents,
    approved: { versionId: v.recordset[0].Id, versionNumber: v.recordset[0].VersionNumber },
    parts: p, alloc: alloc, plan: plan };
}

function shapeContract(c, ents) {
  const ent = k => (ents && ents.byId[k]) ? ents.byId[k].displayName : null;
  return {
    contractId: c.ContractId, budgetId: c.BudgetId, projectKey: c.ProjectKey,
    budgetVersionId: c.BudgetVersionId,
    contractingEntityId: c.ContractingEntityId, contractingEntity: ent(c.ContractingEntityId),
    performingEntityId: c.PerformingEntityId, performingEntity: ent(c.PerformingEntityId),
    allocationKey: c.AllocationKey,
    originalAmount: Number(c.OriginalAmount), currentAmount: Number(c.CurrentAmount),
    profitAmount: c.ProfitAmount == null ? null : Number(c.ProfitAmount),
    scope: c.Scope || '', effectiveDate: c.EffectiveDate,
    status: c.Status, reviewNote: c.ReviewNote || null, updated: c.UpdatedAt
  };
}

async function liveContractRows(pool, budgetId) {
  const r = await pool.request().input('id', sql.VarChar(16), budgetId)
    .query(`SELECT * FROM dbo.Contracts WHERE BudgetId=@id AND IsDeleted=0 ORDER BY ContractId`);
  return r.recordset;
}

/* ---- GET  /api/budget/{id}?scope=contracts ----------------------------- */
async function listContracts(pool, budgetId) {
  const f = await features(pool);
  if (!f.contractsTable) return { available: false, contracts: [], reconciliation: null, approved: null };
  const ctx = await approvedPlan(pool, budgetId);
  if (ctx.notFound) return { available: true, notFound: true, contracts: [], reconciliation: null, approved: null };
  const ents = ctx.ents || await loadEntities(pool);
  const rows = await liveContractRows(pool, budgetId);
  const contracts = rows.map(c => shapeContract(c, ents));
  let reconciliation = null;
  if (ctx.approved) {
    reconciliation = F.reconcile(ctx.plan, rows.map(c => ({
      contractId: c.ContractId, allocationKey: c.AllocationKey, currentAmount: Number(c.CurrentAmount),
      performingEntityKey: (ents.byId[c.PerformingEntityId] || {}).entityKey, status: c.Status })));
  }
  return { available: true,
    approved: ctx.approved ? { versionNumber: ctx.approved.versionNumber } : null,
    contracts: contracts, reconciliation: reconciliation };
}

/* ---- PUT  /api/budget/{id}?scope=contracts  {generate:true} ------------ */
async function generateContracts(pool, budgetId, body, principal) {
  const f = await features(pool);
  if (!f.contractsTable) return jsonRes(503, { error: 'not_migrated',
    message: 'Contracts need sql/migrate_contracts.sql to be run against this database.' });
  const role = await appRoleOf(pool, principal);
  if (!APPROVE_ROLES.has(role)) return jsonRes(403, { error: 'forbidden',
    message: 'Generating contracts requires the director or super_admin role.' });

  const ctx = await approvedPlan(pool, budgetId);
  if (ctx.notFound) return jsonRes(404, { error: 'not_found', message: 'Budget not found.' });
  if (!ctx.approved) return jsonRes(400, { error: 'not_approved',
    message: 'Approve a budget version before generating contracts — contracts are cut from the approved allocation.' });

  // The project's legal entity is the top of the contract chain.
  const proj = await pool.request().input('pk', sql.VarChar(16), ctx.projectKey)
    .query('SELECT EntityId FROM dbo.Projects WHERE ProjectId=@pk AND IsDeleted=0');
  const projectEntityId = proj.recordset.length ? proj.recordset[0].EntityId : null;
  if (!projectEntityId) return jsonRes(400, { error: 'no_project_entity',
    message: 'Set the Project Entity on the project before generating contracts.' });

  const ents = ctx.ents;
  const effectiveDate = body && body.effectiveDate ? String(body.effectiveDate).slice(0, 10) : null;

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    // Prior live contracts for this budget are superseded, never edited.
    await new sql.Request(tx).input('id', sql.VarChar(16), budgetId)
      .query(`UPDATE dbo.Contracts SET Status='Superseded', UpdatedAt=SYSUTCDATETIME()
              WHERE BudgetId=@id AND IsDeleted=0 AND Status IN ('Generated','Requires Review')`);
    let generated = 0;
    for (const pr of ctx.plan.rows) {
      const fromId = pr.contractingEntityKey === PROJECT_ENTITY ? projectEntityId
        : (ents.byKey[pr.contractingEntityKey] || {}).entityId;
      const toEnt = ents.byKey[pr.performingEntityKey];
      if (!fromId || !toEnt) continue;    // an entity not in the master is skipped, not guessed
      await new sql.Request(tx)
        .input('bid', sql.VarChar(16), budgetId)
        .input('pk', sql.VarChar(16), ctx.projectKey)
        .input('vid', sql.BigInt, ctx.approved.versionId)
        .input('pe', sql.Int, projectEntityId)
        .input('ce', sql.Int, fromId)
        .input('pf', sql.Int, toEnt.entityId)
        .input('ak', sql.VarChar(80), pr.allocationKey)
        .input('amt', sql.Decimal(18, 2), pr.amount)
        .input('profit', sql.Decimal(18, 2), pr.profit == null ? null : pr.profit)
        .input('scope', sql.NVarChar(1000), STREAM_LABEL[pr.stream] || pr.stream)
        .input('eff', sql.Date, effectiveDate)
        .input('cuid', sql.NVarChar(128), principal ? (principal.userId || null) : null)
        .input('cuname', sql.NVarChar(200), principal ? (principal.userDetails || null) : null)
        .query(`INSERT INTO dbo.Contracts
                  (BudgetId, ProjectKey, BudgetVersionId, ProjectEntityId, ContractingEntityId, PerformingEntityId,
                   AllocationKey, OriginalAmount, CurrentAmount, ProfitAmount, Scope, EffectiveDate, Status, CreatedById, CreatedByName)
                VALUES (@bid, @pk, @vid, @pe, @ce, @pf, @ak, @amt, @amt, @profit, @scope, @eff, 'Generated', @cuid, @cuname)`);
      generated++;
    }
    await tx.commit();
    await recordActivity(pool, principal, 'contract_generate', 'budget', budgetId,
      { count: generated, versionNumber: ctx.approved.versionNumber });
    const after = await listContracts(pool, budgetId);
    return jsonRes(201, { ok: true, generated: generated, contracts: after.contracts, reconciliation: after.reconciliation });
  } catch (e) { try { await tx.rollback(); } catch (_) {} throw e; }
}

/* ---- PUT  /api/budget/{id}?scope=contract  {contractId, action} -------- */
async function contractAction(pool, budgetId, body, principal) {
  const f = await features(pool);
  if (!f.contractsTable) return jsonRes(503, { error: 'not_migrated', message: 'Contracts are not available yet.' });
  const role = await appRoleOf(pool, principal);
  if (!APPROVE_ROLES.has(role)) return jsonRes(403, { error: 'forbidden',
    message: 'Changing a contract requires the director or super_admin role.' });
  body = body || {};
  const cid = Number(body.contractId);
  if (!(Number.isInteger(cid) && cid > 0)) return jsonRes(400, { error: 'bad_request', message: 'contractId is required.' });
  const cr = await pool.request().input('cid', sql.Int, cid).input('bid', sql.VarChar(16), budgetId)
    .query('SELECT * FROM dbo.Contracts WHERE ContractId=@cid AND BudgetId=@bid AND IsDeleted=0');
  if (!cr.recordset.length) return jsonRes(404, { error: 'not_found', message: 'Contract not found.' });
  const c = cr.recordset[0];

  if (body.action === 'void') {
    await pool.request().input('cid', sql.Int, cid)
      .query(`UPDATE dbo.Contracts SET Status='Void', UpdatedAt=SYSUTCDATETIME() WHERE ContractId=@cid`);
    await recordActivity(pool, principal, 'contract_status', 'budget', budgetId, { contractId: cid, to: 'Void' });
    return jsonRes(200, { ok: true, status: 'Void' });
  }
  if (body.action === 'accept') {
    // Re-pin to the current approved allocation. OriginalAmount never moves.
    const ctx = await approvedPlan(pool, budgetId);
    if (!ctx.approved) return jsonRes(400, { error: 'not_approved', message: 'No approved version to reconcile against.' });
    const planRow = ctx.plan.rows.filter(r => r.allocationKey === c.AllocationKey)[0];
    if (!planRow) return jsonRes(409, { error: 'no_allocation',
      message: 'This contract no longer matches any allocation in the approved budget. Void it instead.' });
    await pool.request().input('cid', sql.Int, cid)
      .input('amt', sql.Decimal(18, 2), planRow.amount)
      .input('vid', sql.BigInt, ctx.approved.versionId)
      .query(`UPDATE dbo.Contracts SET CurrentAmount=@amt, BudgetVersionId=@vid, Status='Generated',
                ReviewNote=NULL, UpdatedAt=SYSUTCDATETIME() WHERE ContractId=@cid`);
    await recordActivity(pool, principal, 'contract_status', 'budget', budgetId, { contractId: cid, to: 'Generated', accepted: true });
    return jsonRes(200, { ok: true, status: 'Generated', currentAmount: planRow.amount });
  }
  return jsonRes(400, { error: 'bad_request', message: "action must be 'accept' or 'void'." });
}

/* The reviewer the approval path calls after a re-approval moves the pin, and
   the project-entity change path uses via the same table. Compares each live
   contract against the newly approved allocation; a mismatch is flagged
   'Requires Review' with the variance — never silently rewritten. */
async function reviewContracts(pool, budgetId, approvedVersionId, principal) {
  const v = await pool.request().input('vid', sql.BigInt, approvedVersionId)
    .query('SELECT Doc FROM dbo.BudgetVersions WHERE Id=@vid');
  if (!v.recordset.length) return 0;
  let doc; try { doc = JSON.parse(v.recordset[0].Doc); } catch (e) { return 0; }
  const ents = await loadEntities(pool);
  const p = parts(doc);
  const alloc = F.allocate({ doc: doc, parts: p, finance: F.financeFor(doc), entities: ents.list });
  const plan = F.contractPlan(alloc, p);
  const planByKey = {};
  plan.rows.forEach(r => { planByKey[r.allocationKey] = r; });
  const rows = await liveContractRows(pool, budgetId);
  let flagged = 0;
  for (const c of rows) {
    if (c.Status === 'Void' || c.Status === 'Superseded') continue;
    const pr = planByKey[c.AllocationKey];
    const expected = pr ? pr.amount : null;
    const variance = expected == null ? null : Math.round((Number(c.CurrentAmount) - expected) * 100) / 100;
    if (expected == null || Math.abs(variance) >= 1) {
      const note = expected == null
        ? 'Allocation no longer exists in the approved budget.'
        : 'Approved allocation ' + expected.toFixed(2) + ' vs contract ' + Number(c.CurrentAmount).toFixed(2) + ' (variance ' + variance.toFixed(2) + ').';
      await pool.request().input('cid', sql.Int, c.ContractId).input('note', sql.NVarChar(1000), note)
        .query(`UPDATE dbo.Contracts SET Status='Requires Review', ReviewNote=@note, UpdatedAt=SYSUTCDATETIME() WHERE ContractId=@cid`);
      flagged++;
    }
  }
  if (flagged) await recordActivity(pool, principal, 'contract_review', 'budget', budgetId, { flagged: flagged });
  return flagged;
}

// Install the reviewer so approveBudget re-checks contracts on a re-approval.
reviewContractsAgainstApproved = reviewContracts;

module.exports = { approveBudget, appRoleOf, APPROVE_ROLES, jsonRes,
  listContracts, generateContracts, contractAction, reviewContracts,
  _setContractReviewer: fn => { reviewContractsAgainstApproved = fn; } };
