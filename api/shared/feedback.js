// Shape and wording of a feedback report, in one place.
//
// The API and test/mock-api.js both use this module, so what the browser
// suites validate against is the same code the deployed endpoint runs. It is
// dependency-free and does no I/O: validation in, plain object out.

const KINDS = ['bug', 'feature'];
const SEVERITIES = ['blocking', 'major', 'minor'];
const STATUSES = ['New', 'Triaged', 'In Progress', 'Done', 'Declined'];

const LIM = { title: 200, body: 8000, route: 200, env: 40, version: 120,
              agent: 500, viewport: 40, notes: 4000, context: 12000 };

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/* Returns { ok: true, report } or { ok: false, message }. The message is
   written for the person who typed the form, not for a log. */
function sanitizeSubmission(raw) {
  let b = raw || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) b = {};

  const kind = KINDS.indexOf(b.kind) !== -1 ? b.kind : '';
  if (!kind) return { ok: false, message: 'Choose whether this is a bug or a feature request.' };

  const title = str(b.title, LIM.title);
  if (title.length < 3) return { ok: false, message: 'Give it a short title so it can be found later.' };

  const body = str(b.body, LIM.body);
  if (body.length < 5) {
    return { ok: false, message: kind === 'bug'
      ? 'Describe what happened, and what you expected instead.'
      : 'Describe what you would like the app to do.' };
  }

  // Severity belongs to bugs. A feature request with one set is not an error
  // worth stopping for — the value is simply dropped.
  const severity = kind === 'bug' && SEVERITIES.indexOf(b.severity) !== -1 ? b.severity : null;

  const c = b.context && typeof b.context === 'object' && !Array.isArray(b.context) ? b.context : {};
  // The diagnostics block is stored whole as JSON, but only after being
  // re-serialised from values this module produced: a client cannot smuggle
  // arbitrary structure into the column.
  const rows = Array.isArray(c.rows)
    ? c.rows.filter(r => Array.isArray(r) && r.length === 2)
        .slice(0, 40)
        .map(r => [str(r[0], 80), str(r[1], 500)])
    : [];

  return { ok: true, report: {
    kind, title, body, severity,
    pageRoute: str(c.route, LIM.route),
    environment: str(c.environment, LIM.env),
    appVersion: str(c.appVersion, LIM.version),
    userAgent: str(c.userAgent, LIM.agent),
    viewport: str(c.viewport, LIM.viewport),
    contextDoc: JSON.stringify({ rows }).slice(0, LIM.context)
  } };
}

function sanitizeStatusUpdate(raw) {
  let b = raw || {};
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  if (!b || typeof b !== 'object') b = {};
  const id = Number(b.feedbackId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, message: 'feedbackId is required.' };
  const status = STATUSES.indexOf(b.status) !== -1 ? b.status : '';
  if (!status) return { ok: false, message: 'status must be one of: ' + STATUSES.join(', ') };
  const notes = b.notes === undefined ? undefined : str(b.notes, LIM.notes);
  return { ok: true, update: { feedbackId: id, status, notes } };
}

const KIND_LABEL = { bug: 'Bug', feature: 'Feature Request' };

function subjectFor(r) {
  const who = r.userName || r.userEmail || 'Unknown user';
  const sev = r.severity ? ' · ' + r.severity : '';
  return `[FS Suite · ${KIND_LABEL[r.kind] || 'Report'}${sev}] ${r.title} — ${who}`;
}

const esc = s => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* The email is deliberately plain: a heading, the report, then everything
   known about where it came from. It is read on a phone as often as not. */
function htmlFor(r) {
  let rows = [];
  try { rows = (JSON.parse(r.contextDoc || '{}').rows) || []; } catch (e) { rows = []; }
  const detail = [
    ['Reported by', (r.userName || '—') + (r.userEmail ? ' <' + r.userEmail + '>' : '')],
    ['Type', KIND_LABEL[r.kind] || r.kind],
    ['Severity', r.severity || '—'],
    ['Page', r.pageRoute || '—'],
    ['Environment', r.environment || '—'],
    ['App version', r.appVersion || '—'],
    ['Viewport', r.viewport || '—'],
    ['Browser', r.userAgent || '—'],
    ['Submitted', r.createdAt || new Date().toISOString()],
    ['Reference', r.feedbackId ? '#' + r.feedbackId : '—']
  ].concat(rows.map(x => [x[0], x[1]]));

  const cell = 'padding:6px 10px;border-bottom:1px solid #E6E8E7;font-size:13px;'
             + 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#12140F;max-width:680px">
  <div style="background:#0B3D2C;color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">
    <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.75">Finishes Solutions Budgeting Suite</div>
    <div style="font-size:17px;font-weight:600;margin-top:2px">${esc(KIND_LABEL[r.kind] || 'Report')}: ${esc(r.title)}</div>
  </div>
  <div style="border:1px solid #E6E8E7;border-top:none;border-radius:0 0 8px 8px;padding:16px 18px">
    <div style="white-space:pre-wrap;font-size:14px;line-height:1.5">${esc(r.body)}</div>
    <table style="width:100%;border-collapse:collapse;margin-top:18px">
      ${detail.map(d => `<tr><td style="${cell};color:#6B7280;width:150px;vertical-align:top">${esc(d[0])}</td>
        <td style="${cell};word-break:break-word">${esc(d[1])}</td></tr>`).join('')}
    </table>
    <div style="margin-top:14px;font-size:12px;color:#6B7280">
      Sent by the Budgeting Suite. Reply to reach the person who filed it.
    </div>
  </div>
</div>`;
}

module.exports = { KINDS, SEVERITIES, STATUSES, LIM,
                   sanitizeSubmission, sanitizeStatusUpdate, subjectFor, htmlFor };
