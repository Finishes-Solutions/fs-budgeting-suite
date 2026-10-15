const { getPool, sql } = require('../shared/db');
const { hasRole, getPrincipal } = require('../shared/auth');
const { features } = require('../shared/schema');
const { scheduleIdentifierProblem, IDENTIFIER_RULE } = require('../shared/identifiers');

// A URL-safe schedule key, matching CK_FeeSchedules_KeyFormat in the database.
const KEY_RX = /^[a-z0-9-]{2,64}$/;

const json = (context, status, body) => {
  context.res = { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body) };
};

/* ---------------------------------------------------------------------------
   Fee schedules — the jurisdiction impact/tap fee library.

   These live here rather than in an api/fee-schedules/ folder on purpose. A NEW
   function folder is not reliably picked up by the deployed host (api/admin-roles/
   answered 404 on staging across two deploys), so the project surface and role
   management are both query scopes on endpoints that already deploy. This is the
   same trade, and it lands better than most: /api/pricing already restricts PUT
   to pricing_admin in BOTH staticwebapp.config.json and this file, so the
   publish path keeps its two gates. A route rule matches paths, not query
   strings — for anything gated only by scope, the in-function check IS the gate.

   Everything is optional until sql/migrate_impact_fees.sql runs. A deploy lands
   before its migration, and SQL naming a table that is not there yet fails the
   whole request — which is how a pending migration turns into a red banner
   instead of a feature that is merely not on yet. So the reads answer with an
   empty list, and the publish answers 503 with something a person can act on.
   --------------------------------------------------------------------------- */

async function listFeeSchedules(context, req, pool) {
  // hasRole already subsumes super_admin into pricing_admin — see api/shared/auth.js.
  const isAdmin = hasRole(req, 'pricing_admin');
  if (!(await features(pool)).feeSchedulesTable) {
    json(context, 200, { isAdmin, schedules: [], migrationPending: true });
    return;
  }
  // Non-admins see active schedules only; admins also see deactivated ones so
  // they can be revived, exactly as templates behave.
  const r = await pool.request().query(
    `SELECT s.ScheduleKey, s.Name, s.Jurisdiction, s.StateCode, s.Description, s.IsActive,
            v.VersionNumber AS CurrentVersion, v.EffectiveDate
     FROM dbo.FeeSchedules AS s
     LEFT JOIN dbo.FeeScheduleVersions AS v
       ON v.ScheduleKey = s.ScheduleKey AND v.IsCurrent = 1
     ${isAdmin ? '' : 'WHERE s.IsActive = 1'}
     ORDER BY s.Name`);
  json(context, 200, { isAdmin, schedules: r.recordset.map(x => ({
    scheduleKey: x.ScheduleKey, name: x.Name, jurisdiction: x.Jurisdiction,
    state: x.StateCode, description: x.Description, isActive: !!x.IsActive,
    currentVersion: x.CurrentVersion || null,
    effective: x.EffectiveDate ? new Date(x.EffectiveDate).toISOString().slice(0, 10) : null
  })) });
}

async function readFeeSchedule(context, req, pool) {
  const key = String(req.query.key || '').toLowerCase();
  if (!KEY_RX.test(key)) { json(context, 400, { error: 'Malformed schedule key' }); return; }
  if (!(await features(pool)).feeSchedulesTable) {
    json(context, 404, { error: 'No fee schedules published yet', migrationPending: true });
    return;
  }
  // A deactivated schedule still resolves: a budget priced from one must keep
  // opening, or deactivating a jurisdiction would break saved work.
  const wanted = req.query.version ? parseInt(req.query.version, 10) : null;
  if (req.query.version && !(wanted >= 1)) {
    json(context, 400, { error: 'Malformed version number' }); return;
  }
  const rq = pool.request().input('k', sql.VarChar(64), key);
  if (wanted) rq.input('n', sql.Int, wanted);
  const r = await rq.query(
    `SELECT TOP 1 s.ScheduleKey, s.Name, s.Jurisdiction, s.StateCode, s.IsActive,
            v.VersionNumber, v.VersionLabel, v.EffectiveDate, v.Doc, v.ChangeSummary, v.CreatedAt,
            (SELECT MAX(VersionNumber) FROM dbo.FeeScheduleVersions
             WHERE ScheduleKey = s.ScheduleKey AND IsCurrent = 1) AS CurrentVersion
     FROM dbo.FeeSchedules AS s
     JOIN dbo.FeeScheduleVersions AS v ON v.ScheduleKey = s.ScheduleKey
     WHERE s.ScheduleKey = @k AND ${wanted ? 'v.VersionNumber = @n' : 'v.IsCurrent = 1'}`);
  if (!r.recordset.length) { json(context, 404, { error: 'Fee schedule not found' }); return; }
  const x = r.recordset[0];
  json(context, 200, {
    scheduleKey: x.ScheduleKey, name: x.Name, jurisdiction: x.Jurisdiction,
    state: x.StateCode, isActive: !!x.IsActive,
    versionNumber: x.VersionNumber, versionLabel: x.VersionLabel,
    currentVersion: x.CurrentVersion || null,
    effective: x.EffectiveDate ? new Date(x.EffectiveDate).toISOString().slice(0, 10) : null,
    changeSummary: x.ChangeSummary, createdAt: x.CreatedAt,
    doc: JSON.parse(x.Doc)
  });
}

