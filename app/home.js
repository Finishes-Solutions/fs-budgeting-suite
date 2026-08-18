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
// PINS ARE BROWSER-LOCAL, ON PURPOSE FOR NOW. The settings document is a
// strict whitelist (api/shared/user-settings-contract.js) that silently drops
// unknown keys, so storing pins per account needs one entry added there — an
// API change that was explicitly out of scope for this pass. Until then pins
// live in localStorage under the signed-in user id, so two people sharing a
// machine do not see each other's. Moving them to the account later is a
// straight swap of pinsRead/pinsWrite; nothing else here changes.
(function () {
'use strict';

var A = {};                  // adapter, supplied by index.html
var budgets = [];
var analyses = [];
var events = [];
var loaded = false;
var loading = false;
var loadError = null;
var greeting = null;         // picked once per page load so repaints do not reshuffle

function esc(s) { return A.esc ? A.esc(String(s)) : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function usd(n) { return A.usd ? A.usd(n) : '$' + Math.round(n || 0).toLocaleString('en-US'); }
function fmtDay(d) { return A.fmtDay ? A.fmtDay(d) : String(d || '').slice(0, 10); }

/* ================= pins ================= */

function pinKey() {
  var uid = (A.userId && A.userId()) || 'anon';
  return 'fs-home-pins-v1:' + uid;
}
function pinsRead() {
  try {
    var raw = localStorage.getItem(pinKey());
    var v = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return { budget: [], analysis: [] };
    return {
      budget: Array.isArray(v.budget) ? v.budget.filter(function (x) { return typeof x === 'string'; }).slice(0, 50) : [],
      analysis: Array.isArray(v.analysis) ? v.analysis.filter(function (x) { return typeof x === 'string'; }).slice(0, 50) : []
    };
  } catch (e) { return { budget: [], analysis: [] }; }
}
function pinsWrite(p) {
  try { localStorage.setItem(pinKey(), JSON.stringify(p)); } catch (e) { /* private mode: pins just do not persist */ }
}
function isPinned(kind, id) {
  var p = pinsRead();
  return (p[kind] || []).indexOf(String(id)) !== -1;
}
// Returns the new state so the caller can word its own toast.
function togglePin(kind, id) {
  if (kind !== 'budget' && kind !== 'analysis') return false;
  id = String(id);
  var p = pinsRead();
  var list = p[kind] || (p[kind] = []);
  var i = list.indexOf(id);
  if (i === -1) list.unshift(id); else list.splice(i, 1);
  pinsWrite(p);
  if (A.currentPage && A.currentPage() === 'home') render();
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
  if (greeting) return greeting;
  // The adapter hands over an already-humanised name ("Matthew Sinitiere"),
  // so the first word is the first name.
  var who = (A.displayName && A.displayName()) || '';
  var firstName = String(who).trim().split(/\s+/)[0] || '';
  if (firstName.length > 20) firstName = '';        // not a name, do not use it

  var pool;
  if (!budgets.length && !analyses.length) {
    pool = GREET.empty;
    firstName = '';                                  // a first run should not feel over-familiar
  } else {
    // Half the time greet by time of day, half the time as a returning user,
    // so the same person sees variety across a day.
    var tod = GREET[timeBucket(new Date().getHours())];
    pool = Math.random() < 0.5 ? tod : GREET.returning;
  }
  var pick = pool[Math.floor(Math.random() * pool.length)];
  greeting = { title: pick[0] + (firstName ? ', ' + firstName : ''), sub: pick[1] };
  return greeting;
}

/* ================= data ================= */

var EVENT_LABEL = {
  login: 'Signed in', budget_save: 'Saved budget', budget_delete: 'Deleted budget',
  budget_restore: 'Restored budget', analysis_save: 'Saved analysis',
  analysis_delete: 'Deleted analysis', analysis_restore: 'Restored analysis',
  export_pdf: 'Exported PDF', export_xlsx: 'Exported Excel', export_csv: 'Exported CSV',
  export_print: 'Printed', settings_update: 'Updated settings', pricing_publish: 'Published pricing'
};
function eventLabel(e) { return EVENT_LABEL[e] || e; }

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
    A.api('user-activity').catch(function () { return null; })
  ]);
  if (results[0] === null && results[1] === null) {
    loadError = 'Could not reach the server.';
    budgets = []; analyses = [];
  } else {
    budgets = results[0] || [];
    analyses = results[1] || [];
  }
  events = (results[2] && results[2].events) || [];
  loading = false; loaded = true;
}

