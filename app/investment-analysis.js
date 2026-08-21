/* Investment Analysis UI — external no-build module.
   The entire workflow lives here behind window.FSInvestmentUI; app/index.html
   contributes only the nav button, two page containers, route hooks, and the
   adapter passed to init(). The browser NEVER calculates: it posts assumptions
   to /api/investment-calculations (preview) or PUT /api/investment-analysis
   (save) and renders the returned canonical result. */
(function () {
  'use strict';

  let A = null;   // adapter: { api, toast, esc, confirmLeave, navigate, ... } — see init()
  const st = {
    id: null, input: null, result: null, source: null,
    loadedVersion: 0, dirty: false, stale: false, busy: '',
    step: 1, viewingVersion: null, conflict: null, errors: {},
    // Per-session, never persisted: an override of the budget-derived inputs
    // is a decision about the edit being made now, so it re-arms on load.
    overrideSource: false,
    // The canonical property area in square feet — see setSizeUnit().
    sizeSF: null
  };

  /* ---------- formatting (display only — never feeds arithmetic) ---------- */
  const nz = v => (Number.isFinite(+v) ? +v : 0);
  const usd = v => v === null || v === undefined ? '—'
    : (v < 0 ? '−$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US');
  const usd2 = v => v === null || v === undefined ? '—'
    : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctf = (v, d) => v === null || v === undefined ? '—' : (v * 100).toFixed(d === undefined ? 2 : d) + '%';
  const rat = v => v === null || v === undefined ? '—' : v.toFixed(2);
  const mult = v => v === null || v === undefined ? '—' : v.toFixed(2) + 'x';
  // The recovered report convention: leverage displays as the difference of the
  // two DISPLAYED two-decimal IRRs, so the printed rows always foot.
  const leveragePct = a => a.equityIRR === null || a.propertyIRR === null ? '—'
    : (Math.round(a.equityIRR * 10000) / 100 - Math.round(a.propertyIRR * 10000) / 100).toFixed(2) + '%';
  // Percent fields are edited as human percentages (6.5, not 0.065).
  const toPct = v => v === null || v === undefined ? '' : String(Math.round(v * 1e6) / 1e4);
  const fromPct = s => s === '' || s === null || s === undefined ? null : nz(s) / 100;
  const numOrNull = s => s === '' || s === null || s === undefined ? null : nz(s);

  /* ---------- display formatting for the assumption fields ----------
     A handful of inputs render as TEXT so they can carry a $, thousands
     separators, a % or a unit suffix. The DECORATION is display only: the
     value in st.input stays a plain number, parseNum() strips the decoration
     off again on every read, and nothing that calculates, saves or exports
     ever sees a formatted string. Fields not listed in FMT keep their native
     number input. */
  const parseNum = s => {
    if (s === null || s === undefined) return null;
    const t = String(s).replace(/[^0-9.eE+-]/g, '');
    return t === '' || !Number.isFinite(+t) ? null : +t;
  };
  const grp = (v, min, max) => (+v).toLocaleString('en-US',
    { minimumFractionDigits: min, maximumFractionDigits: max });
  // Cents only when the value actually has them: $3,810,600 stays whole while
  // $45,408,771.05 keeps its five cents.
  function fmtMoneyIn(v) {
    if (v === null || v === undefined || !Number.isFinite(+v)) return '';
    return '$' + grp(v, Math.round(+v * 100) % 100 === 0 ? 0 : 2, 2);
  }
  // A RATE (0.02) shown the way the review asked for it: "2.00%".
  function fmtPctIn(v) {
    if (v === null || v === undefined || !Number.isFinite(+v)) return '';
    return grp(Math.round(+v * 1e6) / 1e4, 2, 2) + '%';
  }
  // The price field is money in one mode and a rate in the other, so the
  // display it carries follows the mode rather than the field.
  function basisDisplay(inp) {
    const b = inp.acquisition.basis;
    if (b.value === null || b.value === undefined) return '';
    return b.mode === 'acquisitionCapRate' ? toPct(b.value) : fmtMoneyIn(b.value);
  }
  const SIZE_SUFFIX = { squareFeet: 'SF', acres: 'AC', units: 'Units' };
  function fmtSizeIn(v, unit) {
    if (v === null || v === undefined || !Number.isFinite(+v)) return '';
    return grp(v, 0, unit === 'acres' ? 4 : 2) + ' ' + (SIZE_SUFFIX[unit] || 'SF');
  }

  /* ---------- the canonical property size ----------
     Square feet and acres are the same area said two ways, so switching the
     unit CONVERTS the value rather than relabelling it. The conversion runs
     off one canonical square-foot figure, which is why switching SF → acres →
     SF lands back on the number you started with instead of drifting through
     two roundings. Units is not an area at all: it has no conversion, so it
     takes the property's unit count and leaves the canonical area untouched
     for the trip back. */
  const SF_PER_ACRE = 43560;
  const isArea = u => u === 'squareFeet' || u === 'acres';
  const toSF = (v, u) => v === null || v === undefined ? null : (u === 'acres' ? +v * SF_PER_ACRE : +v);
  const fromSF = (sf, u) => sf === null || sf === undefined ? null : (u === 'acres' ? sf / SF_PER_ACRE : sf);
  function noteSizeCanonical() {
    const sz = st.input && st.input.property && st.input.property.size;
    if (sz && isArea(sz.unit) && Number.isFinite(+sz.value)) st.sizeSF = toSF(sz.value, sz.unit);
  }
  function setSizeUnit(to) {
    const sz = st.input.property.size, from = sz.unit;
    sz.unit = to;
    if (from === to) return;
    if (isArea(to)) {
      if (st.sizeSF !== null && st.sizeSF !== undefined) sz.value = fromSF(st.sizeSF, to);
    } else {
      const uc = st.input.property.unitCount;
      if (Number.isFinite(+uc) && +uc > 0) sz.value = +uc;
    }
    const box = host_input('property.size.value');
    if (box) box.value = fmtSizeIn(sz.value, to);
  }

  // House timestamp format, matching the budget app: the viewer's LOCAL time
  // as MM-DD-YYYY h:mm AM/PM, or MM-DD-YYYY where only the day matters.
  function fmtWhen(iso) {
    if (!iso) return '—';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const p = n => String(n).padStart(2, '0');
    const day = p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + d.getFullYear();
    // Settings → Time Format (per account; the shell keeps the flag current)
    if ((window.__fsTimeFormat || '12h') === '24h')
      return day + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return day + ' ' + h + ':' + p(d.getMinutes()) + ' ' + ap;
  }
  function fmtDay(iso) {
    if (!iso) return '—';
    const d = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const p = n => String(n).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + d.getFullYear();
  }

  /* ---------- tiny DOM helpers ---------- */
  const el = id => document.getElementById(id);
  const esc = s => A.esc(String(s === null || s === undefined ? '' : s));

  /* ================= LIST VIEWS =================
     One row markup serves two hosts: the Investment Analysis tab (with the
     creation controls) and the embedded section under the budgets on Home.
     Row actions live in a three-dot menu, exactly like the budget rows —
     Versions is reachable only from there, never from the editor toolbar. */
  const listHosts = new Set();   // every host currently showing a list, for refresh

  /* Search / status / grouping over the analyses list — the same controls the
     budget list has, one shared view state for both hosts. */
  const lv = { q: '', status: 'all', group: '' };
  let lvRows = [];

  function lvFiltered() {
    const q = lv.q.trim().toLowerCase();
    return lvRows.filter(r => {
      const ns = window.normStatus ? normStatus(r.status) : (r.status || 'Draft');
      if (lv.status !== 'all' && ns !== lv.status) return false;
      if (!q) return true;
      return (r.name || '').toLowerCase().includes(q)
        || (r.projectId || '').toLowerCase().includes(q);
    });
  }
  const LV_GROUPS = {
    project: { of: r => r.projectId || 'Standalone' },
    status: { of: r => window.normStatus ? normStatus(r.status) : (r.status || 'Draft') },
    // Same placeholder wording the budgets list uses, so the two group headers
    // read alike for records with no recorded creator.
    user: { of: r => (r.createdByName || '').trim() || 'No User' }
  };

  async function renderListInto(host, opts) {
    if (!host) return;
    opts = opts || {};
    listHosts.add(host);
    try { lvRows = await A.api('investment-analyses'); }
    catch (e) { host.innerHTML = '<div class="empty">Could not load analyses — ' + esc(e.message) + '</div>'; return; }
    // One creation flow everywhere: the tab page and Home both open the same
    // New Investment Analysis modal. The tab page is the fuller index view,
    // laid out exactly like Home — title row, then the list in a card.
    const head = opts.embedded ? '' : `
      <div class="page-title">
        <div><h1>Investment Analyses</h1>
          <div class="sub">Before-tax underwriting, linked to exact saved budget versions</div></div>
        <div style="display:flex;gap:10px" data-inv-edit>
          <button class="btn btn-primary" onclick="FSInvestmentUI.openProjectPicker()">+ New Investment Analysis</button>
        </div>
      </div>`;
    const inner = `
      <div class="card-hd no-print">
        <div class="list-toolbar">
          <input type="text" data-inv-q placeholder="Search name or project…" value="${esc(lv.q)}">
          <select data-inv-status class="lt-status" aria-label="Filter by Status">
            <option value="all">All Statuses</option>
            <option value="Draft">Draft</option>
            <option value="In Review">In Review</option>
            <option value="Completed">Completed</option>
            <option value="Cancelled">Cancelled</option>
          </select>
          <select data-inv-group class="lt-group" title="Group the list" aria-label="Group By">
            <option value="">No Grouping</option>
            <option value="project">Group by Project</option>
            <option value="status">Group by Status</option>
            <option value="user">Group by User</option>
          </select>
        </div>
        <div style="display:flex;gap:12px;align-items:center">
          <div class="mini-seg" role="group" aria-label="Analyses View" title="Analyses View — also in Settings">
            <button data-analysisview-pick="comfortable" aria-label="Comfortable List" title="Comfortable List" onclick="chooseSetting('analysisView','comfortable')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5h16M4 12h16M4 19h16"/></svg></button>
            <button data-analysisview-pick="compact" aria-label="Compact List" title="Compact List" onclick="chooseSetting('analysisView','compact')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg></button>
            <button data-analysisview-pick="cards" aria-label="Card View" title="Card View" onclick="chooseSetting('analysisView','cards')">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg></button>
          </div>
          <span class="eyebrow" data-inv-count>—</span>
        </div>
      </div>
      <table class="inv-table inv-list"><thead><tr>
        <th style="padding-left:22px" class="no-print lt-user-col">User</th><th>Analysis</th><th>Project / Budget</th><th>Status</th><th class="r">Purchase Price</th>
        <th class="r">Year 1 NOI</th><th class="r">Equity IRR</th><th class="r">Optimal Hold</th>
        <th class="r">Analysis Ver.</th><th class="r" style="padding-right:22px">Updated</th><th class="no-print"></th>
      </tr></thead><tbody data-inv-list></tbody></table>
      <div class="home-cards" data-inv-cards></div>
      <div class="empty" data-inv-empty style="display:none">No investment analyses yet.</div>`;
    host.innerHTML = opts.embedded ? inner
      : head + `<section class="card"><div class="card-bd" style="padding:0;overflow-x:auto">${inner}</div></section>`;
    host.querySelector('[data-inv-status]').value = lv.status;
    host.querySelector('[data-inv-group]').value = lv.group;
    host.querySelector('[data-inv-q]').addEventListener('input', e => { lv.q = e.target.value; paintInvList(host, opts); });
    host.querySelector('[data-inv-status]').addEventListener('change', e => { lv.status = e.target.value; paintInvList(host, opts); });
    host.querySelector('[data-inv-group]').addEventListener('change', e => { lv.group = e.target.value; paintInvList(host, opts); });
    paintInvList(host, opts);
    // the freshly rendered toolbar toggles need their active marks
    if (window.paintSettingsUI) window.paintSettingsUI();
  }

  function paintInvList(host, opts) {
    const tb = host.querySelector('[data-inv-list]');
    if (!tb) return;
    tb.innerHTML = '';
    const rows = lvFiltered();
    const empty = host.querySelector('[data-inv-empty]');
    empty.style.display = rows.length ? 'none' : 'block';
    empty.textContent = lvRows.length ? 'No analyses match this search or filter.' : 'No investment analyses yet.';
    const count = host.querySelector('[data-inv-count]');
    if (count) count.textContent = lvRows.length
      ? rows.length + ' of ' + lvRows.length + (lvRows.length === 1 ? ' analysis' : ' analyses') : '—';
    // Per-section view (Settings → Views, or the toolbar): cards or a list
    // at either density — Home and the tab alike.
    const view = A.analysisView ? A.analysisView() : 'comfortable';
    const wrap = host.querySelector('table.inv-list').parentElement;
    wrap.setAttribute('data-density', view === 'compact' ? 'compact' : 'comfortable');
    const cards = host.querySelector('[data-inv-cards]');
    const cardsMode = view === 'cards';
    host.querySelector('table.inv-list').style.display = cardsMode ? 'none' : '';
    if (cards) {
      cards.classList.toggle('on', cardsMode && rows.length > 0);
      cards.innerHTML = '';
    }
    if (cardsMode) {
      const g2 = LV_GROUPS[lv.group];
      const add = r => cards.insertAdjacentHTML('beforeend', invCard(r));
      if (g2) {
        const map = new Map();
        rows.forEach(r => { const k = g2.of(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
        [...map.keys()].sort((a, z) => {
          const pa = a === 'Standalone', pz = z === 'Standalone';
          return pa !== pz ? (pa ? 1 : -1) : a.localeCompare(z, undefined, { numeric: true });
        }).forEach(k => {
          cards.insertAdjacentHTML('beforeend', `<div class="grp-lab">${esc(k)}
            <span class="shut">${map.get(k).length} ${map.get(k).length === 1 ? 'analysis' : 'analyses'}</span></div>`);
          map.get(k).forEach(add);
        });
      } else rows.forEach(add);
      cards.querySelectorAll('[data-inv-card]').forEach(c =>
        c.addEventListener('click', () => { location.hash = '#/analysis/' + c.dataset.invCard; }));
      cards.querySelectorAll('[data-inv-menu]').forEach(b =>
        b.addEventListener('click', ev => {
          ev.stopPropagation(); openInvRowMenu(ev.currentTarget, b.dataset.aid);
        }));
      return;
    }
    const pad = ' style="padding-left:22px"';   // both hosts are cards now
    const g = LV_GROUPS[lv.group];
    if (g) {
      const map = new Map();
      rows.forEach(r => { const k = g.of(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
      [...map.keys()].sort((a, z) => {
        // Placeholder groups (no linked project, no recorded creator) sort last
        // rather than landing wherever the alphabet puts them.
        const ph = v => v === 'Standalone' || v === 'No User';
        const pa = ph(a), pz = ph(z);
        return pa !== pz ? (pa ? 1 : -1) : a.localeCompare(z, undefined, { numeric: true });
      }).forEach(k => {
        const tr = document.createElement('tr');
        tr.className = 'inv-grp';
        tr.innerHTML = `<td colspan="11"${pad}>${esc(k)}
          <span class="shut">${map.get(k).length} ${map.get(k).length === 1 ? 'analysis' : 'analyses'}</span></td>`;
        tb.appendChild(tr);
        map.get(k).forEach(r => tb.appendChild(invListRow(r, pad)));
      });
    } else rows.forEach(r => tb.appendChild(invListRow(r, pad)));
  }

  function invCard(r) {
    return `<div class="hcard" data-inv-card="${esc(r.analysisId)}">
      <div class="hc-id">${window.creatorAvatar ? creatorAvatar(r.createdByName, r.createdByAvatar) + ' ' : ''}${esc(r.projectId || 'Standalone')}${r.sourceBudgetVersionNumber
        ? ' <span class="inv-vsub">v' + r.sourceBudgetVersionNumber + '</span>' : ''}${listDrift(r)}</div>
      <div class="hc-name">${esc(r.name)}</div>
      <div class="hc-row"><span>Purchase Price</span><span class="v">${usd(r.purchasePrice)}</span></div>
      <div class="hc-row"><span>Equity IRR</span><span class="v">${pctf(r.finalYearEquityIRR)}</span></div>
      <div class="hc-ft">${window.statusChip ? statusChip(r.status, 'analysis', r.analysisId) : esc(r.status)}
        <span>${esc(fmtDay(r.updatedAt))}</span></div>
      <button class="rowmenu-btn hc-menu" data-inv-menu data-aid="${esc(r.analysisId)}"
        aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${esc(r.name)}">⋮</button></div>`;
  }

  function invListRow(r, pad) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.addEventListener('click', () => { location.hash = '#/analysis/' + r.analysisId; });
    tr.innerHTML = `
      <td class="no-print" style="padding-left:22px">${window.creatorAvatar ? creatorAvatar(r.createdByName, r.createdByAvatar) : ''}</td>
      <td${pad}>${esc(r.name)}</td>
      <td class="mono" style="font-size:13px;color:var(--green-700);font-weight:600">${esc(r.projectId || '—')}${r.sourceBudgetVersionNumber ? ' <span class="inv-vsub" title="Created from budget version ' + r.sourceBudgetVersionNumber + '">v' + r.sourceBudgetVersionNumber + '</span>' : ''}${listDrift(r)}</td>
      <td>${window.statusChip ? statusChip(r.status, 'analysis', r.analysisId) : esc(r.status)}</td>
      <td class="calc r">${usd(r.purchasePrice)}</td>
      <td class="calc r">${usd(r.year1NOI)}</td>
      <td class="calc r">${pctf(r.finalYearEquityIRR)}</td>
      <td class="calc r">${r.optimalHoldingYear ? 'Year ' + r.optimalHoldingYear : '—'}</td>
      <td class="calc r">${r.currentVersionNumber || '—'}</td>
      <td class="calc r" style="padding-right:22px;font-size:12px;color:var(--ink-400)">${esc(fmtDay(r.updatedAt))}</td>
      <td class="no-print" style="text-align:right"><button class="rowmenu-btn" data-inv-menu
        aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${esc(r.name)}">⋮</button></td>`;
    tr.querySelector('[data-inv-menu]').addEventListener('click', ev => {
      ev.stopPropagation(); openInvRowMenu(ev.currentTarget, r.analysisId);
    });
    return tr;
  }

  function renderList() { return renderListInto(el('page-analyses'), {}); }

  function refreshLists() {
    [...listHosts].forEach(h => {
      if (!document.body.contains(h)) { listHosts.delete(h); return; }
      renderListInto(h, { embedded: h.id !== 'page-analyses' });
    });
  }

  /* ---- three-dot row menu (same classes and behavior as the budget rows) */
  let invMenuTrigger = null;
  function invMenuEl() {
    let m = el('invRowMenu');
    if (!m) {
      m = document.createElement('div');
      m.id = 'invRowMenu';
      m.className = 'rowmenu';
      m.setAttribute('role', 'menu');
      m.setAttribute('aria-hidden', 'true');
      m.style.cssText = 'position:fixed;display:none;z-index:70;background:#fff;border:1px solid var(--ink-200);border-radius:10px;box-shadow:0 8px 28px rgba(22,25,26,.14);padding:6px;min-width:180px';
      document.body.appendChild(m);
      document.addEventListener('click', e => { if (!m.contains(e.target) && e.target !== invMenuTrigger) closeInvRowMenu(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closeInvRowMenu(true); });
    }
    return m;
  }
  function openInvRowMenu(btn, analysisId) {
    const wasOpen = invMenuTrigger === btn;
    closeInvRowMenu();
    if (wasOpen) return;
    const m = invMenuEl();
    m.dataset.aid = analysisId;          // never interpolated into markup
    // The favorite label reads as the action it performs, so it flips per row.
    const fav = window.FSHome && FSHome.isFavorite('analysis', analysisId);
    const items = [
      ['open', 'Open Analysis'],
      ['fav', fav ? 'Remove From Favorites' : 'Add to Favorites'],
      ['versions', 'Versions'], ['duplicate', 'Duplicate'],
      ['sep'], ['delete', 'Delete Analysis', 'danger']
    ];
    m.innerHTML = items.map(([act, label, danger]) => act === 'sep'
      ? '<div class="rowmenu-sep"></div>'
      : `<button class="rowmenu-item${danger ? ' danger' : ''}" role="menuitem" tabindex="-1" data-act="${act}">${label}</button>`).join('');
    m.querySelectorAll('.rowmenu-item').forEach(x => { x.onclick = () => invRowMenuAction(x.dataset.act); });
    m.style.display = 'block';
    const r = btn.getBoundingClientRect();
    m.style.top = (r.bottom + 4) + 'px';
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    invMenuTrigger = btn;
    m.querySelector('.rowmenu-item').focus();
  }
  function closeInvRowMenu(refocus) {
    const m = el('invRowMenu'), t = invMenuTrigger;
    invMenuTrigger = null;
    if (m) { m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); m.innerHTML = ''; }
    if (t) { t.setAttribute('aria-expanded', 'false'); if (refocus && document.body.contains(t)) t.focus(); }
  }
  function invRowMenuAction(act) {
    const aid = el('invRowMenu').dataset.aid;
    closeInvRowMenu(act === 'delete');
    if (act === 'fav') {
      // FSHome words the toast and repaints whichever page is showing; this
      // menu opens from the project page as well as the list.
      if (window.FSHome) FSHome.toggleFavorite('analysis', aid);
      if (!A.currentPage || A.currentPage() === 'analyses') renderList();
      return;
    }
    if (act === 'open') location.hash = '#/analysis/' + aid;
    else if (act === 'versions') showVersions(aid);
    else if (act === 'duplicate') duplicate(aid);
    else if (act === 'delete') softDelete(aid);
  }

  async function createStandalone() {
    const name = (el('invNewName') && el('invNewName').value || '').trim();
    if (!name) { A.toast('Give the analysis a name first.'); return; }
    try {
      const r = await A.api('investment-analyses', { method: 'POST',
        body: JSON.stringify({ mode: 'standalone', analysisName: name }) });
      A.navigate('#/analysis/' + r.analysisId);
    } catch (e) { A.toast('Could not create the analysis — ' + e.message); }
  }

  async function createFromBudget(projectId, versionNumber, name) {
    const body = { mode: 'fromBudget', projectId };
    if (versionNumber) body.budgetVersionNumber = versionNumber;
    if (name) body.analysisName = name;
    const r = await A.api('investment-analyses', { method: 'POST', body: JSON.stringify(body) });
    A.navigate('#/analysis/' + r.analysisId);
    return r.analysisId;
  }

  /* ---- Home-page creation, mirroring the budget buttons ----
     "+ Blank Investment Analysis" creates an unlinked analysis directly (the
     name is edited on step 1); "+ New Investment Analysis" asks which project
     it is for, then snapshots that project's latest saved budget version. */
  async function createBlank() {
    try {
      const r = await A.api('investment-analyses', { method: 'POST',
        body: JSON.stringify({ mode: 'standalone', analysisName: 'Untitled Analysis' }) });
      A.toast('Blank analysis — name it on the Source & Property step.');
      A.navigate('#/analysis/' + r.analysisId);
    } catch (e) { A.toast('Could not create the analysis — ' + e.message); }
  }

  /* THE creation flow — Home and the Investment Analysis tab both open this
     one modal (same pattern as the budget's New Budget modal): link the
     analysis to a project's latest saved budget version, or start standalone. */
  async function openProjectPicker() {
    let budgets = [];
    try { budgets = await A.api('budgets'); }
    catch (e) { A.toast('Could not load the project list — ' + e.message); return; }
    const rows = budgets.map((b, i) => `<tr class="clickable" data-pick="${i}">
        <td class="mono" style="color:var(--green-700);font-weight:600">${esc(b.projectId)}</td><td>${esc(b.name || '—')}</td>
        <td>${stChipStatic(b.status)}</td>
        <td>${esc(fmtDay(b.updated))}</td></tr>`).join('');
    openInvModal(`<h2 class="mod-title">New Investment Analysis</h2>
      <div class="set-lab">From Existing Budget</div>
      <p style="font-size:12.5px;color:var(--ink-500);margin:0 0 10px">Select the project this analysis is
      for. It is created from that project's latest saved budget version — an exact snapshot, so the budget
      changing later never changes the analysis.</p>
      ${budgets.length
        ? `<div style="max-height:300px;overflow:auto;border:1px solid var(--ink-150);border-radius:8px">
           <table class="inv-table" id="invProjectPick"><thead><tr><th>Project ID</th><th>Name</th>
           <th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="empty">No budgets yet. Create a budget first, or start a standalone analysis below.</div>'}
      <div class="set-lab">Standalone Analysis</div>
      <p style="font-size:12.5px;color:var(--ink-500);margin:0 0 10px">Not linked to any budget — you enter
      every assumption yourself.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap" data-inv-edit>
        <input type="text" id="invNewName" placeholder="Analysis name (optional)" style="flex:1;min-width:200px">
        <button class="btn btn-primary" onclick="FSInvestmentUI.createStandaloneFromModal()">Create Standalone Analysis</button>
      </div>`, 560);
    el('invModal').querySelectorAll('[data-pick]').forEach(tr => tr.addEventListener('click', async () => {
      const b = budgets[+tr.dataset.pick];
      closeInvModal();
      try { await createFromBudget(b.projectId); }
      catch (e) { A.toast('Could not create the analysis — ' + e.message); }
    }));
  }

  async function createStandaloneFromModal() {
    const name = (el('invNewName') && el('invNewName').value || '').trim() || 'Untitled Analysis';
    closeInvModal();
    try {
      const r = await A.api('investment-analyses', { method: 'POST',
        body: JSON.stringify({ mode: 'standalone', analysisName: name }) });
      if (name === 'Untitled Analysis') A.toast('Blank analysis — name it on the Source & Property step.');
      A.navigate('#/analysis/' + r.analysisId);
    } catch (e) { A.toast('Could not create the analysis — ' + e.message); }
  }

  async function softDelete(id) {
    if (!confirm('Delete this investment analysis?\n\nIt can be restored by an administrator; its version history is kept.')) return;
    try {
      await A.api('investment-analysis/' + id, { method: 'DELETE' });
      A.toast('Analysis deleted.');
      const wasOpen = st.id === id;
      if (wasOpen) st.id = null;
      refreshLists();
      // Only navigate away if the deleted analysis was the open editor page.
      if (wasOpen && /#\/analysis\//.test(location.hash)) A.navigate('#/analyses');
    } catch (e) { A.toast('Delete failed — ' + e.message); }
  }

  /* ================= EDITOR ================= */
  async function open(id) {
    try {
      const r = await A.api('investment-analysis/' + id);
      st.id = r.analysisId; st.input = r.input; st.result = r.result;
      st.status = r.status || 'Draft';
      st.source = r.source; st.loadedVersion = r.currentVersionNumber;
      st.dirty = false; st.stale = false; st.busy = ''; st.step = r.result ? 6 : 1;
      st.viewingVersion = null; st.conflict = null; st.errors = {};
      // Budget-derived fields relock every time the analysis is opened: an
      // override is a decision about the edit you are making now, not a
      // property of the record.
      st.overrideSource = false;
      st.sizeSF = null; noteSizeCanonical();
      // Badge baseline: the server-stored original import (or values as
      // loaded, for analyses created before originals were stored). Editing
      // a field away from it hides its From Budget badge; putting the exact
      // value back restores it — even across a save and reload.
      snapshotOrigins();
      resetInvUndo();
      renderEditor();
    } catch (e) {
      A.toast('Could not open the analysis — ' + e.message);
      A.navigate('#/analyses');
    }
  }

  const STEPS = ['Source & Property', 'Income', 'Vacancy & Expenses', 'Mortgage', 'Disposition', 'Review & Report'];

  // Which fields make a step "complete". This drives the guided Next buttons
  // and the ✓ marks on the step pills — it never blocks the pills themselves,
  // and the server-side validator remains the real gate on calculate/save.
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  function stepComplete(n) {
    const i = st.input; if (!i) return false;
    switch (n) {
      case 1: return !!(i.analysisName && i.analysisName.trim()
        && i.property.name && i.property.name.trim()
        && isNum(i.property.size.value) && i.property.size.value > 0
        && i.property.purchaseMonth
        && isNum(i.acquisition.basis.value) && i.acquisition.basis.value > 0);
      case 2: return isNum(i.income.year1PotentialIncome) && i.income.year1PotentialIncome >= 0
        && (i.income.otherIncome || []).every(r => isNum(r.year1Amount));
      case 3: return isNum(i.expenses.value);
      case 4: {
        const L = i.financing.loans[0];
        if (!L) return true;                       // all-cash is a complete answer
        return isNum(L.amount.value) && isNum(L.annualRate)
          && isNum(L.amortizationYears) && L.amortizationYears > 0
          && isNum(L.termYears) && L.termYears > 0;
      }
      case 5: return isNum(i.disposition.exitCapRate.value) && i.disposition.exitCapRate.value > 0;
      default: return true;
    }
  }

  // The per-pane footer: a hint plus a Next button that lights up when the
  // step's required fields are in. Rendered once; state refreshed in place.
  function stepNav(n) {
    return `<div class="inv-stepnav no-print" data-stepnav="${n}">
      <span class="inv-stepnav-hint"></span>
      <button class="inv-next" data-inv-edit onclick="FSInvestmentUI.goStep(${n + 1})">
        Next: ${STEPS[n]} →</button>
    </div>`;
  }

  // Refresh the ✓ pills and every Next button without touching any input —
  // called from field changes, so focus and caret are never disturbed.
  function updateStepUI() {
    paintStepFlags();
    document.querySelectorAll('#invSteps button[data-step]').forEach(b => {
      const n = +b.dataset.step;
      if (n === 6) return;
      b.classList.toggle('done', stepComplete(n));
    });
    document.querySelectorAll('#page-analysis [data-stepnav]').forEach(nav => {
      const n = +nav.dataset.stepnav;
      const done = stepComplete(n);
      const btn = nav.querySelector('.inv-next');
      btn.disabled = !done;
      btn.classList.toggle('ready', done);
      nav.querySelector('.inv-stepnav-hint').textContent = done
        ? 'Step Complete'
        : 'Fill in the required fields on this step to continue.';
    });
  }

  // Read-only status chip (used where a click already means something else,
  // like the project picker rows). The shared classes come from index.html.
  function stChipStatic(status) {
    const n = window.normStatus ? normStatus(status) : (status || 'Draft');
    const cls = { 'Draft': 'st-draft', 'In Review': 'st-review',
      'Completed': 'st-done', 'Cancelled': 'st-cancel' }[n] || 'st-draft';
    return `<span class="st-chip ${cls}" style="pointer-events:none">${esc(n)}</span>`;
  }
  /* An analysis whose source budget has moved past the version it was built
     from is FLAGGED in the list, not quietly refreshed. The re-sync lives in
     the editor, where the consequences are visible. */
  function listDrift(r) {
    if (!r || !r.budgetDrift) return '';
    return ' <span class="inv-drift-dot" title="Budget '
      + esc(r.projectId) + ' is now at v' + esc(r.budgetCurrentVersionNumber)
      + ' — open the analysis to re-sync">v' + esc(r.budgetCurrentVersionNumber) + ' available</span>';
  }

  /* ---------- budget-derived expense ratio ----------
     The number is computed server-side from the budget version and stored with
     its provenance, so the UI only reads it. Turning Override on is a decision
     the analysis then carries visibly — on the editor, in the list, and in
     every export. */
  // Other income arrives from the budget's own other-income lines. While it
  // does, the rows are the budget's to state and only the growth rate is the
  // underwriter's to choose — so the labels, the amounts, Add and Remove all
  // go read-only together. Half a lock is no lock.
  function otherIncomeLocked() { return fromBudget('income.otherIncome'); }
  function derivedExpenses() {
    const e = st.input && st.input.expenses;
    return e && e.derivedFrom && typeof e.derivedFrom === 'object' ? e.derivedFrom : null;
  }
  function expensesOverridden() {
    return !!(st.input && st.input.expenses && st.input.expenses.override && derivedExpenses());
  }
  function expBadge() {
    const d = derivedExpenses();
    if (!d) return '';
    return expensesOverridden()
      ? ` <span class="inv-origin inv-origin-warn" title="This no longer matches budget ${esc(d.projectId)} v${esc(d.budgetVersionNumber)}">Overridden</span>`
      : ` <span class="inv-origin" title="Derived from budget ${esc(d.projectId)} v${esc(d.budgetVersionNumber)}">From Budget</span>`;
  }
  function expDerivedNote() {
    const d = derivedExpenses();
    if (!d) return '';
    const base = usd(d.annualOpex) + ' of operating expenses ÷ ' + usd(d.goi)
      + ' gross operating income (' + usd(d.grossIncomeYr) + ' less ' + pctf(d.vacancy, 1) + ' vacancy)';
    // A source budget that is itself outside the 35–55% rail cannot produce a
    // trustworthy ratio, and saying so here is the whole point of the rail.
    const ratio = d.goi > 0 ? d.annualOpex / d.goi : null;
    const bad = ratio !== null && (ratio < 0.35 || ratio > 0.55);
    return esc(base) + (bad
      ? '<br><b class="inv-warn-text">Budget ' + esc(d.projectId) + ' is at ' + pctf(ratio, 1)
        + ' — outside the 35–55% guard rail'
        + (nz(d.opexSchemaVersion) < 2 ? ' and predates the full expense schedule' : '')
        + '. This analysis will misstate NOI until the budget is corrected.</b>'
      : '');
  }
  function setExpenseOverride(on) {
    if (!st.input || !st.input.expenses) return;
    const d = derivedExpenses();
    st.input.expenses.override = !!on;
    // Turning the override back off restores the budget's number rather than
    // leaving whatever was typed sitting there looking derived.
    if (!on && d) {
      st.input.expenses.mode = 'percentOfGOI';
      st.input.expenses.value = d.goi > 0 ? Math.round((d.annualOpex / d.goi) * 10000) / 10000 : null;
    }
    markDirty();
    renderEditor();
  }

  /* ---------- budget drift ----------
     The analysis pins a budget version. When the budget moves past it we SAY so
     and offer the re-sync; nothing recalculates on its own, because a saved
     analysis is never quietly restated. */
  function driftBadge() {
    const s2 = st.source;
    if (!s2 || !s2.drift) return '';
    return ` <button class="inv-drift" onclick="FSInvestmentUI.resync()"
      title="Re-import size, purchase price, income and the expense ratio from budget v${esc(s2.budgetCurrentVersionNumber)}">
      Budget updated to v${esc(s2.budgetCurrentVersionNumber)} — Re-sync</button>`;
  }
  async function resync() {
    if (!st.id) return;
    if (st.dirty && !confirm('Re-syncing replaces the imported values with the budget\u2019s current ones. Unsaved edits to those fields will be lost. Continue?')) return;
    try {
      const r = await A.api('investment-analysis/' + st.id + '?scope=resync', { method: 'PUT', body: '{}' });
      st.input = r.input;
      st.source = r.source;
      st.dirty = true; st.stale = true; st.result = null;
      snapshotOrigins();
      renderEditor();
      A.toast(r.message + (r.expensesOverridden ? ' The expense override was kept.' : ''));
    } catch (e) {
      A.toast('Could not re-sync — ' + e.message);
    }
  }

  /* The source budget, as a real link to its Inputs page rather than plain
     text. The id comes from the analysis's own source record, never a
     constant, so it always points at the budget this analysis was cut from. */
  function sourceBudgetLink(projectId) {
    const pid = String(projectId || '');
    if (!pid) return '';
    return `<a class="inv-srclink" href="#/inputs/${esc(pid)}"
      aria-label="Open linked budget ${esc(pid)}" title="Open linked budget ${esc(pid)}"
      onclick="event.preventDefault();FSInvestmentUI.openSourceBudget('${esc(pid)}')"
      ><span class="mono">${esc(pid)}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg></a>`;
  }
  // Leaving the editor goes through the same unsaved-changes guard as any
  // other navigation — openBudget()/go() own that check.
  function openSourceBudget(projectId) {
    // The link points at #/inputs/<id>, so open that page, not the default
    // Budget page openBudget() lands on from a list row.
    if (typeof window.openBudget === 'function') window.openBudget(projectId, 'input');
    else A.navigate('#/inputs/' + projectId);
  }
  function backToList() { A.navigate('#/analyses'); }

  function paintStatusChip() {
    const h = el('invStatusHost');
    if (h) h.innerHTML = st.id && window.statusChip ? statusChip(st.status, 'analysis', st.id) : '';
  }

  function originBadge(path) {
    const src = st.input && st.input.source;
    const o = src && src.fieldOrigins && src.fieldOrigins[path];
    return o ? `<span class="inv-origin" data-origin="${esc(path)}" title="Imported: ${esc(o)} (budget version ${esc(src.budgetVersionNumber)})">From Budget</span>` : '';
  }

  /* The badge means "this value IS the budget's" — so editing a field away
     from its imported value removes it, and putting the value back restores
     it. The server stores the true import in source.originalValues, so the
     comparison survives saving and reloading an edited field; analyses
     created before that existed fall back to values-as-loaded. */
  function getPath(obj, path) {
    return path.split('.').reduce((v, k) => (v === null || v === undefined ? v : v[k]), obj);
  }
  function snapshotOrigins() {
    st.originVals = {};
    const src = st.input && st.input.source;
    if (!src || !src.fieldOrigins) return;
    const orig = src.originalValues;
    for (const path of Object.keys(src.fieldOrigins)) {
      st.originVals[path] = orig && path in orig
        ? JSON.stringify(orig[path])
        : JSON.stringify(getPath(st.input, path));
    }
  }
  function refreshOriginBadges() {
    if (!st.originVals) return;
    document.querySelectorAll('#page-analysis [data-origin]').forEach(b => {
      const path = b.dataset.origin;
      b.style.display = JSON.stringify(getPath(st.input, path)) === st.originVals[path]
        ? '' : 'none';
    });
  }

  /* ---------- budget-derived inputs are LOCKED ----------
     Every value the analysis imported from a budget version is read-only by
     default, because typing over one silently is how an analysis stops
     matching the budget it claims to come from. The card's ⋮ menu unlocks
     them for this editing session; unlocking changes NO value — it only lets
     you edit, and a field edited away from its import loses its From Budget
     badge exactly as before. */
  function srcOrigins() {
    const s = st.input && st.input.source;
    return s && s.fieldOrigins && typeof s.fieldOrigins === 'object' ? s.fieldOrigins : null;
  }
  function hasBudgetInputs() {
    const o = srcOrigins();
    return !!(o && Object.keys(o).length);
  }
  // property.size covers property.size.unit AND property.size.value; likewise
  // acquisition.basis covers its mode and its value.
  function fromBudget(path) {
    const o = srcOrigins();
    if (!o) return false;
    return Object.keys(o).some(k => path === k || path.indexOf(k + '.') === 0);
  }
  function srcLocked(path) { return !st.overrideSource && fromBudget(path); }
  const ro = path => srcLocked(path) ? ' readonly aria-readonly="true"' : '';
  const dis = path => srcLocked(path) ? ' disabled' : '';
  function setSourceOverride(on) {
    st.overrideSource = !!on;
    renderEditor();
    A.toast(on
      ? 'Budget inputs unlocked — the imported values are unchanged until you edit one.'
      : 'Budget inputs locked again.');
  }

  /* ---------- the step cards' ⋮ menus ----------
     Same element, classes, focus handling and Escape / click-outside behavior
     as the list row menus, so one menu pattern covers the whole app. */
  let stepMenuTrigger = null;
  function stepMenuEl() {
    let m = el('invStepMenu');
    if (!m) {
      m = document.createElement('div');
      m.id = 'invStepMenu';
      m.className = 'rowmenu';
      m.setAttribute('role', 'menu');
      m.setAttribute('aria-hidden', 'true');
      m.style.cssText = 'position:fixed;display:none;z-index:70;background:var(--white);border:1px solid var(--ink-200);border-radius:10px;box-shadow:0 8px 28px rgba(22,25,26,.14);padding:6px;min-width:210px';
      document.body.appendChild(m);
      document.addEventListener('click', e => {
        if (!m.contains(e.target) && e.target !== stepMenuTrigger) closeStepMenu();
      });
      document.addEventListener('keydown', e => {
        if (!stepMenuTrigger) return;
        const items = [...m.querySelectorAll('.rowmenu-item')];
        const i = items.indexOf(document.activeElement);
        const step = d => items[i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length].focus();
        if (e.key === 'Escape') { e.preventDefault(); closeStepMenu(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
        else if (e.key === 'Tab') closeStepMenu(false);
      });
    }
    return m;
  }
  function stepMenuItems(which) {
    if (which === 'expenses') {
      return expensesOverridden()
        ? [['exp-off', 'Use the Budget\u2019s Expense Ratio']]
        : [['exp-on', 'Override Budget Inputs']];
    }
    return st.overrideSource
      ? [['src-off', 'Lock Budget Inputs']]
      : [['src-on', 'Override Budget Inputs']];
  }
  function openStepMenu(btn, which) {
    const wasOpen = stepMenuTrigger === btn;
    closeStepMenu();
    if (wasOpen) return;
    const m = stepMenuEl();
    m.innerHTML = stepMenuItems(which).map(([act, label]) =>
      `<button class="rowmenu-item" role="menuitem" tabindex="-1" data-act="${act}">${label}</button>`).join('');
    m.querySelectorAll('.rowmenu-item').forEach(x => { x.onclick = () => stepMenuAction(x.dataset.act); });
    m.style.display = 'block';
    const r = btn.getBoundingClientRect();
    m.style.top = (r.bottom + 4) + 'px';
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    stepMenuTrigger = btn;
    m.querySelector('.rowmenu-item').focus();
  }
  function closeStepMenu(refocus) {
    const m = el('invStepMenu'), t = stepMenuTrigger;
    stepMenuTrigger = null;
    if (m) { m.style.display = 'none'; m.setAttribute('aria-hidden', 'true'); m.innerHTML = ''; }
    if (t) { t.setAttribute('aria-expanded', 'false'); if (refocus && document.body.contains(t)) t.focus(); }
  }
  function stepMenuAction(act) {
    closeStepMenu();
    if (act === 'src-on') setSourceOverride(true);
    else if (act === 'src-off') setSourceOverride(false);
    else if (act === 'exp-on') setExpenseOverride(true);
    else if (act === 'exp-off') setExpenseOverride(false);
  }
  // The card's ⋮ trigger, rendered only when there is something to unlock.
  function stepMenuBtn(which, label) {
    return `<button class="rowmenu-btn inv-step-menu" data-step-menu="${which}"
      aria-haspopup="menu" aria-expanded="false" aria-label="${label}" title="${label}"
      onclick="FSInvestmentUI.openStepMenu(this,'${which}')">\u22EE</button>`;
  }

  function renderEditor() {
    const host = el('page-analysis'); if (!host) return;
    const inp = st.input;
    const loan = (inp.financing && inp.financing.loans && inp.financing.loans[0]) || null;
    const dollarExp = inp.expenses && inp.expenses.mode === 'annualDollar';
    // Derived-and-locked by default; the Override checkbox is the only way to
    // type into it, and turning it on is visible everywhere the analysis is.
    const expLocked = !!derivedExpenses() && !(inp.expenses && inp.expenses.override);
    host.innerHTML = `
      <div class="page-title">
        <div><button class="btn-back" onclick="FSInvestmentUI.backToList()"
            aria-label="Back to Investment Analyses" title="Back to Investment Analyses">&larr; Back</button>
          <h1 id="invTitle">${esc(inp.analysisName)}</h1>
          <div class="sub">${st.source
            ? 'From Budget ' + sourceBudgetLink(st.source.projectId)
              + ' <span class="inv-vsub">v' + esc(st.source.budgetVersionNumber) + '</span>'
              + driftBadge()
            : 'Standalone Analysis'}</div></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center" class="no-print">
          <span id="invStatusHost"></span>
          <span class="inv-statebar" id="invState"></span>
          <button class="btn btn-ghost" data-inv-edit id="invCalcBtn" onclick="FSInvestmentUI.calculate()">Calculate</button>
          <button class="btn btn-ghost" data-inv-edit id="invSaveBtn" title="Save (Cmd/Ctrl+S)" onclick="FSInvestmentUI.save()">Save</button>
          <button class="btn btn-dark" data-inv-edit id="invExportBtn" onclick="FSInvestmentUI.openExport()">Export</button>
        </div>
      </div>
      <div id="invConflict"></div>
      <div class="wf-steps no-print" id="invSteps">${STEPS.map((s, i) =>
        `<button data-step="${i + 1}" class="${st.step === i + 1 ? 'on' : ''}" onclick="FSInvestmentUI.goStep(${i + 1})"><span class="n">${i + 1}</span>${s}</button>`).join('')}</div>
      <div id="invErrSummary"></div>

      <div class="inv-step ${st.step === 1 ? 'on' : ''}" data-steppane="1">
        <div class="inv-step-hd">
          <div class="inv-step-hd-t">
            <h2>Source &amp; Property</h2>
            <p class="hint">Review every imported value — each is a suggestion from the exact saved budget version, not a live link. The budget changing later never changes this analysis.${hasBudgetInputs()
              ? (st.overrideSource
                ? ' <b class="inv-warn-text">Budget inputs are unlocked for editing.</b>'
                : ' Budget-derived fields are locked; use the ⋮ menu to override them.')
              : ''}</p>
          </div>
          ${hasBudgetInputs() ? stepMenuBtn('source', 'Source & Property actions') : ''}
        </div>
        <div class="inv-grid">
          <label class="fld wide"><span class="lab">Analysis Name</span>
            <input type="text" data-f="analysisName" data-k="inv.analysisName" value="${esc(inp.analysisName)}"></label>
          <label class="fld wide"><span class="lab">Property Name ${originBadge('property.name')}</span>
            <input type="text" data-f="property.name" data-k="inv.property.name" value="${esc(inp.property.name)}"${ro('property.name')}></label>
          <label class="fld wide"><span class="lab">Address ${originBadge('property.address')}</span>
            <input type="text" data-f="property.address" data-k="inv.property.address" value="${esc(inp.property.address)}"${ro('property.address')}></label>
          <label class="fld"><span class="lab">Size Unit ${originBadge('property.size')}</span>
            <select data-f="property.size.unit" data-k="inv.size.unit"${dis('property.size')}>
              <option value="squareFeet" ${inp.property.size.unit === 'squareFeet' ? 'selected' : ''}>Square Feet</option>
              <option value="acres" ${inp.property.size.unit === 'acres' ? 'selected' : ''}>Acres</option>
              <option value="units" ${inp.property.size.unit === 'units' ? 'selected' : ''}>Units</option>
            </select></label>
          <label class="fld"><span class="lab">Size Value</span>
            <input type="text" inputmode="decimal" data-f="property.size.value" data-k="inv.size.value" value="${esc(fmtSizeIn(inp.property.size.value, inp.property.size.unit))}"${ro('property.size')}></label>
          <label class="fld"><span class="lab">Unit Count ${originBadge('property.unitCount')}</span>
            <input type="number" min="0" step="1" data-f="property.unitCount" data-k="inv.unitCount" value="${inp.property.unitCount === null ? '' : inp.property.unitCount}"${ro('property.unitCount')}></label>
          <label class="fld"><span class="lab">Purchase Month</span>
            <input type="month" data-f="property.purchaseMonth" data-k="inv.purchaseMonth" value="${esc(inp.property.purchaseMonth || '')}"></label>
          <label class="fld"><span class="lab">Projection Years</span>
            <select data-f="projection.years" data-k="inv.years">
              <option value="5" ${inp.projection.years === 5 ? 'selected' : ''}>5 Years</option>
              <option value="10" ${inp.projection.years === 10 ? 'selected' : ''}>10 Years</option>
            </select></label>
          <label class="fld"><span class="lab">Price Basis</span>
            <select data-f="acquisition.basis.mode" data-k="inv.basis.mode"${dis('acquisition.basis')}>
              <option value="purchasePrice" ${inp.acquisition.basis.mode === 'purchasePrice' ? 'selected' : ''}>Purchase Price ($)</option>
              <option value="acquisitionCapRate" ${inp.acquisition.basis.mode === 'acquisitionCapRate' ? 'selected' : ''}>Acquisition Cap Rate (%)</option>
            </select></label>
          <label class="fld"><span class="lab" id="invBasisLab">${inp.acquisition.basis.mode === 'acquisitionCapRate' ? 'Acquisition Cap Rate %' : 'Purchase Price'} ${originBadge('acquisition.basis')}</span>
            <input type="text" inputmode="decimal" data-f="acquisition.basis.value" data-k="inv.basis.value" value="${esc(basisDisplay(inp))}"${ro('acquisition.basis')}></label>
          <label class="fld"><span class="lab">Acquisition Costs %</span>
            <input type="text" inputmode="decimal" data-f="acquisition.costPercent" data-k="inv.costPct" value="${esc(fmtPctIn(inp.acquisition.costPercent))}"></label>
        </div>
        ${stepNav(1)}
      </div>

      <div class="inv-step ${st.step === 2 ? 'on' : ''}" data-steppane="2">
        <h2>Income</h2>
        <p class="hint">Potential rental income is gross scheduled rent before vacancy and expenses${st.source ? ' — imported as the budget’s unit-mix rent × 12, never its Net Income figure' : ''}.</p>
        <div class="inv-grid">
          <label class="fld"><span class="lab">Year-1 Potential Rental Income ${originBadge('income.year1PotentialIncome')}</span>
            <input type="text" inputmode="decimal" data-f="income.year1PotentialIncome" data-k="inv.pri" value="${esc(fmtMoneyIn(inp.income.year1PotentialIncome))}"${ro('income.year1PotentialIncome')}></label>
          <label class="fld"><span class="lab">Annual Income Growth %</span>
            <input type="text" inputmode="decimal" data-f="income.growth.value" data-k="inv.incGrowth" value="${esc(fmtPctIn(inp.income.growth.value))}"></label>
        </div>
        <h2 style="margin-top:16px;font-size:13px">Other Income ${originBadge('income.otherIncome')}</h2>
        ${otherIncomeLocked()
          ? '<p class="hint" style="margin:0 0 8px">These rows come from the budget and are read-only. Only the growth rate is yours to set.</p>'
          : ''}
        <div id="invOtherRows"></div>
        ${otherIncomeLocked() ? ''
          : '<button class="btn btn-sm btn-ghost" data-inv-edit onclick="FSInvestmentUI.addOtherIncome()">+ Add Other Income</button>'}
        <div id="invUnitMix"></div>
        <div id="invIncomeSummary"></div>
        ${stepNav(2)}
      </div>

      <div class="inv-step ${st.step === 3 ? 'on' : ''}" data-steppane="3">
        <div class="inv-step-hd">
          <div class="inv-step-hd-t">
            <h2>Vacancy &amp; Expenses</h2>
            <p class="hint">${derivedExpenses()
              ? 'The expense ratio comes from the budget — its operating expenses divided by gross operating income, after vacancy. Override it from the ⋮ menu only if this property is genuinely priced differently from the budget.'
              : 'Enter the property\u2019s complete operating expenses.'}</p>
          </div>
          ${derivedExpenses() ? stepMenuBtn('expenses', 'Vacancy & Expenses actions') : ''}
        </div>
        <div class="inv-grid">
          <label class="fld"><span class="lab">Vacancy / Credit Loss %</span>
            <input type="number" min="0" step="any" data-f="vacancy.value" data-k="inv.vacancy" value="${toPct(inp.vacancy.value)}"></label>
          <label class="fld"><span class="lab">Expense Mode</span>
            <select data-f="expenses.mode" data-k="inv.expMode" ${expLocked ? 'disabled' : ''}>
              <option value="percentOfGOI" ${!dollarExp ? 'selected' : ''}>% of GOI</option>
              <option value="annualDollar" ${dollarExp ? 'selected' : ''}>Annual $ Amount</option>
            </select></label>
          <label class="fld"><span class="lab" id="invExpLab">${dollarExp ? 'Year-1 Operating Expenses $' : 'Operating Expenses % of GOI'}${expBadge()}</span>
            <input type="number" min="0" step="any" data-f="expenses.value" data-k="inv.expValue" ${expLocked ? 'readonly' : ''}
              value="${inp.expenses.value === null ? '' : (dollarExp ? inp.expenses.value : toPct(inp.expenses.value))}"></label>
          <label class="fld" id="invExpGrowthFld" style="${dollarExp ? '' : 'display:none'}"><span class="lab">Expense Growth %</span>
            <input type="number" step="any" data-f="expenses.growth.value" data-k="inv.expGrowth" value="${toPct(inp.expenses.growth ? inp.expenses.growth.value : 0.03)}"></label>
          <!-- The provenance note is its own full-width row rather than a tail
               on the ratio field: inside the field it made that cell taller
               than its neighbours, which is what pushed the ratio out of line
               with Vacancy and Expense Mode. -->
          <span class="inv-derived inv-grid-full" id="invExpDerived">${expDerivedNote()}</span>
        </div>
        <h2 style="margin-top:16px;font-size:13px">Capital Expenses / Reserves (annual)</h2>
        <div id="invCapexRows"></div>
        <button class="btn btn-sm btn-ghost" data-inv-edit onclick="FSInvestmentUI.addCapex()">+ Add Capital Expense</button>
        <div id="invExpSupport"></div>
        ${stepNav(3)}
      </div>

      <div class="inv-step ${st.step === 4 ? 'on' : ''}" data-steppane="4">
        <h2>Mortgage</h2>
        <p class="hint">All cash, or one new fully amortizing first mortgage (30/360). Interest-only, assumed, second, and refinance loans are not supported in this release.</p>
        <label class="chk" style="margin-bottom:12px"><input type="checkbox" id="invFinanced" data-k="inv.financed" ${loan ? 'checked' : ''}> Financed with a first mortgage</label>
        <div class="inv-grid" id="invLoanFields" style="${loan ? '' : 'display:none'}">
          <label class="fld"><span class="lab">Amount Mode</span>
            <select data-f="loan.amount.mode" data-k="inv.loan.mode">
              <option value="ltv" ${!loan || loan.amount.mode === 'ltv' ? 'selected' : ''}>LTV %</option>
              <option value="amount" ${loan && loan.amount.mode === 'amount' ? 'selected' : ''}>Dollar Amount</option>
            </select></label>
          <label class="fld"><span class="lab" id="invLoanAmtLab">${loan && loan.amount.mode === 'amount' ? 'Loan Amount' : 'LTV %'}</span>
            <input type="number" min="0" step="any" data-f="loan.amount.value" data-k="inv.loan.value" value="${loan ? (loan.amount.mode === 'amount' ? loan.amount.value : toPct(loan.amount.value)) : toPct(0.65)}"></label>
          <label class="fld"><span class="lab">Annual Rate %</span>
            <input type="number" min="0" step="any" data-f="loan.annualRate" data-k="inv.loan.rate" value="${loan ? toPct(loan.annualRate) : '6.5'}"></label>
          <label class="fld"><span class="lab">Amortization (Years)</span>
            <input type="number" min="1" step="1" data-f="loan.amortizationYears" data-k="inv.loan.amort" value="${loan ? loan.amortizationYears : 25}"></label>
          <label class="fld"><span class="lab">Loan Term (Years)</span>
            <input type="number" min="1" step="1" data-f="loan.termYears" data-k="inv.loan.term" value="${loan ? loan.termYears : 5}"></label>
          <label class="fld"><span class="lab">Loan Fees / Points %</span>
            <input type="number" min="0" step="any" data-f="loan.feePercent" data-k="inv.loan.fee" value="${loan ? toPct(loan.feePercent) : '1'}"></label>
          <label class="fld"><span class="lab">Interest Calculation</span>
            <input type="text" value="30/360" disabled></label>
          <label class="fld"><span class="lab">Monthly Payment (calculated)</span>
            <input type="text" id="invMonthlyPay" value="${st.result && st.result.loans[0] ? usd2(st.result.loans[0].monthlyPayment) : '—'}" disabled></label>
        </div>
        ${stepNav(4)}
      </div>

      <div class="inv-step ${st.step === 5 ? 'on' : ''}" data-steppane="5">
        <h2>Disposition</h2>
        <p class="hint">Each hypothetical sale at the end of Year N is priced on Year N+1 NOI at the exit cap rate, rounded to the nearest $1,000; selling costs and loan payoff come out of that rounded price.</p>
        <div class="inv-grid">
          <label class="fld"><span class="lab">Exit Cap Rate %</span>
            <input type="number" min="0" step="any" data-f="disposition.exitCapRate.value" data-k="inv.exitCap" value="${toPct(inp.disposition.exitCapRate.value)}"></label>
          <label class="fld"><span class="lab">Selling Costs %</span>
            <input type="number" min="0" step="any" data-f="disposition.sellingCostPercent" data-k="inv.sellPct" value="${toPct(inp.disposition.sellingCostPercent)}"></label>
        </div>
        <label class="chk" style="margin-top:12px"><input type="checkbox" id="invSensitivity" data-k="inv.sensitivity" ${inp.reportOptions && inp.reportOptions.includeSensitivity ? 'checked' : ''}>
          Include acquisition-price sensitivity (90% – 110% of price, LTV preserved)</label>
        ${stepNav(5)}
      </div>

      <div class="inv-step ${st.step === 6 ? 'on' : ''}" data-steppane="6">
        <h2>Review &amp; Report</h2>
        <div id="invReport" class="inv-report"></div>
      </div>`;

    renderOtherIncomeRows();
    renderCapexRows();
    renderSupportTables();
    renderReport();
    renderStateBar();
    updateStepUI();
    bindEditor(host);
    // Badges compare against the server-stored originals, so a field edited
    // and SAVED must render with its badge already hidden on reload.
    refreshOriginBadges();
    // A re-render rebuilds the empty summary host, so outstanding validation
    // has to be re-applied or the banner and the amber pills disappear while
    // the problem they describe is still there.
    if (Object.keys(st.errors || {}).length) showErrors(st.errors);
    paintStatusChip();
  }

  function bindEditor(host) {
    host.querySelectorAll('[data-f]').forEach(e => {
      e.addEventListener('change', onFieldChange);
      e.addEventListener('input', () => markDirty());
    });
    const fin = el('invFinanced');
    if (fin) fin.addEventListener('change', () => {
      if (fin.checked) {
        st.input.financing.loans = [{ label: 'First Mortgage', kind: 'newAmortizing',
          amount: { mode: 'ltv', value: 0.65 }, annualRate: 0.065, amortizationYears: 25,
          termYears: 5, feePercent: 0.01, interestCalculation: '30/360' }];
      } else st.input.financing.loans = [];
      markDirty(); renderEditor();
    });
    const sens = el('invSensitivity');
    if (sens) sens.addEventListener('change', () => {
      st.input.reportOptions = { includeSensitivity: sens.checked }; markDirty();
    });
  }

  // Path-addressed writes into st.input from the form. Percent-style fields
  // convert from display percentages; basis/amount fields depend on their mode.
  function onFieldChange(ev) {
    const f = ev.target.getAttribute('data-f');
    const v = ev.target.value;
    const inp = st.input;
    const pct = fromPct(v), num = numOrNull(v);
    const loan = () => inp.financing.loans[0];
    switch (f) {
      case 'analysisName': inp.analysisName = v.trim() || inp.analysisName; el('invTitle').textContent = inp.analysisName; break;
      case 'property.name': inp.property.name = v; break;
      case 'property.address': inp.property.address = v; break;
      case 'property.size.unit': setSizeUnit(v); break;
      case 'property.size.value':
        inp.property.size.value = parseNum(v);
        noteSizeCanonical();
        break;
      case 'property.unitCount': inp.property.unitCount = num; break;
      case 'property.purchaseMonth': inp.property.purchaseMonth = v || null; break;
      case 'projection.years': {
        inp.projection.years = +v;
        // Capital-expense rows carry one amount per projection year.
        (inp.capitalExpenses || []).forEach(r => {
          r.annualAmounts = Array.from({ length: +v }, (_, i) => nz(r.annualAmounts[i]));
        });
        renderCapexRows();
        break;
      }
      case 'acquisition.basis.mode': {
        inp.acquisition.basis.mode = v; inp.acquisition.basis.value = null;
        el('invBasisLab').textContent = v === 'acquisitionCapRate' ? 'Acquisition Cap Rate %' : 'Purchase Price';
        host_input('acquisition.basis.value').value = '';
        break;
      }
      case 'acquisition.basis.value': {
        const raw = parseNum(v);
        inp.acquisition.basis.value = inp.acquisition.basis.mode === 'acquisitionCapRate'
          ? (raw === null ? null : raw / 100) : raw;
        break;
      }
      case 'acquisition.costPercent': {
        const raw = parseNum(v);
        inp.acquisition.costPercent = raw === null ? null : raw / 100;
        break;
      }
      case 'income.year1PotentialIncome':
        inp.income.year1PotentialIncome = parseNum(v);
        renderIncomeSummary();
        break;
      case 'income.growth.value': {
        const raw = parseNum(v);
        inp.income.growth.value = raw === null ? null : raw / 100;
        break;
      }
      case 'vacancy.value': inp.vacancy.value = pct; break;
      case 'expenses.mode': {
        const dollar = v === 'annualDollar';
        st.input.expenses = dollar
          ? { mode: 'annualDollar', value: null, growth: { mode: 'constant', value: 0.03 } }
          : { mode: 'percentOfGOI', value: null };
        el('invExpLab').textContent = dollar ? 'Year-1 Operating Expenses $' : 'Operating Expenses % of GOI';
        el('invExpGrowthFld').style.display = dollar ? '' : 'none';
        host_input('expenses.value').value = '';
        break;
      }
      case 'expenses.value':
        inp.expenses.value = inp.expenses.mode === 'annualDollar' ? num : pct; break;
      case 'expenses.growth.value':
        if (inp.expenses.mode === 'annualDollar') inp.expenses.growth.value = pct; break;
      case 'loan.amount.mode': {
        loan().amount.mode = v; loan().amount.value = v === 'ltv' ? 0.65 : null;
        el('invLoanAmtLab').textContent = v === 'amount' ? 'Loan Amount' : 'LTV %';
        host_input('loan.amount.value').value = v === 'ltv' ? '65' : '';
        break;
      }
      case 'loan.amount.value': loan().amount.value = loan().amount.mode === 'ltv' ? pct : num; break;
      case 'loan.annualRate': loan().annualRate = pct; break;
      case 'loan.amortizationYears': loan().amortizationYears = num; break;
      case 'loan.termYears': loan().termYears = num; break;
      case 'loan.feePercent': loan().feePercent = pct; break;
      case 'disposition.exitCapRate.value': inp.disposition.exitCapRate.value = pct; break;
      case 'disposition.sellingCostPercent': inp.disposition.sellingCostPercent = pct; break;
    }
    repaintFormatted(f);
    markDirty();
  }

  /* The formatted fields re-render from the stored NUMBER after every commit,
     so what you see is always the value the model holds — never the raw text
     that happened to produce it. This runs on change (not on input), so a
     caret is never moved mid-typing. */
  const FORMATTED = {
    'property.size.value': inp => fmtSizeIn(inp.property.size.value, inp.property.size.unit),
    'acquisition.basis.value': inp => basisDisplay(inp),
    'acquisition.costPercent': inp => fmtPctIn(inp.acquisition.costPercent),
    'income.year1PotentialIncome': inp => fmtMoneyIn(inp.income.year1PotentialIncome),
    'income.growth.value': inp => fmtPctIn(inp.income.growth.value)
  };
  function repaintFormatted(f) {
    const fmt = FORMATTED[f];
    if (!fmt) return;
    const box = host_input(f);
    if (box) box.value = fmt(st.input);
  }
  const host_input = f => document.querySelector('#page-analysis [data-f="' + f + '"]');

  function markDirty() {
    recordInvUndo();
    if (!st.dirty || !st.stale) { st.dirty = true; st.stale = !!st.result; renderStateBar(); }
    updateStepUI();          // keep the Next buttons and step dots live as fields fill in
    pruneErrors();           // and the amber clears the moment its cause is answered
    refreshOriginBadges();   // From Budget disappears when a value is edited away
  }

  /* ---- undo / redo (Cmd/Ctrl+Z · Cmd/Ctrl+Shift+Z or Ctrl+Y) ----
     The same snapshot ring the budget editor uses: the current input plus up
     to ten back, and a redo stack the same depth. Snapshots record in
     markDirty() — after every committed mutation — and the identical-snapshot
     guard means keystroke previews (which fire markDirty without mutating
     the input) never create a step. A new change after an undo clears the
     redo path. In-memory only: opening another analysis resets both stacks,
     and saved versions are never touched. */
  const INV_UNDO_MAX = 10;
  let invUndoStack = [], invRedoStack = [];
  function resetInvUndo() {
    invUndoStack = st.input ? [JSON.stringify(st.input)] : [];
    invRedoStack = [];
  }
  function recordInvUndo() {
    if (!st.input) return;
    const snap = JSON.stringify(st.input);
    if (invUndoStack[invUndoStack.length - 1] === snap) return;   // no-op mutation → no step
    invUndoStack.push(snap);
    if (invUndoStack.length > INV_UNDO_MAX + 1) invUndoStack.shift(); // current + ten back
    invRedoStack = [];                                            // a new change forks history
  }
  function restoreInvSnap(snap, msg) {
    st.input = JSON.parse(snap);
    st.dirty = true; st.stale = !!st.result; st.errors = {};
    renderEditor();
    A.toast(msg);
  }
  function undo() {
    if (!st.id || !st.input) return;
    if (invUndoStack.length < 2) { A.toast('Nothing to undo.'); return; }
    invRedoStack.push(invUndoStack.pop());
    if (invRedoStack.length > INV_UNDO_MAX) invRedoStack.shift();
    restoreInvSnap(invUndoStack[invUndoStack.length - 1], 'Undid the last change.');
  }
  function redo() {
    if (!st.id || !st.input) return;
    if (!invRedoStack.length) { A.toast('Nothing to redo.'); return; }
    const snap = invRedoStack.pop();
    invUndoStack.push(snap);
    if (invUndoStack.length > INV_UNDO_MAX + 1) invUndoStack.shift();
    restoreInvSnap(snap, 'Redid the change.');
  }

  function renderStateBar() {
    const bar = el('invState'); if (!bar) return;
    const pills = [];
    if (st.busy) pills.push('<span class="inv-pill busy">' + esc(st.busy) + '</span>');
    if (st.conflict) pills.push('<span class="inv-pill conflict">Save conflict</span>');
    if (st.dirty) pills.push('<span class="inv-pill dirty">Unsaved changes</span>');
    if (st.stale && st.result) pills.push('<span class="inv-pill stale">Result is stale — recalculate</span>');
    if (!st.dirty && !st.busy && st.loadedVersion >= 1) pills.push('<span class="inv-pill saved">Saved</span>');
    bar.innerHTML = pills.join('');
    // Both exports must match the inputs: disabled while the result is stale.
    const ex = el('invExportBtn'); if (ex) ex.disabled = !st.result || st.stale;
  }

  /* ---- dynamic rows ---- */
  function renderOtherIncomeRows() {
    const host = el('invOtherRows'); if (!host) return;
    const rows = st.input.income.otherIncome || [];
    const lock = otherIncomeLocked();
    host.innerHTML = rows.length ? `<table class="inv-table" style="max-width:640px"><thead>
      <tr><th>Label</th><th class="r">Year-1 Annual $</th><th class="r">Growth %</th>${lock ? '' : '<th></th>'}</tr></thead><tbody>` +
      rows.map((r, i) => `<tr>
        <td><input type="text" data-k="inv.other.${i}.label" value="${esc(r.label)}"${lock ? ' readonly aria-readonly="true"' : ''}
             onchange="FSInvestmentUI._other(${i},'label',this.value)"></td>
        <td class="r"><input type="${lock ? 'text' : 'number'}"${lock ? ' inputmode="decimal" readonly aria-readonly="true"' : ' min="0" step="any"'} style="width:120px" data-k="inv.other.${i}.amount"
             value="${lock ? esc(fmtMoneyIn(r.year1Amount)) : (r.year1Amount === null ? '' : r.year1Amount)}" onchange="FSInvestmentUI._other(${i},'amount',this.value)"></td>
        <td class="r"><input type="number" step="any" style="width:80px" data-k="inv.other.${i}.growth"
             value="${toPct(r.growth.value)}" onchange="FSInvestmentUI._other(${i},'growth',this.value)"></td>
        ${lock ? '' : `<td class="no-print"><button class="btn-x" data-inv-edit title="Remove row"
             onclick="FSInvestmentUI._otherRemove(${i})">×</button></td>`}</tr>`).join('') +
      '</tbody></table>' : '<div style="font-size:12.5px;color:var(--ink-500);margin:6px 0 10px">No other-income rows.</div>';
    renderIncomeSummary();
  }
  function _other(i, k, v) {
    const r = st.input.income.otherIncome[i]; if (!r) return;
    // The growth rate is the one column that stays the underwriter's while the
    // rows are the budget's.
    if (otherIncomeLocked() && k !== 'growth') return;
    if (k === 'label') r.label = v;
    if (k === 'amount') r.year1Amount = parseNum(v);
    if (k === 'growth') r.growth.value = fromPct(v) === null ? 0.03 : fromPct(v);
    markDirty();
    renderIncomeSummary();
  }
  function _otherRemove(i) {
    if (otherIncomeLocked()) return;
    st.input.income.otherIncome.splice(i, 1); markDirty(); renderOtherIncomeRows();
  }
  function addOtherIncome() {
    if (otherIncomeLocked()) return;
    st.input.income.otherIncome.push({ label: 'Other Income', year1Amount: 0, growth: { mode: 'constant', value: 0.03 } });
    markDirty(); renderOtherIncomeRows();
  }

  /* Where Year-1 total income comes from, in one place: the unit rent, the
     other-income lines, and the sum the rest of the model actually uses.
     Reads st.input only, so it stays true while the fields above are typed
     into and never has to be recalculated by hand. */
  function renderIncomeSummary() {
    const host = el('invIncomeSummary'); if (!host) return;
    const inc = st.input.income;
    const unit = nz(inc.year1PotentialIncome);
    const other = (inc.otherIncome || []).reduce((s, r) => s + nz(r.year1Amount), 0);
    host.innerHTML = `<h2 style="margin-top:16px;font-size:13px">Unit &amp; Other Income</h2>
      <table class="inv-table" style="max-width:420px"><tbody>
      <tr><td>Unit Income</td><td class="r mono">${usd(unit)}</td></tr>
      <tr><td>Other Income</td><td class="r mono">${usd(other)}</td></tr>
      <tr class="tot"><td><b>Total Income</b></td><td class="r mono"><b>${usd(unit + other)}</b></td></tr>
      </tbody></table>
      <div class="inv-provenance">Year-1 gross potential income, before vacancy and operating expenses.</div>`;
  }

  function renderCapexRows() {
    const host = el('invCapexRows'); if (!host) return;
    const rows = st.input.capitalExpenses || [];
    const yrs = st.input.projection.years || 5;
    host.innerHTML = rows.length ? `<table class="inv-table" style="max-width:${300 + yrs * 92}px"><thead>
      <tr><th>Label</th>${Array.from({ length: yrs }, (_, y) => '<th class="r">Y' + (y + 1) + '</th>').join('')}<th></th></tr></thead><tbody>` +
      rows.map((r, i) => `<tr>
        <td><input type="text" data-k="inv.capex.${i}.label" value="${esc(r.label)}"
             onchange="FSInvestmentUI._capex(${i},-1,this.value)"></td>
        ${r.annualAmounts.map((a, y) => `<td class="r"><input type="number" min="0" step="any" style="width:86px"
             data-k="inv.capex.${i}.${y}" value="${a || ''}" onchange="FSInvestmentUI._capex(${i},${y},this.value)"></td>`).join('')}
        <td class="no-print"><button class="btn-x" data-inv-edit title="Remove row"
             onclick="FSInvestmentUI._capexRemove(${i})">×</button></td></tr>`).join('') +
      '</tbody></table>' : '<div style="font-size:12.5px;color:var(--ink-500);margin:6px 0 10px">No capital expenses or reserves.</div>';
  }
  function _capex(i, y, v) {
    const r = st.input.capitalExpenses[i]; if (!r) return;
    if (y < 0) r.label = v; else r.annualAmounts[y] = nz(v);
    markDirty();
  }
  function _capexRemove(i) { st.input.capitalExpenses.splice(i, 1); markDirty(); renderCapexRows(); }
  function addCapex() {
    st.input.capitalExpenses.push({ label: 'Reserves',
      annualAmounts: Array.from({ length: st.input.projection.years || 5 }, () => 0) });
    markDirty(); renderCapexRows();
  }

  /* ---- imported support tables ---- */
  function renderSupportTables() {
    const src = st.input.source, sup = src && src.support;
    const um = el('invUnitMix');
    if (um) {
      if (sup && sup.unitMix && sup.unitMix.length) {
        const rentMo = sup.unitMix.reduce((s, u) => s + u.count * u.rent, 0);
        um.innerHTML = `<h2 style="margin-top:16px;font-size:13px">Imported Unit Mix (read-only)</h2>
          <table class="inv-table" style="max-width:520px"><thead><tr><th>Unit Type</th><th class="r">Units</th><th class="r">Rent / Mo</th><th class="r">Annual</th></tr></thead><tbody>
          ${sup.unitMix.map(u => `<tr><td>${esc(u.label)}</td><td class="r mono">${u.count}</td>
            <td class="r mono">${usd(u.rent)}</td><td class="r mono">${usd(12 * u.count * u.rent)}</td></tr>`).join('')}
          <tr class="tot"><td>Total</td><td class="r mono">${sup.unitMix.reduce((s, u) => s + u.count, 0)}</td>
            <td class="r mono">${usd(rentMo)}</td><td class="r mono">${usd(12 * rentMo)}</td></tr></tbody></table>
          <div class="inv-provenance">Reconciliation: ${usd(rentMo)}/mo scheduled rent × 12 = ${usd(12 * rentMo)} suggested Year-1 potential income.</div>`;
      } else um.innerHTML = '';
    }
    const ex = el('invExpSupport');
    if (ex) {
      if (sup && sup.serviceExpenseRows && sup.serviceExpenseRows.length) {
        const stale = nz(sup.opexSchemaVersion) < 2;
        ex.innerHTML = `<h2 style="margin-top:16px;font-size:13px">Budget Operating Expenses</h2>
          <div class="inv-warnings">${stale
            ? `These rows come from the budget's old service-expense list — utilities and trash, but no taxes,
               insurance, management or payroll. They are a <b>partial</b> picture, and the ratio derived from them
               is correspondingly low. Update the budget's expense schedule from its template to fix it at source.`
            : `The expense ratio above is derived from these rows. They are the budget's complete operating
               expense schedule, which is what the 35–55% guard rail keeps honest.`}</div>
          <table class="inv-table" style="max-width:420px"><tbody>
          ${sup.serviceExpenseRows.map(r => `<tr><td>${esc(r.label)}</td><td class="r mono">${usd(r.annualAmount)}/yr</td></tr>`).join('')}
          <tr class="tot"><td><b>Total Operating Expenses</b></td><td class="r mono"><b>${usd(sup.annualServiceExpenses)}/yr</b></td></tr>
          </tbody></table>`;
      } else ex.innerHTML = '';
    }
  }

  function goStep(n) {
    st.step = n;
    document.querySelectorAll('#invSteps button').forEach(b => b.classList.toggle('on', +b.dataset.step === n));
    document.querySelectorAll('#page-analysis .inv-step').forEach(p => p.classList.toggle('on', +p.dataset.steppane === n));
    if (n === 6 && st.result && st.stale) A.toast('Inputs changed since this result — recalculate to refresh it.');
    window.scrollTo(0, 0);
  }

  /* ---------- validation display ----------
     A banner that says "1 assumption needs attention" and stops there sends
     you hunting through six steps. Every flagged assumption is NAMED here,
     with the step it lives on and a button that goes straight to it, and the
     step pill itself carries the same amber the banner does. */
  const FIELD_STEP = [
    ['analysisName', 1, 'Analysis Name'],
    ['property.name', 1, 'Property Name'],
    ['property.address', 1, 'Address'],
    ['property.size.value', 1, 'Size Value'],
    ['property.size.unit', 1, 'Size Unit'],
    ['property.size', 1, 'Property Size'],
    ['property.unitCount', 1, 'Unit Count'],
    ['property.purchaseMonth', 1, 'Purchase Month'],
    ['projection.years', 1, 'Projection Years'],
    ['acquisition.basis.value', 1, 'Purchase Price'],
    ['acquisition.basis', 1, 'Price Basis'],
    ['acquisition.costPercent', 1, 'Acquisition Costs %'],
    ['income.year1PotentialIncome', 2, 'Year-1 Potential Rental Income'],
    ['income.growth', 2, 'Annual Income Growth %'],
    ['income.otherIncome', 2, 'Other Income'],
    ['income', 2, 'Income'],
    ['vacancy', 3, 'Vacancy / Credit Loss %'],
    ['expenses.mode', 3, 'Expense Mode'],
    ['expenses.value', 3, 'Operating Expenses'],
    ['expenses.growth', 3, 'Expense Growth %'],
    ['expenses', 3, 'Operating Expenses'],
    ['capitalExpenses', 3, 'Capital Expenses / Reserves'],
    ['financing.loans.0.amount', 4, 'Loan Amount'],
    ['financing.loans.0.annualRate', 4, 'Annual Rate %'],
    ['financing.loans.0.amortizationYears', 4, 'Amortization (Years)'],
    ['financing.loans.0.termYears', 4, 'Loan Term (Years)'],
    ['financing.loans.0.feePercent', 4, 'Loan Fees / Points %'],
    ['financing', 4, 'Mortgage'],
    ['disposition.exitCapRate', 5, 'Exit Cap Rate %'],
    ['disposition.sellingCostPercent', 5, 'Selling Costs %'],
    ['disposition', 5, 'Disposition']
  ];
  // Longest prefix wins, so expenses.value beats the bare expenses entry.
  function fieldInfo(path) {
    let best = null;
    for (const [k, step, label] of FIELD_STEP) {
      if (path === k || path.indexOf(k + '.') === 0) {
        if (!best || k.length > best.k.length) best = { k, step, label };
      }
    }
    if (!best) return { step: 6, label: path };
    // The price field is money or a rate depending on the mode it is in.
    if (best.k === 'acquisition.basis.value' && st.input
        && st.input.acquisition.basis.mode === 'acquisitionCapRate') {
      return { step: 1, label: 'Acquisition Cap Rate %' };
    }
    if (best.k === 'expenses.value' && st.input && st.input.expenses.mode === 'annualDollar') {
      return { step: 3, label: 'Year-1 Operating Expenses $' };
    }
    if (best.k === 'expenses.value') return { step: 3, label: 'Operating Expenses % of GOI' };
    return { step: best.step, label: best.label };
  }
  const inputNameFor = path => path.startsWith('financing.loans.0.')
    ? 'loan.' + path.slice('financing.loans.0.'.length) : path;

  function showErrors(fields) {
    st.errors = fields || {};
    document.querySelectorAll('#page-analysis .inv-err').forEach(e => e.classList.remove('inv-err'));
    document.querySelectorAll('#page-analysis .inv-errmsg').forEach(e => e.remove());
    const entries = Object.entries(st.errors);
    for (const [path, msg] of entries) {
      const input = host_input(inputNameFor(path));
      if (input) {
        input.classList.add('inv-err');
        const m = document.createElement('div');
        m.className = 'inv-errmsg'; m.textContent = msg;
        input.parentElement.appendChild(m);
      }
    }
    const sum = el('invErrSummary');
    if (!sum) { paintStepFlags(); return; }
    const n = entries.length;
    sum.innerHTML = n ? `<div class="inv-warnings"><b>${n} assumption${n > 1 ? 's need' : ' needs'} attention before this can calculate.</b>
      <ul class="inv-errlist">${entries.map(([path, msg]) => {
        const f = fieldInfo(path);
        return `<li><button type="button" class="inv-errjump" onclick="FSInvestmentUI.goStep(${f.step})"
          >Step ${f.step} · ${esc(STEPS[f.step - 1])}</button>
          <b>${esc(f.label)}</b> — ${esc(msg)}</li>`;
      }).join('')}</ul></div>` : '';
    paintStepFlags();
  }

  // The pills wear the banner's colour for exactly the steps the banner names.
  function paintStepFlags() {
    const flagged = new Set(Object.keys(st.errors || {}).map(p => fieldInfo(p).step));
    document.querySelectorAll('#invSteps button[data-step]').forEach(b => {
      b.classList.toggle('flag', flagged.has(+b.dataset.step));
    });
  }

  /* Flags clear as the assumptions are answered rather than waiting for the
     next Calculate — a warning that outlives its cause teaches people to
     ignore warnings. Calculate remains the real gate; the server re-validates
     everything there. */
  function pruneErrors() {
    const keys = Object.keys(st.errors || {});
    if (!keys.length) return;
    const kept = {};
    for (const k of keys) {
      const box = host_input(inputNameFor(k));
      if (box && String(box.value).trim() !== '') continue;
      kept[k] = st.errors[k];
    }
    if (Object.keys(kept).length !== keys.length) showErrors(kept);
  }

  /* ---------- calculate / save ---------- */
  async function calculate() {
    if (st.busy) return;
    st.busy = 'Calculating…'; renderStateBar();
    try {
      const r = await A.api('investment-calculations', { method: 'POST', body: JSON.stringify(st.input) });
      st.result = r.result; st.stale = false; showErrors(null);
      renderReport(); goStep(6);
      const pay = el('invMonthlyPay');
      if (pay) pay.value = st.result.loans[0] ? usd2(st.result.loans[0].monthlyPayment) : '—';
    } catch (e) {
      if (e.fields) { showErrors(e.fields); A.toast('Fix the highlighted assumptions first.'); }
      else A.toast('Calculation failed — ' + e.message);
    }
    st.busy = ''; renderStateBar();
  }

  async function save() {
    if (st.busy || !st.id) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    st.busy = 'Saving…'; st.conflict = null; renderStateBar();
    try {
      const r = await A.api('investment-analysis/' + st.id, { method: 'PUT',
        body: JSON.stringify({ input: st.input, expectedVersionNumber: st.loadedVersion }) });
      st.result = r.result; st.loadedVersion = r.versionNumber;
      st.dirty = false; st.stale = false; showErrors(null);
      renderReport();
      A.toast(r.versionCreated ? 'Saved — version ' + r.versionNumber + ' recorded.' : 'Saved — nothing meaningful changed, no new version.');
    } catch (e) {
      if (e.status === 409) {
        st.conflict = e.body || {};
        el('invConflict').innerHTML = `<div class="inv-warnings"><b>Someone saved a newer version of this analysis
          (now v${esc(st.conflict.currentVersionNumber)}).</b> Reload to see it — your current inputs will be discarded —
          or duplicate this analysis from its three-dot menu on the list to keep your variant separate.
          <div style="margin-top:8px"><button class="btn btn-sm btn-dark" onclick="FSInvestmentUI.reload()">Reload Latest</button></div></div>`;
      } else if (e.fields) { showErrors(e.fields); A.toast('Fix the highlighted assumptions first.'); }
      else A.toast('Save failed — ' + e.message);
    }
    st.busy = ''; renderStateBar();
  }

  function reload() { open(st.id); }

  // Duplicates the open analysis by default; the list row menus pass an id,
  // whose input is fetched rather than assumed loaded.
  async function duplicate(id) {
    try {
      let input = id && id !== st.id
        ? (await A.api('investment-analysis/' + id)).input
        : st.input;
      input = JSON.parse(JSON.stringify(input));
      const name = (input.analysisName || 'Analysis') + ' (Copy)';
      input.analysisName = name;
      const r = await A.api('investment-analyses', { method: 'POST',
        body: JSON.stringify({ mode: 'standalone', analysisName: name, input }) });
      A.toast('Duplicated — you are now editing the copy.');
      A.navigate('#/analysis/' + r.analysisId);
    } catch (e) { A.toast('Duplicate failed — ' + e.message); }
  }

  /* ---------- versions (opened from the three-dot row menus) ---------- */
  let versionsCtx = null;   // which analysis the open modal belongs to
  async function showVersions(id) {
    versionsCtx = id || st.id;
    try {
      const r = await A.api('investment-analysis/' + versionsCtx + '/versions');
      const rows = r.versions.map(v => `<tr onclick="FSInvestmentUI.viewVersion(${v.versionNumber})">
        <td class="mono">v${v.versionNumber}${v.isCurrent ? ' ·current' : ''}</td>
        <td>${esc(fmtWhen(v.createdAt))}</td>
        <td>${esc(v.createdByName || '—')}</td>
        <td class="r mono">${usd(v.purchasePrice)}</td>
        <td class="r mono">${pctf(v.finalYearEquityIRR)}</td></tr>`).join('');
      openInvModal(`<h2 class="mod-title">Version History</h2>
        <p style="font-size:12.5px;color:var(--ink-500)">Versions are immutable — they are shown exactly as calculated
        when saved and are never recalculated.</p>
        <table class="inv-table inv-verlist"><thead><tr><th>Version</th><th>Saved</th><th>By</th>
        <th class="r">Purchase Price</th><th class="r">Equity IRR</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">No versions yet — save the analysis first.</td></tr>'}</tbody></table>`);
    } catch (e) { A.toast('Could not load versions — ' + e.message); }
  }

  async function viewVersion(n) {
    try {
      const r = await A.api('investment-analysis/' + (versionsCtx || st.id) + '/versions/' + n);
      openInvModal(`<h2 class="mod-title">Version ${n} — Read-Only</h2>
        <div class="inv-provenance">Saved ${esc(fmtWhen(r.version.createdAt))}
        by ${esc(r.version.createdByName || '—')}</div>
        <div class="inv-report">${reportHTML(r.result)}</div>`);
    } catch (e) { A.toast('Could not load the version — ' + e.message); }
  }

  function openInvModal(html, maxWidth) {
    let m = el('invModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'invModal';
      // Centered like the budget's export modal. margin:auto on the card (not
      // align-items:center here) so a taller-than-viewport modal — the version
      // history can be — scrolls from its top instead of clipping it.
      m.style.cssText = 'position:fixed;inset:0;background:rgba(22,25,26,.45);display:flex;z-index:60;padding:24px 16px;overflow:auto';
      m.addEventListener('click', e => { if (e.target === m) m.remove(); });
      document.body.appendChild(m);
    }
    // .mod-sheet carries the shared dialog look (index.html): the card
    // system's corner radius, so this matches the New Budget popup exactly.
    m.innerHTML = `<div class="mod-sheet" style="max-width:${maxWidth || 960}px;padding:22px 26px">
      <button class="btn-x" style="position:absolute;top:14px;right:14px" title="Close" onclick="document.getElementById('invModal').remove()">×</button>
      ${html}</div>`;
  }
  function closeInvModal() { const m = el('invModal'); if (m) m.remove(); }

  /* ================= REPORT ================= */
  function renderReport() {
    const host = el('invReport'); if (!host) return;
    if (!st.result) {
      host.innerHTML = `<div class="empty">No calculation yet. Complete the assumptions, then
        <button class="btn btn-sm btn-dark" data-inv-edit onclick="FSInvestmentUI.calculate()">Calculate</button></div>`;
      return;
    }
    host.innerHTML = (st.stale ? '<div class="inv-warnings"><b>Inputs changed since this result was calculated.</b> Recalculate to refresh it.</div>' : '')
      + reportHTML(st.result);
  }

  function reportHTML(R) {
    const s = R.summary, loan = R.loans[0] || null, years = R.annual;
    const hdr = years.map(a => `<th>Y${a.year}<br><span style="font-weight:400">${esc(a.periodEnd)}</span></th>`).join('');
    const row = (label, f, cls) => `<tr${cls ? ' class="' + cls + '"' : ''}><td>${label}</td>${years.map(a => {
      const v = f(a); return `<td${v === '—' ? ' class="na"' : ''}>${v}</td>`; }).join('')}</tr>`;
    const t = inner => `<div class="inv-rpt-scroll"><table class="inv-rpt"><thead><tr><th></th>${hdr}</tr></thead><tbody>${inner}</tbody></table></div>`;

    let h = `<div class="inv-kpis">
      <div class="kpi"><div class="k">Purchase Price</div><div class="v">${usd(s.purchasePrice)}</div></div>
      <div class="kpi"><div class="k">Acquisition Cap</div><div class="v">${pctf(s.acquisitionCapRate)}</div></div>
      <div class="kpi"><div class="k">Initial Equity</div><div class="v">${usd(s.initialEquity)}</div></div>
      <div class="kpi"><div class="k">Year-1 NOI</div><div class="v">${usd(s.year1NOI)}</div></div>
      <div class="kpi"><div class="k">Equity IRR</div><div class="v">${pctf(s.finalYearEquityIRR)}</div></div>
      <div class="kpi"><div class="k">Optimal Hold</div><div class="v">${s.optimalHoldingYear ? 'Year ' + s.optimalHoldingYear + ' · ' + pctf(s.optimalHoldingYield) : '—'}</div></div>
    </div>`;

    h += `<h3>Acquisition &amp; Initial Investment</h3>
      <div class="inv-rpt-scroll"><table class="inv-rpt" style="max-width:560px"><tbody>
      <tr><td>Purchase Price</td><td>${usd(s.purchasePrice)}</td></tr>
      <tr><td>Acquisition Costs</td><td>${usd(s.acquisitionCosts)}</td></tr>
      ${loan ? `<tr><td>Loan Fees</td><td>${usd(s.loanFees)}</td></tr>` : ''}
      <tr><td>Unleveraged Investment</td><td>${usd(s.unleveragedInitialInvestment)}</td></tr>
      ${loan ? `<tr><td>Less: Loan Principal</td><td>(${usd(loan.principal)})</td></tr>` : ''}
      <tr class="tot"><td>Initial Equity Investment</td><td>${usd(s.initialEquity)}</td></tr>
      <tr><td>Gross Rent Multiplier</td><td>${rat(s.grossRentMultiplier)}</td></tr>
      ${s.pricePerSquareFoot !== null ? `<tr><td>Price / SF</td><td>${usd2(s.pricePerSquareFoot)}</td></tr>` : ''}
      ${s.pricePerUnit !== null ? `<tr><td>Price / Unit</td><td>${usd(s.pricePerUnit)}</td></tr>` : ''}
      </tbody></table></div>`;

    if (loan) {
      h += `<h3>Mortgage</h3>
        <div class="inv-rpt-scroll"><table class="inv-rpt" style="max-width:560px"><tbody>
        <tr><td>${esc(loan.label)}</td><td>${usd(loan.principal)}</td></tr>
        <tr><td>Rate · Amortization · Term</td><td>${(loan.annualRate * 100).toFixed(3)}% · ${loan.amortizationYears}y · ${loan.termYears}y</td></tr>
        <tr><td>Interest Calculation</td><td>${esc(loan.interestCalculation)}</td></tr>
        <tr><td>Monthly Payment</td><td>${usd2(loan.monthlyPayment)}</td></tr>
        <tr class="tot"><td>Annual Debt Service</td><td>${usd(loan.annualDebtService)}</td></tr>
        <tr><td>Initial LTV</td><td>${pctf(s.initialLTV)}</td></tr>
        </tbody></table></div>`;
    }

    h += '<h3>Operating Projection</h3>' + t(
      row('Potential Rental Income', a => usd(a.potentialIncome))
      + row('Less: Vacancy / Credit Loss', a => '(' + usd(a.vacancyLoss) + ')')
      + row('Effective Rental Income', a => usd(a.effectiveRentalIncome))
      + row('Other Income', a => usd(a.otherIncome))
      + row('Gross Operating Income', a => usd(a.grossOperatingIncome), 'tot')
      + row('Operating Expenses', a => '(' + usd(a.operatingExpenses) + ')')
      + row('Net Operating Income', a => usd(a.netOperatingIncome), 'tot')
      + row('Capital Expenses / Reserves', a => a.capitalExpenses ? '(' + usd(a.capitalExpenses) + ')' : '—')
      + row('Debt Service', a => a.debtService ? '(' + usd(a.debtService) + ')' : '—')
      + row('Cash Flow Before Taxes', a => usd(a.cashFlowBeforeTaxes), 'tot'));

    h += '<h3>Hypothetical Sale at End of Each Year</h3>' + t(
      row('Gross Sale Price (Year+1 NOI ÷ exit cap, nearest $1,000)', a => usd(a.grossSalePrice))
      + row('Selling Costs', a => '(' + usd(a.sellingCosts) + ')')
      + row('Loan Payoff', a => a.endingLoanBalance ? '(' + usd(a.endingLoanBalance) + ')' : '—')
      + row('Net Sale Proceeds', a => usd(a.netSaleProceeds), 'tot'));

    if (loan) {
      h += '<h3>LTV · DSCR · Debt Yield</h3>' + t(
        row('Projected LTV (balance ÷ sale value)', a => pctf(a.projectedLTV))
        + row('DSCR (NOI ÷ debt service)', a => rat(a.dscr))
        + row('Debt Yield (NOI ÷ original loan)', a => pctf(a.debtYield)));
    }

    h += '<h3>Returns</h3>' + t(
      row('Cash-on-Cash (CFBT ÷ initial equity)', a => pctf(a.cashOnCash))
      + row('Return on Equity (CFBT ÷ net sale proceeds)', a => pctf(a.returnOnEquity))
      + row('Equity Multiple', a => mult(a.equityMultiple)));

    h += '<h3>IRR &amp; Leverage by Sale Year</h3>' + t(
      row('Property IRR (unleveraged)', a => pctf(a.propertyIRR))
      + (loan ? row('Effective Borrowing Rate', a => pctf(a.effectiveLoanRate)) : '')
      + row('Equity IRR (leveraged)', a => pctf(a.equityIRR))
      + (loan ? row('Leverage Impact', a => leveragePct(a), 'tot') : ''))
      + `<div class="inv-provenance">Optimal holding period: ${s.optimalHoldingYear ? 'Year ' + s.optimalHoldingYear + ' at ' + pctf(s.optimalHoldingYield) + ' equity IRR' : 'not determinable'}.
      ${loan ? ' Leverage is positive when the equity IRR exceeds the property IRR.' : ''}</div>`;

    if (R.sensitivity) {
      const sens = R.sensitivity;
      const shdr = sens.map(x => `<th>${usd(x.purchasePrice)}<br><span style="font-weight:400">${Math.round(x.factor * 100)}%</span></th>`).join('');
      const srow = (label, f) => `<tr><td>${label}</td>${sens.map(x => `<td>${f(x)}</td>`).join('')}</tr>`;
      const seriesRows = (label, key) => years.map((_, y) =>
        srow(label + ' — Sale Y' + (y + 1), x => pctf(x[key][y]))).join('');
      h += `<h3>Acquisition-Price Sensitivity</h3>
        <div class="inv-rpt-scroll"><table class="inv-rpt"><thead><tr><th></th>${shdr}</tr></thead><tbody>
        ${srow('Acquisition Cap Rate', x => pctf(x.acquisitionCapRate))}
        ${srow('Initial Equity', x => usd(x.initialEquity))}
        ${seriesRows('Unleveraged CoC', 'unleveragedCoC')}
        ${seriesRows('Leveraged CoC', 'leveragedCoC')}
        ${seriesRows('Unleveraged IRR', 'unleveragedIRR')}
        ${seriesRows('Leveraged IRR', 'leveragedIRR')}
        </tbody></table></div>`;
    }

    if (R.warnings && R.warnings.length) {
      h += `<div class="inv-warnings"><b>Warnings</b><ul>${R.warnings.map(w => '<li>' + esc(w) + '</li>').join('')}</ul></div>`;
    }

    const src = R.normalizedInput && R.normalizedInput.source;
    h += `<h3>Assumptions &amp; Provenance</h3>
      <div class="inv-provenance">
      ${src ? 'Created from Budget <span class="mono">' + esc(src.projectId) + '</span> <span class="inv-vsub">v' + esc(src.budgetVersionNumber) + '</span>'
            + (src.importedAt ? ' (imported ' + esc(fmtDay(src.importedAt)) + ')' : '') + '.' : 'Standalone Analysis.'}
      Vacancy ${pctf(R.normalizedInput.vacancy.value)} · expenses ${R.normalizedInput.expenses.mode === 'percentOfGOI'
        ? pctf(R.normalizedInput.expenses.value) + ' of GOI'
        : usd(R.normalizedInput.expenses.value) + '/yr growing ' + pctf(R.normalizedInput.expenses.growth.value)}
      · income growth ${pctf(R.normalizedInput.income.growth.value)}
      · acquisition costs ${pctf(R.normalizedInput.acquisition.costPercent)}
      · exit cap ${pctf(R.normalizedInput.disposition.exitCapRate.value)}
      · selling costs ${pctf(R.normalizedInput.disposition.sellingCostPercent)}.
      </div>`;
    return h;
  }

  /* ================= EXPORT (modal, options, PDF, workbook) =================
     One Export button, like the budget: a modal picks the sections and
     options, then produces either format from the same canonical result. */
  const exOpts = { kpis: true, cash: true, sale: true, returns: true, sens: true,
    assumptions: true, highlight: false, signature: false };
  const EX_IDS = { kpis: 'inv-ex-kpis', cash: 'inv-ex-cash', sale: 'inv-ex-sale',
    returns: 'inv-ex-returns', sens: 'inv-ex-sens', assumptions: 'inv-ex-assump',
    highlight: 'inv-ex-highlight', signature: 'inv-ex-signature' };

  function openExport() {
    if (!st.result || st.stale) { A.toast('Calculate first so the exports match the inputs.'); return; }
    // Remembered export options (Settings → Exports) seed the checkboxes.
    const saved = A.exportDefaults && A.exportDefaults('analysis');
    if (saved) for (const k in EX_IDS) if (typeof saved[k] === 'boolean') exOpts[k] = saved[k];
    const chk = (k, label, title) => `<label class="chk"${title ? ' title="' + title + '"' : ''}>
      <input type="checkbox" id="${EX_IDS[k]}" ${exOpts[k] ? 'checked' : ''}> ${label}</label>`;
    // The button row matches the budget export modal exactly — one order
    // everywhere: Email (Soon) · Print · PDF · Excel (.xlsx).
    openInvModal(`<h2 class="mod-title">Export Analysis</h2>
      <div class="eyebrow" style="margin-bottom:12px">Include Sections</div>
      <div style="display:grid;gap:12px;margin-bottom:24px">
        ${chk('kpis', 'Summary &amp; Key Metrics')}
        ${chk('cash', 'Operating Projection')}
        ${chk('sale', 'Hypothetical Sale by Year')}
        ${chk('returns', 'Returns &amp; Leverage')}
        ${chk('sens', 'Acquisition-Price Sensitivity')}
        ${chk('assumptions', 'Assumptions &amp; Provenance',
          'The Excel workbook always carries its Assumptions sheet as the provenance record; this governs the PDF section')}
      </div>
      <div class="eyebrow" style="margin-bottom:12px">Options</div>
      <div style="display:grid;gap:12px;margin-bottom:24px">
        ${chk('highlight', 'Highlight Key Metrics',
          'Light green highlight on GOI, NOI, Purchase Price, Initial Investment, Equity Multiple, Cash-on-Cash and IRR in the PDF')}
        ${chk('signature', 'Signature Needed',
          'Adds a final approval page to the PDF with signature and date lines, identified so it cannot be attached to any other analysis')}
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;align-items:center;flex-wrap:wrap">
        <button class="btn btn-ghost btn-soon" aria-disabled="true"
          title="Coming soon — emailing exports is not built yet"
          onclick="FSInvestmentUI.emailSoon()">Email <span class="soon-pill">Soon</span></button>
        <button class="btn btn-ghost" title="Open the browser print dialog with the composed report"
          onclick="FSInvestmentUI.exportPrint()">Print</button>
        <button class="btn btn-primary" title="Download the branded PDF report"
          onclick="FSInvestmentUI.exportPDF()">PDF</button>
        <button class="btn btn-ghost" title="Download the branded Excel workbook"
          onclick="FSInvestmentUI.exportWorkbook()">Excel (.xlsx)</button>
      </div>`, 580);
    // Any change becomes the account default when Settings says to remember.
    el('invModal').querySelectorAll('input[type=checkbox]').forEach(c =>
      c.addEventListener('change', () => {
        readExportOpts();
        if (A.rememberExport) A.rememberExport('analysis', Object.assign({}, exOpts));
      }));
  }
  function emailSoon() { A.toast('Emailing exports is coming soon.'); }

  // The modal's checkboxes win when it is open; direct calls keep the last
  // (or default all-sections, no-highlight) choices.
  function readExportOpts() {
    for (const k in EX_IDS) {
      const c = document.getElementById(EX_IDS[k]);
      if (c) exOpts[k] = c.checked;
    }
  }

  function exportBaseName() {
    return ((st.input && st.input.analysisName) || 'Investment_Analysis')
      .replace(/[^\w]+/g, '_') + '_Investment_Analysis';
  }
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function exportDoc() {
    return FSExportRender.buildExportDoc(st.result, exOpts,
      { savedVersion: st.loadedVersion, generatedAt: new Date().toISOString() });
  }
  // The fsdoc/1 + fs-render path: content from the producer, layout from the
  // engine. Ten-year projections carry 11 matrix columns, which physically
  // need landscape on letter (the engine's stated policy); five-year docs
  // keep the house-portrait preset.
  function fsdocOf(doc) {
    return FSToFsdoc.toFsdoc(doc,
      { docId: st.id ? st.id + (st.loadedVersion ? '-v' + st.loadedVersion : '') : undefined });
  }
  function pdfPreset(doc) { return doc.meta.years > 5 ? 'landscape' : 'portrait'; }
  const FS_THEME = () => fsRender.themes['finishes-solutions'];
  // FS_EXPORT_RENDERER: the app shell resolves the setting (env via
  // /api/export-config, localStorage override); 'local' falls back to the
  // frozen pre-cutover renderers in legacy-render.js.
  const useLegacy = () => typeof exportRenderer === 'function' && exportRenderer() === 'local';

  /* ---- PDF: a real .pdf file — fsdoc/1 rendered by the vendored fs-render
     engine through pdfmake and downloaded directly, no print dialog. The
     Signature Needed approval page is a suite policy appended after. */
  function exportPDF() {
    if (!st.result || st.stale) { A.toast('Calculate first so the PDF matches the inputs.'); return; }
    if (typeof pdfMake === 'undefined' || typeof fsRender === 'undefined') {
      A.toast('PDF library is unavailable — reload the page.'); return;
    }
    readExportOpts(); closeInvModal();
    const doc = exportDoc();
    let dd;
    if (useLegacy()) {
      dd = FSLegacyRender.buildPdfDocDefinition(doc);   // renders doc.signature itself
      FSExportRender.stampRenderProvenance(dd, 'local');
    } else {
      dd = fsRender.buildPdfDocDefinition(fsdocOf(doc), FS_THEME(), pdfPreset(doc));
      FSExportRender.stampRenderProvenance(dd, 'engine');
      FSExportRender.appendApprovalPage(dd, doc.signature);
    }
    pdfMake.createPdf(dd).getBlob(blob => {
      downloadBlob(blob, exportBaseName() + '.pdf');
      if (A.activity) A.activity('export_pdf', 'analysis', st.id);
    });
  }

  /* ---- Print: the original #printDoc pipeline via the adapter — the same
     print-styled classes the budget report uses. Kept as a third option. */
  function exportPrint() {
    if (!st.result || st.stale) { A.toast('Calculate first so the print matches the inputs.'); return; }
    readExportOpts(); closeInvModal();
    A.print(printReportHTML(st.result, exOpts));
    if (A.activity) A.activity('export_print', 'analysis', st.id);
  }

  function printReportHTML(R, opts) {
    const o = opts || exOpts;
    const s = R.summary, loan = R.loans[0] || null, years = R.annual, N = R.normalizedInput;
    const src = N.source;
    const stamp = fmtWhen(new Date());
    const rr = (k, v, cls) => '<div class="rr ' + (cls || '') + '"><span>' + k + '</span><span class="v">' + v + '</span></div>';
    const tbl = (headers, rows) => '<table class="rpt-tbl full"><thead><tr>'
      + headers.map((h, i) => '<th' + (i ? ' class="r"' : '') + '>' + h + '</th>').join('')
      + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    const seriesRow = (label, f, tot, hl) => {
      const cls = ((tot ? 'tot' : '') + (hl && o.highlight ? ' hl' : '')).trim();
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + label + '</td>'
        + years.map(a => '<td class="r mono">' + f(a) + '</td>').join('') + '</tr>';
    };
    const hlc = base => o.highlight ? (base ? base + ' hl' : 'hl') : (base || '');
    const yearHeads = ['', ...years.map(a => 'Y' + a.year + ' · ' + a.periodEnd)];

    let h = `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
      <div>
        <div class="eyebrow">Finishes Solutions · Investment Analysis · ${years.length}-Year Before-Tax</div>
        <div style="font-size:17pt;font-weight:800">${esc(N.property.name)}</div>
        <div class="muted" style="font-size:9pt">${esc(N.analysisName)}${N.property.address ? ' · ' + esc(N.property.address) : ''}</div>
      </div>
      <div class="muted" style="text-align:right;font-size:8.5pt">${esc(stamp)}<br>
        ${src ? 'From Budget <span class="mono">' + esc(src.projectId) + '</span> <span class="inv-vsub">v' + esc(src.budgetVersionNumber) + '</span>' : 'Standalone Analysis'}${st.loadedVersion ? '<br>Analysis v' + st.loadedVersion : ''}</div>
    </div>`;

    // The KPI band never highlights — Highlight Key Metrics marks only the
    // table and line-item rows further down, per the owner's preference.
    if (o.kpis) {
    h += '<section class="rpt-stats">'
      + [['Purchase Price', usd(s.purchasePrice)], ['Acquisition Cap', pctf(s.acquisitionCapRate)],
         ['Initial Equity', usd(s.initialEquity)], ['Equity IRR', pctf(s.finalYearEquityIRR)],
         ['Optimal Hold', s.optimalHoldingYear ? 'Year ' + s.optimalHoldingYear + ' · ' + pctf(s.optimalHoldingYield) : '—']]
        .map(([k, v]) => '<div><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join('')
      + '</section>';

    h += '<section class="rpt-sec"><h2>Acquisition &amp; Initial Investment</h2><div class="rpt-2col"><div>'
      + rr('Purchase Price', usd(s.purchasePrice), hlc(''))
      + rr('Acquisition Costs (' + pctf(N.acquisition.costPercent) + ')', usd(s.acquisitionCosts))
      + (loan ? rr('Loan Fees (' + pctf(loan.feePercent) + ')', usd(s.loanFees)) : '')
      + rr('Unleveraged Investment', usd(s.unleveragedInitialInvestment), 'mid')
      + (loan ? rr('Less: Loan Principal', '(' + usd(loan.principal) + ')') : '')
      + rr('Initial Equity Investment', usd(s.initialEquity), hlc('grand'))
      + '</div><div>'
      + rr('Gross Rent Multiplier', rat(s.grossRentMultiplier))
      + (s.pricePerSquareFoot !== null ? rr('Price / SF', usd2(s.pricePerSquareFoot)) : '')
      + (s.pricePerUnit !== null ? rr('Price / Unit', usd(s.pricePerUnit)) : '')
      + (loan
        ? rr(esc(loan.label) + ' — ' + (loan.annualRate * 100).toFixed(3) + '% · ' + loan.amortizationYears + 'y am · ' + loan.termYears + 'y term', usd(loan.principal))
          + rr('Monthly Payment (30/360)', usd2(loan.monthlyPayment))
          + rr('Annual Debt Service', usd(loan.annualDebtService))
          + rr('Initial LTV', pctf(s.initialLTV))
        : rr('Financing', 'All cash'))
      + '</div></div></section>';
    }

    if (o.cash) {
    h += '<section class="rpt-sec"><h2>Operating Projection</h2>'
      + tbl(yearHeads, [
          seriesRow('Potential Rental Income', a => usd(a.potentialIncome)),
          seriesRow('Less: Vacancy / Credit Loss (' + pctf(N.vacancy.value) + ')', a => '(' + usd(a.vacancyLoss) + ')'),
          seriesRow('Effective Rental Income', a => usd(a.effectiveRentalIncome)),
          seriesRow('Other Income', a => usd(a.otherIncome)),
          seriesRow('Gross Operating Income', a => usd(a.grossOperatingIncome), true, true),
          seriesRow('Operating Expenses', a => '(' + usd(a.operatingExpenses) + ')'),
          seriesRow('Net Operating Income', a => usd(a.netOperatingIncome), true, true),
          seriesRow('Capital Expenses / Reserves', a => a.capitalExpenses ? '(' + usd(a.capitalExpenses) + ')' : '—'),
          seriesRow('Debt Service', a => a.debtService ? '(' + usd(a.debtService) + ')' : '—'),
          seriesRow('Cash Flow Before Taxes', a => usd(a.cashFlowBeforeTaxes), true)
        ]) + '</section>';
    }

    if (o.sale) {
    h += '<section class="rpt-sec"><h2>Hypothetical Sale at End of Each Year</h2>'
      + '<p class="rpt-note">Each sale is priced on the following year’s NOI at the '
      + pctf(N.disposition.exitCapRate.value) + ' exit cap, rounded to the nearest $1,000; selling costs ('
      + pctf(N.disposition.sellingCostPercent) + ') and the loan payoff come out of that rounded price.</p>'
      + tbl(yearHeads, [
          seriesRow('Gross Sale Price', a => usd(a.grossSalePrice)),
          seriesRow('Selling Costs', a => '(' + usd(a.sellingCosts) + ')'),
          seriesRow('Loan Payoff', a => a.endingLoanBalance ? '(' + usd(a.endingLoanBalance) + ')' : '—'),
          seriesRow('Net Sale Proceeds', a => usd(a.netSaleProceeds), true)
        ]) + '</section>';
    }

    if (o.returns) {
    h += '<section class="rpt-sec"><h2>Returns' + (loan ? ', Debt Coverage' : '') + ' &amp; Leverage</h2>'
      + tbl(yearHeads, [
          ...(loan ? [
            seriesRow('Projected LTV', a => pctf(a.projectedLTV)),
            seriesRow('DSCR', a => rat(a.dscr)),
            seriesRow('Debt Yield', a => pctf(a.debtYield))] : []),
          seriesRow('Cash-on-Cash', a => pctf(a.cashOnCash), false, true),
          seriesRow('Return on Equity', a => pctf(a.returnOnEquity)),
          seriesRow('Equity Multiple', a => mult(a.equityMultiple), false, true),
          seriesRow('Property IRR (unleveraged)', a => pctf(a.propertyIRR), false, true),
          ...(loan ? [seriesRow('Effective Borrowing Rate', a => pctf(a.effectiveLoanRate))] : []),
          seriesRow('Equity IRR (leveraged)', a => pctf(a.equityIRR), true, true),
          ...(loan ? [seriesRow('Leverage Impact', a => leveragePct(a))] : [])
        ])
      + '<p class="rpt-note">Optimal holding period: ' + (s.optimalHoldingYear
          ? 'Year ' + s.optimalHoldingYear + ' at ' + pctf(s.optimalHoldingYield) + ' equity IRR'
          : 'not determinable') + '.</p></section>';
    }

    if (o.sens && R.sensitivity) {
      h += '<section class="rpt-sec"><h2>Acquisition-Price Sensitivity</h2>'
        + '<p class="rpt-note">Scenarios at 90–110% of the base price; base LTV, rates, operating cash flows and terminal sale prices preserved.</p>'
        + tbl(['', ...R.sensitivity.map(x => Math.round(x.factor * 100) + '% · ' + usd(x.purchasePrice))],
          [
            '<tr><td>Acquisition Cap Rate</td>' + R.sensitivity.map(x => '<td class="r mono">' + pctf(x.acquisitionCapRate) + '</td>').join('') + '</tr>',
            '<tr><td>Initial Equity</td>' + R.sensitivity.map(x => '<td class="r mono">' + usd(x.initialEquity) + '</td>').join('') + '</tr>',
            ...years.map((_, y) => '<tr><td>Leveraged CoC — Sale Y' + (y + 1) + '</td>'
              + R.sensitivity.map(x => '<td class="r mono">' + pctf(x.leveragedCoC[y]) + '</td>').join('') + '</tr>'),
            ...years.map((_, y) => '<tr' + (y === years.length - 1 ? ' class="tot"' : '') + '><td>Leveraged IRR — Sale Y' + (y + 1) + '</td>'
              + R.sensitivity.map(x => '<td class="r mono">' + pctf(x.leveragedIRR[y]) + '</td>').join('') + '</tr>')
          ]) + '</section>';
    }

    if (o.assumptions) {
    h += '<section class="rpt-sec"><h2>Assumptions</h2><div class="rpt-2col"><div>'
      + rr('Property Size', N.property.size.value + ' ' + (N.property.size.unit === 'squareFeet' ? 'SF' : N.property.size.unit))
      + rr('Purchase Month', N.property.purchaseMonth)
      + rr('Year-1 Potential Income', usd(N.income.year1PotentialIncome))
      + rr('Income Growth', pctf(N.income.growth.value))
      + rr('Vacancy / Credit Loss', pctf(N.vacancy.value))
      + '</div><div>'
      + rr('Operating Expenses', N.expenses.mode === 'percentOfGOI'
          ? pctf(N.expenses.value) + ' of GOI'
          : usd(N.expenses.value) + '/yr, growing ' + pctf(N.expenses.growth.value))
      + rr('Acquisition Costs', pctf(N.acquisition.costPercent))
      + rr('Exit Cap Rate', pctf(N.disposition.exitCapRate.value))
      + rr('Selling Costs', pctf(N.disposition.sellingCostPercent))
      + '</div></div>'
      + (R.warnings && R.warnings.length
          ? '<p class="rpt-note"><b>Warnings:</b> ' + R.warnings.map(esc).join(' · ') + '</p>' : '')
      + '</section>';
    }
    // The engine identity lives only here on the PDF (and on the workbook's
    // Assumptions sheet) — never on the app UI.
    h += '<p class="rpt-note" style="margin-top:20px">Calculated by engine <span class="mono">'
      + esc(R.calculationVersion) + '</span> · input schema v' + R.inputSchemaVersion + '</p>';

    // Signature Needed: the approval page, always last, identified so a
    // signed page cannot be attached to a different analysis.
    if (o.signature) {
      h += `<section class="rpt-sec rpt-sig"><h2>Approval</h2>
        <p class="rpt-note">The signature below approves the investment analysis identified here, exactly as
        calculated and presented in this document. The identification binds this approval page to this document
        alone — an approval page whose identification does not match the document it accompanies is void.</p>
        <div class="rpt-2col"><div>`
        + rr('Analysis', esc(N.analysisName))
        + rr('Property', esc(N.property.name) + (N.property.address ? ' · ' + esc(N.property.address) : ''))
        + rr('Source', src ? 'Budget <span class="mono">' + esc(src.projectId) + '</span> <span class="inv-vsub">v' + esc(src.budgetVersionNumber) + '</span>' : 'Standalone Analysis')
        + rr('Saved Analysis Version', st.loadedVersion ? 'v' + st.loadedVersion : '(unsaved)')
        + rr('Projection', years.length + '-Year Before-Tax')
        + '</div><div>'
        + rr('Purchase Price', usd(s.purchasePrice))
        + rr('Initial Equity Investment', usd(s.initialEquity))
        + rr('Final-Year Equity IRR', pctf(s.finalYearEquityIRR))
        + rr('Calculation Engine', '<span class="mono">' + esc(R.calculationVersion) + '</span> · schema v' + R.inputSchemaVersion)
        + rr('Generated', esc(stamp))
        + '</div></div>'
        + '<div class="sig-row"><div class="s1"><div class="sig-line"></div><div class="sig-cap">Signature</div></div>'
        + '<div class="s2"><div class="sig-line"></div><div class="sig-cap">Date</div></div></div></section>';
    }
    return h;
  }

  /* ================= EXCEL WORKBOOK =================
     Built by the fs-render engine from the same fsdoc/1 the PDF uses —
     branded bands, frozen headers, landscape fitted printing come from the
     engine's default preset. Tables only; no charts, no media, ever. */
  async function exportWorkbook() {
    if (!st.result || st.stale) { A.toast('Calculate first so the workbook matches the inputs.'); return; }
    if (typeof ExcelJS === 'undefined' || typeof fsRender === 'undefined') {
      A.toast('Excel library is unavailable — reload the page.'); return;
    }
    readExportOpts(); closeInvModal();
    const doc = exportDoc();
    const wb = useLegacy()
      ? FSLegacyRender.buildWorkbook(ExcelJS, doc)
      : fsRender.buildWorkbook(ExcelJS, fsdocOf(doc), FS_THEME());
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      exportBaseName() + '.xlsx');
    if (A.activity) A.activity('export_xlsx', 'analysis', st.id);
  }

  /* ================= public surface ================= */
  window.FSInvestmentUI = {
    init(adapter) { A = adapter; },
    renderList, renderListInto, open, createFromBudget, createStandalone,
    openSourceBudget, backToList, resync, setExpenseOverride, setSourceOverride,
    openStepMenu, openInvRowMenu,
    createStandaloneFromModal, createBlank, openProjectPicker, softDelete,
    calculate, save, reload, duplicate, showVersions, viewVersion, goStep, undo, redo,
    openExport, emailSoon, exportWorkbook, exportPDF, exportPrint, addOtherIncome, addCapex,
    _other, _otherRemove, _capex, _capexRemove,
    _statusApplied(id, status) {
      if (st.id === id) { st.status = status; paintStatusChip(); }
    },
    currentId: () => st.id,
    isDirty: () => st.dirty,
    confirmLeave() {
      if (!st.dirty) return true;
      return confirm('This analysis has unsaved changes that will be lost.\n\nLeave without saving?');
    }
  };
})();
