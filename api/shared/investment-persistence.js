// Shared persistence for investment analyses: content hashing, current annual
// rows, and immutable version snapshots. Kept out of the Function bodies so
// the current rows and a version's rows can never drift apart — a version's
// annual rows are copied server-side from the current rows in the same
// transaction, exactly like BudgetVersionSovLines.
const { sql } = require('./db');
const { contentHash } = require('./canonical');
const { annualRows } = require('./investment/result-rows');

const GUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// What "content changed" means for an analysis: the raw assumptions, the
// budget version they were imported from, and the engine that would calculate
// them. A new engine version therefore versions on next save instead of
// silently rewriting history.
function analysisContentHash(rawInput, sourceBudgetVersionId, calculationVersion) {
  return contentHash({ rawInput, sourceBudgetVersionId: sourceBudgetVersionId || null, calculationVersion });
}

// Queryable summary columns, always derived from the canonical result.
function summaryValues(result) {
  const s = result.summary;
  return {
    purchasePrice: s.purchasePrice,
    year1NOI: s.year1NOI,
    initialEquity: s.initialEquity,
    finalYearEquityIRR: s.finalYearEquityIRR,
    optimalHoldingYear: s.optimalHoldingYear
  };
}

const ANNUAL_COLS = `AnalysisYear, PeriodEnd, PotentialIncome, VacancyLoss, EffectiveRentalIncome,
  OtherIncome, GrossOperatingIncome, OperatingExpenses, NetOperatingIncome, CapitalExpenses,
  DebtService, CashFlowBeforeTaxes, EndingLoanBalance, GrossSalePrice, SellingCosts,
  NetSaleProceeds, ProjectedLTV, DSCR, DebtYield, CashOnCash, ReturnOnEquity, EquityMultiple,
  PropertyIRR, EffectiveLoanRate, EquityIRR, LeverageImpact`;

// Money columns round to the DECIMAL(19,4) grid; ratio columns keep ten
// decimals. ResultDoc remains the full-precision authority.
async function writeAnnualRows(tx, analysisId, result) {
  await new sql.Request(tx).input('id', sql.UniqueIdentifier, analysisId)
    .query('DELETE FROM dbo.InvestmentAnnualResults WHERE AnalysisId = @id');
  const rows = annualRows(result);
  const rq = new sql.Request(tx).input('id', sql.UniqueIdentifier, analysisId);
  const money = ['potentialIncome', 'vacancyLoss', 'effectiveRentalIncome', 'otherIncome',
    'grossOperatingIncome', 'operatingExpenses', 'netOperatingIncome', 'capitalExpenses',
    'debtService', 'cashFlowBeforeTaxes', 'endingLoanBalance', 'grossSalePrice',
    'sellingCosts', 'netSaleProceeds'];
  const ratios = ['projectedLTV', 'dscr', 'debtYield', 'cashOnCash', 'returnOnEquity',
    'equityMultiple', 'propertyIRR', 'effectiveLoanRate', 'equityIRR', 'leverageImpact'];
  const values = rows.map((r, i) => {
    rq.input('y' + i, sql.TinyInt, r.analysisYear);
    rq.input('pe' + i, sql.Char(7), r.periodEnd);
    money.forEach((c, j) => rq.input('m' + i + '_' + j, sql.Decimal(19, 4), r[c] === null ? 0 : r[c]));
    ratios.forEach((c, j) => rq.input('r' + i + '_' + j, sql.Decimal(19, 10), r[c]));
    return `(@id, @y${i}, @pe${i}, ${money.map((_, j) => '@m' + i + '_' + j).join(', ')}, ${ratios.map((_, j) => '@r' + i + '_' + j).join(', ')})`;
  }).join(',\n');
  await rq.query(`INSERT INTO dbo.InvestmentAnnualResults (AnalysisId, ${ANNUAL_COLS}) VALUES ${values}`);
}

// Insert one immutable version and copy the current annual rows server-side.
// Returns the new version row's Id.
async function insertAnalysisVersion(tx, a) {
  const r = await new sql.Request(tx)
    .input('id', sql.UniqueIdentifier, a.analysisId)
    .input('vn', sql.Int, a.versionNumber)
    .input('pid', sql.VarChar(16), a.projectId)
    .input('sbv', sql.BigInt, a.sourceBudgetVersionId)
    .input('name', sql.NVarChar(200), a.name)
    .input('input', sql.NVarChar(sql.MAX), a.inputJson)
    .input('norm', sql.NVarChar(sql.MAX), a.normalizedJson)
    .input('result', sql.NVarChar(sql.MAX), a.resultJson)
    .input('schema', sql.Int, a.inputSchemaVersion)
    .input('calc', sql.VarChar(40), a.calculationVersion)
    .input('hash', sql.Char(64), a.contentHash)
    .input('summary', sql.NVarChar(1000), a.changeSummary)
    .input('pp', sql.Decimal(19, 4), a.summary.purchasePrice)
    .input('noi', sql.Decimal(19, 4), a.summary.year1NOI)
    .input('eq', sql.Decimal(19, 4), a.summary.initialEquity)
    .input('irr', sql.Decimal(19, 10), a.summary.finalYearEquityIRR)
    .input('hold', sql.TinyInt, a.summary.optimalHoldingYear)
    .input('uid', sql.NVarChar(128), a.userId)
    .input('uname', sql.NVarChar(200), a.userName)
    .query(`INSERT INTO dbo.InvestmentAnalysisVersions
              (AnalysisId, VersionNumber, ProjectId, SourceBudgetVersionId, Name,
               InputDoc, NormalizedInputDoc, ResultDoc, InputSchemaVersion,
               CalculationVersion, ContentHash, ChangeSummary,
               PurchasePrice, Year1NOI, InitialEquity, FinalYearEquityIRR, OptimalHoldingYear,
               CreatedById, CreatedByName)
            OUTPUT INSERTED.Id
            VALUES (@id, @vn, @pid, @sbv, @name, @input, @norm, @result, @schema,
                    @calc, @hash, @summary, @pp, @noi, @eq, @irr, @hold, @uid, @uname);`);
  const versionId = r.recordset[0].Id;
  await new sql.Request(tx)
    .input('vid', sql.BigInt, versionId)
    .input('id', sql.UniqueIdentifier, a.analysisId)
    .query(`INSERT INTO dbo.InvestmentVersionAnnualResults (AnalysisVersionId, ${ANNUAL_COLS})
            SELECT @vid, ${ANNUAL_COLS}
            FROM dbo.InvestmentAnnualResults WHERE AnalysisId = @id;`);
  return versionId;
}

// Structured errors only — no raw SQL errors or stack traces reach the client.
function jsonRes(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function validationRes(fields) {
  return jsonRes(400, { error: 'validation_failed', message: 'Correct the highlighted assumptions.', fields });
}

module.exports = { GUID_RX, analysisContentHash, summaryValues, writeAnnualRows,
                   insertAnalysisVersion, jsonRes, validationRes };
