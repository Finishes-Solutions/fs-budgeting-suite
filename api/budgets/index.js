const { getPool, sql } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const { ensureUser, settingsOf } = require('../shared/users');

const FULL_VISIBILITY_ROLES = new Set(['director', 'super_admin']);

module.exports = async function (context, req) {
  const pool = await getPool();
  const principal = getPrincipal(req);
  const userId = principal ? (principal.userId || null) : null;

  let appRole = 'user';
  if (userId) {
    try {
      const row = await ensureUser(pool, principal, {});
      if (row) appRole = row.AppRole || 'user';
    } catch (e) { /* default to user */ }
  }

  const swaSuper = principal && Array.isArray(principal.userRoles) && principal.userRoles.includes('super_admin');
  const canSeeAll = swaSuper || FULL_VISIBILITY_ROLES.has(appRole);

  const rq = pool.request();
  let where = 'b.IsDeleted = 0';
  if (!canSeeAll && userId) {
    rq.input('uid', sql.NVarChar(128), userId);
    where += ' AND (b.CreatedById = @uid OR b.CreatedById IS NULL)';
  }

  const r = await rq.query(
    `SELECT b.ProjectId, b.Name, b.Type, b.Status, b.ContractSum, b.ProjectCost, b.UpdatedAt,
            b.CreatedById, b.CreatedByName,
            JSON_VALUE(b.Doc, '$.address') AS Address,
            JSON_VALUE(u.SettingsDoc, '$.avatarColor') AS CreatedByAvatar
     FROM dbo.Budgets AS b
     LEFT JOIN dbo.Users AS u ON u.UserId = b.CreatedById
     WHERE ${where}
     ORDER BY b.UpdatedAt DESC`);

  const list = r.recordset.map(x => ({
    projectId: x.ProjectId, name: x.Name, type: x.Type, status: x.Status,
    address: x.Address || '',
    contractSum: Number(x.ContractSum), projectCost: Number(x.ProjectCost),
    createdById: x.CreatedById || null, createdByName: x.CreatedByName || null, createdByAvatar: x.CreatedByAvatar || null,
    updated: x.UpdatedAt.toISOString()
  }));
  context.res = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) };
};
