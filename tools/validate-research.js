#!/usr/bin/env node
// Schema check for the research data files (data/research/README.md).
//
//   node tools/validate-research.js                 # every file
//   node tools/validate-research.js <file> [file…]  # just these
//
// Exit code 1 when any file has an error. Warnings never fail the run.
// It checks shape and provenance — that every money/percent range names its
// evidence or says it is derived and how — not whether a number is right.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'data', 'research');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
const UNITS = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'units.json'), 'utf8')).units.map(u => u.id));
const TYPES = new Map(catalog.types.map(t => [t.id, t]));
const DIVISIONS = new Set(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14',
  '21', '22', '23', '25', '26', '27', '28', '31', '32', '33', '34', '35', '40', '41', '42', '43', '44', '45', '46', '48']);
const CONF = new Set(['high', 'medium', 'low']);
const QTY_PER = new Set(['project', 'primaryUnit', 'sf', 'acre', ...UNITS]);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

function check(file) {
  const errors = [], warnings = [];
  const E = (p, m) => errors.push(p + ': ' + m);
  const W = (p, m) => warnings.push(p + ': ' + m);
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { errors: ['parse: ' + e.message], warnings }; }

  const evidenceIds = new Set();
  (doc.evidence || []).forEach((ev, i) => {
    const p = 'evidence[' + i + ']';
    if (!ev.id) E(p, 'missing id');
    else if (evidenceIds.has(ev.id)) E(p, 'duplicate id ' + ev.id);
    else evidenceIds.add(ev.id);
    if (!ev.metric) E(p, 'missing metric');
    if (!isNum(ev.value) && !(isNum(ev.low) || isNum(ev.high)) && ev.unit !== 'text') E(p, 'needs value or low/high');
    if (!ev.unit) E(p, 'missing unit');
    const s = ev.source || {};
    if (!s.title || !s.publisher || !s.accessed) E(p, 'source needs title, publisher, accessed');
    if (!s.url || !/^https?:\/\//.test(s.url)) E(p, 'source.url must be an http(s) URL');
    if (!ev.quote) E(p, 'missing quote / table reference');
    if (!CONF.has(ev.confidence)) E(p, 'confidence must be high|medium|low');
    if (/^USD/.test(ev.unit || '')) {
      if (!isNum(ev.dataYear)) E(p, 'money evidence needs dataYear');
      if (!ev.regionKey) E(p, 'money evidence needs regionKey');
    }
  });

  const refOk = id => typeof id === 'string' && (evidenceIds.has(id) || /^[\w\-/]+\.json#[\w\-]+$/.test(id) || /^[\w\-]+#[\w\-]+$/.test(id));
  function range(p, r, money, required) {
    if (r === undefined || r === null) { if (required) E(p, 'missing'); return; }
    ['low', 'mid', 'high'].forEach(k => { if (!isNum(r[k])) E(p, k + ' must be a number'); });
    if (isNum(r.low) && isNum(r.mid) && isNum(r.high) && !(r.low <= r.mid && r.mid <= r.high)) E(p, 'needs low <= mid <= high');
    if (money) {
      if (!isNum(r.dollarYear)) E(p, 'money range needs dollarYear');
      if (!r.region) E(p, 'money range needs region');
    }
    if (!Array.isArray(r.evidence)) E(p, 'evidence must be an array');
    else r.evidence.forEach(id => { if (!refOk(id)) E(p, 'unknown evidence id ' + id); });
    if (typeof r.derived !== 'boolean') E(p, 'derived must be true/false');
    if (r.derived && !r.method) E(p, 'derived values need a method');
    if (!r.derived && Array.isArray(r.evidence) && r.evidence.length === 0) E(p, 'not derived but cites no evidence');
  }

  const rel = path.relative(ROOT, file).split(path.sep);
  if (rel[0] === '_blocks') {
    if (!doc.id || !Array.isArray(doc.items)) E('file', 'block file needs id and items[]');
    (doc.items || []).forEach((it, i) => {
      const p = 'items[' + i + ']';
      if (!it.id || !it.name) E(p, 'needs id and name');
      if (!UNITS.has(it.unit)) E(p, 'unknown unit ' + it.unit);
      if (it.division && !DIVISIONS.has(it.division)) E(p, 'unknown division ' + it.division);
      range(p + '.cost', it.cost, it.unit !== 'pct', true);
    });
    return { errors, warnings };
  }
  if (rel[0] === '_indices' || rel[0] === '_common') {
    if (!Array.isArray(doc.evidence)) W('file', 'no evidence[]');
    return { errors, warnings };
  }

  // ---- project type file
  const t = TYPES.get(doc.id);
  if (!t) E('id', 'not in catalog.json: ' + doc.id);
  else {
    if (rel[0] !== t.category) E('file', 'belongs in data/research/' + t.category + '/');
    if (doc.primaryUnit !== t.primaryUnit) E('primaryUnit', 'catalog says ' + t.primaryUnit);
  }
  if (doc.schemaVersion !== 1) E('schemaVersion', 'must be 1');
  if (!doc.summary) W('summary', 'missing');

  const s = doc.sizing || {};
  range('sizing.typicalSize', s.typicalSize, false, true);
  ['sfPerPrimaryUnit', 'primaryUnitsPerAcre', 'parkingPerPrimaryUnit'].forEach(k => range('sizing.' + k, s[k], false, false));
  if (doc.primaryUnit !== 'sf' && doc.primaryUnit !== 'nrsf' && !s.sfPerPrimaryUnit && !['mw', 'mwh', 'acre', 'ls'].includes(doc.primaryUnit))
    W('sizing.sfPerPrimaryUnit', 'missing — $/SF cannot be reported');

  const h = doc.hardCost || {};
  range('hardCost.perPrimaryUnit', h.perPrimaryUnit, true, true);
  range('hardCost.perSF', h.perSF, true, false);
  if (!h.scope || typeof h.scope.includesSitework !== 'boolean') E('hardCost.scope', 'needs includesSitework etc.');

  if (doc.qualityTiers) ['economy', 'standard', 'premium', 'luxury'].forEach(k => {
    if (!isNum(doc.qualityTiers[k])) E('qualityTiers.' + k, 'must be a number');
  });

  const sp = doc.systemSplit;
  if (!sp || !Array.isArray(sp.lines) || !sp.lines.length) E('systemSplit', 'missing lines');
  else {
    let sum = 0; const seen = new Set();
    sp.lines.forEach((l, i) => {
      if (!DIVISIONS.has(l.division)) E('systemSplit.lines[' + i + ']', 'unknown division ' + l.division);
      if (seen.has(l.division)) E('systemSplit.lines[' + i + ']', 'duplicate division ' + l.division);
      seen.add(l.division);
      if (!isNum(l.pct) || l.pct < 0) E('systemSplit.lines[' + i + ']', 'pct must be >= 0');
      sum += l.pct || 0;
    });
    if (Math.abs(sum - 1) > 0.0005) E('systemSplit', 'must sum to 1.000 (is ' + sum.toFixed(4) + ')');
    if (typeof sp.derived !== 'boolean') E('systemSplit.derived', 'must be true/false');
    if (sp.derived && !sp.method) E('systemSplit', 'derived split needs a method');
  }

  const ids = new Set();
  (doc.lineItems || []).forEach((li, i) => {
    const p = 'lineItems[' + i + ']';
    if (!li.id || !li.name) E(p, 'needs id and name');
    if (ids.has(li.id)) E(p, 'duplicate id ' + li.id);
    ids.add(li.id);
    if (!DIVISIONS.has(li.division)) E(p, 'unknown division ' + li.division);
    if (!UNITS.has(li.unit)) E(p, 'unknown unit ' + li.unit);
    if (!li.qty || !QTY_PER.has(li.qty.per) || !isNum(li.qty.value)) E(p, 'qty needs per (project|primaryUnit|sf|acre|<unit>) and value');
    range(p + '.cost', li.cost, true, true);
    ['inBaseline', 'scales', 'optional'].forEach(k => { if (typeof li[k] !== 'boolean') E(p + '.' + k, 'must be true/false'); });
  });

  if (doc.ffe) range('ffe.perPrimaryUnit', doc.ffe.perPrimaryUnit, true, false);
  range('softCosts.pctOfHard', (doc.softCosts || {}).pctOfHard, false, true);
  const c = doc.contingency || {};
  ['design', 'hard', 'soft'].forEach(k => range('contingency.' + k, c[k], false, true));
  const rc = (doc.rangeCheck || {}).perPrimaryUnit;
  if (!rc || !isNum(rc.min) || !isNum(rc.max) || !(rc.min < rc.max)) E('rangeCheck.perPrimaryUnit', 'needs min < max');
  else if (!isNum(rc.dollarYear) || !rc.region) E('rangeCheck.perPrimaryUnit', 'needs dollarYear and region');

  const sourced = (doc.evidence || []).length;
  if (!sourced) W('evidence', 'no sourced evidence at all — every value is derived');
  return { errors, warnings };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return d.name.endsWith('.json') && !['catalog.json', 'units.json'].includes(d.name) ? [p] : [];
  });
}

if (require.main === module) {
  const files = process.argv.length > 2 ? process.argv.slice(2).map(f => path.resolve(f)) : walk(ROOT);
  let bad = 0;
  for (const f of files) {
    const { errors, warnings } = check(f);
    const name = path.relative(process.cwd(), f);
    if (errors.length) { bad++; console.log('✖ ' + name); errors.forEach(e => console.log('    error  ' + e)); }
    else console.log('✔ ' + name);
    warnings.forEach(w => console.log('    warn   ' + w));
  }
  if (process.argv.length === 2) {
    const have = new Set(files.map(f => path.basename(f, '.json')));
    const missing = catalog.types.filter(t => !have.has(t.id)).map(t => t.id);
    if (missing.length) console.log('\nmissing type files (' + missing.length + '): ' + missing.join(', '));
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { check };
