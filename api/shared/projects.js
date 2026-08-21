// The Projects aggregate — the parent of budgets and investment analyses.
//
// It lives here rather than in an api/projects/ folder on purpose: a NEW
// function folder is not reliably picked up by the deployed host (see
// AGENTS.md — api/admin-roles/ answered 404 across two deploys while every
// established endpoint kept working). So the project surface is query scopes
// on endpoints that already deploy:
//
//   GET /api/budgets?scope=projects            the project index
//   GET /api/budgets?scope=project&id=BD-0001  one project + children
//   PUT /api/budget/{id}?scope=project         project metadata and status
//
// SECURITY NOTE, and it is not a footnote: a staticwebapp.config.json route
// rule matches PATHS, not query strings. It cannot see ?scope=project. The
// in-function checks in this module are therefore the ONLY gate on these
// scopes and must be written as the real gate, never as defence in depth.

const { sql } = require('./db');
const { features } = require('./schema');

const PROJECT_ID_RX = /^(OP|BD|AS|TST)-\d{4}$/;
const BUDGET_ID_RX = /^(OP|BD|AS|TST)-\d{4}(-\d{2})?$/;

// The deal pipeline, ending in the status the analytics dashboard counts as
// real work won. On Hold and Lost are side-states, not steps.
const PROJECT_STATUSES = [
  'Lead', 'Qualified', 'Budgeting', 'Proposal Sent', 'Awarded',
  'Converted to Project', 'On Hold', 'Lost'
];
const CONVERTED = 'Converted to Project';

// A budget id with any alternate suffix stripped. BD-0001-02 belongs to
// BD-0001; BD-0001 belongs to itself.
function projectKeyOf(id) {
  const s = String(id || '').toUpperCase();
  return /^(OP|BD|AS|TST)-\d{4}-\d{2}$/.test(s) ? s.slice(0, -3) : s;
}

