// Admin-managed budget templates.
//
//   GET    /api/templates                      list (non-admins see active only)
//   GET    /api/templates/{key}                template + its current published version
//   GET    /api/templates/{key}/versions       version history, newest first
//   GET    /api/templates/{key}/versions/{n}   one immutable version
//   POST   /api/templates                      create a template + version 1      (admin)
//   PUT    /api/templates/{key}                publish a new immutable version    (admin)
//   PATCH  /api/templates/{key}                name / description / type / active (admin)
//
// Every mutation is gated twice: by a route rule in staticwebapp.config.json and
// again here with hasRole(req,'pricing_admin'). There is no email allow-list and no
// client-only check. A published version is never updated, and a template is never
// hard-deleted — deactivation is how one leaves circulation.
const { getPool, sql } = require('../shared/db');
const { getPrincipal, hasRole } = require('../shared/auth');
const { contentHash } = require('../shared/canonical');

const KEY_RX = /^[a-z0-9-]{1,64}$/;
const ADMIN = 'pricing_admin';

module.exports = async function (context, req) {
  const key = (context.bindingData.key || '').toLowerCase();
  const sub = (context.bindingData.sub || '').toLowerCase();
  const n = context.bindingData.n;
  const method = req.method.toUpperCase();
  const admin = hasRole(req, ADMIN);
  const pool = await getPool();

  const bad = (code, msg) => { context.res = { status: code, body: msg }; };
  const ok = (body) => {
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  };

  if (key && !KEY_RX.test(key)) return bad(400, 'Template key must be lowercase letters, digits and hyphens');

  // ---------------------------------------------------------------- reads
  if (method === 'GET') {
    if (!key) {
      // Deactivated templates stay visible to admins so they can be revived; everyone
      // else only sees what a new budget may actually be created from.
      const r = await pool.request().query(
        `SELECT t.TemplateKey, t.Name, t.BudgetType, t.Description, t.IsActive, t.UpdatedAt,
                v.VersionNumber AS CurrentVersion, v.PublishedAt, v.PricingVersion
         FROM dbo.BudgetTemplates AS t
         LEFT JOIN dbo.BudgetTemplateVersions AS v
           ON v.TemplateKey = t.TemplateKey AND v.IsCurrent = 1
         ORDER BY t.IsActive DESC, t.Name`);
      const list = r.recordset.filter(x => admin || x.IsActive).map(meta);
      return ok({ isAdmin: admin, templates: list });
    }

    if (sub === 'versions' && (n === undefined || n === null || n === '')) {
      const r = await pool.request().input('k', sql.VarChar(64), key)
        .query(`SELECT VersionNumber, VersionLabel, IsCurrent, PricingVersion, ChangeSummary,
                       CreatedByName, CreatedAt, PublishedAt, TemplateSchemaVersion
                FROM dbo.BudgetTemplateVersions WHERE TemplateKey = @k
                ORDER BY VersionNumber DESC`);
      if (!r.recordset.length) return bad(404, 'Template not found');
      return ok({ templateKey: key, versions: r.recordset.map(versionMeta) });
    }

    if (sub === 'versions') {
      if (!/^\d+$/.test(String(n))) return bad(400, 'Version number must be a positive integer');
      const r = await pool.request().input('k', sql.VarChar(64), key).input('n', sql.Int, parseInt(n, 10))
        .query(`SELECT * FROM dbo.BudgetTemplateVersions WHERE TemplateKey = @k AND VersionNumber = @n`);
      if (!r.recordset.length) return bad(404, 'Version not found');
      const v = r.recordset[0];
      return ok({ templateKey: key, version: versionMeta(v), doc: JSON.parse(v.Doc) });
    }

    if (sub) return bad(404, 'Not found');

    const t = await pool.request().input('k', sql.VarChar(64), key)
      .query(`SELECT t.*, v.Id AS VersionId, v.VersionNumber, v.VersionLabel, v.PricingVersion,
                     v.ChangeSummary, v.CreatedByName AS VersionByName, v.PublishedAt,
                     v.TemplateSchemaVersion, v.Doc
              FROM dbo.BudgetTemplates AS t
              LEFT JOIN dbo.BudgetTemplateVersions AS v
                ON v.TemplateKey = t.TemplateKey AND v.IsCurrent = 1
              WHERE t.TemplateKey = @k`);
    if (!t.recordset.length) return bad(404, 'Template not found');
    const row = t.recordset[0];
    // A deactivated template still resolves: existing budgets that reference it must
    // keep opening, and an admin needs to be able to reactivate it.
    return ok({
      ...meta(row),
      currentVersionId: row.VersionId || null,
      changeSummary: row.ChangeSummary,
      versionLabel: row.VersionLabel,
      publishedByName: row.VersionByName,
      templateSchemaVersion: row.TemplateSchemaVersion,
      doc: row.Doc ? JSON.parse(row.Doc) : null
    });
  }

  // ---------------------------------------------------------------- writes
  if (!admin) return bad(403, 'The pricing_admin role is required to change templates');
  const principal = getPrincipal(req);
  const userId = principal ? (principal.userId || null) : null;
  const userName = principal ? (principal.userDetails || null) : null;
  const body = req.body || {};

  if (method === 'POST') {
    const newKey = String(body.templateKey || '').toLowerCase().trim();
    if (!KEY_RX.test(newKey)) return bad(400, 'Template key must be lowercase letters, digits and hyphens');
    if (!body.name) return bad(400, 'Name is required');
    if (!body.doc || typeof body.doc !== 'object') return bad(400, 'A complete template document is required');

    const exists = await pool.request().input('k', sql.VarChar(64), newKey)
      .query('SELECT 1 AS x FROM dbo.BudgetTemplates WHERE TemplateKey = @k');
    if (exists.recordset.length) return bad(409, 'That template key already exists');

    const tx = new sql.Transaction(pool); await tx.begin();
    try {
      await new sql.Request(tx)
        .input('k', sql.VarChar(64), newKey)
        .input('name', sql.NVarChar(200), String(body.name).slice(0, 200))
        .input('type', sql.NVarChar(50), String(body.budgetType || body.name).slice(0, 50))
        .input('desc', sql.NVarChar(1000), String(body.description || '').slice(0, 1000))
        .input('uid', sql.NVarChar(128), userId)
        .input('uname', sql.NVarChar(200), userName)
        .query(`INSERT INTO dbo.BudgetTemplates
                  (TemplateKey, Name, BudgetType, Description, IsActive, CreatedById, CreatedByName)
                VALUES (@k, @name, @type, @desc, 1, @uid, @uname)`);
      const version = await publish(tx, newKey, body, userId, userName, 'Initial version');
      await tx.commit();
      return ok({ ok: true, templateKey: newKey, versionNumber: version });
    } catch (e) { await tx.rollback(); throw e; }
  }

  if (!key) return bad(400, 'A template key is required');
  const found = await pool.request().input('k', sql.VarChar(64), key)
    .query('SELECT TemplateKey FROM dbo.BudgetTemplates WHERE TemplateKey = @k');
  if (!found.recordset.length) return bad(404, 'Template not found');

  if (method === 'PUT') {
    if (!body.doc || typeof body.doc !== 'object') return bad(400, 'A complete template document is required');
    const tx = new sql.Transaction(pool); await tx.begin();
    try {
      const version = await publish(tx, key, body, userId, userName, null);
      await tx.commit();
      return ok({ ok: true, templateKey: key, versionNumber: version });
    } catch (e) { await tx.rollback(); throw e; }
  }

  if (method === 'PATCH') {
    // Metadata and activation only. Publishing is the sole route to new content, so a
    // rename can never quietly alter what a budget is created from.
    const sets = [], rq = pool.request().input('k', sql.VarChar(64), key);
    if (body.name !== undefined) { sets.push('Name=@name'); rq.input('name', sql.NVarChar(200), String(body.name).slice(0, 200)); }
    if (body.budgetType !== undefined) { sets.push('BudgetType=@type'); rq.input('type', sql.NVarChar(50), String(body.budgetType).slice(0, 50)); }
    if (body.description !== undefined) { sets.push('Description=@desc'); rq.input('desc', sql.NVarChar(1000), String(body.description).slice(0, 1000)); }
    if (body.isActive !== undefined) { sets.push('IsActive=@act'); rq.input('act', sql.Bit, body.isActive ? 1 : 0); }
    if (!sets.length) return bad(400, 'Nothing to change');
    await rq.query(`UPDATE dbo.BudgetTemplates SET ${sets.join(', ')}, UpdatedAt=SYSUTCDATETIME() WHERE TemplateKey=@k`);
    return ok({ ok: true, templateKey: key });
  }

  return bad(405, 'Method not allowed');

  function meta(x) {
    return {
      templateKey: x.TemplateKey, name: x.Name, budgetType: x.BudgetType,
      description: x.Description, isActive: !!x.IsActive,
      currentVersion: x.CurrentVersion !== undefined ? x.CurrentVersion : x.VersionNumber,
      pricingVersion: x.PricingVersion,
      publishedAt: x.PublishedAt ? x.PublishedAt.toISOString() : null,
      updatedAt: x.UpdatedAt ? x.UpdatedAt.toISOString() : null
    };
  }
  function versionMeta(v) {
    return {
      versionNumber: v.VersionNumber, versionLabel: v.VersionLabel, isCurrent: !!v.IsCurrent,
      pricingVersion: v.PricingVersion, changeSummary: v.ChangeSummary,
      createdByName: v.CreatedByName, templateSchemaVersion: v.TemplateSchemaVersion,
      createdAt: v.CreatedAt ? v.CreatedAt.toISOString() : null,
      publishedAt: v.PublishedAt ? v.PublishedAt.toISOString() : null
    };
  }
};