const FEE_BASES = ['flat', 'unit', 'acre', 'resSF', 'amenSF', 'bldgSF', 'pctHard'];

// Shape validation. A malformed schedule reaching a budget prices real money
// wrong, so this refuses rather than coercing.
function validateScheduleDoc(doc) {
  if (!doc || typeof doc !== 'object') return 'Body must be a fee schedule document';
  if (!KEY_RX.test(String(doc.scheduleKey || '').toLowerCase())) return 'scheduleKey must be lowercase letters, digits and hyphens';
  if (!doc.name) return 'name is required';
  if (!Array.isArray(doc.meters)) return 'meters[] is required (it may be empty)';
  if (doc.fees && !Array.isArray(doc.fees)) return 'fees must be an array';
  const ids = new Set();
  for (const m of doc.meters) {
    if (!m || !m.rowId) return 'every meter needs a rowId';
    if (ids.has(m.rowId)) return 'duplicate meter rowId: ' + m.rowId;
    ids.add(m.rowId);
    if (!(Number(m.edu) >= 0)) return 'meter ' + m.rowId + ' needs a numeric edu';
    for (const k of ['meter', 'vault', 'waterTap', 'sewerTap']) {
      const r = m[k];
      if (r === null || r === undefined) continue;   // absent is "NA", and legitimate
      if (typeof r !== 'object' || !(Number(r.low) >= 0) || !(Number(r.high) >= 0))
        return 'meter ' + m.rowId + ' has a malformed ' + k + ' range';
    }
  }
  for (const f of (doc.fees || [])) {
    if (!f || !f.feeId || !f.label) return 'every fee needs a feeId and a label';
    if (!FEE_BASES.includes(f.basis)) return 'fee ' + f.feeId + ' has an unknown basis: ' + f.basis;
  }
  // Budgets copy these ids and the Impact Fees step renders them into
  // attributes, so a schedule must not be able to publish markup as a key.
  const badId = scheduleIdentifierProblem(doc);
  if (badId) return 'malformed identifier at ' + badId + ' — use ' + IDENTIFIER_RULE;
  return null;
}

