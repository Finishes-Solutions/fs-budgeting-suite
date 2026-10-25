#!/usr/bin/env node
// Compile data/research/** into app/research-data.js — the only research the
// app ships. The app never fetches research at runtime.
//
//   node tools/build-research-data.js           # validate, normalize, write
//   node tools/build-research-data.js --check   # exit 1 if app/research-data.js is stale
//
// Normalization (docs/BUDGET_ENGINE.md §1), applied to every money value:
//   normalized = value × series[baseYear] / series[dollarYear] ÷ factor(region)
// with the escalation series from _indices/escalation.json and the regional
// factors from _indices/regional.json (metro → state → US). Percentages and
// ratios are never normalized. Output is deterministic (no timestamps), so the
// freshness test can compare bytes.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { check, walk: walkAll } = require('./validate-research');
const { FEE_USES } = require('../app/budget-engine.js');

const ROOT = path.join(__dirname, '..', 'data', 'research');
const OUT = path.join(__dirname, '..', 'app', 'research-data.js');
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = p => fs.existsSync(p);

const r2 = x => Math.round(x * 100) / 100;
const r4 = x => Math.round(x * 10000) / 10000;

function loadIndices() {
  const escP = path.join(ROOT, '_indices', 'escalation.json');
  const regP = path.join(ROOT, '_indices', 'regional.json');
  const esc = exists(escP) ? readJson(escP) : null;
  const reg = exists(regP) ? readJson(regP) : null;
  return { esc, reg };
}

function makeNormalizer(catalog, esc, reg) {
  const baseYear = catalog.baseYear;
  const series = (esc && esc.series) || {};
  const factors = (reg && reg.factors) || { US: 1 };
  const years = Object.keys(series).map(Number).sort((a, b) => a - b);
  function idx(y) {
    if (series[String(y)] !== undefined) return +series[String(y)];
    if (!years.length) return null;
    // Outside the series: clamp to the nearest year we have (and say so).
    const near = y < years[0] ? years[0] : years[years.length - 1];
    return +series[String(near)];
  }
  function escalate(year) {
    if (!Number.isFinite(+year) || !years.length) return 1;
    const a = idx(+year), b = idx(baseYear);
    return a && b ? b / a : 1;
  }
  function regionKeyOf(region) {
    if (!region) return 'US';
    const s = String(region).trim();
    if (factors[s] !== undefined) return s;
    if (/^(US|USA|national|U\.S\.)/i.test(s)) return 'US';
    const st = s.match(/^([A-Z]{2})(-|$)/);
    if (st && factors[st[1]] !== undefined) return st[1];
    return null;
  }
  function regional(region) {
    const k = regionKeyOf(region);
    if (k === null) return { factor: 1, key: 'US', unknown: true };
    return { factor: +factors[k] || 1, key: k };
  }
  return {
    baseYear,
    factor(year, region) {
      const e = escalate(year), g = regional(region);
      return { factor: e / g.factor, escalation: e, regional: g.factor, regionKey: g.key, unknownRegion: !!g.unknown };
    }
  };
}

// A money range → normalized {low, mid, high} plus provenance.
function money(range, N, file, warn) {
  if (!range) return null;
  const f = N.factor(range.dollarYear, range.region);
  if (f.unknownRegion) warn(file + ': unknown region "' + range.region + '" treated as national');
  const out = { low: r2(range.low * f.factor), mid: r2(range.mid * f.factor), high: r2(range.high * f.factor) };
  out.source = provenance(range, file);
  out.source.normalization = { dollarYear: range.dollarYear, region: range.region,
    escalation: r4(f.escalation), regional: r4(f.regional) };
  return out;
}
function pct(range, file) {
  if (!range) return null;
  return { low: range.low, mid: range.mid, high: range.high, source: provenance(range, file) };
}
function provenance(range, file) {
  const refs = (range.evidence || []).map(id => id.includes('#') ? id : file + '#' + id);
  return { file, evidence: refs, derived: !!range.derived, method: range.method || '' };
}

