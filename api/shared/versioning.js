// Shared helpers for writing budgets and their immutable version snapshots.
// Kept out of api/budget/index.js so the SOV projection used for the current
// rows and for a version snapshot can never drift apart.
const { sql } = require('./db');
const { sovRows, qtyOf } = require('./sov');

// Rows are inserted in batches rather than one statement per line: a
// multifamily budget carries ~103 lines, and the save now holds an update lock
// on the budget while it runs, so round trips are worth cutting.
const CHUNK = 50;

async function writeSovLines(tx, projectId, rows) {
  await new sql.Request(tx).input('id', sql.VarChar(16), projectId)
    .query('DELETE FROM dbo.SovLines WHERE ProjectId = @id');
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const rq = new sql.Request(tx).input('id', sql.VarChar(16), projectId);
    const values = chunk.map((r, j) => {
      rq.input('o' + j, sql.Int, r.lineOrder);
      rq.input('k' + j, sql.VarChar(64), r.lineKey);
      rq.input('s' + j, sql.VarChar(10), r.scope);
      rq.input('g' + j, sql.NVarChar(120), r.grp);
      rq.input('c' + j, sql.NVarChar(20), r.code);
      rq.input('d' + j, sql.NVarChar(300), r.descr);
      rq.input('b' + j, sql.VarChar(10), r.basis);
      rq.input('q' + j, sql.Decimal(18, 2), r.qty);
      rq.input('r' + j, sql.Decimal(18, 4), r.rate);
      rq.input('t' + j, sql.Decimal(18, 2), r.total);
      return `(@id, @o${j}, @k${j}, @s${j}, @g${j}, @c${j}, @d${j}, @b${j}, @q${j}, @r${j}, @t${j}, 'parametric-estimate')`;
    }).join(',');
    await rq.query(
      `INSERT INTO dbo.SovLines
         (ProjectId, LineOrder, LineKey, Scope, Grp, Code, Descr, Basis, Qty, Rate, Total, Provenance)
       VALUES ${values}`);
  }
}

// Insert one immutable version row and return its Id. The versioned SOV rows
// are copied server-side from dbo.SovLines, which guarantees a version's lines
// are exactly the current lines at that instant — no second projection to
// disagree with the first.
async function insertVersion(tx, v) {
  const r = await new sql.Request(tx)
    .input('id', sql.VarChar(16), v.projectId)
    .input('vn', sql.Int, v.versionNumber)
    .input('name', sql.NVarChar(200), v.name || '')
    .input('type', sql.NVarChar(50), v.type || 'Multifamily')
    .input('status', sql.NVarChar(30), v.status || 'Draft')
    .input('cs', sql.Decimal(18, 2), v.contractSum || 0)
    .input('pc', sql.Decimal(18, 2), v.projectCost || 0)
    .input('pv', sql.NVarChar(32), v.pricingVersion || null)
    .input('tk', sql.VarChar(64), v.templateKey || null)
    .input('tv', sql.BigInt, v.templateVersionId || null)
    .input('doc', sql.NVarChar(sql.MAX), v.docJson)
    .input('hash', sql.Char(64), v.contentHash)
    .input('summary', sql.NVarChar(1000), v.changeSummary || null)
    .input('uid', sql.NVarChar(128), v.userId || null)
    .input('uname', sql.NVarChar(200), v.userName || null)
    .query(`INSERT INTO dbo.BudgetVersions
              (ProjectId, VersionNumber, Name, Type, Status, ContractSum, ProjectCost,
               PricingVersion, TemplateKey, TemplateVersionId, Doc, ContentHash,
               DocumentSchemaVersion, ChangeSummary, CreatedById, CreatedByName)
            VALUES (@id, @vn, @name, @type, @status, @cs, @pc, @pv, @tk, @tv, @doc, @hash,
                    1, @summary, @uid, @uname);
            SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS Id;`);
  const versionId = r.recordset[0].Id;

  await new sql.Request(tx)
    .input('vid', sql.BigInt, versionId)
    .input('id', sql.VarChar(16), v.projectId)
    .query(`INSERT INTO dbo.BudgetVersionSovLines
              (BudgetVersionId, LineOrder, LineKey, Scope, Grp, Code, Descr, Basis, Qty, Rate, Total, Provenance)
            SELECT @vid,
                   ROW_NUMBER() OVER (ORDER BY ISNULL(LineOrder, 2147483647), Id),
                   LineKey, Scope, Grp, Code, Descr, Basis, Qty, Rate, Total, Provenance
            FROM dbo.SovLines WHERE ProjectId = @id`);
  return versionId;
}

module.exports = { sovRows, qtyOf, writeSovLines, insertVersion };
