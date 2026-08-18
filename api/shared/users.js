// Per-user accounts, settings, and the activity log (dbo.Users /
// dbo.UserActivity — sql/migrate_users.sql).
//
// The row key is the Static Web Apps clientPrincipal.userId — the same stable
// value budgets and analyses stamp into CreatedById. Profile fields the app
// queries (display name, contact email, phone) are real columns; every
// presentation preference travels in ONE JSON SettingsDoc so a new setting is
// an additive key here, never another migration.
//
// Activity is best-effort by design: recordActivity swallows its own errors,
// because a failed audit row must never fail the save or export it describes.
const { sql } = require('./db');
// The validation contract lives in its own dependency-free module so
// test/mock-api.js can require the identical logic without touching SQL.
const { DEFAULT_SETTINGS, CLIENT_EVENTS, sanitizeSettings, sanitizeProfile } =
  require('./user-settings-contract');

// A page reload is not a login. A bootstrap only counts as a login (and logs
// one) when the account has been quiet for at least this long.
const LOGIN_GAP_MINUTES = 30;

// Upsert the account row so activity's FK always has a parent. Returns the
// row's current state. When `boot` is set, LastSeenAt refreshes and a quiet
// gap increments LoginCount and logs a 'login' event.
async function ensureUser(pool, principal, opts) {
  const userId = principal && principal.userId;
  if (!userId) return null;
  const boot = !!(opts && opts.boot);
  const r = await pool.request()
    .input('uid', sql.NVarChar(128), userId)
    .input('details', sql.NVarChar(200), principal.userDetails || null)
    .input('boot', sql.Bit, boot ? 1 : 0)
    .input('gap', sql.Int, LOGIN_GAP_MINUTES)
    .query(`MERGE dbo.Users AS t
            USING (SELECT @uid AS UserId) AS s ON t.UserId = s.UserId
            WHEN MATCHED THEN UPDATE SET
              UserDetails = COALESCE(@details, t.UserDetails),
              LoginCount  = t.LoginCount + IIF(@boot = 1 AND DATEDIFF(MINUTE, t.LastSeenAt, SYSUTCDATETIME()) >= @gap, 1, 0),
              LastSeenAt  = IIF(@boot = 1, SYSUTCDATETIME(), t.LastSeenAt),
              UpdatedAt   = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (UserId, UserDetails, LoginCount)
              VALUES (@uid, @details, IIF(@boot = 1, 1, 0))
            OUTPUT INSERTED.UserId, INSERTED.UserDetails, INSERTED.DisplayName, INSERTED.Email,
                   INSERTED.Phone, INSERTED.SettingsDoc, INSERTED.FirstSeenAt, INSERTED.LastSeenAt,
                   INSERTED.LoginCount,
                   DELETED.LastSeenAt AS PrevSeenAt, DELETED.LoginCount AS PrevLogins;`);
  return r.recordset[0] || null;
}

// Fire-and-forget audit row. Never throws.
async function recordActivity(pool, principal, eventType, entityType, entityId, detail) {
  try {
    const userId = principal && principal.userId;
    if (!userId) return;
    await pool.request()
      .input('uid', sql.NVarChar(128), userId)
      .input('ev', sql.VarChar(40), String(eventType).slice(0, 40))
      .input('et', sql.VarChar(30), entityType ? String(entityType).slice(0, 30) : null)
      .input('eid', sql.NVarChar(64), entityId ? String(entityId).slice(0, 64) : null)
      .input('detail', sql.NVarChar(sql.MAX), detail ? JSON.stringify(detail) : null)
      .query(`IF NOT EXISTS (SELECT 1 FROM dbo.Users WHERE UserId = @uid)
                INSERT INTO dbo.Users (UserId) VALUES (@uid);
              INSERT INTO dbo.UserActivity (UserId, EventType, EntityType, EntityId, DetailDoc)
              VALUES (@uid, @ev, @et, @eid, @detail);`);
  } catch (e) { /* audit must never break the operation it describes */ }
}

function settingsOf(row) {
  let stored = {};
  try { stored = JSON.parse(row.SettingsDoc || '{}'); } catch (e) { /* fall back to defaults */ }
  return sanitizeSettings(stored);
}

function userResponse(row) {
  return {
    userDetails: row.UserDetails || null,
    displayName: row.DisplayName || null,
    email: row.Email || null,
    phone: row.Phone || null,
    settings: settingsOf(row),
    firstSeenAt: row.FirstSeenAt,
    lastSeenAt: row.LastSeenAt,
    loginCount: row.LoginCount
  };
}

module.exports = {
  DEFAULT_SETTINGS, CLIENT_EVENTS, LOGIN_GAP_MINUTES,
  sanitizeSettings, sanitizeProfile,
  ensureUser, recordActivity, settingsOf, userResponse
};
