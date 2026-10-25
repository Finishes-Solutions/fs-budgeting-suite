/* Budgeting v2 — the estimate workspace (Inputs page) and the estimate detail
   (Budget page) for budgets built by the v2 engine.

   A no-build IIFE behind window.FSBudgetV2, wired by a small adapter in
   app/index.html (the same pattern as investment-analysis.js). It owns
   doc.engine (the project: components, shared elements, phases, overrides,
   scenarios) and nothing else. Every change recomputes with FSBudgetEngine and
   MATERIALIZES the result into the ordinary budget fields (lines, contingency,
   project costs, engineSummary) — so saving, versions, the SOV, the CSI
   schedule, the classic exports and the guard rails all keep working on a
   document they already understand (docs/BUDGET_ENGINE.md §7).

   Security: every string that reaches HTML goes through A.esc(); ids reach
   only data-* attributes (escaped) and are read back by delegated listeners —
   never interpolated into inline handlers. migrate() regenerates any id that
   is not a safe row id, the same rule the API enforces (api/shared/identifiers.js). */
(function () {
  'use strict';
  var A = null;                       // adapter from index.html
  var E = window.FSBudgetEngine, D = window.FSResearchData || null;

  /* The research bundle is ~2 MB, so it is not on the page for classic
     budgets: ready() loads app/research-data.js once, the first time an
     estimate is created or opened, and resolves false if it cannot. */
  var loading = null;
  function ready() {
    if (D && D.types) return Promise.resolve(true);
    if (!loading) loading = new Promise(function (resolve) {
      var sc = document.createElement('script');
      sc.src = 'research-data.js';
      sc.onload = function () { D = window.FSResearchData || null; resolve(!!(D && D.types)); };
      sc.onerror = function () { loading = null; resolve(false); };
      document.head.appendChild(sc);
    });
    return loading;
  }
  var SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  var st = { result: null, resultFor: null, view: 'detail', open: {}, q: '', picker: null, drawer: null,
    blockQ: '', scope: 'project', sens: null, scen: null };

  /* ------------------------------------------------------------ formatting */
  function esc(s) { return A ? A.esc(s) : String(s == null ? '' : s); }
  function money(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var r = Math.round(v);
    return (r < 0 ? '−$' : '$') + Math.abs(r).toLocaleString('en-US');
  }
  function money2(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function short(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var a = Math.abs(v), sg = v < 0 ? '−$' : '$';
    if (a >= 1e9) return sg + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return sg + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return sg + Math.round(a / 1e3).toLocaleString('en-US') + 'K';
    return money(v);
  }
  function pct(v, d) { return v === null || v === undefined || !isFinite(v) ? '—' : (v * 100).toFixed(d === undefined ? 1 : d) + '%'; }
  function num(v, d) { return v === null || v === undefined || !isFinite(v) ? '—' : (+v).toLocaleString('en-US', { maximumFractionDigits: d === undefined ? 2 : d }); }
  function unitL(id, plural) {
    var u = (D.units || []).filter(function (x) { return x.id === id; })[0];
    return u ? (plural ? u.plural : u.label) : (id || '');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function newId(p) { return p + Math.random().toString(36).slice(2, 9); }
  function nextMonth() { var d = new Date(); d.setMonth(d.getMonth() + 3); return d.toISOString().slice(0, 7); }

  /* ------------------------------------------------------------ document */
  function isEngine(doc) { return !!(doc && doc.engine && typeof doc.engine === 'object'); }
  function P() { var d = A.getDoc(); return d && d.engine; }

  /* Repair an engine project on load: arrays present, ids safe and unique. */
  function migrate(doc) {
    var e = doc.engine;
    if (!e || typeof e !== 'object') { delete doc.engine; return doc; }
    ['components', 'phases', 'shared', 'scenarios'].forEach(function (k) { if (!Array.isArray(e[k])) e[k] = []; });
    if (!e.phases.length) e.phases.push(E.newPhase({ id: 'p1', name: 'Phase 1' }));
    e.overrides = e.overrides && typeof e.overrides === 'object' && !Array.isArray(e.overrides) ? e.overrides : {};
    e.settings = e.settings && typeof e.settings === 'object' ? e.settings : {};
    e.land = e.land && typeof e.land === 'object' ? e.land : { mode: 'amount', value: 0 };
    e.location = e.location && typeof e.location === 'object' ? e.location : { region: 'US' };
    var seen = {};
    var fix = function (o, p) {
      if (!o || typeof o !== 'object') return;
      if (!SAFE_ID.test(String(o.id || '')) || seen[o.id]) o.id = newId(p);
      seen[o.id] = true;
    };
    e.phases.forEach(function (x) { fix(x, 'p'); x.financing = x.financing || { enabled: true }; });
    var phaseIds = e.phases.map(function (x) { return x.id; });
    e.components.forEach(function (c) {
      fix(c, 'c');
      if (phaseIds.indexOf(c.phaseId) < 0) c.phaseId = phaseIds[0];
      c.blocks = Array.isArray(c.blocks) ? c.blocks : [];
      c.blocks.forEach(function (b) { fix(b, 'b'); });
      c.items = c.items && typeof c.items === 'object' ? c.items : {};
      c.baseline = c.baseline && typeof c.baseline === 'object' ? c.baseline : { price: null, basis: 'national' };
    });
    e.shared.forEach(function (s) { fix(s, 's'); s.allocation = s.allocation || { method: 'sf' }; });
    e.scenarios.forEach(function (s) { fix(s, 'sc'); s.patch = s.patch || {}; });
    return doc;
  }

  function startNew(doc) {
    doc.engine = E.newProject(D, { mode: 'quick', startMonth: nextMonth() });
    doc.type = 'Estimate';
    st.result = null;
    st.picker = { purpose: 'quick' };
    return doc;
  }

  /* Recompute and write the result into the budget's ordinary fields. */
  function materialize(doc) {
    if (!isEngine(doc) || !D) return null;
    var r = E.calculate(doc.engine, D);
    if (!r || r.error) return null;
    var m = E.toBudgetDoc(r, doc.engine);
    doc.lines = m.lines;
    doc.contingency = m.contingency;
    doc.projectCosts = m.projectCosts;
    doc.companies = m.companies;
    doc.resSF = m.resSF; doc.amenSF = 0; doc.siteSF = m.siteSF;
    doc.engineSummary = m.engineSummary;
    doc.units = Array.isArray(doc.units) ? doc.units : [];
    doc.type = typeLabel(doc.engine, r);
    doc.engine.dataVersion = D.version;
    doc.engine.engineVersion = E.ENGINE_VERSION;
    st.result = r;
    st.resultFor = doc;
    st.sens = null; st.scen = null;
    return r;
  }
  function typeLabel(p, r) {
    if (!p.components.length) return 'Estimate';
    var names = {};
    r.components.forEach(function (c) { names[c.typeName] = 1; });
    var k = Object.keys(names);
    return k.length === 1 ? k[0] : 'Mixed-use (' + k.length + ' types)';
  }
  /* The result on screen. Opening a budget never rewrites it: the saved lines
     stay the record until the user edits the estimate or chooses "Update to
     current research". If the shipped research or engine has changed since
     the save, the screen shows what they give now, next to the saved total
     (dataStale()). Only changed() materializes. */
  function result() {
    var doc = A.getDoc();
    if (!isEngine(doc) || !D) return null;
    if (!st.result || st.resultFor !== doc) { st.result = E.calculate(doc.engine, D); st.resultFor = doc; }
    return st.result;
  }
  function sized(doc) {
    var pf = doc && doc.engineSummary && doc.engineSummary.proforma && doc.engineSummary.proforma.project;
    if (!pf) return false;
    if (pf.sizeSF > 0) return true;
    return Object.keys(pf.primaryUnits || {}).some(function (k) { return pf.primaryUnits[k] > 0; });
  }

  /* A change: mutate → recompute → hand to the app's change pipeline. */
  function changed() {
    var doc = A.getDoc();
    materialize(doc);
    A.touch();          // marks dirty and re-renders via recalc() → paint()
  }

  /* ------------------------------------------------------------ path setters */
  function target(parts) {
    var p = P();
    var head = parts[0];
    var byId = function (arr, id) { return (arr || []).filter(function (x) { return x.id === id; })[0] || null; };
    if (head === 'p') return { obj: p, rest: parts.slice(1) };
    if (head === 'c') return { obj: byId(p.components, parts[1]), rest: parts.slice(2) };
    if (head === 'ph') return { obj: byId(p.phases, parts[1]), rest: parts.slice(2) };
    if (head === 'sh') return { obj: byId(p.shared, parts[1]), rest: parts.slice(2) };
    if (head === 'sc') return { obj: byId(p.scenarios, parts[1]), rest: parts.slice(2) };
    if (head === 'b') {
      var c = byId(p.components, parts[1]);
      return { obj: c ? byId(c.blocks, parts[2]) : null, rest: parts.slice(3) };
    }
    return { obj: null, rest: [] };
  }
  function setPath(path, value) {
    var parts = path.split('.');
    var t = target(parts);
    if (!t.obj || !t.rest.length) return false;
    var o = t.obj;
    for (var i = 0; i < t.rest.length - 1; i++) {
      var k = t.rest[i];
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
      if (!o[k] || typeof o[k] !== 'object') o[k] = {};
      o = o[k];
    }
    var last = t.rest[t.rest.length - 1];
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') return false;
    o[last] = value;
    return true;
  }
  function getPath(path) {
    var parts = path.split('.'), t = target(parts);
    if (!t.obj) return undefined;
    var o = t.obj;
    for (var i = 0; i < t.rest.length; i++) { if (o === null || o === undefined) return undefined; o = o[t.rest[i]]; }
    return o;
  }
  function parse(el) {
    var ty = el.getAttribute('data-t') || 'text';
    if (ty === 'bool') return !!el.checked;
    var v = el.value;
    if (ty === 'num' || ty === 'pct') {
      var s = String(v).replace(/[$,%\s]/g, '');
      if (s === '') return null;
      var n = +s;
      if (!isFinite(n)) return null;
      return ty === 'pct' ? n / 100 : n;
    }
    if (ty === 'month') return /^\d{4}-\d{2}$/.test(v) ? v : null;
    return String(v).slice(0, 200);
  }

  /* ------------------------------------------------------------ small widgets */
  function k(path) { return ' data-k="v2.' + esc(path) + '"'; }
  function numInput(path, val, opts) {
    opts = opts || {};
    var shown = val === null || val === undefined ? '' : (opts.pct ? +(val * 100).toFixed(4) : val);
    return '<input type="number" class="num v2-in" step="' + (opts.step || 'any') + '" min="' + (opts.min === undefined ? 0 : opts.min) + '"'
      + ' data-f="' + esc(path) + '" data-t="' + (opts.pct ? 'pct' : 'num') + '"' + k(path)
      + ' value="' + esc(shown) + '"' + (opts.ph !== undefined ? ' placeholder="' + esc(opts.ph) + '"' : '')
      + (opts.label ? ' aria-label="' + esc(opts.label) + '"' : '') + '>';
  }
  function textInput(path, val, opts) {
    opts = opts || {};
    return '<input type="text" class="v2-in" data-f="' + esc(path) + '" data-t="text"' + k(path) + ' value="' + esc(val || '') + '"'
      + (opts.label ? ' aria-label="' + esc(opts.label) + '"' : '') + ' maxlength="120">';
  }
  function select(path, val, options, opts) {
    opts = opts || {};
    return '<select class="v2-in" data-f="' + esc(path) + '" data-t="' + (opts.t || 'text') + '"' + k(path)
      + (opts.label ? ' aria-label="' + esc(opts.label) + '"' : '') + '>'
      + options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(val) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('')
      + '</select>';
  }
  function fld(label, control, help, cls) {
    return '<label class="fld' + (cls ? ' ' + cls : '') + '"><span class="lab">' + esc(label) + '</span>' + control
      + (help ? '<span class="v2-help">' + help + '</span>' : '') + '</label>';
  }
  function btn(act, label, attrs, cls) {
    return '<button type="button" class="btn ' + (cls || 'btn-ghost btn-sm') + '" data-act="' + act + '"' + (attrs || '') + '>' + label + '</button>';
  }
  function srcBadge(src) {
    if (!src) return '';
    var kind = src.kind === 'user' ? 'user' : (src.kind === 'computed' || src.kind === 'allocation') ? 'computed'
      : src.kind === 'missing' ? 'derived'
      : (src.kind === 'derived' || (src.ref && src.ref.derived)) ? 'derived' : 'research';
    var lab = kind === 'user' ? 'Edited' : kind === 'derived' ? 'Derived — verify' : kind === 'computed' ? 'Computed' : 'Sourced';
    return '<span class="v2-src v2-src-' + kind + '">' + lab + '</span>';
  }

  /* ------------------------------------------------------------ regions */
  function regionOptions() {
    var reg = D.indices && D.indices.regional;
    var f = reg ? reg.factors : { US: 1 }, labels = reg ? reg.labels || {} : {};
    var keys = Object.keys(f).filter(function (x) { return x !== 'US'; });
    var states = keys.filter(function (x) { return /^[A-Z]{2}$/.test(x); }).sort();
    var metros = keys.filter(function (x) { return /-/.test(x); }).sort(function (a, b) {
      return String(labels[a] || a).localeCompare(String(labels[b] || b)); });
    var o = [['US', 'National average (1.00)']];
    metros.forEach(function (x) { o.push([x, (labels[x] || x) + ' (' + (+f[x]).toFixed(2) + ')']); });
    states.forEach(function (x) { o.push([x, (labels[x] || x) + ' — statewide (' + (+f[x]).toFixed(2) + ')']); });
    return o;
  }

  /* ------------------------------------------------------------ type picker */
  function typesByCategory(q) {
    q = String(q || '').toLowerCase().trim();
    var out = [];
    (D.categories || []).forEach(function (cat) {
      var ts = Object.keys(D.types).map(function (id) { return D.types[id]; })
        .filter(function (t) { return t.category === cat.id; })
        .filter(function (t) { return !q || (t.name + ' ' + t.description + ' ' + t.id + ' ' + cat.name).toLowerCase().indexOf(q) >= 0; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (ts.length) out.push({ cat: cat, types: ts });
    });
    return out;
  }
  function pickerHTML() {
    var groups = typesByCategory(st.q);
    var h = '<div class="v2-picker" role="dialog" aria-modal="true" aria-labelledby="v2PickTitle">'
      + '<div class="v2-picker-hd"><h2 id="v2PickTitle">Choose a project type</h2>'
      + '<button type="button" class="btn-x" data-act="close-picker" aria-label="Close">×</button></div>'
      + '<input type="search" class="v2-search" data-ui="q" data-k="v2.pickq" placeholder="Search 90+ project types — e.g. RV, hotel, marina, data center" value="'
      + esc(st.q) + '" aria-label="Search project types">'
      + '<div class="v2-picker-list">';
    if (!groups.length) h += '<p class="v2-empty">No project type matches “' + esc(st.q) + '”. Try another word, or use the Custom builder.</p>';
    groups.forEach(function (g) {
      h += '<div class="v2-cat"><div class="eyebrow">' + esc(g.cat.name) + '</div><div class="v2-cat-grid">';
      g.types.forEach(function (t) {
        var hc = t.hardCost.perPrimaryUnit;
        h += '<button type="button" class="v2-type" data-act="pick-type" data-type="' + esc(t.id) + '">'
          + '<span class="v2-type-name">' + esc(t.name) + '</span>'
          + '<span class="v2-type-desc">' + esc(t.description) + '</span>'
          + '<span class="v2-type-meta mono">' + (hc ? money(hc.mid) + ' / ' + esc(unitL(t.primaryUnit)) : 'Assembled from blocks')
          + (t.evidenceCount ? ' · ' + t.evidenceCount + ' sources' : ' · derived') + '</span></button>';
      });
      h += '</div></div>';
    });
    return h + '</div></div>';
  }

  /* ------------------------------------------------------------ inputs page */
  function renderInputs(host) {
    var doc = A.getDoc();
    if (!host || !isEngine(doc)) return;
    var p = doc.engine, r = result();
    var mode = p.mode || 'quick';
    var h = staleBanner() + '<div class="v2-wrap"><div class="v2-main">';
    h += '<div class="v2-modes"><div class="v2-seg" role="group" aria-label="Estimate mode">'
      + [['quick', 'Quick estimate'], ['mixed', 'Mixed-use & phases'], ['custom', 'Custom builder']].map(function (m) {
        return '<button type="button" aria-pressed="' + (mode === m[0]) + '" class="v2-mode' + (mode === m[0] ? ' on' : '')
          + '" data-act="mode" data-mode="' + m[0] + '">' + m[1] + '</button>'; }).join('')
      + '</div><span class="v2-modes-end">' + btn('save-file', 'Download project file', ' title="Save these estimate inputs as a .json file"')
      + btn('open-file', 'Open project file', ' title="Replace these inputs with a saved .json project file"') + '</span></div>';

    if (!p.components.length && mode !== 'custom') {
      h += '<section class="card"><div class="card-hd"><h2>What are you building?</h2><span class="eyebrow">Step 1 — pick a type</span></div>'
        + '<div class="card-bd"><p class="v2-lede">Pick the project type and enter its size. The budget fills in from researched costs right away — every number can be changed later.</p>'
        + btn('open-picker', 'Choose project type', ' data-purpose="quick"', 'btn-primary') + '</div></section>';
    }
    if (mode === 'quick') p.components.slice(0, 1).forEach(function (c) { h += componentCard(c, r, true); });
    if (mode === 'mixed') h += mixedHTML(p, r);
    if (mode === 'custom') h += customHTML(p, r);
    h += projectCard(p, r);
    h += '</div>' + resultPanel(r) + '</div>';
    if (st.picker) h += '<div class="v2-scrim" data-act="close-picker"></div>' + pickerHTML();
    if (st.drawer) h += drawerHTML();
    host.innerHTML = h;
  }

  function priceHelp(t, c, rc) {
    var hc = t.hardCost.perPrimaryUnit;
    if (!hc) return '';
    var s = hc.source || {};
    return 'Researched ' + money(hc.low) + '–' + money(hc.high) + ', mid ' + money(hc.mid) + ' per ' + esc(unitL(t.primaryUnit))
      + ' (national, ' + D.baseYear + ' $' + (s.derived ? ', <b>derived estimate — verify</b>' : '') + '). '
      + '<button type="button" class="v2-link" data-act="source-type" data-type="' + esc(t.id) + '">Sources</button>'
      + (rc && rc.unitPrice ? ' · This project: <b>' + money(rc.unitPrice) + '</b>/' + esc(unitL(t.primaryUnit)) + ' after location, size, quality and escalation.' : '');
  }

  function componentCard(c, r, quick) {
    var t = D.types[c.typeId];
    var rc = r ? r.components.filter(function (x) { return x.id === c.id; })[0] : null;
    var id = c.id, pre = 'c.' + id + '.';
    if (!t) return '<section class="card"><div class="card-bd"><p class="v2-warn">Unknown project type “' + esc(c.typeId) + '”.</p>'
      + btn('del-comp', 'Remove', ' data-id="' + esc(id) + '"') + '</div></section>';
    var unit = unitL(t.primaryUnit, true);
    var hc = t.hardCost.perPrimaryUnit;
    var h = '<section class="card v2-comp"><div class="card-hd"><h2>' + (quick ? esc(t.name) : textInput(pre + 'name', c.name, { label: 'Component name' })) + '</h2>'
      + '<span class="v2-hd-actions">' + btn('open-picker', quick ? 'Change type' : 'Type: ' + esc(t.name), ' data-purpose="retype" data-id="' + esc(id) + '"')
      + (quick ? '' : btn('del-comp', 'Remove', ' data-id="' + esc(id) + '"')) + '</span></div><div class="card-bd">';
    h += '<p class="v2-typedesc">' + esc(t.description) + '</p>';
    h += '<div class="grid g4">'
      + fld('Size (' + unit + ')', numInput(pre + 'size', c.size, { label: 'Size in ' + unit, step: 1 }),
          t.sizing.typicalSize ? 'Typical ' + num(t.sizing.typicalSize.low, 0) + '–' + num(t.sizing.typicalSize.high, 0) : '')
      + fld('Baseline price per ' + unitL(t.primaryUnit), numInput(pre + 'baseline.price', c.baseline && c.baseline.price, { ph: hc ? Math.round(hc.mid) : '', label: 'Baseline price' }),
          'Blank = researched default')
      + fld('Price basis', select(pre + 'baseline.basis', (c.baseline && c.baseline.basis) || 'national',
          [['national', 'National — apply location'], ['local', 'Already local']]))
      + fld('Quality', select(pre + 'quality', c.quality || 'standard',
          E.QUALITY_TIERS.map(function (q) { return [q, q.charAt(0).toUpperCase() + q.slice(1) + qualityNote(t, q)]; })))
      + '</div>';
    h += '<div class="v2-pricehelp">' + priceHelp(t, c, rc) + '</div>';
    if (!quick) h += '<div class="grid g4" style="margin-top:12px">' + fld('Phase', select(pre + 'phaseId', c.phaseId, P().phases.map(function (x) { return [x.id, x.name]; }))) + '</div>';

    // Advanced
    var open = st.open['adv:' + id];
    h += '<button type="button" class="v2-disclose" data-act="toggle" data-key="adv:' + esc(id) + '" aria-expanded="' + !!open + '">'
      + (open ? '▾' : '▸') + ' Details — area, construction, line items, soft costs, contingency, revenue</button>';
    if (open) h += advancedHTML(c, t, rc, pre);
    if (rc) h += '<div class="v2-comp-sum mono">' + money(rc.totals.total) + ' total · '
      + (rc.metrics.perPrimaryUnit ? money(rc.metrics.perPrimaryUnit) + ' / ' + esc(unitL(t.primaryUnit)) + ' · ' : '')
      + (rc.metrics.perSF && t.primaryUnit !== 'sf' ? money2(rc.metrics.perSF) + ' / SF · ' : '') + rangeChip(rc.range) + '</div>';
    return h + '</div></section>';
  }
  function qualityNote(t, q) {
    var f = t.qualityTiers && isNum(t.qualityTiers[q]) ? t.qualityTiers[q] : null;
    return f && q !== 'standard' ? ' (×' + f.toFixed(2) + ')' : '';
  }
  function rangeChip(rg) {
    if (!rg) return '';
    var cls = rg.status === 'within' ? 'ok' : 'warn';
    return '<span class="v2-chip v2-chip-' + cls + '">' + (rg.status === 'within' ? 'Within researched range' : 'Outside range — ' + rg.status)
      + ' (' + money(rg.min) + '–' + money(rg.max) + ' all-in)</span>';
  }

  function advancedHTML(c, t, rc, pre) {
    var g = rc || { sf: 0, acres: 0 };
    var h = '<div class="v2-adv">';
    h += '<div class="grid g4">'
      + fld('Building SF', numInput(pre + 'sf', c.sf, { ph: Math.round(g.sf || 0), step: 100 }), 'Blank = from size')
      + fld('Site acres', numInput(pre + 'acres', c.acres, { ph: g.acres ? +g.acres.toFixed(2) : '', step: 0.1 }), 'Blank = from density');
    if (t.template && t.template.constructionType) {
      h += fld('Construction type', select(pre + 'constructionType', c.constructionType || t.template.constructionType,
        [['VB', 'Type V-B (wood)'], ['VA', 'Type V-A (wood, rated)'], ['III', 'Type III'], ['IV', 'Type IV (mass timber)'], ['II', 'Type II (non-comb.)'], ['I', 'Type I (concrete/steel)']]),
        'Research basis: ' + esc(t.template.constructionType))
        + fld('Stories', numInput(pre + 'stories', c.stories, { ph: t.template.stories, step: 1 }), 'Research basis: ' + esc(t.template.stories));
    }
    h += '</div>';
    // Parking, FF&E
    h += '<div class="grid g4" style="margin-top:12px">'
      + fld('Added parking', select(pre + 'parking.type', (c.parking && c.parking.type) || 'none',
        [['none', 'None beyond the baseline'], ['surface', 'Surface'], ['structured-above', 'Structured (above grade)'], ['structured-below', 'Structured (below grade)'],
          ['podium', 'Podium'], ['tuck-under', 'Tuck-under'], ['carport-covered', 'Covered carport']]))
      + fld('Parking spaces', numInput(pre + 'parking.spaces', c.parking && c.parking.spaces, { ph: g.spaces ? Math.round(g.spaces) : '', step: 1 }))
      + (t.ffe ? fld('FF&E', '<label class="chk"><input type="checkbox" data-f="' + esc(pre + 'includeFFE') + '" data-t="bool"' + k(pre + 'includeFFE')
          + (c.includeFFE !== false ? ' checked' : '') + '> Include ' + money(t.ffe.perPrimaryUnit.mid) + ' / ' + esc(unitL(t.primaryUnit)) + '</label>') : '')
      + '</div>';
    // Line items
    var items = (t.lineItems || []);
    if (items.length) {
      h += '<div class="v2-sub">Specialty &amp; fixed items</div><table class="tbl v2-tbl"><thead><tr><th>Item</th><th class="r">Qty</th><th>Unit</th><th class="r">Unit cost</th><th>Included</th><th>Basis</th></tr></thead><tbody>';
      items.forEach(function (li) {
        var sw = (c.items || {})[li.id] || {};
        var on = li.inBaseline ? true : (sw.on !== undefined ? sw.on : !li.optional);
        h += '<tr><td>' + esc(li.name) + (li.notes ? '<div class="v2-note">' + esc(li.notes) + '</div>' : '') + '</td>'
          + '<td class="r">' + (li.inBaseline ? esc(qtyLabel(li)) : numInput(pre + 'items.' + li.id + '.qty', sw.qty, { ph: qtyLabel(li), step: 1, label: li.name + ' quantity' })) + '</td>'
          + '<td>' + esc(unitL(li.unit)) + '</td><td class="r mono">' + money(li.cost.mid) + '</td>'
          + '<td>' + (li.inBaseline ? '<span class="v2-chip">In baseline</span>'
            : '<input type="checkbox" data-f="' + esc(pre + 'items.' + li.id + '.on') + '" data-t="bool"' + k(pre + 'items.' + li.id + '.on') + (on ? ' checked' : '')
              + ' aria-label="Include ' + esc(li.name) + '">') + '</td>'
          + '<td>' + srcBadge({ kind: li.cost.source && li.cost.source.derived ? 'derived' : 'research' }) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    // Soft, contingency
    var sp = t.softCosts && t.softCosts.pctOfHard ? t.softCosts.pctOfHard.mid : null;
    var cg = t.contingency || {};
    h += '<div class="grid g4" style="margin-top:12px">'
      + fld('Soft costs (% of hard)', numInput(pre + 'softCostPct', c.softCostPct, { pct: 1, ph: sp !== null ? +(sp * 100).toFixed(2) : '', step: 0.5 }),
        'Excludes fees, developer fee, financing')
      + fld('Design contingency %', numInput(pre + 'contingency.design', c.contingency && c.contingency.design, { pct: 1, ph: cg.design ? +(cg.design.mid * 100).toFixed(2) : '', step: 0.5 }))
      + fld('Hard cost contingency %', numInput(pre + 'contingency.hard', c.contingency && c.contingency.hard, { pct: 1, ph: cg.hard ? +(cg.hard.mid * 100).toFixed(2) : '', step: 0.5 }))
      + fld('Soft cost contingency %', numInput(pre + 'contingency.soft', c.contingency && c.contingency.soft, { pct: 1, ph: cg.soft ? +(cg.soft.mid * 100).toFixed(2) : '', step: 0.5 }))
      + '</div>';
    // Revenue for the pro forma
    var rv = c.revenue || {};
    h += '<div class="v2-sub">Revenue (feeds the pro forma — leave blank if not needed)</div><div class="grid g4">'
      + fld('Revenue basis', select(pre + 'revenue.mode', rv.mode || 'perUnitMonth',
        [['perUnitMonth', 'Per ' + unitL(t.primaryUnit) + ' per month'], ['perUnitYear', 'Per ' + unitL(t.primaryUnit) + ' per year'],
          ['perSFYear', 'Per SF per year'], ['annual', 'Total per year']]))
      + fld('Rate ($)', numInput(pre + 'revenue.rate', rv.rate, { step: 1 }))
      + fld('Other income / yr ($)', numInput(pre + 'revenue.otherIncome', rv.otherIncome, { step: 100 }))
      + fld('Vacancy %', numInput(pre + 'revenue.vacancy', rv.vacancy, { pct: 1, step: 0.5 }))
      + fld('Operating expenses (% of income)', numInput(pre + 'revenue.expenseRatio', rv.expenseRatio, { pct: 1, step: 0.5 }))
      + '</div>';
    if (t.summary) h += '<p class="v2-note" style="margin-top:12px"><b>Research note:</b> ' + esc(t.summary) + '</p>';
    return h + '</div>';
  }
  function qtyLabel(li) {
    var q = li.qty || {};
    return q.per === 'project' ? String(q.value) : q.value + ' per ' + (q.per === 'primaryUnit' ? 'unit' : q.per);
  }

  function projectCard(p, r) {
    var ph0 = p.phases[0];
    var rp0 = r && r.phases[0];
    var h = '<section class="card"><div class="card-hd"><h2>Location, schedule &amp; land</h2><span class="eyebrow">Applies to the whole project</span></div><div class="card-bd">';
    h += '<div class="grid g4">'
      + fld('Location', select('p.location.region', (p.location && p.location.region) || 'US', regionOptions(), { label: 'Location' }),
        r ? 'Cost factor ' + r.region.factor.toFixed(3) + ' vs national' : '')
      + fld('Construction start', '<input type="month" class="v2-in" data-f="p.startMonth" data-t="month"' + k('p.startMonth') + ' value="' + esc(p.startMonth || '') + '">')
      + (p.mode !== 'mixed' ? fld('Construction months', numInput('ph.' + ph0.id + '.months', ph0.months, { ph: rp0 ? rp0.months : '', step: 1 }),
          'Blank = Census average for this type and value') : '')
      + fld('Escalation per year', numInput('p.settings.escalationRate', p.settings.escalationRate, { pct: 1, step: 0.1,
          ph: D.indices.escalation && D.indices.escalation.forecast ? +(100 * avgForecast()).toFixed(2) : '' }),
          rp0 && rp0.escalation ? 'To midpoint: ' + pct(rp0.escalation.factor - 1, 2) : '')
      + '</div>';
    h += '<div class="grid g4" style="margin-top:12px">'
      + fld('Land price basis', select('p.land.mode', p.land.mode || 'amount', [['amount', 'Total amount'], ['perAcre', 'Per acre'], ['perUnit', 'Per primary unit']]))
      + fld('Land price ($)', numInput('p.land.value', p.land.value, { step: 1000 }))
      + fld('Total site acres', numInput('p.land.acres', p.land.acres, { ph: r && r.metrics.acres ? +r.metrics.acres.toFixed(2) : '', step: 0.1 }))
      + fld('Land closing %', numInput('p.land.closingPct', p.land.closingPct, { pct: 1, step: 0.25, ph: 2 }))
      + '</div>';
    if (p.mode !== 'mixed') {
      var f = ph0.financing || {};
      h += '<div class="grid g4" style="margin-top:12px">'
        + fld('Construction loan', '<label class="chk"><input type="checkbox" data-f="ph.' + esc(ph0.id) + '.financing.enabled" data-t="bool"' + k('ph.' + ph0.id + '.financing.enabled')
          + (f.enabled !== false ? ' checked' : '') + '> Model a construction loan</label>')
        + fld('Loan-to-cost %', numInput('ph.' + ph0.id + '.financing.ltc', f.ltc, { pct: 1, step: 1, ph: rp0 && rp0.financing ? +(rp0.financing.ltc * 100).toFixed(1) : '' }))
        + fld('Interest rate %', numInput('ph.' + ph0.id + '.financing.rate', f.rate, { pct: 1, step: 0.125, ph: rp0 && rp0.financing ? +(rp0.financing.rate * 100).toFixed(3) : '' }))
        + fld('Loan fee %', numInput('ph.' + ph0.id + '.financing.feePct', f.feePct, { pct: 1, step: 0.25, ph: rp0 && rp0.financing ? +(rp0.financing.feePct * 100).toFixed(2) : '' }))
        + '</div>';
    }
    h += '<div class="grid g4" style="margin-top:12px">'
      + fld('Developer fee %', numInput('p.settings.developerFeePct', p.settings.developerFeePct, { pct: 1, step: 0.5, ph: 4 }), 'Of cost excl. land and financing')
      + '</div>';
    return h + '</div></section>';
  }
  function avgForecast() {
    var fc = D.indices.escalation.forecast || {}, ks = Object.keys(fc);
    return ks.length ? ks.reduce(function (s, x) { return s + (+fc[x]); }, 0) / ks.length : 0;
  }

  function mixedHTML(p, r) {
    var h = '';
    p.components.forEach(function (c) { h += componentCard(c, r, false); });
    h += '<section class="card"><div class="card-bd v2-addrow">' + btn('open-picker', '+ Add component', ' data-purpose="add"', 'btn-dark btn-sm')
      + '<span class="v2-note">A project is one or more components — residential, retail, hotel, parking… Each can sit in its own phase.</span></div></section>';
    h += sharedHTML(p, r) + phasesHTML(p, r);
    return h;
  }

  function blockOptions() {
    var o = [['', '— choose a building block —']];
    Object.keys(D.blocks).map(function (id) { return D.blocks[id]; })
      .sort(function (a, b) { return (a.blockName + a.name).localeCompare(b.blockName + b.name); })
      .forEach(function (b) { o.push([b.id, b.blockName + ' · ' + b.name + ' (' + money(b.cost.mid) + '/' + unitL(b.unit) + ')']); });
    return o;
  }

  function sharedHTML(p, r) {
    var h = '<section class="card"><div class="card-hd"><h2>Shared elements</h2><span class="eyebrow">Built once, split across components</span></div><div class="card-bd">';
    if (!p.shared.length) h += '<p class="v2-note">Parking structures, podiums, site work, amenities or infrastructure that several components share. Each one is priced once and divided by the method you choose.</p>';
    p.shared.forEach(function (s) {
      var pre = 'sh.' + s.id + '.';
      var rs = r ? r.shared.filter(function (x) { return x.id === s.id; })[0] : null;
      h += '<div class="v2-shared"><div class="grid g4">'
        + fld('Name', textInput(pre + 'name', s.name))
        + fld('Building block', select(pre + 'itemId', s.itemId || '', blockOptions()))
        + fld('Quantity', numInput(pre + 'qty', s.qty, { step: 1 }))
        + fld('Unit cost override ($)', numInput(pre + 'unitCost', s.unitCost, { step: 1 }))
        + '</div><div class="grid g4" style="margin-top:10px">'
        + fld('Phase', select(pre + 'phaseId', s.phaseId || p.phases[0].id, p.phases.map(function (x) { return [x.id, x.name]; })))
        + fld('Split by', select(pre + 'allocation.method', (s.allocation && s.allocation.method) || 'sf',
          [['sf', 'Building SF'], ['units', 'Primary units'], ['revenue', 'Revenue share'], ['cost', 'Direct cost'], ['equal', 'Equal'], ['manual', 'Manual %']]))
        + '<div class="fld"><span class="lab">Cost</span><div class="mono v2-big">' + (rs ? money(rs.amount) : '—') + '</div></div>'
        + '<div class="fld"><span class="lab">&nbsp;</span>' + btn('del-shared', 'Remove', ' data-id="' + esc(s.id) + '"') + '</div></div>';
      if (s.allocation && s.allocation.method === 'manual') {
        h += '<div class="grid g4" style="margin-top:10px">' + p.components.map(function (c) {
          return fld(c.name + ' share %', numInput(pre + 'allocation.shares.' + c.id, s.allocation.shares && s.allocation.shares[c.id], { pct: 1, step: 1 }));
        }).join('') + '</div>';
      }
      if (rs && rs.shares.length) h += '<div class="v2-note">Split: ' + rs.shares.map(function (x) {
        var c = r.components.filter(function (y) { return y.id === x.comp; })[0];
        return esc(c ? c.name : x.comp) + ' ' + money(x.amount); }).join(' · ') + '</div>';
      h += '</div>';
    });
    return h + btn('add-shared', '+ Add shared element', '', 'btn-ghost btn-sm') + '</div></section>';
  }

  function phasesHTML(p, r) {
    var h = '<section class="card"><div class="card-hd"><h2>Phases</h2><span class="eyebrow">Timeline, escalation &amp; financing per phase</span></div><div class="card-bd">';
    var phs = r ? r.phases : [];
    var mi = function (m) { var x = /^(\d{4})-(\d{2})$/.exec(m || ''); return x ? +x[1] * 12 + (+x[2] - 1) : null; };
    var starts = phs.map(function (x) { return mi(x.start); }).filter(function (x) { return x !== null; });
    var ends = phs.map(function (x) { var s = mi(x.start); return s === null ? null : s + x.months; }).filter(function (x) { return x !== null; });
    var t0 = starts.length ? Math.min.apply(null, starts) : null, t1 = ends.length ? Math.max.apply(null, ends) : null;
    if (t0 !== null && t1 > t0) {
      h += '<div class="v2-gantt" aria-label="Phase timeline">';
      phs.forEach(function (x) {
        var s = mi(x.start); if (s === null) return;
        var left = 100 * (s - t0) / (t1 - t0), w = 100 * x.months / (t1 - t0);
        h += '<div class="v2-gantt-row"><span class="v2-gantt-lab">' + esc(x.name) + '</span><span class="v2-gantt-track">'
          + '<span class="v2-gantt-bar" style="left:' + left.toFixed(2) + '%;width:' + Math.max(1, w).toFixed(2) + '%">'
          + esc(x.start) + ' · ' + x.months + ' mo · ' + short(x.totals.total) + '</span></span></div>';
      });
      h += '</div>';
    }
    p.phases.forEach(function (ph, i) {
      var pre = 'ph.' + ph.id + '.';
      var rp = phs.filter(function (x) { return x.id === ph.id; })[0];
      var f = ph.financing || {};
      h += '<div class="v2-phase"><div class="grid g4">'
        + fld('Name', textInput(pre + 'name', ph.name))
        + fld('Start month', '<input type="month" class="v2-in" data-f="' + esc(pre + 'startMonth') + '" data-t="month"' + k(pre + 'startMonth') + ' value="' + esc(ph.startMonth || '') + '">',
          i === 0 ? 'Blank = project start' : 'Blank = after the previous phase')
        + fld('Months', numInput(pre + 'months', ph.months, { ph: rp ? rp.months : '', step: 1 }))
        + fld('Draw curve', select(pre + 'drawCurve', ph.drawCurve || 's', [['s', 'S-curve'], ['linear', 'Straight line'], ['front', 'Front-loaded'], ['back', 'Back-loaded']]))
        + '</div><div class="grid g4" style="margin-top:10px">'
        + fld('Loan-to-cost %', numInput(pre + 'financing.ltc', f.ltc, { pct: 1, step: 1, ph: rp && rp.financing ? +(rp.financing.ltc * 100).toFixed(1) : '' }))
        + fld('Interest rate %', numInput(pre + 'financing.rate', f.rate, { pct: 1, step: 0.125, ph: rp && rp.financing ? +(rp.financing.rate * 100).toFixed(3) : '' }))
        + fld('Financing', '<label class="chk"><input type="checkbox" data-f="' + esc(pre + 'financing.enabled') + '" data-t="bool"' + k(pre + 'financing.enabled')
          + (f.enabled !== false ? ' checked' : '') + '> Construction loan</label>')
        + '<div class="fld"><span class="lab">Phase total</span><div class="mono v2-big">' + (rp ? money(rp.totals.total) : '—') + '</div>'
        + (rp ? '<span class="v2-help">Midpoint ' + esc(rp.midpoint || '—') + ' · escalation ' + pct(rp.escalation.factor - 1, 2) + '</span>' : '') + '</div>'
        + '</div>' + (p.phases.length > 1 ? btn('del-phase', 'Remove phase', ' data-id="' + esc(ph.id) + '"') : '') + '</div>';
    });
    return h + btn('add-phase', '+ Add phase', '', 'btn-ghost btn-sm') + '</div></section>';
  }

  function customHTML(p, r) {
    var c = p.components.filter(function (x) { return x.typeId === 'custom'; })[0];
    var h = '<section class="card"><div class="card-hd"><h2>Custom builder</h2><span class="eyebrow">Assemble a project from cost building blocks</span></div><div class="card-bd">';
    if (!c) {
      h += '<p class="v2-lede">For anything no template fits: add priced building blocks — a metal building, site work by the acre, a pool, docks, solar, parking — or your own priced items. Soft costs, contingency, fees and financing are added the same way as any template.</p>'
        + btn('add-custom', 'Start a custom component', '', 'btn-primary') + '</div></section>';
      p.components.filter(function (x) { return x.typeId !== 'custom'; }).forEach(function (x) { h += componentCard(x, r, false); });
      return h;
    }
    var rc = r ? r.components.filter(function (x) { return x.id === c.id; })[0] : null;
    h += '<div class="grid g4">' + fld('Component name', textInput('c.' + c.id + '.name', c.name)) + '</div>';
    h += '<table class="tbl v2-tbl" style="margin-top:12px"><thead><tr><th>Block</th><th class="r">Qty</th><th>Unit</th><th class="r">Researched unit cost</th><th class="r">Your unit cost</th><th class="r">Amount</th><th></th></tr></thead><tbody>';
    (c.blocks || []).forEach(function (b) {
      var bi = D.blocks[b.itemId];
      var line = r ? r.lines.filter(function (l) { return l.key === c.id + ':block:' + b.id; })[0] : null;
      var pre = 'b.' + c.id + '.' + b.id + '.';
      h += '<tr><td>' + (bi ? esc(bi.blockName) + ' · ' + esc(bi.name) : textInput(pre + 'name', b.name || '', { label: 'Item name' }))
        + (bi && bi.cost.source && bi.cost.source.derived ? ' ' + srcBadge({ kind: 'derived' }) : '') + '</td>'
        + '<td class="r">' + numInput(pre + 'qty', b.qty, { step: 1, label: 'Quantity' }) + '</td>'
        + '<td>' + esc(bi ? unitL(bi.unit) : (b.unit || 'ea')) + '</td>'
        + '<td class="r mono">' + (bi ? money(bi.cost.mid) : '—') + '</td>'
        + '<td class="r">' + numInput(pre + 'unitCost', b.unitCost, { step: 1, label: 'Unit cost override' }) + '</td>'
        + '<td class="r mono">' + (line ? money(line.amount) : '—') + '</td>'
        + '<td>' + btn('del-block', '×', ' data-comp="' + esc(c.id) + '" data-id="' + esc(b.id) + '" aria-label="Remove block"', 'btn-x') + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<div class="v2-blockadd"><input type="search" class="v2-search" data-ui="blockQ" data-k="v2.blockq" placeholder="Search building blocks — pool, dock, metal building, site work, solar…" value="' + esc(st.blockQ) + '" aria-label="Search building blocks">';
    var q = st.blockQ.toLowerCase().trim();
    var list = Object.keys(D.blocks).map(function (id) { return D.blocks[id]; })
      .filter(function (b) { return !q || (b.name + ' ' + b.blockName + ' ' + b.id).toLowerCase().indexOf(q) >= 0; })
      .sort(function (a, z) { return (a.blockName + a.name).localeCompare(z.blockName + z.name); }).slice(0, q ? 40 : 12);
    h += '<div class="v2-blocklist">' + list.map(function (b) {
      return '<button type="button" class="v2-blockbtn" data-act="add-block" data-comp="' + esc(c.id) + '" data-item="' + esc(b.id) + '">'
        + '<span>' + esc(b.blockName) + ' · ' + esc(b.name) + '</span><span class="mono">' + money(b.cost.mid) + '/' + esc(unitL(b.unit)) + '</span></button>';
    }).join('') + '<button type="button" class="v2-blockbtn" data-act="add-block" data-comp="' + esc(c.id) + '" data-item=""><span>Your own priced item</span><span class="mono">enter cost</span></button></div></div>';
    if (rc) h += '<div class="v2-comp-sum mono">' + money(rc.totals.total) + ' total including soft costs, contingency, fees and financing</div>';
    h += '</div></section>';
    p.components.filter(function (x) { return x.id !== c.id; }).forEach(function (x) { h += componentCard(x, r, false); });
    h += '<section class="card"><div class="card-bd v2-addrow">' + btn('open-picker', '+ Add a templated component', ' data-purpose="add"', 'btn-ghost btn-sm') + '</div></section>';
    return h;
  }

  function resultPanel(r) {
    var h = '<aside class="v2-side" aria-live="polite"><div class="v2-sticky card"><div class="card-bd">';
    if (!r || !r.components.length) return h + '<div class="eyebrow">Total project cost</div><div class="v2-total">—</div><p class="v2-note">Pick a project type to see the budget.</p></div></div></aside>';
    var T = r.totals, m = r.metrics, s = r.split;
    h += '<div class="eyebrow">Total project cost</div><div class="v2-total mono">' + money(T.total) + '</div>';
    h += '<div class="v2-kpis">'
      + (m.perPrimaryUnit ? '<div><span class="k">Per ' + esc(unitL(m.unit)) + '</span><span class="v mono">' + money(m.perPrimaryUnit) + '</span></div>' : '')
      + (m.perSF ? '<div><span class="k">Per SF</span><span class="v mono">' + money2(m.perSF) + '</span></div>' : '')
      + (m.perAcre ? '<div><span class="k">Per acre</span><span class="v mono">' + money(m.perAcre) + '</span></div>' : '')
      + '</div>';
    h += '<div class="v2-split" role="img" aria-label="Hard ' + pct(s.hard, 0) + ', soft ' + pct(s.soft, 0) + ', land ' + pct(s.land, 0) + '">'
      + '<span class="v2-split-h" style="width:' + (100 * s.hard).toFixed(2) + '%"></span><span class="v2-split-s" style="width:' + (100 * s.soft).toFixed(2)
      + '%"></span><span class="v2-split-l" style="width:' + (100 * s.land).toFixed(2) + '%"></span></div>'
      + '<div class="v2-legend"><span><i class="v2-split-h"></i>Hard ' + pct(s.hard, 0) + '</span><span><i class="v2-split-s"></i>Soft ' + pct(s.soft, 0)
      + '</span><span><i class="v2-split-l"></i>Land ' + pct(s.land, 0) + '</span></div>';
    h += '<table class="v2-mini"><tbody>'
      + row('Construction', T.hard) + row('FF&E', T.ffe) + row('Contingency', T.hardContingency + T.softContingency)
      + row('Soft costs', T.soft - T.fees - T.developerFee) + row('Impact & tap fees', T.fees) + row('Developer fee', T.developerFee)
      + row('Financing', T.financing) + row('Land', T.land) + '</tbody></table>';
    var warn = r.warnings.filter(function (w) { return w.level !== 'info'; });
    if (warn.length) h += '<div class="v2-warns">' + warn.map(function (w) { return '<p class="v2-warn">' + esc(w.message) + '</p>'; }).join('') + '</div>';
    h += '<div class="v2-side-actions">' + btn('goto-detail', 'Open detailed budget →', '', 'btn-primary btn-sm') + '</div>';
    return h + '</div></div></aside>';
    function row(l, v) { return v ? '<tr><td>' + esc(l) + '</td><td class="r mono">' + money(v) + '</td></tr>' : ''; }
  }

  /* ------------------------------------------------------------ detail page */
  function renderDetail(host) {
    var doc = A.getDoc();
    if (!host || !isEngine(doc)) return;
    var r = result(), p = doc.engine;
    var h = '<div class="v2-detail">';
    h += '<div class="v2-toolbar no-print"><div class="v2-views" role="group" aria-label="Estimate views">'
      + [['detail', 'Budget detail'], ['draws', 'Draw schedule'], ['scenarios', 'Scenarios'], ['sensitivity', 'Sensitivity'], ['sources', 'Sources & assumptions']].map(function (v) {
        return '<button type="button" aria-pressed="' + (st.view === v[0]) + '" class="v2-mode' + (st.view === v[0] ? ' on' : '') + '" data-act="view" data-view="' + v[0] + '">' + v[1] + '</button>';
      }).join('') + '</div><div class="v2-tool-actions">'
      + btn('export-xlsx', 'Excel', ' title="Download the estimate workbook"') + btn('export-pdf', 'PDF', ' title="Download the estimate report"')
      + '</div></div>';
    if (!r || !r.components.length) {
      h += '<section class="card"><div class="card-bd v2-emptystate"><h2>No components yet</h2><p>Go to Inputs and pick a project type — the detailed budget builds itself from there.</p>'
        + btn('goto-inputs', 'Go to Inputs', '', 'btn-primary') + '</div></section></div>';
      host.innerHTML = h; return;
    }
    h += summaryBand(r);
    h += proformaBar(r);
    h += staleBanner();
    if (st.view === 'detail') h += detailTree(r, p);
    if (st.view === 'draws') h += drawsHTML(r);
    if (st.view === 'scenarios') h += scenariosHTML(p, r);
    if (st.view === 'sensitivity') h += sensitivityHTML(p);
    if (st.view === 'sources') h += sourcesHTML(r);
    h += '</div>';
    if (st.drawer) h += drawerHTML();
    host.innerHTML = h;
  }
  function dataStale(p) {
    return !!(p && ((p.dataVersion && D.version && p.dataVersion !== D.version)
      || (p.engineVersion && p.engineVersion !== E.ENGINE_VERSION)));
  }
  function staleBanner() {
    var doc = A.getDoc(), p = doc.engine;
    if (!dataStale(p)) return '';
    var saved = doc.engineSummary && doc.engineSummary.totals ? doc.engineSummary.totals.total : null;
    var r = st.result;
    return '<div class="banner"><span>Saved with research data <b>' + esc(p.dataVersion) + '</b>' + (p.engineVersion && p.engineVersion !== E.ENGINE_VERSION ? ' and ' + esc(p.engineVersion) : '')
      + (saved !== null ? ' (total ' + money(saved) + ')' : '')
      + '. The app now ships <b>' + esc(D.version) + '</b> / ' + esc(E.ENGINE_VERSION) + ', which gives ' + (r ? money(r.totals.total) : '—')
      + '. The saved budget is unchanged until you edit it or update.</span>' + btn('update-research', 'Update to current research', '', 'btn-sm btn-dark') + '</div>';
  }

  function summaryBand(r) {
    var T = r.totals, m = r.metrics;
    var tiles = [['Total project cost', money(T.total)], ['Hard', money(T.hardAll)], ['Soft', money(T.softAll)], ['Land', money(T.land)]];
    if (m.perPrimaryUnit) tiles.push(['Per ' + unitL(m.unit), money(m.perPrimaryUnit)]);
    if (m.perSF) tiles.push(['Per SF', money2(m.perSF)]);
    if (m.perAcre) tiles.push(['Per acre', money(m.perAcre)]);
    return '<div class="stats v2-stats">' + tiles.map(function (t) { return '<div class="stat"><div class="k">' + esc(t[0]) + '</div><div class="v">' + esc(t[1]) + '</div></div>'; }).join('') + '</div>'
      + (r.warnings.some(function (w) { return w.code === 'range'; }) ? '<div class="v2-warns">' + r.warnings.filter(function (w) { return w.code === 'range'; })
        .map(function (w) { return '<p class="v2-warn">' + esc(w.message) + '</p>'; }).join('') + '</div>' : '');
  }

  function proformaBar(r) {
    var opts = [['project', 'Whole project']];
    r.components.forEach(function (c) { opts.push(['component:' + c.id, 'Component — ' + c.name]); });
    if (r.phases.length > 1) r.phases.forEach(function (x) { opts.push(['phase:' + x.id, 'Phase — ' + x.name]); });
    var sel = '<select class="v2-in" data-ui="scope" aria-label="Pro forma scope">' + opts.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (st.scope === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    var pf = scopeData(r);
    var noIncome = !(pf && pf.income && pf.income.year1PotentialIncome > 0);
    return '<section class="card v2-pfbar no-print"><div class="card-bd"><div class="v2-pf-row"><div><div class="eyebrow">Pro forma handoff</div>'
      + '<div class="v2-note">Sends the cost, size and revenue of the scope you pick to a new investment analysis. Save first; the analysis is built from the saved version.</div></div>'
      + '<div class="v2-pf-ctl">' + sel + btn('proforma', 'Create pro forma →', '', 'btn-primary btn-sm') + '</div></div>'
      + (pf ? '<div class="v2-note mono">' + money(pf.totalCost) + ' cost · ' + (pf.size ? num(pf.size.value, 0) + (pf.size.unit === 'squareFeet' ? ' SF' : ' units') : 'no size')
        + ' · Year-1 income ' + (noIncome ? '— (enter revenue on Inputs → Details)' : money(pf.income.year1PotentialIncome)) + '</div>' : '')
      + '</div></section>';
  }
  function scopeData(r) {
    if (!r || !r.proforma) return null;
    if (st.scope === 'project') return r.proforma.project;
    var x = st.scope.split(':');
    var list = x[0] === 'component' ? r.proforma.components : r.proforma.phases;
    return list.filter(function (s) { return s.id === x[1]; })[0] || r.proforma.project;
  }

  function detailTree(r, p) {
    var h = '<section class="card"><div class="card-hd"><h2>Detailed budget</h2><span class="v2-hd-actions">'
      + btn('expand-all', 'Expand all') + btn('collapse-all', 'Collapse all') + '</span></div><div class="card-bd v2-scroll">';
    h += '<table class="tbl v2-tree"><thead><tr><th>Line</th><th class="r">Qty</th><th>Unit</th><th class="r">Rate</th><th class="r">Amount</th><th>Source</th></tr></thead><tbody>';
    var groups = r.components.map(function (c) { return { id: c.id, name: c.name, sub: c.typeName, lines: r.lines.filter(function (l) { return l.comp === c.id; }), total: c.totals.total }; });
    var loose = r.lines.filter(function (l) { return !l.comp; });
    if (loose.length) groups.push({ id: '_project', name: 'Project-level', sub: 'Not allocated to a component', lines: loose,
      total: loose.reduce(function (s, l) { return s + l.amount; }, 0) });
    var phaseName = {};
    r.phases.forEach(function (x) { phaseName[x.id] = x.name; });
    groups.forEach(function (g) {
      var ck = 'c:' + g.id, cOpen = st.open[ck] !== false;
      h += treeRow(ck, cOpen, 0, esc(g.name) + ' <span class="v2-sub-inline">' + esc(g.sub) + '</span>', g.total);
      if (!cOpen) return;
      var phases = {};
      g.lines.forEach(function (l) { (phases[l.phase] = phases[l.phase] || []).push(l); });
      Object.keys(phases).forEach(function (ph) {
        var pk = ck + '|' + ph, pOpen = st.open[pk] !== false;
        var pl = phases[ph];
        if (r.phases.length > 1) h += treeRow(pk, pOpen, 1, esc(phaseName[ph] || ph), pl.reduce(function (s, l) { return s + l.amount; }, 0));
        if (r.phases.length > 1 && !pOpen) return;
        var grp = {};
        pl.forEach(function (l) { var gname = l.category === 'hard' && l.division ? 'Division ' + l.division + ' — ' + E._.csiTitle(l.division) : l.group;
          (grp[gname] = grp[gname] || []).push(l); });
        Object.keys(grp).sort(groupOrder).forEach(function (gname) {
          var gk = pk + '|' + gname, gOpen = st.open[gk] === true;
          var gl = grp[gname];
          // A division that is a single line needs no group row of its own.
          if (gl.length === 1 && /^Division/.test(gname)) {
            var one = Object.assign({}, gl[0], { name: gname });
            h += lineRow(one, r.phases.length > 1 ? 2 : 1);
            return;
          }
          var edited = gl.some(function (l) { return l.overridden; });
          h += treeRow(gk, gOpen, r.phases.length > 1 ? 2 : 1, esc(gname) + (edited ? ' <span class="v2-src v2-src-user">Edited</span>' : ''),
            gl.reduce(function (s, l) { return s + l.amount; }, 0));
          if (!gOpen) return;
          gl.forEach(function (l) { h += lineRow(l, r.phases.length > 1 ? 3 : 2); });
        });
      });
    });
    h += '<tr class="v2-tot"><td>Total project cost</td><td></td><td></td><td></td><td class="r mono">' + money(r.totals.total) + '</td><td></td></tr>';
    return h + '</tbody></table></div></section>';
  }
  function groupOrder(a, b) {
    var rank = function (s) { return /^Division/.test(s) ? 0 : /Specialty|Building blocks|Parking|Shared/.test(s) ? 1 : /FF&E/.test(s) ? 2
      : /Contingency/.test(s) ? 3 : /Soft/.test(s) ? 4 : /fees/i.test(s) ? 5 : /Developer/.test(s) ? 6 : /Financing/.test(s) ? 7 : /Land/.test(s) ? 8 : 9; };
    return rank(a) - rank(b) || a.localeCompare(b);
  }
  function treeRow(key, open, depth, label, amount) {
    return '<tr class="v2-trow v2-d' + depth + '"><td><button type="button" class="v2-tog" data-act="toggle" data-key="' + esc(key) + '" aria-expanded="' + open + '">'
      + (open ? '▾' : '▸') + '</button> ' + label + '</td><td></td><td></td><td></td><td class="r mono">' + money(amount) + '</td><td></td></tr>';
  }
  function lineRow(l, depth) {
    var isPct = /^%/.test(l.uom || '');
    var qty = l.qty === null ? '' : isPct ? pct(l.qty, 2) : num(l.qty, 2);
    var rate = l.rate === null ? '' : isPct ? money(l.rate) : money2(l.rate);
    var input = '<input type="number" class="num v2-in v2-ov" step="1" data-ov="' + esc(l.key) + '" data-k="v2.ov.' + esc(l.key) + '" value="'
      + (l.overridden ? Math.round(l.amount * 100) / 100 : Math.round(l.amount)) + '" aria-label="Amount for ' + esc(l.name) + '">';
    return '<tr class="v2-line v2-d' + depth + (l.overridden ? ' v2-edited' : '') + '"><td>' + esc(l.name) + (l.carveOut ? ' <span class="v2-note">(within baseline)</span>' : '') + '</td>'
      + '<td class="r mono">' + qty + '</td><td>' + esc(isPct ? l.uom : unitL(l.uom)) + '</td><td class="r mono">' + (isPct ? 'of ' : '') + rate + '</td>'
      + '<td class="r">' + input + (l.overridden ? '<button type="button" class="v2-link" data-act="reset-ov" data-key="' + esc(l.key) + '" title="Back to ' + money(l.baseAmount) + '">reset</button>' : '') + '</td>'
      + '<td><button type="button" class="v2-srcbtn" data-act="source" data-key="' + esc(l.key) + '" data-k="v2.src.' + esc(l.key) + '" aria-label="Source for '
      + esc(l.name) + '">' + srcBadge(l.source) + '</button></td></tr>';
  }

  function drawsHTML(r) {
    var h = '';
    r.phases.forEach(function (x) {
      h += '<section class="card"><div class="card-hd"><h2>' + esc(x.name) + ' — monthly draws</h2><span class="eyebrow">' + esc(x.start || 'no start date') + ' · ' + x.months
        + ' months' + (x.financing && x.financing.enabled ? ' · loan ' + money(x.financing.loan) + ' at ' + pct(x.financing.rate, 2) + ', interest ' + money(x.financing.interest) : '') + '</span></div>'
        + '<div class="card-bd v2-scroll">';
      if (!x.draws.length || !x.totals.total) { h += '<p class="v2-note">Nothing is built in this phase.</p></div></section>'; return; }
      var mx = Math.max.apply(null, x.draws.map(function (d) { return d.outlay + d.interest; })) || 1;
      h += '<table class="tbl v2-tbl"><thead><tr><th>Month</th><th class="r">Hard</th><th class="r">Soft</th><th class="r">Land</th><th class="r">Equity</th><th class="r">Loan draw</th><th class="r">Interest</th><th class="r">Loan balance</th><th>Draw</th></tr></thead><tbody>';
      x.draws.forEach(function (d) {
        h += '<tr><td class="mono">' + esc(d.month || 'M' + d.index) + '</td><td class="r mono">' + money(d.hard) + '</td><td class="r mono">' + money(d.soft) + '</td><td class="r mono">' + money(d.land)
          + '</td><td class="r mono">' + money(d.equity) + '</td><td class="r mono">' + money(d.loan) + '</td><td class="r mono">' + money(d.interest) + '</td><td class="r mono">' + money(d.balance)
          + '</td><td class="v2-barcell"><span class="v2-bar" style="width:' + (100 * (d.outlay + d.interest) / mx).toFixed(1) + '%"></span></td></tr>';
      });
      h += '</tbody></table></div></section>';
    });
    return h;
  }

  function scenariosHTML(p, r) {
    if (!st.scen) st.scen = E.compareScenarios(p, D);
    var rows = st.scen;
    var h = '<section class="card"><div class="card-hd"><h2>Scenarios</h2><span class="eyebrow">Side by side against the base estimate</span></div><div class="card-bd">';
    p.scenarios.forEach(function (s) {
      var pre = 'sc.' + s.id + '.';
      var pa = s.patch || {};
      h += '<div class="v2-scen"><div class="grid g4">' + fld('Scenario', textInput(pre + 'name', s.name))
        + fld('Quality (all components)', select(pre + 'q', pa.__quality || '', [['', 'As base']].concat(E.QUALITY_TIERS.map(function (q) { return [q, q]; }))))
        + fld('Baseline price change %', numInput(pre + 'price', pa.__price, { pct: 1, step: 1, min: -90 }))
        + fld('Escalation per year %', numInput(pre + 'esc', pa.settings && pa.settings.escalationRate, { pct: 1, step: 0.25, min: -10 }))
        + '</div><div class="grid g4" style="margin-top:8px">'
        + fld('Soft cost % (all)', numInput(pre + 'soft', pa.settings && pa.settings.softCostPct, { pct: 1, step: 0.5 }))
        + fld('Hard contingency %', numInput(pre + 'cont', pa.settings && pa.settings.hardContingencyPct, { pct: 1, step: 0.5 }))
        + fld('Land price ($)', numInput(pre + 'land', pa.land && pa.land.value, { step: 1000 }))
        + '<div class="fld"><span class="lab">&nbsp;</span>' + btn('del-scenario', 'Remove', ' data-id="' + esc(s.id) + '"') + '</div></div></div>';
    });
    h += btn('add-scenario', '+ Add scenario', '', 'btn-ghost btn-sm');
    h += '<div class="v2-scroll" style="margin-top:16px"><table class="tbl v2-tbl"><thead><tr><th>Measure</th>' + rows.map(function (x) { return '<th class="r">' + esc(x.name) + '</th>'; }).join('') + '</tr></thead><tbody>';
    var line = function (label, f, fmt) {
      return '<tr><td>' + label + '</td>' + rows.map(function (x) { return '<td class="r mono">' + fmt(f(x)) + '</td>'; }).join('') + '</tr>'; };
    h += line('Total project cost', function (x) { return x.totals.total; }, money)
      + line('Change vs base', function (x) { return x.delta; }, function (v) { return v ? (v > 0 ? '+' : '') + money(v) : '—'; })
      + line('Hard', function (x) { return x.totals.hardAll; }, money) + line('Soft', function (x) { return x.totals.softAll; }, money)
      + line('Land', function (x) { return x.totals.land; }, money)
      + line('Per SF', function (x) { return x.metrics.perSF; }, money2)
      + line('Per primary unit', function (x) { return x.metrics.perPrimaryUnit; }, money);
    return h + '</tbody></table></div></div></section>';
  }

  function sensitivityHTML(p) {
    if (!st.sens) st.sens = E.sensitivity(p, D);
    var s = st.sens, mx = Math.max.apply(null, s.drivers.map(function (d) { return Math.max(Math.abs(d.lowDelta), Math.abs(d.highDelta)); })) || 1;
    var h = '<section class="card"><div class="card-hd"><h2>Sensitivity</h2><span class="eyebrow">Each driver moved alone; base ' + money(s.base) + '</span></div><div class="card-bd">';
    h += '<table class="tbl v2-tbl v2-tornado"><thead><tr><th>Driver</th><th class="r">Low case</th><th class="v2-tcell">Change in total cost</th><th>High case</th></tr></thead><tbody>';
    s.drivers.forEach(function (d) {
      var lw = 50 * Math.abs(d.lowDelta) / mx, hw = 50 * Math.abs(d.highDelta) / mx;
      var lneg = d.lowDelta < 0, hneg = d.highDelta < 0;
      h += '<tr><td>' + esc(d.name) + '</td><td class="r mono">' + esc(d.loLabel) + ': ' + (d.lowDelta > 0 ? '+' : '') + short(d.lowDelta) + '</td>'
        + '<td class="v2-tcell"><span class="v2-tbar ' + (lneg ? 'neg' : 'pos') + '" style="' + (lneg ? 'right:50%' : 'left:50%') + ';width:' + lw.toFixed(1) + '%"></span>'
        + '<span class="v2-tbar ' + (hneg ? 'neg' : 'pos') + '" style="' + (hneg ? 'right:50%' : 'left:50%') + ';width:' + hw.toFixed(1) + '%"></span><span class="v2-taxis"></span></td>'
        + '<td class="mono">' + esc(d.hiLabel) + ': ' + (d.highDelta > 0 ? '+' : '') + short(d.highDelta) + '</td></tr>';
    });
    return h + '</tbody></table></div></section>';
  }

  function sourcesHTML(r) {
    var used = {};
    var walk = function (src) {
      if (!src || typeof src !== 'object') return;
      (src.evidence || []).forEach(function (e) { used[e] = (used[e] || 0) + 1; });
      ['ref', 'was', 'of', 'typePct', 'weight', 'baseline', 'rate', 'ltc', 'fee'].forEach(function (k) { walk(src[k]); });
    };
    r.lines.forEach(function (l) { walk(l.source); });
    r.components.forEach(function (c) { walk(c.baselineSource); });
    var ids = Object.keys(used).sort();
    var derived = r.lines.filter(function (l) { var s = l.source || {}; return s.kind === 'derived' || (s.ref && s.ref.derived); });
    var h = '<section class="card"><div class="card-hd"><h2>Sources &amp; assumptions</h2><span class="eyebrow">' + ids.length + ' sources · '
      + derived.length + ' derived lines</span></div><div class="card-bd">';
    h += '<p class="v2-note">Every default comes from the research files shipped with the app (version <span class="mono">' + esc(D.version)
      + '</span>), escalated to ' + D.baseYear + ' with the ' + esc((D.indices.escalation && D.indices.escalation.seriesName) || 'escalation index')
      + ' and brought to a national baseline with ' + esc('regional factors') + '. “Derived estimate — verify” means no published number was found and the value was reasoned from comparables.</p>';
    r.components.forEach(function (c) {
      var t = D.types[c.typeId];
      if (!t) return;
      h += '<div class="v2-src-type"><div class="eyebrow">' + esc(c.name) + ' — ' + esc(t.name) + '</div>'
        + '<p>' + esc(t.summary || '') + '</p>'
        + '<p class="v2-note">Baseline ' + money(c.baselinePrice) + '/' + esc(unitL(c.unit)) + ' · factors: location ' + (c.factors.regional || 1).toFixed(3)
        + ', quality ' + (c.factors.quality || 1).toFixed(2) + ', size ' + (c.factors.size || 1).toFixed(3) + ', escalation ' + (c.factors.escalation || 1).toFixed(4)
        + '</p>' + (t.openQuestions && t.openQuestions.length ? '<p class="v2-note"><b>Open questions:</b> ' + esc(t.openQuestions.join(' · ')) + '</p>' : '') + '</div>';
    });
    h += '<table class="tbl v2-tbl"><thead><tr><th>Source</th><th>Value</th><th>Confidence</th><th>Quote / reference</th></tr></thead><tbody>';
    ids.forEach(function (id) {
      var e = D.evidence[id];
      if (!e) return;
      h += evidenceRow(e);
    });
    return h + '</tbody></table></div></section>';
  }
  function evidenceRow(e) {
    var raw = e.raw || {};
    var v = raw.value !== null && raw.value !== undefined ? num(raw.value) : [raw.low, raw.high].filter(function (x) { return x !== null && x !== undefined; }).map(function (x) { return num(x); }).join('–');
    var safeUrl = /^https?:\/\//.test(e.url || '') ? e.url : '#';
    return '<tr><td><a href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(e.title) + '</a><div class="v2-note">' + esc(e.publisher)
      + ' · accessed ' + esc(e.accessed || '') + ' · <span class="mono">' + esc(e.id) + '</span></div></td>'
      + '<td class="mono">' + esc(v + ' ' + e.unit) + (raw.year ? ' (' + esc(raw.year) + ', ' + esc(raw.region || '') + ')' : '')
      + (e.normalized && e.normalized.value ? '<div class="v2-note">≈ ' + money(e.normalized.value) + ' national ' + D.baseYear + '</div>' : '') + '</td>'
      + '<td>' + esc(e.confidence) + '</td><td class="v2-quote">“' + esc(e.quote) + '”' + (e.scopeNotes ? '<div class="v2-note">' + esc(e.scopeNotes) + '</div>' : '') + '</td></tr>';
  }

  /* A line's source chain, or a type's research, in a side drawer. */
  function drawerHTML() {
    var d = st.drawer, r = st.result, h = '';
    if (d.kind === 'line') {
      var l = r && r.lines.filter(function (x) { return x.key === d.key; })[0];
      if (!l) { st.drawer = null; return ''; }
      h = '<h2>' + esc(l.name) + '</h2><p class="mono v2-big">' + money(l.amount) + '</p>' + srcBadge(l.source);
      h += sourceChain(l.source);
    } else if (d.kind === 'type') {
      var t = D.types[d.type];
      if (!t) { st.drawer = null; return ''; }
      h = '<h2>' + esc(t.name) + '</h2><p>' + esc(t.summary || '') + '</p>' + sourceChain({ kind: 'research', ref: t.hardCost.perPrimaryUnit && t.hardCost.perPrimaryUnit.source });
      var ev = Object.keys(D.evidence).filter(function (k) { return k.indexOf(t.file + '#') === 0; });
      if (ev.length) h += '<h3>All evidence for this type (' + ev.length + ')</h3><table class="tbl v2-tbl"><tbody>' + ev.map(function (k) { return evidenceRow(D.evidence[k]); }).join('') + '</tbody></table>';
    }
    return '<div class="v2-scrim" data-act="close-drawer"></div><aside class="v2-drawer" role="dialog" aria-modal="true" aria-label="Source details">'
      + '<button type="button" class="btn-x v2-drawer-x" data-act="close-drawer" data-k="v2.drawerx" aria-label="Close">×</button>' + h + '</aside>';
  }
  function sourceChain(src, depth) {
    depth = depth || 0;
    if (!src || depth > 4) return '';
    var h = '<div class="v2-chain">';
    if (src.kind === 'user') h += '<p><b>Overridden by the user.</b> ' + esc(src.note || '') + '</p>' + (src.was ? '<p class="v2-note">Default was:</p>' + sourceChain(src.was, depth + 1) : '');
    else if (src.kind === 'allocation') h += '<p>Allocated by <b>' + esc(src.method) + '</b>' + (isNum(src.share) ? ' (' + pct(src.share, 1) + ' share)' : '') + ' from a shared cost.</p>' + sourceChain(src.of, depth + 1);
    else if (src.kind === 'computed') h += '<p>' + esc(src.note || 'Computed') + '.</p>' + ['rate', 'ltc', 'fee'].map(function (k) { return src[k] ? sourceChain({ kind: 'research', ref: src[k] }, depth + 1) : ''; }).join('');
    else if (src.kind === 'research-blend') h += '<p>The type’s soft-cost % of hard cost, spread across soft-cost items by their researched weights.</p>'
      + sourceChain(src.typePct, depth + 1) + sourceChain({ kind: 'research', ref: src.weight }, depth + 1);
    else if (src.kind === 'missing') h += '<p>No researched value — zero until you enter one.</p>';
    else {
      var ref = src.ref || src;
      if (src.baseline) h += sourceChain(src.baseline, depth + 1);
      if (ref && ref.file) {
        h += '<p>' + (ref.derived ? '<b>Derived estimate — verify.</b> ' : '<b>Researched.</b> ') + 'File <span class="mono">' + esc(ref.file) + '</span></p>';
        if (ref.method) h += '<p class="v2-note">' + esc(ref.method) + '</p>';
        if (ref.normalization) h += '<p class="v2-note">Normalized from ' + esc(ref.normalization.dollarYear) + ' dollars (' + esc(ref.normalization.region)
          + '): escalation ×' + esc(ref.normalization.escalation) + ', regional ÷' + esc(ref.normalization.regional) + '.</p>';
        var ev = (ref.evidence || []).map(function (k) { return D.evidence[k]; }).filter(Boolean);
        if (ev.length) h += '<table class="tbl v2-tbl"><tbody>' + ev.map(evidenceRow).join('') + '</tbody></table>';
      }
      if (isNum(src.pct)) h += '<p class="v2-note">Share of the baseline: ' + pct(src.pct, 2) + '</p>';
    }
    return h + '</div>';
  }

  /* ------------------------------------------------------------ exports */
  function fsdoc() {
    var doc = A.getDoc(), r = result();
    return { fsdoc: '1', meta: {
      title: doc.name || doc.projectId || 'Estimate',
      eyebrow: 'FINISHES SOLUTIONS · PROJECT ESTIMATE',
      subline: (doc.projectId || '') + (doc.address ? ' · ' + doc.address : ''),
      rightLines: [new Date().toLocaleDateString('en-US'), 'Research data ' + D.version, doc.type || ''].filter(Boolean),
      bandLine: (doc.name || 'Estimate') + ' · Total ' + money(r.totals.total),
      footnote: 'Budgeting engine ' + r.engineVersion + ' · research ' + D.version + ' · derived estimates are marked — verify before relying on them.',
      footerRight: doc.projectId || '',
      generatedAt: new Date().toISOString()
    }, sheets: E.toFsdocSheets(r, doc.engine, D) };
  }
  function baseName() { var d = A.getDoc(); return ((d.projectId || 'estimate') + ' ' + (d.name || '')).trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') + '_estimate'; }
  async function exportXlsx() {
    if (typeof ExcelJS === 'undefined' || typeof fsRender === 'undefined') { A.toast('Excel library is unavailable — reload the page.'); return; }
    try {
      var wb = fsRender.buildWorkbook(ExcelJS, fsdoc(), fsRender.themes['finishes-solutions']);
      var buf = await wb.xlsx.writeBuffer();
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), baseName() + '.xlsx');
      A.toast('Estimate workbook exported');
      if (A.activity) A.activity('export_xlsx', 'budget', A.getDoc().projectId);
    } catch (e) { A.toast('Export failed — ' + e.message); }
  }
  function exportPdf() {
    if (typeof pdfMake === 'undefined' || typeof fsRender === 'undefined') { A.toast('PDF library is unavailable — reload the page.'); return; }
    try {
      var dd = fsRender.buildPdfDocDefinition(fsdoc(), fsRender.themes['finishes-solutions'], 'landscape');
      pdfMake.createPdf(dd).getBlob(function (b) { download(b, baseName() + '.pdf'); A.toast('Estimate report exported'); });
      if (A.activity) A.activity('export_pdf', 'budget', A.getDoc().projectId);
    } catch (e) { A.toast('Export failed — ' + e.message); }
  }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ------------------------------------------------------------ actions */
  function act(name, el) {
    var p = P(), doc = A.getDoc();
    var id = el.getAttribute('data-id');
    switch (name) {
      case 'mode':
        p.mode = el.getAttribute('data-mode');
        if (p.mode === 'quick' && p.components.length > 1) A.toast('Quick estimate shows the first component; the others are kept.');
        return changed();
      case 'open-picker':
        st.picker = { purpose: el.getAttribute('data-purpose'), id: id };
        st.q = '';
        A.pendingFocus('v2.pickq');
        return paint();
      case 'close-picker': st.picker = null; return paint();
      case 'pick-type': return pickType(el.getAttribute('data-type'));
      case 'del-comp':
        p.components = p.components.filter(function (c) { return c.id !== id; });
        return changed();
      case 'add-phase': {
        var n = p.phases.length + 1;
        p.phases.push(E.newPhase({ id: newId('p'), name: 'Phase ' + n }));
        return changed();
      }
      case 'del-phase': {
        if (p.phases.length < 2) return;
        p.phases = p.phases.filter(function (x) { return x.id !== id; });
        p.components.forEach(function (c) { if (c.phaseId === id) c.phaseId = p.phases[0].id; });
        p.shared.forEach(function (s) { if (s.phaseId === id) s.phaseId = p.phases[0].id; });
        return changed();
      }
      case 'add-shared':
        p.shared.push({ id: newId('s'), name: 'Shared element ' + (p.shared.length + 1), itemId: '', qty: 1, unitCost: null,
          phaseId: p.phases[0].id, allocation: { method: 'sf', shares: {} } });
        return changed();
      case 'del-shared': p.shared = p.shared.filter(function (s) { return s.id !== id; }); return changed();
      case 'add-custom': {
        var c = E.newComponent(D, 'custom', { id: newId('c'), name: 'Custom component', size: 1, phaseId: p.phases[0].id });
        p.components.push(c);
        return changed();
      }
      case 'add-block': {
        var comp = p.components.filter(function (x) { return x.id === el.getAttribute('data-comp'); })[0];
        if (!comp) return;
        var item = el.getAttribute('data-item');
        var DEF_QTY = { sf: 1000, sy: 500, lf: 100, cy: 100, acre: 1, kw: 100, kwh: 500 };
        var bu = item && D.blocks[item] ? D.blocks[item].unit : 'ea';
        comp.blocks.push(item ? { id: newId('b'), itemId: item, qty: DEF_QTY[bu] || 1, unitCost: null }
          : { id: newId('b'), itemId: '', name: 'Priced item', qty: 1, unitCost: 0, unit: 'ls' });
        return changed();
      }
      case 'del-block': {
        var cc = p.components.filter(function (x) { return x.id === el.getAttribute('data-comp'); })[0];
        if (cc) cc.blocks = cc.blocks.filter(function (b) { return b.id !== id; });
        return changed();
      }
      case 'toggle': {
        var key = el.getAttribute('data-key');
        var cur = st.open[key];
        var dflt = /^c:/.test(key) && key.split('|').length <= 2 ? true : false;
        st.open[key] = !(cur === undefined ? dflt : cur);
        return paint();
      }
      case 'expand-all':
      case 'collapse-all': {
        var r = result(), on = name === 'expand-all';
        st.open = {};
        if (r) r.lines.forEach(function (l) {
          var ck = 'c:' + (l.comp || '_project');
          var gname = l.category === 'hard' && l.division ? 'Division ' + l.division + ' — ' + E._.csiTitle(l.division) : l.group;
          st.open[ck] = true; st.open[ck + '|' + l.phase] = true; st.open[ck + '|' + l.phase + '|' + gname] = on;
        });
        return paint();
      }
      case 'reset-ov': delete p.overrides[el.getAttribute('data-key')]; return changed();
      case 'source': st.drawer = { kind: 'line', key: el.getAttribute('data-key'), back: el.getAttribute('data-k') }; A.pendingFocus('v2.drawerx'); return paint();
      case 'source-type': st.drawer = { kind: 'type', type: el.getAttribute('data-type') }; A.pendingFocus('v2.drawerx'); return paint();
      case 'close-drawer': if (st.drawer && st.drawer.back) A.pendingFocus(st.drawer.back); st.drawer = null; return paint();
      case 'view': st.view = el.getAttribute('data-view'); return paint();
      case 'goto-detail': return A.go('budget');
      case 'goto-inputs': return A.go('input');
      case 'export-xlsx': return exportXlsx();
      case 'export-pdf': return exportPdf();
      case 'proforma': return proforma();
      case 'add-scenario':
        p.scenarios.push({ id: newId('sc'), name: 'Scenario ' + (p.scenarios.length + 1), patch: {} });
        return changed();
      case 'del-scenario': p.scenarios = p.scenarios.filter(function (s) { return s.id !== id; }); return changed();
      case 'update-research': return changed();
      case 'save-file': return saveFile();
      case 'open-file': return openFile();
    }
  }

  function pickType(typeId) {
    var p = P(), t = D.types[typeId];
    if (!t) return;
    var pk = st.picker || { purpose: 'quick' };
    st.picker = null;
    if (pk.purpose === 'retype' && pk.id) {
      var c = p.components.filter(function (x) { return x.id === pk.id; })[0];
      if (c) {
        // Everything measured in the old type's units goes back to defaults;
        // only the name (in mixed mode), phase, quality and blocks carry over.
        var fresh = E.newComponent(D, typeId, { id: c.id, phaseId: c.phaseId, quality: c.quality, blocks: c.blocks,
          name: p.mode === 'quick' ? t.name : c.name });
        Object.keys(c).forEach(function (k) { delete c[k]; });
        Object.assign(c, fresh);
      }
    } else if (pk.purpose === 'add' || p.mode === 'mixed') {
      var phaseId = p.phases[p.phases.length - 1].id;
      p.components.push(E.newComponent(D, typeId, { id: newId('c'), phaseId: phaseId }));
      if (p.mode === 'quick' && p.components.length > 1) p.mode = 'mixed';
    } else {
      p.components = [E.newComponent(D, typeId, { id: newId('c'), phaseId: p.phases[0].id })];
    }
    A.pendingFocus('v2.c.' + p.components[p.components.length - 1].id + '.size');
    changed();
  }

  async function proforma() {
    var doc = A.getDoc();
    var sc = st.scope === 'project' ? { kind: 'project', id: 'project' }
      : { kind: st.scope.split(':')[0], id: st.scope.split(':')[1] };
    if (A.isDirty()) {
      var ok = await A.save();
      if (!ok) { A.toast('Save the budget first — the pro forma is built from a saved version.'); return; }
    }
    try {
      await A.createAnalysis(doc.projectId, sc);
    } catch (e) { A.toast('Could not create the pro forma — ' + e.message); }
  }

  /* A project file is doc.engine on its own — the estimate inputs, portable
     between budgets or kept offline. Opening one replaces this budget's
     estimate inputs (after a confirm) and goes through migrate() like any
     saved document, so a hostile file cannot smuggle unsafe ids. */
  function saveFile() {
    var doc = A.getDoc();
    var body = JSON.stringify({ kind: 'fs-budgeting-estimate', version: 1, savedAt: new Date().toISOString(),
      name: doc.name || '', engine: doc.engine }, null, 2);
    download(new Blob([body], { type: 'application/json' }), baseName().replace(/_estimate$/, '') + '.estimate.json');
  }
  function openFile() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 5e6) { A.toast('That file is too large to be a project file.'); return; }
      var rd = new FileReader();
      rd.onload = function () {
        var j = null;
        try { j = JSON.parse(rd.result); } catch (e) { j = null; }
        if (!j || j.kind !== 'fs-budgeting-estimate' || !j.engine || typeof j.engine !== 'object') {
          A.toast('Not a Budgeting Suite estimate file.'); return;
        }
        if (!window.confirm('Replace this budget’s estimate inputs with “' + String(j.name || f.name).slice(0, 80) + '”?')) return;
        var doc = A.getDoc();
        doc.engine = j.engine;
        migrate(doc);
        st.result = null;
        changed();
        A.toast('Project file opened — Save to keep it.');
      };
      rd.readAsText(f);
    };
    inp.click();
  }

  /* Scenario controls are friendlier than raw patches: a few named fields
     write the patch the engine merges. */
  function scenarioSet(id, field, v) {
    var s = P().scenarios.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    var pa = s.patch = s.patch || {};
    pa.settings = pa.settings || {};
    if (field === 'name') s.name = v || s.name;
    if (field === 'q') { pa.__quality = v || undefined; }
    if (field === 'price') pa.__price = v;
    if (field === 'esc') pa.settings.escalationRate = v;
    if (field === 'soft') pa.settings.softCostPct = v;
    if (field === 'cont') pa.settings.hardContingencyPct = v;
    if (field === 'land') { pa.land = pa.land || {}; if (v === null) delete pa.land.value; else pa.land.value = v; }
    // Quality and price apply to every component.
    var base = P();
    pa.components = base.components.map(function (c) {
      var x = { id: c.id };
      if (pa.__quality) x.quality = pa.__quality;
      if (isNum(pa.__price) && pa.__price !== 0) {
        var r = result(), rc = r && r.components.filter(function (y) { return y.id === c.id; })[0];
        x.baseline = { price: (rc ? rc.baselinePrice : 0) * (1 + pa.__price), basis: (c.baseline && c.baseline.basis) || 'national' };
      }
      return x;
    });
    changed();
  }

  /* ------------------------------------------------------------ events */
  function onInput(ev) {
    var el = ev.target;
    if (painting) { var t = ev.type; setTimeout(function () { onInput({ type: t, target: el, detached: true }); }, 0); return; }
    if (!el || !el.closest || (!ev.detached && !el.closest('[data-v2]'))) return;
    var ui = el.getAttribute('data-ui');
    if (ui === 'q') { st.q = el.value; return paint(); }
    if (ui === 'blockQ') { st.blockQ = el.value; return paint(); }
    if (ui === 'scope') { st.scope = el.value; return paint(); }
    var ov = el.getAttribute('data-ov');
    if (ov !== null) {
      if (ev.type !== 'change') return;          // overrides commit on change, not per keystroke
      var r = result(), l = r && r.lines.filter(function (x) { return x.key === ov; })[0];
      var v = el.value === '' ? null : +el.value;
      if (v === null || !isFinite(v)) delete P().overrides[ov];
      else if (l && Math.abs(v - l.baseAmount) < 0.005) delete P().overrides[ov];
      else P().overrides[ov] = { amount: Math.round(v * 100) / 100 };
      return changed();
    }
    var f = el.getAttribute('data-f');
    if (!f) return;
    var isText = el.getAttribute('data-t') === 'text' && el.tagName === 'INPUT';
    if (isText && ev.type === 'input') { setPath(f, parse(el)); A.markDirty(); return; }   // names: no recompute per keystroke
    if (isText && ev.type === 'change') { setPath(f, parse(el)); return changed(); }        // …but names reach lines, groups and scopes
    // The project's Construction start is phase 1's start unless phase 1 has
    // its own (set in Mixed-use & phases).
    if (f === 'p.startMonth' && P().phases[0] && P().mode !== 'mixed') P().phases[0].startMonth = null;
    if (el.type === 'number' && ev.type === 'input') { /* recompute live while typing numbers */ }
    var m = /^sc\.([A-Za-z0-9_-]+)\.(name|q|price|esc|soft|cont|land)$/.exec(f);
    if (m) { if (ev.type === 'change' || m[2] !== 'name') scenarioSet(m[1], m[2], parse(el)); return; }
    if (getPath(f) === parse(el)) return;
    setPath(f, parse(el));
    changed();
  }
  function onClick(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el || !el.closest('[data-v2]')) return;
    ev.preventDefault();
    act(el.getAttribute('data-act'), el);
  }
  function onKey(ev) {
    if (ev.key === 'Escape' && (st.picker || st.drawer)) {
      if (!document.querySelector('.page.on [data-v2]')) return;
      if (st.drawer && st.drawer.back) A.pendingFocus(st.drawer.back);
      st.picker = null; st.drawer = null; paint();
    }
  }

  /* ------------------------------------------------------------ paint */
  /* Replacing innerHTML blurs the focused field, and a blur can fire 'change'
     — which would re-enter paint() halfway through its own render. Events that
     arrive while painting are replayed right after it instead. */
  var painting = false, pendingPaint = false;
  function paint() {
    var doc = A ? A.getDoc() : null;
    if (!isEngine(doc)) return;
    if (E && (!D || !D.types)) {
      ['v2Inputs', 'v2Detail'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && !el.querySelector('.v2-loading')) el.innerHTML = '<section class="card"><div class="card-bd v2-emptystate v2-loading" role="status">'
          + '<h2>Loading research data…</h2><p>The cost data for estimates loads the first time you open one.</p></div></section>';
      });
      ready().then(function (okd) { if (okd) paint(); else { loading = null; showLoadError(); } });
      return;
    }
    if (!E) { showLoadError(); return; }
    paintNow();
  }
  function showLoadError() {
    ['v2Inputs', 'v2Detail'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.innerHTML = '<section class="card"><div class="card-bd v2-emptystate" role="alert"><h2>The estimate data did not load</h2>'
        + '<p>The research data or the estimate engine is missing from this page. Reload; if it keeps happening, report a bug — your saved budget is unaffected.</p></div></section>';
    });
  }
  function paintNow() {
    if (painting) { pendingPaint = true; return; }
    painting = true;
    var page = A.currentPage();
    try {
      A.withFocus(function () {
        if (page === 'input') renderInputs(document.getElementById('v2Inputs'));
        if (page === 'budget') renderDetail(document.getElementById('v2Detail'));
      });
    } finally { painting = false; }
    if (pendingPaint) { pendingPaint = false; setTimeout(paint, 0); }
  }

  function init(adapter) {
    A = adapter;
    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
  }

  window.FSBudgetV2 = {
    init: init, ready: ready, isEngine: isEngine, startNew: startNew, migrate: migrate, materialize: materialize, paint: paint, sized: sized,
    result: result, reset: function () { st.result = null; st.resultFor = null; st.picker = null; st.drawer = null; st.view = 'detail'; st.scope = 'project'; st.sens = null; st.scen = null; },
    setImpactFees: function (doc, amount) {
      if (!isEngine(doc) || !D) return;
      var v = amount === null || amount === undefined ? null : Math.round(amount * 100) / 100;
      if (doc.engine.settings.impactFeesOverride !== v) { doc.engine.settings.impactFeesOverride = v; materialize(doc); }
    },
    _st: st
  };
})();
