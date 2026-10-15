// Home — the "what should I do next" screen.
//
// Budgets and Investment Analysis are the complete, neutral indexes: every
// record, searchable, sortable. Home is deliberately the opposite — personal,
// short, and about what needs doing. It never lists everything.
//
// Everything here reads endpoints that already exist:
//   /api/budgets              the budgets this account can see
//   /api/investment-analyses  the analyses this account can see
//   /api/user-activity        THIS account's own last 50 events
// so recency is personal (what YOU touched) rather than global (what anyone
// touched), which is the thing the two index pages structurally cannot show.
//
// FAVORITES LIVE ON THE ACCOUNT, in the settings document's `favorites` key
// (api/shared/user-settings-contract.js validates and caps it), so they follow
// the user to any signed-in browser rather than being stranded in one. Writes
// go through the same debounced settings save every other preference uses.
//
// This was a pin, and the setting was `pinned`. The contract lifts a stored
// legacy document, and favorites made while they were browser-local are lifted
// by adoptLocalFavorites() below — so nobody loses anything they had starred.
//
// The star TOGGLES wherever it appears (Home, the lists, a project page, both
// editors). The old pin only ever un-pinned, which made it impossible to
// favorite something you were not already looking at on Home.
(function () {
'use strict';

var A = {};                  // adapter, supplied by index.html
var budgets = [];
var analyses = [];
/* Projects, so a favorited project can actually be shown here. Home used to
   fetch budgets and analyses only, which is why starring a project stored the
   favorite correctly and then nothing appeared. */
var projects = [];
// False when the projects scope could not be read (offline, or before its
// migration). "No projects" is only a fact worth steering someone by when the
// list was actually read.
var projectsAvailable = false;
var events = [];
var loaded = false;
var loading = false;
var loadError = null;
var greeting = null;         // picked once per page load so repaints do not reshuffle
var adopted = false;         // legacy localStorage pins are lifted once per load

function esc(s) { return A.esc ? A.esc(String(s)) : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function usd(n) { return A.usd ? A.usd(n) : '$' + Math.round(n || 0).toLocaleString('en-US'); }
function fmtDay(d) { return A.fmtDay ? A.fmtDay(d) : String(d || '').slice(0, 10); }

/* ================= favorites ================= */

// The pre-account storage key, read once by adoptLocalFavorites() and removed.
function legacyPinKey() {
  var uid = (A.userId && A.userId()) || 'anon';
  return 'fs-home-pins-v1:' + uid;
}
var FAV_KINDS = ['budget', 'analysis', 'project'];
function emptyFavorites() { return { budget: [], analysis: [], project: [] }; }
function normaliseFavorites(v) {
  if (!v || typeof v !== 'object') return emptyFavorites();
  var take = function (a) {
    return Array.isArray(a)
      ? a.filter(function (x) { return typeof x === 'string' && x; }).slice(0, 50)
      : [];
  };
  return { budget: take(v.budget), analysis: take(v.analysis), project: take(v.project) };
}
function favoritesRead() {
  var s = (A.settings && A.settings()) || {};
  // `pinned` is the legacy key; the server contract lifts it too, so this only
  // matters for a session that has not round-tripped its settings yet.
  return normaliseFavorites(s.favorites || s.pinned);
}
function favoritesWrite(p) {
  // setSetting stores it and queues the same debounced save every other
  // preference uses; the contract sanitises it again server-side.
  if (A.setSetting) A.setSetting('favorites', normaliseFavorites(p));
}

/* One-time lift of favorites made while they were browser-local. Runs only when
   the account has none, so it can never overwrite what was set elsewhere. */
function adoptLocalFavorites() {
  var key;
  try { key = legacyPinKey(); } catch (e) { return; }
  var local;
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return;
    local = normaliseFavorites(JSON.parse(raw));
  } catch (e) { return; }
  if (!local.budget.length && !local.analysis.length) {
    try { localStorage.removeItem(key); } catch (e) {}
    return;
  }
  var acct = favoritesRead();
  if (!acct.budget.length && !acct.analysis.length && !acct.project.length) favoritesWrite(local);
  try { localStorage.removeItem(key); } catch (e) {}
}
function isFavorite(kind, id) {
  var p = favoritesRead();
  return (p[kind] || []).indexOf(String(id)) !== -1;
}
function unfavorite(kind, id) {
  if (!isFavorite(kind, id)) return false;
  toggleFavorite(kind, id);
  return true;
}

// Returns the new state so the caller can word its own toast.
function toggleFavorite(kind, id) {
  if (FAV_KINDS.indexOf(kind) === -1) return false;
  id = String(id);
  var p = favoritesRead();
  var list = p[kind] || (p[kind] = []);
  var i = list.indexOf(id);
  if (i === -1) list.unshift(id); else list.splice(i, 1);
  favoritesWrite(p);
  if (A.toast) A.toast(i === -1 ? 'Added to Favorites.' : 'Removed from Favorites.');
  if (A.currentPage && A.currentPage() === 'home') render();
  if (A.favoritesChanged) A.favoritesChanged(kind, id, i === -1);
  return i === -1;
}

/* ================= greetings =================
   Varied on purpose: the same line every session makes the app feel like a
   form. Time of day narrows the pool, then one is picked at random and held
   for the page load. */

var GREET = {
  // No budgets and no analyses yet — a genuinely new account.
  empty: [
    ['Let’s get started', 'Create your first budget and the rest of the suite opens up.'],
    ['Nothing here yet', 'Start with a budget — everything else builds on one.'],
    ['Welcome aboard', 'Your first project budget is a couple of clicks away.'],
    ['A clean slate', 'Create a budget to begin pricing a project.'],
    ['Ready when you are', 'Start a budget, then underwrite it as an investment analysis.']
  ],
  morning: [
    ['Good morning', 'Here is where you left off.'],
    ['Morning', 'A quick look at what is waiting.'],
    ['Good morning', 'Picking up where you stopped.'],
    ['Early start', 'Your recent work is below.']
  ],
  afternoon: [
    ['Good afternoon', 'Here is where you left off.'],
    ['Afternoon', 'A quick look at what is waiting.'],
    ['Back at it', 'Your recent work is below.'],
    ['Good afternoon', 'Picking up where you stopped.']
  ],
  evening: [
    ['Good evening', 'Here is where you left off.'],
    ['Evening', 'Wrapping up? Here is what is open.'],
    ['Good evening', 'Your recent work is below.'],
    ['Still going', 'Here is what is waiting.']
  ],
  night: [
    ['Working late', 'Here is where you left off.'],
    ['Burning the midnight oil', 'Your recent work is below.'],
    ['Late one', 'Here is what is waiting.'],
    ['Still up', 'Picking up where you stopped.']
  ],
  // Returning with work in progress — used alongside the time-of-day pool.
  returning: [
    ['Welcome back', 'Here is where you left off.'],
    ['Welcome back', 'A few things are waiting on you.'],
    ['Good to see you', 'Your recent work is below.'],
    ['Where were we', 'Picking up where you stopped.'],
    ['Back again', 'Here is what changed since last time.']
  ]
};

function timeBucket(h) {
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

function pickGreeting() {
  var isEmpty = !budgets.length && !analyses.length;
  // Held for the page load so a repaint does not reshuffle it — but re-picked
  // when the account crosses from empty to having work, or the first budget
  // someone creates would leave "Let's get started" on screen all session.
  if (greeting && greeting.empty === isEmpty) return greeting;
  // The adapter hands over an already-humanised name ("Matthew Sinitiere"),
  // so the first word is the first name.
  var who = (A.displayName && A.displayName()) || '';
  var firstName = String(who).trim().split(/\s+/)[0] || '';
  if (firstName.length > 20) firstName = '';        // not a name, do not use it

  var pool;
  if (isEmpty) {
    pool = GREET.empty;
    firstName = '';                                  // a first run should not feel over-familiar
  } else {
    // Half the time greet by time of day, half the time as a returning user,
    // so the same person sees variety across a day.
    var tod = GREET[timeBucket(new Date().getHours())];
    pool = Math.random() < 0.5 ? tod : GREET.returning;
  }
  var pick = pool[Math.floor(Math.random() * pool.length)];
  greeting = { title: pick[0] + (firstName ? ', ' + firstName : ''), sub: pick[1], empty: isEmpty };
  return greeting;
}

/* ================= data ================= */

var EVENT_LABEL = {
  login: 'Signed in',
  budget_create: 'Created budget', budget_save: 'Saved budget',
  budget_delete: 'Deleted budget', budget_restore: 'Restored budget',
  budget_status: 'Changed budget status', budget_primary: 'Changed primary budget',
  analysis_save: 'Saved analysis',
  analysis_delete: 'Deleted analysis', analysis_restore: 'Restored analysis',
  project_create: 'Created project', project_update: 'Updated project',
  project_status: 'Changed project status', project_convert: 'Converted project',
  project_delete: 'Deleted project',
  favorite_add: 'Favorited', favorite_remove: 'Unfavorited',
  export_pdf: 'Exported PDF', export_xlsx: 'Exported Excel', export_csv: 'Exported CSV',
  export_print: 'Printed', settings_update: 'Updated settings',
  profile_update: 'Updated profile', pricing_publish: 'Published pricing',
  feedback_submit: 'Sent feedback', feedback_update: 'Updated feedback',
  ai_ask: 'Asked the Budget Assistant'
};
function eventLabel(e) { return EVENT_LABEL[e] || e; }

/* What the event was actually about, in words. "Updated settings" told nobody
   anything; every event now carries a structured detail document and this is
   the readable half of it. Kept in step with eventDetail() in
   app/dashboard.js — one vocabulary, two places it is read — and deliberately
   tolerant, so an event written before its shape existed still renders. */
function fieldPhrase(f) {
  var k = f && f.key ? String(f.key) : '';
  var pretty = k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, function (c) { return c.toUpperCase(); });
  if (f && f.from !== undefined && f.to !== undefined && f.from !== null)
    return pretty + ' ' + String(f.from) + ' → ' + String(f.to);
  if (f && f.to !== undefined && f.to !== null) return pretty + ' → ' + String(f.to);
  return pretty;
}
function eventDetail(e) {
  var d = e && e.detail;
  if (!d || typeof d !== 'object') return '';
  var name = d.name ? String(d.name) : '';
  switch (e.eventType) {
    case 'favorite_add': case 'favorite_remove':
      return name;
    case 'budget_create': case 'budget_save': case 'analysis_save':
      return [name, Array.isArray(d.changed) && d.changed.length
        ? d.changed.map(fieldPhrase).join('; ') : ''].filter(Boolean).join(' — ');
    case 'budget_status': case 'project_status': case 'budget_primary':
      return (name ? name + ' — ' : '') + (d.from || 'none') + ' → ' + (d.to || 'none');
    case 'ai_ask':
      return [name, d.question ? '"' + String(d.question) + '"' : ''].filter(Boolean).join(' — ');
    case 'project_delete':
      return (name ? name + ' — ' : '') + d.budgetsDeleted + ' budget'
        + (d.budgetsDeleted === 1 ? '' : 's') + ', ' + d.analysesDeleted + ' analys'
        + (d.analysesDeleted === 1 ? 'is' : 'es');
    case 'project_update': case 'profile_update':
      return (name ? name + ' — ' : '')
        + (Array.isArray(d.fields) ? d.fields.map(fieldPhrase).join('; ') : '');
    case 'feedback_submit':
      return [d.kind === 'feature' ? 'Feature request' : d.kind === 'bug' ? 'Bug' : '',
        d.title ? String(d.title) : ''].filter(Boolean).join(' · ');
    case 'feedback_update':
      return d.status ? 'Status → ' + String(d.status) : '';
    case 'settings_update':
      // A role change, logged against the account whose role it was.
      if (d.roleChangedTo) return 'Role changed to ' + String(d.roleChangedTo).split('_')
        .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
      return Array.isArray(d.changed) ? d.changed.map(function (c) {
        return typeof c === 'string' ? c.replace(/([a-z])([A-Z])/g, '$1 $2') : fieldPhrase(c);
      }).join('; ') : '';
    default:
      return name;
  }
}

function relTime(iso) {
  if (!iso) return '';
  var diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
  return fmtDay(iso);
}
function daysSince(iso) {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

async function load() {
  loading = true; loadError = null;
  var results = await Promise.all([
    A.api('budgets').catch(function () { return null; }),
    A.api('investment-analyses').catch(function () { return null; }),
    // Activity is a bonus, never a blocker: without it Home falls back to
    // global recency, which is still useful.
    A.api('user-activity').catch(function () { return null; }),
    // Projects, because a project can be favorited like anything else and
    // Home had no project data at all — which is exactly why starring one
    // did nothing here. Tolerant of the pre-migration {available:false}
    // shape, the same way the Projects page is.
    A.api('budgets?scope=projects').catch(function () { return null; })
  ]);
  if (results[0] === null && results[1] === null) {
    loadError = 'Could not reach the server.';
    budgets = []; analyses = [];
  } else {
    budgets = results[0] || [];
    analyses = results[1] || [];
  }
  // Home's fetch of the budget list is also index.html's: handing it back
  // saves a visit a second identical GET /api/budgets.
  if (results[0] && A.budgetsLoaded) A.budgetsLoaded(results[0]);
  events = (results[2] && results[2].events) || [];
  projects = (results[3] && results[3].projects) || [];
  projectsAvailable = !!(results[3] && results[3].available !== false && Array.isArray(results[3].projects));
  if (!adopted) { adopted = true; adoptLocalFavorites(); }
  loading = false; loaded = true;
}

/* Recent = what THIS account touched, newest first, one entry per record.
   The activity log gives the order; the two indexes give the display data.
   With no activity yet (a fresh account, or events not recorded for these
   records) it falls back to most-recently-updated, which is still sensible. */
function recentItems(limit) {
  var byBudget = {}, byAnalysis = {}, byProject = {};
  budgets.forEach(function (b) { byBudget[String(b.projectId).toUpperCase()] = b; });
  analyses.forEach(function (a) { byAnalysis[String(a.analysisId).toLowerCase()] = a; });
  projects.forEach(function (x) { byProject[String(x.projectId).toUpperCase()] = x; });

  var out = [], seen = {};
  events.forEach(function (ev) {
    if (!ev.entityId || !ev.entityType) return;
    var kind = ev.entityType === 'budget' ? 'budget'
      : ev.entityType === 'analysis' ? 'analysis'
      : ev.entityType === 'project' ? 'project' : null;
    if (!kind) return;
    var key = kind + ':' + ev.entityId;
    if (seen[key]) return;
    var rec = kind === 'budget' ? byBudget[String(ev.entityId).toUpperCase()]
      : kind === 'project' ? byProject[String(ev.entityId).toUpperCase()]
      : byAnalysis[String(ev.entityId).toLowerCase()];
    if (!rec) return;                       // deleted, or not visible to this role
    seen[key] = 1;
    out.push({ kind: kind, rec: rec, when: ev.createdAt, why: eventLabel(ev.eventType) });
  });

  if (out.length < limit) {
    // Top up from whatever is most recently updated, skipping anything the
    // activity pass already placed.
    var rest = budgets.map(function (b) { return { kind: 'budget', rec: b, when: b.updated, why: 'Updated' }; })
      .concat(analyses.map(function (a) { return { kind: 'analysis', rec: a, when: a.updatedAt || a.updated, why: 'Updated' }; }))
      .filter(function (x) {
        var id = x.kind === 'budget' ? x.rec.projectId : x.rec.analysisId;
        return !seen[x.kind + ':' + id];
      })
      .sort(function (p, q) { return new Date(q.when) - new Date(p.when); });
    out = out.concat(rest);
  }
  return out.slice(0, limit);
}

/* What needs a decision or a nudge. Deliberately a short, trustworthy list:
   a queue nobody believes is a queue nobody reads. Every rule below is
   computable from the two index payloads — see the notes at the end of this
   file for the ones that need API changes. */
var STALE_DRAFT_DAYS = 14;

function attentionItems() {
  var out = [];

  budgets.forEach(function (b) {
    if (b.status === 'In Review') {
      out.push({ kind: 'budget', rec: b, reason: 'In Review', tone: 'review',
                 note: 'Waiting on a decision' });
    }
  });
  analyses.forEach(function (a) {
    if (a.status === 'In Review') {
      out.push({ kind: 'analysis', rec: a, reason: 'In Review', tone: 'review',
                 note: 'Waiting on a decision' });
    }
  });

  // Budgets that have never been underwritten. The clearest next action in
  // the whole app, and invisible on either index page — but only for the
  // budget that stands for its project. An alternate is another way of
  // pricing the same work, so nagging about every alternate (and every
  // finished sibling) buried the one nudge that mattered. A project counts
  // as underwritten once ANY of its budgets has an analysis.
  var underwritten = {}, underwrittenProject = {};
  analyses.forEach(function (a) {
    if (a.projectId) underwritten[String(a.projectId).toUpperCase()] = 1;
    if (a.projectKey) underwrittenProject[String(a.projectKey).toUpperCase()] = 1;
  });
  var primary = primaryBudgetIds();
  budgets.forEach(function (b) {
    if (b.status === 'Cancelled') return;
    var key = b.projectKey ? String(b.projectKey).toUpperCase() : '';
    if (key && !primary[String(b.projectId).toUpperCase()]) return;
    if (key && underwrittenProject[key]) return;
    if (!underwritten[String(b.projectId).toUpperCase()]) {
      out.push({ kind: 'budget', rec: b, reason: 'No Analysis', tone: 'idea',
                 note: 'No investment analysis yet' });
    }
  });

  // Drafts that have gone quiet.
  budgets.forEach(function (b) {
    if (b.status !== 'Draft') return;
    var d = daysSince(b.updated);
    if (d >= STALE_DRAFT_DAYS) {
      out.push({ kind: 'budget', rec: b, reason: 'Idle Draft', tone: 'idle',
                 note: 'Untouched for ' + d + ' days' });
    }
  });

  // One row per record: the most pressing reason wins.
  var rank = { review: 0, idle: 1, idea: 2 };
  var best = {};
  out.forEach(function (x) {
    var id = x.kind + ':' + (x.kind === 'budget' ? x.rec.projectId : x.rec.analysisId);
    if (!best[id] || rank[x.tone] < rank[best[id].tone]) best[id] = x;
  });
  return Object.keys(best).map(function (k) { return best[k]; })
    .sort(function (p, q) { return rank[p.tone] - rank[q.tone]; });
}

/* Each project's primary budget, as the set of budget ids. The project list
   names it (primaryBudgetId); when it does not — or the primary is not one
   this account can see — the same tie-break the server applies stands in:
   shortest id, then alphabetical. Budgets with no project are not here; they
   stand for themselves. */
function primaryBudgetIds() {
  var byKey = {}, named = {}, out = {};
  projects.forEach(function (x) {
    if (x && x.projectId && x.primaryBudgetId)
      named[String(x.projectId).toUpperCase()] = String(x.primaryBudgetId).toUpperCase();
  });
  budgets.forEach(function (b) {
    if (!b.projectKey) return;
    var k = String(b.projectKey).toUpperCase();
    (byKey[k] = byKey[k] || []).push(String(b.projectId).toUpperCase());
  });
  Object.keys(byKey).forEach(function (k) {
    var ids = byKey[k];
    var hit = named[k] && ids.indexOf(named[k]) !== -1 ? named[k]
      : ids.slice().sort(function (a, z) { return a.length - z.length || (a < z ? -1 : a > z ? 1 : 0); })[0];
    out[hit] = 1;
  });
  return out;
}

/* Where "N more" in Needs Attention leads: the list that holds the rest.
   Analyses only → the analyses list; otherwise the Budgets list, filtered to
   the status the overflow shares when it shares one (In Review, or Draft for
   idle drafts), unfiltered when it is a mix. */
function attentionOverflowTarget(rest) {
  if (!rest.length) return null;
  if (rest.every(function (x) { return x.kind === 'analysis'; })) return { page: 'analyses' };
  var st = null, same = true;
  rest.forEach(function (x) {
    if (x.kind !== 'budget') { same = false; return; }
    var s = x.reason === 'In Review' ? 'In Review' : x.reason === 'Idle Draft' ? 'Draft' : null;
    if (!s || (st && s !== st)) same = false;
    st = st || s;
  });
  return { page: 'budgets', status: same && st ? st : 'all' };
}
function openAttentionList() {
  var t = attentionOverflowTarget(attentionItems().slice(ATTENTION_SHOWN));
  if (!t) return;
  if (t.page === 'analyses') { if (A.go) A.go('analyses'); return; }
  if (A.openBudgetsList) A.openBudgetsList(t.status);
}
var ATTENTION_SHOWN = 6;
var ACTIVITY_SHOWN = 5;

/* True when this account demonstrably has no project to put a budget in.
   Unknown (not loaded, offline, pre-migration) is not "none". */
function needsProject() {
  return loaded && !loadError && projectsAvailable && projects.length === 0;
}

function favoriteItems() {
  var p = favoritesRead(), out = [];
  p.budget.forEach(function (id) {
    var rec = budgets.filter(function (b) { return String(b.projectId) === id; })[0];
    if (rec) out.push({ kind: 'budget', rec: rec });
  });
  p.analysis.forEach(function (id) {
    var rec = analyses.filter(function (a) { return String(a.analysisId) === id; })[0];
    if (rec) out.push({ kind: 'analysis', rec: rec });
  });
  p.project.forEach(function (id) {
    var rec = projects.filter(function (x) { return String(x.projectId) === id; })[0];
    if (rec) out.push({ kind: 'project', rec: rec });
  });
  return out;
}

/* ================= render ================= */

/* A static chip, not the editable one: the whole card is a button, and a
   <button> inside a <button> is invalid and does not reliably receive clicks.
   Status is changed on the record itself or from either index list. */
var STATUS_CLS = { 'Draft': 'st-draft', 'In Review': 'st-review',
                   'Completed': 'st-done', 'Cancelled': 'st-cancel' };
function projectChipStatic(status) {
  var n = PROJECT_STATUS_CLS[status] ? status : 'Lead';
  return '<span class="st-chip ' + PROJECT_STATUS_CLS[n]
    + '" style="pointer-events:none">' + esc(n) + '</span>';
}
function statusChipStatic(status) {
  var n = window.normStatus ? window.normStatus(status) : (status || 'Draft');
  return '<span class="st-chip ' + (STATUS_CLS[n] || 'st-draft')
    + '" style="pointer-events:none">' + esc(n) + '</span>';
}

function recordId(kind, rec) {
  return kind === 'project' ? rec.projectId
    : kind === 'budget' ? rec.projectId : rec.analysisId;
}
/* The three indexes spell their timestamp differently; each carries one, so
   the card footer never has to invent a value. */
function recordUpdated(kind, rec) {
  return kind === 'budget' || kind === 'project' ? rec.updated : (rec.updatedAt || rec.updated);
}
var UNTITLED = { budget: 'Untitled budget', analysis: 'Untitled analysis', project: 'Untitled project' };
function recordName(kind, rec) {
  return rec.name || UNTITLED[kind] || 'Untitled';
}
/* The id rides in an escaped data-id and comes back through this.dataset —
   never inside a quoted string in the handler, where esc() is no defence (the
   HTML parser decodes &#39; back to a quote before the JS runs). Returns the
   whole attribute pair. */
function openAttr(kind, rec) {
  var fn = kind === 'project' ? 'openProject' : kind === 'budget' ? 'openBudget' : 'openAnalysis';
  return `data-id="${esc(recordId(kind, rec))}" onclick="FSHome.${fn}(this.dataset.id)"`;
}
/* A project runs the deal pipeline, not the budget statuses, so its chip has
   its own vocabulary. Sharing one map would have painted "Awarded" as a Draft. */
var PROJECT_STATUS_CLS = {
  'Lead': 'st-draft', 'Qualified': 'st-draft', 'Budgeting': 'st-review',
  'Proposal Sent': 'st-review', 'Awarded': 'st-done',
  'Converted to Project': 'st-converted', 'On Hold': 'st-hold', 'Lost': 'st-cancel'
};

/* The star sits at the top right of the card and TOGGLES. It cannot live inside
   the card: the card is a <button> and a nested <button> is invalid HTML that
   does not reliably receive clicks. So the card and the star are siblings inside
   a positioned wrapper — two real buttons, each with its own label — and the
   header row reserves space on the right so the star never lands on the id or a
   title. Filled means favorited; outline means not. */
var STAR_FILLED = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<path fill="currentColor" d="M12 17.27 6.82 20.4a1 1 0 0 1-1.49-1.08l1.38-5.89-4.57-3.96'
  + 'A1 1 0 0 1 2.7 7.72l6.02-.52 2.36-5.55a1 1 0 0 1 1.84 0l2.36 5.55 6.02.52a1 1 0 0 1 .56 1.75'
  + 'l-4.57 3.96 1.38 5.89a1 1 0 0 1-1.49 1.08L12 17.27z"/></svg>';
var STAR_OUTLINE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"'
  + ' d="M12 17.27 6.82 20.4l1.38-5.89-4.57-3.96 6.02-.52L12 4.48l2.35 5.55 6.02.52-4.57 3.96'
  + ' 1.38 5.89L12 17.27z"/></svg>';
/* The star markup, reused by Home, the budget and analysis lists, the project
   page and both editor headers — one affordance, one behaviour, everywhere. */
function starButton(kind, id, name, on) {
  return '<button class="hm-star' + (on ? ' is-on' : '') + '"'
    + ' data-kind="' + esc(kind) + '" data-id="' + esc(id) + '"'
    + ' onclick="event.stopPropagation();FSHome.toggleFavorite(this.dataset.kind,this.dataset.id)"'
    + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
    + ' aria-label="' + (on ? 'Remove ' : 'Add ') + esc(name || id) + (on ? ' from' : ' to') + ' Favorites"'
    + ' title="' + (on ? 'Remove from Favorites' : 'Add to Favorites') + '">'
    + (on ? STAR_FILLED : STAR_OUTLINE) + '</button>';
}

/* One card shape for budgets and analyses alike. The header (type, id, title)
   grows with the title; the summary block (amount, rule, status, timestamp)
   is pushed to the bottom with margin-top:auto, so a two-line title never
   drags the footer out of line with the card beside it. */
var KIND_LABEL = { budget: 'Budget', analysis: 'Analysis', project: 'Project' };
function itemCard(kind, rec, meta, favorited) {
  var id = recordId(kind, rec);
  var money = kind === 'project'
    ? usd(rec.status === 'Converted to Project' && rec.contractAmount !== null
        ? rec.contractAmount : rec.liveContractSum)
    : kind === 'budget'
      ? usd(rec.projectCost || rec.contractSum || 0)
      : (rec.purchasePrice ? usd(rec.purchasePrice) : '—');   // never calculated: no price yet, not $0
  var moneyLab = kind === 'project' ? 'Contract Sum'
    : kind === 'budget' ? 'Total Project Cost' : 'Purchase Price';
  var star = starButton(kind, id, recordName(kind, rec), favorited);
  return `<div class="hm-card-wrap${favorited ? ' is-fav' : ''}">
    <button class="hm-card" ${openAttr(kind, rec)}>
      <div class="hm-card-hd">
        <div class="hm-card-top">
          <span class="hm-kind hm-kind-${kind}">${KIND_LABEL[kind] || kind}</span>
          <span class="hm-id mono">${esc(kind === 'analysis' ? (rec.projectId || 'Standalone') : id)}</span>
        </div>
        <div class="hm-card-name">${esc(recordName(kind, rec))}</div>
      </div>
      <div class="hm-card-sum">
        <div class="hm-card-money"><span class="k">${moneyLab}</span><span class="v mono">${money}</span></div>
        <div class="hm-card-ft">${kind === 'project' ? projectChipStatic(rec.status) : statusChipStatic(rec.status)}
          <span class="hm-when">${esc(meta || '')}</span></div>
      </div>
    </button>${star}
  </div>`;
}

function section(title, body, action) {
  return `<section class="hm-sec">
    <div class="hm-sec-hd"><span class="eyebrow">${esc(title)}</span>${action || ''}</div>
    ${body}
  </section>`;
}

function render() {
  var host = document.getElementById('homeContent');
  if (!host) return;

  // The hero renders whatever happens: offline or mid-load, the greeting and
  // the two create buttons are still the point of the page. An error replaces
  // the sections below it, never the way to act.
  var g = pickGreeting();
  // With no project anywhere, a budget has nowhere to belong, so making the
  // project is the first step and gets the filled button. + New Budget stays
  // (its dialog can create the project too); it just stops leading.
  var firstProject = needsProject();
  var html = `<div class="hm-hero">
    <div>
      <h1 class="hm-greet">${esc(g.title)}</h1>
      <div class="hm-greet-sub">${esc(firstProject && g.empty ? 'Start with a project — every budget belongs to one.' : g.sub)}</div>
    </div>
    <div class="hm-actions">
      ${firstProject ? '<button class="btn btn-primary" id="homeNewProjectBtn" onclick="FSHome.newProject()">+ New Project</button>' : ''}
      <button class="btn ${firstProject ? 'btn-ghost' : 'btn-primary'}" id="newBudgetBtn" onclick="openNewBudget()">+ New Budget</button>
      <button class="btn btn-ghost" onclick="FSInvestmentUI.openProjectPicker()">+ New Investment Analysis</button>
    </div>
  </div>`;

  if (loadError) {
    host.innerHTML = html + `<div class="hm-empty">
      <div class="hm-empty-big">Could not load your work</div>
      <div>${esc(loadError)} Your budgets and analyses are safe — this is a
      connection problem, not a data one.</div></div>`;
    return;
  }
  if (!loaded) {
    host.innerHTML = html + '<div class="hm-loading">Loading your work…</div>';
    return;
  }

  // ---- favorites
  var pins = favoriteItems();
  if (pins.length) {
    html += section('Favorites',
      '<div class="hm-cards">' + pins.map(function (x) {
        // The footer keeps saying what every other card says. The star icon
        // carries "this is a favorite", so the timestamp is not spent on it.
        // A record with no timestamp gets no half-written line.
        var w = relTime(recordUpdated(x.kind, x.rec));
        return itemCard(x.kind, x.rec, w ? 'Updated · ' + w : '', true);
      }).join('') + '</div>');
  }

  // ---- needs attention
  // Above Recent: what is waiting on a decision is the reason to open Home,
  // and on a phone Recent's cards pushed it a screen and a half down.
  var att = attentionItems();
  if (att.length) {
    var rows = att.slice(0, ATTENTION_SHOWN).map(function (x) {
      var id = recordId(x.kind, x.rec);
      return `<button class="hm-att" ${openAttr(x.kind, x.rec)}>
        <span class="hm-att-tag hm-tone-${x.tone}">${esc(x.reason)}</span>
        <span class="hm-att-name">${esc(recordName(x.kind, x.rec))}</span>
        <span class="hm-att-id mono">${esc(x.kind === 'budget' ? id : (x.rec.projectId || 'Standalone'))}</span>
        <span class="hm-att-note">${esc(x.note)}</span>
      </button>`;
    }).join('');
    // The overflow is a way to the rest, not a number to read and shrug at.
    html += section('Needs Attention', '<div class="hm-atts">' + rows + '</div>',
      att.length > ATTENTION_SHOWN
        ? `<button class="hm-link hm-more" onclick="FSHome.openAttentionList()">${att.length - ATTENTION_SHOWN} more →</button>` : '');
  }

  // ---- recent
  var rec = recentItems(6);
  if (rec.length) {
    html += section('Recent', '<div class="hm-cards">' + rec.map(function (x) {
      return itemCard(x.kind, x.rec, x.why + ' · ' + relTime(x.when),
        isFavorite(x.kind, recordId(x.kind, x.rec)));
    }).join('') + '</div>');
  } else if (!budgets.length && !analyses.length) {
    html += section('Get Started', firstProject
      ? `<div class="hm-empty">
          <div class="hm-empty-big">No budgets yet</div>
          <div>A budget belongs to a project, so start by creating the project — its ID, name and
          address. Then add its first budget and underwrite it as an investment analysis.</div>
        </div>`
      : `<div class="hm-empty">
          <div class="hm-empty-big">No budgets yet</div>
          <div>Create a budget to price a project, then underwrite it as an investment analysis.
          Everything you open will show up here.</div>
        </div>`);
  }

  // ---- your activity
  // What you DID, so sign-ins are left out: they say nothing about any record
  // and crowded the real events off a short list. Short because Recent above
  // already shows the records themselves.
  var acts = events.filter(function (e) { return e && e.eventType !== 'login'; }).slice(0, ACTIVITY_SHOWN);
  if (acts.length) {
    html += section('Your Activity', '<div class="hm-log">' + acts.map(function (e) {
      // The record's NAME, with its id as the fallback: "Riverbend Phase 1"
      // is what someone is looking for, not BD-0002.
      var det = eventDetail(e);
      var what = det || (e.entityId ? String(e.entityId) : '');
      return `<div class="hm-log-row">
        <span class="hm-log-ev">${esc(eventLabel(e.eventType))}</span>
        <span class="hm-log-what${det ? '' : ' mono'}" title="${esc(e.entityId || '')}">${esc(what)}</span>
        <span class="hm-log-when">${esc(relTime(e.createdAt))}</span>
      </div>`;
    }).join('') + '</div>');
  }

  host.innerHTML = html;
}

/* Home refetches every time it is opened, and paints what it already has
   first so the page is never blank while that happens.

   Caching for the page's lifetime was wrong: hash routes are same-document
   navigations, so returning to Home after creating a budget would keep showing
   the state from before it existed — the empty "no budgets yet" screen next to
   a Budgets page listing them. A dashboard has to be current. */
async function show() {
  render();                   // instant: whatever is cached, or the loading state
  if (loading) return;        // a load is already in flight and will render itself
  await load();
  render();
}
// Content is known to be wrong (a delete): drop it so the next paint shows the
// loading state rather than a record that is gone.
function invalidate() { loaded = false; budgets = []; analyses = []; }

window.FSHome = {
  init: function (a) { A = a || {}; },
  show: show,
  render: render,
  invalidate: invalidate,
  toggleFavorite: toggleFavorite,
  unfavorite: unfavorite,
  isFavorite: isFavorite,
  starButton: starButton,
  // The static coloured chip, for cards that are themselves buttons (the
  // project page's Favorites strip borrows it).
  statusChipStatic: statusChipStatic,
  favorites: favoritesRead,
  needsProject: needsProject,
  newProject: function () { if (A.newProject) A.newProject(); },
  openAttentionList: openAttentionList,
  openBudget: function (id) { if (A.openBudget) A.openBudget(id); },
  openAnalysis: function (id) {
    if (window.FSInvestmentUI) { location.hash = '#/analysis/' + String(id).toLowerCase(); }
  },
  openProject: function (id) {
    if (window.FSProjects) FSProjects.open(String(id).toUpperCase());
  },
  // exposed for the suites
  _attention: function () { return attentionItems(); },
  _overflowTarget: function () { return attentionOverflowTarget(attentionItems().slice(ATTENTION_SHOWN)); },
  _recent: function (n) { return recentItems(n || 6); },
  _favorites: function () { return favoritesRead(); },
  _greetingPools: GREET
};
})();

/* ============================================================
   WHAT THE NEXT PASS NEEDS (API / SQL), and why it is not here
   ============================================================
   1. ~~Pins per account, not per browser.~~ Done, and since renamed: the
      setting is `favorites` (budgets, analyses and projects), the icon is a
      star, and it toggles everywhere rather than only un-pinning from Home.
      The contract lifts a stored `pinned` document, so nothing was lost.

   2. "Running on old pricing" in Needs Attention.
      /api/budgets does not return PricingVersion, so the client cannot tell
      which budgets are behind without fetching every budget. Adding the column
      to the SELECT in api/budgets/index.js is a one-line change and no
      migration — the column already exists on dbo.Budgets.

   3. "Analysis is behind its budget" in Needs Attention.
      Needs the budget's current version number next to the analysis's
      SourceBudgetVersionNumber. Both live in SQL already
      (dbo.BudgetVersions.VersionNumber); the listing query would need a
      correlated MAX per project. No migration.

   4. Activity older than the last 50 events.
      /api/user-activity is TOP 50 with no paging. Home only shows 5, so this
      matters solely if the section grows a "view all" — the analytics endpoint
      already has the paged version to copy.
   ============================================================ */
