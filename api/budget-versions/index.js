// Read-only budget version history.
//   GET /api/budget/{id}/versions            → metadata, newest first
//   GET /api/budget/{id}/versions/{number}   → one immutable version + its SOV rows
//
// Viewing history never touches the current budget: every query here is a SELECT.
// Restore, rollback, compare and version deletion are deliberately not offered.
const { getPool, sql } = require('../shared/db');

const ID_RX = /^(OP-\d{4}|BD-\d{4}|AS-\d{4}|TST-\d{4})$/;

module.exports = async function (context, req) {
  const id = (context.bindingData.id || '').toUpperCase();
  if (!ID_RX.test(id)) { context.res = { status: 400, body: 'Invalid project ID (OP-#### / BD-#### / AS-#### / TST-####)' }; return; }

  const raw = context.bindingData.versionNumber;
  let versionNumber = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    if (!/^\d+$/.test(String(raw))) { context.res = { status: 400, body: 'Version number must be a positive integer' }; return; }
    versionNumber = parseInt(raw, 10);
    if (versionNumber < 1) { context.res = { status: 400, body: 'Version number must be a positive integer' }; return; }
  }

  const pool = await getPool();

  // A soft-deleted budget is invisible to the app, so its history is too —
  // consistent with GET /api/budget/{id} returning 404 for the same row.
  const b = await pool.request().input('id', sql.VarChar(16), id)
    .query('SELECT ProjectId FROM dbo.Budgets WHERE ProjectId = @id AND IsDeleted = 0');
  if (!b.recordset.length) { context.res = { status: 404, body: 'Not found' }; return; }

  const latest = await pool.request().input('id', sql.VarChar(16), id)
    .query('SELECT ISNULL(MAX(VersionNumber), 0) AS MaxV FROM dbo.BudgetVersions WHERE ProjectId = @id');
  const maxV = latest.recordset[0].MaxV;

  if (versionNumber === null) {
    const r = await pool.request().input('id', sql.VarChar(16), id)
      .query(`SELECT v.VersionNumber, v.CreatedAt, v.CreatedByName, v.ChangeSummary, v.Status,
                     v.ContractSum, v.ProjectCost, v.PricingVersion,
                     v.TemplateKey, t.Name AS TemplateName, tv.VersionNumber AS TemplateVersionNumber
              FROM dbo.BudgetVersions AS v
              LEFT JOIN dbo.BudgetTemplates AS t ON t.TemplateKey = v.TemplateKey
              LEFT JOIN dbo.BudgetTemplateVersions AS tv ON tv.Id = v.TemplateVersionId
              WHERE v.ProjectId = @id
              ORDER BY v.VersionNumber DESC`);
    context.res = {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: id, currentVersion: maxV, versions: r.recordset.map(meta) })
    };
    return;
  }

  const r = await pool.request()
    .input('id', sql.VarChar(16), id)
    .input('vn', sql.Int, versionNumber)
    .query(`SELECT v.Id, v.VersionNumber, v.CreatedAt, v.CreatedByName, v.ChangeSummary, v.Status,
                   v.ContractSum, v.ProjectCost, v.PricingVersion, v.Doc,
                   v.TemplateKey, t.Name AS TemplateName, tv.VersionNumber AS TemplateVersionNumber
            FROM dbo.BudgetVersions AS v
            LEFT JOIN dbo.BudgetTemplates AS t ON t.TemplateKey = v.TemplateKey
            LEFT JOIN dbo.BudgetTemplateVersions AS tv ON tv.Id = v.TemplateVersionId
            WHERE v.ProjectId = @id AND v.VersionNumber = @vn`);
  if (!r.recordset.length) { context.res = { status: 404, body: 'Version not found' }; return; }
  const row = r.recordset[0];

  const lines = await pool.request().input('vid', sql.BigInt, row.Id)
    .query(`SELECT LineOrder, LineKey, Scope, Grp, Code, Descr, Basis, Qty, Rate, Total, Provenance
            FROM dbo.BudgetVersionSovLines WHERE BudgetVersionId = @vid ORDER BY LineOrder`);

  context.res = {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: id,
      currentVersion: maxV,
      version: meta(row),
      doc: JSON.parse(row.Doc),
      sovLines: lines.recordset.map(l => ({
        lineOrder: l.LineOrder, lineKey: l.LineKey, scope: l.Scope, grp: l.Grp,
        code: l.Code, desc: l.Descr, basis: l.Basis,
        qty: Number(l.Qty), rate: Number(l.Rate), total: Number(l.Total),
        provenance: l.Provenance
      }))
    })
  };

  function meta(x) {
    return {
      versionNumber: x.VersionNumber,
      isCurrent: x.VersionNumber === maxV,
      createdAt: x.CreatedAt ? x.CreatedAt.toISOString() : null,
      createdByName: x.CreatedByName,
      changeSummary: x.ChangeSummary,
      status: x.Status,
      contractSum: Number(x.ContractSum),
      projectCost: Number(x.ProjectCost),
      pricingVersion: x.PricingVersion,
      templateKey: x.TemplateKey,
      templateName: x.TemplateName,
      templateVersion: x.TemplateVersionNumber
    };
  }
};
