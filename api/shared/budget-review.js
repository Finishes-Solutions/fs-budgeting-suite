// Budget review for the Budget Assistant: where a budget is possibly wrong,
// and what it might be missing — found by rules, so the assistant reasons from
// evidence rather than impressions.
//
// Pure. Every dollar figure comes from api/shared/budget-calc.js; the inputs
// are the budget document, the current pricing library and (optionally) other
// budgets the user can see, for benchmarking against their own portfolio.
//
// Each finding says what KIND of evidence it is:
//   'fact'       the document literally says this ($0 line, stale pricing…)
//   'library'    compared with the current published pricing library
//   'portfolio'  compared with the median of the user's other budgets
//   'heuristic'  a common development-budget checklist item not found by
//                keyword — possibly covered under another name
const calc = require('./budget-calc');

const r2 = n => Math.round(calc.nz(n) * 100) / 100;
const key = l => (l.scope || 'res') + '|' + String(l.code || '').trim();
const LIMIT = 15;

// Common development-budget items a multifamily pro forma is often missing.
// Matched by keyword against line descriptions and groups, case-insensitive.
const CHECKLIST = [
  { id: 'constructionInterest', label: 'Construction loan interest / interest reserve', rx: /interest|carry|interest reserve/i },
  { id: 'loanFees', label: 'Construction / perm loan fees and lender costs', rx: /loan fee|origination|lender|financing|points/i },
  { id: 'buildersRisk', label: "Builder's risk insurance", rx: /builder'?s? risk|course of construction/i },
  { id: 'constructionTaxes', label: 'Property taxes during construction', rx: /property tax|real estate tax|ad valorem/i },
  { id: 'legalTitle', label: 'Legal, title and closing (beyond the closing-cost fee)', rx: /legal|attorney|title|escrow/i },
  { id: 'ffe', label: 'FF&E for leasing office / model units', rx: /ff&?e|furniture|furnish|model unit/i },
  { id: 'leaseUp', label: 'Lease-up / operating deficit reserve', rx: /lease-?up|operating (deficit|reserve)|reserve/i },
  { id: 'softContingency', label: 'Soft-cost contingency', rx: /soft.*contingency|contingency.*soft/i },
  { id: 'bonds', label: 'Payment & performance bonds', rx: /\bbond/i },
  { id: 'utilitiesDuringConstruction', label: 'Utilities / temporary power during construction', rx: /temporary|temp power|utilities during/i }
];

function median(a) {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function perSF(doc) { return calc.nz(doc.resSF) + calc.nz(doc.amenSF); }

function reviewBudget(doc, ctx) {
  doc = doc || {}; ctx = ctx || {};
  const findings = [];
  let benchmarks = null;
  const add = (kind, severity, area, finding, extra) => findings.push(Object.assign({ kind, severity, area, finding }, extra || {}));
  const lines = doc.lines || [];
  const p = calc.parts(doc), g = calc.grossIncome(doc), tu = calc.totUnits(doc), sf = perSF(doc);

  /* ---- facts in the document ---- */
  lines.forEach(l => {
    if (!calc.scopeActive(doc, l.scope)) return;
    const total = calc.lineQty(doc, l) * calc.nz(l.unit);
    if (total === 0) add('fact', 'warn', 'lines', 'Priced at $0: ' + (l.code || '') + ' ' + (l.desc || ''),
      { code: l.code || null, reason: calc.nz(l.unit) === 0 ? 'rate is $0' : 'quantity is 0' });
  });
  const amenLines = lines.filter(l => l.scope === 'amen');
  if (amenLines.length && !calc.scopeActive(doc, 'amen'))
    add('fact', 'warn', 'amenity', amenLines.length + ' amenity lines are suppressed because amenity SF is 0 — '
      + 'they contribute $0. Enter the clubhouse SF if the project has one.');
  const sc20 = lines.find(l => l.scope === 'soft' && String(l.code).trim() === 'SC-20');
  if (sc20 && !sc20.derived && sc20.basis === 'sf')
    add('fact', 'warn', 'impactFees', 'Impact & tap fees are still the parametric $' + calc.nz(sc20.unit).toFixed(2)
      + '/SF placeholder (' + '$' + Math.round(calc.lineQty(doc, sc20) * calc.nz(sc20.unit)).toLocaleString('en-US')
      + ') — pick a jurisdiction on the Impact Fees step to price the real number.');
  const pc = doc.projectCosts || {};
  if (!(calc.nz(pc.land) > 0)) add('fact', 'warn', 'projectCosts', 'Land is $0.');
  ['dev', 'mkt', 'cls'].forEach(k => {
    if (!(calc.feeVal(pc[k]) > 0)) add('fact', 'info', 'projectCosts',
      ({ dev: 'Developer fee', mkt: 'Marketing / brokerage', cls: 'Closing costs' })[k] + ' is $0.');
  });
  if (!(p.cont > 0)) add('fact', 'warn', 'contingency', 'Construction contingency is $0.');
  if (!(doc.companies || []).some(c => calc.nz(c.pct) > 0)) add('fact', 'info', 'profit', 'No GC profit / fee is carried.');
  (doc.units || []).forEach(u => {
    if (calc.nz(u.count) > 0 && !(calc.nz(u.rent) > 0)) add('fact', 'warn', 'units', 'Unit type "' + (u.label || '?') + '" has no rent.');
    if (calc.nz(u.count) > 0 && !(calc.nz(u.sf) > 0)) add('fact', 'warn', 'units', 'Unit type "' + (u.label || '?') + '" has no SF.');
  });
  const rentable = (doc.units || []).reduce((s, u) => s + calc.nz(u.sf) * calc.nz(u.count), 0);
  if (calc.nz(doc.resSF) > 0 && rentable > 0) {
    const eff = rentable / calc.nz(doc.resSF);
    if (eff > 0.95 || eff < 0.7) add('fact', 'warn', 'units', 'Leasable unit SF is ' + (eff * 100).toFixed(1)
      + '% of residential SF (70–95% is typical) — the unit mix or the building SF is probably off.');
  }
  (doc.expenses || []).forEach(e => { if (!(calc.nz(e.rate) > 0)) add('fact', 'info', 'expenses', 'Expense row "' + (e.label || '?') + '" is $0.'); });
  (doc.other || []).forEach(o => { if (!(calc.nz(o.rate) > 0)) add('fact', 'info', 'otherIncome', 'Other-income row "' + (o.label || '?') + '" is $0.'); });
  if (tu > 0 && g.rentMo > 0 && g.otherMo / g.rentMo < 0.03)
    add('fact', 'info', 'otherIncome', 'Other income is ' + (100 * g.otherMo / g.rentMo).toFixed(1)
      + '% of rent — ancillary income is often 5–10% of rent in new multifamily.');

  /* ---- against the pricing library ---- */
  const lib = ctx.library && Array.isArray(ctx.library.lines) ? ctx.library : null;
  if (lib) {
    if (doc.pricingVersion && lib.version && doc.pricingVersion !== lib.version)
      add('library', 'info', 'pricing', 'Budget is priced on library ' + doc.pricingVersion + '; current is ' + lib.version
        + '. Update Pricing would move matched lines to current rates (and replace manual rates).');
    const have = new Set(lines.map(key));
    const libByKey = new Map(lib.lines.map(l => [key(l), l]));
    const missing = lib.lines.filter(l => !have.has(key(l)) && calc.scopeActive(doc, l.scope))
      .map(l => {
        const est = calc.lineQty(doc, Object.assign({}, l, { auto: l.basis !== 'ls' })) * calc.nz(l.unit);
        return { scope: l.scope, group: l.grp, code: l.code, description: l.desc, libraryRate: l.unit,
          basis: l.basis, estimatedCostAtLibraryRate: r2(est) };
      })
      .sort((a, z) => z.estimatedCostAtLibraryRate - a.estimatedCostAtLibraryRate);
    if (missing.length) add('library', 'warn', 'scope', missing.length + ' current-library line(s) are not in this budget'
      + ' (by scope + CSI code). Either deliberately excluded or missing scope.',
      { lines: missing.slice(0, LIMIT), estimatedTotal: r2(missing.reduce((s, m) => s + m.estimatedCostAtLibraryRate, 0)) });
    const drift = lines.map(l => {
      const m = libByKey.get(key(l));
      // Only like with like: a per-unit rate against a per-SF library rate is
      // not a deviation, it is a different measure.
      if (!m || l.derived || l.basis !== m.basis || !(calc.nz(m.unit) > 0) || !(calc.nz(l.unit) > 0)) return null;   // $0 lines are reported above
      const ratio = calc.nz(l.unit) / calc.nz(m.unit) - 1;
      if (Math.abs(ratio) < 0.15) return null;
      return { code: l.code, description: l.desc, rate: calc.nz(l.unit), libraryRate: m.unit, pctFromLibrary: Math.round(ratio * 1000) / 10,
        dollarEffect: r2(calc.lineQty(doc, l) * (calc.nz(l.unit) - calc.nz(m.unit))) };
    }).filter(Boolean).sort((a, z) => Math.abs(z.dollarEffect) - Math.abs(a.dollarEffect));
    if (drift.length) add('library', 'info', 'rates', drift.length + ' line rate(s) differ from the current library by 15% or more.',
      { lines: drift.slice(0, LIMIT) });
  }

  /* ---- against the user's own portfolio ---- */
  const peers = (ctx.benchmarks || []).filter(b => b && b.doc && perSF(b.doc) > 0);
  if (peers.length >= 3 && sf > 0) {
    const metric = (d, f) => { const s = perSF(d); return s > 0 ? f(d, calc.parts(d)) / s : NaN; };
    const series = {
      hardPerSF: d => metric(d, (x, q) => q.hard),
      softPerSF: d => metric(d, (x, q) => q.soft),
      contractPerSF: d => metric(d, (x, q) => q.contract),
      projectPerSF: d => metric(d, (x, q) => q.project)
    };
    const bench = {};
    Object.entries(series).forEach(([k, f]) => {
      const med = median(peers.map(b => f(b.doc)));
      const mine = f(doc);
      bench[k] = { thisBudget: r2(mine), portfolioMedian: r2(med), peers: peers.length };
      if (Number.isFinite(med) && med > 0 && Math.abs(mine / med - 1) > 0.25)
        add('portfolio', 'warn', 'benchmark', k + ' is ' + r2(mine) + ' vs a median of ' + r2(med)
          + ' across ' + peers.length + ' of your other budgets (' + (mine > med ? '+' : '') + Math.round((mine / med - 1) * 100) + '%).');
    });
    // Group-level $/building SF, where at least three peers carry the group.
    const groupPSF = d => {
      const s = perSF(d), out = {};
      (d.lines || []).forEach(l => {
        if (!calc.scopeActive(d, l.scope)) return;
        const k = (l.scope || 'res') + ' · ' + (l.grp || 'General');
        out[k] = (out[k] || 0) + calc.lineQty(d, l) * calc.nz(l.unit) / s;
      });
      return out;
    };
    const mineG = groupPSF(doc), peerG = peers.map(b => groupPSF(b.doc));
    const groups = Object.keys(mineG).map(k => {
      const vals = peerG.map(x => x[k]).filter(v => v !== undefined);
      const med = median(vals);
      if (vals.length < 3 || !(med > 0)) return null;
      const dev = mineG[k] / med - 1;
      return Math.abs(dev) > 0.3 ? { group: k, thisBudgetPerSF: r2(mineG[k]), portfolioMedianPerSF: r2(med),
        peers: vals.length, pctFromMedian: Math.round(dev * 100), dollarEffect: r2((mineG[k] - med) * sf) } : null;
    }).filter(Boolean).sort((a, z) => Math.abs(z.dollarEffect) - Math.abs(a.dollarEffect));
    if (groups.length) add('portfolio', 'info', 'benchmark', groups.length + ' group(s) are 30%+ off your portfolio median $/SF.',
      { groups: groups.slice(0, LIMIT) });
    benchmarks = bench;
  }

  /* ---- development checklist ---- */
  const text = lines.map(l => (l.desc || '') + ' ' + (l.grp || '')).join(' \n ');
  const absent = CHECKLIST.filter(c => !c.rx.test(text));
  if (absent.length) add('heuristic', 'info', 'checklist', 'Not found by keyword in any line (may be covered under another name, '
    + 'in the GC general conditions, or deliberately outside this budget): ' + absent.map(c => c.label).join('; ') + '.',
    { items: absent.map(c => c.id) });

  const order = { error: 0, warn: 1, info: 2 };
  return {
    summary: { findings: findings.length, warnings: findings.filter(f => f.severity !== 'info').length },
    benchmarks,
    findings: findings.sort((a, z) => order[a.severity] - order[z.severity])
  };
}

module.exports = { reviewBudget, CHECKLIST };