const jsonRes = (status, body) => ({
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

// Creates the project row a budget belongs to if it is not there yet, so a
// budget saved before its project existed still rolls up. Never overwrites an
// existing project — the project owns its own name and status once created.
async function ensureProject(pool, budgetId, seed) {
  const f = await features(pool);
  if (!f.projectsTable) return null;
  const key = projectKeyOf(budgetId);
  if (!PROJECT_ID_RX.test(key)) return null;
  seed = seed || {};
  await pool.request()
    .input('pid', sql.VarChar(16), key)
    .input('name', sql.NVarChar(200), seed.name || key)
    .input('addr', sql.NVarChar(300), seed.address || '')
    .input('type', sql.NVarChar(50), seed.type || 'Multifamily')
    .input('bid', sql.VarChar(16), budgetId)
    .input('cuid', sql.NVarChar(128), seed.userId || null)
    .input('cuname', sql.NVarChar(200), seed.userName || null)
    .query(`IF NOT EXISTS (SELECT 1 FROM dbo.Projects WHERE ProjectId = @pid)
              INSERT INTO dbo.Projects (ProjectId, Name, Address, Type, PrimaryBudgetId,
                                        CreatedById, CreatedByName)
              VALUES (@pid, @name, @addr, @type, @bid, @cuid, @cuname);`);
  return key;
}

// The project index: one row per project with its children rolled up. Money
// for a converted project is the SNAPSHOT taken at conversion, so reported
// backlog does not move when someone edits a budget afterwards.
async function listProjects(pool, opts) {
  const f = await features(pool);
  if (!f.projectsTable) return { available: false, projects: [] };
  const rq = pool.request();
  let where = 'p.IsDeleted = 0';
  if (opts && opts.ownerId) {
    rq.input('uid', sql.NVarChar(128), opts.ownerId);
    where += ` AND EXISTS (SELECT 1 FROM dbo.Budgets AS ob
                           WHERE ob.ProjectKey = p.ProjectId AND ob.IsDeleted = 0
                             AND (ob.CreatedById = @uid OR ob.CreatedById IS NULL))`;
  }
  const grCols = f.budgetsGuardrail
    ? `(SELECT COUNT(*) FROM dbo.Budgets AS gb
        WHERE gb.ProjectKey = p.ProjectId AND gb.IsDeleted = 0 AND gb.GuardrailStatus = 'breach') AS BreachCount`
    : 'CAST(NULL AS INT) AS BreachCount';

  const r = await rq.query(
    `SELECT p.ProjectId, p.Name, p.Address, p.Type, p.Status, p.PrimaryBudgetId,
            p.ConvertedAt, p.ContractAmount, p.ProjectAmount,
            p.CreatedById, p.CreatedByName, p.CreatedAt, p.UpdatedAt,
            (SELECT COUNT(*) FROM dbo.Budgets AS b
              WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0) AS BudgetCount,
            (SELECT COUNT(*) FROM dbo.InvestmentAnalyses AS a
              WHERE a.ProjectKey = p.ProjectId AND a.IsDeleted = 0) AS AnalysisCount,
            (SELECT SUM(b2.ContractSum) FROM dbo.Budgets AS b2
              WHERE b2.ProjectKey = p.ProjectId AND b2.IsDeleted = 0
                AND b2.ProjectId = ISNULL(p.PrimaryBudgetId, b2.ProjectId)) AS LiveContractSum,
            (SELECT SUM(b3.ProjectCost) FROM dbo.Budgets AS b3
              WHERE b3.ProjectKey = p.ProjectId AND b3.IsDeleted = 0
                AND b3.ProjectId = ISNULL(p.PrimaryBudgetId, b3.ProjectId)) AS LiveProjectCost,
            ${grCols}
     FROM dbo.Projects AS p
     WHERE ${where}
     ORDER BY p.UpdatedAt DESC`);

  return { available: true, statuses: PROJECT_STATUSES, projects: r.recordset.map(shapeProject) };
}

function shapeProject(x) {
  return {
    projectId: x.ProjectId, name: x.Name || '', address: x.Address || '',
    type: x.Type, status: x.Status, primaryBudgetId: x.PrimaryBudgetId || null,
    convertedAt: x.ConvertedAt ? x.ConvertedAt.toISOString() : null,
    contractAmount: x.ContractAmount === null || x.ContractAmount === undefined ? null : Number(x.ContractAmount),
    projectAmount: x.ProjectAmount === null || x.ProjectAmount === undefined ? null : Number(x.ProjectAmount),
    liveContractSum: x.LiveContractSum === null || x.LiveContractSum === undefined ? 0 : Number(x.LiveContractSum),
    liveProjectCost: x.LiveProjectCost === null || x.LiveProjectCost === undefined ? 0 : Number(x.LiveProjectCost),
    budgetCount: x.BudgetCount || 0, analysisCount: x.AnalysisCount || 0,
    breachCount: x.BreachCount === null || x.BreachCount === undefined ? null : Number(x.BreachCount),
    createdById: x.CreatedById || null, createdByName: x.CreatedByName || null,
    createdAt: x.CreatedAt ? x.CreatedAt.toISOString() : null,
    updated: x.UpdatedAt ? x.UpdatedAt.toISOString() : null
  };
}

// One project with everything hanging off it — the Projects tab's detail view.
async function getProject(pool, projectId) {
  const f = await features(pool);
  if (!f.projectsTable) return { available: false };
  const key = String(projectId || '').toUpperCase();
  if (!PROJECT_ID_RX.test(key)) return { available: true, project: null };

  const grCols = f.budgetsGuardrail ? 'b.GuardrailStatus, b.GuardrailBreachCount'
    : "CAST(NULL AS VARCHAR(10)) AS GuardrailStatus, CAST(NULL AS INT) AS GuardrailBreachCount";
  const ownerCols = f.budgetsCreatedBy ? 'b.CreatedById, b.CreatedByName'
    : 'CAST(NULL AS NVARCHAR(128)) AS CreatedById, CAST(NULL AS NVARCHAR(200)) AS CreatedByName';

  const [proj, budgets, analyses] = await Promise.all([
    pool.request().input('pid', sql.VarChar(16), key).query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM dbo.Budgets AS b WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0) AS BudgetCount,
              (SELECT COUNT(*) FROM dbo.InvestmentAnalyses AS a WHERE a.ProjectKey = p.ProjectId AND a.IsDeleted = 0) AS AnalysisCount,
              CAST(NULL AS INT) AS BreachCount,
              CAST(NULL AS DECIMAL(18,2)) AS LiveContractSum,
              CAST(NULL AS DECIMAL(18,2)) AS LiveProjectCost
       FROM dbo.Projects AS p WHERE p.ProjectId = @pid AND p.IsDeleted = 0`),
    pool.request().input('pid', sql.VarChar(16), key).query(
      `SELECT b.ProjectId, b.Name, b.Type, b.Status, b.ContractSum, b.ProjectCost, b.UpdatedAt,
              JSON_VALUE(b.Doc, '$.address') AS Address, ${ownerCols}, ${grCols}
       FROM dbo.Budgets AS b
       WHERE b.ProjectKey = @pid AND b.IsDeleted = 0
       ORDER BY LEN(b.ProjectId), b.ProjectId`),
    pool.request().input('pid', sql.VarChar(16), key).query(
      `SELECT a.AnalysisId, a.ProjectId, a.Name, a.Status, a.CurrentVersionNumber,
              a.PurchasePrice, a.Year1NOI, a.InitialEquity, a.FinalYearEquityIRR,
              a.CreatedById, a.CreatedByName, a.UpdatedAt,
              bv.VersionNumber AS SourceBudgetVersionNumber
       FROM dbo.InvestmentAnalyses AS a
       LEFT JOIN dbo.BudgetVersions AS bv ON bv.Id = a.SourceBudgetVersionId
       WHERE a.ProjectKey = @pid AND a.IsDeleted = 0
       ORDER BY a.UpdatedAt DESC`)
  ]);

  if (!proj.recordset.length) return { available: true, project: null };
  const p = shapeProject(proj.recordset[0]);
  // The detail view shows the live money of the primary budget, which the list
  // query computes in SQL and this one computes here — same rule, one budget.
  const primary = budgets.recordset.find(b => b.ProjectId === p.primaryBudgetId) || budgets.recordset[0] || null;
  p.liveContractSum = primary ? Number(primary.ContractSum) : 0;
  p.liveProjectCost = primary ? Number(primary.ProjectCost) : 0;
  p.breachCount = budgets.recordset.filter(b => b.GuardrailStatus === 'breach').length;

  return {
    available: true, statuses: PROJECT_STATUSES, project: p,
    budgets: budgets.recordset.map(x => ({
      projectId: x.ProjectId, name: x.Name, type: x.Type, status: x.Status,
      address: x.Address || '',
      contractSum: Number(x.ContractSum), projectCost: Number(x.ProjectCost),
      isAlternate: x.ProjectId !== key,
      isPrimary: x.ProjectId === p.primaryBudgetId,
      guardrailStatus: x.GuardrailStatus || null,
      guardrailBreachCount: x.GuardrailBreachCount === null ? null : Number(x.GuardrailBreachCount),
      createdById: x.CreatedById || null, createdByName: x.CreatedByName || null,
      updated: x.UpdatedAt.toISOString()
    })),
    analyses: analyses.recordset.map(x => ({
      analysisId: x.AnalysisId.toLowerCase(), projectId: x.ProjectId, name: x.Name,
      status: x.Status, currentVersionNumber: x.CurrentVersionNumber,
      sourceBudgetVersionNumber: x.SourceBudgetVersionNumber,
      purchasePrice: x.PurchasePrice === null ? null : Number(x.PurchasePrice),
      year1NOI: x.Year1NOI === null ? null : Number(x.Year1NOI),
      initialEquity: x.InitialEquity === null ? null : Number(x.InitialEquity),
      finalYearEquityIRR: x.FinalYearEquityIRR === null ? null : Number(x.FinalYearEquityIRR),
      createdById: x.CreatedById || null, createdByName: x.CreatedByName || null,
      updated: x.UpdatedAt.toISOString()
    }))
  };
}

// Metadata and status writes. Moving to Converted to Project stamps the date
// and SNAPSHOTS the primary budget's money — a snapshot, not a live join, so a
// later budget edit cannot restate what has already been reported.
async function updateProject(pool, projectId, body, principal) {
  const f = await features(pool);
  if (!f.projectsTable) return jsonRes(503, { error: 'not_migrated',
    message: 'Projects are not available until sql/migrate_projects_and_guardrails.sql has run.' });

  const key = String(projectId || '').toUpperCase();
  if (!PROJECT_ID_RX.test(key)) return jsonRes(400, { error: 'bad_request', message: 'Invalid project ID.' });
  body = body || {};

  if (body.status !== undefined && !PROJECT_STATUSES.includes(body.status))
    return jsonRes(400, { error: 'bad_request', message: 'status must be one of: ' + PROJECT_STATUSES.join(', ') });

  const cur = await pool.request().input('pid', sql.VarChar(16), key)
    .query(`SELECT p.Status, p.PrimaryBudgetId, p.ConvertedAt,
                   (SELECT TOP 1 b.ContractSum FROM dbo.Budgets AS b
                     WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0
                       AND b.ProjectId = ISNULL(p.PrimaryBudgetId, b.ProjectId)
                     ORDER BY LEN(b.ProjectId), b.ProjectId) AS ContractSum,
                   (SELECT TOP 1 b.ProjectCost FROM dbo.Budgets AS b
                     WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0
                       AND b.ProjectId = ISNULL(p.PrimaryBudgetId, b.ProjectId)
                     ORDER BY LEN(b.ProjectId), b.ProjectId) AS ProjectCost
            FROM dbo.Projects AS p WHERE p.ProjectId = @pid AND p.IsDeleted = 0`);
  if (!cur.recordset.length) return jsonRes(404, { error: 'not_found', message: 'Project not found.' });
  const row = cur.recordset[0];

  if (body.primaryBudgetId !== undefined && body.primaryBudgetId !== null) {
    const bid = String(body.primaryBudgetId).toUpperCase();
    if (!BUDGET_ID_RX.test(bid) || projectKeyOf(bid) !== key)
      return jsonRes(400, { error: 'bad_request', message: 'The primary budget must belong to this project.' });
    body.primaryBudgetId = bid;
  }

  const converting = body.status === CONVERTED && row.Status !== CONVERTED;
  const sets = ['UpdatedAt = SYSUTCDATETIME()'];
  const rq = pool.request().input('pid', sql.VarChar(16), key);

  if (body.name !== undefined) { rq.input('name', sql.NVarChar(200), String(body.name).slice(0, 200)); sets.push('Name = @name'); }
  if (body.address !== undefined) { rq.input('addr', sql.NVarChar(300), String(body.address).slice(0, 300)); sets.push('Address = @addr'); }
  if (body.type !== undefined) { rq.input('type', sql.NVarChar(50), String(body.type).slice(0, 50)); sets.push('Type = @type'); }
  if (body.notes !== undefined) { rq.input('notes', sql.NVarChar(2000), String(body.notes).slice(0, 2000)); sets.push('Notes = @notes'); }
  if (body.primaryBudgetId !== undefined) { rq.input('bid', sql.VarChar(16), body.primaryBudgetId); sets.push('PrimaryBudgetId = @bid'); }
  if (body.status !== undefined) { rq.input('st', sql.NVarChar(40), body.status); sets.push('Status = @st'); }

  if (converting) {
    rq.input('cs', sql.Decimal(18, 2), row.ContractSum === null ? null : Number(row.ContractSum));
    rq.input('pc', sql.Decimal(18, 2), row.ProjectCost === null ? null : Number(row.ProjectCost));
    sets.push('ConvertedAt = SYSUTCDATETIME()', 'ContractAmount = @cs', 'ProjectAmount = @pc');
  }

  await rq.query(`UPDATE dbo.Projects SET ${sets.join(', ')} WHERE ProjectId = @pid AND IsDeleted = 0`);
  const after = await getProject(pool, key);
  return jsonRes(200, { ok: true, converted: converting, project: after.project });
}

module.exports = {
  PROJECT_STATUSES, CONVERTED, PROJECT_ID_RX, BUDGET_ID_RX,
  projectKeyOf, ensureProject, listProjects, getProject, updateProject, jsonRes
};
