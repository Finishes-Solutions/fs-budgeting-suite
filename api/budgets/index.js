const { getPool, sql } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const { ensureUser } = require('../shared/users');
const { features } = require('../shared/schema');

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

  const r = await rq.query(
    `SELECT b.ProjectId, b.Name, b.Type, b.Status, b.ContractSum, b.ProjectCost, b.UpdatedAt,
            ${ownerCols}
            JSON_VALUE(b.Doc, '$.address') AS Address,
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
    updated: x.UpdatedAt.toISOString()
  }));
  context.res = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) };
};
