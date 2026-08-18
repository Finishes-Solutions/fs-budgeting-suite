// GET /api/admin-roles — every account with its application role.
// PUT /api/admin-roles — set one account's role: { userId, appRole }.
//
// The target account travels in the PUT body rather than the route. A flat
// route matches every other endpoint here and avoids the optional route
// parameter, which the managed-Functions host did not register.
//
// The SWA route rule gates this to super_admin; the in-function check is
// defense-in-depth.
const { getPool, sql } = require('../shared/db');
const { isSuperAdmin } = require('../shared/auth');
const { features } = require('../shared/schema');

const VALID_ROLES = ['user', 'manager', 'director', 'super_admin'];

const jsonRes = (status, body) => ({
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

module.exports = async function (context, req) {
  if (!isSuperAdmin(req)) {
    context.res = jsonRes(403, { error: 'forbidden', message: 'Requires super_admin role.' });
    return;
  }
  const pool = await getPool();

  // Roles live in a column added by sql/migrate_roles_and_ownership.sql. Until
  // that runs, say so plainly instead of failing with a SQL error.
  const f = await features(pool);
  if (!f.usersAppRole) {
    context.res = jsonRes(503, { error: 'migration_pending',
      message: 'Role management needs sql/migrate_roles_and_ownership.sql to be run against this database.' });
    return;
  }

  if (req.method === 'GET') {
    const r = await pool.request().query(
      `SELECT UserId, UserDetails, DisplayName, Email, AppRole, LastSeenAt, LoginCount
       FROM dbo.Users ORDER BY LastSeenAt DESC`);
    context.res = jsonRes(200, r.recordset.map(x => ({
      userId: x.UserId,
      userDetails: x.UserDetails || null,
      displayName: x.DisplayName || null,
      email: x.Email || null,
      appRole: x.AppRole || 'user',
      lastSeenAt: x.LastSeenAt,
      loginCount: x.LoginCount
    })));
    return;
  }

  // ---- PUT
  const body = req.body || {};
  const targetId = typeof body.userId === 'string' ? body.userId : '';
  if (!targetId) {
    context.res = jsonRes(400, { error: 'bad_request', message: 'userId is required.' });
    return;
  }
  const role = body.appRole;
  if (!VALID_ROLES.includes(role)) {
    context.res = jsonRes(400, { error: 'bad_request',
      message: 'appRole must be one of: ' + VALID_ROLES.join(', ') });
    return;
  }
  const r = await pool.request()
    .input('uid', sql.NVarChar(128), targetId)
    .input('role', sql.NVarChar(50), role)
    .query(`UPDATE dbo.Users SET AppRole = @role, UpdatedAt = SYSUTCDATETIME()
            WHERE UserId = @uid;
            SELECT @@ROWCOUNT AS N;`);
  if (!r.recordset[0].N) {
    context.res = jsonRes(404, { error: 'not_found', message: 'User not found.' });
    return;
  }
  context.res = jsonRes(200, { ok: true, userId: targetId, appRole: role });
};
