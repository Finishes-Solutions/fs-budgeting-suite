// GET /api/user-settings[?boot=1] — the signed-in account's profile and
//   settings. `boot=1` marks a session bootstrap: LastSeenAt refreshes, and a
//   quiet gap (30+ minutes) counts as a login and logs one.
// PUT /api/user-settings — save profile fields and/or settings. The settings
//   document is validated against the whitelist in shared/users.js: unknown
//   keys are dropped, bad values fall back, so the stored JSON is always safe
//   to apply blindly. Records a 'settings_update' activity event.
//
// GET /api/user-settings?scope=roles — every account with its application
//   role (super_admin only). Powers the Admin page.
// PUT /api/user-settings?scope=roles — set one account's role, as
//   { userId, appRole } (super_admin only).
//
// Role management lives here rather than in a function of its own because a
// dedicated api/admin-roles function did not register on the deployed host —
// it answered 404 while every established endpoint kept working, through both
// a parameterised and a flat route. Hanging it off an endpoint that is known
// to deploy is what actually reaches users. The SWA route rule cannot gate a
// query parameter, so the super_admin check in requireSuperAdmin below is the
// real gate, not a second line of defence.
//
// Settings are PER ACCOUNT, keyed by the SWA principal userId, so they follow
// the user to any signed-in browser. The client keeps a localStorage cache
// purely so the theme applies before the first network round trip.
const { getPool, sql } = require('../shared/db');
const { getPrincipal, isSuperAdmin } = require('../shared/auth');
const U = require('../shared/users');
const { features } = require('../shared/schema');

const VALID_ROLES = ['user', 'manager', 'director', 'super_admin'];

const jsonRes = (status, body) => ({
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal || !principal.userId) {
    context.res = jsonRes(401, { error: 'not_authenticated', message: 'Sign in to load settings.' });
    return;
  }
  const pool = await getPool();

  // ---- role management (super_admin only)
  if (String((req.query && req.query.scope) || '') === 'roles') {
   try {
    if (!isSuperAdmin(req)) {
      context.res = jsonRes(403, { error: 'forbidden', message: 'Requires super_admin role.' });
      return;
    }
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

    if (req.method === 'PUT') {
      // A body can arrive already parsed or still a string depending on how the
      // host read the request; accept either rather than 400-ing on a shape.
      let b = req.body || {};
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      const targetId = typeof b.userId === 'string' ? b.userId : '';
      if (!targetId) {
        context.res = jsonRes(400, { error: 'bad_request', message: 'userId is required.' });
        return;
      }
      if (!VALID_ROLES.includes(b.appRole)) {
        context.res = jsonRes(400, { error: 'bad_request',
          message: 'appRole must be one of: ' + VALID_ROLES.join(', ') });
        return;
      }
      // One statement, and the count comes from the driver's own rowsAffected.
      // The previous version ran `UPDATE ...; SELECT @@ROWCOUNT` and then read
      // r.recordset[0] — when the batch yields no recordset that throws, and an
      // exception here surfaces as a bare 500 with an empty body, which is
      // exactly what the Admin page was reporting.
      const r = await pool.request()
        .input('uid', sql.NVarChar(128), targetId)
        .input('role', sql.NVarChar(50), b.appRole)
        .query(`UPDATE dbo.Users SET AppRole = @role, UpdatedAt = SYSUTCDATETIME()
                WHERE UserId = @uid;`);
      const changed = Array.isArray(r.rowsAffected)
        ? r.rowsAffected.reduce((a, n) => a + n, 0)
        : Number(r.rowsAffected) || 0;
      if (!changed) {
        context.res = jsonRes(404, { error: 'not_found', message: 'User not found.' });
        return;
      }
      await U.recordActivity(pool, principal, 'settings_update', 'user', targetId,
        { roleChangedTo: b.appRole });
      context.res = jsonRes(200, { ok: true, userId: targetId, appRole: b.appRole });
      return;
    }

    context.res = jsonRes(405, { error: 'method_not_allowed' });
    return;
   } catch (e) {
    // An unhandled throw here reaches the client as an empty 500, which says
    // nothing. Name the failure so the next report is actionable.
    context.res = jsonRes(500, { error: 'role_update_failed',
      message: 'Role management failed: ' + (e && e.message ? e.message : String(e)) });
    return;
   }
  }

  if (req.method === 'GET') {
    const boot = /^(1|true)$/i.test(String((req.query && req.query.boot) || ''));
    const row = await U.ensureUser(pool, principal, { boot });
    // ensureUser's OUTPUT tells us whether this bootstrap crossed the quiet
    // gap: a fresh row has no DELETED side, a counted login raised LoginCount.
    const loggedIn = boot && (row.PrevLogins === null || row.PrevLogins === undefined
      || row.LoginCount > row.PrevLogins);
    if (loggedIn) await U.recordActivity(pool, principal, 'login', null, null, null);
    context.res = jsonRes(200, U.userResponse(row));
    return;
  }

  // ---- PUT
  const body = req.body || {};
  const row = await U.ensureUser(pool, principal, {});
  const profile = U.sanitizeProfile(body);
  const stored = U.settingsOf(row);
  const merged = body.settings !== undefined
    ? U.sanitizeSettings(Object.assign({}, stored, body.settings))
    : stored;
  const settingsJson = JSON.stringify(merged);

  const { sql } = require('../shared/db');
  const rq = pool.request()
    .input('uid', sql.NVarChar(128), principal.userId)
    .input('settings', sql.NVarChar(sql.MAX), settingsJson);
  // Email is never client-set: it is locked to the signed-in account and
  // maintained by ensureUser from the platform principal.
  const sets = ['SettingsDoc=@settings', 'SettingsUpdatedAt=SYSUTCDATETIME()', 'UpdatedAt=SYSUTCDATETIME()'];
  if (profile.displayName !== undefined) { rq.input('dn', sql.NVarChar(200), profile.displayName || null); sets.push('DisplayName=@dn'); }
  if (profile.phone !== undefined) { rq.input('ph', sql.NVarChar(40), profile.phone || null); sets.push('Phone=@ph'); }
  // AppRole is optional until sql/migrate_roles_and_ownership.sql has run.
  const f = await features(pool);
  const appRoleOut = f.usersAppRole ? 'INSERTED.AppRole,' : '';
  const r = await rq.query(`UPDATE dbo.Users SET ${sets.join(', ')}
    OUTPUT INSERTED.UserId, INSERTED.UserDetails, INSERTED.DisplayName, INSERTED.Email,
           INSERTED.Phone, INSERTED.SettingsDoc, ${appRoleOut} INSERTED.FirstSeenAt,
           INSERTED.LastSeenAt, INSERTED.LoginCount
    WHERE UserId=@uid;`);

  await U.recordActivity(pool, principal, 'settings_update', null, null, {
    changed: Object.keys(body.settings || {}).concat(
      ['displayName', 'phone'].filter(k => profile[k] !== undefined))
  });
  context.res = jsonRes(200, U.userResponse(r.recordset[0]));
};
