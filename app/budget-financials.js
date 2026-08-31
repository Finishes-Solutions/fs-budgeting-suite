/* Budget Financials — the derived views over one internal budget.

   A no-build IIFE behind window.FSBudgetFinancials, wired from index.html with
   an adapter (esc/usd/doc/parts/csiSchedule/api/...). It renders, and never
   computes money of its own: every number comes from FSBudgetFinance, the
   byte-identical calc pair, fed the doc's own parts()/csiSchedule(). So the
   bank budget, profit splits, waterfall, intercompany view and executive
   summary cannot drift from each other or from the budget — they are one model
   shown five ways.

   index.html carries only the shells (#bankBody, #splitsBody, #waterfallBody,
   #intercoBody, #execBody); everything below fills them. */
(function () {
  'use strict';
  var A = {};
  var F = window.FSBudgetFinance;
  var entitiesCache = null;      // {available, entities[]}
  var waterfallMode = 'usd';     // 'usd' | 'pct'

  function esc(s) { return A.esc ? A.esc(String(s == null ? '' : s)) : String(s == null ? '' : s); }
  function usd(n) { return A.usd ? A.usd(n) : '$' + Math.round(n || 0).toLocaleString('en-US'); }
  function usd2(n) { return A.usd2 ? A.usd2(n) : usd(n); }
  function pct(n) { return (n == null || !isFinite(n)) ? '—' : (n * 100).toFixed(1) + '%'; }
  function signedUsd(n) { return (n < 0 ? '-' : '') + usd(Math.abs(n)); }

  function docNow() { return A.doc ? A.doc() : (window.doc || null); }
  function isTemplate() { return A.isTemplateEdit ? A.isTemplateEdit() : false; }

  // The model, computed once per render from the live doc. Returns null when
  // there is nothing to show (no doc, or the calc helpers are unavailable).
  function model() {
    var doc = docNow();
    if (!doc || !F || !A.parts) return null;
    var parts = A.parts();
    var csi = A.csiSchedule ? A.csiSchedule() : null;
    var finance = F.financeFor(doc);
    var entities = (entitiesCache && entitiesCache.available) ? entitiesCache.entities : [];
    var bank = F.deriveBank({ doc: doc, parts: parts, csi: csi, finance: finance });
    var alloc = F.allocate({ doc: doc, parts: parts, csi: csi, finance: finance, entities: entities });
    var plan = F.contractPlan(alloc, parts);
    var con = F.consolidate(alloc, parts, plan);
    var wf = F.waterfall(alloc, con, parts);
    return { doc: doc, parts: parts, finance: finance, bank: bank, alloc: alloc, plan: plan, con: con, wf: wf };
  }

  /* ---- Entity list, loaded once so splits show display names ---------- */
  function loadEntities() {
    if (entitiesCache || !A.api) return Promise.resolve(entitiesCache);
    return A.api('budgets?scope=entities')
      .then(function (r) { entitiesCache = r || { available: false, entities: [] }; return entitiesCache; })
      .catch(function () { entitiesCache = { available: false, entities: [] }; return entitiesCache; });
  }

  /* ================= BANK BUDGET ================= */
  function bankHtml(m) {
    var b = m.bank;
    var rows = b.rows.map(function (r) {
      return '<tr><td>' + esc(r.label) + '</td>'
        + '<td class="r">' + usd(r.internal) + '</td>'
        + '<td class="r">' + usd(r.bank) + '</td>'
        + '<td class="r">' + signedUsd(r.diffUsd) + '</td>'
        + '<td class="r">' + (r.diffPct == null ? '—' : pct(r.diffPct)) + '</td></tr>';
    }).join('');
    var diff = b.bankTotal - b.internalTotal;
    return '<div class="fin-hd"><h2>Bank / Lender Budget</h2>'
      + '<span class="eyebrow">Internal project cost + a ' + (+b.upliftPct).toFixed(b.upliftPct % 1 ? 1 : 0)
      + '% lender uplift · every bank line traces to its internal line</span></div>'
      + '<div class="fin-scroll"><table class="tbl fin-tbl"><thead><tr>'
      + '<th>Category</th><th class="r">Internal</th><th class="r">Bank</th><th class="r">Difference</th><th class="r">%</th>'
      + '</tr></thead><tbody>' + rows
      + '<tr class="fin-total"><td>Total</td><td class="r">' + usd(b.internalTotal) + '</td>'
      + '<td class="r">' + usd(b.bankTotal) + '</td><td class="r">' + signedUsd(diff) + '</td>'
      + '<td class="r">' + pct(b.internalTotal > 0 ? diff / b.internalTotal : null) + '</td></tr>'
      + '</tbody></table></div>'
      + '<div class="fin-note">Reconciles: ' + usd(b.internalTotal) + ' internal + ' + usd(b.upliftUsd)
      + ' uplift = ' + usd(b.bankTotal) + ' bank'
      + (b.remainderUsd ? ' · ' + usd(b.remainderUsd) + ' unallocated to ' + esc(b.remainderTarget) : '') + '.</div>';
  }

  /* ================= PROFIT SPLITS ================= */
  function splitsHtml(m) {
    var a = m.alloc;
    if (!a.rows.length) return '<div class="fin-hd"><h2>Profit Allocation</h2></div>'
      + '<div class="fin-empty">No participating companies yet.</div>';
    var rows = a.rows.map(function (r) {
      var headline = r.basisLabel === 'margin' ? pct(r.marginPct) : pct(r.markupPct);
      return '<tr><td>' + esc(r.displayName) + '</td>'
        + '<td class="r">' + usd(r.costBasis) + '</td>'
        + '<td class="r">' + usd(r.contractValue) + '</td>'
        + '<td class="r">' + usd(r.profit) + '</td>'
        + '<td class="r">' + pct(r.markupPct) + '</td>'
        + '<td class="r">' + pct(r.marginPct) + '</td>'
        + '<td class="r">' + pct(r.pctOfProject) + '</td></tr>';
    }).join('');
    return '<div class="fin-hd"><h2>Profit Allocation by Company</h2>'
      + '<span class="eyebrow">Markup = profit ÷ cost · Margin = profit ÷ contract value — both shown</span></div>'
      + '<div class="fin-scroll"><table class="tbl fin-tbl"><thead><tr>'
      + '<th>Company</th><th class="r">Cost Basis</th><th class="r">Contract Value</th>'
      + '<th class="r">Profit</th><th class="r" title="Profit ÷ Cost">Markup %</th>'
      + '<th class="r" title="Profit ÷ Revenue">Margin %</th><th class="r">% of Project</th>'
      + '</tr></thead><tbody>' + rows
      + '<tr class="fin-total"><td>Total Finishes</td><td class="r">' + usd(a.totalCostBasis) + '</td>'
      + '<td class="r">' + usd(a.totalContractValue) + '</td><td class="r">' + usd(a.totalProfit) + '</td>'
      + '<td class="r">' + pct(a.totalCostBasis > 0 ? a.totalProfit / a.totalCostBasis : null) + '</td>'
      + '<td class="r">' + pct(a.totalContractValue > 0 ? a.totalProfit / a.totalContractValue : null) + '</td>'
      + '<td class="r">' + pct(a.project > 0 ? a.totalContractValue / a.project : null) + '</td></tr>'
      + '</tbody></table></div>';
  }

  /* ================= PROFIT WATERFALL (inline SVG) ================= */
  function waterfallHtml(m) {
    var wf = m.wf, stages = wf.stages, project = wf.project || 1;
    var W = 720, rowH = 34, padL = 200, padR = 120, top = 8;
    var H = top * 2 + stages.length * rowH;
    var maxV = project || 1;
    var scale = (W - padL - padR) / maxV;
    var bars = stages.map(function (s, i) {
      var y = top + i * rowH;
      var isTotal = s.kind === 'total' || s.kind === 'result';
      // Totals draw from zero; step bars float on the running balance.
      var startVal = isTotal ? 0 : (s.amount < 0 ? s.running : s.running - s.amount);
      var w = Math.abs(s.amount) * scale;
      var x = padL + Math.min(startVal, startVal + s.amount) * scale;
      var cls = isTotal ? 'wf-total' : (s.amount < 0 ? 'wf-neg' : 'wf-pos');
      var valTxt = waterfallMode === 'pct'
        ? (s.pct == null ? '—' : (s.amount < 0 ? '-' : '') + Math.abs(s.pct * 100).toFixed(1) + '%')
        : signedUsd(s.amount);
      return '<g>'
        + '<text x="' + (padL - 8) + '" y="' + (y + rowH / 2 + 4) + '" text-anchor="end" class="wf-lab">' + esc(s.label) + '</text>'
        + '<rect x="' + x.toFixed(1) + '" y="' + (y + 5) + '" width="' + Math.max(w, 1).toFixed(1) + '" height="' + (rowH - 12) + '" rx="2" class="' + cls + '"></rect>'
        + '<text x="' + (W - padR + 8) + '" y="' + (y + rowH / 2 + 4) + '" class="wf-val">' + valTxt + '</text>'
        + '</g>';
    }).join('');
    return '<div class="fin-hd"><h2>Profit Waterfall</h2>'
      + '<span class="eyebrow">Total project value through consolidated Finishes profit</span>'
      + '<span class="fin-toggle no-print">'
      + '<button class="' + (waterfallMode === 'usd' ? 'on' : '') + '" onclick="FSBudgetFinancials.setWaterfallMode(\'usd\')">$</button>'
      + '<button class="' + (waterfallMode === 'pct' ? 'on' : '') + '" onclick="FSBudgetFinancials.setWaterfallMode(\'pct\')">%</button>'
      + '</span></div>'
      + '<div class="fin-scroll"><svg viewBox="0 0 ' + W + ' ' + H + '" class="wf-svg" role="img" aria-label="Profit waterfall">'
      + bars + '</svg></div>';
  }

  /* ================= INTERCOMPANY ================= */
  function intercoHtml(m) {
    var con = m.con;
    var revRows = con.entityRevenue.map(function (e) {
      return '<tr><td>' + esc(e.displayName) + '</td>'
        + '<td class="r">' + usd(e.external) + '</td>'
        + '<td class="r">' + usd(e.intercompany) + '</td>'
        + '<td class="r">' + usd(e.total) + '</td></tr>';
    }).join('');
    var elimRows = con.eliminations.length
      ? con.eliminations.map(function (x) {
          return '<tr><td>' + esc(nameOf(m, x.from)) + ' → ' + esc(nameOf(m, x.to)) + '</td>'
            + '<td class="r">(' + usd(x.amount) + ')</td></tr>';
        }).join('')
      : '<tr><td colspan="2" class="fin-empty">No intercompany transfers.</td></tr>';
    return '<div class="fin-hd"><h2>Intercompany Reconciliation</h2>'
      + '<span class="eyebrow">Entity revenue vs consolidated Finishes revenue — transfers eliminated, never double-counted</span></div>'
      + '<div class="fin-two">'
      + '<div class="fin-scroll"><table class="tbl fin-tbl"><thead><tr>'
      + '<th>Entity</th><th class="r">External</th><th class="r">Intercompany</th><th class="r">Gross</th>'
      + '</tr></thead><tbody>' + revRows + '</tbody></table></div>'
      + '<div class="fin-scroll"><table class="tbl fin-tbl"><thead><tr>'
      + '<th>Elimination</th><th class="r">Amount</th></tr></thead><tbody>' + elimRows + '</tbody></table></div>'
      + '</div>'
      + '<div class="fin-recon">'
      + '<div><span class="k">Consolidated External Revenue</span><span class="v">' + usd(con.consolidatedExternalRevenue) + '</span></div>'
      + '<div><span class="k">Intercompany Eliminated</span><span class="v">(' + usd(con.intercompanyTotal) + ')</span></div>'
      + '<div><span class="k">Consolidated Finishes Profit</span><span class="v">' + usd(con.consolidatedFinishesProfit) + '</span></div>'
      + '</div>';
  }
  function nameOf(m, key) {
    if (key === '__project_entity__') {
      var e = m.doc.projectEntity;
      return e ? (e.displayName || e.legalName) : 'Project Entity';
    }
    var row = (m.alloc.rows || []).filter(function (r) { return r.entityKey === key; })[0];
    return row ? row.displayName : key;
  }

  /* ================= EXECUTIVE SUMMARY (on the Budget page) ============= */
  function execHtml(m) {
    var b = m.bank, a = m.alloc, con = m.con, parts = m.parts;
    function row(k, v, cls) { return '<div class="exec-row ' + (cls || '') + '"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>'; }
    var companyRows = a.rows.map(function (r) {
      return row(r.displayName + ' Allocation', usd(r.contractValue) + ' <span class="exec-sub">' + usd(r.profit) + ' profit</span>');
    }).join('');
    var margin = con.consolidatedExternalRevenue > 0 ? con.consolidatedFinishesProfit / con.consolidatedExternalRevenue : null;
    var markup = (parts.project - con.consolidatedFinishesProfit) > 0 ? con.consolidatedFinishesProfit / (parts.project - con.consolidatedFinishesProfit) : null;
    var fs = a.rows.filter(function (r) { return r.entityKey === F.FS_KEY; })[0];
    return '<div class="exec-grid">'
      + row('Internal Project Cost', usd(b.internalTotal), 'exec-strong')
      + row('Bank / Lender Budget', usd(b.bankTotal))
      + row('Bank Uplift', pct(b.internalTotal > 0 ? (b.bankTotal - b.internalTotal) / b.internalTotal : null))
      + row('Project Entity → Finishes Solutions', fs ? usd(parts.contract) : '—')
      + companyRows
      + row('Total Finishes Profit', usd(a.totalProfit), 'exec-strong')
      + row('Consolidated Margin', pct(margin) + ' <span class="exec-sub">' + pct(markup) + ' markup</span>')
      + row('Reconciliation', reconChip(m))
      + '</div>';
  }
  // Until contracts exist (Phase 7) the reconciliation status is the internal
  // consistency check; the contract-vs-allocation status layers on later.
  function reconChip(m) {
    var ok = m.con.checks.identity;
    return '<span class="st-chip ' + (ok ? 'st-done' : 'st-cancel') + '">' + (ok ? 'Reconciled' : 'Check allocations') + '</span>';
  }

  /* ================= PUBLIC RENDER ================= */
  function elm(id) { return document.getElementById(id); }
  function set(id, html) { var e = elm(id); if (e) e.innerHTML = html; }

  function renderExec() {
    if (!elm('execBody')) return;
    var m = model();
    set('execBody', m ? execHtml(m) : '<div class="fin-empty">Open a budget to see its summary.</div>');
  }

  function render() {
    if (!elm('bankBody')) return;
    // Template mode authors the rules that budgets will inherit, instead of
    // showing derived views — a template has no real numbers to derive from.
    if (isTemplate()) { renderTemplateForm(); return; }
    var m = model();
    if (!m) {
      set('bankBody', '<div class="fin-empty">Open a budget to see its financial views.</div>');
      set('splitsBody', ''); set('waterfallBody', ''); set('intercoBody', '');
      set('finBanner', '');
      return;
    }
    set('finBanner', '<div class="fin-layer no-print">Derived from the current working budget. '
      + 'Bank budget, profit allocation and reconciliation update automatically as the budget changes.</div>');
    set('bankBody', bankHtml(m));
    set('splitsBody', splitsHtml(m));
    set('waterfallBody', waterfallHtml(m));
    set('intercoBody', intercoHtml(m));
  }

  function setWaterfallMode(mode) {
    waterfallMode = (mode === 'pct') ? 'pct' : 'usd';
    var m = model();
    if (m) set('waterfallBody', waterfallHtml(m));
  }

  /* ================= TEMPLATE-MODE AUTHORING ================= */
  var STREAMS = [
    { v: 'companyMarkup', l: 'Construction markup' },
    { v: 'devFee', l: 'Developer fee' },
    { v: 'mktFee', l: 'Marketing / Brokerage fee' },
    { v: 'clsFee', l: 'Closing costs' },
    { v: 'none', l: 'Not participating' }
  ];
  var REMAINDERS = [
    { v: 'contingency', l: 'Contingency line' },
    { v: 'lenderAllowance', l: 'Lender Allowance line' },
    { v: 'prorata', l: 'Pro-rata across all lines' }
  ];
  function ensureFinance() {
    var doc = docNow();
    if (!doc.finance || typeof doc.finance !== 'object') doc.finance = { bank: { upliftPct: 10, allocation: [], remainder: 'contingency' }, allocations: [] };
    if (!doc.finance.bank) doc.finance.bank = { upliftPct: 10, allocation: [], remainder: 'contingency' };
    if (!Array.isArray(doc.finance.bank.allocation)) doc.finance.bank.allocation = [];
    if (!Array.isArray(doc.finance.allocations)) doc.finance.allocations = [];
    return doc.finance;
  }
  function finEntities() {
    var list = (entitiesCache && entitiesCache.available) ? entitiesCache.entities : [];
    return list.filter(function (e) { return e.isFinishesCompany; });
  }
  function renderTemplateForm() {
    var fin = ensureFinance();
    var ents = finEntities();
    var entOpts = function (sel) {
      return ents.map(function (e) {
        return '<option value="' + esc(e.entityKey) + '"' + (e.entityKey === sel ? ' selected' : '') + '>' + esc(e.displayName) + '</option>';
      }).join('');
    };
    // Bank rules.
    var bankRuleRows = fin.bank.allocation.map(function (r, i) {
      return '<tr>'
        + '<td><select onchange="FSBudgetFinancials.editBankRule(' + i + ',\'match\',this.value)">'
        + ['div', 'hard', 'soft', 'profit', 'cont', 'land', 'fees'].map(function (mm) {
            return '<option value="' + mm + '"' + (r.match === mm ? ' selected' : '') + '>' + mm + '</option>'; }).join('')
        + '</select></td>'
        + '<td><input value="' + esc(r.key == null ? '' : r.key) + '" placeholder="div key e.g. 03" style="width:90px" onchange="FSBudgetFinancials.editBankRule(' + i + ',\'key\',this.value)"></td>'
        + '<td class="r"><input type="number" step="0.5" value="' + (+r.pct || 0) + '" style="width:70px" onchange="FSBudgetFinancials.editBankRule(' + i + ',\'pct\',this.value)"> %</td>'
        + '<td class="no-print"><button class="btn-x" onclick="FSBudgetFinancials.removeBankRule(' + i + ')">×</button></td></tr>';
    }).join('');
    var allocRows = fin.allocations.map(function (a, i) {
      return '<tr>'
        + '<td><select onchange="FSBudgetFinancials.editAlloc(' + i + ',\'entityKey\',this.value)">' + entOpts(a.entityKey) + '</select></td>'
        + '<td><select onchange="FSBudgetFinancials.editAlloc(' + i + ',\'stream\',this.value)">'
        + STREAMS.map(function (s) { return '<option value="' + s.v + '"' + (a.stream === s.v ? ' selected' : '') + '>' + esc(s.l) + '</option>'; }).join('')
        + '</select></td>'
        + '<td class="r"><input type="number" step="0.05" value="' + (a.costShare == null ? '' : a.costShare) + '" placeholder="—" style="width:70px" onchange="FSBudgetFinancials.editAlloc(' + i + ',\'costShare\',this.value)"></td>'
        + '<td class="r"><input type="number" step="0.05" value="' + (a.share == null ? '' : a.share) + '" placeholder="1" style="width:70px" onchange="FSBudgetFinancials.editAlloc(' + i + ',\'share\',this.value)"></td>'
        + '<td class="no-print"><button class="btn-x" onclick="FSBudgetFinancials.removeAlloc(' + i + ')">×</button></td></tr>';
    }).join('');
    var html = '<div class="fin-layer no-print">Editing template finance rules. These carry into every new budget created from this template; a budget can override them.</div>'
      + '<div class="fin-hd"><h2>Bank / Lender Budget Rules</h2>'
      + '<span class="eyebrow">The lender uplift and how it is distributed across categories</span></div>'
      + '<div class="fin-form-row"><label>Bank uplift %<input type="number" step="0.5" value="' + (+fin.bank.upliftPct || 0)
      + '" style="width:80px" onchange="FSBudgetFinancials.editBankUplift(this.value)"></label>'
      + '<label>Remainder goes to <select onchange="FSBudgetFinancials.editBankRemainder(this.value)">'
      + REMAINDERS.map(function (rm) { return '<option value="' + rm.v + '"' + (fin.bank.remainder === rm.v ? ' selected' : '') + '>' + esc(rm.l) + '</option>'; }).join('')
      + '</select></label></div>'
      + '<div class="fin-scroll"><table class="tbl fin-tbl"><thead><tr><th>Category</th><th>Division key</th><th class="r">Uplift</th><th class="no-print"></th></tr></thead>'
      + '<tbody>' + (bankRuleRows || '<tr><td colspan="4" class="fin-empty">No category rules — the whole uplift lands on the remainder line.</td></tr>') + '</tbody></table></div>'
      + '<div class="no-print" style="margin:8px 0 20px"><button class="btn btn-ghost" onclick="FSBudgetFinancials.addBankRule()">+ Add category rule</button></div>'
      + '<div class="fin-hd"><h2>Profit Allocation Rules</h2>'
      + '<span class="eyebrow">Which Finishes company earns each stream. Cost share splits construction cost basis (must total 1); Share splits a fee.</span></div>'
      + (ents.length
          ? '<div class="fin-scroll"><table class="tbl fin-tbl"><thead><tr><th>Company</th><th>Stream</th><th class="r">Cost Share</th><th class="r">Fee Share</th><th class="no-print"></th></tr></thead>'
            + '<tbody>' + (allocRows || '<tr><td colspan="5" class="fin-empty">No allocation rules yet.</td></tr>') + '</tbody></table></div>'
            + '<div class="no-print" style="margin-top:8px"><button class="btn btn-ghost" onclick="FSBudgetFinancials.addAlloc()">+ Add allocation rule</button></div>'
          : '<div class="fin-empty">The Entity Master has not loaded, or its migration has not run — allocation rules need the Finishes companies.</div>');
    set('bankBody', html);
    set('splitsBody', ''); set('waterfallBody', ''); set('intercoBody', ''); set('finBanner', '');
  }
  function touched() { if (A.touch) A.touch(); else if (A.markDirty) A.markDirty(); render(); }
  function editBankUplift(v) { ensureFinance().bank.upliftPct = +v || 0; touched(); }
  function editBankRemainder(v) { ensureFinance().bank.remainder = v; touched(); }
  function addBankRule() { ensureFinance().bank.allocation.push({ match: 'div', key: '', pct: 0 }); touched(); }
  function removeBankRule(i) { ensureFinance().bank.allocation.splice(i, 1); touched(); }
  function editBankRule(i, k, v) {
    var r = ensureFinance().bank.allocation[i]; if (!r) return;
    r[k] = (k === 'pct') ? (+v || 0) : v; touched();
  }
  function addAlloc() {
    var ents = finEntities();
    ensureFinance().allocations.push({ entityKey: ents[0] ? ents[0].entityKey : 'finishes-solutions', stream: 'companyMarkup', costShare: 1 });
    touched();
  }
  function removeAlloc(i) { ensureFinance().allocations.splice(i, 1); touched(); }
  function editAlloc(i, k, v) {
    var a = ensureFinance().allocations[i]; if (!a) return;
    if (k === 'costShare' || k === 'share') { if (v === '') delete a[k]; else a[k] = +v || 0; }
    else a[k] = v;
    touched();
  }

  window.FSBudgetFinancials = {
    init: function (adapter) { A = adapter || {}; loadEntities(); },
    render: render,
    renderExec: renderExec,
    setWaterfallMode: setWaterfallMode,
    reloadEntities: function () { entitiesCache = null; return loadEntities(); },
    // template-mode authoring
    editBankUplift: editBankUplift, editBankRemainder: editBankRemainder,
    addBankRule: addBankRule, removeBankRule: removeBankRule, editBankRule: editBankRule,
    addAlloc: addAlloc, removeAlloc: removeAlloc, editAlloc: editAlloc,
    // exposed for suites
    _model: model
  };
})();
