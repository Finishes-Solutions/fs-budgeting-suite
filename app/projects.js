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
    // The old copy said a project appears the first time a budget is saved
    // against its ID. It does not any more: a budget id cannot name a project,
    // so the first move is Create Project.
    host.innerHTML = '<div class="card"><div class="card-bd"><div class="hm-empty">'
      + '<b>No projects yet.</b><br>Create one with <b>+ Create Project</b> above. '
      + 'A project is the parent: its budgets and investment analyses hang off it, '
      + 'and every budget belongs to exactly one.</div></div></div>';
    return;
  }

  // Converted projects first — they are the real work — then the rest by
  // recency. The counts row above says what the dashboard says, so the two
  // never disagree in front of someone.
  var converted = ps.filter(function (p) { return p.status === 'Converted to Project'; });
  var contract = converted.reduce(function (s, p) { return s + (p.contractAmount || 0); }, 0);
  var project = converted.reduce(function (s, p) { return s + (p.projectAmount || 0); }, 0);

  var view = projectView();
  host.innerHTML =
    '<div class="pj-stats">'
    + statCard('Projects', num(ps.length), '')
    + statCard('Converted to Project', num(converted.length),
        ps.length ? Math.round(100 * converted.length / ps.length) + '% of all projects' : '—')
    + statCard('Converted Contract Amount', usd(contract), '')
    + statCard('Converted Project Amount', usd(project), '')
    + '</div>'
    + '<div class="card"><div class="card-hd"><h2>All Projects</h2>'
    + '<div class="pj-hd-r">' + viewSeg(view)
    + '<span class="eyebrow">' + num(ps.length) + ' project' + (ps.length === 1 ? '' : 's') + '</span>'
    + '</div></div>'
    + (view === 'cards'
      ? '<div class="card-bd"><div class="hm-cards on">' + ps.map(cardFor).join('') + '</div></div>'
      : '<div class="card-bd" style="overflow-x:auto" data-density="'
        + (view === 'compact' ? 'compact' : 'comfortable') + '">'
        + '<table class="tbl pj-tbl pj-tbl-index"><thead><tr>'
        + '<th style="width:34px"></th><th>Project ID</th><th>Project Name</th><th>Status</th>'
        + '<th class="r">Contract</th><th class="r">Total Project</th>'
        + '<th class="r">Budgets</th><th class="r">Analyses</th><th></th></tr></thead><tbody>'
        + ps.map(rowFor).join('')
        + '</tbody></table></div>')
    + '</div>';
}

/* The three views every other list already offers, in the place the review
   asked for: beside the count. It stores through the same per-account
   preference mechanism as budgetView and analysisView, so the choice follows
   the account to any signed-in browser. */
function projectView() {
  var v = A.projectView ? A.projectView() : 'comfortable';
  return v === 'compact' || v === 'cards' ? v : 'comfortable';
}
function viewSeg(view) {
  var opt = function (val, label, path) {
    return '<button data-projectview-pick="' + val + '"' + (val === view ? ' class="on"' : '')
      + ' aria-pressed="' + (val === view ? 'true' : 'false') + '"'
      + ' aria-label="' + label + '" title="' + label + '"'
      + ' onclick="FSProjects.setView(\'' + val + '\')">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
      + ' stroke-linejoin="round">' + path + '</svg></button>';
  };
  return '<div class="mini-seg" role="group" aria-label="Projects View" title="Projects View">'
    + opt('comfortable', 'Comfortable List', '<path d="M4 5h16M4 12h16M4 19h16"/>')
    + opt('compact', 'Compact List', '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>')
    + opt('cards', 'Card View', '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>')
    + '</div>';
}
function setView(v) {
  // chooseSetting() repaints this page itself when it is the one showing, so
  // the local render is only the fallback for a missing adapter.
  if (A.setSetting) A.setSetting('projectView', v);
  else render(false);
}

