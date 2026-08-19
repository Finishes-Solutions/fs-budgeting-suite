/* ============================================================
   Feedback — the bug button, its dialog, and the Admin board
   ============================================================
   One small module rather than more of index.html, and one place where both
   halves live: what a user sends, and what an admin reads.

   A report goes to POST /api/user-settings?scope=feedback. The row is written
   before any email is attempted, so a mail outage costs nothing. If the POST
   itself fails — offline, or the migration has not been run yet — the dialog
   offers the same report as a prefilled email instead, so the user is never
   left holding something they cannot send.

   Diagnostics are collected automatically. They are the difference between a
   report you can act on and "it broke", and they are shown to the user before
   they send, because a report that quietly harvests context is not honest.

   Injected by index.html (init):
     api, esc, toast, fmtWhen, versionRows, currentRoute, mailTo
   ============================================================ */
(function () {
'use strict';

var A = {};
var open = false;
var kind = 'bug';
var busy = false;
var lastError = '';

/* ---------- context ---------- */

/* The Version page's diagnostics table, plus where the user actually was.
   versionRows() is the same function that paints that page, so the report and
   the page can never disagree. */
function context() {
  var rows = [];
  try { rows = (A.versionRows && A.versionRows()) || []; } catch (e) { rows = []; }
  var find = function (label) {
    for (var i = 0; i < rows.length; i++) if (rows[i][0] === label) return String(rows[i][1] || '');
    return '';
  };
  // versionRows escapes for HTML; strip the entities back out so the stored
  // value and the email read as plain text.
  var plain = function (s) {
    return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  };
  return {
    route: (A.currentRoute && A.currentRoute()) || location.hash || '#/',
    environment: plain(find('Environment')),
    appVersion: 'pricing ' + plain(find('Pricing Library Version'))
      + ' · engine ' + plain(find('Investment Engine')),
    userAgent: navigator.userAgent,
    viewport: window.innerWidth + '×' + window.innerHeight,
    rows: rows.map(function (r) { return [plain(r[0]), plain(r[1])]; })
  };
}

/* ---------- dialog ---------- */

function el(id) { return document.getElementById(id); }

function show(k) {
  kind = k === 'feature' ? 'feature' : 'bug';
  lastError = '';
  var m = el('fbModal');
  if (!m) return;
  open = true;
  m.style.display = 'flex';
  paintForm();
  var t = el('fbTitle');
  if (t) setTimeout(function () { t.focus(); }, 30);
}

function close() {
  open = false;
  var m = el('fbModal');
  if (m) m.style.display = 'none';
}

function setKind(k) {
  kind = k === 'feature' ? 'feature' : 'bug';
  paintForm();
}

/* The severity row and the wording both belong to bugs; a feature request
   asking "what went wrong" reads as a form nobody proofread. */
function paintForm() {
  var bug = kind === 'bug';
  var t = el('fbHeading'); if (t) t.textContent = bug ? 'Report a Bug' : 'Request a Feature';
  var sev = el('fbSevRow'); if (sev) sev.style.display = bug ? '' : 'none';
  var lab = el('fbBodyLab');
  if (lab) lab.textContent = bug ? 'What happened, and what did you expect?' : 'What would you like it to do?';
  var body = el('fbBody');
  if (body) body.placeholder = bug
    ? 'I clicked Export on a budget and nothing downloaded. I expected the PDF to open.'
    : 'It would help to filter the budgets list by the person who created it.';
  [['fbKindBug', bug], ['fbKindFeature', !bug]].forEach(function (p) {
    var b = el(p[0]);
    if (b) { b.classList.toggle('on', p[1]); b.setAttribute('aria-pressed', p[1] ? 'true' : 'false'); }
  });
  paintContext();
  var err = el('fbError');
  // The stylesheet hides both of these, so showing one means setting a value,
  // not clearing the inline style back to the rule that hides it.
  if (err) { err.textContent = lastError; err.style.display = lastError ? 'block' : 'none'; }
}

function paintContext() {
  var c = context();
  var box = el('fbCtx');
  if (!box) return;
  var line = function (k, v) {
    return '<div class="fb-ctx-row"><span>' + A.esc(k) + '</span><span>' + A.esc(v || '—') + '</span></div>';
  };
  box.innerHTML = line('Page', c.route) + line('Environment', c.environment)
    + line('Versions', c.appVersion) + line('Screen', c.viewport);
}

function readForm() {
  return {
    kind: kind,
    title: (el('fbTitle') || {}).value || '',
    body: (el('fbBody') || {}).value || '',
    severity: kind === 'bug' ? ((el('fbSev') || {}).value || 'minor') : null,
    context: context()
  };
}

function fail(msg) {
  lastError = msg;
  var err = el('fbError');
  if (err) { err.textContent = msg; err.style.display = 'block'; }
  var fb = el('fbFallback');
  if (fb) fb.style.display = 'block';
}

async function submit() {
  if (busy) return;
  var report = readForm();
  if (report.title.trim().length < 3) return fail('Give it a short title so it can be found later.');
  if (report.body.trim().length < 5) {
    return fail(kind === 'bug' ? 'Describe what happened, and what you expected instead.'
                               : 'Describe what you would like the app to do.');
  }
  busy = true;
  var btn = el('fbSend');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    var r = await A.api('user-settings?scope=feedback',
      { method: 'POST', body: JSON.stringify(report) });
    close();
    clearForm();
    // Delivery is best effort by design, and saying so is more useful than a
    // cheerful lie: the report is stored either way.
    A.toast(r && r.emailStatus === 'sent'
      ? 'Thanks — sent to Matthew.'
      : 'Thanks — saved. Email delivery is not switched on yet.');
  } catch (e) {
    fail(String(e && e.message ? e.message : e));
  } finally {
    busy = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Send Report'; }
  }
}

function clearForm() {
  ['fbTitle', 'fbBody'].forEach(function (id) { var e = el(id); if (e) e.value = ''; });
  lastError = '';
  var fb = el('fbFallback'); if (fb) fb.style.display = 'none';
}

/* The escape hatch: everything the user typed, plus the diagnostics, as a
   mail draft. Used when the API cannot be reached at all. Returns the URL it
   navigated to, which is also how a test reads it — location.href cannot be
   stubbed, and a draft nobody can inspect is a draft nobody can trust. */
function mailFallback() {
  var r = readForm();
  var c = r.context;
  var lines = [r.body, '', '---', 'Type: ' + (r.kind === 'bug' ? 'Bug' : 'Feature request')];
  if (r.severity) lines.push('Severity: ' + r.severity);
  lines.push('Page: ' + c.route, 'Environment: ' + c.environment,
             'Versions: ' + c.appVersion, 'Screen: ' + c.viewport, 'Browser: ' + c.userAgent);
  var subject = '[FS Suite] ' + r.title;
  var url = 'mailto:' + (A.mailTo || 'matthews@finishessolutions.com')
    + '?subject=' + encodeURIComponent(subject)
    + '&body=' + encodeURIComponent(lines.join('\n'));
  location.href = url;
  return url;
}

/* ---------- admin board ---------- */

var board = [];
var boardFilter = 'open';
var STATUSES = ['New', 'Triaged', 'In Progress', 'Done', 'Declined'];
var OPEN = { 'New': 1, 'Triaged': 1, 'In Progress': 1 };

async function loadBoard() {
  var tb = el('fbBoardBody');
  if (!tb) return;
  tb.innerHTML = '<tr><td colspan="6" style="padding:22px;color:var(--ink-400)">Loading…</td></tr>';
  try {
    board = await A.api('user-settings?scope=feedback');
    paintBoard();
  } catch (e) {
    var pending = /migration_pending|migrate_feedback/.test(e.message || '');
    tb.innerHTML = '<tr><td colspan="6" style="padding:22px;color:var(--danger)">'
      + A.esc(pending
        ? 'The feedback board is not available yet — this database still needs '
          + 'sql/migrate_feedback.sql to be run. The bug button stays hidden until it is.'
        : e.message) + '</td></tr>';
  }
}

function boardRows() {
  return board.filter(function (x) {
    return boardFilter === 'all' ? true
      : boardFilter === 'open' ? !!OPEN[x.status]
      : x.status === 'Done' || x.status === 'Declined';
  });
}

var MAIL_LABEL = { sent: 'Emailed', pending: 'Not sent', failed: 'Email failed', disabled: 'Email off' };

function paintBoard() {
  var tb = el('fbBoardBody');
  if (!tb) return;
  var rows = boardRows();
  tb.innerHTML = '';
  rows.forEach(function (x) {
    var sev = x.severity ? '<span class="fb-sev fb-sev-' + A.esc(x.severity) + '">' + A.esc(x.severity) + '</span>' : '';
    var mail = x.emailStatus && x.emailStatus !== 'sent'
      ? '<span class="fb-mail fb-mail-' + A.esc(x.emailStatus) + '" title="' + A.esc(x.emailError || '') + '">'
        + A.esc(MAIL_LABEL[x.emailStatus] || x.emailStatus) + '</span>'
      : '';
    tb.insertAdjacentHTML('beforeend',
      '<tr class="fb-row" data-fb-id="' + x.feedbackId + '">'
      + '<td style="padding-left:22px"><span class="fb-kind fb-kind-' + A.esc(x.kind) + '">'
        + (x.kind === 'bug' ? 'Bug' : 'Feature') + '</span></td>'
      + '<td><button class="fb-open" onclick="FSFeedback.toggleRow(' + x.feedbackId + ')">'
        + A.esc(x.title) + '</button> ' + sev + ' ' + mail + '</td>'
      + '<td style="font-size:12px;color:var(--ink-500)">' + A.esc(x.userName || x.userEmail || '—') + '</td>'
      + '<td style="font-size:12px;color:var(--ink-400)">' + A.esc(A.fmtWhen(x.createdAt)) + '</td>'
      + '<td><select class="admin-role-sel" onchange="FSFeedback.setStatus(' + x.feedbackId + ',this.value)">'
        + STATUSES.map(function (s) {
            return '<option value="' + s + '"' + (x.status === s ? ' selected' : '') + '>' + s + '</option>';
          }).join('')
      + '</select></td><td class="no-print"></td></tr>'
      + '<tr class="fb-detail" id="fbDetail' + x.feedbackId + '" style="display:none"><td colspan="6">'
        + detailHTML(x) + '</td></tr>');
  });
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6" style="padding:22px;color:var(--ink-400)">'
      + (board.length ? 'Nothing in this view.' : 'No reports yet.') + '</td></tr>';
  }
  var counts = el('fbCounts');
  if (counts) {
    var openN = board.filter(function (x) { return OPEN[x.status]; }).length;
    counts.textContent = openN + ' open · ' + board.length + ' total';
  }
}

