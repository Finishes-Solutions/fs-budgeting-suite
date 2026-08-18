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
const { parts, grossIncome, totUnits, nz } = require('../shared/budget-calc');
const { GUID_RX, jsonRes } = require('../shared/investment-persistence');
const { ensureUser } = require('../shared/users');
const D = require('../shared/investment/defaults');

const ID_RX = /^(OP-\d{4}|BD-\d{4}|AS-\d{4}|TST-\d{4})$/;
const FULL_VISIBILITY_ROLES = new Set(['director', 'super_admin']);

module.exports = async function (context, req) {
  const pool = await getPool();
  const principal = getPrincipal(req);
  const userId = principal ? (principal.userId || null) : null;

  if (req.method === 'GET') {
    let appRole = 'user';
    if (userId) {
      try {
        const row = await ensureUser(pool, principal, {});
        if (row) appRole = row.AppRole || 'user';
      } catch (e) { /* default to user */ }
    }
    const swaSuper = principal && Array.isArray(principal.userRoles) && principal.userRoles.includes('super_admin');
    const canSeeAll = swaSuper || FULL_VISIBILITY_ROLES.has(appRole);

    const projectId = (req.query.projectId || '').toUpperCase();
    if (projectId && !ID_RX.test(projectId)) { context.res = jsonRes(400, { error: 'bad_request', message: 'Invalid project ID filter.' }); return; }
    const rq = pool.request();
    let where = 'a.IsDeleted = 0';
    if (projectId) { rq.input('pid', sql.VarChar(16), projectId); where += ' AND a.ProjectId = @pid'; }
    if (!canSeeAll && userId) {
      rq.input('uid', sql.NVarChar(128), userId);
      where += ' AND (a.CreatedById = @uid OR a.CreatedById IS NULL)';
    }
    const r = await rq.query(
      `SELECT a.AnalysisId, a.ProjectId, a.Name, a.Status, a.CurrentVersionNumber,
              a.SourceBudgetVersionId, bv.VersionNumber AS SourceBudgetVersionNumber,
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
      status: x.Status, currentVersionNumber: x.CurrentVersionNumber,
      sourceBudgetVersionNumber: x.SourceBudgetVersionNumber,
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

  let input, projectId = null, sourceBudgetVersionId = null;

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
    const r = await rq.query(
      `SELECT v.Id, v.VersionNumber, v.Doc, v.Name, v.ContractSum, v.ProjectCost
       FROM dbo.BudgetVersions AS v
       JOIN dbo.Budgets AS b ON b.ProjectId = v.ProjectId AND b.IsDeleted = 0
       WHERE v.ProjectId = @pid AND ${versionFilter}`);
    if (!r.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Budget version not found.' }); return; }
    const v = r.recordset[0];
    sourceBudgetVersionId = v.Id;

    let doc;
    try { doc = JSON.parse(v.Doc); } catch (_) { doc = null; }
    if (!doc) { context.res = jsonRes(500, { error: 'source_unreadable', message: 'The budget version document could not be read.' }); return; }

    // Server-derived suggestions from the immutable version document. Gross
    // scheduled rent, never the budget's Net Income/Yr; project cost as a
    // labeled, editable suggestion; service expenses only as supporting data.
    const p = parts(doc), gi = grossIncome(doc), tu = totUnits(doc);
    const siteSF = nz(doc.siteSF), bldgSF = nz(doc.resSF) + nz(doc.amenSF);
    const round2 = x => Math.round(x * 100) / 100;
    input = {
      schemaVersion: 1,
      analysisName: typeof body.analysisName === 'string' && body.analysisName.trim()
        ? body.analysisName.trim().slice(0, 200) : (v.Name + ' — Investment Analysis').slice(0, 200),
      source: {
        projectId,
        budgetVersionId: v.Id,
        budgetVersionNumber: v.VersionNumber,
        importedAt: new Date().toISOString(),
        fieldOrigins: {
          'property.name': 'Budget name',
          'property.address': 'Budget address',
          'property.size': siteSF > 0 ? 'Budget Site SF' : 'Budget Residential + Amenity SF',
          'property.unitCount': 'Budget unit mix',
          'acquisition.basis': 'Budget Total Project Cost',
          'income.year1PotentialIncome': 'Budget unit mix — gross scheduled rent × 12',
          'income.otherIncome': 'Budget other-income rows × 12'
        },
        support: {
          contractSum: round2(p.contract),
          projectCost: round2(p.project),
          annualServiceExpenses: round2(12 * gi.expMo),
          serviceExpenseRows: (doc.expenses || []).map(e => ({
            label: e.label, annualAmount: round2(12 * nz(e.rate) *
              (e.per === 'fixed' ? (nz(e.count) || 1) : (e.auto ? tu : nz(e.count)))) })),
          unitMix: (doc.units || []).map(u => ({ label: u.label, count: nz(u.count), rent: nz(u.rent) }))
        }
      },
      property: {
        name: doc.name || v.Name || projectId,
        address: doc.address || '',
        size: { unit: 'squareFeet', value: siteSF > 0 ? siteSF : bldgSF },
        unitCount: tu || null,
        purchaseMonth: null                       // the user must choose — never invented
      },
      projection: { years: 5, taxMode: 'beforeTax' },
      acquisition: { basis: { mode: 'purchasePrice', value: round2(p.project) }, costPercent: D.acquisitionCostPercent },
      income: {
        mode: 'aggregate',
        year1PotentialIncome: round2(12 * gi.rentMo),
        growth: { mode: 'constant', value: D.incomeGrowth },
        otherIncome: (doc.other || []).map(o => ({
          label: o.label || 'Other Income',
          year1Amount: round2(12 * nz(o.rate) * (o.auto ? tu : nz(o.count))),
          growth: { mode: 'constant', value: D.otherIncomeGrowth }
        }))
      },
      vacancy: { mode: 'constant', value: D.vacancy },
      expenses: { mode: 'percentOfGOI', value: null },   // imported rows are NOT complete OPEX
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
      const val = op.split('.').reduce((v, k) => (v === null || v === undefined ? v : v[k]), input);
      input.source.originalValues[op] = val === undefined ? null : JSON.parse(JSON.stringify(val));
    }
  } else if (body.mode === 'standalone') {
    const given = body.input && typeof body.input === 'object' ? body.input : {};
    const name = typeof body.analysisName === 'string' && body.analysisName.trim()
      ? body.analysisName.trim() : (typeof given.analysisName === 'string' ? given.analysisName : '');
    if (!name) { context.res = jsonRes(400, { error: 'bad_request', message: 'analysisName is required.' }); return; }
    input = Object.assign({
      schemaVersion: 1,
      property: { name: name, address: '', size: { unit: 'squareFeet', value: null }, purchaseMonth: null },
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

  const r = await pool.request()
    .input('pid', sql.VarChar(16), projectId)
    .input('name', sql.NVarChar(200), input.analysisName)
    .input('sbv', sql.BigInt, sourceBudgetVersionId)
    .input('input', sql.NVarChar(sql.MAX), JSON.stringify(input))
    .input('calc', sql.VarChar(40), require('../shared/investment/constants').CALCULATION_VERSION)
    .input('uid', sql.NVarChar(128), userId)
    .input('uname', sql.NVarChar(200), userName)
    .query(`INSERT INTO dbo.InvestmentAnalyses
              (ProjectId, Name, SourceBudgetVersionId, InputDoc, NormalizedInputDoc, ResultDoc,
               ContentHash, CalculationVersion, CreatedById, CreatedByName)
            OUTPUT INSERTED.AnalysisId
            VALUES (@pid, @name, @sbv, @input, N'{}', N'{}',
                    REPLICATE('0', 64), @calc, @uid, @uname);`);
  const analysisId = r.recordset[0].AnalysisId.toLowerCase();
  context.res = jsonRes(201, {
    ok: true, analysisId, input,
    currentVersionNumber: 0,
    source: input.source ? {
      projectId, budgetVersionId: sourceBudgetVersionId,
      budgetVersionNumber: input.source.budgetVersionNumber
    } : null
  });
};
