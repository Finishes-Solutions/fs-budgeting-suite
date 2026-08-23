// The Projects aggregate — the parent of budgets and investment analyses.
//
// It lives here rather than in an api/projects/ folder on purpose: a NEW
// function folder is not reliably picked up by the deployed host (see
// AGENTS.md — api/admin-roles/ answered 404 across two deploys while every
// established endpoint kept working). So the project surface is query scopes
// on endpoints that already deploy:
//
//   GET    /api/budgets?scope=projects           the project index
//   GET    /api/budgets?scope=project&id=OP-0001 one project + children
//   GET    /api/budgets?scope=next-project-id    the lowest free OP-####
//   PUT    /api/budget/{id}?scope=project        project metadata and status
//   PUT    /api/budget/{id}?scope=project        + {create:true} — a new project
//   DELETE /api/budget/{id}?scope=project        soft-delete, cascading
//
// SECURITY NOTE, and it is not a footnote: a staticwebapp.config.json route
// rule matches PATHS, not query strings. It cannot see ?scope=project. The
// in-function checks in this module are therefore the ONLY gate on these
// scopes and must be written as the real gate, never as defence in depth.
//
// IDENTIFIERS — the rule this module exists to enforce:
//
//   A PROJECT id is OP-####. Four digits, its own namespace, and the only
//   thing dbo.Projects is keyed by. Unique among LIVE projects: deleting a
//   project frees its number for deliberate reuse (createProject claims the
//   tombstone), while two live projects with one id stay impossible. A
//   BUDGET id, by contrast, stays reserved even after deletion — its version
//   history hangs off it, and reuse would graft new content onto old history.
//   A BUDGET id is BD-#### (or a legacy OP-/AS-/TST-####), optionally with a
//   -NN alternate suffix.
//
// A project id is NEVER derived from a budget id and a budget id is never
// displayed as a project id. A budget says which project it belongs to by
// carrying dbo.Budgets.ProjectKey — an explicit link, set when the budget is
// created. Before sql/migrate_project_op_ids.sql that link was inferred by
// stripping a budget's alternate suffix, which is exactly why the Projects
// list used to show BD-… ids in its PROJECT ID column.

const { sql } = require('./db');
const { features } = require('./schema');
// Activity is best-effort and never throws — see api/shared/users.js.
const { recordActivity } = require('./users');

const PROJECT_ID_RX = /^OP-\d{4}$/;
const BUDGET_ID_RX = /^(OP|BD|AS|TST)-\d{4}(-\d{2})?$/;
// The prefix new budgets are minted under. Legacy budgets keep whatever
// prefix they were created with; nothing renames them.
const BUDGET_PREFIX = 'BD';

// The deal pipeline, ending in the status the analytics dashboard counts as
// real work won. On Hold and Lost are side-states, not steps.
const PROJECT_STATUSES = [
  'Lead', 'Qualified', 'Budgeting', 'Proposal Sent', 'Awarded',
  'Converted to Project', 'On Hold', 'Lost'
];
const CONVERTED = 'Converted to Project';

// A budget id with any alternate suffix stripped. BD-0001-02 and BD-0001 share
// a BASE BUDGET id — which is how alternates are numbered, and nothing more.
// It is deliberately NOT called projectKeyOf any more: it does not, and must
// not, produce a project id.
function budgetBaseOf(id) {
  const s = String(id || '').toUpperCase();
  return /^(OP|BD|AS|TST)-\d{4}-\d{2}$/.test(s) ? s.slice(0, -3) : s;
}