function rowFor(p) {
  // A converted project reports its SNAPSHOT; everything else reports the live
  // primary budget. Mixing the two in one column without saying which is which
  // is how a dashboard starts lying, so the cell says.
  var conv = p.status === 'Converted to Project';
  var contract = conv && p.contractAmount !== null ? p.contractAmount : p.liveContractSum;
  var total = conv && p.projectAmount !== null ? p.projectAmount : p.liveProjectCost;
  // The ID and the name are two facts, so they are two columns. The address
  // stays with the name as its secondary line — it identifies the same thing.
  return '<tr class="pj-row" onclick="FSProjects.open(\'' + esc(p.projectId) + '\')">'
    + '<td onclick="event.stopPropagation()">' + star('project', p.projectId, p.name || p.projectId) + '</td>'
    + '<td><span class="pj-id mono">' + esc(p.projectId) + '</span>'
      + (p.breachCount ? ' <span class="badge bad" title="' + p.breachCount + ' budget(s) outside a guard rail">'
          + p.breachCount + '</span>' : '') + '</td>'
    + '<td><div class="pj-name">' + esc(p.name || 'Untitled') + '</div>'
      + (p.address ? '<div class="pj-addr">' + esc(p.address) + '</div>' : '') + '</td>'
    + '<td>' + statusChip(p) + '</td>'
    + '<td class="r mono">' + usd(contract) + (conv ? '' : '<div class="pj-live">live</div>') + '</td>'
    + '<td class="r mono">' + usd(total) + '</td>'
    + '<td class="r mono">' + num(p.budgetCount) + '</td>'
    + '<td class="r mono">' + num(p.analysisCount) + '</td>'
    // The same ⋮ affordance every other list uses. "Open →" was a second way
    // to do what clicking the row already does, occupying the place the row
    // actions belong.
    + '<td class="r no-print" onclick="event.stopPropagation()">' + projectMenuBtn(p) + '</td></tr>';
}

function projectMenuBtn(p) {
  return '<button class="rowmenu-btn" data-pjid="' + esc(p.projectId) + '"'
    + ' aria-haspopup="menu" aria-expanded="false"'
    + ' aria-label="Actions for project ' + esc(p.projectId) + '"'
    + ' onclick="event.stopPropagation();FSProjects.openProjectMenu(this)">\u22EE</button>';
}

function cardFor(p) {
  var conv = p.status === 'Converted to Project';
  var contract = conv && p.contractAmount !== null ? p.contractAmount : p.liveContractSum;
  var s = PROJECT_STATUSES.indexOf(p.status) === -1 ? 'Lead' : p.status;
  return '<div class="hm-card-wrap">'
    + '<button class="hm-card" onclick="FSProjects.open(\'' + esc(p.projectId) + '\')">'
    + '<div class="hm-card-hd"><div class="hm-card-top">'
    + '<span class="hm-kind hm-kind-budget">Project</span>'
    + '<span class="hm-id mono">' + esc(p.projectId) + '</span></div>'
    + '<div class="hm-card-name">' + esc(p.name || 'Untitled') + '</div>'
    + (p.address ? '<div class="pj-addr">' + esc(p.address) + '</div>' : '') + '</div>'
    + '<div class="hm-card-sum"><div class="hm-card-money">'
    + '<span class="k">' + (conv ? 'Contract Amount' : 'Contract Sum') + '</span>'
    + '<span class="v mono">' + usd(contract) + '</span></div>'
    + '<div class="hm-card-ft"><span class="st-chip ' + (STATUS_CLS[s] || 'st-draft') + '">' + esc(s) + '</span>'
    + '<span>' + num(p.budgetCount) + ' · ' + num(p.analysisCount) + '</span></div></div>'
    + '</button>'
    // The card carries the same actions as the row: a card view is a different
    // shape for the same list, not a reduced one.
    + '<div class="pj-card-menu no-print">' + projectMenuBtn(p) + '</div>'
    + '</div>';
}

/* The four headline numbers as real cards rather than four labelled figures
   floating on the page background. The sub-line is optional: a card that
   restates what its own label already said is noise, so only the one number
   that genuinely needs context keeps one. */
