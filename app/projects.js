/* Projects — the parent view. One project per ID, and everything that belongs
   to it hangs off this page: its budgets (a base plus any alternates), its
   investment analyses, and the favorites you have starred within it.

   External no-build IIFE behind window.FSProjects, initialised from
   index.html with an adapter, exactly like home.js and dashboard.js. There is
   no build step here — a syntax error ships as a broken page, so run
   `node --check app/projects.js` before committing.

   The data comes from query scopes on endpoints that already deploy
   (/api/budgets?scope=projects and ?scope=project&id=…), because a NEW
   api/<name>/ folder is not reliably picked up by the deployed host. See
   api/shared/projects.js for that history and for the security consequence:
   a route rule cannot see a query string, so the in-function check is the
   real gate.

   A project is UNAVAILABLE until sql/migrate_projects_and_guardrails.sql has
   run. That is not an error state — the page says so plainly and every other
   page keeps working, because a deploy lands before its migration. */
(function () {
'use strict';

var A = {};                 // adapter, supplied by index.html
var list = null;            // { available, statuses, projects[] }
var detail = null;          // { available, project, budgets[], analyses[] }
var loading = false;
var error = null;
var openId = null;

function esc(s) { return A.esc ? A.esc(String(s)) : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function usd(n) { return A.usd ? A.usd(n) : '$' + Math.round(n || 0).toLocaleString('en-US'); }
function num(n) { return Number(n || 0).toLocaleString('en-US'); }
function el(id) { return document.getElementById(id); }

/* The deal pipeline. Kept in step with PROJECT_STATUSES in
   api/shared/projects.js — the server rejects anything else, so the two lists
   change together. Converted to Project is the one the analytics dashboard
   counts, and reaching it snapshots the money. */
var PROJECT_STATUSES = ['Lead', 'Qualified', 'Budgeting', 'Proposal Sent', 'Awarded',
                        'Converted to Project', 'On Hold', 'Lost'];
var STATUS_CLS = {
  'Lead': 'st-draft', 'Qualified': 'st-draft', 'Budgeting': 'st-review',
  'Proposal Sent': 'st-review', 'Awarded': 'st-done',
  'Converted to Project': 'st-converted', 'On Hold': 'st-hold', 'Lost': 'st-cancel'
};

function isFav(kind, id) { return !!(window.FSHome && FSHome.isFavorite(kind, id)); }
function star(kind, id, name) {
  return window.FSHome ? FSHome.starButton(kind, id, name, isFav(kind, id)) : '';
}

/* ================= data ================= */

async function loadList(force) {
  if (list && !force) return;
  loading = true; error = null;
  try { list = await A.api('budgets?scope=projects'); }
  catch (e) { error = e.message; list = null; }
  loading = false;
}

async function loadDetail(id, force) {
  if (detail && detail.project && detail.project.projectId === id && !force) return;
  loading = true; error = null; detail = null;
  try { detail = await A.api('budgets?scope=project&id=' + encodeURIComponent(id)); }
  catch (e) { error = e.message; }
  loading = false;
}

function invalidate() { list = null; detail = null; }

/* ================= index ================= */

async function render(force) {
  var host = el('projectsBody');
  if (!host) return;
  host.innerHTML = '<div class="dash-loading">Loading projects…</div>';
  await loadList(force);
  if (error) { host.innerHTML = errorCard(error); return; }
  if (!list || !list.available) { host.innerHTML = notMigratedCard(); return; }

  var ps = list.projects || [];
  if (!ps.length) {
    host.innerHTML = '<div class="card"><div class="card-bd"><div class="hm-empty">'
      + '<b>No projects yet.</b><br>A project appears here the first time a budget is saved against its ID. '
      + 'Every budget belongs to exactly one project.</div></div></div>';
    return;
  }

  // Converted projects first — they are the real work — then the rest by
  // recency. The counts row above says what the dashboard says, so the two
  // never disagree in front of someone.
  var converted = ps.filter(function (p) { return p.status === 'Converted to Project'; });
  var contract = converted.reduce(function (s, p) { return s + (p.contractAmount || 0); }, 0);
  var project = converted.reduce(function (s, p) { return s + (p.projectAmount || 0); }, 0);

  host.innerHTML =
    '<div class="grid g4" style="margin-bottom:16px">'
    + tile('Projects', num(ps.length), ps.length - converted.length + ' still in pipeline')
    + tile('Converted to Project', num(converted.length),
        ps.length ? Math.round(100 * converted.length / ps.length) + '% of all projects' : '—')
    + tile('Converted Contract Amount', usd(contract), 'Snapshot taken at conversion')
    + tile('Converted Project Amount', usd(project), 'Snapshot taken at conversion')
    + '</div>'
    + '<div class="card"><div class="card-hd"><h2>All Projects</h2>'
    + '<span class="eyebrow">' + num(ps.length) + ' project' + (ps.length === 1 ? '' : 's') + '</span></div>'
    + '<div class="card-bd" style="overflow-x:auto">'
    + '<table class="tbl pj-tbl"><thead><tr>'
    + '<th style="width:34px"></th><th>Project</th><th>Status</th>'
    + '<th class="r">Contract</th><th class="r">Total Project</th>'
    + '<th class="r">Budgets</th><th class="r">Analyses</th><th></th></tr></thead><tbody>'
    + ps.map(rowFor).join('')
    + '</tbody></table></div></div>';
}

function rowFor(p) {
  // A converted project reports its SNAPSHOT; everything else reports the live
  // primary budget. Mixing the two in one column without saying which is which
  // is how a dashboard starts lying, so the cell says.
  var conv = p.status === 'Converted to Project';
  var contract = conv && p.contractAmount !== null ? p.contractAmount : p.liveContractSum;
  var total = conv && p.projectAmount !== null ? p.projectAmount : p.liveProjectCost;
  return '<tr class="pj-row" onclick="FSProjects.open(\'' + esc(p.projectId) + '\')">'
    + '<td onclick="event.stopPropagation()">' + star('project', p.projectId, p.name || p.projectId) + '</td>'
    + '<td><div class="pj-id mono">' + esc(p.projectId)
      + (p.breachCount ? ' <span class="badge bad" title="' + p.breachCount + ' budget(s) outside a guard rail">'
          + p.breachCount + '</span>' : '') + '</div>'
      + '<div class="pj-name">' + esc(p.name || 'Untitled') + '</div>'
      + (p.address ? '<div class="pj-addr">' + esc(p.address) + '</div>' : '') + '</td>'
    + '<td>' + statusChip(p) + '</td>'
    + '<td class="r mono">' + usd(contract) + (conv ? '' : '<div class="pj-live">live</div>') + '</td>'
    + '<td class="r mono">' + usd(total) + '</td>'
    + '<td class="r mono">' + num(p.budgetCount) + '</td>'
    + '<td class="r mono">' + num(p.analysisCount) + '</td>'
    + '<td class="r"><span class="pj-go">Open →</span></td></tr>';
}

function tile(k, v, sub) {
  return '<div class="dash-kpi"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div>'
    + '<div class="sub">' + esc(sub) + '</div></div>';
}

function statusChip(p) {
  var s = PROJECT_STATUSES.indexOf(p.status) === -1 ? 'Lead' : p.status;
  return '<button class="st-chip ' + (STATUS_CLS[s] || 'st-draft') + '"'
    + ' onclick="event.stopPropagation();FSProjects.openStatusMenu(this,\'' + esc(p.projectId) + '\')"'
    + ' title="Change project status" aria-haspopup="menu">' + esc(s) + '</button>';
}

/* ================= detail ================= */

async function open(id) {
  openId = String(id || '').toUpperCase();
  if (A.navigate) A.navigate('#/project/' + openId);
  await show(openId, true);
}

async function show(id, force) {
  openId = String(id || '').toUpperCase();
  var host = el('projectBody');
  if (!host) return;
  host.innerHTML = '<div class="dash-loading">Loading project…</div>';
  if (A.go) A.go('project');
  await loadDetail(openId, force);
  paintDetail();
}

function paintDetail() {
  var host = el('projectBody');
  if (!host) return;
  if (error) { host.innerHTML = errorCard(error); return; }
  if (!detail || !detail.available) { host.innerHTML = notMigratedCard(); return; }
  if (!detail.project) {
    host.innerHTML = '<div class="card"><div class="card-bd"><div class="hm-empty">'
      + '<b>No project with that ID.</b><br>Projects are created the first time a budget is saved against an ID.'
      + '</div></div></div>';
    return;
  }
  var p = detail.project, budgets = detail.budgets || [], analyses = detail.analyses || [];
  var conv = p.status === 'Converted to Project';

  // The favorites strip is the point of the page: on a project you see the
  // budget and the analysis you starred, not everything that exists.
  var favB = budgets.filter(function (b) { return isFav('budget', b.projectId); });
  var favA = analyses.filter(function (a) { return isFav('analysis', a.analysisId); });

  el('projectTitle').textContent = p.projectId + ' — ' + (p.name || 'Untitled');
  el('projectSub').innerHTML = [p.address ? esc(p.address) : '', esc(p.type),
    num(budgets.length) + ' budget' + (budgets.length === 1 ? '' : 's'),
    num(analyses.length) + ' analys' + (analyses.length === 1 ? 'is' : 'es')]
    .filter(Boolean).join(' · ');
  el('projectStar').innerHTML = star('project', p.projectId, p.name || p.projectId);
  el('projectStatusHost').innerHTML = statusChip(p);

  host.innerHTML =
    '<div class="grid g4" style="margin-bottom:16px">'
    + tile(conv ? 'Contract Amount' : 'Contract Sum',
        usd(conv && p.contractAmount !== null ? p.contractAmount : p.liveContractSum),
        conv ? 'Snapshot at conversion' : 'Live, from the primary budget')
    + tile(conv ? 'Project Amount' : 'Total Project Cost',
        usd(conv && p.projectAmount !== null ? p.projectAmount : p.liveProjectCost),
        conv ? 'Snapshot at conversion' : 'Live, from the primary budget')
    + tile('Budgets', num(budgets.length),
        p.breachCount ? p.breachCount + ' outside a guard rail' : 'All within guard rails')
    + tile('Investment Analyses', num(analyses.length),
        analyses.length ? 'Linked to this project' : 'None yet')
    + '</div>'
    + (conv ? '<div class="gr-alert" style="border:1px solid var(--green-200);background:var(--green-50);color:var(--green-800)">'
        + '<b>Converted to a project</b> on ' + esc(A.fmtDay ? A.fmtDay(p.convertedAt) : String(p.convertedAt || '').slice(0, 10))
        + '. The contract and project amounts above were captured at that moment and no longer move with the budget.'
        + '</div>' : '')
    + (favB.length || favA.length ? favoritesCard(favB, favA) : '')
    + budgetsCard(p, budgets)
    + analysesCard(analyses);
}

function favoritesCard(favB, favA) {
  return '<div class="card"><div class="card-hd"><h2>Favorites</h2>'
    + '<span class="eyebrow">What you starred on this project</span></div>'
    + '<div class="card-bd"><div class="hm-cards">'
    + favB.map(function (b) { return miniCard('budget', b.projectId, b.name, usd(b.projectCost), 'Total Project', b.status); }).join('')
    + favA.map(function (a) { return miniCard('analysis', a.analysisId, a.name, usd(a.purchasePrice), 'Purchase Price', a.status); }).join('')
    + '</div></div></div>';
}

function miniCard(kind, id, name, money, moneyLab, status) {
  var openAttr = kind === 'budget'
    ? 'FSProjects.openBudget(\'' + esc(String(id).replace(/'/g, '')) + '\')'
    : 'FSProjects.openAnalysis(\'' + esc(String(id).replace(/'/g, '')) + '\')';
  return '<div class="hm-card-wrap is-fav">'
    + '<button class="hm-card" onclick="' + openAttr + '">'
    + '<div class="hm-card-hd"><div class="hm-card-top">'
    + '<span class="hm-kind hm-kind-' + kind + '">' + (kind === 'budget' ? 'Budget' : 'Analysis') + '</span>'
    + '<span class="hm-id mono">' + esc(kind === 'budget' ? id : '') + '</span></div>'
    + '<div class="hm-card-name">' + esc(name || 'Untitled') + '</div></div>'
    + '<div class="hm-card-sum"><div class="hm-card-money"><span class="k">' + esc(moneyLab) + '</span>'
    + '<span class="v mono">' + money + '</span></div>'
    + '<div class="hm-card-ft"><span class="badge">' + esc(status || 'Draft') + '</span></div></div>'
    + '</button>' + star(kind, id, name) + '</div>';
}

function budgetsCard(p, budgets) {
  return '<div class="card"><div class="card-hd"><h2>Budgets</h2>'
    + '<div style="display:flex;gap:10px;align-items:center">'
    + '<span class="eyebrow">The base budget and its alternates</span>'
    + '<button class="btn btn-ghost btn-sm no-print" onclick="FSProjects.addAlternate()">+ Add Alternate Budget</button>'
    + '</div></div>'
    + '<div class="card-bd" style="overflow-x:auto">'
    + (budgets.length
      ? '<table class="tbl pj-tbl"><thead><tr><th style="width:34px"></th><th>Budget</th><th>Status</th>'
        + '<th>Guard Rails</th><th class="r">Contract</th><th class="r">Total Project</th><th></th></tr></thead><tbody>'
        + budgets.map(function (b) {
          return '<tr class="pj-row" onclick="FSProjects.openBudget(\'' + esc(b.projectId) + '\')">'
            + '<td onclick="event.stopPropagation()">' + star('budget', b.projectId, b.name) + '</td>'
            + '<td><div class="pj-id mono">' + esc(b.projectId)
              + (b.isPrimary ? ' <span class="badge ok">Primary</span>'
                 : b.isAlternate ? ' <span class="badge">Alternate</span>' : '') + '</div>'
              + '<div class="pj-name">' + esc(b.name || 'Untitled') + '</div></td>'
            + '<td><span class="badge">' + esc(b.status || 'Draft') + '</span></td>'
            + '<td>' + guardrailCell(b) + '</td>'
            + '<td class="r mono">' + usd(b.contractSum) + '</td>'
            + '<td class="r mono">' + usd(b.projectCost) + '</td>'
            + '<td class="r"><span class="pj-go">Open →</span></td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="hm-empty">No budgets on this project yet.</div>')
    + '</div></div>';
}

/* A budget saved before the guard-rail columns existed reports nothing rather
   than reporting "clear" — an unknown is not a pass. */
function guardrailCell(b) {
  if (!b.guardrailStatus) return '<span class="mut" style="font-size:12px">Not evaluated</span>';
  if (b.guardrailStatus === 'breach') return '<span class="badge bad">' + num(b.guardrailBreachCount) + ' blocking</span>';
  if (b.guardrailStatus === 'warn') return '<span class="badge warn">' + num(b.guardrailBreachCount) + ' to review</span>';
  return '<span class="badge ok">Clear</span>';
}

function analysesCard(analyses) {
  return '<div class="card"><div class="card-hd"><h2>Investment Analyses</h2>'
    + '<span class="eyebrow">Underwriting built from this project’s budgets</span></div>'
    + '<div class="card-bd" style="overflow-x:auto">'
    + (analyses.length
      ? '<table class="tbl pj-tbl"><thead><tr><th style="width:34px"></th><th>Analysis</th><th>From Budget</th>'
        + '<th>Status</th><th class="r">Purchase Price</th><th class="r">Year-1 NOI</th><th></th></tr></thead><tbody>'
        + analyses.map(function (a) {
          return '<tr class="pj-row" onclick="FSProjects.openAnalysis(\'' + esc(a.analysisId) + '\')">'
            + '<td onclick="event.stopPropagation()">' + star('analysis', a.analysisId, a.name) + '</td>'
            + '<td><div class="pj-name">' + esc(a.name || 'Untitled') + '</div></td>'
            + '<td class="mono" style="font-size:12px">' + esc(a.projectId || 'Standalone')
              + (a.sourceBudgetVersionNumber ? ' <span class="inv-vsub">v' + esc(a.sourceBudgetVersionNumber) + '</span>' : '') + '</td>'
            + '<td><span class="badge">' + esc(a.status || 'Draft') + '</span></td>'
            + '<td class="r mono">' + usd(a.purchasePrice) + '</td>'
            + '<td class="r mono">' + usd(a.year1NOI) + '</td>'
            + '<td class="r"><span class="pj-go">Open →</span></td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="hm-empty">No investment analyses on this project yet.</div>')
    + '</div></div>';
}

function errorCard(msg) {
  return '<div class="card"><div class="card-bd"><div class="hm-empty">'
    + '<b>Could not load projects.</b><br>' + esc(msg) + '</div></div></div>';
}
function notMigratedCard() {
  return '<div class="card"><div class="card-bd"><div class="hm-empty">'
    + '<b>Projects are not switched on yet.</b><br>'
    + 'They arrive when <span class="mono">sql/migrate_projects_and_guardrails.sql</span> has been run '
    + 'against the database. Everything else in the suite works exactly as before until then.'
    + '</div></div></div>';
}

/* ================= status ================= */

var stTrigger = null;
function statusMenuEl() {
  var m = el('pjStMenu');
  if (!m) {
    m = document.createElement('div');
    m.id = 'pjStMenu'; m.className = 'st-menu'; m.setAttribute('role', 'menu');
    document.body.appendChild(m);
    document.addEventListener('click', function (e) {
      if (!m.contains(e.target) && e.target !== stTrigger) closeStatusMenu();
    });
  }
  return m;
}
function openStatusMenu(btn, projectId) {
  var was = stTrigger === btn;
  closeStatusMenu();
  if (was) return;
  var m = statusMenuEl();
  m.innerHTML = PROJECT_STATUSES.map(function (s) {
    return '<button role="menuitem" data-st="' + esc(s) + '">'
      + '<span class="st-chip ' + (STATUS_CLS[s] || 'st-draft') + '">' + esc(s) + '</span></button>';
  }).join('');
  m.querySelectorAll('[data-st]').forEach(function (x) {
    x.onclick = function () { var s = x.dataset.st; closeStatusMenu(); setStatus(projectId, s); };
  });
  var r = btn.getBoundingClientRect();
  m.style.display = 'block';
  m.style.top = Math.min(r.bottom + 4, window.innerHeight - 300) + 'px';
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
  stTrigger = btn;
}
function closeStatusMenu() {
  var m = el('pjStMenu');
  if (m) m.style.display = 'none';
  stTrigger = null;
}

/* Converting is the one status change that captures money, so it asks first —
   and says exactly what it is about to freeze. */
async function setStatus(projectId, status) {
  var converting = status === 'Converted to Project';
  if (converting && !confirm('Convert ' + projectId + ' to a project?\n\n'
      + 'The contract and total project amounts from its primary budget are captured now, and stop '
      + 'moving when the budget is edited. They are what the analytics dashboard reports.')) return;
  try {
    var r = await A.api('budget/' + encodeURIComponent(projectId) + '?scope=project',
      { method: 'PUT', body: JSON.stringify({ status: status }) });
    if (list && list.projects) {
      list.projects = list.projects.map(function (p) { return p.projectId === projectId ? r.project : p; });
    }
    if (detail && detail.project && detail.project.projectId === projectId) detail.project = r.project;
    if (A.toast) A.toast(r.converted
      ? projectId + ' converted — ' + usd(r.project.contractAmount) + ' contract captured.'
      : projectId + ' is now ' + status + '.');
    if (A.currentPage && A.currentPage() === 'project') paintDetail();
    else render(false);
    if (A.dashboardInvalidate) A.dashboardInvalidate();
  } catch (e) {
    if (A.toast) A.toast('Could not change the status — ' + e.message);
  }
}

/* An alternate is the same budget priced a different way, so it starts as a
   copy rather than a blank sheet. The next free -NN suffix under this project;
   the ids the widened ID_RX allows are -02 … -99. */
function addAlternate() {
  if (!detail || !detail.project) return;
  var base = detail.project.projectId;
  var taken = {};
  (detail.budgets || []).forEach(function (b) { taken[b.projectId] = 1; });
  var next = null;
  for (var i = 2; i <= 99; i++) {
    var cand = base + '-' + (i < 10 ? '0' + i : String(i));
    if (!taken[cand]) { next = cand; break; }
  }
  if (!next) { if (A.toast) A.toast('This project already has 98 alternate budgets.'); return; }
  var from = (detail.budgets || [])[0];
  if (!from) { if (A.toast) A.toast('Create the base budget first — an alternate is a copy of one.'); return; }
  if (A.duplicateBudget) A.duplicateBudget(from.projectId, next);
}

window.FSProjects = {
  init: function (a) { A = a || {}; },
  render: render,
  show: show,
  open: open,
  invalidate: invalidate,
  openStatusMenu: openStatusMenu,
  addAlternate: addAlternate,
  currentId: function () { return openId; },
  openBudget: function (id) { if (A.openBudget) A.openBudget(id); },
  openAnalysis: function (id) { location.hash = '#/analysis/' + String(id).toLowerCase(); },
  PROJECT_STATUSES: PROJECT_STATUSES,
  // exposed for the suites
  _list: function () { return list; },
  _detail: function () { return detail; }
};
})();
