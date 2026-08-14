// Read-only immutable version history for one investment analysis.
// GET /api/investment-analysis/{id}/versions       — the list
// GET /api/investment-analysis/{id}/versions/{n}   — one full snapshot
// Old versions are returned exactly as stored — never recalculated — and each
// carries the calculation version that produced it.
const { getPool, sql } = require('../shared/db');
const { GUID_RX, jsonRes } = require('../shared/investment-persistence');

module.exports = async function (context, req) {
  const id = (context.bindingData.id || '').toLowerCase();
  if (!GUID_RX.test(id)) { context.res = jsonRes(400, { error: 'bad_request', message: 'Invalid analysis ID.' }); return; }
  const pool = await getPool();

  const head = await pool.request().input('id', sql.UniqueIdentifier, id)
    .query(`SELECT CurrentVersionNumber FROM dbo.InvestmentAnalyses
            WHERE AnalysisId = @id AND IsDeleted = 0`);
  if (!head.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Not found' }); return; }
  const currentVersion = head.recordset[0].CurrentVersionNumber;

  const vn = context.bindingData.versionNumber;
  if (vn === undefined || vn === null || vn === '') {
    const r = await pool.request().input('id', sql.UniqueIdentifier, id)
      .query(`SELECT VersionNumber, Name, ChangeSummary, CalculationVersion, InputSchemaVersion,
                     PurchasePrice, Year1NOI, InitialEquity, FinalYearEquityIRR, OptimalHoldingYear,
                     CreatedById, CreatedByName, CreatedAt
              FROM dbo.InvestmentAnalysisVersions
              WHERE AnalysisId = @id ORDER BY VersionNumber DESC`);
    context.res = jsonRes(200, {
      analysisId: id, currentVersion,
      versions: r.recordset.map(v => ({
        versionNumber: v.VersionNumber, name: v.Name, changeSummary: v.ChangeSummary,
        calculationVersion: v.CalculationVersion, inputSchemaVersion: v.InputSchemaVersion,
        purchasePrice: v.PurchasePrice === null ? null : +v.PurchasePrice,
        year1NOI: v.Year1NOI === null ? null : +v.Year1NOI,
        initialEquity: v.InitialEquity === null ? null : +v.InitialEquity,
        finalYearEquityIRR: v.FinalYearEquityIRR === null ? null : +v.FinalYearEquityIRR,
        optimalHoldingYear: v.OptimalHoldingYear,
        createdByName: v.CreatedByName, createdAt: v.CreatedAt,
        isCurrent: v.VersionNumber === currentVersion
      }))
    });
    return;
  }

  if (!/^\d+$/.test(String(vn))) { context.res = jsonRes(400, { error: 'bad_request', message: 'Version number must be a positive integer.' }); return; }
  const r = await pool.request()
    .input('id', sql.UniqueIdentifier, id)
    .input('vn', sql.Int, parseInt(vn, 10))
    .query(`SELECT VersionNumber, Name, ChangeSummary, CalculationVersion, InputSchemaVersion,
                   InputDoc, ResultDoc, SourceBudgetVersionId, CreatedByName, CreatedAt
            FROM dbo.InvestmentAnalysisVersions
            WHERE AnalysisId = @id AND VersionNumber = @vn`);
  if (!r.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Version not found' }); return; }
  const v = r.recordset[0];
  const parse = s => { try { return JSON.parse(s); } catch (_) { return null; } };
  context.res = jsonRes(200, {
    analysisId: id, currentVersion,
    version: {
      versionNumber: v.VersionNumber, name: v.Name, changeSummary: v.ChangeSummary,
      calculationVersion: v.CalculationVersion, inputSchemaVersion: v.InputSchemaVersion,
      sourceBudgetVersionId: v.SourceBudgetVersionId,
      createdByName: v.CreatedByName, createdAt: v.CreatedAt,
      isCurrent: v.VersionNumber === currentVersion
    },
    input: parse(v.InputDoc),
    result: parse(v.ResultDoc)
  });
};