function statCard(k, v, sub) {
  return '<div class="pj-stat"><div class="pj-stat-k">' + esc(k) + '</div>'
    + '<div class="pj-stat-v">' + esc(v) + '</div>'
    + '<div class="pj-stat-sub">' + (sub ? esc(sub) : '') + '</div></div>';
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
      + '<b>No project with that ID.</b><br>Project IDs look like <span class="mono">OP-0001</span>. '
      + 'Create one with + Create Project on the Projects tab.'
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
  // Counts read as proper nouns and pluralise honestly, including at zero:
  // "1 Budget · 2 Analyses", "0 Budgets · 0 Analyses".
  // The types the project's BUDGETS are, not a type the project claims. One
  // property can carry a Multifamily budget and a Commercial budget at once,
  // so a single locked project type was a fiction the page had to keep.
  el('projectSub').innerHTML = [p.address ? esc(p.address) : '', esc(p.budgetTypes || ''),
    num(budgets.length) + ' Budget' + (budgets.length === 1 ? '' : 's'),
    num(analyses.length) + ' Analys' + (analyses.length === 1 ? 'is' : 'es')]
    .filter(Boolean).join(' · ');
  el('projectStar').innerHTML = star('project', p.projectId, p.name || p.projectId);
  el('projectStatusHost').innerHTML = statusChip(p);

  host.innerHTML =
    '<div class="pj-stats">'
    // A converted project's amounts are frozen, which the banner below states
    // once; the cards carry the number, not a repeated caption.
    + statCard(conv ? 'Contract Amount' : 'Contract Sum',
        usd(conv && p.contractAmount !== null ? p.contractAmount : p.liveContractSum), '')
    // Named for what it actually is. It reports the PRIMARY budget's cost and
    // nothing else — an alternate is a different way of pricing the same work,
    // so adding one in would double-count the project.
    + statCard(conv ? 'Project Amount' : 'Total Project Cost (Primary)',
        usd(conv && p.projectAmount !== null ? p.projectAmount : p.liveProjectCost),
        conv ? '' : (primaryOf(budgets) ? primaryOf(budgets).projectId : ''))
    // The only sub-line kept here is a warning: "all clear" is what the
    // absence of one already means, but a breach has to be visible.
    + statCard('Budgets', num(budgets.length),
        p.breachCount ? p.breachCount + ' outside a guard rail' : '')
    + statCard('Investment Analyses', num(analyses.length), '')
    + '</div>'
    + (conv ? '<div class="gr-alert" style="border:1px solid var(--green-200);background:var(--green-50);color:var(--green-800)">'
        + '<b>Converted to a project</b> on ' + esc(A.fmtDay ? A.fmtDay(p.convertedAt) : String(p.convertedAt || '').slice(0, 10))
        + '. The contract and project amounts above were captured at that moment and no longer move with the budget.'
        + '</div>' : '')
    + (favB.length || favA.length ? favoritesCard(favB, favA) : '')
    + budgetsCard(p, budgets)
    + analysesCard(analyses, budgets);
}

/* Which budget the project's money comes from. The server decides — this is
   the same answer, so the card can name it without a second rule. */
