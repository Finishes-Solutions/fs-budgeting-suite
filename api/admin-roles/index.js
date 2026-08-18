const { getPool, sql } = require('../shared/db');
const { isSuperAdmin } = require('../shared/auth');

const VALID_ROLES = ['user', 'manager', 'director', 'super_admin'];

module.exports = async function (context, req) {
  if (!isSuperAdmin(req)) {
    context.res = { status: 403, body: JSON.stringify({ error: 'forbidden' }) };
    return;
  }
  const pool = await getPool();

  if (req.method === 'GET') {
    const r = await pool.request().query(
      `SELECT UserId, UserDetails, DisplayName, Email, AppRole, LastSeenAt, LoginCount
       FROM dbo.Users ORDER BY LastSeenAt DESC`);
    const users = r.recordset.map(x => ({
      userId: x.UserId,
      userDetails: x.UserDetails || null,
      displayName: x.DisplayName || null,
      email: x.Email || null,
      appRole: x.AppRole || 'user',
      lastSeenAt: x.LastSeenAt,
      loginCount: x.LoginCount
    }));
    context.res = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(users) };
    return;
  }

  // PUT /api/admin-roles/{userId}
  const targetId = context.bindingData.userId;
  if (!targetId) {
    context.res = { status: 400, body: JSON.stringify({ error: 'userId required' }) };
    return;
  }
  const body = req.body || {};
  const role = body.appRole;
  if (!VALID_ROLES.includes(role)) {
    context.res = { status: 400, body: JSON.stringify({ error: 'appRole must be one of: ' + VALID_ROLES.join(', ') }) };
    return;
  }
  const r = await pool.request()
    .input('uid', sql.NVarChar(128), targetId)
    .input('role', sql.NVarChar(50), role)
    .query(`UPDATE dbo.Users SET AppRole = @role, UpdatedAt = SYSUTCDATETIME()
            WHERE UserId = @uid;
            SELECT @@ROWCOUNT AS N;`);
  if (!r.recordset[0].N) {
    context.res = { status: 404, body: JSON.stringify({ error: 'User not found' }) };
    return;
  }
  context.res = { headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, userId: targetId, appRole: role }) };
};
