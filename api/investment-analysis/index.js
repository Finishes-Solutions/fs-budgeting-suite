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
const { calculateInvestmentAnalysis } = require('../shared/investment/calculate');
const C = require('../shared/investment/constants');
const { GUID_RX, analysisContentHash, summaryValues, writeAnnualRows,
        insertAnalysisVersion, jsonRes, validationRes } = require('../shared/investment-persistence');

const DUP_KEY = new Set([2627, 2601]);
const MAX_BODY = 2 * 1024 * 1024;   // 2 MB — far beyond any real assumption set

module.exports = async function (context, req) {
  const id = (context.bindingData.id || '').toLowerCase();
  if (!GUID_RX.test(id)) { context.res = jsonRes(400, { error: 'bad_request', message: 'Invalid analysis ID.' }); return; }
  const pool = await getPool();

  if (req.method === 'GET') {
    const r = await pool.request().input('id', sql.UniqueIdentifier, id)
      .query(`SELECT a.AnalysisId, a.ProjectId, a.Name, a.Status, a.CurrentVersionNumber,
                     a.SourceBudgetVersionId, bv.VersionNumber AS SourceBudgetVersionNumber,
                     a.InputDoc, a.NormalizedInputDoc, a.ResultDoc,
                     a.InputSchemaVersion, a.CalculationVersion, a.CreatedAt, a.UpdatedAt
              FROM dbo.InvestmentAnalyses AS a
              LEFT JOIN dbo.BudgetVersions AS bv ON bv.Id = a.SourceBudgetVersionId
              WHERE a.AnalysisId = @id AND a.IsDeleted = 0`);
    if (!r.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Not found' }); return; }
    const a = r.recordset[0];
    const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };
    const result = parse(a.ResultDoc);
    context.res = jsonRes(200, {
      analysisId: a.AnalysisId.toLowerCase(), projectId: a.ProjectId, name: a.Name,
      status: a.Status, currentVersionNumber: a.CurrentVersionNumber,
      source: a.SourceBudgetVersionId ? {
        projectId: a.ProjectId, budgetVersionId: a.SourceBudgetVersionId,
        budgetVersionNumber: a.SourceBudgetVersionNumber
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
      .query(`UPDATE dbo.InvestmentAnalyses SET IsDeleted = 1, DeletedAt = SYSUTCDATETIME()
              WHERE AnalysisId = @id AND IsDeleted = 0;
              SELECT COUNT(*) AS Found FROM dbo.InvestmentAnalyses WHERE AnalysisId = @id;`);
    if (!r.recordset[0].Found) { context.res = jsonRes(404, { error: 'not_found', message: 'Not found' }); return; }
    context.res = { status: 204 };
    return;
  }

  // ---- PUT
  const body = req.body || {};
  const input = body.input;
  if (!input || typeof input !== 'object') { context.res = jsonRes(400, { error: 'bad_request', message: 'Body must be { input, expectedVersionNumber }.' }); return; }
  if (JSON.stringify(body).length > MAX_BODY) { context.res = jsonRes(413, { error: 'too_large', message: 'The analysis input is too large.' }); return; }

  const principal = getPrincipal(req);
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

  async function save() {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const cur = await new sql.Request(tx).input('id', sql.UniqueIdentifier, id)
        .query(`SELECT AnalysisId, ProjectId, SourceBudgetVersionId, CurrentVersionNumber,
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
      const sourceBudgetVersionId = a.SourceBudgetVersionId;
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
        .input('status', sql.NVarChar(30), typeof body.status === 'string' ? body.status.slice(0, 30) : 'Draft')
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
                  Name=@name, Status=@status, CurrentVersionNumber=@vn, ProjectionYears=@years,
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
      return { ok: true, versionNumber, versionCreated: !unchanged, result };
    } catch (e) { await tx.rollback(); throw e; }
  }
};