function primaryOf(budgets) {
  return (budgets || []).filter(function (b) { return b.isPrimary; })[0] || null;
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
    + '<div class="pj-hd-r">'
    + '<span class="eyebrow">The base budget and its alternates</span>'
    // A project can exist before any budget does now, so the first budget has
    // to be creatable from here — the alternate button copies one and cannot
    // be the only way in.
    + '<button class="btn btn-ghost btn-sm no-print" onclick="FSProjects.newBudget()">+ New Budget</button>'
    + (budgets.length
      ? '<button class="btn btn-ghost btn-sm no-print" onclick="FSProjects.addAlternate()">+ Add Alternate Budget</button>'
      : '')
    + '</div></div>'
    + '<div class="card-bd" style="overflow-x:auto">'
    + (budgets.length
      // Budget ID and Budget Name are two columns, not one stacked cell, and
      // the widths are declared so the money columns line up with the
      // Investment Analyses table below.
      ? '<table class="tbl pj-tbl pj-tbl-budgets"><thead><tr><th style="width:34px"></th>'
        + '<th>Budget ID</th><th>Budget Name</th><th>Status</th>'
        + '<th>Guard Rails</th><th class="r">Contract</th><th class="r">Total Project</th>'
        + '<th class="no-print"></th></tr></thead><tbody>'
        + budgets.map(function (b) {
          return '<tr class="pj-row" onclick="FSProjects.openBudget(\'' + esc(b.projectId) + '\')">'
            + '<td onclick="event.stopPropagation()">' + star('budget', b.projectId, b.name) + '</td>'
            + '<td><span class="pj-id mono">' + esc(b.projectId) + '</span>'
              + (b.isPrimary ? ' <span class="badge ok">Primary</span>'
                 : b.isAlternate ? ' <span class="badge">Alternate</span>' : '') + '</td>'
            + '<td><div class="pj-name">' + esc(b.name || 'Untitled') + '</div></td>'
            + '<td><span class="badge">' + esc(b.status || 'Draft') + '</span></td>'
            + '<td>' + guardrailCell(b) + '</td>'
            + '<td class="r mono">' + usd(b.contractSum) + '</td>'
            + '<td class="r mono">' + usd(b.projectCost) + '</td>'
            + '<td class="r no-print" onclick="event.stopPropagation()">'
            // The same ⋮ menu the Budgets tab and Home use, so Edit, Versions,
            // Update Pricing and the favorite toggle behave identically here.
            + '<button class="rowmenu-btn" data-pid="' + esc(b.projectId) + '"'
            // The project context the menu needs to offer Make Primary — and
            // to know not to offer it on the budget that already is.
            + ' data-project="' + esc(p.projectId) + '"'
            + ' data-primary="' + (b.isPrimary ? '1' : '0') + '"'
            + ' aria-haspopup="menu" aria-expanded="false"'
            + ' aria-label="Actions for budget ' + esc(b.projectId) + '"'
            + ' onclick="event.stopPropagation();openRowMenu(this)">\u22EE</button></td></tr>';
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

function analysesCard(analyses, budgets) {
  return '<div class="card"><div class="card-hd"><h2>Investment Analyses</h2>'
    + '<div class="pj-hd-r">'
    + '<span class="eyebrow">Underwriting built from this project’s budgets</span>'
    + '<button class="btn btn-ghost btn-sm no-print" onclick="FSProjects.addAnalysis()"'
    + ((budgets || []).length ? '' : ' disabled title="Create a budget on this project first"')
    + '>+ Add Investment Analysis</button>'
    + '</div></div>'
    + '<div class="card-bd" style="overflow-x:auto">'
    + (analyses.length
      ? '<table class="tbl pj-tbl pj-tbl-analyses"><thead><tr><th style="width:34px"></th><th>Analysis</th><th>From Budget</th>'
        + '<th>Status</th><th class="r">Purchase Price</th><th class="r">Year-1 NOI</th>'
        + '<th class="no-print"></th></tr></thead><tbody>'
        + analyses.map(function (a) {
          var inaId = A.displayChildId && a.itemNumber && detail && detail.project
            ? A.displayChildId('INA', Number(String(detail.project.projectId).slice(-4)), a.itemNumber) : '';
          return '<tr class="pj-row" onclick="FSProjects.openAnalysis(\'' + esc(a.analysisId) + '\')">'
            + '<td onclick="event.stopPropagation()">' + star('analysis', a.analysisId, a.name) + '</td>'
            + '<td><div class="pj-name">' + esc(a.name || 'Untitled') + '</div>'
              + (inaId ? '<div class="pj-addr mono">' + esc(inaId) + '</div>' : '') + '</td>'
            + '<td class="mono" style="font-size:12px">' + esc(a.projectId || 'Standalone')
              + (a.sourceBudgetVersionNumber ? ' <span class="inv-vsub">v' + esc(a.sourceBudgetVersionNumber) + '</span>' : '') + '</td>'
            + '<td><span class="badge">' + esc(a.status || 'Draft') + '</span></td>'
            + '<td class="r mono">' + usd(a.purchasePrice) + '</td>'
            + '<td class="r mono">' + usd(a.year1NOI) + '</td>'
            + '<td class="r no-print" onclick="event.stopPropagation()">'
            // The analysis list's own ⋮ menu — Open, Versions, Duplicate,
            // Delete and the favorite toggle. Update Pricing has no analysis
            // counterpart: an analysis pins a budget VERSION, and re-importing
            // it is the editor's Re-sync, where the consequences are visible.
            + '<button class="rowmenu-btn" data-aid="' + esc(a.analysisId) + '"'
            + ' aria-haspopup="menu" aria-expanded="false"'
            + ' aria-label="Actions for ' + esc(a.name || 'analysis') + '"'
            + ' onclick="event.stopPropagation();FSInvestmentUI.openInvRowMenu(this,this.dataset.aid)">\u22EE</button>'
            + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="hm-empty">No investment analyses on this project yet.</div>')
    + '</div></div>';
}

/* One button, three honest outcomes. Exactly one budget is the common case and
   needs no question asked; several means the choice matters, so the picker
   opens — restricted to THIS project's budgets, because that is what the
   button on this page promises. None means there is nothing to build from,
   and the card already says so. */
async function addAnalysis() {
  if (!detail || !detail.project) return;
  var budgets = detail.budgets || [];
  if (!budgets.length) {
    if (A.toast) A.toast('Create a budget on this project first — an analysis is built from one.');
    return;
  }
  if (budgets.length === 1) { await createAnalysisFrom(budgets[0].projectId); return; }
  openBudgetPicker(budgets);
}

async function createAnalysisFrom(budgetId) {
  if (!window.FSInvestmentUI) return;
  try {
    await FSInvestmentUI.createFromBudget(budgetId);
    invalidate();
  } catch (e) {
    if (A.toast) A.toast('Could not create the analysis — ' + e.message);
  }
}

/* The picker is a REAL dialog now: #invPickModal in index.html, with the same
   shell every other popup uses. The version built here said class="modal" when
   no such class existed, so it had no styling at all — it rendered as a plain
   block at the foot of the document, and nothing unmounted it, which is why it
   followed you to every other tab. Centering, the dimmed backdrop, the scroll
   lock, focus in and out, Escape and backdrop-click all come from the shared
   dialog plumbing; leaving the page closes it. */
function openBudgetPicker(budgets) {
  var body = el('invPickBody');
  if (!body || !A.openDialog) return;
  body.innerHTML =
    '<p style="font-size:12.5px;color:var(--ink-500);margin:0 0 12px">'
    + esc(detail.project.projectId) + ' has ' + num(budgets.length) + ' budgets. '
    + 'Choose the one to underwrite — the analysis snapshots that budget\u2019s latest saved version.</p>'
    + '<div style="max-height:300px;overflow:auto;border:1px solid var(--ink-150);border-radius:8px">'
    + '<table class="tbl"><thead><tr><th>Budget ID</th><th>Budget Name</th><th class="r">Total Project</th></tr></thead><tbody>'
    + budgets.map(function (b) {
      return '<tr class="clickable" tabindex="0" data-pick="' + esc(b.projectId) + '">'
        + '<td><span class="pj-id mono">' + esc(b.projectId) + '</span>'
        + (b.isPrimary ? ' <span class="badge ok">Primary</span>' : '') + '</td>'
        + '<td>' + esc(b.name || 'Untitled') + '</td>'
        + '<td class="r mono">' + usd(b.projectCost) + '</td></tr>';
    }).join('')
    + '</tbody></table></div>'
    + '<div style="display:flex;justify-content:flex-end;margin-top:14px">'
    + '<button class="btn btn-ghost" data-pick-cancel>Cancel</button></div>';
  body.querySelectorAll('[data-pick]').forEach(function (tr) {
    var pick = function () { var id = tr.dataset.pick; closeBudgetPicker(); createAnalysisFrom(id); };
    tr.onclick = pick;
    // A row that can be reached by keyboard has to be usable by keyboard.
    tr.onkeydown = function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    };
  });
  body.querySelector('[data-pick-cancel]').onclick = function () { closeBudgetPicker(); };
  A.openDialog('invPickModal', '[data-pick]');
}
function closeBudgetPicker() {
  if (A.closeDialog) A.closeDialog('invPickModal');
  var body = el('invPickBody');
  if (body) body.innerHTML = '';
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

/* A budget id with any alternate suffix stripped — the BASE BUDGET, which is
   the only thing this is for. It is not a project id: a project id is OP-####
   and lives in its own namespace. */
function budgetBaseOf(id) {
  var s = String(id || '').toUpperCase();
  return /^(OP|BD|BDG|AS|TST)-\d{4}-\d{2}$/.test(s) ? s.slice(0, -3) : s;
}

/* An alternate is the same budget priced a different way, so it starts as a
   copy rather than a blank sheet, and it belongs to the SAME project.

   The id stays in the source budget's FAMILY. A BDG budget's siblings are the
   project's next items — BDG-0042-01 gives BDG-0042-02 — numbered by the
   server, which also sees deleted ids (a budget number is never re-issued).
   A legacy budget keeps its -NN suffix loop, because renaming eras mid-family
   would put BD-0002 and BDG-0002-01 side by side claiming to be siblings. */
async function addAlternate() {
  if (!detail || !detail.project) return;
  var from = primaryOf(detail.budgets) || (detail.budgets || [])[0];
  if (!from) {
    if (A.toast) A.toast('Create the first budget on this project — an alternate is a copy of one.');
    return;
  }
  var next = null;
  if (/^BDG-/.test(String(from.projectId).toUpperCase())) {
    try {
      var r = await A.api('budget/BD-0000?scope=next-budget-id&project='
        + encodeURIComponent(detail.project.projectId));
      next = r && r.budgetId;
    } catch (e) { /* fall through to the toast below */ }
    if (!next) { if (A.toast) A.toast('Could not number the next budget — try again.'); return; }
  } else {
    var base = budgetBaseOf(from.projectId);
    var taken = {};
    (detail.budgets || []).forEach(function (b) { taken[b.projectId] = 1; });
    for (var i = 2; i <= 99; i++) {
      var cand = base + '-' + (i < 10 ? '0' + i : String(i));
      if (!taken[cand]) { next = cand; break; }
    }
    if (!next) { if (A.toast) A.toast('This budget already has 98 alternates.'); return; }
  }
  if (A.duplicateBudget) A.duplicateBudget(from.projectId, next, detail.project.projectId);
}

/* The first budget on a project, or another one beside the alternates. Opens
   the New Budget dialog with this project already chosen, so its name and
   address come across instead of being retyped. */
function newBudget() {
  if (!detail || !detail.project) return;
  if (A.newBudget) A.newBudget(detail.project.projectId);
}

/* ================= primary budget ================= */

/* Exactly one budget is the project's primary, and it is what the project's
   money is reported from. Promoting one demotes the previous in the same
   write — the server stores a single PrimaryBudgetId — so the project cannot
   pass through a state with none or two. */
async function makePrimary(budgetId) {
  if (!detail || !detail.project) return;
  var pid = detail.project.projectId;
  try {
    await A.api('budget/' + encodeURIComponent(pid) + '?scope=project',
      { method: 'PUT', body: JSON.stringify({ primaryBudgetId: budgetId }) });
    // Re-read rather than patch: the labels, the row flags and the money all
    // move together, and the money is the server's answer, not ours.
    list = null;
    await loadDetail(pid, true);
    paintDetail();
    if (A.toast) A.toast(budgetId + ' is now the primary budget for ' + pid + '.');
    if (A.dashboardInvalidate) A.dashboardInvalidate();
  } catch (e) {
    if (A.toast) A.toast('Could not change the primary budget — ' + e.message);
  }
}

/* ================= project row menu ================= */

var pjMenuTrigger = null;
function projectMenuEl() {
  var m = el('pjRowMenu');
  if (!m) {
    m = document.createElement('div');
    m.id = 'pjRowMenu';
    m.className = 'rowmenu';
    m.setAttribute('role', 'menu');
    document.body.appendChild(m);
    document.addEventListener('click', function (e) {
      if (pjMenuTrigger && !e.target.closest('#pjRowMenu')) closeProjectMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (!pjMenuTrigger) return;
      var items = [].slice.call(m.querySelectorAll('.rowmenu-item'));
      var i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); closeProjectMenu(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[i < 0 ? 0 : (i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Tab') closeProjectMenu(false);
    });
  }
  return m;
}
function openProjectMenu(btn) {
  var was = pjMenuTrigger === btn;
  closeProjectMenu(false);
  if (was) return;                       // the trigger toggles its own menu
  var pid = btn.dataset.pjid;
  var m = projectMenuEl();
  m.dataset.pjid = pid;                  // never interpolated into markup
  var fav = isFav('project', pid);
  var items = [
    ['open', 'Open Project'],
    ['fav', fav ? 'Remove From Favorites' : 'Add to Favorites'],
    ['sep'],
    ['delete', 'Delete Project', 'danger']
  ];
  m.innerHTML = items.map(function (it) {
    return it[0] === 'sep' ? '<div class="rowmenu-sep"></div>'
      : '<button class="rowmenu-item' + (it[2] ? ' ' + it[2] : '') + '" role="menuitem"'
        + ' tabindex="-1" data-act="' + it[0] + '">' + esc(it[1]) + '</button>';
  }).join('');
  m.querySelectorAll('.rowmenu-item').forEach(function (x) {
    x.onclick = function () { projectMenuAction(x.dataset.act); };
  });
  m.style.display = 'block';
  var r = btn.getBoundingClientRect();
  m.style.top = (r.bottom + 4) + 'px';
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  pjMenuTrigger = btn;
  var first = m.querySelector('.rowmenu-item');
  if (first) first.focus();
}
function closeProjectMenu(refocus) {
  var m = el('pjRowMenu'), t = pjMenuTrigger;
  pjMenuTrigger = null;
  if (m) { m.style.display = 'none'; m.innerHTML = ''; }
  if (t) {
    t.setAttribute('aria-expanded', 'false');
    if (refocus && document.body.contains(t)) t.focus();
  }
}
function projectMenuAction(act) {
  var pid = el('pjRowMenu').dataset.pjid;
  closeProjectMenu(act === 'delete');
  if (act === 'open') { open(pid); return; }
  if (act === 'fav') {
    // FSHome words the toast and repaints whichever page is showing.
    if (window.FSHome) FSHome.toggleFavorite('project', pid);
    return;
  }
  if (act === 'delete') removeProject(pid);
}

/* Deleting a project takes its budgets and its analyses with it, so the
   warning says exactly how many — and says plainly that nothing is destroyed.
   The server does all three in one transaction; a project flagged deleted
   while its budgets were still live would keep being counted. */
async function removeProject(projectId) {
  var p = ((list && list.projects) || []).filter(function (x) { return x.projectId === projectId; })[0]
    || (detail && detail.project && detail.project.projectId === projectId ? detail.project : null);
  var nb = p ? p.budgetCount : 0, na = p ? p.analysisCount : 0;
  var msg = 'Delete project ' + projectId + (p && p.name ? ' — ' + p.name : '') + '?\n\n'
    + 'This also deletes ' + nb + ' budget' + (nb === 1 ? '' : 's')
    + ' and ' + na + ' investment analys' + (na === 1 ? 'is' : 'es') + ' linked to it.\n\n'
    + 'Nothing is destroyed: everything is flagged deleted and every saved version is kept, '
    + 'so an administrator can restore it.';
  if (!confirm(msg)) return;
  try {
    var r = await A.api('budget/' + encodeURIComponent(projectId) + '?scope=project', { method: 'DELETE' });
    if (window.FSHome && FSHome.unfavorite) FSHome.unfavorite('project', projectId);
    invalidate();
    if (A.toast) A.toast('Deleted ' + projectId + ' — ' + r.budgetsDeleted + ' budget'
      + (r.budgetsDeleted === 1 ? '' : 's') + ' and ' + r.analysesDeleted + ' analys'
      + (r.analysesDeleted === 1 ? 'is' : 'es') + ' with it.');
    if (A.dashboardInvalidate) A.dashboardInvalidate();
    // Standing on the project that just went away is not a place to be.
    if (A.currentPage && A.currentPage() === 'project') { if (A.go) A.go('projects'); render(true); }
    else render(true);
  } catch (e) {
    if (A.toast) A.toast('Could not delete the project — ' + e.message);
  }
}

window.FSProjects = {
  init: function (a) { A = a || {}; },
  render: render,
  show: show,
  open: open,
  invalidate: invalidate,
  openStatusMenu: openStatusMenu,
  openProjectMenu: openProjectMenu,
  closeProjectMenu: closeProjectMenu,
  makePrimary: makePrimary,
  addAlternate: addAlternate,
  newBudget: newBudget,
  addAnalysis: addAnalysis,
  closeBudgetPicker: closeBudgetPicker,
  setView: setView,
  paint: paintDetail,
  currentId: function () { return openId; },
  openBudget: function (id) { if (A.openBudget) A.openBudget(id); },
  openAnalysis: function (id) { location.hash = '#/analysis/' + String(id).toLowerCase(); },
  PROJECT_STATUSES: PROJECT_STATUSES,
  // exposed for the suites
  _list: function () { return list; },
  _detail: function () { return detail; }
};
})();
