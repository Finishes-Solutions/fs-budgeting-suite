// GET  /api/investment-analyses[?projectId=BD-0001] — list active analyses.
// POST /api/investment-analyses — create a draft, either imported from an
//      exact immutable budget version or standalone.
//
// Creation stores the (possibly incomplete) prefill input and NO result:
// CurrentVersionNumber stays 0 and no annual rows exist until the first
// successful save calculates. The user must review imported assumptions and
// add vacancy, expenses, financing, and disposition before anything computes —
// the prefill deliberately invents no market assumption (no purchase month,
// no expense ratio, no exit cap).
const { getPool, sql } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const { projectFromBudget, currentPurchaseMonth } = require('../shared/investment/from-budget');
const { GUID_RX, jsonRes } = require('../shared/investment-persistence');
const { ensureUser } = require('../shared/users');
const { features } = require('../shared/schema');
// A budget's project is a stored link now, never something derived from its
// id — see api/shared/projects.js. The analysis reads that link so it rolls up
// to the same project the budget belongs to.
const D = require('../shared/investment/defaults');

const ID_RX = /^(OP|BD|BDG|AS|TST)-\d{4}(-\d{2})?$/;
const FULL_VISIBILITY_ROLES = new Set(['director', 'super_admin']);

module.exports = async function (context, req) {
  const pool = await getPool();
  const principal = getPrincipal(req);
  const userId = principal ? (principal.userId || null) : null;

  if (req.method === 'GET') {
    // Roles only exist once sql/migrate_roles_and_ownership.sql has run. Before
    // that every account reads as the default 'user', so applying the filter
    // would hide analyses that used to be visible — leave it off entirely.
    const f = await features(pool);
    let appRole = 'user';
    if (userId) {
      try {
        const row = await ensureUser(pool, principal, {});
        if (row) appRole = row.AppRole || 'user';
      } catch (e) { /* default to user */ }
    }
    const swaSuper = principal && Array.isArray(principal.userRoles) && principal.userRoles.includes('super_admin');
    const canSeeAll = !f.usersAppRole || swaSuper || FULL_VISIBILITY_ROLES.has(appRole);

    const projectId = (req.query.projectId || '').toUpperCase();
    if (projectId && !ID_RX.test(projectId)) { context.res = jsonRes(400, { error: 'bad_request', message: 'Invalid project ID filter.' }); return; }
    // Item numbers and the project link arrive with sql/adopt_project_numbers.sql
    // and sql/migrate_projects_and_guardrails.sql; before they run, the list is
    // exactly what it has always been.
    const listItemCol = f.analysesItemNumber && f.analysesProjectKey
      ? 'a.ItemNumber, a.ProjectKey,'
      : 'CAST(NULL AS INT) AS ItemNumber, CAST(NULL AS VARCHAR(16)) AS ProjectKey,';
    const rq = pool.request();
    let where = 'a.IsDeleted = 0';
    if (projectId) { rq.input('pid', sql.VarChar(16), projectId); where += ' AND a.ProjectId = @pid'; }
    if (!canSeeAll && userId) {
      rq.input('uid', sql.NVarChar(128), userId);
      where += ' AND (a.CreatedById = @uid OR a.CreatedById IS NULL)';
    }
    const r = await rq.query(
      `SELECT a.AnalysisId, a.ProjectId, a.Name, a.Status, a.CurrentVersionNumber,
              ${listItemCol}
              a.SourceBudgetVersionId, bv.VersionNumber AS SourceBudgetVersionNumber,
              (SELECT MAX(v2.VersionNumber) FROM dbo.BudgetVersions AS v2
                WHERE v2.ProjectId = a.ProjectId) AS BudgetCurrentVersionNumber,
              a.PurchasePrice, a.Year1NOI, a.InitialEquity, a.FinalYearEquityIRR,
              a.OptimalHoldingYear, a.CalculationVersion,
              a.CreatedById, a.CreatedByName, a.CreatedAt, a.UpdatedAt,
              JSON_VALUE(cu.SettingsDoc, '$.avatarColor') AS CreatedByAvatar
       FROM dbo.InvestmentAnalyses AS a
       LEFT JOIN dbo.BudgetVersions AS bv ON bv.Id = a.SourceBudgetVersionId
       LEFT JOIN dbo.Users AS cu ON cu.UserId = a.CreatedById
       WHERE ${where}
       ORDER BY a.UpdatedAt DESC`);
    context.res = jsonRes(200, r.recordset.map(x => ({
      analysisId: x.AnalysisId.toLowerCase(), projectId: x.ProjectId, name: x.Name,
      // The identifier-model display id (INA-0042-03) is COMPUTED from these
      // two, in one client helper — never stored, never a join key.
      projectKey: x.ProjectKey || null,
      itemNumber: x.ItemNumber === null || x.ItemNumber === undefined ? null : Number(x.ItemNumber),
      status: x.Status, currentVersionNumber: x.CurrentVersionNumber,
      sourceBudgetVersionNumber: x.SourceBudgetVersionNumber,
      // The budget's CURRENT version, so the list can flag an analysis whose
      // source has moved on. Reporting it is all this does — nothing
      // recalculates on its own.
      budgetCurrentVersionNumber: x.BudgetCurrentVersionNumber || null,
      budgetDrift: !!(x.BudgetCurrentVersionNumber && x.SourceBudgetVersionNumber
                      && x.BudgetCurrentVersionNumber > x.SourceBudgetVersionNumber),
      purchasePrice: x.PurchasePrice === null ? null : +x.PurchasePrice,
      year1NOI: x.Year1NOI === null ? null : +x.Year1NOI,
      initialEquity: x.InitialEquity === null ? null : +x.InitialEquity,
      finalYearEquityIRR: x.FinalYearEquityIRR === null ? null : +x.FinalYearEquityIRR,
      optimalHoldingYear: x.OptimalHoldingYear,
      calculationVersion: x.CalculationVersion,
      createdById: x.CreatedById || null, createdByName: x.CreatedByName || null, createdByAvatar: x.CreatedByAvatar || null,
      createdAt: x.CreatedAt, updatedAt: x.UpdatedAt
    })));
    return;
  }

  // ---- POST: create
  const body = req.body || {};
  const userName = principal ? (principal.userDetails || null) : null;

  let input, projectId = null, sourceBudgetVersionId = null, projectKey = null;

  if (body.mode === 'fromBudget') {
    projectId = (body.projectId || '').toUpperCase();
    if (!ID_RX.test(projectId)) { context.res = jsonRes(400, { error: 'bad_request', message: 'Invalid project ID.' }); return; }
    const rq = pool.request().input('pid', sql.VarChar(16), projectId);
    let versionFilter = 'v.VersionNumber = (SELECT MAX(v2.VersionNumber) FROM dbo.BudgetVersions v2 WHERE v2.ProjectId = @pid)';
    if (body.budgetVersionNumber !== undefined) {
      if (!Number.isInteger(body.budgetVersionNumber) || body.budgetVersionNumber < 1) {
        context.res = jsonRes(400, { error: 'bad_request', message: 'budgetVersionNumber must be a positive integer.' }); return;
      }
      rq.input('vn', sql.Int, body.budgetVersionNumber);
      versionFilter = 'v.VersionNumber = @vn';
    }
    // The join makes cross-project forgery impossible: the version must belong
    // to the named project, and the project must not be soft-deleted.
    // The project columns come along for the ride: the analysis's Property
    // Name and Address are the PROJECT's, not the budget id. That is the whole
    // point of a budget being tied to a project — an analysis built from one
    // should never end up named "BD-2108".
    const pjFeat = await features(pool);
    const pjCols = pjFeat.budgetsProjectKey && pjFeat.projectsTable
      ? 'b.ProjectKey, pj.Name AS ProjectName, pj.Address AS ProjectAddress'
      : `CAST(NULL AS VARCHAR(16)) AS ProjectKey, CAST(NULL AS NVARCHAR(200)) AS ProjectName,
         CAST(NULL AS NVARCHAR(300)) AS ProjectAddress`;
    const pjJoin = pjFeat.budgetsProjectKey && pjFeat.projectsTable
      ? 'LEFT JOIN dbo.Projects AS pj ON pj.ProjectId = b.ProjectKey' : '';
    const r = await rq.query(
      `SELECT v.Id, v.VersionNumber, v.Doc, v.Name, v.ContractSum, v.ProjectCost, ${pjCols}
       FROM dbo.BudgetVersions AS v
       JOIN dbo.Budgets AS b ON b.ProjectId = v.ProjectId AND b.IsDeleted = 0
       ${pjJoin}
       WHERE v.ProjectId = @pid AND ${versionFilter}`);
    if (!r.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Budget version not found.' }); return; }
    const v = r.recordset[0];
    sourceBudgetVersionId = v.Id;
    projectKey = v.ProjectKey || null;

    let doc;
    try { doc = JSON.parse(v.Doc); } catch (_) { doc = null; }
    if (!doc) { context.res = jsonRes(500, { error: 'source_unreadable', message: 'The budget version document could not be read.' }); return; }

    // Server-derived suggestions from the immutable version document. Gross
    // scheduled rent, never the budget's Net Income/Yr; project cost as a
    // labeled, editable suggestion; the expense ratio derived against the same
    // Gross Operating Income the engine multiplies. Building SF, never site SF
    // — see api/shared/investment/from-budget.js for why that distinction is
    // load-bearing.
    const proj = projectFromBudget(doc, v, { projectId, vacancy: D.vacancy,
      projectName: v.ProjectName || '', projectAddress: v.ProjectAddress || '', scope: body.scope });
    input = {
      schemaVersion: 1,
      analysisName: typeof body.analysisName === 'string' && body.analysisName.trim()
        ? body.analysisName.trim().slice(0, 200) : (v.Name + ' — Investment Analysis').slice(0, 200),
      source: {
        projectId,
        budgetVersionId: v.Id,
        budgetVersionNumber: v.VersionNumber,
        importedAt: new Date().toISOString(),
        syncedAt: new Date().toISOString(),
        fieldOrigins: proj.fieldOrigins,
        support: proj.support,
        scope: proj.scope
      },
      property: {
        name: proj.imported.property.name,
        address: proj.imported.property.address,
        size: proj.imported.property.size,
        unitCount: proj.imported.property.unitCount,
        purchaseMonth: currentPurchaseMonth()     // defaults to the current month; changed on step 1
      },
      projection: { years: 5, taxMode: 'beforeTax' },
      acquisition: { basis: proj.imported.acquisition.basis, costPercent: D.acquisitionCostPercent },
      income: {
        mode: 'aggregate',
        year1PotentialIncome: proj.imported.income.year1PotentialIncome,
        growth: { mode: 'constant', value: D.incomeGrowth },
        otherIncome: proj.imported.income.otherIncome
      },
      vacancy: { mode: 'constant', value: proj.imported.vacancy !== undefined && proj.imported.vacancy !== null ? proj.imported.vacancy : D.vacancy },
      expenses: proj.imported.expenses,
      capitalExpenses: [],
      financing: { loans: [] },
      disposition: { exitCapRate: { mode: 'constant', value: null }, sellingCostPercent: D.sellingCostPercent },
      reportOptions: { includeSensitivity: true }
    };
    // The true imported values, stored inside the server-owned provenance
    // block so the From Budget badges compare against the ORIGINAL import
    // forever — surviving edits, saves, and reloads. Rides in the JSON doc;
    // no schema change.
    input.source.originalValues = {};
    for (const op of Object.keys(input.source.fieldOrigins)) {
      const val = op.split('.').reduce((val2, k) => (val2 === null || val2 === undefined ? val2 : val2[k]), input);
      input.source.originalValues[op] = val === undefined ? null : JSON.parse(JSON.stringify(val));
    }
  } else if (body.mode === 'standalone') {
    const given = body.input && typeof body.input === 'object' ? body.input : {};
    const name = typeof body.analysisName === 'string' && body.analysisName.trim()
      ? body.analysisName.trim() : (typeof given.analysisName === 'string' ? given.analysisName : '');
    if (!name) { context.res = jsonRes(400, { error: 'bad_request', message: 'analysisName is required.' }); return; }
    input = Object.assign({
      schemaVersion: 1,
      property: { name: name, address: '', size: { unit: 'squareFeet', value: null }, purchaseMonth: currentPurchaseMonth() },
      projection: { years: 5, taxMode: 'beforeTax' },
      acquisition: { basis: { mode: 'purchasePrice', value: null }, costPercent: D.acquisitionCostPercent },
      income: { mode: 'aggregate', year1PotentialIncome: null, growth: { mode: 'constant', value: D.incomeGrowth }, otherIncome: [] },
      vacancy: { mode: 'constant', value: D.vacancy },
      expenses: { mode: 'percentOfGOI', value: null },
      capitalExpenses: [],
      financing: { loans: [] },
      disposition: { exitCapRate: { mode: 'constant', value: null }, sellingCostPercent: D.sellingCostPercent },
      reportOptions: { includeSensitivity: true }
    }, given, { schemaVersion: 1, analysisName: name.slice(0, 200), source: null });
  } else {
    context.res = jsonRes(400, { error: 'bad_request', message: "mode must be 'fromBudget' or 'standalone'." });
    return;
  }

  // ProjectKey arrives with sql/migrate_projects_and_guardrails.sql; naming it
  // before that runs would fail every creation.
  const analysisFeatures = await features(pool);
  const pkCol = analysisFeatures.analysesProjectKey ? ', ProjectKey' : '';
  const pkVal = analysisFeatures.analysesProjectKey ? ', @pkey' : '';
  // The item number — INA-0042-03's "03" — is allocated at creation, once,
  // from the project's current highest, deleted analyses included so a number
  // is never re-issued. UX_InvestmentAnalyses_Item is the backstop for two
  // concurrent creations; the loser recomputes once and retries, the same
  // pattern the budget save uses for version numbers.
  const wantsItem = analysisFeatures.analysesItemNumber && analysisFeatures.analysesProjectKey && projectKey;
  const itemCol = wantsItem ? ', ItemNumber' : '';
  const itemVal = wantsItem
    ? `, (SELECT ISNULL(MAX(x.ItemNumber), 0) + 1 FROM dbo.InvestmentAnalyses AS x WHERE x.ProjectKey = @pkey)`
    : '';
  const INS_DUP = new Set([2627, 2601]);

  const insert = () => pool.request()
    .input('pid', sql.VarChar(16), projectId)
    .input('pkey', sql.VarChar(16), projectKey)
    .input('name', sql.NVarChar(200), input.analysisName)
    .input('sbv', sql.BigInt, sourceBudgetVersionId)
    .input('input', sql.NVarChar(sql.MAX), JSON.stringify(input))
    .input('calc', sql.VarChar(40), require('../shared/investment/constants').CALCULATION_VERSION)
    .input('uid', sql.NVarChar(128), userId)
    .input('uname', sql.NVarChar(200), userName)
    .query(`INSERT INTO dbo.InvestmentAnalyses
              (ProjectId, Name, SourceBudgetVersionId, InputDoc, NormalizedInputDoc, ResultDoc,
               ContentHash, CalculationVersion, CreatedById, CreatedByName${pkCol}${itemCol})
            OUTPUT INSERTED.AnalysisId${wantsItem ? ', INSERTED.ItemNumber' : ''}
            VALUES (@pid, @name, @sbv, @input, N'{}', N'{}',
                    REPLICATE('0', 64), @calc, @uid, @uname${pkVal}${itemVal});`);
  let r;
  try { r = await insert(); }
  catch (e) {
    if (!INS_DUP.has(e.number)) throw e;
    r = await insert();
  }
  const analysisId = r.recordset[0].AnalysisId.toLowerCase();
  const itemNumber = wantsItem ? Number(r.recordset[0].ItemNumber) : null;
  context.res = jsonRes(201, {
    ok: true, analysisId, input,
    projectKey: projectKey || null, itemNumber,
    currentVersionNumber: 0,
    source: input.source ? {
      projectId, budgetVersionId: sourceBudgetVersionId,
      budgetVersionNumber: input.source.budgetVersionNumber
    } : null
  });
};
