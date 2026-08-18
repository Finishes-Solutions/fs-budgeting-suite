// POST /api/user-activity — the client reports an event the API cannot see
//   itself (browser-side exports render entirely client-side). Only the
//   whitelisted export events are accepted; everything else is recorded by
//   the endpoint that did the work (logins, saves, settings changes).
// GET  /api/user-activity — the signed-in account's own recent events,
//   newest first (the Users timeline index makes this cheap).
const { getPool, sql } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const U = require('../shared/users');

const jsonRes = (status, body) => ({
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal || !principal.userId) {
    context.res = jsonRes(401, { error: 'not_authenticated', message: 'Sign in first.' });
    return;
  }
  const pool = await getPool();

  if (req.method === 'GET') {
    const r = await pool.request()
      .input('uid', sql.NVarChar(128), principal.userId)
      .query(`SELECT TOP 50 EventType, EntityType, EntityId, DetailDoc, CreatedAt
              FROM dbo.UserActivity WHERE UserId = @uid ORDER BY CreatedAt DESC, Id DESC`);
    context.res = jsonRes(200, { events: r.recordset.map(x => ({
      eventType: x.EventType, entityType: x.EntityType, entityId: x.EntityId,
      detail: x.DetailDoc ? JSON.parse(x.DetailDoc) : null, createdAt: x.CreatedAt
    })) });
    return;
  }

  // ---- POST
  const body = req.body || {};
  const ev = String(body.eventType || '');
  if (!U.CLIENT_EVENTS.has(ev)) {
    context.res = jsonRes(400, { error: 'bad_request',
      message: 'eventType must be one of: ' + [...U.CLIENT_EVENTS].join(', ') });
    return;
  }
  const detail = body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail)
    ? body.detail : null;
  await U.recordActivity(pool, principal, ev,
    typeof body.entityType === 'string' ? body.entityType : null,
    typeof body.entityId === 'string' ? body.entityId : null,
    detail);
  context.res = { status: 204 };
};
