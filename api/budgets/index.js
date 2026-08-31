const { getPool, sql } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const { ensureUser } = require('../shared/users');
const { features } = require('../shared/schema');
const { listProjects, getProject, nextProjectId, jsonRes } = require('../shared/projects');
const { listEntities } = require('../shared/entities');

const FULL_VISIBILITY_ROLES = new Set(['director', 'super_admin']);

module.exports = async function (context, req) {
  const pool = await getPool();
  const principal = getPrincipal(req);
  const userId = principal ? (principal.userId || null) : null;

  // Ownership columns and AppRole arrive with
  // sql/migrate_roles_and_ownership.sql. Until it runs the list behaves as it
  // always did — everyone sees every budget — instead of failing outright.
  const f = await features(pool);

  let appRole = 'user';
  if (userId) {
    try {
      const row = await ensureUser(pool, principal, {});
      if (row) appRole = row.AppRole || 'user';
    } catch (e) { /* default to user */ }
  }

  const swaSuper = principal && Array.isArray(principal.userRoles) && principal.userRoles.includes('super_admin');
  // Without the AppRole column every account reads as the default 'user', so
  // filtering then would hide budgets that used to be visible. Leave it off.
  const canSeeAll = !f.usersAppRole || swaSuper || FULL_VISIBILITY_ROLES.has(appRole);

  // ---- project scopes.
  // A staticwebapp.config.json route rule matches paths, not query strings, so
  // it cannot see ?scope=. Everything below is gated by the same signed-in
  // principal and the same ownership rule as the budget list itself — that
  // in-function check is the real gate here, not defence in depth.
  const scope = String((req.query && req.query.scope) || '');
  // Entity Master read. Every signed-in user needs it (project-entity picker,
  // exec summary, contracts display). Admins can ask for inactive rows too.
  if (scope === 'entities') {
    if (!principal && !process.env.FS_ALLOW_ANON) {
      context.res = jsonRes(401, { error: 'unauthenticated', message: 'Sign in to view entities.' });
      return;
    }
    const includeInactive = String((req.query && req.query.all) || '') === '1' && canSeeAll;
    context.res = jsonRes(200, await listEntities(pool, { includeInactive }));
    return;
  }
  if (scope === 'projects' || scope === 'project' || scope === 'next-project-id') {
    if (!principal && !process.env.FS_ALLOW_ANON) {
      context.res = jsonRes(401, { error: 'unauthenticated', message: 'Sign in to view projects.' });
      return;
    }
    // What the New Project dialog offers as a starting point. Only a
    // suggestion: the field stays editable and the server still enforces both
    // the OP-### shape and uniqueness on the create itself.
    if (scope === 'next-project-id') {
      context.res = jsonRes(200, { projectId: await nextProjectId(pool) });
      return;
    }
    if (scope === 'projects') {
      context.res = jsonRes(200, await listProjects(pool,
        { ownerId: (f.budgetsCreatedBy && !canSeeAll && userId) ? userId : null }));
      return;
    }
    const one = await getProject(pool, (req.query.id || '').toUpperCase());
    if (one.available && !one.project) {
      context.res = jsonRes(404, { error: 'not_found', message: 'Project not found.' });
      return;
    }
    context.res = jsonRes(200, one);
    return;
  }

  const rq = pool.request();
  let where = 'b.IsDeleted = 0';
  // Filter by owner only when the column exists to filter on. NULL is allowed
  // through so budgets saved before ownership tracking stay visible to all.
  if (f.budgetsCreatedBy && !canSeeAll && userId) {
    rq.input('uid', sql.NVarChar(128), userId);
    where += ' AND (b.CreatedById = @uid OR b.CreatedById IS NULL)';
  }

  const ownerCols = f.budgetsCreatedBy
    ? 'b.CreatedById, b.CreatedByName,'
    : 'CAST(NULL AS NVARCHAR(128)) AS CreatedById, CAST(NULL AS NVARCHAR(200)) AS CreatedByName,';
  // The creator's avatar colour lives in their settings JSON; the join is only
  // meaningful once there is a CreatedById to join on.
  const avatarCol = (f.budgetsCreatedBy && f.usersSettingsDoc)
    ? "JSON_VALUE(u.SettingsDoc, '$.avatarColor') AS CreatedByAvatar"
    : 'CAST(NULL AS NVARCHAR(40)) AS CreatedByAvatar';
  const avatarJoin = (f.budgetsCreatedBy && f.usersSettingsDoc)
    ? 'LEFT JOIN dbo.Users AS u ON u.UserId = b.CreatedById'
    : '';
  // Both arrive with sql/migrate_projects_and_guardrails.sql; before it runs
  // the list is exactly what it has always been.
  const projectKeyCol = f.budgetsProjectKey ? 'b.ProjectKey' : 'CAST(NULL AS VARCHAR(16)) AS ProjectKey';
  const guardrailCols = f.budgetsGuardrail
    ? 'b.GuardrailStatus, b.GuardrailBreachCount'
    : 'CAST(NULL AS VARCHAR(10)) AS GuardrailStatus, CAST(NULL AS INT) AS GuardrailBreachCount';

  const r = await rq.query(
    `SELECT b.ProjectId, b.Name, b.Type, b.Status, b.ContractSum, b.ProjectCost, b.UpdatedAt,
            ${ownerCols}
            JSON_VALUE(b.Doc, '$.address') AS Address,
            ${projectKeyCol},
            ${guardrailCols},
            ${avatarCol}
     FROM dbo.Budgets AS b
     ${avatarJoin}
     WHERE ${where}
     ORDER BY b.UpdatedAt DESC`);

  const list = r.recordset.map(x => ({
    projectId: x.ProjectId, name: x.Name, type: x.Type, status: x.Status,
    address: x.Address || '',
    contractSum: Number(x.ContractSum), projectCost: Number(x.ProjectCost),
    createdById: x.CreatedById || null, createdByName: x.CreatedByName || null,
    createdByAvatar: x.CreatedByAvatar || null,
    projectKey: x.ProjectKey || null,
    guardrailStatus: x.GuardrailStatus || null,
    guardrailBreachCount: x.GuardrailBreachCount === null ? null : Number(x.GuardrailBreachCount),
    updated: x.UpdatedAt.toISOString()
  }));
  context.res = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) };
};
