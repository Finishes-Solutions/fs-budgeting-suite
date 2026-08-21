const { getPool, sql } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const { contentHash, contentEquals, parseDoc } = require('../shared/canonical');
const { sovRows, writeSovLines, insertVersion } = require('../shared/versioning');
const { parts, grossIncome } = require('../shared/budget-calc');
const { features } = require('../shared/schema');
const FSGuardrails = require('../shared/guardrails');
const { updateProject, ensureProject, projectKeyOf, PROJECT_ID_RX } = require('../shared/projects');

// TST-#### are throwaway test budgets used to exercise preview environments against
// this same database. They are real rows; sql/cleanup_test_budgets.sql purges them and
// the lender package excludes them (see docs/DATA_CONTRACT.md).
const ID_RX = /^(OP|BD|AS|TST)-\d{4}(-\d{2})?$/;

const DUP_KEY = new Set([2627, 2601]);   // unique constraint / unique index violation

module.exports = async function (context, req) {
  const id = (context.bindingData.id || '').toUpperCase();
  const pool = await getPool();

  // ---- PUT /api/budget/{id}?scope=project — project metadata and status.
  // A route rule matches paths, not query strings, so it cannot see this
  // scope: the signed-in check here is the real gate, not defence in depth.
  if (req.method === 'PUT' && String((req.query && req.query.scope) || '') === 'project') {
    const principal = getPrincipal(req);
    if (!principal && !process.env.FS_ALLOW_ANON) {
      context.res = { status: 401, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'unauthenticated', message: 'Sign in to change a project.' }) };
      return;
    }
    if (!PROJECT_ID_RX.test(id)) {
      context.res = { status: 400, body: 'Invalid project ID (OP-#### / BD-#### / AS-#### / TST-####)' }; return;
    }
    context.res = await updateProject(pool, id, req.body, principal);
    return;
  }

  if (!ID_RX.test(id)) { context.res = { status: 400, body: 'Invalid project ID (OP-#### / BD-#### / AS-#### / TST-####)' }; return; }

  if (req.method === 'GET') {
    // Soft-deleted budgets are invisible to the app; the row and its history stay.
    const r = await pool.request().input('id', sql.VarChar(16), id)
      .query('SELECT Doc FROM dbo.Budgets WHERE ProjectId = @id AND IsDeleted = 0');
    if (!r.recordset.length) { context.res = { status: 404, body: 'Not found' }; return; }
    context.res = { headers: { 'Content-Type': 'application/json' }, body: r.recordset[0].Doc };
    return;
  }

  if (req.method === 'DELETE') {
    // Recoverable deletion: flag the budget and leave SovLines, BudgetVersions and
    // BudgetVersionSovLines untouched, so history survives and a later PUT on the
    // same ProjectId restores it. Hard removal is sql/purge_deleted_budgets.sql,
    // run by an admin — the app never destroys a budget.
    const r = await pool.request().input('id', sql.VarChar(16), id)
      .query(`UPDATE dbo.Budgets SET IsDeleted = 1, DeletedAt = SYSUTCDATETIME()
              WHERE ProjectId = @id AND IsDeleted = 0;
              SELECT COUNT(*) AS Found FROM dbo.Budgets WHERE ProjectId = @id;`);
    if (!r.recordset[0].Found) { context.res = { status: 404, body: 'Not found' }; return; }
    context.res = { status: 204 };
    return;
  }

  // PUT with { status } only — the quick status change from the lists and
  // cards. Updates the row and the stored document in place WITHOUT recording
  // a version; the editor's full { meta, doc } save still versions as before.
  const STATUSES = ['Draft', 'In Review', 'Completed', 'Cancelled'];
  if (req.body && !req.body.doc && typeof req.body.status === 'string') {
    if (!STATUSES.includes(req.body.status)) {
      context.res = { status: 400, body: 'status must be one of: ' + STATUSES.join(', ') }; return;
    }
    const r = await pool.request().input('id', sql.VarChar(16), id)
      .input('st', sql.NVarChar(30), req.body.status)
      .query(`UPDATE dbo.Budgets SET Status=@st, Doc=JSON_MODIFY(Doc,'$.status',@st),
                UpdatedAt=SYSUTCDATETIME()
              WHERE ProjectId=@id AND IsDeleted=0;
              SELECT @@ROWCOUNT AS N;`);
    if (!r.recordset[0].N) { context.res = { status: 404, body: 'Not found' }; return; }
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, status: req.body.status }) };
    return;
  }

  // PUT — upsert the budget doc + meta, rewrite the normalized SOV rows
  // (SovLines is the read surface for the lender-package pipeline), and record an
  // immutable version when the content actually changed. All in one transaction.
  const { meta, doc } = req.body || {};
  if (!doc || !meta) { context.res = { status: 400, body: 'Body must be { meta, doc }' }; return; }
  if ((doc.projectId || '').toUpperCase() !== id) { context.res = { status: 400, body: 'Body projectId must match route' }; return; }

  // Guard rails, re-evaluated from the SUBMITTED DOCUMENT — never from a
  // client-supplied verdict. The browser refuses the save first as a courtesy;
  // this is the gate. A rail whose denominator is zero is not evaluated, so a
  // half-built budget is never blocked, and an acknowledgement recorded on the
  // document downgrades a blocking rail to a warning.
  {
    const gp = parts(doc);
    const gr = FSGuardrails.evaluate({ doc, parts: gp, gross: grossIncome(doc), fee: gp.fee });
    if (gr.blocking) {
      context.res = { status: 422, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'guardrail_breach',
          message: gr.blocking + ' guard rail' + (gr.blocking === 1 ? '' : 's')
            + ' outside range. Correct the value, or record an override with a reason.',
          breaches: gr.breaches.filter(b => b.severity === 'error')
            .map(b => ({ id: b.id, label: b.label, actual: b.actual, display: b.display,
                         min: b.min, max: b.max, range: b.range, message: b.message })) }) };
      return;
    }
  }

  const principal = getPrincipal(req);
  // Only the two identity fields are stored — never roles, tokens or headers.
  // Both are nullable so local development without a principal still saves.
  const userId = principal ? (principal.userId || null) : null;
  const userName = principal ? (principal.userDetails || null) : null;

  // Ownership columns arrive with sql/migrate_roles_and_ownership.sql; naming
  // them before it runs would fail every save (see shared/schema.js).
  const schemaFeatures = await features(pool);
  const ownerInsertCols = schemaFeatures.budgetsCreatedBy ? ', CreatedById, CreatedByName' : '';
  const ownerInsertVals = schemaFeatures.budgetsCreatedBy ? ', @cuid, @cuname' : '';
  // Guard-rail columns arrive with sql/migrate_projects_and_guardrails.sql.
  // Until it runs, the rails still evaluate and still block — only the stored
  // summary of them is skipped, so the list simply shows no rail indicator.
  const grSet = schemaFeatures.budgetsGuardrail ? ', GuardrailStatus=@grst, GuardrailBreachCount=@grn' : '';
  const grInsertCols = schemaFeatures.budgetsGuardrail ? ', GuardrailStatus, GuardrailBreachCount' : '';
  const grInsertVals = schemaFeatures.budgetsGuardrail ? ', @grst, @grn' : '';

  // Version numbers are serialized by the locks below and enforced by
  // UQ_BudgetVersions_Version. A duplicate can still surface if two saves race
  // in the window before the lock is taken, so retry once rather than 500.
  let result;
  for (let attempt = 0; ; attempt++) {
    try { result = await save(); break; }
    catch (e) {
      if (attempt === 0 && DUP_KEY.has(e.number)) continue;
      throw e;
    }
  }
  // A budget always belongs to a project. Creating the parent (and stamping the
  // link) is best effort and outside the save transaction on purpose: a project
  // row that cannot be written must never cost someone their budget.
  if (schemaFeatures.projectsTable && schemaFeatures.budgetsProjectKey) {
    try {
      await ensureProject(pool, id, { name: meta.name || doc.name, address: doc.address,
                                      type: meta.type || doc.type, userId, userName });
      await pool.request()
        .input('id', sql.VarChar(16), id)
        .input('pk', sql.VarChar(16), projectKeyOf(id))
        .query('UPDATE dbo.Budgets SET ProjectKey = @pk WHERE ProjectId = @id AND ProjectKey IS NULL');
    } catch (e) { context.log && context.log.warn && context.log.warn('project link skipped: ' + e.message); }
  }

  context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  // Best-effort audit trail — recordActivity never throws.
  if (result.versionCreated)
    await require('../shared/users').recordActivity(pool, principal, 'budget_save', 'budget', id,
      { versionNumber: result.versionNumber });

  async function save() {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      // UPDLOCK+HOLDLOCK serializes concurrent saves of the same budget, and holds
      // the key range so two first-saves of a new ProjectId cannot both proceed.
      const cur = await new sql.Request(tx).input('id', sql.VarChar(16), id)
        .query(`SELECT Name, Type, Status, ContractSum, ProjectCost, PricingVersion,
                       TemplateKey, TemplateVersionId, Doc, IsDeleted
                FROM dbo.Budgets WITH (UPDLOCK, HOLDLOCK) WHERE ProjectId = @id`);
      const existing = cur.recordset[0] || null;

      const top = await new sql.Request(tx).input('id', sql.VarChar(16), id)
        .query(`SELECT TOP 1 VersionNumber, ContentHash, Doc
                FROM dbo.BudgetVersions WITH (UPDLOCK, HOLDLOCK)
                WHERE ProjectId = @id ORDER BY VersionNumber DESC`);
      let maxVersion = top.recordset.length ? top.recordset[0].VersionNumber : 0;
      let latest = top.recordset[0] || null;

      // Historical baseline protection: a budget that predates versioning must not
      // have the incoming replacement labelled as its history. Snapshot what the
      // database holds right now — the old Doc and its existing SovLines — before
      // applying the update, in this same transaction.
      if (existing && maxVersion === 0) {
        const prevDoc = parseDoc(existing.Doc);
        await insertVersion(tx, {
          projectId: id, versionNumber: 1,
          name: existing.Name, type: existing.Type, status: existing.Status,
          contractSum: existing.ContractSum, projectCost: existing.ProjectCost,
          pricingVersion: existing.PricingVersion,
          templateKey: existing.TemplateKey, templateVersionId: existing.TemplateVersionId,
          docJson: existing.Doc,
          contentHash: prevDoc ? contentHash(prevDoc) : contentHash(existing.Doc),
          changeSummary: 'Initial version — state before this save',
          userId: null, userName: 'System (baseline)'
        });
        maxVersion = 1;
        latest = { VersionNumber: 1, ContentHash: prevDoc ? contentHash(prevDoc) : null, Doc: existing.Doc };
      }

      const templateKey = doc.templateKey || (existing && existing.TemplateKey) || null;
      const templateVersionId = doc.templateVersionId || (existing && existing.TemplateVersionId) || null;
      const docJson = JSON.stringify(doc);

      // Summary money is derived from the document, never trusted from meta:
      // a tampered meta.contractSum/projectCost must not change stored totals,
      // and the investment-analysis prefill reads these values back. The meta
      // fields stay in the request shape for client compatibility; they are
      // simply no longer believed.
      const calc = parts(doc);
      const contractSum = Math.round(calc.contract * 100) / 100;
      const projectCost = Math.round(calc.project * 100) / 100;
      const rails = FSGuardrails.evaluate({ doc, parts: calc, gross: grossIncome(doc), fee: calc.fee });

      // Saving a soft-deleted ProjectId restores it: recreate means recover.
      await new sql.Request(tx)
        .input('id', sql.VarChar(16), id)
        .input('name', sql.NVarChar(200), meta.name || '')
        .input('type', sql.NVarChar(50), meta.type || 'Multifamily')
        .input('status', sql.NVarChar(30), meta.status || 'Draft')
        .input('cs', sql.Decimal(18, 2), contractSum)
        .input('pc', sql.Decimal(18, 2), projectCost)
        .input('pv', sql.NVarChar(32), doc.pricingVersion || '')
        .input('tk', sql.VarChar(64), templateKey)
        .input('tv', sql.BigInt, templateVersionId)
        .input('doc', sql.NVarChar(sql.MAX), docJson)
        .input('cuid', sql.NVarChar(128), userId)
        .input('cuname', sql.NVarChar(200), userName)
        .input('grst', sql.VarChar(10), rails.status)
        .input('grn', sql.Int, rails.breaches.length)
        .query(`MERGE dbo.Budgets AS t
                USING (SELECT @id AS ProjectId) AS s ON t.ProjectId = s.ProjectId
                WHEN MATCHED THEN UPDATE SET Name=@name, Type=@type, Status=@status,
                  ContractSum=@cs, ProjectCost=@pc, PricingVersion=@pv, Doc=@doc,
                  TemplateKey=@tk, TemplateVersionId=@tv,
                  IsDeleted=0, DeletedAt=NULL, UpdatedAt=SYSUTCDATETIME()${grSet}
                WHEN NOT MATCHED THEN INSERT (ProjectId, Name, Type, Status, ContractSum,
                  ProjectCost, PricingVersion, Doc, TemplateKey, TemplateVersionId
                  ${ownerInsertCols}${grInsertCols})
                  VALUES (@id, @name, @type, @status, @cs, @pc, @pv, @doc, @tk, @tv
                  ${ownerInsertVals}${grInsertVals});`);

      await writeSovLines(tx, id, sovRows(doc));

      // A save that changed nothing meaningful creates no version. The hash
      // comparison is the fast path; the content comparison is the fallback for
      // migration baselines, whose ContentHash was computed by the database over
      // the raw stored text rather than canonicalized JSON.
      const incomingHash = contentHash(doc);
      const unchanged = !!latest && (
        latest.ContentHash === incomingHash ||
        contentEquals(parseDoc(latest.Doc), doc));

      let versionNumber = maxVersion, versionCreated = false;
      if (!unchanged) {
        versionNumber = maxVersion + 1;
        await insertVersion(tx, {
          projectId: id, versionNumber,
          name: meta.name, type: meta.type, status: meta.status,
          contractSum, projectCost,
          pricingVersion: doc.pricingVersion,
          templateKey, templateVersionId,
          docJson, contentHash: incomingHash,
          changeSummary: typeof meta.changeSummary === 'string' ? meta.changeSummary.slice(0, 1000) : null,
          userId, userName
        });
        versionCreated = true;
      }

      await tx.commit();
      return { ok: true, versionNumber, versionCreated };
    } catch (e) { await tx.rollback(); throw e; }
  }
};