async function publishFeeSchedule(context, req, pool) {
  if (!hasRole(req, 'pricing_admin')) {
    json(context, 403, { error: 'pricing_admin role required' }); return;
  }
  if (!(await features(pool)).feeSchedulesTable) {
    json(context, 503, { error: 'Fee schedules are not migrated yet — run sql/migrate_impact_fees.sql' });
    return;
  }
  const body = req.body || {};
  const doc = body.doc || body;
  const problem = validateScheduleDoc(doc);
  if (problem) { json(context, 400, { error: problem }); return; }

  const key = String(doc.scheduleKey).toLowerCase();
  const who = getPrincipal(req) || {};
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    // Upsert the identity row, then allocate the next version number under
    // UPDLOCK/HOLDLOCK so two concurrent publishes cannot claim the same one.
    await new sql.Request(tx)
      .input('k', sql.VarChar(64), key)
      .input('n', sql.NVarChar(200), String(doc.name))
      .input('j', sql.NVarChar(200), String(doc.jurisdiction || doc.name))
      .input('s', sql.Char(2), doc.state ? String(doc.state).toUpperCase().slice(0, 2) : null)
      .input('id', sql.NVarChar(128), who.userId || null)
      .input('by', sql.NVarChar(200), who.userDetails || null)
      .query(
        `IF EXISTS (SELECT 1 FROM dbo.FeeSchedules WITH (UPDLOCK, HOLDLOCK) WHERE ScheduleKey = @k)
           UPDATE dbo.FeeSchedules
              SET Name = @n, Jurisdiction = @j, StateCode = @s, UpdatedAt = SYSUTCDATETIME()
            WHERE ScheduleKey = @k;
         ELSE
           INSERT INTO dbo.FeeSchedules (ScheduleKey, Name, Jurisdiction, StateCode, CreatedById, CreatedByName)
           VALUES (@k, @n, @j, @s, @id, @by);`);

    const nx = await new sql.Request(tx)
      .input('k', sql.VarChar(64), key)
      .query(`SELECT ISNULL(MAX(VersionNumber), 0) + 1 AS N
              FROM dbo.FeeScheduleVersions WITH (UPDLOCK, HOLDLOCK) WHERE ScheduleKey = @k`);
    const next = nx.recordset[0].N;

    // The demote must land before the insert: IsCurrent is enforced by a
    // filtered unique index, so two current rows never exist even momentarily.
    await new sql.Request(tx).input('k', sql.VarChar(64), key)
      .query('UPDATE dbo.FeeScheduleVersions SET IsCurrent = 0 WHERE ScheduleKey = @k AND IsCurrent = 1');

    await new sql.Request(tx)
      .input('k', sql.VarChar(64), key)
      .input('v', sql.Int, next)
      .input('l', sql.NVarChar(200), body.versionLabel || null)
      .input('e', sql.Date, doc.effective || null)
      .input('d', sql.NVarChar(sql.MAX), JSON.stringify(doc))
      .input('c', sql.NVarChar(1000), body.changeSummary || null)
      .input('id', sql.NVarChar(128), who.userId || null)
      .input('by', sql.NVarChar(200), who.userDetails || null)
      .query(
        `INSERT INTO dbo.FeeScheduleVersions
           (ScheduleKey, VersionNumber, VersionLabel, IsCurrent, EffectiveDate, Doc,
            ChangeSummary, CreatedById, CreatedByName)
         VALUES (@k, @v, @l, 1, @e, @d, @c, @id, @by)`);
    await tx.commit();
    json(context, 200, { ok: true, scheduleKey: key, versionNumber: next });
  } catch (e) { await tx.rollback(); throw e; }
}

module.exports = async function (context, req) {
  const pool = await getPool();
  const scope = String((req.query && req.query.scope) || '');

  if (scope === 'fee-schedules') { await listFeeSchedules(context, req, pool); return; }
  if (scope === 'fee-schedule') {
    if (req.method === 'GET') { await readFeeSchedule(context, req, pool); return; }
    await publishFeeSchedule(context, req, pool);
    return;
  }

  if (req.method === 'GET') {
    const r = await pool.request().query(
      'SELECT TOP 1 Doc FROM dbo.PricingLibrary WHERE IsCurrent = 1 ORDER BY Effective DESC');
    if (!r.recordset.length) { context.res = { status: 404, body: 'No pricing library published' }; return; }
    // no-store, and it is not belt and braces: a budget created moments after
    // a publish must be born on the version that was just published. A cached
    // response here is the difference between a new budget being current and
    // it opening with an "update to current pricing" banner it has no business
    // showing.
    context.res = { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: r.recordset[0].Doc };
    return;
  }

  // PUT — publish a new version. Defense in depth: SWA route rules already
  // restrict this to pricing_admin, and we verify the role again here.
  if (!hasRole(req, 'pricing_admin')) { context.res = { status: 403, body: 'pricing_admin role required' }; return; }

  const doc = req.body;
  if (!doc || !doc.version || !Array.isArray(doc.lines)) {
    context.res = { status: 400, body: 'Body must be a pricing document with version and lines[]' }; return;
  }
  delete doc.adminPass; // never persist the local-dev passcode
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).query('UPDATE dbo.PricingLibrary SET IsCurrent = 0 WHERE IsCurrent = 1');
    await new sql.Request(tx)
      .input('v', sql.NVarChar(32), doc.version)
      .input('e', sql.Date, doc.effective || new Date())
      .input('d', sql.NVarChar(sql.MAX), JSON.stringify(doc))
      .query('INSERT INTO dbo.PricingLibrary (Version, Effective, IsCurrent, Doc) VALUES (@v, @e, 1, @d)');
    await tx.commit();
  } catch (e) { await tx.rollback(); throw e; }
  context.res = { status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, version: doc.version }) };
};
// Exposed for test/identifiers.test.js; the Functions host only calls the default export.
module.exports.validateScheduleDoc = validateScheduleDoc;
