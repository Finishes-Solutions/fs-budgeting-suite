/* ============================================================
   Feedback — the bug button, its dialog, and the Admin board
   ============================================================
   One small module rather than more of index.html, and one place where both
   halves live: what a user sends, and what an admin reads.

   There are two ways a report can leave this page, and the server decides
   which by telling the app whether it can send mail (features.feedbackMail,
   answered on the settings call the app already makes):

     mail mode  — the default until the Graph app registration exists. Pick
                  bug or feature request and the user's own mail client opens
                  with the subject and every diagnostic already filled in;
                  they describe it in their own words and press send. Nothing
                  is stored, because nothing reached us.
     app mode   — once mail is configured. The report is typed here, stored in
                  dbo.Feedback, and emailed from the automation mailbox. If
                  that POST fails, the mail draft is offered as the fallback.

   Finishing the Azure setup switches the button over on its own; no code
   change, no deploy.

   Diagnostics are collected automatically. They are the difference between a
   report you can act on and "it broke", and they are shown to the user before
   they send, because a report that quietly harvests context is not honest.

   Injected by index.html (init):
     api, esc, toast, fmtWhen, versionRows, currentRoute, pageLabel, userName,
     features, mailTo
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
    page: (A.pageLabel && A.pageLabel()) || 'the app',
    signedIn: plain(find('Signed In')),
    roles: plain(find('Roles')),
    host: plain(find('Host')),
    pricingSource: plain(find('Pricing Source')),
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

/* 'app' only once the server says it can actually deliver; anything else —
   unknown, offline, not configured — is 'mail', which always works. */
function mode() {
  var f = (A.features && A.features()) || {};
  return (f.feedbackMail && f.feedbackStore) ? 'app' : 'mail';
}

function show(k) {
  kind = k === 'feature' ? 'feature' : 'bug';
  lastError = '';
  var m = el('fbModal');
  if (!m) return;
  open = true;
  m.style.display = 'flex';
  paintForm();
  // In mail mode the first thing to do is choose a kind, so the kind buttons
  // take focus rather than a field that is not there.
  var first = mode() === 'app' ? el('fbTitle') : el('fbKindBug');
  if (first) setTimeout(function () { first.focus(); }, 30);
}

function close() {
  open = false;
  var m = el('fbModal');
  if (m) m.style.display = 'none';
}

/* One click on a kind button. In app mode it selects; in mail mode it is the
   whole interaction — the next thing the user sees is their own mail client. */
function pick(k) {
  kind = k === 'feature' ? 'feature' : 'bug';
  if (mode() === 'app') { paintForm(); return; }
  var url = compose();
  close();
  A.toast('Opening your email app…');
  return url;
}
function setKind(k) { kind = k === 'feature' ? 'feature' : 'bug'; paintForm(); }

/* The severity row and the wording both belong to bugs; a feature request
   asking "what went wrong" reads as a form nobody proofread. */
function paintForm() {
  var bug = kind === 'bug';
  var app = mode() === 'app';
  var t = el('fbHeading');
  if (t) t.textContent = app ? (bug ? 'Report a Bug' : 'Request a Feature')
                             : 'Report a Bug or Request a Feature';
  var sev = el('fbSevRow'); if (sev) sev.style.display = bug ? '' : 'none';
  var lab = el('fbBodyLab');
  if (lab) lab.textContent = bug ? 'What happened, and what did you expect?' : 'What would you like it to do?';
  var body = el('fbBody');
  if (body) body.placeholder = bug
    ? 'I clicked Export on a budget and nothing downloaded. I expected the PDF to open.'
    : 'It would help to filter the budgets list by the person who created it.';
  // In mail mode the kind buttons are actions, not a selection, so neither is
  // shown as chosen and nothing claims to be pressed.
  [['fbKindBug', app && bug], ['fbKindFeature', app && !bug]].forEach(function (p) {
    var b = el(p[0]);
    if (!b) return;
    b.classList.toggle('on', p[1]);
    if (app) b.setAttribute('aria-pressed', p[1] ? 'true' : 'false');
    else b.removeAttribute('aria-pressed');
  });
  var form = el('fbForm'); if (form) form.style.display = app ? '' : 'none';
  var send = el('fbSend'); if (send) send.style.display = app ? '' : 'none';
  // Copying is the way out when a locked-down desktop refuses mailto:; it only
  // means anything in the mode that depends on a mail client.
  var copy = el('fbCopy'); if (copy) copy.style.display = app ? 'none' : '';
  var note = el('fbNote');
  if (note) note.textContent = app
    ? 'Goes to ' + (A.mailTo || 'the team') + '. Nothing from your budgets is included.'
    : 'Pick one and your email app opens with all of this filled in, addressed to '
      + (A.mailTo || 'the team') + '. Describe it in your own words and send. '
      + 'Nothing from your budgets is included.';
  paintContext();
  var err = el('fbError');
  // The stylesheet hides both of these, so showing one means setting a value,
  // not clearing the inline style back to the rule that hides it.
  if (err) { err.textContent = lastError; err.style.display = lastError ? 'block' : 'none'; }
  var fb = el('fbFallback'); if (fb && !lastError) fb.style.display = 'none';
}

