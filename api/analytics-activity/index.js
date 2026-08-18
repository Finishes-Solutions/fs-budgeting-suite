const { getPool, sql } = require('../shared/db');
const { isSuperAdmin } = require('../shared/auth');

const jsonRes = (status, body) => ({
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

function buildFilter(rq, q) {
  const clauses = [];
  if (q.from) {
    rq.input('from', sql.DateTime2, q.from);
    clauses.push('ua.CreatedAt >= @from');
  }
  if (q.to) {
    rq.input('to', sql.DateTime2, q.to);
    clauses.push('ua.CreatedAt <= @to');
  }
  if (q.userId) {
    rq.input('uid', sql.NVarChar(128), q.userId);
    clauses.push('ua.UserId = @uid');
  }
  return clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
}

module.exports = async function (context, req) {
  if (!isSuperAdmin(req)) {
    context.res = jsonRes(403, { error: 'forbidden', message: 'Requires super_admin role.' });
    return;
  }

  const pool = await getPool();
  const q = req.query || {};

  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 500, 1), 5000);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

  const dataRq = pool.request();
  const countRq = pool.request();
  const where = buildFilter(dataRq, q);
  buildFilter(countRq, q);

  const [rows, countResult, users] = await Promise.all([
    dataRq.query(
      `SELECT ua.EventType, ua.EntityType, ua.EntityId, ua.CreatedAt,
              u.DisplayName, u.Email, ua.UserId
       FROM dbo.UserActivity ua
       LEFT JOIN dbo.Users u ON u.UserId = ua.UserId
       ${where}
       ORDER BY ua.CreatedAt DESC, ua.Id DESC
       OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`),
    countRq.query(
      `SELECT COUNT(*) AS total FROM dbo.UserActivity ua ${where}`),
    pool.request().query(
      `SELECT UserId, DisplayName, Email FROM dbo.Users ORDER BY DisplayName`)
  ]);

  context.res = jsonRes(200, {
    events: rows.recordset.map(x => ({
      eventType: x.EventType, entityType: x.EntityType, entityId: x.EntityId,
      createdAt: x.CreatedAt,
      userName: x.DisplayName || x.Email || 'Unknown',
      userId: x.UserId
    })),
    total: countResult.recordset[0].total,
    users: users.recordset.map(u => ({
      userId: u.UserId,
      name: u.DisplayName || u.Email || 'Unknown'
    }))
  });
};