function build() {
  const catalog = readJson(path.join(ROOT, 'catalog.json'));
  const units = readJson(path.join(ROOT, 'units.json'));
  const { esc, reg } = loadIndices();
  const N = makeNormalizer(catalog, esc, reg);
  const warnings = [], errors = [];
  const warn = m => warnings.push(m);

  const bundle = {
    schemaVersion: 1,
    baseYear: catalog.baseYear,
    categories: catalog.categories,
    units: units.units,
    indices: {
      escalation: esc ? { seriesName: esc.seriesName || esc.name || '', series: esc.series, forecast: esc.forecast || {},
        method: esc.method || '', file: '_indices/escalation.json' } : null,
      regional: reg ? { factors: reg.factors, labels: reg.labels || {}, method: reg.method || '',
        file: '_indices/regional.json' } : null
    },
    common: {},
    blocks: {},
    types: {},
    evidence: {}
  };
  if (!esc) warn('_indices/escalation.json missing — dollars are NOT escalated');
  if (!reg) warn('_indices/regional.json missing — dollars are NOT regionalized');

  const files = walkAll(ROOT);
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const v = check(abs);
    if (v.errors.length) { errors.push(rel + ':\n    ' + v.errors.join('\n    ')); continue; }
    const doc = readJson(abs);

    // Evidence → the shared evidence table, normalized where it is money.
    (doc.evidence || []).forEach(ev => {
      const key = rel + '#' + ev.id;
      const e = { id: key, metric: ev.metric, unit: ev.unit, confidence: ev.confidence,
        title: ev.source.title, url: ev.source.url, publisher: ev.source.publisher, accessed: ev.source.accessed,
        quote: ev.quote, scopeNotes: ev.scopeNotes || '',
        raw: { value: ev.value === undefined ? null : ev.value, low: ev.low === undefined ? null : ev.low,
               high: ev.high === undefined ? null : ev.high, region: ev.region || ev.regionKey || '', year: ev.dataYear || null } };
      if (/^USD/.test(ev.unit || '') && ev.dataYear) {
        const f = N.factor(ev.dataYear, ev.regionKey);
        const n = x => (Number.isFinite(x) ? r2(x * f.factor) : null);
        e.normalized = { value: n(ev.value), low: n(ev.low), high: n(ev.high), factor: r4(f.factor) };
      }
      bundle.evidence[key] = e;
    });

    const top = rel.split('/')[0];
    if (top === '_indices') continue;
    if (top === '_common') {
      const items = {};
      (doc.items || []).forEach(it => {
        const r = it.range || it.value || null;
        const isMoney = r && r.dollarYear !== undefined;
        items[it.id] = { id: it.id, name: it.name, basis: it.basis || '', notes: it.notes || '',
          range: r ? (isMoney ? money(r, N, rel, warn) : pct(r, rel)) : null,
          extra: it.extra || it.table || undefined };
      });
      bundle.common[doc.id || path.basename(abs, '.json')] = { name: doc.name || '', file: rel, items,
        method: doc.method || '' };
      continue;
    }
    if (top === '_blocks') {
      (doc.items || []).forEach(it => {
        if (bundle.blocks[it.id]) { errors.push(rel + ': duplicate block item id ' + it.id); return; }
        bundle.blocks[it.id] = { id: it.id, name: it.name, block: doc.id, blockName: doc.name || doc.id,
          division: it.division || null, unit: it.unit, notes: it.notes || '',
          cost: it.unit === 'pct' ? pct(it.cost, rel) : money(it.cost, N, rel, warn) };
      });
      continue;
    }

    // Project type.
    const cat = catalog.types.find(t => t.id === doc.id);
    const s = doc.sizing || {};
    const sz = k => (s[k] ? { low: s[k].low, mid: s[k].mid, high: s[k].high, source: provenance(s[k], rel),
      type: s[k].type || undefined } : null);
    const h = doc.hardCost || {};
    const rc = (doc.rangeCheck || {}).perPrimaryUnit;
    let range = null;
    if (rc) {
      const f = N.factor(rc.dollarYear, rc.region);
      range = { min: r2(rc.min * f.factor), max: r2(rc.max * f.factor), method: rc.method || '' };
    }
    const qt = doc.qualityTiers;
    bundle.types[doc.id] = {
      id: doc.id, name: cat.name, category: cat.category, description: cat.description,
      primaryUnit: cat.primaryUnit, altUnits: cat.altUnits, file: rel, summary: doc.summary || '',
      researchedAt: doc.researchedAt || null,
      sizing: { typicalSize: sz('typicalSize'), sfPerPrimaryUnit: sz('sfPerPrimaryUnit'),
        primaryUnitsPerAcre: sz('primaryUnitsPerAcre'), parkingPerPrimaryUnit: sz('parkingPerPrimaryUnit') },
      hardCost: { perPrimaryUnit: money(h.perPrimaryUnit, N, rel, warn), perSF: money(h.perSF, N, rel, warn),
        scope: h.scope || {} },
      qualityTiers: qt ? { economy: qt.economy, standard: qt.standard, premium: qt.premium, luxury: qt.luxury,
        source: provenance(qt, rel) } : null,
      systemSplit: { lines: doc.systemSplit.lines.map(l => ({ division: l.division, pct: l.pct, note: l.note || '' })),
        source: provenance(doc.systemSplit, rel) },
      lineItems: (doc.lineItems || []).map(li => ({ id: li.id, name: li.name, division: li.division,
        block: li.block || null, unit: li.unit, qty: li.qty, cost: money(li.cost, N, rel, warn),
        inBaseline: li.inBaseline, scales: li.scales, optional: li.optional, notes: li.notes || '' })),
      ffe: doc.ffe && doc.ffe.perPrimaryUnit ? { perPrimaryUnit: money(doc.ffe.perPrimaryUnit, N, rel, warn) } : null,
      softCosts: { pctOfHard: pct(doc.softCosts.pctOfHard, rel), developerFee: pct(doc.softCosts.developerFee, rel), breakdown: doc.softCosts.breakdown || null,
        notes: doc.softCosts.notes || '' },
      contingency: { design: pct(doc.contingency.design, rel), hard: pct(doc.contingency.hard, rel),
        soft: pct(doc.contingency.soft, rel) },
      rangeCheck: range,
      template: Object.assign({}, cat.template || {}, doc.template || {}),
      evidenceCount: (doc.evidence || []).length,
      openQuestions: doc.openQuestions || []
    };
  }

  // Template switches the engine acts on must name things that exist: a typo
  // would otherwise price fees at $0 or fall back to a default duration silently.
  const durations = new Set(Object.keys((bundle.common.schedule || {}).items || {}).filter(k => /^duration-/.test(k)).map(k => k.slice(9)));
  Object.values(bundle.types).forEach(t => {
    const tp = t.template || {};
    if (tp.feeUse && tp.feeUse !== 'none' && !FEE_USES[tp.feeUse]) errors.push(t.id + ': template.feeUse "' + tp.feeUse + '" is not a fee land use');
    if (tp.durationClass && !durations.has(tp.durationClass)) errors.push(t.id + ': template.durationClass "' + tp.durationClass + '" has no _common/schedule entry');
  });

  // Every catalog type must have a research file before the bundle ships.
  const missing = catalog.types.filter(t => !bundle.types[t.id]).map(t => t.id);
  bundle.missingTypes = missing;
  const body = JSON.stringify(bundle);
  bundle.version = catalog.baseYear + '.' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 10);
  return { bundle, warnings, errors, missing };
}