/* Recent = what THIS account touched, newest first, one entry per record.
   The activity log gives the order; the two indexes give the display data.
   With no activity yet (a fresh account, or events not recorded for these
   records) it falls back to most-recently-updated, which is still sensible. */
function recentItems(limit) {
  var byBudget = {}, byAnalysis = {};
  budgets.forEach(function (b) { byBudget[String(b.projectId).toUpperCase()] = b; });
  analyses.forEach(function (a) { byAnalysis[String(a.analysisId).toLowerCase()] = a; });

  var out = [], seen = {};
  events.forEach(function (ev) {
    if (!ev.entityId || !ev.entityType) return;
    var kind = ev.entityType === 'budget' ? 'budget' : ev.entityType === 'analysis' ? 'analysis' : null;
    if (!kind) return;
    var key = kind + ':' + ev.entityId;
    if (seen[key]) return;
    var rec = kind === 'budget'
      ? byBudget[String(ev.entityId).toUpperCase()]
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
  // the whole app, and invisible on either index page.
  var underwritten = {};
  analyses.forEach(function (a) { if (a.projectId) underwritten[String(a.projectId).toUpperCase()] = 1; });
  budgets.forEach(function (b) {
    if (b.status === 'Cancelled') return;
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

function pinnedItems() {
  var p = pinsRead(), out = [];
  p.budget.forEach(function (id) {
    var rec = budgets.filter(function (b) { return String(b.projectId) === id; })[0];
    if (rec) out.push({ kind: 'budget', rec: rec });
  });
  p.analysis.forEach(function (id) {
    var rec = analyses.filter(function (a) { return String(a.analysisId) === id; })[0];
    if (rec) out.push({ kind: 'analysis', rec: rec });
  });
  return out;
}

/* ================= render ================= */

/* A static chip, not the editable one: the whole card is a button, and a
   <button> inside a <button> is invalid and does not reliably receive clicks.
   Status is changed on the record itself or from either index list. */
var STATUS_CLS = { 'Draft': 'st-draft', 'In Review': 'st-review',
                   'Completed': 'st-done', 'Cancelled': 'st-cancel' };
function statusChipStatic(status) {
  var n = window.normStatus ? window.normStatus(status) : (status || 'Draft');
  return '<span class="st-chip ' + (STATUS_CLS[n] || 'st-draft')
    + '" style="pointer-events:none">' + esc(n) + '</span>';
}

function recordId(kind, rec) { return kind === 'budget' ? rec.projectId : rec.analysisId; }
function recordName(kind, rec) {
  var n = rec.name || '';
  return n || (kind === 'budget' ? 'Untitled budget' : 'Untitled analysis');
}
function openAttr(kind, rec) {
  var id = String(recordId(kind, rec)).replace(/'/g, '');
  return kind === 'budget' ? `FSHome.openBudget('${esc(id)}')` : `FSHome.openAnalysis('${esc(id)}')`;
}

function itemCard(kind, rec, meta) {
  var id = recordId(kind, rec);
  var money = kind === 'budget'
    ? usd(rec.projectCost || rec.contractSum || 0)
    : usd(rec.purchasePrice || 0);
  var moneyLab = kind === 'budget' ? 'Total Project' : 'Purchase Price';
  return `<button class="hm-card" onclick="${openAttr(kind, rec)}">
    <div class="hm-card-top">
      <span class="hm-kind hm-kind-${kind}">${kind === 'budget' ? 'Budget' : 'Analysis'}</span>
      <span class="hm-id mono">${esc(kind === 'budget' ? id : (rec.projectId || 'Standalone'))}</span>
    </div>
    <div class="hm-card-name">${esc(recordName(kind, rec))}</div>
    <div class="hm-card-money"><span>${moneyLab}</span><span class="v mono">${money}</span></div>
    <div class="hm-card-ft">${statusChipStatic(rec.status)}
      <span class="hm-when">${esc(meta || '')}</span></div>
  </button>`;
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
  var html = `<div class="hm-hero">
    <div>
      <h1 class="hm-greet">${esc(g.title)}</h1>
      <div class="hm-greet-sub">${esc(g.sub)}</div>
    </div>
    <div class="hm-actions">
      <button class="btn btn-primary" id="newBudgetBtn" onclick="openNewBudget()">+ New Budget</button>
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

  // ---- pinned
  var pins = pinnedItems();
  if (pins.length) {
    html += section('Pinned',
      '<div class="hm-cards">' + pins.map(function (x) {
        return itemCard(x.kind, x.rec, 'Pinned');
      }).join('') + '</div>');
  }

  // ---- needs attention
  var att = attentionItems();
  if (att.length) {
    var rows = att.slice(0, 6).map(function (x) {
      var id = recordId(x.kind, x.rec);
      return `<button class="hm-att" onclick="${openAttr(x.kind, x.rec)}">
        <span class="hm-att-tag hm-tone-${x.tone}">${esc(x.reason)}</span>
        <span class="hm-att-name">${esc(recordName(x.kind, x.rec))}</span>
        <span class="hm-att-id mono">${esc(x.kind === 'budget' ? id : (x.rec.projectId || 'Standalone'))}</span>
        <span class="hm-att-note">${esc(x.note)}</span>
      </button>`;
    }).join('');
    html += section('Needs Attention', '<div class="hm-atts">' + rows + '</div>',
      att.length > 6 ? `<span class="hm-more">${att.length - 6} more</span>` : '');
  }

  // ---- recent
  var rec = recentItems(6);
  if (rec.length) {
    html += section('Recent', '<div class="hm-cards">' + rec.map(function (x) {
      return itemCard(x.kind, x.rec, x.why + ' · ' + relTime(x.when));
    }).join('') + '</div>');
  } else if (!budgets.length && !analyses.length) {
    html += section('Get Started',
      `<div class="hm-empty">
        <div class="hm-empty-big">No budgets yet</div>
        <div>Create a budget to price a project, then underwrite it as an investment analysis.
        Everything you open will show up here.</div>
      </div>`);
  }

  // ---- your activity
  var acts = events.slice(0, 8);
  if (acts.length) {
    html += section('Your Activity', '<div class="hm-log">' + acts.map(function (e) {
      var what = e.entityId ? esc(String(e.entityId)) : '';
      return `<div class="hm-log-row">
        <span class="hm-log-ev">${esc(eventLabel(e.eventType))}</span>
        <span class="hm-log-what mono">${what}</span>
        <span class="hm-log-when">${esc(relTime(e.createdAt))}</span>
      </div>`;
    }).join('') + '</div>',
    '<button class="hm-link" onclick="go(\'budgets\')">All Budgets</button>');
  }

  host.innerHTML = html;
}

async function show() {
  if (!loaded && !loading) {
    render();                 // paint the loading state first
    await load();
  }
  render();
}
// A save or delete elsewhere should be reflected next time Home is opened.
function invalidate() { loaded = false; }

window.FSHome = {
  init: function (a) { A = a || {}; },
  show: show,
  render: render,
  invalidate: invalidate,
  togglePin: togglePin,
  isPinned: isPinned,
  openBudget: function (id) { if (A.openBudget) A.openBudget(id); },
  openAnalysis: function (id) {
    if (window.FSInvestmentUI) { location.hash = '#/analysis/' + String(id).toLowerCase(); }
  },
  // exposed for the suites
  _attention: function () { return attentionItems(); },
  _recent: function (n) { return recentItems(n || 6); },
  _greetingPools: GREET
};
})();

/* ============================================================
   WHAT THE NEXT PASS NEEDS (API / SQL), and why it is not here
   ============================================================
   1. Pins per account, not per browser.
      One entry in api/shared/user-settings-contract.js (a `pinned` key,
      sanitized as two short string arrays) and pinsRead/pinsWrite swap to the
      settings document. No SQL: SettingsDoc is already an arbitrary JSON blob,
      which is exactly why it was built that way.

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
      /api/user-activity is TOP 50 with no paging. Home only shows 8, so this
      matters solely if the section grows a "view all" — the analytics endpoint
      already has the paged version to copy.
   ============================================================ */
