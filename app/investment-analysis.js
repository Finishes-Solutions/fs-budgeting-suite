/* Investment Analysis UI — external no-build module.
   The entire workflow lives here behind window.FSInvestmentUI; app/index.html
   contributes only the nav button, two page containers, route hooks, and the
   adapter passed to init(). The browser NEVER calculates: it posts assumptions
   to /api/investment-calculations (preview) or PUT /api/investment-analysis
   (save) and renders the returned canonical result. */
(function () {
  'use strict';

  let A = null;   // adapter: { api, toast, esc, confirmLeave, navigate, isMobile }
  const st = {
    id: null, input: null, result: null, source: null,
    loadedVersion: 0, dirty: false, stale: false, busy: '',
    step: 1, viewingVersion: null, conflict: null, errors: {}
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

  /* ---------- tiny DOM helpers ---------- */
  const el = id => document.getElementById(id);
  const esc = s => A.esc(String(s === null || s === undefined ? '' : s));

  /* ================= LIST VIEWS =================
     One row markup serves two hosts: the Investment Analysis tab (with the
     creation controls) and the embedded section under the budgets on Home.
     Row actions live in a three-dot menu, exactly like the budget rows —
     Versions is reachable only from there, never from the editor toolbar. */
  const listHosts = new Set();   // every host currently showing a list, for refresh

  async function renderListInto(host, opts) {
    if (!host) return;
    opts = opts || {};
    listHosts.add(host);
    let rows = [];
    try { rows = await A.api('investment-analyses'); }
    catch (e) { host.innerHTML = '<div class="empty">Could not load analyses — ' + esc(e.message) + '</div>'; return; }
    const head = opts.embedded ? '' : `
      <div class="page-title">
        <div><h1>Investment Analyses</h1>
          <div class="sub">Before-tax underwriting, linked to exact saved budget versions</div></div>
      </div>
      <div class="inv-newrow no-print" data-inv-edit>
        <input type="text" id="invNewName" data-k="inv.newName" placeholder="New Standalone Analysis Name…">
        <button class="btn btn-dark" onclick="FSInvestmentUI.createStandalone()">+ New Standalone Analysis</button>
        <span style="font-size:12px;color:var(--ink-500)">or open a budget and use Create Investment Analysis</span>
      </div>`;
    host.innerHTML = head + `
      <table class="inv-table"><thead><tr>
        <th${opts.embedded ? ' style="padding-left:22px"' : ''}>Analysis</th><th>Project</th><th>Status</th><th class="r">Purchase Price</th>
        <th class="r">Year-1 NOI</th><th class="r">Equity IRR</th><th class="r">Optimal Hold</th>
        <th class="r">Version</th><th>Updated</th><th class="no-print"></th>
      </tr></thead><tbody data-inv-list></tbody></table>
      <div class="empty" data-inv-empty style="display:none">No investment analyses yet.</div>`;
    const tb = host.querySelector('[data-inv-list]');
    if (!rows.length) { host.querySelector('[data-inv-empty]').style.display = 'block'; return; }
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.addEventListener('click', () => { location.hash = '#/analysis/' + r.analysisId; });
      tr.innerHTML = `
        <td${opts.embedded ? ' style="padding-left:22px"' : ''}><b>${esc(r.name)}</b></td>
        <td class="mono">${esc(r.projectId || '—')}${r.sourceBudgetVersionNumber ? ' <span class="inv-origin" title="Created from budget version ' + r.sourceBudgetVersionNumber + '">v' + r.sourceBudgetVersionNumber + '</span>' : ''}</td>
        <td>${esc(r.status)}</td>
        <td class="r mono">${usd(r.purchasePrice)}</td>
        <td class="r mono">${usd(r.year1NOI)}</td>
        <td class="r mono">${pctf(r.finalYearEquityIRR)}</td>
        <td class="r mono">${r.optimalHoldingYear ? 'Year ' + r.optimalHoldingYear : '—'}</td>
        <td class="r mono">${r.currentVersionNumber || '—'}</td>
        <td>${esc((r.updatedAt || '').slice(0, 10))}</td>
        <td class="no-print" style="text-align:right"><button class="rowmenu-btn" data-inv-menu
          aria-haspopup="menu" aria-expanded="false" aria-label="Actions for ${esc(r.name)}">⋮</button></td>`;
      tr.querySelector('[data-inv-menu]').addEventListener('click', ev => {
        ev.stopPropagation(); openInvRowMenu(ev.currentTarget, r.analysisId);
      });
      tb.appendChild(tr);
    });
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
    const items = [
      ['open', 'Open Analysis'], ['versions', 'Versions'], ['duplicate', 'Duplicate'],
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

  async function openProjectPicker() {
    let budgets = [];
    try { budgets = await A.api('budgets'); }
    catch (e) { A.toast('Could not load the project list — ' + e.message); return; }
    const rows = budgets.map((b, i) => `<tr class="clickable" data-pick="${i}">
        <td class="mono">${esc(b.projectId)}</td><td><b>${esc(b.name || '—')}</b></td>
        <td>${esc(b.status || '—')}</td><td>${esc((b.updated || '').slice(0, 10))}</td></tr>`).join('');
    openInvModal(`<h2 style="margin-top:0">New Investment Analysis</h2>
      <p style="font-size:12.5px;color:var(--ink-500)">Select the project this analysis is for. It is created
      from that project's latest saved budget version — an exact snapshot, so the budget changing later
      never changes the analysis.</p>
      ${budgets.length
        ? `<table class="inv-table" id="invProjectPick"><thead><tr><th>Project ID</th><th>Name</th>
           <th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty">No budgets yet. Create a budget first, or start a Blank Investment Analysis.</div>'}`, 640);
    el('invModal').querySelectorAll('[data-pick]').forEach(tr => tr.addEventListener('click', async () => {
      const b = budgets[+tr.dataset.pick];
      closeInvModal();
      try { await createFromBudget(b.projectId); }
      catch (e) { A.toast('Could not create the analysis — ' + e.message); }
    }));
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
      st.source = r.source; st.loadedVersion = r.currentVersionNumber;
      st.dirty = false; st.stale = false; st.busy = ''; st.step = r.result ? 6 : 1;
      st.viewingVersion = null; st.conflict = null; st.errors = {};
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

  function originBadge(path) {
    const src = st.input && st.input.source;
    const o = src && src.fieldOrigins && src.fieldOrigins[path];
    return o ? `<span class="inv-origin" title="Imported: ${esc(o)} (budget version ${esc(src.budgetVersionNumber)})">From Budget</span>` : '';
  }

  function renderEditor() {
    const host = el('page-analysis'); if (!host) return;
    const inp = st.input;
    const loan = (inp.financing && inp.financing.loans && inp.financing.loans[0]) || null;
    const dollarExp = inp.expenses && inp.expenses.mode === 'annualDollar';
    host.innerHTML = `
      <div class="page-title">
        <div><h1 id="invTitle">${esc(inp.analysisName)}</h1>
          <div class="sub">${st.source
            ? 'From budget <span class="mono">' + esc(st.source.projectId) + '</span> version ' + esc(st.source.budgetVersionNumber)
            : 'Standalone Analysis'}</div></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center" class="no-print">
          <span class="inv-statebar" id="invState"></span>
          <button class="btn btn-ghost" data-inv-edit id="invCalcBtn" onclick="FSInvestmentUI.calculate()">Calculate</button>
          <button class="btn btn-ghost" data-inv-edit id="invSaveBtn" title="Save (Cmd/Ctrl+S)" onclick="FSInvestmentUI.save()">Save</button>
          <button class="btn btn-dark" data-inv-edit id="invExportBtn" onclick="FSInvestmentUI.openExport()">Export</button>
        </div>
      </div>
      <div id="invConflict"></div>
      <div class="inv-steps no-print" id="invSteps">${STEPS.map((s, i) =>
        `<button data-step="${i + 1}" class="${st.step === i + 1 ? 'on' : ''}" onclick="FSInvestmentUI.goStep(${i + 1})"><span class="n">${i + 1}</span>${s}</button>`).join('')}</div>
      <div id="invErrSummary"></div>

      <div class="inv-step ${st.step === 1 ? 'on' : ''}" data-steppane="1">
        <h2>Source &amp; Property</h2>
        <p class="hint">Review every imported value — each is a suggestion from the exact saved budget version, not a live link. The budget changing later never changes this analysis.</p>
        <div class="inv-grid">
          <label class="fld wide"><span class="lab">Analysis Name</span>
            <input type="text" data-f="analysisName" data-k="inv.analysisName" value="${esc(inp.analysisName)}"></label>
          <label class="fld wide"><span class="lab">Property Name ${originBadge('property.name')}</span>
            <input type="text" data-f="property.name" data-k="inv.property.name" value="${esc(inp.property.name)}"></label>
          <label class="fld wide"><span class="lab">Address ${originBadge('property.address')}</span>
            <input type="text" data-f="property.address" data-k="inv.property.address" value="${esc(inp.property.address)}"></label>
          <label class="fld"><span class="lab">Size Unit ${originBadge('property.size')}</span>
            <select data-f="property.size.unit" data-k="inv.size.unit">
              <option value="squareFeet" ${inp.property.size.unit === 'squareFeet' ? 'selected' : ''}>Square Feet</option>
              <option value="acres" ${inp.property.size.unit === 'acres' ? 'selected' : ''}>Acres</option>
              <option value="units" ${inp.property.size.unit === 'units' ? 'selected' : ''}>Units</option>
            </select></label>
          <label class="fld"><span class="lab">Size Value</span>
            <input type="number" min="0" step="any" data-f="property.size.value" data-k="inv.size.value" value="${inp.property.size.value === null ? '' : inp.property.size.value}"></label>
          <label class="fld"><span class="lab">Unit Count ${originBadge('property.unitCount')}</span>
            <input type="number" min="0" step="1" data-f="property.unitCount" data-k="inv.unitCount" value="${inp.property.unitCount === null ? '' : inp.property.unitCount}"></label>
          <label class="fld"><span class="lab">Purchase Month</span>
            <input type="month" data-f="property.purchaseMonth" data-k="inv.purchaseMonth" value="${esc(inp.property.purchaseMonth || '')}"></label>
          <label class="fld"><span class="lab">Projection Years</span>
            <select data-f="projection.years" data-k="inv.years">
              <option value="5" ${inp.projection.years === 5 ? 'selected' : ''}>5 Years</option>
              <option value="10" ${inp.projection.years === 10 ? 'selected' : ''}>10 Years</option>
            </select></label>
          <label class="fld"><span class="lab">Price Basis</span>
            <select data-f="acquisition.basis.mode" data-k="inv.basis.mode">
              <option value="purchasePrice" ${inp.acquisition.basis.mode === 'purchasePrice' ? 'selected' : ''}>Purchase Price ($)</option>
              <option value="acquisitionCapRate" ${inp.acquisition.basis.mode === 'acquisitionCapRate' ? 'selected' : ''}>Acquisition Cap Rate (%)</option>
            </select></label>
          <label class="fld"><span class="lab" id="invBasisLab">${inp.acquisition.basis.mode === 'acquisitionCapRate' ? 'Acquisition Cap Rate %' : 'Purchase Price'} ${originBadge('acquisition.basis')}</span>
            <input type="number" min="0" step="any" data-f="acquisition.basis.value" data-k="inv.basis.value" value="${inp.acquisition.basis.value === null ? '' : (inp.acquisition.basis.mode === 'acquisitionCapRate' ? toPct(inp.acquisition.basis.value) : inp.acquisition.basis.value)}"></label>
          <label class="fld"><span class="lab">Acquisition Costs %</span>
            <input type="number" min="0" step="any" data-f="acquisition.costPercent" data-k="inv.costPct" value="${toPct(inp.acquisition.costPercent)}"></label>
        </div>
        ${stepNav(1)}
      </div>

      <div class="inv-step ${st.step === 2 ? 'on' : ''}" data-steppane="2">
        <h2>Income</h2>
        <p class="hint">Potential rental income is gross scheduled rent before vacancy and expenses${st.source ? ' — imported as the budget’s unit-mix rent × 12, never its Net Income figure' : ''}.</p>
        <div class="inv-grid">
          <label class="fld"><span class="lab">Year-1 Potential Rental Income ${originBadge('income.year1PotentialIncome')}</span>
            <input type="number" min="0" step="any" data-f="income.year1PotentialIncome" data-k="inv.pri" value="${inp.income.year1PotentialIncome === null ? '' : inp.income.year1PotentialIncome}"></label>
          <label class="fld"><span class="lab">Annual Income Growth %</span>
            <input type="number" step="any" data-f="income.growth.value" data-k="inv.incGrowth" value="${toPct(inp.income.growth.value)}"></label>
        </div>
        <h2 style="margin-top:16px;font-size:13px">Other Income ${originBadge('income.otherIncome')}</h2>
        <div id="invOtherRows"></div>
        <button class="btn btn-sm btn-ghost" data-inv-edit onclick="FSInvestmentUI.addOtherIncome()">+ Add Other Income</button>
        <div id="invUnitMix"></div>
        ${stepNav(2)}
      </div>

      <div class="inv-step ${st.step === 3 ? 'on' : ''}" data-steppane="3">
        <h2>Vacancy &amp; Expenses</h2>
        <p class="hint">Enter the property's complete operating expenses.${st.source ? ' The budget’s service-expense rows below are a partial reference only — they are not a full OPEX picture and are never applied automatically.' : ''}</p>
        <div class="inv-grid">
          <label class="fld"><span class="lab">Vacancy / Credit Loss %</span>
            <input type="number" min="0" step="any" data-f="vacancy.value" data-k="inv.vacancy" value="${toPct(inp.vacancy.value)}"></label>
          <label class="fld"><span class="lab">Expense Mode</span>
            <select data-f="expenses.mode" data-k="inv.expMode">
              <option value="percentOfGOI" ${!dollarExp ? 'selected' : ''}>% of GOI</option>
              <option value="annualDollar" ${dollarExp ? 'selected' : ''}>Annual $ Amount</option>
            </select></label>
          <label class="fld"><span class="lab" id="invExpLab">${dollarExp ? 'Year-1 Operating Expenses $' : 'Operating Expenses % of GOI'}</span>
            <input type="number" min="0" step="any" data-f="expenses.value" data-k="inv.expValue" value="${inp.expenses.value === null ? '' : (dollarExp ? inp.expenses.value : toPct(inp.expenses.value))}"></label>
          <label class="fld" id="invExpGrowthFld" style="${dollarExp ? '' : 'display:none'}"><span class="lab">Expense Growth %</span>
            <input type="number" step="any" data-f="expenses.growth.value" data-k="inv.expGrowth" value="${toPct(inp.expenses.growth ? inp.expenses.growth.value : 0.03)}"></label>
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
      case 'property.size.unit': inp.property.size.unit = v; break;
      case 'property.size.value': inp.property.size.value = num; break;
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
      case 'acquisition.basis.value':
        inp.acquisition.basis.value = inp.acquisition.basis.mode === 'acquisitionCapRate' ? pct : num; break;
      case 'acquisition.costPercent': inp.acquisition.costPercent = pct; break;
      case 'income.year1PotentialIncome': inp.income.year1PotentialIncome = num; break;
      case 'income.growth.value': inp.income.growth.value = pct; break;
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
    markDirty();
  }
  const host_input = f => document.querySelector('#page-analysis [data-f="' + f + '"]');

  function markDirty() {
    if (!st.dirty || !st.stale) { st.dirty = true; st.stale = !!st.result; renderStateBar(); }
    updateStepUI();   // keep the Next buttons and ✓ pills live as fields fill in
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
    host.innerHTML = rows.length ? `<table class="inv-table" style="max-width:640px"><thead>
      <tr><th>Label</th><th class="r">Year-1 Annual $</th><th class="r">Growth %</th><th></th></tr></thead><tbody>` +
      rows.map((r, i) => `<tr>
        <td><input type="text" data-k="inv.other.${i}.label" value="${esc(r.label)}"
             onchange="FSInvestmentUI._other(${i},'label',this.value)"></td>
        <td class="r"><input type="number" min="0" step="any" style="width:120px" data-k="inv.other.${i}.amount"
             value="${r.year1Amount === null ? '' : r.year1Amount}" onchange="FSInvestmentUI._other(${i},'amount',this.value)"></td>
        <td class="r"><input type="number" step="any" style="width:80px" data-k="inv.other.${i}.growth"
             value="${toPct(r.growth.value)}" onchange="FSInvestmentUI._other(${i},'growth',this.value)"></td>
        <td class="no-print"><button class="btn-x" data-inv-edit title="Remove row"
             onclick="FSInvestmentUI._otherRemove(${i})">×</button></td></tr>`).join('') +
      '</tbody></table>' : '<div style="font-size:12.5px;color:var(--ink-500);margin:6px 0 10px">No other-income rows.</div>';
  }
  function _other(i, k, v) {
    const r = st.input.income.otherIncome[i]; if (!r) return;
    if (k === 'label') r.label = v;
    if (k === 'amount') r.year1Amount = numOrNull(v);
    if (k === 'growth') r.growth.value = fromPct(v) === null ? 0.03 : fromPct(v);
    markDirty();
  }
  function _otherRemove(i) { st.input.income.otherIncome.splice(i, 1); markDirty(); renderOtherIncomeRows(); }
  function addOtherIncome() {
    st.input.income.otherIncome.push({ label: 'Other Income', year1Amount: 0, growth: { mode: 'constant', value: 0.03 } });
    markDirty(); renderOtherIncomeRows();
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
        ex.innerHTML = `<h2 style="margin-top:16px;font-size:13px">Budget Service Expenses (reference only)</h2>
          <div class="inv-warnings">These rows come from the construction budget's service-expense list. They are a
            <b>partial</b> reference — real property OPEX (taxes, insurance, management, maintenance, utilities)
            is usually much larger. They are never applied automatically.</div>
          <table class="inv-table" style="max-width:420px"><tbody>
          ${sup.serviceExpenseRows.map(r => `<tr><td>${esc(r.label)}</td><td class="r mono">${usd(r.annualAmount)}/yr</td></tr>`).join('')}
          <tr class="tot"><td>Total imported service expenses</td><td class="r mono">${usd(sup.annualServiceExpenses)}/yr</td></tr>
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

  /* ---------- validation display ---------- */
  function showErrors(fields) {
    st.errors = fields || {};
    document.querySelectorAll('#page-analysis .inv-err').forEach(e => e.classList.remove('inv-err'));
    document.querySelectorAll('#page-analysis .inv-errmsg').forEach(e => e.remove());
    const unmatched = [];
    for (const [path, msg] of Object.entries(st.errors)) {
      const fieldName = path.startsWith('financing.loans.0.') ? 'loan.' + path.slice('financing.loans.0.'.length) : path;
      const input = host_input(fieldName);
      if (input) {
        input.classList.add('inv-err');
        const m = document.createElement('div');
        m.className = 'inv-errmsg'; m.textContent = msg;
        input.parentElement.appendChild(m);
      } else unmatched.push(msg);
    }
    const sum = el('invErrSummary');
    const n = Object.keys(st.errors).length;
    sum.innerHTML = n ? `<div class="inv-warnings"><b>${n} assumption${n > 1 ? 's need' : ' needs'} attention before this can calculate.</b>
      ${unmatched.length ? '<ul>' + unmatched.map(m => '<li>' + esc(m) + '</li>').join('') + '</ul>' : ''}</div>` : '';
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
        <td>${esc((v.createdAt || '').slice(0, 16).replace('T', ' '))}</td>
        <td>${esc(v.createdByName || '—')}</td>
        <td class="r mono">${usd(v.purchasePrice)}</td>
        <td class="r mono">${pctf(v.finalYearEquityIRR)}</td></tr>`).join('');
      openInvModal(`<h2 style="margin-top:0">Version History</h2>
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
      openInvModal(`<h2 style="margin-top:0">Version ${n} — Read-Only</h2>
        <div class="inv-provenance">Saved ${esc((r.version.createdAt || '').slice(0, 16).replace('T', ' '))}
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
    m.innerHTML = `<div style="background:#fff;border-radius:12px;max-width:${maxWidth || 960}px;width:100%;padding:22px 26px;position:relative;margin:auto">
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
      ${src ? 'Created from budget <span class="mono">' + esc(src.projectId) + '</span> version ' + esc(src.budgetVersionNumber)
            + (src.importedAt ? ' (imported ' + esc(String(src.importedAt).slice(0, 10)) + ')' : '') + '.' : 'Standalone Analysis.'}
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
    const chk = (k, label, title) => `<label class="chk"${title ? ' title="' + title + '"' : ''}>
      <input type="checkbox" id="${EX_IDS[k]}" ${exOpts[k] ? 'checked' : ''}> ${label}</label>`;
    // The button row matches the budget export modal exactly — one order
    // everywhere: Email (Soon) · Print · PDF · Excel (.xlsx).
    openInvModal(`<h2 style="margin-top:0">Export Analysis</h2>
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
    const dd = fsRender.buildPdfDocDefinition(fsdocOf(doc), FS_THEME(), pdfPreset(doc));
    FSExportRender.appendApprovalPage(dd, doc.signature);
    pdfMake.createPdf(dd).getBlob(blob => downloadBlob(blob, exportBaseName() + '.pdf'));
  }

  /* ---- Print: the original #printDoc pipeline via the adapter — the same
     print-styled classes the budget report uses. Kept as a third option. */
  function exportPrint() {
    if (!st.result || st.stale) { A.toast('Calculate first so the print matches the inputs.'); return; }
    readExportOpts(); closeInvModal();
    A.print(printReportHTML(st.result, exOpts));
  }

  function printReportHTML(R, opts) {
    const o = opts || exOpts;
    const s = R.summary, loan = R.loans[0] || null, years = R.annual, N = R.normalizedInput;
    const src = N.source;
    const stamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
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
        ${src ? 'From budget <span class="mono">' + esc(src.projectId) + '</span> v' + esc(src.budgetVersionNumber) : 'Standalone Analysis'}${st.loadedVersion ? '<br>Analysis v' + st.loadedVersion : ''}</div>
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
        + rr('Source', src ? 'Budget <span class="mono">' + esc(src.projectId) + '</span> version ' + esc(src.budgetVersionNumber) : 'Standalone Analysis')
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
    const wb = fsRender.buildWorkbook(ExcelJS, fsdocOf(exportDoc()), FS_THEME());
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(new Blob([buf],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      exportBaseName() + '.xlsx');
  }

  /* ================= public surface ================= */
  window.FSInvestmentUI = {
    init(adapter) { A = adapter; },
    renderList, renderListInto, open, createFromBudget, createStandalone,
    createBlank, openProjectPicker, softDelete,
    calculate, save, reload, duplicate, showVersions, viewVersion, goStep,
    openExport, emailSoon, exportWorkbook, exportPDF, exportPrint, addOtherIncome, addCapex,
    _other, _otherRemove, _capex, _capexRemove,
    currentId: () => st.id,
    isDirty: () => st.dirty,
    confirmLeave() {
      if (!st.dirty) return true;
      return confirm('This analysis has unsaved changes that will be lost.\n\nLeave without saving?');
    }
  };
})();
