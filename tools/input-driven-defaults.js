// The JavaScript mirror of sql/publish_multifamily_input_defaults.sql.
//
// The SQL is what a database admin runs against the one production database;
// nothing in the test harness can execute T-SQL. This module performs the SAME
// transformation on plain documents, step for step, so test/input-defaults.test.js
// can prove what the SQL is meant to guarantee — default totals unchanged
// (through the real api/shared/budget-calc.js), the pool leaves with Amenity
// SF 0, per-unit lines follow the unit count, and only scopes and bases the
// deployed code understands are published.
//
// KEEP IN SYNC WITH THE SQL. Every rule here has a twin there: the target
// list (@targets), the old/new/mixed classification, the refusals (THROW
// 50062-50075), the exact half-up cent arithmetic, where the pool is moved
// to, the developer-fee conversion and the tolerances. Change one, change both.
//
// Not used by the app. Never deployed (tools/ is not under app/ or api/).

'use strict';

const calc = require('../api/shared/budget-calc');

// MIRROR: @targets. Every one is a residential per-SF line today.
const OLD_SCOPE = 'res';
const OLD_BASIS = 'sf';
const TARGETS = [
  { ord: 1, kind: 'pool', code: '13 11 00', oldDesc: 'Swimming Pool w/ Pool Deck', newScope: 'amen', newGrp: 'Amenity Site & Pool', newDesc: 'Swimming Pool w/ Pool Deck', newBasis: 'ls' },
  { ord: 2, kind: 'unit', code: '11 31 00', oldDesc: 'Residential Appliances', newScope: 'res', newGrp: null, newDesc: 'Residential Appliances (per Unit)', newBasis: 'unit' },
  { ord: 3, kind: 'unit', code: '12 30 00', oldDesc: 'Casework / Stock Cabinets', newScope: 'res', newGrp: null, newDesc: 'Casework / Stock Cabinets (per Unit)', newBasis: 'unit' },
  { ord: 4, kind: 'unit', code: '12 36 00', oldDesc: 'Countertops', newScope: 'res', newGrp: null, newDesc: 'Countertops (per Unit)', newBasis: 'unit' },
  { ord: 5, kind: 'unit', code: '08 11 00', oldDesc: 'Interior Doors & Frames', newScope: 'res', newGrp: null, newDesc: 'Interior Doors & Frames (per Unit)', newBasis: 'unit' },
  { ord: 6, kind: 'unit', code: '08 71 00', oldDesc: 'Interior Door Hardware', newScope: 'res', newGrp: null, newDesc: 'Interior Door Hardware (per Unit)', newBasis: 'unit' },
  { ord: 7, kind: 'unit', code: '08 83 00', oldDesc: 'Mirrors', newScope: 'res', newGrp: null, newDesc: 'Mirrors (per Unit)', newBasis: 'unit' },
  { ord: 8, kind: 'unit', code: '10 28 00', oldDesc: 'Toilet, Bath & Laundry Accessories', newScope: 'res', newGrp: null, newDesc: 'Toilet, Bath & Laundry Accessories (per Unit)', newBasis: 'unit' },
  { ord: 9, kind: 'unit', code: '12 21 00', oldDesc: 'Window Blinds', newScope: 'res', newGrp: null, newDesc: 'Window Blinds (per Unit)', newBasis: 'unit' },
  { ord: 10, kind: 'unit', code: '10 55 00', oldDesc: 'Mailboxes', newScope: 'res', newGrp: null, newDesc: 'Mailboxes (per Unit)', newBasis: 'unit' }
];

// The app's line key — stampCurrentPricing() and repriceBudget() in
// app/index.html match a budget line to a library line by exactly this.
const keyOf = l => l.scope + '|' + l.code + '|' + l.desc;
const oldKey = t => OLD_SCOPE + '|' + t.code + '|' + t.oldDesc;
const newKey = t => t.newScope + '|' + t.code + '|' + t.newDesc;

const countKey = (lines, k) => lines.filter(l => keyOf(l) === k).length;

// MIRROR: the @state classification. 'old' = every target exactly once under
// its old key and none under its new key; 'new' = the reverse.
function classify(doc) {
  const lines = (doc && doc.lines) || [];
  const oldOnce = TARGETS.filter(t => countKey(lines, oldKey(t)) === 1).length;
  const oldAny = TARGETS.filter(t => countKey(lines, oldKey(t)) > 0).length;
  const newOnce = TARGETS.filter(t => countKey(lines, newKey(t)) === 1).length;
  const newAny = TARGETS.filter(t => countKey(lines, newKey(t)) > 0).length;
  if (oldOnce === TARGETS.length && newAny === 0) return 'old';
  if (newOnce === TARGETS.length && oldAny === 0) return 'new';
  return 'mixed';
}

// A plain decimal with at most `places` places, as a BigInt of value x 10^places.
// MIRROR: TRY_CONVERT(DECIMAL(38,10), x) <> TRY_CONVERT(DECIMAL(19,4), x).
function scaled(v, places) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const s = Math.round(n * 10 ** places);
  if (s / 10 ** places !== n) return null;
  return BigInt(s);
}

// MIRROR: ((n - n % d) / d + CASE WHEN 2 * (n % d) >= d THEN 1 ELSE 0 END)
// — whole-number division rounded half up, n and d non-negative.
function halfUpCents(n, d) {
  const q = n / d, r = n % d;
  return 2n * r >= d ? q + 1n : q;
}

