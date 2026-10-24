/* Budget Engine v2 — project → detailed, research-backed total project budget.

   One file, two runtimes: the browser loads it as a plain script (it hangs off
   window.FSBudgetEngine) and Node requires it as CommonJS. It is PURE: no DOM,
   no network, no clock — the research bundle (app/research-data.js) is passed
   in, and the same project always produces the same result.

   Design: docs/BUDGET_ENGINE.md. The rules that matter most:

   - No default lives here. Every researched number is read from the bundle,
     and every line carries `source` naming the research file and evidence it
     came from (or `derived` with its method, or `user` when overridden). The
     only constants in this file are structural — how a draw curve is shaped,
     which month money moves in — and they are named and documented below.
   - Money is integer CENTS internally. Every total is a sum of rounded lines,
     and every allocation is a largest-remainder split, so component, phase
     and project totals add up exactly.
   - The pro forma engine (api/shared/investment/) is never called or copied
     here; the engine only prepares what it receives (result.proforma). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSBudgetEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ENGINE_VERSION = 'budget-engine-2.0.0';
  var SQFT_PER_ACRE = 43560;
  var QUALITY_TIERS = ['economy', 'standard', 'premium', 'luxury'];
  var ALLOCATION_METHODS = ['sf', 'units', 'revenue', 'cost', 'equal', 'manual'];
  var DRAW_CURVES = ['s', 'linear', 'front', 'back'];

  /* Structural timing assumptions — when money moves, not how much. Soft-cost
     items listed in UPFRONT are paid at the phase's financial close (month 0);
     A&E is paid 70% before construction and the rest across it; everything
     else soft is spread evenly across construction. Land closes at month 0. */
  var UPFRONT_SOFT = { permitsPlanReview: 1, impactFees: 1, tapFees: 1, legalAccounting: 0.5, titleClosingRecording: 1,
    thirdPartyReports: 1, buildersRiskInsurance: 1, generalLiabilityInsurance: 1, civilSurveyGeotech: 0.8,
    architectureEngineering: 0.7 };

  /* ------------------------------------------------------------ helpers */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function nz(v) { return isNum(+v) && v !== null && v !== '' ? +v : 0; }
  function num(v, d) { return v === null || v === undefined || v === '' || !isNum(+v) ? d : +v; }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function cents(x) { return Math.round(nz(x) * 100); }
  function dollars(c) { return c / 100; }
  function r4(x) { return Math.round(x * 10000) / 10000; }
  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function sum(arr, f) { var s = 0; for (var i = 0; i < arr.length; i++) s += f ? f(arr[i]) : arr[i]; return s; }

  function parseMonth(m) {
    var x = /^(\d{4})-(\d{2})$/.exec(String(m || ''));
    return x ? { y: +x[1], m: +x[2] } : null;
  }
  function monthIndex(m) { var p = parseMonth(m); return p ? p.y * 12 + (p.m - 1) : null; }
  function monthOf(i) { var y = Math.floor(i / 12), m = i - y * 12 + 1; return y + '-' + (m < 10 ? '0' : '') + m; }
  function addMonths(m, n) { var i = monthIndex(m); return i === null ? null : monthOf(i + Math.round(n)); }

  /* Split totalCents across weights so the parts are integers that sum EXACTLY
     to the total (largest remainder; ties go to the earlier entry). All-zero
     or invalid weights split equally. */
  function allocateCents(totalCents, weights) {
    var n = weights.length;
    if (!n) return [];
    var w = weights.map(function (x) { return isNum(x) && x > 0 ? x : 0; });
    var W = sum(w);
    if (!(W > 0)) { w = weights.map(function () { return 1; }); W = n; }
    var sign = totalCents < 0 ? -1 : 1, T = Math.abs(totalCents);
    var raw = w.map(function (x) { return T * x / W; });
    var out = raw.map(Math.floor);
    var rem = T - sum(out);
    var order = raw.map(function (x, i) { return { i: i, f: x - Math.floor(x) }; })
      .sort(function (a, b) { return b.f - a.f || a.i - b.i; });
    for (var k = 0; k < rem; k++) out[order[k % n].i] += 1;
    return out.map(function (x) { return sign * x; });
  }

  /* ------------------------------------------------------------ research access */
  function typeOf(D, id) { return (D && D.types && D.types[id]) || null; }
  function common(D, file, id) {
    var f = D && D.common && D.common[file];
    return f && f.items && f.items[id] ? f.items[id] : null;
  }
  function commonMid(D, file, id) {
    var it = common(D, file, id);
    return it && it.range && isNum(it.range.mid) ? it.range.mid : null;
  }
  function srcOf(range) { return range && range.source ? range.source : null; }
  function unitLabel(D, id, plural) {
    var u = (D && D.units || []).filter(function (x) { return x.id === id; })[0];
    return u ? (plural ? u.plural : u.label) : id;
  }

  function regionInfo(D, key) {
    var reg = D && D.indices && D.indices.regional;
    var f = reg && reg.factors ? reg.factors : { US: 1 };
    var k = key || 'US';
    if (f[k] === undefined) {
      var st = /^([A-Z]{2})(-|$)/.exec(k);
      if (st && f[st[1]] !== undefined) return { key: st[1], factor: +f[st[1]], requested: k, fellBack: true,
        label: (reg.labels && reg.labels[st[1]]) || st[1] };
      return { key: 'US', factor: 1, requested: k, fellBack: k !== 'US', label: 'National average' };
    }
    return { key: k, factor: +f[k] || 1, label: (reg && reg.labels && reg.labels[k]) || k };
  }

  /* Escalation from the base year's mid-point (July) to a construction
     midpoint, compounding the forecast annual rate of each calendar year the
     span crosses (the last forecast rate carries forward). A midpoint before
     the base mid-point de-escalates through the historical series. A user
     rate replaces the forecast. */
  function escalation(D, midMonth, userRate) {
    var base = (D && D.baseYear || 2026) * 12 + 6;
    var mid = monthIndex(midMonth);
    if (mid === null) return { factor: 1, years: 0, method: 'no midpoint' };
    var years = (mid - base) / 12;
    if (isNum(userRate)) return { factor: Math.pow(1 + userRate, years), years: years, method: 'user rate ' + userRate };
    var esc = D && D.indices && D.indices.escalation;
    if (!esc) return { factor: 1, years: years, method: 'no escalation index in the research bundle' };
    if (mid <= base) {
      var s = esc.series || {}, by = D.baseYear, y = Math.floor(mid / 12);
      var a = +s[String(y)], b = +s[String(by)];
      return { factor: a && b ? a / b : 1, years: years, method: 'historical series ' + y + '→' + by };
    }
    var fc = esc.forecast || {}, keys = Object.keys(fc).map(Number).sort(function (p, q) { return p - q; });
    if (!keys.length) return { factor: 1, years: years, method: 'no forecast in the escalation index' };
    var factor = 1, cur = base;
    while (cur < mid) {
      var yr = Math.floor(cur / 12), next = Math.min(mid, (yr + 1) * 12);
      var rate = fc[String(yr)];
      if (rate === undefined) rate = yr < keys[0] ? fc[String(keys[0])] : fc[String(keys[keys.length - 1])];
      factor *= Math.pow(1 + (+rate), (next - cur) / 12);
      cur = next;
    }
    return { factor: factor, years: years, method: 'forecast rates from ' + (esc.file || 'escalation index') };
  }

  function qualityFactor(D, type, tier) {
    tier = QUALITY_TIERS.indexOf(tier) >= 0 ? tier : 'standard';
    if (type && type.qualityTiers && isNum(type.qualityTiers[tier]))
      return { factor: type.qualityTiers[tier], source: type.qualityTiers.source };
    var it = common(D, 'adjustments', 'qualityTier-' + tier);
    if (it && it.range && isNum(it.range.mid)) return { factor: it.range.mid, source: it.range.source };
    return { factor: 1, source: null, missing: tier !== 'standard' };
  }

  /* Economies of scale on the size-variable part of the price:
     factor = (size / typical)^e with the exponent e from _common/adjustments.json
     (sizeAdjustment-exponent, negative: bigger is cheaper per unit). The
     factor is held to SIZE_FACTOR_BOUNDS so a 50× extrapolation of a curve fit
     on ordinary projects cannot run away; absent research → no adjustment. */
  var SIZE_FACTOR_BOUNDS = [0.85, 1.2];
  function sizeFactor(D, type, size) {
    var it = common(D, 'adjustments', 'sizeAdjustment-exponent');
    var typical = type && type.sizing && type.sizing.typicalSize && type.sizing.typicalSize.mid;
    if (!it || !it.range || !isNum(it.range.mid) || !(typical > 0) || !(size > 0)) return { factor: 1, source: null };
    var e = it.range.mid;
    return { factor: clamp(Math.pow(size / typical, e), SIZE_FACTOR_BOUNDS[0], SIZE_FACTOR_BOUNDS[1]), source: it.range.source, exponent: e };
  }

  function relFactor(D, prefix, chosen, dflt) {
    if (!chosen || chosen === dflt) return { factor: 1, source: null };
    var a = common(D, 'adjustments', prefix + chosen), b = dflt ? common(D, 'adjustments', prefix + dflt) : null;
    var fa = a && a.range && isNum(a.range.mid) ? a.range.mid : null;
    var fb = b && b.range && isNum(b.range.mid) ? b.range.mid : (dflt ? null : 1);
    if (fa === null || fb === null || !(fb > 0)) return { factor: 1, source: null, missing: true };
    return { factor: fa / fb, source: a.range.source };
  }

  /* ------------------------------------------------------------ defaults */
  var _seq = 0;
  function newId(prefix) { _seq += 1; return prefix + _seq.toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  function newPhase(opts) {
    opts = opts || {};
    return { id: opts.id || newId('p'), name: opts.name || 'Phase 1', startMonth: opts.startMonth || null,
      months: num(opts.months, null), drawCurve: opts.drawCurve || 's', carryMonths: num(opts.carryMonths, null),
      financing: Object.assign({ enabled: true, ltc: null, rate: null, feePct: null }, opts.financing || {}) };
  }

  function newComponent(D, typeId, opts) {
    opts = opts || {};
    var t = typeOf(D, typeId);
    var typical = t && t.sizing && t.sizing.typicalSize ? t.sizing.typicalSize.mid : 0;
    return {
      id: opts.id || newId('c'), typeId: typeId, name: opts.name || (t ? t.name : typeId),
      phaseId: opts.phaseId || null,
      size: num(opts.size, typical || 0), sf: num(opts.sf, null), acres: num(opts.acres, null),
      quality: opts.quality || 'standard',
      baseline: Object.assign({ price: null, basis: 'national' }, opts.baseline || {}),
      constructionType: opts.constructionType || null, stories: num(opts.stories, null),
      includeFFE: opts.includeFFE !== false, parking: opts.parking || null,
      items: opts.items || {}, blocks: opts.blocks || [],
      softCostPct: num(opts.softCostPct, null), contingency: opts.contingency || {},
      revenue: opts.revenue || null
    };
  }

  function newProject(D, opts) {
    opts = opts || {};
    var phase = newPhase({ id: 'p1', name: 'Phase 1', startMonth: opts.startMonth || null });
    var p = {
      schema: 1, engineVersion: ENGINE_VERSION, dataVersion: D ? D.version : null,
      mode: opts.mode || 'quick',
      location: { region: opts.region || 'US' },
      startMonth: opts.startMonth || null,
      settings: { escalationRate: null, designContingencyPct: null, hardContingencyPct: null, softContingencyPct: null,
        developerFeePct: null, softCostPct: null, impactFeesOverride: null },
      land: { mode: 'amount', value: 0, acres: null, closingPct: null, dueDiligence: null },
      phases: [phase], components: [], shared: [], overrides: {}, scenarios: []
    };
    if (opts.typeId) p.components.push(newComponent(D, opts.typeId, { id: 'c1', phaseId: 'p1', size: opts.size,
      baseline: opts.baseline }));
    return p;
  }

  /* ------------------------------------------------------------ component geometry */
  function primaryUnitIsArea(u) { return u === 'sf' || u === 'nrsf'; }

  function geometry(D, comp, t) {
    var size = Math.max(0, nz(comp.size));
    var unit = t ? t.primaryUnit : 'ls';
    var spu = t && t.sizing && t.sizing.sfPerPrimaryUnit ? t.sizing.sfPerPrimaryUnit.mid : null;
    var sf;
    if (isNum(comp.sf) && comp.sf !== null) sf = Math.max(0, comp.sf);
    else if (unit === 'sf') sf = size;
    else if (spu > 0) sf = size * spu;
    else if (unit === 'nrsf') sf = size;
    else sf = 0;
    var upa = t && t.sizing && t.sizing.primaryUnitsPerAcre ? t.sizing.primaryUnitsPerAcre.mid : null;
    var acres;
    if (isNum(comp.acres) && comp.acres !== null) acres = Math.max(0, comp.acres);
    else if (unit === 'acre') acres = size;
    else if (upa > 0) acres = size / upa;
    else acres = 0;
    var ppu = t && t.sizing && t.sizing.parkingPerPrimaryUnit ? t.sizing.parkingPerPrimaryUnit : null;
    var spaces = comp.parking && isNum(comp.parking.spaces) ? comp.parking.spaces : (ppu && isNum(ppu.mid) ? ppu.mid * size : 0);
    return { size: size, unit: unit, sf: sf, acres: acres, spaces: spaces, parkingType: ppu ? ppu.type || null : null };
  }

  function driverQty(D, per, value, geo, t) {
    var v = nz(value);
    if (per === 'project') return v;
    if (per === 'primaryUnit' || (t && per === t.primaryUnit)) return v * geo.size;
    if (per === 'sf' || per === 'nrsf') return v * geo.sf;
    if (per === 'acre') return v * geo.acres;
    if (per === 'space') return v * geo.spaces;
    return v;
  }

  /* ------------------------------------------------------------ line builder */
  function Lines(project) {
    this.list = [];
    this.overrides = (project && project.overrides) || {};
    this.used = {};
  }
  /* Add one line. qty × rate (dollars) unless amountCents is given. An
     override replaces amount, rate or qty, or switches the line off. */
  Lines.prototype.add = function (L) {
    var o = this.overrides[L.key];
    var baseCents = isNum(L.amountCents) ? Math.round(L.amountCents) : cents(nz(L.qty) * nz(L.rate));
    var qty = L.qty, rate = L.rate, amt = baseCents, overridden = false, source = L.source || null;
    if (o) {
      this.used[L.key] = true;
      if (o.off) { amt = 0; overridden = true; }
      else if (isNum(o.amount)) { amt = cents(o.amount); overridden = true; }
      else {
        if (isNum(o.qty)) { qty = o.qty; overridden = true; }
        if (isNum(o.rate)) { rate = o.rate; overridden = true; }
        if (overridden) amt = cents(nz(qty) * nz(rate));
      }
      if (overridden) source = { kind: 'user', note: o.note || 'Overridden', was: source };
    }
    var line = { key: L.key, comp: L.comp || null, phase: L.phase || null, category: L.category,
      group: L.group || '', division: L.division || null, code: L.code || '', name: L.name,
      qty: isNum(qty) ? qty : null, uom: L.uom || '', rate: isNum(rate) ? rate : null,
      cents: amt, baseCents: baseCents, overridden: overridden, carveOut: !!L.carveOut,
      timing: L.timing || null, source: source };
    this.list.push(line);
    return line;
  };

  function divisionName(D, div) {
    var names = D && D.divisions;
    return names && names[div] ? names[div] : 'Division ' + div;
  }

  var CSI_TITLES = { '01': 'General Requirements', '02': 'Existing Conditions', '03': 'Concrete', '04': 'Masonry',
    '05': 'Metals', '06': 'Wood, Plastics & Composites', '07': 'Thermal & Moisture Protection', '08': 'Openings',
    '09': 'Finishes', '10': 'Specialties', '11': 'Equipment', '12': 'Furnishings', '13': 'Special Construction',
    '14': 'Conveying Equipment', '21': 'Fire Suppression', '22': 'Plumbing', '23': 'HVAC',
    '25': 'Integrated Automation', '26': 'Electrical', '27': 'Communications', '28': 'Electronic Safety & Security',
    '31': 'Earthwork', '32': 'Exterior Improvements', '33': 'Utilities', '34': 'Transportation',
    '35': 'Waterway & Marine Construction', '40': 'Process Interconnections', '41': 'Material Processing & Handling',
    '42': 'Process Heating, Cooling & Drying', '43': 'Process Gas & Liquid Handling', '44': 'Pollution & Waste Control',
    '45': 'Industry-Specific Manufacturing Equipment', '46': 'Water & Wastewater Equipment', '48': 'Electrical Power Generation' };
  function csiTitle(div) { return CSI_TITLES[div] || ('Division ' + div); }

  /* ------------------------------------------------------------ the component's hard cost */
  function componentHard(D, project, comp, phase, ctx, lines, warnings) {
    var t = typeOf(D, comp.typeId);
    var geo = geometry(D, comp, t);
    var R = ctx.region, E = ctx.esc[phase.id];
    var info = { geo: geo, factors: {}, baselineSource: null };
    if (!t) {
      warnings.push({ level: 'error', code: 'unknown-type', comp: comp.id,
        message: comp.name + ': project type "' + comp.typeId + '" is not in the research data.' });
      return info;
    }
    var key = function (s) { return comp.id + ':' + s; };
    var isCustom = t.id === 'custom';
    var userPrice = comp.baseline && isNum(comp.baseline.price) && comp.baseline.price !== null && comp.baseline.price > 0;
    var local = userPrice && comp.baseline.basis === 'local';
    var Rf = local ? 1 : R.factor;
    var Ef = E.factor;
    var Q = qualityFactor(D, t, comp.quality);
    var S = sizeFactor(D, t, geo.size);
    var C = relFactor(D, 'constructionType-', comp.constructionType, t.template && t.template.constructionType);
    var H = { factor: 1 };
    if (isNum(comp.stories) && comp.stories && t.template && isNum(t.template.stories)) {
      var per = commonMid(D, 'adjustments', 'storiesAdjustment-perStory');
      if (per !== null) H = { factor: Math.max(0.5, 1 + per * (comp.stories - t.template.stories)),
        source: srcOf(common(D, 'adjustments', 'storiesAdjustment-perStory').range) };
    }
    if (Q.missing) warnings.push({ level: 'warn', code: 'quality-default', comp: comp.id,
      message: comp.name + ': no researched multiplier for "' + comp.quality + '" quality — priced at standard.' });
    info.factors = { regional: Rf, escalation: Ef, quality: Q.factor, size: S.factor, constructionType: C.factor,
      stories: H.factor, regionKey: local ? 'local price' : R.key };

    var hc = t.hardCost && t.hardCost.perPrimaryUnit;
    var P0 = userPrice ? comp.baseline.price : (hc ? hc.mid : 0);
    info.baselinePrice = P0;
    info.baselineSource = userPrice ? { kind: 'user', note: 'Baseline price entered by the user (' + (local ? 'local' : 'national') + ' basis)' }
      : { kind: 'research', ref: srcOf(hc) };
    var factorAll = Rf * Q.factor * C.factor * H.factor * Ef;

    if (!isCustom && geo.size > 0 && P0 > 0) {
      /* Fixed (non-scaling) in-baseline items are sized for the TYPICAL project,
         so they come out of the per-unit price at typical size and come back as
         fixed amounts: cost(size) = v × size × S + F. That is what makes a
         10-pad and a 40-pad food truck park price differently per pad. */
      var typical = t.sizing && t.sizing.typicalSize ? t.sizing.typicalSize.mid : geo.size;
      var tgeo = geometry(D, { size: typical }, t);
      var fixedAtTypical = 0;
      (t.lineItems || []).forEach(function (li) {
        if (li.inBaseline && !li.scales && li.cost) fixedAtTypical += li.cost.mid * driverQty(D, li.qty.per, li.qty.value, tgeo, t);
      });
      var v = typical > 0 ? P0 - fixedAtTypical / typical : P0;
      // A template whose fixed items exceed the price at typical size is
      // internally inconsistent; keep at least 20% of the price variable.
      if (v < 0.2 * P0) {
        warnings.push({ level: 'info', code: 'fixed-share-capped', comp: comp.id,
          message: comp.name + ': fixed items exceed 80% of the baseline at typical size — treated as 80%.' });
        fixedAtTypical = 0.8 * P0 * typical; v = 0.2 * P0;
      }
      var fixedScale = typical > 0 ? fixedAtTypical / (P0 * typical) : 0;
      var baseHardDollars = (v * geo.size * S.factor + (fixedAtTypical > 0 ? fixedAtTypical : 0)) * factorAll;
      info.baselineHard = baseHardDollars;
      info.fixedShare = fixedScale;
      info.unitPrice = geo.size > 0 ? baseHardDollars / geo.size : 0;

      // Carve-outs: in-baseline items, at their own quantities, inside their division.
      var carves = {};
      var carveLines = [];
      (t.lineItems || []).forEach(function (li) {
        if (!li.inBaseline || !li.cost) return;
        var q = driverQty(D, li.qty.per, li.qty.value, geo, t);
        if (!(q > 0)) return;
        var rate = li.cost.mid * factorAll;
        carves[li.division] = (carves[li.division] || 0) + cents(q * rate);
        carveLines.push({ li: li, q: q, rate: rate });
      });

      var splitLines = (t.systemSplit && t.systemSplit.lines) || [];
      var baseCents = cents(baseHardDollars);
      var divCents = allocateCents(baseCents, splitLines.map(function (l) { return l.pct; }));
      // Remainders after carve-outs; a deficit (carve-outs bigger than their
      // division's share) is taken from the other divisions proportionally, so
      // the baseline total never moves.
      var rem = splitLines.map(function (l, i) { return divCents[i] - (carves[l.division] || 0); });
      // Carve-outs in a division the split does not list come out of all of them.
      var inSplit = {};
      splitLines.forEach(function (l) { inSplit[l.division] = true; });
      var orphanCarve = sum(Object.keys(carves).filter(function (d) { return !inSplit[d]; }), function (d) { return carves[d]; });
      var deficit = sum(rem.filter(function (x) { return x < 0; })) - orphanCarve;
      if (deficit < 0) {
        var pos = rem.map(function (x) { return x > 0 ? x : 0; });
        var take = allocateCents(-deficit, pos);
        rem = rem.map(function (x, i) { return x < 0 ? 0 : x - take[i]; });
      }
      var carvedDivs = {};
      Object.keys(carves).forEach(function (d) { carvedDivs[d] = true; });
      splitLines.forEach(function (l, i) {
        // A division with carve-outs but no share in the split still gets a
        // zero remainder line so its items have a home.
        lines.add({ key: key('div:' + l.division), comp: comp.id, phase: phase.id, category: 'hard',
          group: 'Construction', division: l.division, code: l.division + ' 00 00',
          name: csiTitle(l.division) + (carvedDivs[l.division] ? ' — balance' : ''),
          amountCents: rem[i], qty: null, rate: null, timing: 'hard',
          source: { kind: t.systemSplit.source && t.systemSplit.source.derived ? 'derived' : 'research',
            ref: t.systemSplit.source, baseline: info.baselineSource, pct: l.pct } });
      });
      carveLines.forEach(function (c) {
        var liSrc = c.li.cost.source || {};
        lines.add({ key: key('item:' + c.li.id), comp: comp.id, phase: phase.id, category: 'hard',
          group: 'Construction', division: c.li.division, code: c.li.division + ' 00 00', name: c.li.name,
          qty: c.q, uom: c.li.unit, rate: c.rate, carveOut: true, timing: 'hard',
          source: { kind: liSrc.derived ? 'derived' : 'research', ref: liSrc } });
      });
    } else if (!isCustom && geo.size > 0 && !(P0 > 0)) {
      warnings.push({ level: 'warn', code: 'no-baseline', comp: comp.id,
        message: comp.name + ': no baseline price — enter one to price this component.' });
    }

    // Additive template items (switchable; optional ones start off).
    (t.lineItems || []).forEach(function (li) {
      if (li.inBaseline || !li.cost) return;
      var sw = (comp.items || {})[li.id] || {};
      var on = sw.on !== undefined ? !!sw.on : !li.optional;
      if (!on) return;
      var q = isNum(sw.qty) ? sw.qty : driverQty(D, li.qty.per, li.qty.value, geo, t);
      if (!(q > 0)) return;
      var liSrc = li.cost.source || {};
      lines.add({ key: key('item:' + li.id), comp: comp.id, phase: phase.id, category: 'hard', group: 'Specialty & site',
        division: li.division, code: li.division + ' 00 00', name: li.name, qty: q, uom: li.unit,
        rate: li.cost.mid * Rf * Ef, timing: 'hard', source: { kind: liSrc.derived ? 'derived' : 'research', ref: liSrc } });
    });

    // Site work the baseline does not include.
    if (!isCustom && t.hardCost && t.hardCost.scope && t.hardCost.scope.includesSitework === false && geo.acres > 0) {
      var sw0 = (comp.items || {})['site-work'] || {};
      if (sw0.on !== false) {
        var b = D.blocks && D.blocks['site-development-light'];
        if (b && b.cost) lines.add({ key: key('site-work'), comp: comp.id, phase: phase.id, category: 'hard',
          group: 'Specialty & site', division: b.division || '31', code: (b.division || '31') + ' 00 00',
          name: 'Site development (not in the baseline price)', qty: isNum(sw0.qty) ? sw0.qty : geo.acres, uom: 'acre',
          rate: b.cost.mid * Rf * Ef, timing: 'hard', source: { kind: b.cost.source.derived ? 'derived' : 'research', ref: b.cost.source } });
      }
    }

    // Parking the baseline does not include.
    var pk = comp.parking;
    if (pk && pk.type && pk.type !== 'none' && pk.type !== 'auto') {
      var pb = D.blocks && D.blocks['parking-' + pk.type];
      var spaces = isNum(pk.spaces) ? pk.spaces : geo.spaces;
      if (pb && pb.cost && spaces > 0) lines.add({ key: key('parking'), comp: comp.id, phase: phase.id, category: 'hard',
        group: 'Parking', division: pb.division || '32', code: (pb.division || '32') + ' 00 00', name: pb.name,
        qty: spaces, uom: 'space', rate: pb.cost.mid * Rf * Ef, timing: 'hard',
        source: { kind: pb.cost.source.derived ? 'derived' : 'research', ref: pb.cost.source } });
      else if (!pb) warnings.push({ level: 'warn', code: 'parking-type', comp: comp.id,
        message: comp.name + ': no researched cost for parking type "' + pk.type + '".' });
    }

    // Extra building blocks (the Custom builder, or add-ons on any component).
    (comp.blocks || []).forEach(function (bl) {
      var b = D.blocks && D.blocks[bl.itemId];
      var hasUser = isNum(bl.unitCost) && bl.unitCost !== null;
      if (!b && !hasUser) {
        warnings.push({ level: 'warn', code: 'unknown-block', comp: comp.id,
          message: comp.name + ': building block "' + bl.itemId + '" is not in the research data.' });
        return;
      }
      var rate = hasUser ? bl.unitCost : b.cost.mid * Rf * Ef;
      var src = hasUser ? { kind: 'user', note: 'Unit cost entered by the user' }
        : { kind: b.cost.source.derived ? 'derived' : 'research', ref: b.cost.source };
      var div = bl.division || (b && b.division) || '01';
      lines.add({ key: key('block:' + bl.id), comp: comp.id, phase: phase.id, category: 'hard', group: 'Building blocks',
        division: div, code: div + ' 00 00', name: bl.name || (b ? b.name : bl.itemId), qty: nz(bl.qty),
        uom: b ? b.unit : (bl.unit || 'ea'), rate: rate, timing: 'hard', source: src });
    });

    // FF&E.
    if (!isCustom && comp.includeFFE !== false && t.ffe && t.ffe.perPrimaryUnit && !(t.hardCost.scope && t.hardCost.scope.includesFFE)
        && geo.size > 0) {
      var fs = t.ffe.perPrimaryUnit.source || {};
      lines.add({ key: key('ffe'), comp: comp.id, phase: phase.id, category: 'ffe', group: 'FF&E', division: '12',
        code: '12 00 00', name: 'Furniture, fixtures & equipment', qty: geo.size, uom: t.primaryUnit,
        rate: t.ffe.perPrimaryUnit.mid * Q.factor * Rf * Ef, timing: 'hard',
        source: { kind: fs.derived ? 'derived' : 'research', ref: fs } });
    }
    return info;
  }

  /* ------------------------------------------------------------ shared elements */
  function sharedCost(D, sh, ctx, phase) {
    var R = ctx.region.factor, E = ctx.esc[phase.id].factor;
    var hasUser = isNum(sh.unitCost) && sh.unitCost !== null;
    if (sh.itemId) {
      var b = D.blocks && D.blocks[sh.itemId];
      if (!b && !hasUser) return null;
      return { rate: hasUser ? sh.unitCost : b.cost.mid * R * E, uom: b ? b.unit : 'ea', division: (b && b.division) || '01',
        name: sh.name || (b ? b.name : sh.itemId),
        source: hasUser ? { kind: 'user', note: 'Unit cost entered by the user' }
          : { kind: b.cost.source.derived ? 'derived' : 'research', ref: b.cost.source } };
    }
    if (sh.typeId) {
      var t = typeOf(D, sh.typeId);
      if (!t && !hasUser) return null;
      var hc = t && t.hardCost && t.hardCost.perPrimaryUnit;
      return { rate: hasUser ? sh.unitCost : (hc ? hc.mid : 0) * R * E, uom: t ? t.primaryUnit : 'ea',
        division: '03', name: sh.name || (t ? t.name : sh.typeId),
        source: hasUser ? { kind: 'user', note: 'Unit cost entered by the user' }
          : { kind: hc && hc.source && hc.source.derived ? 'derived' : 'research', ref: hc ? hc.source : null } };
    }
    if (hasUser) return { rate: sh.unitCost, uom: sh.unit || 'ls', division: sh.division || '01', name: sh.name || 'Shared element',
      source: { kind: 'user', note: 'Unit cost entered by the user' } };
    return null;
  }

  function allocationWeights(sh, comps, info, revenue) {
    var m = sh.allocation && sh.allocation.method;
    if (ALLOCATION_METHODS.indexOf(m) < 0) m = 'sf';
    var targets = comps.filter(function (c) {
      var only = sh.allocation && Array.isArray(sh.allocation.components) && sh.allocation.components.length
        ? sh.allocation.components : null;
      if (only && only.indexOf(c.id) < 0) return false;
      // Manual shares name their components; one without a share takes none.
      if (m === 'manual' && sh.allocation.shares && Object.keys(sh.allocation.shares).some(function (k) { return nz(sh.allocation.shares[k]) > 0; }))
        return nz(sh.allocation.shares[c.id]) > 0;
      return true;
    });
    var w = targets.map(function (c) {
      var i = info[c.id] || { geo: {} };
      if (m === 'sf') return i.geo.sf || 0;
      if (m === 'units') return i.geo.size || 0;
      if (m === 'revenue') return revenue[c.id] || 0;
      if (m === 'cost') return i.directHardCents || 0;
      if (m === 'manual') return nz(sh.allocation.shares && sh.allocation.shares[c.id]);
      return 1;
    });
    return { method: m, targets: targets, weights: w };
  }

  /* ------------------------------------------------------------ soft costs */
  var SOFT_ITEMS = [
    ['architectureEngineering', 'Architecture & engineering'],
    ['civilSurveyGeotech', 'Civil, survey & geotechnical'],
    ['permitsPlanReview', 'Permits & plan review'],
    ['legalAccounting', 'Legal & accounting'],
    ['buildersRiskInsurance', "Builder's risk insurance"],
    ['generalLiabilityInsurance', 'General liability insurance'],
    ['propertyTaxesDuringConstruction', 'Property taxes during construction'],
    ['marketingLeasing', 'Marketing & leasing'],
    ['titleClosingRecording', 'Title, closing & recording (construction loan)'],
    ['testingInspections', 'Testing & inspections'],
    ['ownersRepPM', "Owner's rep / project management"]
  ];

  /* The type's soft-cost % of hard (or a project/component override) is spread
     over the soft-cost items in proportion to their researched norms in
     _common/soft-costs.json; impact & tap fees, the developer fee and financing
     are separate lines. Returns weights and the source of each. */
  function softWeights(D) {
    var out = [];
    SOFT_ITEMS.forEach(function (s) {
      var it = common(D, 'soft-costs', s[0]);
      if (!it || !it.range || !isNum(it.range.mid)) return;
      var b = String(it.basis || '').toLowerCase();
      if (b && b.indexOf('pctofhard') < 0 && b.indexOf('pct of hard') < 0) return;   // other bases handled elsewhere
      out.push({ id: s[0], name: it.name || s[1], w: it.range.mid, source: it.range.source });
    });
    return out;
  }

  /* ------------------------------------------------------------ fees */
  /* Impact + water/sewer capacity (tap) fees from _common/fees.json by the
     type's land use (catalog template.feeUse). Rates are national averages;
     the Impact Fees step's jurisdiction schedule replaces them through
     settings.impactFeesOverride. Which fee item applies to which land use is
     structure (FEE_USES); every rate and EDU factor is research. */
  var FEE_USES = {
    singleFamily: { impact: 'impactFee-singleFamily', per: 'unit', edu: 'eduPerUnit-singleFamily', eduPer: 'unit' },
    multifamily: { impact: 'impactFee-multifamily', per: 'unit', edu: 'eduPerUnit-multifamily', eduPer: 'unit' },
    retail: { impact: 'impactFee-retail', per: 'kSF', edu: 'eduPer1000SF-nonresidential', eduPer: 'kSF' },
    office: { impact: 'impactFee-office', per: 'kSF', edu: 'eduPer1000SF-nonresidential', eduPer: 'kSF' },
    industrial: { impact: 'impactFee-industrial', per: 'kSF', edu: 'eduPer1000SF-nonresidential', eduPer: 'kSF' },
    hotel: { impact: 'impactFee-hotel', per: 'unit', edu: 'eduPer1000SF-nonresidential', eduPer: 'kSF' }
  };
  function feeEstimate(D, t, geo) {
    var use = t && t.template && t.template.feeUse;
    var spec = use && FEE_USES[use];
    if (!spec) return null;
    var units = isNum(t.template.feeDwellingsPerProject) ? t.template.feeDwellingsPerProject
      : geo.size * (isNum(t.template.feeUnitsPerPrimaryUnit) ? t.template.feeUnitsPerPrimaryUnit : 1);
    var ksf = geo.sf / 1000;
    var parts = [];
    var imp = common(D, 'fees', spec.impact);
    var q = spec.per === 'unit' ? units : ksf;
    if (imp && imp.range && isNum(imp.range.mid) && q > 0)
      parts.push({ id: spec.impact, name: imp.name || 'Impact fees', qty: q, uom: spec.per === 'unit' ? (t.primaryUnit === 'key' ? 'key' : 'unit') : '1,000 SF',
        rate: imp.range.mid, source: imp.range.source });
    var eduF = commonMid(D, 'fees', spec.edu);
    var edus = eduF === null ? 0 : eduF * (spec.eduPer === 'unit' ? units : ksf);
    ['waterCapacityFee', 'sewerCapacityFee'].forEach(function (id) {
      var it = common(D, 'fees', id);
      if (it && it.range && isNum(it.range.mid) && edus > 0)
        parts.push({ id: id, name: it.name || id, qty: edus, uom: 'EDU', rate: it.range.mid, source: it.range.source });
    });
    return parts.length ? { parts: parts } : null;
  }

  /* Construction months for a component: the Census start-to-completion
     months for its category (catalog template.durationClass) in the value
     band of its estimated hard cost (_common/schedule.json). */
  function durationFor(D, t, hardDollars) {
    var cls = t && t.template && t.template.durationClass;
    var it = cls ? common(D, 'schedule', 'duration-' + cls) : null;
    if (!it) it = common(D, 'schedule', 'constructionMonths-default');
    if (!it || !it.range) return null;
    var bands = it.extra && Array.isArray(it.extra.bands) ? it.extra.bands : null;
    if (bands && bands.length && isNum(hardDollars) && hardDollars > 0) {
      for (var i = 0; i < bands.length; i++) {
        var mx = bands[i].maxValue;
        if (mx === null || mx === undefined || hardDollars < mx) return { months: bands[i].months, source: it.range.source, cls: cls };
      }
      return { months: bands[bands.length - 1].months, source: it.range.source, cls: cls };
    }
    return isNum(it.range.mid) ? { months: it.range.mid, source: it.range.source, cls: cls } : null;
  }

  /* ------------------------------------------------------------ draws & financing */
  function curveCum(curve, x) {
    x = clamp(x, 0, 1);
    if (curve === 'linear') return x;
    if (curve === 'front') return 1 - (1 - x) * (1 - x);
    if (curve === 'back') return x * x;
    return (1 - Math.cos(Math.PI * x)) / 2;   // 's'
  }
  function curveWeights(curve, months) {
    var w = [];
    for (var m = 1; m <= months; m++) w.push(curveCum(curve, m / months) - curveCum(curve, (m - 1) / months));
    return w;
  }

  /* Monthly cost schedule (cents, excluding financing) for one phase:
     index 0 = financial close; 1..months = construction. */
  function phaseSchedule(phaseLines, months, curve) {
    var n = months + 1, hard = new Array(n).fill(0), soft = new Array(n).fill(0), land = new Array(n).fill(0);
    var hw = curveWeights(curve, months), lw = curveWeights('linear', months);
    phaseLines.forEach(function (l) {
      if (!l.cents) return;
      if (l.category === 'land') { land[0] += l.cents; return; }
      if (l.category === 'financing') return;
      if (l.timing === 'hard' || l.category === 'hard' || l.category === 'ffe' || l.category === 'contingency') {
        var parts = allocateCents(l.cents, hw);
        for (var i = 0; i < months; i++) hard[i + 1] += parts[i];
        return;
      }
      var up = UPFRONT_SOFT[l.softId] !== undefined ? UPFRONT_SOFT[l.softId] : (l.timing === 'upfront' ? 1 : 0);
      var upC = Math.round(l.cents * up);
      soft[0] += upC;
      var spread = allocateCents(l.cents - upC, lw);
      for (var j = 0; j < months; j++) soft[j + 1] += spread[j];
    });
    return { hard: hard, soft: soft, land: land };
  }

  /* Equity first, then the construction loan at LTC; interest accrues monthly
     on the drawn balance and is capitalized (funded by the loan as an interest
     reserve) through construction plus any carry months; the loan fee is paid at
     close on the committed amount. The total cost depends on the interest and
     the interest on the total, so the schedule is solved by fixed-point
     iteration (it converges in a handful of rounds; the cap is a safety net). */
  function financePhase(sched, months, carry, fin) {
    var n = months + 1 + carry;
    var outlay = new Array(n).fill(0);
    for (var i = 0; i <= months; i++) outlay[i] = sched.hard[i] + sched.soft[i] + sched.land[i];
    var base = sum(outlay);
    if (!fin || !fin.enabled || !(fin.ltc > 0) || base <= 0) {
      return { interestCents: 0, feeCents: 0, loanCents: 0, equityCents: base, draws: outlay.map(function (o, m) {
        return { m: m, outlay: o, equity: o, loan: 0, interest: 0, balance: 0 }; }), iterations: 0 };
    }
    var r = fin.rate / 12, ltc = clamp(fin.ltc, 0, 0.95), feeP = fin.feePct || 0;
    var total = base, rows = [], interest = 0, fee = 0, it = 0;
    for (it = 1; it <= 60; it++) {
      fee = Math.round(feeP * ltc * total);
      var equityBudget = Math.round((1 - ltc) * total);
      var eqUsed = 0, bal = 0; interest = 0; rows = [];
      for (var m = 0; m < n; m++) {
        var o = outlay[m] + (m === 0 ? fee : 0);
        var e = Math.min(o, Math.max(0, equityBudget - eqUsed));
        eqUsed += e;
        var loanDraw = o - e;
        var intr = Math.round(bal * r);
        bal += loanDraw + intr;
        interest += intr;
        rows.push({ m: m, outlay: o, equity: e, loan: loanDraw, interest: intr, balance: bal });
      }
      var next = base + fee + interest;
      if (Math.abs(next - total) < 1) { total = next; break; }
      total = next;
    }
    return { interestCents: interest, feeCents: fee, loanCents: rows.length ? rows[rows.length - 1].balance : 0,
      equityCents: total - (rows.length ? rows[rows.length - 1].balance : 0), draws: rows, iterations: it };
  }

  /* ------------------------------------------------------------ calculate */
  function calculate(projectIn, D, opts) {
    opts = opts || {};
    var project = clone(projectIn) || {};
    var warnings = [];
    if (!D || !D.types) return { error: 'no research data', warnings: [{ level: 'error', code: 'no-data', message: 'Research data not loaded.' }] };
    project.components = Array.isArray(project.components) ? project.components : [];
    project.phases = Array.isArray(project.phases) && project.phases.length ? project.phases : [newPhase({ id: 'p1' })];
    project.shared = Array.isArray(project.shared) ? project.shared : [];
    project.settings = project.settings || {};
    project.land = project.land || {};
    var S = project.settings;
    var lines = new Lines(project);
    var region = regionInfo(D, project.location && project.location.region);
    if (region.fellBack) warnings.push({ level: 'warn', code: 'region',
      message: 'No regional factor for "' + region.requested + '" — using ' + region.label + '.' });

    // Phases: start, length, midpoint, escalation.
    var phaseById = {};
    // A first, unescalated estimate of each component's hard cost picks its
    // Census duration band; a phase lasts as long as its longest component.
    var roughHard = function (c) {
      var t = typeOf(D, c.typeId), g = geometry(D, c, t);
      var p0 = c.baseline && isNum(c.baseline.price) && c.baseline.price > 0 ? c.baseline.price
        : (t && t.hardCost && t.hardCost.perPrimaryUnit ? t.hardCost.perPrimaryUnit.mid : 0);
      return p0 * g.size * region.factor + sum(c.blocks || [], function (b) {
        var bi = D.blocks && D.blocks[b.itemId];
        return nz(b.qty) * (isNum(b.unitCost) && b.unitCost !== null ? b.unitCost : (bi && bi.cost ? bi.cost.mid : 0));
      });
    };
    var defaultMonths = function (comps) {
      var best = null;
      comps.forEach(function (c) {
        var d = durationFor(D, typeOf(D, c.typeId), roughHard(c));
        if (d && (best === null || d.months > best)) best = d.months;
      });
      if (best !== null) return best;
      var g = durationFor(D, null, 0);
      return g ? g.months : 1;
    };
    var ctx = { region: region, esc: {} };
    var phaseInfo = [];
    var projStart = project.startMonth || opts.today || null;
    project.phases.forEach(function (ph, i) {
      ph.id = ph.id || 'p' + (i + 1);
      var comps = project.components.filter(function (c) { return (c.phaseId || project.phases[0].id) === ph.id; });
      var months = Math.max(1, Math.round(num(ph.months, defaultMonths(comps))));
      var start = ph.startMonth || (i === 0 ? projStart : null);
      if (!start && i > 0) {
        var prev = phaseInfo[i - 1];
        start = prev.start ? addMonths(prev.start, prev.months) : null;
      }
      var mid = start ? addMonths(start, months / 2) : null;
      var esc = escalation(D, mid, isNum(S.escalationRate) ? S.escalationRate : null);
      if (!start) warnings.push({ level: 'info', code: 'no-start', phase: ph.id,
        message: (ph.name || 'Phase') + ': no start month — priced in ' + (D.baseYear || '') + ' dollars without escalation.' });
      ctx.esc[ph.id] = esc;
      var pi = { id: ph.id, name: ph.name || ('Phase ' + (i + 1)), start: start, months: months, mid: mid, escalation: esc,
        curve: DRAW_CURVES.indexOf(ph.drawCurve) >= 0 ? ph.drawCurve : 's', financing: ph.financing || {},
        carry: Math.max(0, Math.round(num(ph.carryMonths, commonMid(D, 'financing', 'carryMonthsAfterCompletion') || 0))) };
      phaseInfo.push(pi);
      phaseById[ph.id] = pi;
    });
    var firstPhase = phaseInfo[0];

    // 1. Component hard costs.
    var info = {};
    project.components.forEach(function (c, i) {
      c.id = c.id || 'c' + (i + 1);
      var ph = phaseById[c.phaseId] || firstPhase;
      c.phaseId = ph.id;
      info[c.id] = componentHard(D, project, c, ph, ctx, lines, warnings);
      info[c.id].directHardCents = sum(lines.list.filter(function (l) { return l.comp === c.id; }), function (l) { return l.cents; });
    });
    var revenue = {};
    project.components.forEach(function (c) { revenue[c.id] = annualRevenue(c, info[c.id].geo); });

    // 2. Shared elements → allocated hard lines.
    var sharedOut = [];
    project.shared.forEach(function (sh, i) {
      sh.id = sh.id || 's' + (i + 1);
      var ph = phaseById[sh.phaseId] || firstPhase;
      var sc = sharedCost(D, sh, ctx, ph);
      if (!sc) { warnings.push({ level: 'warn', code: 'shared-unpriced', message: (sh.name || sh.id) + ': no cost — choose a block or enter a unit cost.' }); return; }
      // The shared element is priced (and overridable) as one line, then split.
      var whole = new Lines(project).add({ key: 'shared:' + sh.id, category: 'hard', qty: nz(sh.qty), rate: sc.rate,
        name: sc.name, source: sc.source });
      var aw = allocationWeights(sh, project.components, info, revenue);
      if (!aw.targets.length) {
        warnings.push({ level: 'warn', code: 'shared-no-target', message: sc.name + ': no component to allocate to — counted at project level.' });
        lines.add({ key: 'shared:' + sh.id + '>project', comp: null, phase: ph.id, category: 'hard', group: 'Shared elements',
          division: sc.division, code: sc.division + ' 00 00', name: sc.name, amountCents: whole.cents, qty: nz(sh.qty),
          uom: sc.uom, rate: sc.rate, timing: 'hard', source: whole.source });
        sharedOut.push({ id: sh.id, name: sc.name, cents: whole.cents, method: aw.method, shares: [] });
        return;
      }
      if (aw.method === 'manual' && Math.abs(sum(aw.weights) - 1) > 0.001)
        warnings.push({ level: 'info', code: 'shares-normalized', message: sc.name + ': manual shares did not total 100% — normalized.' });
      if (aw.method === 'revenue' && !(sum(aw.weights) > 0))
        warnings.push({ level: 'info', code: 'shares-equal', message: sc.name + ': no revenue entered — split equally.' });
      var split = allocateCents(whole.cents, aw.weights);
      var W = sum(aw.weights.map(function (x) { return x > 0 ? x : 0; }));
      aw.targets.forEach(function (c, k) {
        lines.add({ key: 'shared:' + sh.id + '>' + c.id, comp: c.id, phase: ph.id, category: 'hard', group: 'Shared elements',
          division: sc.division, code: sc.division + ' 00 00', name: sc.name + ' (share)', amountCents: split[k],
          qty: nz(sh.qty), uom: sc.uom, rate: sc.rate, timing: 'hard',
          source: { kind: 'allocation', method: aw.method, share: W > 0 ? aw.weights[k] / W : 1 / aw.targets.length, of: whole.source } });
      });
      sharedOut.push({ id: sh.id, name: sc.name, cents: whole.cents, method: aw.method, phase: ph.id,
        shares: aw.targets.map(function (c, k) { return { comp: c.id, cents: split[k] }; }) });
    });

    // 3. Contingencies, soft costs, fees per (component, phase) group.
    var groups = {};
    lines.list.forEach(function (l) {
      if (l.category !== 'hard' && l.category !== 'ffe') return;
      var g = (l.comp || 'project') + '|' + l.phase;
      groups[g] = groups[g] || { comp: l.comp, phase: l.phase, hard: 0, ffe: 0 };
      groups[g][l.category === 'ffe' ? 'ffe' : 'hard'] += l.cents;
    });
    var softW = softWeights(D);
    var compById = {};
    project.components.forEach(function (c) { compById[c.id] = c; });
    var pctFrom = function (userVal, compVal, typeRange, commonFile, commonId) {
      if (isNum(compVal) && compVal !== null) return { v: compVal, source: { kind: 'user', note: 'Component override' } };
      if (isNum(userVal) && userVal !== null) return { v: userVal, source: { kind: 'user', note: 'Project setting' } };
      if (typeRange && isNum(typeRange.mid)) return { v: typeRange.mid, source: { kind: typeRange.source && typeRange.source.derived ? 'derived' : 'research', ref: typeRange.source } };
      var it = commonFile ? common(D, commonFile, commonId) : null;
      if (it && it.range && isNum(it.range.mid)) return { v: it.range.mid, source: { kind: it.range.source && it.range.source.derived ? 'derived' : 'research', ref: it.range.source } };
      return { v: 0, source: { kind: 'missing', note: 'No researched value' } };
    };
    Object.keys(groups).sort().forEach(function (gk) {
      var g = groups[gk], c = compById[g.comp] || null, t = c ? typeOf(D, c.typeId) : null;
      var tag = (g.comp || 'project') + '@' + g.phase + ':';
      var base = { comp: g.comp, phase: g.phase };
      var cc = (c && c.contingency) || {};
      var tc = (t && t.contingency) || {};
      var dP = pctFrom(S.designContingencyPct, cc.design, tc.design, 'contingency', 'designContingency');
      var hP = pctFrom(S.hardContingencyPct, cc.hard, tc.hard, 'contingency', 'hardCostContingency');
      var sP = pctFrom(S.softContingencyPct, cc.soft, tc.soft, 'contingency', 'softCostContingency');
      var hardBase = g.hard;   // FF&E carries no design contingency
      var dl = lines.add(Object.assign({ key: tag + 'cont:design', category: 'contingency', group: 'Contingency',
        code: '99 02 00', name: 'Design contingency', amountCents: Math.round(hardBase * dP.v), qty: dP.v, uom: '% of hard',
        rate: dollars(hardBase), timing: 'hard', source: dP.source }, base));
      lines.add(Object.assign({ key: tag + 'cont:hard', category: 'contingency', group: 'Contingency', code: '99 03 00',
        name: 'Hard cost (construction) contingency', amountCents: Math.round((hardBase + g.ffe + dl.cents) * hP.v), qty: hP.v,
        uom: '% of hard', rate: dollars(hardBase + g.ffe + dl.cents), timing: 'hard', source: hP.source }, base));

      // Soft cost bucket: type % of hard (or overrides), spread by norm weights.
      var spct = pctFrom(S.softCostPct, c ? c.softCostPct : null, t && t.softCosts ? t.softCosts.pctOfHard : null,
        null, null);
      var bucket = Math.round((g.hard + g.ffe) * spct.v);
      var wsum = sum(softW, function (x) { return x.w; });
      if (bucket > 0 && softW.length && wsum > 0) {
        var parts = allocateCents(bucket, softW.map(function (x) { return x.w; }));
        softW.forEach(function (s, k) {
          var l = lines.add(Object.assign({ key: tag + 'soft:' + s.id, category: 'soft', group: 'Soft costs', code: 'SC',
            name: s.name, amountCents: parts[k], qty: spct.v * s.w / wsum, uom: '% of hard', rate: dollars(g.hard + g.ffe),
            source: { kind: 'research-blend', typePct: spct.source, weight: s.source } }, base));
          l.softId = s.id;
        });
      } else if (bucket > 0) {
        lines.add(Object.assign({ key: tag + 'soft:all', category: 'soft', group: 'Soft costs', code: 'SC',
          name: 'Soft costs', amountCents: bucket, qty: spct.v, uom: '% of hard', rate: dollars(g.hard + g.ffe), source: spct.source }, base));
      }
      // Third-party reports: a per-project amount (first group of each component only).
      if (c && gk === (c.id + '|' + c.phaseId)) {
        var tp = common(D, 'soft-costs', 'thirdPartyReports');
        if (tp && tp.range && isNum(tp.range.mid) && /project/i.test(tp.basis || '')) {
          var l3 = lines.add(Object.assign({ key: tag + 'soft:thirdPartyReports', category: 'soft', group: 'Soft costs', code: 'SC',
            name: tp.name || 'Third-party reports', qty: 1, uom: 'project', rate: tp.range.mid * region.factor,
            source: { kind: tp.range.source && tp.range.source.derived ? 'derived' : 'research', ref: tp.range.source } }, base));
          l3.softId = 'thirdPartyReports';
        }
        // Impact & tap fees.
        var geo = info[c.id].geo;
        var fe = S.impactFeesOverride === null || S.impactFeesOverride === undefined ? feeEstimate(D, t, geo) : null;
        (fe ? fe.parts : []).forEach(function (fp) {
          var lf = lines.add(Object.assign({ key: tag + 'fees:' + fp.id, category: 'fees', group: 'Impact & tap fees', code: 'SC',
            name: fp.name, qty: fp.qty, uom: fp.uom, rate: fp.rate, timing: 'upfront',
            source: { kind: fp.source && fp.source.derived ? 'derived' : 'research', ref: fp.source } }, base));
          lf.softId = 'impactFees';
        });
      }
    });
    // A jurisdiction schedule from the Impact Fees step replaces the estimates,
    // allocated across components by building SF.
    if (isNum(S.impactFeesOverride) && S.impactFeesOverride !== null && project.components.length) {
      var feeSplit = allocateCents(cents(S.impactFeesOverride), project.components.map(function (c) { return info[c.id].geo.sf || 0; }));
      project.components.forEach(function (c, k) {
        var lf = lines.add({ key: c.id + '@' + c.phaseId + ':fees:schedule', comp: c.id, phase: c.phaseId, category: 'fees',
          group: 'Impact & tap fees', code: 'SC', name: 'Impact & tap fees (jurisdiction schedule)', amountCents: feeSplit[k],
          timing: 'upfront', source: { kind: 'user', note: 'From the Impact Fees step' } });
        lf.softId = 'impactFees';
      });
    }

    // Soft contingency on each group's soft + fees.
    Object.keys(groups).sort().forEach(function (gk) {
      var g = groups[gk], c = compById[g.comp] || null, t = c ? typeOf(D, c.typeId) : null;
      var tag = (g.comp || 'project') + '@' + g.phase + ':';
      var softSum = sum(lines.list.filter(function (l) { return l.comp === g.comp && l.phase === g.phase && (l.category === 'soft' || l.category === 'fees'); }),
        function (l) { return l.cents; });
      var sP = pctFrom(S.softContingencyPct, c && c.contingency ? c.contingency.soft : null, t && t.contingency ? t.contingency.soft : null,
        'contingency', 'softCostContingency');
      lines.add({ key: tag + 'cont:soft', comp: g.comp, phase: g.phase, category: 'softContingency', group: 'Contingency',
        code: 'SC', name: 'Soft cost contingency', amountCents: Math.round(softSum * sP.v), qty: sP.v, uom: '% of soft',
        rate: dollars(softSum), source: sP.source });
    });

    // 4. Land.
    var L0 = project.land, landCents = 0;
    var totalAcres = num(L0.acres, null);
    var compAcres = sum(project.components, function (c) { return info[c.id].geo.acres || 0; });
    if (totalAcres === null) totalAcres = compAcres;
    var totalSize = sum(project.components, function (c) { return info[c.id].geo.size || 0; });
    if (L0.mode === 'perAcre') landCents = cents(nz(L0.value) * totalAcres);
    else if (L0.mode === 'perUnit') landCents = cents(nz(L0.value) * totalSize);
    else landCents = cents(L0.value);
    var landLines = [];
    if (landCents > 0) {
      var closeP = isNum(L0.closingPct) && L0.closingPct !== null ? { v: L0.closingPct, source: { kind: 'user' } }
        : pctFrom(null, null, null, 'land-closing', 'landClosingCosts');
      var ddIt = common(D, 'land-closing', 'landDueDiligence');
      var ddC = isNum(L0.dueDiligence) && L0.dueDiligence !== null ? cents(L0.dueDiligence)
        : (ddIt && ddIt.range && isNum(ddIt.range.mid) ? cents(ddIt.range.mid * region.factor) : 0);
      var ddSrc = isNum(L0.dueDiligence) && L0.dueDiligence !== null ? { kind: 'user' }
        : { kind: ddIt && ddIt.range && ddIt.range.source && ddIt.range.source.derived ? 'derived' : 'research', ref: ddIt && ddIt.range ? ddIt.range.source : null };
      landLines.push({ id: 'price', name: 'Land / acquisition', cents: landCents, source: { kind: 'user', note: 'Land price entered by the user' } });
      landLines.push({ id: 'closing', name: 'Land closing costs', cents: Math.round(landCents * closeP.v), source: closeP.source });
      if (ddC > 0) landLines.push({ id: 'dd', name: 'Land due diligence', cents: ddC, source: ddSrc });
      var lw = project.components.map(function (c) { return info[c.id].geo.acres || info[c.id].geo.sf || 0; });
      landLines.forEach(function (ll) {
        var whole = new Lines(project).add({ key: 'land:' + ll.id, category: 'land', amountCents: ll.cents, name: ll.name, source: ll.source });
        if (!project.components.length) {
          lines.add({ key: 'land:' + ll.id + '>project', comp: null, phase: firstPhase.id, category: 'land', group: 'Land',
            code: 'LAND', name: ll.name, amountCents: whole.cents, source: whole.source });
          return;
        }
        var sp = allocateCents(whole.cents, lw);
        project.components.forEach(function (c, k) {
          lines.add({ key: 'land:' + ll.id + '>' + c.id, comp: c.id, phase: c.phaseId, category: 'land', group: 'Land',
            code: 'LAND', name: ll.name, amountCents: sp[k], source: { kind: 'allocation', method: 'acres', of: whole.source } });
        });
      });
    }

    // Property taxes during construction: the land's assessed value (taken as
    // its price) × the researched annual rate × the phase's construction years.
    var taxIt = common(D, 'soft-costs', 'propertyTaxesDuringConstruction');
    if (landCents > 0 && taxIt && taxIt.range && isNum(taxIt.range.mid)) {
      project.components.forEach(function (c) {
        var landC = sum(lines.list.filter(function (l) { return l.comp === c.id && /^land:price>/.test(l.key); }), function (l) { return l.cents; });
        var pi = phaseById[c.phaseId];
        if (!(landC > 0) || !pi) return;
        var lt = lines.add({ key: c.id + '@' + c.phaseId + ':soft:propertyTaxes', comp: c.id, phase: c.phaseId, category: 'soft',
          group: 'Soft costs', code: 'SC', name: taxIt.name || 'Property taxes during construction',
          qty: pi.months / 12, uom: 'years', rate: dollars(landC) * taxIt.range.mid,
          source: { kind: taxIt.range.source && taxIt.range.source.derived ? 'derived' : 'research', ref: taxIt.range.source } });
        lt.softId = 'propertyTaxesDuringConstruction';
      });
    }

    // 5. Developer fee: % of cost before the fee and financing, excluding land.
    Object.keys(groups).sort().forEach(function (gk) {
      var g = groups[gk], c = compById[g.comp] || null;
      var tag = (g.comp || 'project') + '@' + g.phase + ':';
      var baseC = sum(lines.list.filter(function (l) { return l.comp === g.comp && l.phase === g.phase && l.category !== 'land'; }),
        function (l) { return l.cents; });
      var tdf = c ? typeOf(D, c.typeId) : null;
      var dv = pctFrom(S.developerFeePct, c ? c.developerFeePct : null, tdf && tdf.softCosts ? tdf.softCosts.developerFee : null, 'soft-costs', 'developerFee');
      lines.add({ key: tag + 'dev', comp: g.comp, phase: g.phase, category: 'developerFee', group: 'Developer fee', code: 'DEV',
        name: 'Developer fee', amountCents: Math.round(baseC * dv.v), qty: dv.v, uom: '% of cost excl. land',
        rate: dollars(baseC), source: dv.source });
    });

    // 6. Financing per phase.
    var finDefaults = {
      ltc: commonMid(D, 'financing', 'loanToCost'), rate: commonMid(D, 'financing', 'constructionLoanRate'),
      feePct: commonMid(D, 'financing', 'constructionLoanFee')
    };
    var finSrc = function (id) { var it = common(D, 'financing', id); return it && it.range ? it.range.source : null; };
    phaseInfo.forEach(function (pi) {
      var pl = lines.list.filter(function (l) { return l.phase === pi.id; });
      var f = pi.financing || {};
      var fin = { enabled: f.enabled !== false, ltc: num(f.ltc, finDefaults.ltc), rate: num(f.rate, finDefaults.rate),
        feePct: num(f.feePct, finDefaults.feePct) };
      if (fin.enabled && (fin.ltc === null || fin.rate === null)) {
        warnings.push({ level: 'warn', code: 'financing-missing', phase: pi.id, message: pi.name + ': no researched financing terms — financing not modeled.' });
        fin.enabled = false;
      }
      var sched = phaseSchedule(pl, pi.months, pi.curve);
      var res = financePhase(sched, pi.months, pi.carry, fin);
      pi.fin = fin; pi.loan = res; pi.sched = sched;
      // Attribute interest and fee to components by their share of the phase's cost.
      var compsIn = {};
      pl.forEach(function (l) { var k = l.comp || 'project'; compsIn[k] = (compsIn[k] || 0) + l.cents; });
      var keys = Object.keys(compsIn).sort();
      [['interest', 'Construction loan interest (capitalized)', res.interestCents, { kind: 'computed', note: 'Monthly draw schedule × loan rate', rate: finSrc('constructionLoanRate'), ltc: finSrc('loanToCost') }],
       ['fee', 'Construction loan fee', res.feeCents, { kind: 'computed', note: 'Loan fee × committed loan', fee: finSrc('constructionLoanFee') }]].forEach(function (fx) {
        if (!fx[2]) return;
        var whole = new Lines(project).add({ key: pi.id + ':fin:' + fx[0], category: 'financing', amountCents: fx[2], name: fx[1], source: fx[3] });
        var sp = allocateCents(whole.cents, keys.map(function (k) { return compsIn[k]; }));
        keys.forEach(function (k, j) {
          lines.add({ key: pi.id + ':fin:' + fx[0] + '>' + k, comp: k === 'project' ? null : k, phase: pi.id, category: 'financing',
            group: 'Financing', code: 'FIN', name: fx[1], amountCents: sp[j], source: whole.overridden ? whole.source : fx[3] });
        });
      });
    });

    // Overrides that matched nothing (a removed component, a renamed item).
    var stale = Object.keys(project.overrides || {}).filter(function (k) {
      return !lines.used[k] && !lines.list.some(function (l) { return l.key === k; });
    });
    if (stale.length) warnings.push({ level: 'info', code: 'stale-overrides', keys: stale,
      message: stale.length + ' override(s) no longer match a line and were ignored.' });

    return assemble(D, project, lines.list, info, phaseInfo, sharedOut, region, warnings, revenue);
  }

  function annualRevenue(c, geo) {
    var r = c.revenue;
    if (!r || !isNum(+r.rate) || r.rate === null || r.rate === '') return 0;
    var rate = +r.rate;
    if (r.mode === 'perUnitMonth') return rate * geo.size * 12;
    if (r.mode === 'perUnitYear') return rate * geo.size;
    if (r.mode === 'perSFYear') return rate * geo.sf;
    if (r.mode === 'annual') return rate;
    return 0;
  }

  /* ------------------------------------------------------------ assemble the result */
  var CAT_BUCKET = { hard: 'hard', ffe: 'ffe', contingency: 'contingency', soft: 'soft', fees: 'soft',
    softContingency: 'contingency', developerFee: 'soft', financing: 'financing', land: 'land' };

  function totalsOf(ls) {
    var t = { hard: 0, ffe: 0, contingency: 0, soft: 0, financing: 0, land: 0, total: 0,
      hardContingency: 0, softContingency: 0, fees: 0, developerFee: 0 };
    ls.forEach(function (l) {
      var b = CAT_BUCKET[l.category] || 'soft';
      t[b] += l.cents; t.total += l.cents;
      if (l.category === 'contingency') t.hardContingency += l.cents;
      if (l.category === 'softContingency') t.softContingency += l.cents;
      if (l.category === 'fees') t.fees += l.cents;
      if (l.category === 'developerFee') t.developerFee += l.cents;
    });
    var out = {};
    Object.keys(t).forEach(function (k) { out[k] = dollars(t[k]); });
    // The three-way split reported everywhere: hard (incl. FF&E and hard-side
    // contingency) / soft (incl. fees, developer fee, financing, soft contingency) / land.
    out.hardAll = dollars(t.hard + t.ffe + t.hardContingency);
    out.softAll = dollars(t.soft + t.financing + t.softContingency);
    out.cents = t.total;
    return out;
  }

  function metricsOf(totalD, sf, acres, size, unit) {
    return { sf: sf, acres: acres, primaryUnits: size, unit: unit,
      perSF: sf > 0 ? totalD / sf : null, perAcre: acres > 0 ? totalD / acres : null,
      perPrimaryUnit: size > 0 && unit ? totalD / size : null };
  }

  function assemble(D, project, list, info, phaseInfo, sharedOut, region, warnings, revenue) {
    var totals = totalsOf(list);
    var comps = project.components.map(function (c) {
      var t = typeOf(D, c.typeId), i = info[c.id], g = i.geo || { size: 0, sf: 0, acres: 0 };
      var cl = list.filter(function (l) { return l.comp === c.id; });
      var ct = totalsOf(cl);
      var m = metricsOf(ct.total, g.sf, g.acres, g.size, t ? t.primaryUnit : null);
      // Range check: all-in (hard + soft, excl. land) per primary unit, brought
      // back to national base-year dollars so it compares with the research.
      var range = null;
      if (t && t.rangeCheck && g.size > 0) {
        var allIn = ct.total - ct.land;
        var R = i.factors && isNum(i.factors.regional) ? i.factors.regional : 1;
        var E = i.factors && isNum(i.factors.escalation) ? i.factors.escalation : 1;
        var per = allIn / g.size / (R * E);
        var status = per < t.rangeCheck.min ? 'below' : per > t.rangeCheck.max ? 'above' : 'within';
        range = { min: t.rangeCheck.min, max: t.rangeCheck.max, value: per, status: status, unit: t.primaryUnit };
        if (status !== 'within') warnings.push({ level: 'warn', code: 'range', comp: c.id,
          message: c.name + ': all-in cost of $' + Math.round(per).toLocaleString('en-US') + ' per ' + unitLabel(D, t.primaryUnit)
            + ' (national, ' + D.baseYear + ' $) is ' + status + ' the researched range of $'
            + Math.round(t.rangeCheck.min).toLocaleString('en-US') + '–$' + Math.round(t.rangeCheck.max).toLocaleString('en-US') + '.' });
      }
      return { id: c.id, name: c.name, typeId: c.typeId, typeName: t ? t.name : c.typeId, category: t ? t.category : null,
        phaseId: c.phaseId, quality: c.quality, size: g.size, unit: t ? t.primaryUnit : null,
        unitLabel: t ? unitLabel(D, t.primaryUnit, true) : '', sf: g.sf, acres: g.acres, spaces: g.spaces,
        factors: i.factors || {}, baselinePrice: i.baselinePrice || 0, baselineSource: i.baselineSource,
        unitPrice: i.unitPrice || 0, totals: ct, metrics: m, range: range, revenue: revenue[c.id] || 0 };
    });
    var phases = phaseInfo.map(function (pi) {
      var pl = list.filter(function (l) { return l.phase === pi.id; });
      var pt = totalsOf(pl);
      var start = monthIndex(pi.start);
      var draws = (pi.loan ? pi.loan.draws : []).map(function (d) {
        var m = d.m;
        return { month: start === null ? null : monthOf(start + m), index: m,
          hard: dollars(pi.sched.hard[m] || 0), soft: dollars(pi.sched.soft[m] || 0), land: dollars(pi.sched.land[m] || 0),
          outlay: dollars(d.outlay), equity: dollars(d.equity), loan: dollars(d.loan), interest: dollars(d.interest),
          balance: dollars(d.balance) };
      });
      var compsIn = project.components.filter(function (c) { return c.phaseId === pi.id; });
      var sf = sum(compsIn, function (c) { return info[c.id].geo.sf || 0; });
      var acres = sum(compsIn, function (c) { return info[c.id].geo.acres || 0; });
      return { id: pi.id, name: pi.name, start: pi.start, months: pi.months, carryMonths: pi.carry, midpoint: pi.mid,
        escalation: { factor: pi.escalation.factor, years: pi.escalation.years, method: pi.escalation.method },
        curve: pi.curve, components: compsIn.map(function (c) { return c.id; }), totals: pt,
        metrics: metricsOf(pt.total, sf, acres, null, null),
        financing: pi.fin ? { enabled: pi.fin.enabled, ltc: pi.fin.ltc, rate: pi.fin.rate, feePct: pi.fin.feePct,
          loan: dollars(pi.loan.loanCents), equity: dollars(pi.loan.equityCents), interest: dollars(pi.loan.interestCents),
          fee: dollars(pi.loan.feeCents), iterations: pi.loan.iterations } : null,
        draws: draws };
    });
    var sfAll = sum(comps, function (c) { return c.sf || 0; });
    var acresAll = num(project.land && project.land.acres, null);
    if (acresAll === null) acresAll = sum(comps, function (c) { return c.acres || 0; });
    var units = {};
    comps.forEach(function (c) { if (c.unit) units[c.unit] = (units[c.unit] || 0) + c.size; });
    var unitKeys = Object.keys(units);
    var single = unitKeys.length === 1 ? unitKeys[0] : null;
    var metrics = metricsOf(totals.total, sfAll, acresAll, single ? units[single] : null, single);
    metrics.byUnit = units;
    var T = totals.total;
    var split = { hard: T > 0 ? totals.hardAll / T : 0, soft: T > 0 ? totals.softAll / T : 0, land: T > 0 ? totals.land / T : 0 };

    var outLines = list.map(function (l) {
      return { key: l.key, comp: l.comp, phase: l.phase, category: l.category, group: l.group, division: l.division,
        code: l.code, name: l.name, qty: l.qty, uom: l.uom, rate: l.rate, amount: dollars(l.cents),
        baseAmount: dollars(l.baseCents), overridden: l.overridden, carveOut: l.carveOut, source: l.source };
    });
    var result = {
      engineVersion: ENGINE_VERSION, dataVersion: D.version, baseYear: D.baseYear,
      region: { key: region.key, factor: region.factor, label: region.label },
      totals: totals, metrics: metrics, split: split, components: comps, phases: phases,
      shared: sharedOut.map(function (s) { return { id: s.id, name: s.name, amount: dollars(s.cents), method: s.method,
        phase: s.phase || null, shares: s.shares.map(function (x) { return { comp: x.comp, amount: dollars(x.cents) }; }) }; }),
      lines: outLines, warnings: warnings
    };
    result.proforma = proformaScopes(project, result);
    return result;
  }

  /* What the pro forma (investment engine) needs, per scope. Purchase price
     is the scope's total project cost; size is building SF when there is
     any, else the primary units; income comes from the revenue the user
     entered on each component. Nothing here calls the pro forma engine. */
  function proformaScopes(project, result) {
    function scope(kind, id, name, comps, totalD) {
      var sf = sum(comps, function (c) { return c.sf || 0; });
      var units = {};
      comps.forEach(function (c) { if (c.unit) units[c.unit] = (units[c.unit] || 0) + c.size; });
      var uk = Object.keys(units);
      var potential = 0, other = 0, vacW = 0, expW = 0, vacSum = 0, expSum = 0;
      comps.forEach(function (rc) {
        var pc = project.components.filter(function (x) { return x.id === rc.id; })[0] || {};
        var r = pc.revenue || {};
        var inc = rc.revenue || 0;
        potential += inc;
        other += nz(r.otherIncome);
        if (isNum(+r.vacancy) && r.vacancy !== null && r.vacancy !== '') { vacSum += inc * (+r.vacancy); vacW += inc; }
        if (isNum(+r.expenseRatio) && r.expenseRatio !== null && r.expenseRatio !== '') { expSum += (inc + nz(r.otherIncome)) * (+r.expenseRatio); expW += inc + nz(r.otherIncome); }
      });
      var dwelling = ['unit', 'key', 'bed', 'pad', 'site', 'slip', 'space'];
      var unitCount = uk.length === 1 && dwelling.indexOf(uk[0]) >= 0 ? units[uk[0]] : null;
      return { kind: kind, id: id, name: name, totalCost: Math.round(totalD * 100) / 100,
        sizeSF: sf > 0 ? sf : null, size: sf > 0 ? { unit: 'squareFeet', value: sf }
          : (unitCount ? { unit: 'units', value: unitCount } : null),
        unitCount: unitCount, primaryUnits: units,
        income: { year1PotentialIncome: Math.round(potential * 100) / 100, otherIncome: Math.round(other * 100) / 100 },
        vacancy: vacW > 0 ? r4(vacSum / vacW) : null, expenseRatio: expW > 0 ? r4(expSum / expW) : null,
        components: comps.map(function (c) { return c.id; }) };
    }
    var all = result.components;
    return {
      project: scope('project', 'project', 'Whole project', all, result.totals.total),
      components: all.map(function (c) { return scope('component', c.id, c.name, [c], c.totals.total); }),
      phases: result.phases.map(function (p) {
        return scope('phase', p.id, p.name, all.filter(function (c) { return c.phaseId === p.id; }), p.totals.total); })
    };
  }

  /* ------------------------------------------------------------ scenarios & sensitivity */
  function merge(base, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
    var out = clone(base) || {};
    Object.keys(patch).forEach(function (k) {
      if (k === 'components' && Array.isArray(patch.components) && Array.isArray(out.components)) {
        patch.components.forEach(function (pc) {
          var i = out.components.map(function (c) { return c.id; }).indexOf(pc.id);
          if (i >= 0) out.components[i] = merge(out.components[i], pc); else out.components.push(clone(pc));
        });
      } else if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) out[k] = merge(out[k], patch[k]);
      else out[k] = clone(patch[k]);
    });
    return out;
  }
  function applyScenario(project, scenario) { return merge(project, (scenario && scenario.patch) || {}); }

  function compareScenarios(project, D, opts) {
    var base = calculate(project, D, opts);
    var rows = [{ id: 'base', name: 'Base', result: base }];
    (project.scenarios || []).forEach(function (s) {
      rows.push({ id: s.id, name: s.name, result: calculate(applyScenario(project, s), D, opts) });
    });
    return rows.map(function (r) {
      return { id: r.id, name: r.name, totals: r.result.totals, metrics: r.result.metrics, split: r.result.split,
        delta: r.result.totals.total - base.totals.total };
    });
  }

  /* One-at-a-time sensitivity: each driver moved down and up, everything else
     held. Drivers that do not apply (no land, no financing) are left out. */
  function sensitivity(project, D, opts) {
    var base = calculate(project, D, opts);
    var B = base.totals.total;
    var drivers = [];
    var withComps = function (f) {
      return function (p) { p.components.forEach(f); return p; };
    };
    drivers.push({ id: 'baseline', name: 'Baseline price per unit', lo: '-10%', hi: '+10%',
      down: withComps(function (c, i) { var cb = base.components[i]; c.baseline = Object.assign({}, c.baseline, { price: (cb ? cb.baselinePrice : 0) * 0.9 }); }),
      up: withComps(function (c, i) { var cb = base.components[i]; c.baseline = Object.assign({}, c.baseline, { price: (cb ? cb.baselinePrice : 0) * 1.1 }); }) });
    drivers.push({ id: 'quality', name: 'Quality tier', lo: 'one tier down', hi: 'one tier up',
      down: withComps(function (c) { var i = QUALITY_TIERS.indexOf(c.quality || 'standard'); c.quality = QUALITY_TIERS[Math.max(0, i - 1)]; }),
      up: withComps(function (c) { var i = QUALITY_TIERS.indexOf(c.quality || 'standard'); c.quality = QUALITY_TIERS[Math.min(3, i + 1)]; }) });
    var softNow = function (c) {
      var t = typeOf(D, c.typeId);
      return isNum(c.softCostPct) && c.softCostPct !== null ? c.softCostPct
        : isNum(project.settings && project.settings.softCostPct) && project.settings.softCostPct !== null ? project.settings.softCostPct
        : (t && t.softCosts && t.softCosts.pctOfHard ? t.softCosts.pctOfHard.mid : 0);
    };
    drivers.push({ id: 'soft', name: 'Soft cost %', lo: '×0.8', hi: '×1.2',
      down: withComps(function (c) { c.softCostPct = softNow(c) * 0.8; }), up: withComps(function (c) { c.softCostPct = softNow(c) * 1.2; }) });
    var escNow = isNum(project.settings && project.settings.escalationRate) && project.settings.escalationRate !== null
      ? project.settings.escalationRate : null;
    var fc = D.indices && D.indices.escalation && D.indices.escalation.forecast;
    var fcMid = fc ? sum(Object.keys(fc).map(function (k) { return +fc[k]; })) / Math.max(1, Object.keys(fc).length) : null;
    var e0 = escNow !== null ? escNow : fcMid;
    if (e0 !== null && base.phases.some(function (p) { return p.midpoint; })) drivers.push({ id: 'escalation', name: 'Escalation rate', lo: '−2 pts', hi: '+2 pts',
      down: function (p) { p.settings.escalationRate = e0 - 0.02; return p; }, up: function (p) { p.settings.escalationRate = e0 + 0.02; return p; } });
    if (base.totals.financing > 0) {
      var rate0 = base.phases.filter(function (p) { return p.financing && p.financing.enabled; }).map(function (p) { return p.financing.rate; })[0];
      drivers.push({ id: 'rate', name: 'Construction loan rate', lo: '−1 pt', hi: '+1 pt',
        down: function (p) { p.phases.forEach(function (ph) { ph.financing = Object.assign({}, ph.financing, { rate: rate0 - 0.01 }); }); return p; },
        up: function (p) { p.phases.forEach(function (ph) { ph.financing = Object.assign({}, ph.financing, { rate: rate0 + 0.01 }); }); return p; } });
      drivers.push({ id: 'duration', name: 'Construction duration', lo: '−3 months', hi: '+3 months',
        down: function (p) { p.phases.forEach(function (ph, i) { ph.months = Math.max(1, base.phases[i].months - 3); }); return p; },
        up: function (p) { p.phases.forEach(function (ph, i) { ph.months = base.phases[i].months + 3; }); return p; } });
    }
    if (base.totals.land > 0) drivers.push({ id: 'land', name: 'Land price', lo: '-10%', hi: '+10%',
      down: function (p) { p.land.value = nz(p.land.value) * 0.9; return p; }, up: function (p) { p.land.value = nz(p.land.value) * 1.1; return p; } });
    var contNow = function (k, c) {
      var t = typeOf(D, c.typeId);
      return t && t.contingency && t.contingency[k] ? t.contingency[k].mid : 0;
    };
    drivers.push({ id: 'contingency', name: 'Hard cost contingency', lo: '−2 pts', hi: '+2 pts',
      down: withComps(function (c) { c.contingency = Object.assign({}, c.contingency, { hard: Math.max(0, num(c.contingency && c.contingency.hard, contNow('hard', c)) - 0.02) }); }),
      up: withComps(function (c) { c.contingency = Object.assign({}, c.contingency, { hard: num(c.contingency && c.contingency.hard, contNow('hard', c)) + 0.02 }); }) });
    return { base: B, drivers: drivers.map(function (d) {
      var lo = calculate(d.down(clone(project)), D, opts).totals.total;
      var hi = calculate(d.up(clone(project)), D, opts).totals.total;
      return { id: d.id, name: d.name, loLabel: d.lo, hiLabel: d.hi, low: lo, high: hi, lowDelta: lo - B, highDelta: hi - B,
        swing: Math.abs(hi - lo) };
    }).sort(function (a, b) { return b.swing - a.swing; }) };
  }

  /* ------------------------------------------------------------ into the budget document */
  /* Materialize a result into the existing budget document's fields (see
     docs/BUDGET_ENGINE.md §7). parts(doc).project equals result.totals.total
     to the cent: hard + FF&E → res lines, design + hard contingency → the
     contingency amount (line 99 03 00), soft/fees/soft contingency/financing →
     soft lines, land price → projectCosts.land, land closing + due diligence →
     projectCosts.cls, developer fee → projectCosts.dev. No profit split: the
     baseline is a contractor's price including OH&P. */
  function toBudgetDoc(result, project) {
    var lines = [], contC = 0, landC = 0, clsC = 0, devC = 0;
    result.lines.forEach(function (l) {
      var c = Math.round(l.amount * 100);
      if (l.category === 'contingency') { contC += c; return; }
      if (l.category === 'land') { if (/^land:price/.test(l.key)) landC += c; else clsC += c; return; }
      if (l.category === 'developerFee') { devC += c; return; }
      var scope = l.category === 'hard' || l.category === 'ffe' ? 'res' : 'soft';
      var comp = result.components.filter(function (x) { return x.id === l.comp; })[0];
      var grp = (comp ? comp.name + ' — ' : '') + (scope === 'res' ? (l.category === 'ffe' ? 'FF&E' : l.group) : l.group);
      lines.push({ lineId: 'eng-' + l.key.replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 56), scope: scope, grp: grp,
        code: l.code || '', desc: l.name, basis: 'ls', qty: 1, auto: false, unit: dollars(c), baseUnit: dollars(c),
        derived: 'engine', engineKey: l.key, comp: l.comp, phase: l.phase });
    });
    var sf = result.metrics.sf || 0;
    return {
      lines: lines,
      contingency: { mode: 'amt', val: dollars(contC) },
      projectCosts: { land: dollars(landC), dev: { mode: 'amt', val: dollars(devC) }, mkt: { mode: 'amt', val: 0 },
        cls: { mode: 'amt', val: dollars(clsC) } },
      companies: [],
      resSF: Math.round(sf), amenSF: 0,
      siteSF: Math.round((result.metrics.acres || 0) * SQFT_PER_ACRE),
      engineSummary: summaryOf(result)
    };
  }

  function summaryOf(result) {
    return { engineVersion: result.engineVersion, dataVersion: result.dataVersion, baseYear: result.baseYear,
      region: result.region, totals: result.totals, metrics: result.metrics, split: result.split,
      components: result.components.map(function (c) { return { id: c.id, name: c.name, typeId: c.typeId, typeName: c.typeName,
        phaseId: c.phaseId, size: c.size, unit: c.unit, sf: c.sf, acres: c.acres, totals: c.totals, metrics: c.metrics, range: c.range }; }),
      phases: result.phases.map(function (p) { return { id: p.id, name: p.name, start: p.start, months: p.months,
        midpoint: p.midpoint, escalation: p.escalation.factor, totals: p.totals, financing: p.financing }; }),
      proforma: result.proforma };
  }

  /* ------------------------------------------------------------ fsdoc export sheets */
  function fmtMoney(v) { return v === null || v === undefined ? '—' : '$' + Math.round(v).toLocaleString('en-US'); }
  function sourceLabel(src, D) {
    if (!src) return '';
    if (src.kind === 'user') return 'User override' + (src.note && src.note !== 'Overridden' ? ' — ' + src.note : '');
    if (src.kind === 'allocation') return 'Allocated by ' + src.method;
    if (src.kind === 'computed') return src.note || 'Computed';
    if (src.kind === 'research-blend') return 'Type soft-cost % × soft-cost norm weights';
    if (src.kind === 'missing') return 'No researched value';
    var ref = src.ref || src;
    if (src.baseline && src.baseline.kind === 'user') return 'User baseline price; split ' + (ref && ref.file ? ref.file : '');
    var tag = ref && ref.derived ? 'Derived estimate — verify' : 'Researched';
    return tag + (ref && ref.file ? ' (' + ref.file + ')' : '');
  }

  function toFsdocSheets(result, project, D) {
    var R = result, sheets = [];
    var kv = function (k, v, fmt, total) { return { k: k, v: v, fmt: fmt, total: !!total }; };
    var unit = R.metrics.unit ? unitLabel(D, R.metrics.unit) : null;
    sheets.push({ key: 'engine-summary', name: 'Estimate Summary', title: 'Total Project Cost — Summary', blocks: [
      { kind: 'kpiBand', tiles: [
        { k: 'Total project cost', v: fmtMoney(R.totals.total) },
        { k: 'Per SF', v: R.metrics.perSF ? '$' + R.metrics.perSF.toFixed(2) : '—' },
        { k: unit ? 'Per ' + unit : 'Per acre', v: unit ? fmtMoney(R.metrics.perPrimaryUnit) : fmtMoney(R.metrics.perAcre) },
        { k: 'Hard / Soft / Land', v: Math.round(R.split.hard * 100) + ' / ' + Math.round(R.split.soft * 100) + ' / ' + Math.round(R.split.land * 100) + '%' }] },
      { kind: 'group', label: 'COST SUMMARY' },
      { kind: 'kv', rows: [
        kv('Construction hard cost', R.totals.hard, 'money'), kv('FF&E', R.totals.ffe, 'money'),
        kv('Design + construction contingency', R.totals.hardContingency, 'money'),
        kv('Hard cost subtotal', R.totals.hardAll, 'money', true),
        kv('Soft costs', R.totals.soft - R.totals.fees - R.totals.developerFee, 'money'),
        kv('Impact & tap fees', R.totals.fees, 'money'), kv('Developer fee', R.totals.developerFee, 'money'),
        kv('Financing (interest + fees)', R.totals.financing, 'money'), kv('Soft cost contingency', R.totals.softContingency, 'money'),
        kv('Soft cost subtotal', R.totals.softAll, 'money', true),
        kv('Land & acquisition', R.totals.land, 'money', true),
        kv('Total project cost', R.totals.total, 'money', true)] },
      { kind: 'group', label: 'BASIS' },
      { kind: 'kv', rows: [
        kv('Location', R.region.label + ' (factor ' + R.region.factor.toFixed(3) + ')'),
        kv('Gross building SF', R.metrics.sf ? Math.round(R.metrics.sf).toLocaleString('en-US') : '—'),
        kv('Site acres', R.metrics.acres ? R.metrics.acres.toFixed(2) : '—'),
        kv('Cost per acre', R.metrics.perAcre, 'money'),
        kv('Research data version', R.dataVersion || '—'), kv('Engine', R.engineVersion)] },
      { kind: 'note', text: 'All defaults come from the research data shipped with the app (' + (R.dataVersion || '') + '), escalated to the construction midpoint and adjusted to the project location. Values marked "Derived estimate — verify" have no direct published source.' }
    ] });
    sheets.push({ key: 'engine-components', name: 'Components', title: 'Cost by Component', blocks: [
      { kind: 'table', columns: [
        { key: 'name', label: 'Component' }, { key: 'type', label: 'Type' }, { key: 'size', label: 'Size' },
        { key: 'hard', label: 'Hard (incl. FF&E, cont.)', fmt: 'money' }, { key: 'soft', label: 'Soft (incl. fin.)', fmt: 'money' },
        { key: 'land', label: 'Land', fmt: 'money' }, { key: 'total', label: 'Total', fmt: 'money' },
        { key: 'per', label: 'Per primary unit', fmt: 'money' }, { key: 'psf', label: 'Per SF', fmt: 'money2' },
        { key: 'range', label: 'Range check' }],
        rows: R.components.map(function (c) {
          return { name: c.name, type: c.typeName, size: Math.round(c.size * 100) / 100 + ' ' + c.unitLabel,
            hard: c.totals.hardAll, soft: c.totals.softAll, land: c.totals.land, total: c.totals.total,
            per: c.metrics.perPrimaryUnit, psf: c.metrics.perSF,
            range: c.range ? c.range.status + ' ($' + Math.round(c.range.min).toLocaleString('en-US') + '–$' + Math.round(c.range.max).toLocaleString('en-US') + ')' : '—' };
        }),
        totals: { name: 'Total', hard: R.totals.hardAll, soft: R.totals.softAll, land: R.totals.land, total: R.totals.total } }
    ].concat(R.shared.length ? [{ kind: 'group', label: 'SHARED ELEMENTS' }, { kind: 'table', columns: [
      { key: 'name', label: 'Shared element' }, { key: 'method', label: 'Allocation' }, { key: 'amount', label: 'Cost', fmt: 'money' },
      { key: 'shares', label: 'Shares' }],
      rows: R.shared.map(function (s) { return { name: s.name, method: s.method, amount: s.amount,
        shares: s.shares.map(function (x) { var c = R.components.filter(function (y) { return y.id === x.comp; })[0];
          return (c ? c.name : x.comp) + ' ' + fmtMoney(x.amount); }).join('; ') }; }) }] : []) });
    sheets.push({ key: 'engine-phases', name: 'Phases', title: 'Cost by Phase', blocks: [
      { kind: 'table', columns: [
        { key: 'name', label: 'Phase' }, { key: 'start', label: 'Start' }, { key: 'months', label: 'Months', fmt: 'qty' },
        { key: 'mid', label: 'Midpoint' }, { key: 'esc', label: 'Escalation' },
        { key: 'hard', label: 'Hard', fmt: 'money' }, { key: 'soft', label: 'Soft', fmt: 'money' }, { key: 'land', label: 'Land', fmt: 'money' },
        { key: 'total', label: 'Total', fmt: 'money' }, { key: 'loan', label: 'Loan', fmt: 'money' }, { key: 'interest', label: 'Interest', fmt: 'money' }],
        rows: R.phases.map(function (p) { return { name: p.name, start: p.start || '—', months: p.months, mid: p.midpoint || '—',
          esc: (p.escalation.factor * 100 - 100).toFixed(1) + '%', hard: p.totals.hardAll, soft: p.totals.softAll, land: p.totals.land,
          total: p.totals.total, loan: p.financing ? p.financing.loan : 0, interest: p.financing ? p.financing.interest : 0 }; }),
        totals: { name: 'Total', hard: R.totals.hardAll, soft: R.totals.softAll, land: R.totals.land, total: R.totals.total } }
    ] });
    var compName = {};
    R.components.forEach(function (c) { compName[c.id] = c.name; });
    var phaseName = {};
    R.phases.forEach(function (p) { phaseName[p.id] = p.name; });
    sheets.push({ key: 'engine-detail', name: 'Detail', title: 'Line-Item Detail', blocks: [
      { kind: 'table', columns: [
        { key: 'comp', label: 'Component' }, { key: 'phase', label: 'Phase' }, { key: 'group', label: 'Group' },
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Line' }, { key: 'qty', label: 'Qty', fmt: 'qty' },
        { key: 'uom', label: 'Unit' }, { key: 'rate', label: 'Rate', fmt: 'money2' }, { key: 'amount', label: 'Amount', fmt: 'money' },
        { key: 'flag', label: 'Edited' }],
        rows: R.lines.filter(function (l) { return l.amount !== 0 || l.overridden; }).map(function (l) {
          var isPct = /^%/.test(l.uom || '');
          return { comp: compName[l.comp] || 'Project', phase: phaseName[l.phase] || '', group: l.group, code: l.code,
            name: l.name + (l.carveOut ? ' (within baseline)' : ''), qty: l.qty === null ? undefined : (isPct ? Math.round(l.qty * 10000) / 100 : Math.round(l.qty * 100) / 100),
            uom: isPct ? l.uom.replace(/^%/, '%') : unitLabel(D, l.uom), rate: isPct ? undefined : (l.rate === null ? undefined : l.rate),
            amount: l.amount, flag: l.overridden ? 'yes' : '' };
        }),
        totals: { name: 'Total project cost', amount: R.totals.total } }
    ] });
    var drawBlocks = [];
    R.phases.forEach(function (p) {
      if (!p.draws.length) return;
      drawBlocks.push({ kind: 'group', label: p.name.toUpperCase() + ' — MONTHLY DRAWS' });
      drawBlocks.push({ kind: 'table', columns: [
        { key: 'month', label: 'Month' }, { key: 'hard', label: 'Hard', fmt: 'money' }, { key: 'soft', label: 'Soft', fmt: 'money' },
        { key: 'land', label: 'Land', fmt: 'money' }, { key: 'equity', label: 'Equity', fmt: 'money' }, { key: 'loan', label: 'Loan draw', fmt: 'money' },
        { key: 'interest', label: 'Interest', fmt: 'money' }, { key: 'balance', label: 'Loan balance', fmt: 'money' }],
        rows: p.draws.map(function (d) { return { month: d.month || ('M' + d.index), hard: d.hard, soft: d.soft, land: d.land,
          equity: d.equity, loan: d.loan, interest: d.interest, balance: d.balance }; }) });
    });
    if (drawBlocks.length) sheets.push({ key: 'engine-draws', name: 'Draws', title: 'Draw Schedules', blocks: drawBlocks });
    sheets.push({ key: 'engine-sources', name: 'Sources', title: 'Sources & Assumptions', blocks: sourcesBlocks(R, project, D) });
    return sheets;
  }

  function sourcesBlocks(R, project, D) {
    var blocks = [];
    blocks.push({ kind: 'group', label: 'ASSUMPTIONS' });
    var rows = [];
    R.components.forEach(function (c) {
      var t = typeOf(D, c.typeId);
      rows.push({ k: c.name + ' — baseline price', v: fmtMoney(c.baselinePrice) + ' / ' + unitLabel(D, c.unit) + ' · '
        + (c.baselineSource && c.baselineSource.kind === 'user' ? 'user entered' : sourceLabel({ ref: c.baselineSource && c.baselineSource.ref }, D)) });
      rows.push({ k: c.name + ' — factors', v: 'regional ' + r4(c.factors.regional || 1) + ' · quality ' + r4(c.factors.quality || 1)
        + ' · size ' + r4(c.factors.size || 1) + ' · escalation ' + r4(c.factors.escalation || 1) });
      if (t && t.summary) rows.push({ k: c.name + ' — research note', v: t.summary });
    });
    R.phases.forEach(function (p) {
      rows.push({ k: p.name + ' — schedule', v: (p.start || 'no start') + ', ' + p.months + ' months, midpoint ' + (p.midpoint || '—')
        + ', escalation ' + (p.escalation.factor * 100 - 100).toFixed(2) + '% (' + p.escalation.method + ')' });
      if (p.financing && p.financing.enabled) rows.push({ k: p.name + ' — financing', v: 'LTC ' + Math.round(p.financing.ltc * 100)
        + '%, rate ' + (p.financing.rate * 100).toFixed(2) + '%, fee ' + (p.financing.feePct * 100).toFixed(2) + '%' });
    });
    blocks.push({ kind: 'kv', rows: rows.length ? rows : [{ k: 'No components', v: '—' }] });
    // Every evidence item behind the lines on this budget.
    var refs = {};
    var collect = function (src) {
      if (!src || typeof src !== 'object') return;
      if (src.evidence) src.evidence.forEach(function (e) { refs[e] = true; });
      ['ref', 'was', 'of', 'typePct', 'weight', 'baseline', 'rate', 'ltc', 'fee'].forEach(function (k) { collect(src[k]); });
    };
    R.lines.forEach(function (l) { collect(l.source); });
    R.components.forEach(function (c) { collect(c.baselineSource); });
    var ev = Object.keys(refs).sort().map(function (k) { return D.evidence && D.evidence[k]; }).filter(Boolean);
    blocks.push({ kind: 'group', label: 'SOURCES (' + ev.length + ')' });
    if (ev.length) blocks.push({ kind: 'table', columns: [
      { key: 'id', label: 'Ref' }, { key: 'title', label: 'Source' }, { key: 'publisher', label: 'Publisher' },
      { key: 'value', label: 'Value' }, { key: 'conf', label: 'Confidence' }, { key: 'url', label: 'URL' }],
      rows: ev.map(function (e) {
        var v = e.raw.value !== null ? e.raw.value : [e.raw.low, e.raw.high].filter(function (x) { return x !== null; }).join('–');
        return { id: e.id, title: e.title, publisher: e.publisher, value: v + ' ' + e.unit + (e.raw.year ? ' (' + e.raw.year + ')' : ''),
          conf: e.confidence, url: e.url };
      }) });
    else blocks.push({ kind: 'note', text: 'No sourced evidence is attached to these lines — every default used is a derived estimate.' });
    return blocks;
  }

  return {
    ENGINE_VERSION: ENGINE_VERSION, QUALITY_TIERS: QUALITY_TIERS, ALLOCATION_METHODS: ALLOCATION_METHODS, DRAW_CURVES: DRAW_CURVES,
    newProject: newProject, newComponent: newComponent, newPhase: newPhase,
    calculate: calculate, compareScenarios: compareScenarios, sensitivity: sensitivity, applyScenario: applyScenario,
    toBudgetDoc: toBudgetDoc, summaryOf: summaryOf, toFsdocSheets: toFsdocSheets, sourceLabel: sourceLabel,
    // exposed for tests and the UI
    _: { allocateCents: allocateCents, escalation: escalation, regionInfo: regionInfo, geometry: geometry,
      curveWeights: curveWeights, financePhase: financePhase, qualityFactor: qualityFactor, sizeFactor: sizeFactor,
      csiTitle: csiTitle, unitLabel: unitLabel, typeOf: typeOf, addMonths: addMonths }
  };
});