function detailHTML(x) {
  // The diagnostics rows already carry environment, versions, browser and the
  // rest; only what they do not know is stated separately, so the table is not
  // half duplicates.
  var rows = [];
  try { rows = (JSON.parse(x.contextDoc || '{}').rows) || []; } catch (e) { rows = []; }
  var mail = x.emailStatus === 'sent' ? 'Emailed to ' + (A.mailTo || 'the inbox')
    : (MAIL_LABEL[x.emailStatus] || x.emailStatus) + (x.emailError ? ' — ' + x.emailError : '');
  var meta = [['Reported by', (x.userName || '—') + (x.userEmail ? ' <' + x.userEmail + '>' : '')],
              ['Page', x.pageRoute], ['Screen', x.viewport], ['Notification', mail]]
    .concat(rows);
  return '<div class="fb-det">'
    + '<div class="fb-det-body">' + A.esc(x.body) + '</div>'
    + '<table class="fb-det-meta">' + meta.map(function (m) {
        return '<tr><td>' + A.esc(m[0]) + '</td><td>' + A.esc(m[1] || '—') + '</td></tr>';
      }).join('') + '</table></div>';
}

function toggleRow(id) {
  var d = el('fbDetail' + id);
  if (d) d.style.display = d.style.display === 'none' ? '' : 'none';
}

function setFilter(f) {
  boardFilter = f;
  ['open', 'closed', 'all'].forEach(function (k) {
    var b = el('fbFilter-' + k);
    if (b) b.classList.toggle('on', k === f);
  });
  paintBoard();
}

async function setStatus(id, status) {
  try {
    await A.api('user-settings?scope=feedback',
      { method: 'PUT', body: JSON.stringify({ feedbackId: id, status: status }) });
    var row = board.filter(function (x) { return x.feedbackId === id; })[0];
    if (row) row.status = status;
    A.toast('Marked ' + status + '.');
    if (boardFilter !== 'all') paintBoard();
  } catch (e) {
    A.toast('Could not update — ' + (e && e.message ? e.message : e));
    loadBoard();
  }
}

window.FSFeedback = {
  init: function (a) { A = a || {}; },
  show: show,
  close: close,
  setKind: setKind,
  submit: submit,
  mailFallback: mailFallback,
  loadBoard: loadBoard,
  setFilter: setFilter,
  setStatus: setStatus,
  toggleRow: toggleRow,
  isOpen: function () { return open; },
  // exposed for the suites
  _context: context,
  _board: function () { return board; }
};
})();
