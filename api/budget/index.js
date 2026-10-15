const { getPool, sql } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const { contentHash, contentEquals, parseDoc } = require('../shared/canonical');
const { sovRows, writeSovLines, insertVersion } = require('../shared/versioning');
const { parts, grossIncome } = require('../shared/budget-calc');
const { features } = require('../shared/schema');
const FSGuardrails = require('../shared/guardrails');
const P = require('../shared/projects');
const { updateProject, createProject, deleteProject, linkBudgetToProject,
        PROJECT_ID_RX } = P;

// TST-#### are throwaway test budgets used to exercise preview environments against
// this same database. They are real rows; sql/cleanup_test_budgets.sql purges them and
// the lender package excludes them (see docs/DATA_CONTRACT.md).
const ID_RX = /^(OP|BD|BDG|AS|TST)-\d{4}(-\d{2})?$/;

const DUP_KEY = new Set([2627, 2601]);   // unique constraint / unique index violation

module.exports = async function (context, req) {
  const id = (context.bindingData.id || '').toUpperCase();
  const pool = await getPool();

  // ---- ?scope=project — the project surface, on an endpoint that already
  // deploys. A route rule matches paths, not query strings, so it cannot see
  // this scope: the signed-in check here is the real gate, not defence in
  // depth.
  //
  //   PUT    + {create:true}      create a project
  //   PUT                         metadata, status, Make Primary
  //   DELETE                      soft-delete, cascading to its children
  if (String((req.query && req.query.scope) || '') === 'project'
      && (req.method === 'PUT' || req.method === 'DELETE')) {
    const principal = getPrincipal(req);
    if (!principal && !process.env.FS_ALLOW_ANON) {
      context.res = { status: 401, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'unauthenticated', message: 'Sign in to change a project.' }) };
      return;
    }
    // The project id namespace, and the message the New Project form shows
    // against its own field.
    if (!PROJECT_ID_RX.test(id)) {
      context.res = { status: 400, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'bad_project_id', field: 'projectId',
                               message: 'Use the format OP-####.' }) };
      return;
    }
    if (req.method === 'DELETE') { context.res = await deleteProject(pool, id, principal); return; }
    if (req.body && req.body.create === true) {
      context.res = await createProject(pool, id, req.body, principal);
      return;
    }
    context.res = await updateProject(pool, id, req.body, principal);
    return;
  }

  // ---- GET /api/budget/{id}?scope=next-budget-id — the lowest free BD-####.
  // Lives here rather than on /api/budgets so the New Budget flow can ask for
  // one without pulling the whole index. The {id} segment is ignored; the
  // route needs a segment and the id namespace check below would reject a
  // placeholder, so this is answered before it.
  if (req.method === 'GET' && String((req.query && req.query.scope) || '') === 'next-budget-id') {
    const principal = getPrincipal(req);
    if (!principal && !process.env.FS_ALLOW_ANON) {
      context.res = { status: 401, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'unauthenticated', message: 'Sign in first.' }) };
      return;
    }
    // With a project, the suggestion is the identifier model's child id —
    // BDG-<number>-<next item> — so a budget carries its project's number by
    // construction. Without one (offline dialog, no project chosen yet), the
    // flat lowest-free BD-#### survives as the fallback.
    const forProject = String((req.query && req.query.project) || '').toUpperCase();
    const suggested = PROJECT_ID_RX.test(forProject)
      ? await P.nextChildBudgetId(pool, forProject)
      : await P.nextBudgetId(pool);
    context.res = { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ budgetId: suggested }) };
    return;
  }

  if (!ID_RX.test(id)) { context.res = { status: 400, body: 'Invalid project ID (OP-#### / BD-#### / AS-#### / TST-####)' }; return; }

  // ---- POST /api/budget/{id}?scope=ask — the Budget Assistant (Claude).
  // A scope on an endpoint that already deploys, for the same reason as the
  // project scopes above. Read-only: it never writes the budget. The signed-in
  // check and the ownership rule live in shared/budget-assistant.js and are
  // the real gate — a route rule cannot see the query string.
  if (req.method === 'POST') {
    if (String((req.query && req.query.scope) || '') !== 'ask') {
      context.res = { status: 405, body: 'POST is only accepted with ?scope=ask' }; return;
    }
    const principal = getPrincipal(req);
    const assistant = require('../shared/budget-assistant');
    const out = await assistant.ask({
      store: () => assistant.sqlStore(pool, principal), principal, id, body: req.body || {},
      log: m => context.log && context.log.warn && context.log.warn(m) });
    const activity = out.activity; delete out.activity;
    context.res = out;
    // Best-effort, like every activity row: who asked what, about which
    // budget, and what it cost in tokens — never the answer itself.
    if (activity) await require('../shared/users').recordActivity(pool, principal, 'ai_ask', 'budget', id, activity);
    return;
  }

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
      .query(`SELECT TOP 1 Name, ProjectKey, ContractSum, ProjectCost FROM dbo.Budgets WHERE ProjectId = @id;
              UPDATE dbo.Budgets SET IsDeleted = 1, DeletedAt = SYSUTCDATETIME()
              WHERE ProjectId = @id AND IsDeleted = 0;
              SELECT COUNT(*) AS Found FROM dbo.Budgets WHERE ProjectId = @id;`);
    const before = (r.recordsets[0] || [])[0] || null;
    if (!(r.recordsets[1] || [])[0] || !r.recordsets[1][0].Found) {
      context.res = { status: 404, body: 'Not found' }; return;
    }
    context.res = { status: 204 };
    // The log said nothing at all about a deletion until now, which made the
    // one action people most want to trace the one it could not.
    await require('../shared/users').recordActivity(pool, getPrincipal(req),
      'budget_delete', 'budget', id,
      before ? { name: before.Name || null, projectKey: before.ProjectKey || null,
                 contractSum: before.ContractSum === null ? null : Number(before.ContractSum),
                 projectCost: before.ProjectCost === null ? null : Number(before.ProjectCost) } : null);
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
      .query(`SELECT TOP 1 Status AS Was, Name, ProjectKey FROM dbo.Budgets
                WHERE ProjectId=@id AND IsDeleted=0;
              UPDATE dbo.Budgets SET Status=@st, Doc=JSON_MODIFY(Doc,'$.status',@st),
                UpdatedAt=SYSUTCDATETIME()
              WHERE ProjectId=@id AND IsDeleted=0;
              SELECT @@ROWCOUNT AS N;`);
    const was = (r.recordsets[0] || [])[0] || null;
    if (!(r.recordsets[1] || [])[0] || !r.recordsets[1][0].N) { context.res = { status: 404, body: 'Not found' }; return; }
    context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, status: req.body.status }) };
    // A status change is a decision, and it recorded nothing before this.
    if (was && was.Was !== req.body.status) {
      await require('../shared/users').recordActivity(pool, getPrincipal(req),
        'budget_status', 'budget', id,
        { name: was.Name || null, projectKey: was.ProjectKey || null,
          from: was.Was, to: req.body.status });
    }
    return;
  }

  // PUT — upsert the budget doc + meta, rewrite the normalized SOV rows
  // (SovLines is the read surface for the lender-package pipeline), and record an
  // immutable version when the content actually changed. All in one transaction.
  const { meta, doc } = req.body || {};
  if (!doc || !meta) { context.res = { status: 400, body: 'Body must be { meta, doc }' }; return; }
  if ((doc.projectId || '').toUpperCase() !== id) { context.res = { status: 400, body: 'Body projectId must match route' }; return; }

  // Building square footage is REQUIRED and must be greater than zero.
  //
  // This is the authoritative half of the check, and it exists because of what
  // happens downstream: an investment analysis imports the building size from
  // the budget, and a budget saved with no size produced an analysis that
  // could never calculate. Refusing the empty budget at the source is the fix;
  // the form refuses it first as a courtesy.
  //
  // resSF + amenSF is the BUILDING, which is exactly what the analysis
  // imports — site area is land and has never counted toward it.
  {
    const bldgSF = (Number(doc.resSF) || 0) + (Number(doc.amenSF) || 0);
    if (!(bldgSF > 0)) {
      context.res = { status: 422, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'size_required', field: 'resSF',
          message: 'Square footage is required — enter a building size greater than zero before saving.' }) };
      return;
    }
  }

  // Which project this budget belongs to. A budget id can no longer name a
  // project, so the link has to be stated: the client sends it, and it is
  // checked against a real project row. It is only REQUIRED on a create —
  // budgets saved before sql/migrate_project_op_ids.sql already carry their
  // ProjectKey and must keep saving without one being resent.
  const wantsCreate = req.body.create === true;
  const projectKey = meta.projectKey ? String(meta.projectKey).toUpperCase() : null;
  if (projectKey && !PROJECT_ID_RX.test(projectKey)) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'bad_project_id', field: 'projectKey',
        message: 'A budget belongs to a project whose ID looks like OP-####.' }) };
    return;
  }
  if (wantsCreate && !projectKey) {
    context.res = { status: 400, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'project_required', field: 'projectKey',
        message: 'Choose the project this budget belongs to.' }) };
    return;
  }

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
  //
  // On a CREATE the save refuses to land on an id that is already taken.
  // Without this a brand-new budget typed against an existing id silently
  // replaced that budget and versioned the replacement as its next revision —
  // the original survived only in history. The check happens inside the save
  // transaction, under the lock that already serialises first-saves, so two
  // concurrent creates cannot both win.
  let result;
  for (let attempt = 0; ; attempt++) {
    try { result = await save(); break; }
    catch (e) {
      if (e && e.fsBudgetIdTaken) {
        context.res = { status: 409, headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'budget_id_taken', field: 'projectId',
            message: 'Budget ' + id + ' already exists. Choose another Budget ID.',
            suggestion: projectKey ? await P.nextChildBudgetId(pool, projectKey)
                                   : await P.nextBudgetId(pool) }) };
        return;
      }
      if (attempt === 0 && DUP_KEY.has(e.number)) continue;
      throw e;
    }
  }
  // Stamp which project this budget belongs to. Only when the client said —
  // a save that does not mention a project leaves the existing link alone,
  // which is what every edit of an existing budget does.
  if (projectKey && schemaFeatures.projectsTable && schemaFeatures.budgetsProjectKey) {
    try {
      await linkBudgetToProject(pool, id, projectKey);
    } catch (e) { context.log && context.log.warn && context.log.warn('project link skipped: ' + e.message); }
  }

  context.res = { status: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ projectKey: projectKey || null }, result)) };
  // Best-effort audit trail — recordActivity never throws.
  //
  // Detail enough to answer "what changed, on what, by whom" from the log
  // alone: which project the budget belongs to, what it is called, the money
  // as saved, and whether this was the budget coming into existence.
  if (result.versionCreated) {
    await require('../shared/users').recordActivity(pool, principal,
      wantsCreate ? 'budget_create' : 'budget_save', 'budget', id, {
        name: meta.name || null,
        projectKey: projectKey || null,
        status: meta.status || null,
        versionNumber: result.versionNumber,
        contractSum: result.contractSum,
        projectCost: result.projectCost,
        pricingVersion: doc.pricingVersion || null,
        changed: result.changedFields || null
      });
  }

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

      // A create must not land on an occupied id. A soft-deleted row is still
      // occupied: restoring it is what an ordinary save does, and doing it
      // silently under a "new budget" would be just as surprising.
      if (wantsCreate && existing) {
        await tx.rollback();
        const err = new Error('Budget ' + id + ' already exists');
        err.fsBudgetIdTaken = true;
        throw err;
      }

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

      // WHICH fields moved, for the activity log. A summary, deliberately:
      // the version snapshot is the full record, and an audit row that tries
      // to be one is unreadable. Compared against what was actually stored,
      // so it reports the change rather than the submission.
      const prev = existing ? parseDoc(existing.Doc) : null;
      const changed = [];
      if (existing) {
        const num = v => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
        const cmp = (key, was, now) => { if (was !== now) changed.push({ key, from: was, to: now }); };
        cmp('name', existing.Name || null, meta.name || null);
        cmp('status', existing.Status || null, meta.status || null);
        cmp('type', existing.Type || null, meta.type || null);
        cmp('contractSum', num(existing.ContractSum), num(contractSum));
        cmp('projectCost', num(existing.ProjectCost), num(projectCost));
        cmp('pricingVersion', existing.PricingVersion || null, doc.pricingVersion || null);
        if (prev) {
          cmp('residentialSF', Number(prev.resSF) || 0, Number(doc.resSF) || 0);
          cmp('amenitySF', Number(prev.amenSF) || 0, Number(doc.amenSF) || 0);
          cmp('siteSF', Number(prev.siteSF) || 0, Number(doc.siteSF) || 0);
          const units = d => (d.units || []).reduce((a, u) => a + (Number(u.count) || 0), 0);
          cmp('unitCount', units(prev), units(doc));
          cmp('lineItems', (prev.lines || []).length, (doc.lines || []).length);
        }
      }

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
      return { ok: true, versionNumber, versionCreated,
               contractSum, projectCost, changedFields: changed };
    } catch (e) {
      // The id-taken path rolls back before throwing, so a second rollback
      // here would fail on a transaction that is already gone.
      if (!e || !e.fsBudgetIdTaken) { try { await tx.rollback(); } catch (_) { /* already rolled back */ } }
      throw e;
    }
  }
};