// Publishing: allocate the next version under a lock, demote the previous current
// version and insert the new one as current — all inside the caller's transaction,
// so it either happens completely or not at all. The filtered unique index on
// (TemplateKey) WHERE IsCurrent = 1 is the database-level backstop against two
// concurrent publishes both claiming current.
async function publish(tx, key, body, userId, userName, defaultLabel) {
  const r = await new sql.Request(tx).input('k', sql.VarChar(64), key)
    .query(`SELECT ISNULL(MAX(VersionNumber), 0) AS MaxV
            FROM dbo.BudgetTemplateVersions WITH (UPDLOCK, HOLDLOCK) WHERE TemplateKey = @k`);
  const next = r.recordset[0].MaxV + 1;

  await new sql.Request(tx).input('k', sql.VarChar(64), key)
    .query('UPDATE dbo.BudgetTemplateVersions SET IsCurrent = 0 WHERE TemplateKey = @k AND IsCurrent = 1');

  const docJson = JSON.stringify(body.doc);
  await new sql.Request(tx)
    .input('k', sql.VarChar(64), key)
    .input('vn', sql.Int, next)
    .input('label', sql.NVarChar(100), (body.versionLabel || defaultLabel || ('Version ' + next)).slice(0, 100))
    .input('schema', sql.Int, +body.templateSchemaVersion || 1)
    .input('pv', sql.NVarChar(32), body.doc.pricingVersion || body.pricingVersion || null)
    .input('doc', sql.NVarChar(sql.MAX), docJson)
    .input('hash', sql.Char(64), contentHash(body.doc))
    .input('summary', sql.NVarChar(1000), body.changeSummary ? String(body.changeSummary).slice(0, 1000) : null)
    .input('uid', sql.NVarChar(128), userId)
    .input('uname', sql.NVarChar(200), userName)
    .query(`INSERT INTO dbo.BudgetTemplateVersions
              (TemplateKey, VersionNumber, VersionLabel, IsCurrent, TemplateSchemaVersion,
               PricingVersion, Doc, ContentHash, ChangeSummary, CreatedById, CreatedByName, PublishedAt)
            VALUES (@k, @vn, @label, 1, @schema, @pv, @doc, @hash, @summary, @uid, @uname, SYSUTCDATETIME())`);

  await new sql.Request(tx).input('k', sql.VarChar(64), key)
    .query('UPDATE dbo.BudgetTemplates SET UpdatedAt = SYSUTCDATETIME() WHERE TemplateKey = @k');
  return next;
}
