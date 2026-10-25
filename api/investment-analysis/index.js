// GET / PUT / DELETE one investment analysis.
//
// PUT is the save path and the server is authoritative: the raw input is
// validated and CALCULATED HERE, any client-supplied result is ignored, and a
// meaningful change (hash over {rawInput, sourceBudgetVersionId,
// calculationVersion}) updates the current rows and inserts one immutable
// version — atomically, serialized per analysis with UPDLOCK+HOLDLOCK.
// `expectedVersionNumber` gives optimistic concurrency: a stale save gets 409
// instead of silently overwriting someone else's version.
const { getPool, sql } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const { features } = require('../shared/schema');
const { calculateInvestmentAnalysis } = require('../shared/investment/calculate');
const C = require('../shared/investment/constants');
const { GUID_RX, analysisContentHash, summaryValues, writeAnnualRows,
        insertAnalysisVersion, jsonRes, validationRes } = require('../shared/investment-persistence');
const { projectFromBudget } = require('../shared/investment/from-budget');

const DUP_KEY = new Set([2627, 2601]);
const MAX_BODY = 2 * 1024 * 1024;   // 2 MB — far beyond any real assumption set

module.exports = async function (context, req) {
  const id = (context.bindingData.id || '').toLowerCase();
  if (!GUID_RX.test(id)) { context.res = jsonRes(400, { error: 'bad_request', message: 'Invalid analysis ID.' }); return; }
  const pool = await getPool();
  // Declared once, up front. The DELETE branch below used to read it before
  // the `const` further down had run — a temporal-dead-zone ReferenceError
  // thrown AFTER the soft-delete had committed, so the analysis vanished, no
  // activity row was written and the caller got a 500.
  const principal = getPrincipal(req);

  if (req.method === 'GET') {
    const gf = await features(pool);
    const idCols = gf.analysesItemNumber && gf.analysesProjectKey
      ? 'a.ItemNumber, a.ProjectKey,'
      : 'CAST(NULL AS INT) AS ItemNumber, CAST(NULL AS VARCHAR(16)) AS ProjectKey,';
    const r = await pool.request().input('id', sql.UniqueIdentifier, id)
      .query(`SELECT a.AnalysisId, a.ProjectId, a.Name, a.Status, a.CurrentVersionNumber,
                     ${idCols}
                     a.SourceBudgetVersionId, bv.VersionNumber AS SourceBudgetVersionNumber,
                     a.InputDoc, a.NormalizedInputDoc, a.ResultDoc,
                     a.InputSchemaVersion, a.CalculationVersion, a.CreatedAt, a.UpdatedAt,
                     (SELECT MAX(v2.VersionNumber) FROM dbo.BudgetVersions AS v2
                       WHERE v2.ProjectId = a.ProjectId) AS BudgetCurrentVersionNumber
              FROM dbo.InvestmentAnalyses AS a
              LEFT JOIN dbo.BudgetVersions AS bv ON bv.Id = a.SourceBudgetVersionId
              WHERE a.AnalysisId = @id AND a.IsDeleted = 0`);
    if (!r.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Not found' }); return; }
    const a = r.recordset[0];
    const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };
    const result = parse(a.ResultDoc);
    context.res = jsonRes(200, {
      analysisId: a.AnalysisId.toLowerCase(), projectId: a.ProjectId, name: a.Name,
      projectKey: a.ProjectKey || null,
      itemNumber: a.ItemNumber === null || a.ItemNumber === undefined ? null : Number(a.ItemNumber),
      status: a.Status, currentVersionNumber: a.CurrentVersionNumber,
      source: a.SourceBudgetVersionId ? {
        projectId: a.ProjectId, budgetVersionId: a.SourceBudgetVersionId,
        budgetVersionNumber: a.SourceBudgetVersionNumber,
        // The budget's CURRENT version, so the client can say "budget updated
        // to v7 — re-sync". Nothing recalculates on its own: a saved analysis
        // is never quietly restated (docs/DATA_CONTRACT.md).
        budgetCurrentVersionNumber: a.BudgetCurrentVersionNumber || null,
        drift: !!(a.BudgetCurrentVersionNumber && a.SourceBudgetVersionNumber
                  && a.BudgetCurrentVersionNumber > a.SourceBudgetVersionNumber)
      } : null,
      input: parse(a.InputDoc),
      result: result && result.annual ? result : null,
      inputSchemaVersion: a.InputSchemaVersion,
      calculationVersion: a.CalculationVersion,
      createdAt: a.CreatedAt, updatedAt: a.UpdatedAt
    });
    return;
  }

  if (req.method === 'DELETE') {
    const r = await pool.request().input('id', sql.UniqueIdentifier, id)
      .query(`SELECT TOP 1 Name, ProjectId, ProjectKey FROM dbo.InvestmentAnalyses WHERE AnalysisId = @id;
              UPDATE dbo.InvestmentAnalyses SET IsDeleted = 1, DeletedAt = SYSUTCDATETIME()
              WHERE AnalysisId = @id AND IsDeleted = 0;
              SELECT COUNT(*) AS Found FROM dbo.InvestmentAnalyses WHERE AnalysisId = @id;`);
    const before = (r.recordsets[0] || [])[0] || null;
    if (!(r.recordsets[1] || [])[0] || !r.recordsets[1][0].Found) {
      context.res = jsonRes(404, { error: 'not_found', message: 'Not found' }); return;
    }
    context.res = { status: 204 };
    // Deleting an analysis recorded nothing before this. The principal is read
    // HERE: the `const principal` further down is not initialised on this path,
    // and touching it threw after the delete had already happened.
    await require('../shared/users').recordActivity(pool, getPrincipal(req), 'analysis_delete', 'analysis', id,
      before ? { name: before.Name || null, budgetId: before.ProjectId || null,
                 projectKey: before.ProjectKey || null } : null);
    return;
  }

  // ---- PUT
  const body = req.body || {};

  /* PUT ?scope=resync — re-read the budget's CURRENT version and refresh only
     the imported fields, leaving everything the user typed alone.
     It is a PROPOSAL and writes NOTHING: the re-synced input comes back to the
     browser, which shows what changes and applies it as unsaved edits; the
     ordinary save (with expectedVersionNumber and resyncBudgetVersionId) is
     what records it. Writing it here used to restate the stored inputs and
     re-point the source behind the saved result's back — a reopened analysis
     showed the new inputs beside the old result, not marked stale, and the
     user's Discard discarded nothing. `body.input`, when sent, is the copy on
     screen, so unsaved edits elsewhere survive the re-sync.
     Extends a route that already deploys rather than adding a function folder. */
  if (String((req.query && req.query.scope) || '') === 'resync') {
    if (JSON.stringify(body).length > MAX_BODY) { context.res = jsonRes(413, { error: 'too_large', message: 'The analysis input is too large.' }); return; }
    const cur = await pool.request().input('id', sql.UniqueIdentifier, id)
      .query(`SELECT a.ProjectId, a.InputDoc, a.CurrentVersionNumber
              FROM dbo.InvestmentAnalyses AS a WHERE a.AnalysisId = @id AND a.IsDeleted = 0`);
    if (!cur.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Not found' }); return; }
    const row = cur.recordset[0];
    if (!row.ProjectId) {
      context.res = jsonRes(400, { error: 'not_linked',
        message: 'This analysis is standalone — there is no budget to re-sync from.' });
      return;
    }
    let input;
    if (body.input && typeof body.input === 'object' && !Array.isArray(body.input)) {
      input = JSON.parse(JSON.stringify(body.input));
    } else {
      try { input = JSON.parse(row.InputDoc); } catch (_) { input = null; }
    }
    if (!input) { context.res = jsonRes(500, { error: 'unreadable', message: 'The stored assumptions could not be read.' }); return; }

    const bv = await pool.request().input('pid', sql.VarChar(16), row.ProjectId)
      .query(`SELECT TOP 1 v.Id, v.VersionNumber, v.Doc, v.Name
              FROM dbo.BudgetVersions AS v
              JOIN dbo.Budgets AS b ON b.ProjectId = v.ProjectId AND b.IsDeleted = 0
              WHERE v.ProjectId = @pid ORDER BY v.VersionNumber DESC`);
    if (!bv.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Budget version not found.' }); return; }
    const v = bv.recordset[0];
    let bdoc; try { bdoc = JSON.parse(v.Doc); } catch (_) { bdoc = null; }
    if (!bdoc) { context.res = jsonRes(500, { error: 'source_unreadable', message: 'The budget version document could not be read.' }); return; }

    // Derived against the vacancy this analysis actually carries, not the
    // organisation default — the ratio is a share of GOI, and GOI is after
    // vacancy.
    const vacancy = input.vacancy && Number.isFinite(+input.vacancy.value) ? +input.vacancy.value : undefined;
    const proj = projectFromBudget(bdoc, v, { projectId: row.ProjectId, vacancy,
      scope: input.source && input.source.scope });
    // Re-sync never turns a component or phase analysis into a whole-project
    // one: if its slice is gone, refuse and change nothing.
    if (proj.scopeMissing) {
      context.res = jsonRes(409, { error: 'scope_missing',
        message: 'The component or phase this analysis was built from is no longer in the budget. Nothing was changed.' });
      return;
    }

    input.property = Object.assign({}, input.property, {
      name: proj.imported.property.name,
      address: proj.imported.property.address,
      size: proj.imported.property.size,
      unitCount: proj.imported.property.unitCount
    });
    input.acquisition = Object.assign({}, input.acquisition, { basis: proj.imported.acquisition.basis });
    input.income = Object.assign({}, input.income, {
      year1PotentialIncome: proj.imported.income.year1PotentialIncome,
      otherIncome: proj.imported.income.otherIncome
    });
    // An explicit override survives a re-sync — the user turned it on knowing
    // it would stop tracking the budget. Its provenance still refreshes, so the
    // warning can say what it no longer matches.
    const overridden = !!(input.expenses && input.expenses.override);
    input.expenses = overridden
      ? Object.assign({}, input.expenses, { derivedFrom: proj.imported.expenses.derivedFrom })
      : proj.imported.expenses;

    input.source = Object.assign({}, input.source || {}, {
      projectId: row.ProjectId, budgetVersionId: v.Id, budgetVersionNumber: v.VersionNumber,
      syncedAt: new Date().toISOString(),
      fieldOrigins: proj.fieldOrigins, support: proj.support, scope: proj.scope,
      // originalValues is deliberately NOT rewritten: the From Budget badges
      // compare against the ORIGINAL import forever.
      originalValues: (input.source && input.source.originalValues) || {},
      importedAt: (input.source && input.source.importedAt) || new Date().toISOString()
    });

    // Deliberately no UPDATE — see the comment above.
    context.res = jsonRes(200, { ok: true, input, expensesOverridden: overridden,
      source: { projectId: row.ProjectId, budgetVersionId: v.Id, budgetVersionNumber: v.VersionNumber,
                budgetCurrentVersionNumber: v.VersionNumber, drift: false },
      message: 'Re-synced from budget ' + row.ProjectId + ' v' + v.VersionNumber
        + '. Nothing is stored until the analysis is saved.' });
    return;
  }

  // PUT with { status } only — the quick status change from the lists, cards
  // and editor chip. No calculation, no version, works on incomplete drafts.
  const STATUSES = ['Draft', 'In Review', 'Completed', 'Cancelled'];
  if (body.input === undefined && typeof body.status === 'string') {
    if (!STATUSES.includes(body.status)) {
      context.res = jsonRes(400, { error: 'bad_request', message: 'status must be one of: ' + STATUSES.join(', ') }); return;
    }
    const sr = await pool.request().input('id', sql.UniqueIdentifier, id)
      .input('st', sql.NVarChar(30), body.status)
      .query(`UPDATE dbo.InvestmentAnalyses SET Status=@st, UpdatedAt=SYSUTCDATETIME()
              WHERE AnalysisId=@id AND IsDeleted=0; SELECT @@ROWCOUNT AS N;`);
    if (!sr.recordset[0].N) { context.res = jsonRes(404, { error: 'not_found', message: 'Not found' }); return; }
    context.res = jsonRes(200, { ok: true, status: body.status });
    return;
  }

  const input = body.input;
  if (!input || typeof input !== 'object') { context.res = jsonRes(400, { error: 'bad_request', message: 'Body must be { input, expectedVersionNumber }.' }); return; }
  if (JSON.stringify(body).length > MAX_BODY) { context.res = jsonRes(413, { error: 'too_large', message: 'The analysis input is too large.' }); return; }
  // A full save changes the assumptions, not the workflow status. Absent, the
  // stored status stands (every save used to reset it to Draft); present, it
  // must be a real status, exactly as the status-only path requires.
  if (body.status !== undefined && body.status !== null && !STATUSES.includes(body.status)) {
    context.res = jsonRes(400, { error: 'bad_request', message: 'status must be one of: ' + STATUSES.join(', ') }); return;
  }
  const newStatus = typeof body.status === 'string' ? body.status : null;
  // A re-sync applied in the browser travels with the save that records it.
  const resyncTo = body.resyncBudgetVersionId === undefined || body.resyncBudgetVersionId === null
    ? null : String(body.resyncBudgetVersionId);
  if (resyncTo !== null && !/^\d{1,18}$/.test(resyncTo)) {
    context.res = jsonRes(400, { error: 'bad_request', message: 'resyncBudgetVersionId must be a budget version id.' }); return;
  }

  const userId = principal ? (principal.userId || null) : null;
  const userName = principal ? (principal.userDetails || null) : null;

  let result;
  try {
    result = calculateInvestmentAnalysis(input);   // client "result" is never read
  } catch (e) {
    if (e.validation) { context.res = validationRes(e.validation); return; }
    context.log.error('investment save calculation failed', e.message);
    context.res = jsonRes(500, { error: 'calculation_failed', message: 'The calculation could not be completed.' });
    return;
  }

  let out;
  for (let attempt = 0; ; attempt++) {
    try { out = await save(); break; }
    catch (e) {
      if (attempt === 0 && DUP_KEY.has(e.number)) continue;
      if (e.httpRes) { context.res = e.httpRes; return; }
      throw e;
    }
  }
  context.res = jsonRes(200, out);
  // Best-effort audit trail — recordActivity never throws.
  if (out.versionCreated)
    await require('../shared/users').recordActivity(pool, principal, 'analysis_save', 'analysis', id, {
      name: out.name || null,
      budgetId: out.projectId || null,
      projectKey: out.projectKey || null,
      versionNumber: out.versionNumber,
      purchasePrice: out.purchasePrice === undefined ? null : out.purchasePrice,
      year1NOI: out.year1NOI === undefined ? null : out.year1NOI
    });

  async function save() {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const cur = await new sql.Request(tx).input('id', sql.UniqueIdentifier, id)
        .query(`SELECT AnalysisId, ProjectId, ProjectKey, SourceBudgetVersionId, CurrentVersionNumber,
                       ContentHash, IsDeleted
                FROM dbo.InvestmentAnalyses WITH (UPDLOCK, HOLDLOCK) WHERE AnalysisId = @id`);
      if (!cur.recordset.length) {
        const e = new Error('not found'); e.httpRes = jsonRes(404, { error: 'not_found', message: 'Not found' }); throw e;
      }
      const a = cur.recordset[0];

      // Optimistic concurrency: the caller says which version it loaded.
      if (body.expectedVersionNumber !== undefined && body.expectedVersionNumber !== null
          && body.expectedVersionNumber !== a.CurrentVersionNumber) {
        const e = new Error('conflict');
        e.httpRes = jsonRes(409, {
          error: 'version_conflict',
          message: 'Someone saved a newer version of this analysis after you loaded it.',
          currentVersionNumber: a.CurrentVersionNumber
        });
        throw e;
      }

      // Provenance is server-owned: the stored source link survives every
      // save; a client cannot re-point an analysis at another budget version.
      // The one exception is a re-sync, and it is checked HERE rather than
      // trusted: the version must belong to this analysis's own budget and be
      // newer than the one it is pinned to.
      let sourceBudgetVersionId = a.SourceBudgetVersionId;
      if (resyncTo !== null && String(resyncTo) !== String(a.SourceBudgetVersionId)) {
        const bad = () => {
          const e = new Error('bad resync');
          e.httpRes = jsonRes(400, { error: 'bad_resync',
            message: 'That budget version cannot be re-synced into this analysis. Re-sync again, then save.' });
          return e;
        };
        if (!a.ProjectId) throw bad();
        const chk = await new sql.Request(tx)
          .input('nv', sql.BigInt, resyncTo)
          .input('ov', sql.BigInt, a.SourceBudgetVersionId === undefined ? null : a.SourceBudgetVersionId)
          .input('pid', sql.VarChar(16), a.ProjectId)
          .query(`SELECT v.Id, v.VersionNumber,
                         (SELECT o.VersionNumber FROM dbo.BudgetVersions AS o WHERE o.Id = @ov) AS PinnedNumber
                  FROM dbo.BudgetVersions AS v
                  WHERE v.Id = @nv AND v.ProjectId = @pid`);
        const hit = chk.recordset[0];
        if (!hit || (hit.PinnedNumber !== null && hit.PinnedNumber !== undefined
                     && !(hit.VersionNumber > hit.PinnedNumber))) throw bad();
        sourceBudgetVersionId = hit.Id;
      }
      if (input.source && typeof input.source === 'object') {
        input.source.budgetVersionId = sourceBudgetVersionId;
      }

      const hash = analysisContentHash(input, sourceBudgetVersionId, C.CALCULATION_VERSION);
      const unchanged = a.CurrentVersionNumber >= 1 && a.ContentHash === hash;
      const versionNumber = unchanged ? a.CurrentVersionNumber : a.CurrentVersionNumber + 1;
      const sum = summaryValues(result);
      const inputJson = JSON.stringify(input);
      const normalizedJson = JSON.stringify(result.normalizedInput);
      const resultJson = JSON.stringify(result);

      await new sql.Request(tx)
        .input('id', sql.UniqueIdentifier, id)
        .input('name', sql.NVarChar(200), result.normalizedInput.analysisName)
        .input('status', sql.NVarChar(30), newStatus)
        .input('sbv', sql.BigInt, sourceBudgetVersionId === undefined ? null : sourceBudgetVersionId)
        .input('vn', sql.Int, versionNumber)
        .input('input', sql.NVarChar(sql.MAX), inputJson)
        .input('norm', sql.NVarChar(sql.MAX), normalizedJson)
        .input('result', sql.NVarChar(sql.MAX), resultJson)
        .input('hash', sql.Char(64), hash)
        .input('schema', sql.Int, C.SCHEMA_VERSION)
        .input('calc', sql.VarChar(40), C.CALCULATION_VERSION)
        .input('years', sql.TinyInt, result.normalizedInput.projection.years)
        .input('pp', sql.Decimal(19, 4), sum.purchasePrice)
        .input('noi', sql.Decimal(19, 4), sum.year1NOI)
        .input('eq', sql.Decimal(19, 4), sum.initialEquity)
        .input('irr', sql.Decimal(19, 10), sum.finalYearEquityIRR)
        .input('hold', sql.TinyInt, sum.optimalHoldingYear)
        .query(`UPDATE dbo.InvestmentAnalyses SET
                  Name=@name, Status=COALESCE(@status, Status), SourceBudgetVersionId=@sbv,
                  CurrentVersionNumber=@vn, ProjectionYears=@years,
                  InputDoc=@input, NormalizedInputDoc=@norm, ResultDoc=@result,
                  ContentHash=@hash, InputSchemaVersion=@schema, CalculationVersion=@calc,
                  PurchasePrice=@pp, Year1NOI=@noi, InitialEquity=@eq,
                  FinalYearEquityIRR=@irr, OptimalHoldingYear=@hold,
                  IsDeleted=0, DeletedAt=NULL, UpdatedAt=SYSUTCDATETIME()
                WHERE AnalysisId=@id`);

      await writeAnnualRows(tx, id, result);

      if (!unchanged) {
        await insertAnalysisVersion(tx, {
          analysisId: id, versionNumber,
          projectId: a.ProjectId, sourceBudgetVersionId,
          name: result.normalizedInput.analysisName,
          inputJson, normalizedJson, resultJson,
          inputSchemaVersion: C.SCHEMA_VERSION,
          calculationVersion: C.CALCULATION_VERSION,
          contentHash: hash,
          changeSummary: typeof body.changeSummary === 'string' ? body.changeSummary.slice(0, 1000) : null,
          summary: sum, userId, userName
        });
      }

      await tx.commit();
      // The identity and the headline numbers travel back so the audit row can
      // name what was saved without a second read.
      return { ok: true, versionNumber, versionCreated: !unchanged, result,
               name: result.normalizedInput.analysisName,
               projectId: a.ProjectId || null,
               projectKey: a.ProjectKey || null,
               purchasePrice: sum ? sum.purchasePrice : null,
               year1NOI: sum ? sum.year1NOI : null };
    } catch (e) { await tx.rollback(); throw e; }
  }
};