function render(bundle) {
  return '/* GENERATED by tools/build-research-data.js from data/research/** — do not edit by hand.\n'
    + '   The app ships this research; it never fetches research at runtime.\n'
    + '   Rebuild: node tools/build-research-data.js */\n'
    + '(function (root, factory) {\n'
    + '  if (typeof module === \'object\' && module.exports) module.exports = factory();\n'
    + '  else root.FSResearchData = factory();\n'
    + '})(typeof self !== \'undefined\' ? self : this, function () {\n'
    + '  \'use strict\';\n'
    + '  return ' + JSON.stringify(bundle) + ';\n'
    + '});\n';
}

if (require.main === module) {
  const { bundle, warnings, errors, missing } = build();
  warnings.forEach(w => console.log('warn  ' + w));
  if (errors.length) { errors.forEach(e => console.log('error ' + e)); }
  if (missing.length) console.log('missing type files (' + missing.length + '): ' + missing.join(', '));
  const out = render(bundle);
  if (process.argv.includes('--check')) {
    const cur = exists(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== out) { console.log('app/research-data.js is STALE — run node tools/build-research-data.js'); process.exit(1); }
    console.log('app/research-data.js is current (' + bundle.version + ')');
    process.exit(errors.length ? 1 : 0);
  }
  if (errors.length && !process.argv.includes('--force')) { console.log('not written: fix the errors above (or --force)'); process.exit(1); }
  fs.writeFileSync(OUT, out);
  console.log('wrote app/research-data.js — ' + Object.keys(bundle.types).length + ' types, '
    + Object.keys(bundle.blocks).length + ' block items, ' + Object.keys(bundle.evidence).length
    + ' evidence items, version ' + bundle.version);
}

module.exports = { build, render, makeNormalizer };