const jsonRes = (status, body) => ({
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

// The lowest OP-#### not taken by ANY row, soft-deleted included. A deleted
// project's number CAN be reused — typing it into Create Project claims the
// tombstone — but reuse is a deliberate act, so the suggestion never steers
// anyone into one by default. Returns null when all 9,999 are gone.
async function nextProjectId(pool) {
  const f = await features(pool);
  if (!f.projectsTable) return null;
  const r = await pool.request().query('SELECT ProjectId FROM dbo.Projects');
  const taken = new Set(r.recordset.map(x => String(x.ProjectId).toUpperCase()));
  for (let i = 1; i <= 9999; i++) {
    const id = 'OP-' + String(i).padStart(4, '0');
    if (!taken.has(id)) return id;
  }
  return null;
}

// The lowest BD-#### not already taken by any budget, deleted ones included,
// for the same reason. Budget ids are a separate namespace from project ids
// and are never derived from one.
async function nextBudgetId(pool) {
  const r = await pool.request().query('SELECT ProjectId FROM dbo.Budgets');
  const taken = new Set(r.recordset.map(x => String(x.ProjectId).toUpperCase()));
  for (let i = 1; i <= 9999; i++) {
    const id = BUDGET_PREFIX + '-' + String(i).padStart(4, '0');
    if (!taken.has(id)) return id;
  }
  return null;
}

// Create a project. This is the ONLY way a project comes into existence now:
// saving a budget no longer conjures its parent, because a budget id cannot
// name a project. Uniqueness is enforced by PK_Projects, not by the read
// below — the read only exists to answer with a useful message. Two concurrent
// creates therefore cannot both win: the loser gets the duplicate-key error
// and is answered 409, exactly like the pre-read path.
const DUP_KEY = new Set([2627, 2601]);

async function createProject(pool, projectId, body, principal) {
  const f = await features(pool);
  if (!f.projectsTable) return jsonRes(503, { error: 'not_migrated',
    message: 'Projects are not available until sql/migrate_projects_and_guardrails.sql has run.' });

  const key = String(projectId || '').trim().toUpperCase();
  if (!PROJECT_ID_RX.test(key)) return jsonRes(400, { error: 'bad_project_id',
    field: 'projectId', message: 'Use the format OP-####.' });

  body = body || {};
  const name = String(body.name === undefined || body.name === null ? '' : body.name).trim();
  const address = String(body.address === undefined || body.address === null ? '' : body.address).trim();
  // Every field the New Project dialog offers is required, and the API says so
  // per field rather than as one blanket refusal, so the form can attach each
  // message to the input it belongs to.
  if (!name) return jsonRes(400, { error: 'bad_request', field: 'name', message: 'Project Name is required.' });
  if (!address) return jsonRes(400, { error: 'bad_request', field: 'address', message: 'Address is required.' });

  const status = PROJECT_STATUSES.includes(body.status) ? body.status : 'Lead';
  // A project has NO type. One property can carry a Multifamily budget and a
  // Commercial budget at once, so the type belongs to each budget; the column
  // keeps its default and the app never reads it.
  //
  // An id is unique among LIVE projects, not forever. Deleting a project
  // frees its number for deliberate reuse: creating over a soft-deleted row
  // CLAIMS that row and resets it — new name, address, creator and dates, no
  // primary budget, back to Lead — rather than resurrecting the old project.
  // The UPDATE below is the atomic claim: its IsDeleted = 1 guard means at
  // most one of two concurrent creates can win it; the loser falls through to
  // the INSERT, whose PK violation answers 409. Two live projects with one id
  // therefore stay impossible, which is the half of the rule that matters.
  //
  // Accepted caveat of reuse: the OLD project's soft-deleted budgets and
  // analyses keep pointing at this id, so an admin restoring one later
  // attaches it to the NEW project. Reusing a number merges its history —
  // the activity log carries both lives of the id for the same reason.
  const withInputs = rq => rq
    .input('pid', sql.VarChar(16), key)
    .input('name', sql.NVarChar(200), name.slice(0, 200))
    .input('addr', sql.NVarChar(300), address.slice(0, 300))
    .input('st', sql.NVarChar(40), status)
    .input('notes', sql.NVarChar(2000), String(body.notes || '').slice(0, 2000))
    .input('cuid', sql.NVarChar(128), principal ? (principal.userId || null) : null)
    .input('cuname', sql.NVarChar(200), principal ? (principal.userDetails || null) : null);

  const claimed = await withInputs(pool.request())
    .query(`UPDATE dbo.Projects
              SET Name = @name, Address = @addr, Status = @st, Notes = @notes,
                  PrimaryBudgetId = NULL, ConvertedAt = NULL,
                  ContractAmount = NULL, ProjectAmount = NULL,
                  CreatedById = @cuid, CreatedByName = @cuname,
                  CreatedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME(),
                  IsDeleted = 0, DeletedAt = NULL
            WHERE ProjectId = @pid AND IsDeleted = 1;
            SELECT @@ROWCOUNT AS N;`);
  const reused = !!claimed.recordset[0].N;

  if (!reused) {
    try {
      await withInputs(pool.request())
        .query(`INSERT INTO dbo.Projects (ProjectId, Name, Address, Status, Notes, CreatedById, CreatedByName)
                VALUES (@pid, @name, @addr, @st, @notes, @cuid, @cuname);`);
    } catch (e) {
      if (DUP_KEY.has(e.number)) return jsonRes(409, { error: 'project_id_taken',
        field: 'projectId', message: 'Project ID must be unique.' });
      throw e;
    }
  }
  const after = await getProject(pool, key);
  await recordActivity(pool, principal, 'project_create', 'project', key,
    { name: name, address: address, reusedNumber: reused || undefined });
  return jsonRes(201, { ok: true, created: true, reusedNumber: reused, project: after.project });
}

// Soft delete, cascading to everything the project owns. One transaction so a
// project can never end up flagged while its budgets are still live — the
// Projects list would keep counting them.
//
// Recoverable by design, exactly like a budget: the rows and every version
// stay, only the flags move. sql/purge_deleted_budgets.sql is still the only
// thing that destroys anything.
async function deleteProject(pool, projectId, principal) {
  const f = await features(pool);
  if (!f.projectsTable) return jsonRes(503, { error: 'not_migrated',
    message: 'Projects are not available until sql/migrate_projects_and_guardrails.sql has run.' });

  const key = String(projectId || '').toUpperCase();
  if (!PROJECT_ID_RX.test(key)) return jsonRes(400, { error: 'bad_request', message: 'Invalid project ID.' });

  const cur = await pool.request().input('pid', sql.VarChar(16), key)
    .query('SELECT Name FROM dbo.Projects WHERE ProjectId = @pid AND IsDeleted = 0');
  if (!cur.recordset.length) return jsonRes(404, { error: 'not_found', message: 'Project not found.' });

  const tx = new sql.Transaction(pool);
  await tx.begin();
  let budgets = 0, analyses = 0;
  try {
    const b = await new sql.Request(tx).input('pid', sql.VarChar(16), key)
      .query(`UPDATE dbo.Budgets SET IsDeleted = 1, DeletedAt = SYSUTCDATETIME()
              WHERE ProjectKey = @pid AND IsDeleted = 0;
              SELECT @@ROWCOUNT AS N;`);
    budgets = b.recordset[0].N;

    const a = await new sql.Request(tx).input('pid', sql.VarChar(16), key)
      .query(`UPDATE dbo.InvestmentAnalyses SET IsDeleted = 1, DeletedAt = SYSUTCDATETIME()
              WHERE ProjectKey = @pid AND IsDeleted = 0;
              SELECT @@ROWCOUNT AS N;`);
    analyses = a.recordset[0].N;

    await new sql.Request(tx).input('pid', sql.VarChar(16), key)
      .query(`UPDATE dbo.Projects SET IsDeleted = 1, DeletedAt = SYSUTCDATETIME(),
                UpdatedAt = SYSUTCDATETIME()
              WHERE ProjectId = @pid AND IsDeleted = 0;`);
    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch (_) { /* the failure below is the real one */ }
    throw e;
  }
  await recordActivity(pool, principal, 'project_delete', 'project', key,
    { name: cur.recordset[0].Name || null, budgetsDeleted: budgets, analysesDeleted: analyses });
  return jsonRes(200, { ok: true, projectId: key, name: cur.recordset[0].Name || '',
                        budgetsDeleted: budgets, analysesDeleted: analyses });
}

// Attach a budget to its project. Called by the budget save with the project
// the client says the budget belongs to; refuses a project that does not
// exist, because a dangling ProjectKey would fail FK_Budgets_Project anyway
// and a clear 400 beats a 500.
async function linkBudgetToProject(pool, budgetId, projectKey) {
  const f = await features(pool);
  if (!f.projectsTable || !f.budgetsProjectKey) return { ok: false, skipped: true };
  const key = String(projectKey || '').toUpperCase();
  if (!PROJECT_ID_RX.test(key)) return { ok: false, reason: 'bad_project_id' };
  const r = await pool.request().input('pid', sql.VarChar(16), key)
    .query('SELECT 1 AS Found FROM dbo.Projects WHERE ProjectId = @pid AND IsDeleted = 0');
  if (!r.recordset.length) return { ok: false, reason: 'not_found' };
  await pool.request()
    .input('id', sql.VarChar(16), String(budgetId).toUpperCase())
    .input('pk', sql.VarChar(16), key)
    .query('UPDATE dbo.Budgets SET ProjectKey = @pk WHERE ProjectId = @id');
  return { ok: true, projectKey: key };
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
    `SELECT p.ProjectId, p.Name, p.Address, p.Status, p.PrimaryBudgetId,
            p.ConvertedAt, p.ContractAmount, p.ProjectAmount,
            p.CreatedById, p.CreatedByName, p.CreatedAt, p.UpdatedAt,
            (SELECT COUNT(*) FROM dbo.Budgets AS b
              WHERE b.ProjectKey = p.ProjectId AND b.IsDeleted = 0) AS BudgetCount,
            (SELECT COUNT(*) FROM dbo.InvestmentAnalyses AS a
              WHERE a.ProjectKey = p.ProjectId AND a.IsDeleted = 0) AS AnalysisCount,
            -- The types this project's budgets actually are. A project has no
            -- type of its own: one property can carry a Multifamily budget and
            -- a Commercial budget at the same time.
            (SELECT STRING_AGG(t.Type, ', ') WITHIN GROUP (ORDER BY t.Type)
               FROM (SELECT DISTINCT bt.Type FROM dbo.Budgets AS bt
                      WHERE bt.ProjectKey = p.ProjectId AND bt.IsDeleted = 0) AS t) AS BudgetTypes,
            -- PRIMARY ONLY, and it is a TOP 1 rather than a SUM: the summary
            -- card reports the primary budget's cost, so an alternate must
            -- never be added into it. The ORDER BY is the same tie-break the
            -- detail view uses, for the transitional case of a project whose
            -- primary is not set.
            (SELECT TOP 1 b2.ContractSum FROM dbo.Budgets AS b2
              WHERE b2.ProjectKey = p.ProjectId AND b2.IsDeleted = 0
                AND b2.ProjectId = ISNULL(p.PrimaryBudgetId, b2.ProjectId)
              ORDER BY LEN(b2.ProjectId), b2.ProjectId) AS LiveContractSum,
            (SELECT TOP 1 b3.ProjectCost FROM dbo.Budgets AS b3
              WHERE b3.ProjectKey = p.ProjectId AND b3.IsDeleted = 0
                AND b3.ProjectId = ISNULL(p.PrimaryBudgetId, b3.ProjectId)
              ORDER BY LEN(b3.ProjectId), b3.ProjectId) AS LiveProjectCost,
            ${grCols}
     FROM dbo.Projects AS p
     WHERE ${where}
     ORDER BY p.UpdatedAt DESC`);

  return { available: true, statuses: PROJECT_STATUSES, projects: r.recordset.map(shapeProject) };
}

function shapeProject(x) {
  return {
    projectId: x.ProjectId, name: x.Name || '', address: x.Address || '',
    // budgetTypes, not type: see the query above.
    budgetTypes: x.BudgetTypes || '',
    status: x.Status, primaryBudgetId: x.PrimaryBudgetId || null,
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
              (SELECT STRING_AGG(t.Type, ', ') WITHIN GROUP (ORDER BY t.Type)
                 FROM (SELECT DISTINCT bt.Type FROM dbo.Budgets AS bt
                        WHERE bt.ProjectKey = p.ProjectId AND bt.IsDeleted = 0) AS t) AS BudgetTypes,
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
  // The detail view shows the live money of the PRIMARY budget, which the list
  // query computes in SQL and this one computes here — same rule, one budget,
  // and never a sum across alternates.
  const primary = budgets.recordset.find(b => b.ProjectId === p.primaryBudgetId) || budgets.recordset[0] || null;
  p.liveContractSum = primary ? Number(primary.ContractSum) : 0;
  p.liveProjectCost = primary ? Number(primary.ProjectCost) : 0;
  p.breachCount = budgets.recordset.filter(b => b.GuardrailStatus === 'breach').length;
  // What the row menu needs to know without asking again: which budget is
  // primary is the project's answer, not each row's guess.
  const primaryId = primary ? primary.ProjectId : null;

  return {
    available: true, statuses: PROJECT_STATUSES, project: p,
    budgets: budgets.recordset.map(x => ({
      projectId: x.ProjectId, name: x.Name, type: x.Type, status: x.Status,
      address: x.Address || '',
      contractSum: Number(x.ContractSum), projectCost: Number(x.ProjectCost),
      // An alternate is a budget carrying the -NN suffix. It is no longer
      // "an id that differs from the project's", because a budget id and a
      // project id are different namespaces and always differ.
      isAlternate: budgetBaseOf(x.ProjectId) !== x.ProjectId,
      isPrimary: x.ProjectId === primaryId,
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
    .query(`SELECT p.Status, p.PrimaryBudgetId, p.ConvertedAt, p.Name,
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

  // Make Primary. The budget must be a LIVE budget of THIS project — which is
  // now a real lookup against ProjectKey, not a string operation on the id.
  // Because "which budget is primary" is one scalar column, promoting one
  // demotes the previous in the same statement: a project cannot pass through
  // a state with none or two.
  if (body.primaryBudgetId !== undefined && body.primaryBudgetId !== null) {
    const bid = String(body.primaryBudgetId).toUpperCase();
    if (!BUDGET_ID_RX.test(bid))
      return jsonRes(400, { error: 'bad_request', message: 'Invalid budget ID.' });
    const owns = await pool.request()
      .input('bid', sql.VarChar(16), bid).input('pid', sql.VarChar(16), key)
      .query(`SELECT 1 AS Found FROM dbo.Budgets
              WHERE ProjectId = @bid AND ProjectKey = @pid AND IsDeleted = 0`);
    if (!owns.recordset.length)
      return jsonRes(400, { error: 'bad_request',
        message: 'The primary budget must be a live budget on this project.' });
    body.primaryBudgetId = bid;
  }

  const converting = body.status === CONVERTED && row.Status !== CONVERTED;
  const sets = ['UpdatedAt = SYSUTCDATETIME()'];
  const rq = pool.request().input('pid', sql.VarChar(16), key);

  if (body.name !== undefined) { rq.input('name', sql.NVarChar(200), String(body.name).slice(0, 200)); sets.push('Name = @name'); }
  if (body.address !== undefined) { rq.input('addr', sql.NVarChar(300), String(body.address).slice(0, 300)); sets.push('Address = @addr'); }
  // body.type is deliberately not accepted: a project has no type.
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

  // One event per KIND of change, each naming the project it happened to and
  // what actually moved. "Updated settings" told nobody anything; these say
  // which project, which field, from what, to what.
  const pname = after.project ? after.project.name : null;
  if (body.primaryBudgetId !== undefined && body.primaryBudgetId !== row.PrimaryBudgetId) {
    await recordActivity(pool, principal, 'budget_primary', 'project', key,
      { name: pname, from: row.PrimaryBudgetId || null, to: body.primaryBudgetId || null });
  }
  if (converting) {
    await recordActivity(pool, principal, 'project_convert', 'project', key, {
      name: pname,
      contractAmount: row.ContractSum === null ? null : Number(row.ContractSum),
      projectAmount: row.ProjectCost === null ? null : Number(row.ProjectCost)
    });
  } else if (body.status !== undefined && body.status !== row.Status) {
    await recordActivity(pool, principal, 'project_status', 'project', key,
      { name: pname, from: row.Status, to: body.status });
  }
  const meta = ['name', 'address', 'notes'].filter(k => body[k] !== undefined);
  if (meta.length) {
    await recordActivity(pool, principal, 'project_update', 'project', key,
      { name: pname, fields: meta.map(k => ({ key: k, to: String(body[k]).slice(0, 200) })) });
  }
  return jsonRes(200, { ok: true, converted: converting, project: after.project });
}

module.exports = {
  PROJECT_STATUSES, CONVERTED, PROJECT_ID_RX, BUDGET_ID_RX, BUDGET_PREFIX,
  budgetBaseOf, nextProjectId, nextBudgetId, createProject, deleteProject,
  linkBudgetToProject, listProjects, getProject, updateProject, jsonRes
};