class RefusedError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// transform({ pricing, template, newPricingVersion, effective })
//   -> { alreadyDone: true }                                  (both already new)
//   -> { alreadyDone: false, pricing, template, devPct, before, after }
// Throws RefusedError (with the SQL's THROW number as .code) where the SQL
// would refuse. Inputs are never mutated.
function transform({ pricing, template, newPricingVersion = '2026.10-v1', effective = '2026-10-15' }) {
  const pDoc = JSON.parse(JSON.stringify(pricing));
  const tDoc = JSON.parse(JSON.stringify(template));
  const pState = classify(pDoc), tState = classify(tDoc);
  if (pState === 'new' && tState === 'new') return { alreadyDone: true };
  if (!(pState === 'old' && tState === 'old')) {
    throw new RefusedError(50062, `Refusing to publish: pricing library is "${pState}" and template is "${tState}".`);
  }

  // MIRROR: THROW 50064 — still plain residential per-SF (auto) lines with
  // plain-decimal, non-negative rates.
  const bad = [];
  for (const [src, doc] of [['pricing', pDoc], ['template', tDoc]]) {
    for (const t of TARGETS) {
      const l = doc.lines.find(x => keyOf(x) === oldKey(t));
      const u = scaled(l.unit, 4);
      let ok = l.basis === OLD_BASIS && u !== null && u >= 0n;
      if (src === 'template') {
        const b = scaled(l.baseUnit, 4);
        ok = ok && l.auto === true && b !== null && b >= 0n;
      }
      if (!ok) bad.push(src + ' ' + t.code + ' ' + t.oldDesc);
    }
  }
  if (bad.length) throw new RefusedError(50064, 'Refusing to publish: not plain residential per-SF auto lines: ' + bad.join('; '));

  // MIRROR: THROW 50065-50067 — the calibration point.
  const S2 = scaled(tDoc.resSF, 2);
  if (S2 === null || S2 <= 0n) throw new RefusedError(50065, 'resSF is missing, zero, or has more than 2 places');
  const counts = (tDoc.units || []).map(u => scaled(u.count, 4));
  if (!counts.length || counts.some(c => c === null)) throw new RefusedError(50066, 'unit mix empty or non-numeric');
  const U4 = counts.reduce((s, c) => s + c, 0n);
  if (U4 <= 0n) throw new RefusedError(50066, 'unit mix totals zero');
  if (!(Number(tDoc.amenSF) > 0)) throw new RefusedError(50067, 'amenSF is 0 — the pool would leave the default total');

  // MIRROR: @rates. Per unit: cents = rate4 x S2 / U4; pool: rate4 x S2 / 10000.
  const rateOf = (t, v) => {
    const d = t.kind === 'unit' ? U4 : 10000n;
    return Number(halfUpCents(scaled(v, 4) * S2, d)) / 100;
  };

  // MIRROR: pool goes just after the last amenity line (ord = amenLast + 0.5).
  function rebuild(doc, isTemplate) {
    let amenLast = -1;
    doc.lines.forEach((l, i) => { if (l.scope === 'amen') amenLast = i; });
    const out = doc.lines.map((l, i) => {
      const t = TARGETS.find(x => keyOf(l) === oldKey(x));
      if (!t) return { ord: i, v: l };
      let v;
      if (t.kind === 'pool') {
        v = { ...l, scope: t.newScope, grp: t.newGrp, basis: t.newBasis, unit: rateOf(t, l.unit) };
        if (isTemplate) Object.assign(v, { baseUnit: rateOf(t, l.baseUnit), qty: 1, auto: false });
        return { ord: amenLast >= 0 ? amenLast + 0.5 : i, v };
      }
      v = { ...l, desc: t.newDesc, basis: t.newBasis, unit: rateOf(t, l.unit) };
      if (isTemplate) v.baseUnit = rateOf(t, l.baseUnit);
      return { ord: i, v };
    });
    return out.sort((a, b) => a.ord - b.ord).map(x => x.v);
  }

  const newP = { ...pDoc, lines: rebuild(pDoc, false), version: newPricingVersion, effective };
  let newT = { ...tDoc, lines: rebuild(tDoc, true), pricingVersion: newPricingVersion };

  // Totals: through the REAL budget-calc parts() (the SQL ports it).
  const p0 = calc.parts(tDoc), p1 = calc.parts(newT);

  // MIRROR: developer fee — only a positive DOLLAR fee (a bare number, or an
  // object whose mode is not 'pct') is converted; fee$ / project is exactly
  // the share that reproduces the same project cost.
  const dev = (newT.projectCosts || {}).dev;
  const devIsAmt = typeof dev === 'number' || (dev && typeof dev === 'object' && dev.mode !== 'pct');
  let devPct = null;
  if (devIsAmt && p1.fee.dev > 0 && p1.project > 0) {
    devPct = Math.round(p1.fee.dev / p1.project * 100 * 1e4) / 1e4;
    newT = { ...newT, projectCosts: { ...newT.projectCosts, dev: { mode: 'pct', val: devPct } } };
  }
  const p2 = calc.parts(newT);

  // MIRROR: THROW 50071-50073 and their tolerance.
  const unitTargets = TARGETS.filter(t => t.kind === 'unit').length;
  const tol = 1 + 0.01 * (Number(U4) / 1e4) * unitTargets;
  if (Math.abs(p2.contract - p0.contract) > tol) throw new RefusedError(50071, 'default contract sum would move');
  if (Math.abs(p2.project - p0.project) > tol + 0.000001 * p0.project) throw new RefusedError(50072, 'default project cost would move');
  if ((p2.fee.pctRate || 0) > 0.95) throw new RefusedError(50073, 'fee percentages above 95%');

  return { alreadyDone: false, pricing: newP, template: newT, devPct, tolerance: tol,
           before: { contract: p0.contract, project: p0.project, devFee: p0.fee.dev },
           after: { contract: p2.contract, project: p2.project, devFee: p2.fee.dev } };
}

module.exports = { TARGETS, keyOf, classify, transform, halfUpCents, RefusedError };