function paintContext() {
  var c = context();
  var box = el('fbCtx');
  if (!box) return;
  var line = function (k, v) {
    return '<div class="fb-ctx-row"><span>' + A.esc(k) + '</span><span>' + A.esc(v || '—') + '</span></div>';
  };
  box.innerHTML = line('Page', c.page + ' (' + c.route + ')')
    + line('Environment', c.environment)
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

/* ---------- the mail draft ---------- */

var KIND_WORD = { bug: 'Bug', feature: 'Feature Request' };

/* Everything the developer needs, short enough to survive a mailto URL.
   Deliberately not the whole Version table: Outlook and several webmail
   clients truncate a long mailto, and a draft that arrives cut in half is
   worse than one that never had the last four lines. */
function detailLines(c) {
  return [
    'Type: ' + (KIND_WORD[kind] || 'Report'),
    'Page: ' + c.page + ' (' + c.route + ')',
    'Environment: ' + c.environment,
    'Host: ' + c.host,
    'Versions: ' + c.appVersion,
    'Pricing source: ' + c.pricingSource,
    'Screen: ' + c.viewport,
    'Signed in: ' + c.signedIn,
    'Roles: ' + c.roles,
    'Browser: ' + c.userAgent,
    'Reported: ' + new Date().toLocaleString()
  ];
}

function detailBlock(c) {
  return '----- Details for the developer — please leave these in -----\n'
    + detailLines(c).join('\n');
}

/* The subject is written for you, not left blank: type, where they were, and
   who they are. Enough to file it without opening it, and still editable. */
function subjectFor(c) {
  var who = (A.userName && A.userName()) || c.signedIn || '';
  return '[FS Suite · ' + (KIND_WORD[kind] || 'Report') + '] '
    + c.page + (who ? ' — ' + who : '');
}

function bodyFor(c, typed) {
  var prompt = kind === 'bug'
    ? 'Describe the problem here — what you did, what happened, and what you expected.'
    : 'Describe what you would like the app to do, and what it would help you get done.';
  return (typed ? typed : prompt) + '\n\n\n' + detailBlock(c) + '\n';
}

/* Hands the report to whatever mail client the machine uses. Returns the URL
   it navigated to, which is also how a test reads it — location.href cannot be
   stubbed, and a draft nobody can inspect is a draft nobody can trust. */
function compose(typed) {
  var c = context();
  var url = 'mailto:' + (A.mailTo || 'matthews@finishessolutions.com')
    + '?subject=' + encodeURIComponent(subjectFor(c))
    + '&body=' + encodeURIComponent(bodyFor(c, typed));
  location.href = url;
  return url;
}

/* Some browsers and locked-down desktops refuse mailto: entirely, and the
   failure is silent — nothing opens and the user is left guessing. Copying the
   same text is the way out that needs no mail client at all. */
async function copyDetails() {
  var c = context();
  var text = 'To: ' + (A.mailTo || 'matthews@finishessolutions.com') + '\n'
    + 'Subject: ' + subjectFor(c) + '\n\n' + bodyFor(c, readForm().body.trim());
  try {
    await navigator.clipboard.writeText(text);
    A.toast('Details copied — paste them into an email.');
  } catch (e) {
    A.toast('Could not copy automatically. Select the details and copy them.');
  }
  return text;
}

/* The app-mode fallback: the user typed a report, the POST failed, and this
   hands the same words to their mail client rather than losing them. */
function mailFallback() { return compose(readForm().body.trim()); }

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
  pick: pick,
  setKind: setKind,
  submit: submit,
  compose: compose,
  copyDetails: copyDetails,
  mailFallback: mailFallback,
  mode: mode,
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
