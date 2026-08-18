// GET /api/user-settings[?boot=1] — the signed-in account's profile and
//   settings. `boot=1` marks a session bootstrap: LastSeenAt refreshes, and a
//   quiet gap (30+ minutes) counts as a login and logs one.
// PUT /api/user-settings — save profile fields and/or settings. The settings
//   document is validated against the whitelist in shared/users.js: unknown
//   keys are dropped, bad values fall back, so the stored JSON is always safe
//   to apply blindly. Records a 'settings_update' activity event.
//
// Settings are PER ACCOUNT, keyed by the SWA principal userId, so they follow
// the user to any signed-in browser. The client keeps a localStorage cache
// purely so the theme applies before the first network round trip.
const { getPool } = require('../shared/db');
const { getPrincipal } = require('../shared/auth');
const U = require('../shared/users');

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
  const r = await rq.query(`UPDATE dbo.Users SET ${sets.join(', ')}
    OUTPUT INSERTED.UserId, INSERTED.UserDetails, INSERTED.DisplayName, INSERTED.Email,
           INSERTED.Phone, INSERTED.SettingsDoc, INSERTED.FirstSeenAt, INSERTED.LastSeenAt,
           INSERTED.LoginCount
    WHERE UserId=@uid;`);

  await U.recordActivity(pool, principal, 'settings_update', null, null, {
    changed: Object.keys(body.settings || {}).concat(
      ['displayName', 'phone'].filter(k => profile[k] !== undefined))
  });
  context.res = jsonRes(200, U.userResponse(r.recordset[0]));
};
