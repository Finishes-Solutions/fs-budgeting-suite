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
// POST /api/user-settings?scope=feedback — file a bug report or feature
//   request. Any signed-in account. The row is written first and only then is
//   the notification email attempted, so a mail outage can never cost someone
//   their report.
// GET /api/user-settings?scope=feedback — the feedback board (super_admin).
// PUT /api/user-settings?scope=feedback — set one report's status and notes,
//   as { feedbackId, status, notes } (super_admin only).
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
const FB = require('../shared/feedback');
const mailer = require('../shared/mailer');

const VALID_ROLES = ['user', 'manager', 'director', 'super_admin'];
// Enough for a bad afternoon, not enough to flood the board.
const RATE_LIMIT_PER_HOUR = 12;

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

  // ---- feedback: submit (anyone signed in), read and triage (super_admin)
  if (String((req.query && req.query.scope) || '') === 'feedback') {
   try {
    const f = await features(pool);
    if (!f.feedbackTable) {
      context.res = jsonRes(503, { error: 'migration_pending',
        message: 'Feedback needs sql/migrate_feedback.sql to be run against this database.' });
      return;
    }

    if (req.method === 'POST') {
      const parsed = FB.sanitizeSubmission(req.body);
      if (!parsed.ok) {
        context.res = jsonRes(400, { error: 'bad_request', message: parsed.message });
        return;
      }
      // A slip of the finger on the Send button should not fill the board.
      const recent = await pool.request()
        .input('uid', sql.NVarChar(128), principal.userId)
        .query(`SELECT COUNT(*) AS N FROM dbo.Feedback
                WHERE UserId = @uid AND CreatedAt > DATEADD(hour, -1, SYSUTCDATETIME());`);
      if (((recent.recordset[0] || {}).N || 0) >= RATE_LIMIT_PER_HOUR) {
        context.res = jsonRes(429, { error: 'rate_limited',
          message: 'That is a lot of reports in one hour. Give it a few minutes, '
                 + 'or email matthews@finishessolutions.com directly.' });
        return;
      }

      const r = parsed.report;
      const who = await U.ensureUser(pool, principal, {});
      const userName = (who && (who.DisplayName || who.UserDetails)) || principal.userDetails || null;
      const userEmail = (who && who.Email) || principal.userDetails || null;

      const ins = await pool.request()
        .input('kind', sql.VarChar(20), r.kind)
        .input('title', sql.NVarChar(200), r.title)
        .input('body', sql.NVarChar(sql.MAX), r.body)
        .input('sev', sql.VarChar(20), r.severity)
        .input('uid', sql.NVarChar(128), principal.userId)
        .input('uname', sql.NVarChar(200), userName)
        .input('uemail', sql.NVarChar(320), userEmail)
        .input('route', sql.NVarChar(200), r.pageRoute || null)
        .input('env', sql.NVarChar(40), r.environment || null)
        .input('ver', sql.NVarChar(120), r.appVersion || null)
        .input('ua', sql.NVarChar(500), r.userAgent || null)
        .input('vp', sql.VarChar(40), r.viewport || null)
        .input('ctx', sql.NVarChar(sql.MAX), r.contextDoc)
        .query(`INSERT INTO dbo.Feedback
                  (Kind, Title, Body, Severity, UserId, UserName, UserEmail,
                   PageRoute, Environment, AppVersion, UserAgent, Viewport, ContextDoc)
                OUTPUT INSERTED.FeedbackId, INSERTED.CreatedAt
                VALUES (@kind, @title, @body, @sev, @uid, @uname, @uemail,
                        @route, @env, @ver, @ua, @vp, @ctx);`);
      const row = ins.recordset[0];
      const saved = Object.assign({}, r, { feedbackId: row.FeedbackId,
        createdAt: row.CreatedAt, userName, userEmail });

      await U.recordActivity(pool, principal, 'feedback_submit', 'feedback',
        String(row.FeedbackId), { kind: r.kind, title: r.title });

      // The report is safe from here on. Mail is best effort, and its outcome
      // is recorded on the row so the board can show what happened.
      const sent = await mailer.send({
        subject: FB.subjectFor(saved),
        html: FB.htmlFor(saved),
        replyTo: userEmail || undefined
      });
      const state = sent.ok ? 'sent' : (sent.disabled ? 'disabled' : 'failed');
      try {
        await pool.request()
          .input('id', sql.Int, row.FeedbackId)
          .input('st', sql.VarChar(20), state)
          .input('err', sql.NVarChar(400), sent.ok ? null : String(sent.error || '').slice(0, 400))
          .query(`UPDATE dbo.Feedback
                    SET EmailStatus = @st, EmailError = @err,
                        EmailedAt = IIF(@st = 'sent', SYSUTCDATETIME(), NULL)
                  WHERE FeedbackId = @id;`);
      } catch (e) { /* bookkeeping must never fail the submission */ }

      context.res = jsonRes(201, { ok: true, feedbackId: row.FeedbackId, emailStatus: state });
      return;
    }

    if (!isSuperAdmin(req)) {
      context.res = jsonRes(403, { error: 'forbidden', message: 'Requires super_admin role.' });
      return;
    }

    if (req.method === 'GET') {
      const r = await pool.request().query(
        `SELECT TOP 400 FeedbackId, Kind, Title, Body, Severity, UserName, UserEmail,
                PageRoute, Environment, AppVersion, UserAgent, Viewport, ContextDoc,
                Status, AdminNotes, EmailStatus, EmailError, EmailedAt, CreatedAt, UpdatedAt
         FROM dbo.Feedback ORDER BY CreatedAt DESC`);
      context.res = jsonRes(200, r.recordset.map(x => ({
        feedbackId: x.FeedbackId, kind: x.Kind, title: x.Title, body: x.Body,
        severity: x.Severity, userName: x.UserName, userEmail: x.UserEmail,
        pageRoute: x.PageRoute, environment: x.Environment, appVersion: x.AppVersion,
        userAgent: x.UserAgent, viewport: x.Viewport, contextDoc: x.ContextDoc,
        status: x.Status, adminNotes: x.AdminNotes, emailStatus: x.EmailStatus,
        emailError: x.EmailError, emailedAt: x.EmailedAt,
        createdAt: x.CreatedAt, updatedAt: x.UpdatedAt
      })));
      return;
    }

    if (req.method === 'PUT') {
      const parsed = FB.sanitizeStatusUpdate(req.body);
      if (!parsed.ok) {
        context.res = jsonRes(400, { error: 'bad_request', message: parsed.message });
        return;
      }
      const u = parsed.update;
      const rq = pool.request()
        .input('id', sql.Int, u.feedbackId)
        .input('st', sql.VarChar(20), u.status);
      let setNotes = '';
      if (u.notes !== undefined) { rq.input('notes', sql.NVarChar(sql.MAX), u.notes || null); setNotes = ', AdminNotes = @notes'; }
      const r = await rq.query(`UPDATE dbo.Feedback
          SET Status = @st${setNotes}, UpdatedAt = SYSUTCDATETIME()
        WHERE FeedbackId = @id;`);
      const changed = Array.isArray(r.rowsAffected)
        ? r.rowsAffected.reduce((a, n) => a + n, 0)
        : Number(r.rowsAffected) || 0;
      if (!changed) {
        context.res = jsonRes(404, { error: 'not_found', message: 'Report not found.' });
        return;
      }
      await U.recordActivity(pool, principal, 'feedback_update', 'feedback',
        String(u.feedbackId), { status: u.status });
      context.res = jsonRes(200, { ok: true, feedbackId: u.feedbackId, status: u.status });
      return;
    }

    context.res = jsonRes(405, { error: 'method_not_allowed' });
    return;
   } catch (e) {
    context.res = jsonRes(500, { error: 'feedback_failed',
      message: 'Feedback failed: ' + (e && e.message ? e.message : String(e)) });
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
    // What the server can actually do, answered on the call the app already
    // makes rather than in a probe of its own. The feedback button reads this
    // to decide between filing a report here and handing one to the user's
    // mail client, so finishing the Azure setup switches it over on its own.
    const f = await features(pool);
    context.res = jsonRes(200, Object.assign(U.userResponse(row), {
      features: { feedbackStore: !!f.feedbackTable, feedbackMail: mailer.isConfigured() }
    }));
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
