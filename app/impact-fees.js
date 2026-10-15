/* Impact & tap fees — the shared fee calculator.

   One file, two runtimes: the browser loads it as a plain script (it hangs off
   window.FSImpactFees) and test/impact-fees.test.js requires it as CommonJS, so
   the arithmetic that decides a real six-figure soft-cost line is provable
   without a browser.

   There is deliberately NO api/shared twin. The computed total is MATERIALIZED
   onto the SOV line as a lump sum, so the server keeps seeing an ordinary soft
   line: api/shared/budget-calc.js, the SOV projection and the guard rails need
   no knowledge of fee schedules at all. Keeping that true is the point — a
   second implementation of this arithmetic would be a second thing to keep in
   parity, which is exactly the trap guardrails.js exists to warn about.

   THE MODEL, using the City of Waller schedule this was built from:

     water impact fee = EDU multiplier x $3,689.91   (per-EDU rates, for display)
     sewer impact fee = EDU multiplier x $7,619.03

   but the PUBLISHED per-row amounts are what the schedule stores and what this
   uses. The true water rate is ~$3,689.9104, so deriving the 330-EDU row from
   the rounded $3,689.91 lands 12 cents under what the city actually charges.
   A jurisdiction's published number is the number.

   The low/high spread applies ONLY to the four adders — meter, vault, water tap
   work, sewer tap work. Impact fees themselves are single-valued, so 'low' and
   'high' do not move them. An absent or null range is the workbook's "NA"
   (meters 3 inch and under have no vault) and contributes nothing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSImpactFees = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var nz = function (v) { return Number.isFinite(+v) ? +v : 0; };

  var BASES = ['low', 'avg', 'high'];
  var BASIS_LABEL = { low: 'low side', avg: 'average', high: 'high side' };

  /* High is the default everywhere. A fee estimate that comes in under what the
     city bills is worse than one that comes in over, and this number reaches
     lenders. Changing the default is a decision, not a tidy-up. */
  var DEFAULT_BASIS = 'high';

  function basisOf(b) { return BASES.indexOf(b) >= 0 ? b : DEFAULT_BASIS; }

  /* One low/high pair resolved against the chosen basis. null, undefined and a
     malformed pair all read as zero — "NA" and "not published" are the same
     thing to a budget, and neither should print $NaN. */
  function pick(range, basis) {
    if (!range || typeof range !== 'object') return 0;
    var lo = nz(range.low), hi = nz(range.high);
    if (basis === 'low') return lo;
    if (basis === 'high') return hi;
    return (lo + hi) / 2;
  }

  /* The generic, non-meter fees other jurisdictions charge — roadway, park,
     drainage, plan review. Waller's schedule carries none; this is the
     extension point that means the next city does not need a schema change.
     pctHard is a share of hard cost expressed as a percentage, matching how
     doc.contingency and the project-cost fees already read a percentage. */
  function extraQty(basis, ctx) {
    ctx = ctx || {};
    switch (basis) {
      case 'unit':    return nz(ctx.units);
      case 'acre':    return nz(ctx.acres);
      case 'resSF':   return nz(ctx.resSF);
      case 'amenSF':  return nz(ctx.amenSF);
      case 'bldgSF':  return nz(ctx.resSF) + nz(ctx.amenSF);
      case 'pctHard': return nz(ctx.hard) / 100;
      default:        return 1;                       // 'flat'
    }
  }

  /* One meter row, priced. `sel` is the budget's selection for that row —
     quantity plus which adders this project actually pays. A project tapping an
     existing stub pays the impact fee and the tap work but not a new meter, and
     that is a per-project fact, not a schedule fact. */
  function rowAmounts(meter, sel, basis) {
    basis = basisOf(basis);
    sel = sel || {};
    var qty = nz(sel.qty);
    var on = function (k) { return sel[k] === undefined ? true : !!sel[k]; };
    var each = {
      waterImpact: nz(meter && meter.waterImpact),
      sewerImpact: nz(meter && meter.sewerImpact),
      meter:       on('includeMeter') ? pick(meter && meter.meter, basis) : 0,
      vault:       on('includeVault') ? pick(meter && meter.vault, basis) : 0,
      waterTap:    on('includeTaps')  ? pick(meter && meter.waterTap, basis) : 0,
      sewerTap:    on('includeTaps')  ? pick(meter && meter.sewerTap, basis) : 0
    };
    each.total = each.waterImpact + each.sewerImpact + each.meter + each.vault
               + each.waterTap + each.sewerTap;
    return {
      id: sel.id || null, label: sel.label || '',
      rowId: meter && meter.rowId, size: meter && meter.size,
      gpm: nz(meter && meter.gpm), edu: nz(meter && meter.edu),
      qty: qty, each: each, total: qty * each.total,
      hasVault: !!(meter && meter.vault)
    };
  }

  /* How one selected meter reads on screen and in the exports. Size alone is
     ambiguous — 2 inch appears at both 80 and 100 gpm, and the gpm is what sets
     the EDU multiplier — so the rate is always part of the name. */
  function meterName(meter) {
    if (!meter) return '';
    return meter.size + '" \u00b7 ' + nz(meter.gpm) + ' gpm \u00b7 ' + nz(meter.edu) + ' EDU';
  }

  function extraAmount(fee, basis, ctx) {
    if (!fee) return 0;
    return nz(fee.qty === undefined ? 1 : fee.qty)
         * pick(fee.amount, basisOf(basis))
         * extraQty(fee.basis, ctx);
  }

  /* The whole calculation. Pure, and safe on a budget that has never opened the
     Impact Fees step: no schedule means a zero total and no rows, which is
     exactly how every budget that predates this behaves. */
  function evaluate(schedule, impactFees, ctx) {
    var f = impactFees || {};
    var basis = basisOf(f.basis);
    var meters = (schedule && Array.isArray(schedule.meters)) ? schedule.meters : [];
    var byId = {};
    meters.forEach(function (m) { if (m && m.rowId) byId[m.rowId] = m; });

    var rows = (Array.isArray(f.meters) ? f.meters : [])
      .filter(function (s) { return s && byId[s.rowId]; })
      .map(function (s) { return rowAmounts(byId[s.rowId], s, basis); });
    // Duplicates are legitimate here and must not be deduped — see the note on
    // selection identity above.

    var feeById = {};
    ((schedule && Array.isArray(schedule.fees)) ? schedule.fees : [])
      .forEach(function (x) { if (x && x.feeId) feeById[x.feeId] = x; });

    var extras = (Array.isArray(f.extras) ? f.extras : [])
      .filter(function (s) { return s && feeById[s.feeId]; })
      .map(function (s) {
        var def = feeById[s.feeId];
        return { feeId: def.feeId, label: def.label, basis: def.basis,
                 qty: nz(s.qty === undefined ? 1 : s.qty),
                 total: extraAmount({ amount: def.amount, basis: def.basis, qty: s.qty }, basis, ctx) };
      });

    var manual = (Array.isArray(f.manual) ? f.manual : [])
      .map(function (m) {
        return { rowId: m && m.rowId, label: (m && m.label) || 'Fee', total: nz(m && m.amount) };
      });

    var sum = function (a) { return a.reduce(function (s, r) { return s + r.total; }, 0); };
    var meterTotal = sum(rows), extrasTotal = sum(extras), manualTotal = sum(manual);
    var derived = meterTotal + extrasTotal + manualTotal;

    return {
      basis: basis, basisLabel: BASIS_LABEL[basis],
      rows: rows, extras: extras, manual: manual,
      meterTotal: meterTotal, extrasTotal: extrasTotal, manualTotal: manualTotal,
      derivedTotal: derived,
      total: derived,
      hasSchedule: !!(schedule && schedule.scheduleKey),
      scheduleKey: f.scheduleKey || null,
      scheduleName: f.scheduleName || (schedule && schedule.name) || null,
      scheduleVersion: f.scheduleVersion || null
    };
  }

  /* The sentence that travels — onto the SOV line's description, into the edits
     report, and onto the PDF. It is what makes the number defensible six months
     later, so it names the jurisdiction, the basis and the schedule version. */
  function provenance(result) {
    if (!result || !result.scheduleName) return '';
    var s = result.scheduleName + ' (' + result.basisLabel;
    if (result.scheduleVersion) s += ', v' + result.scheduleVersion;
    return s + ')';
  }

  return {
    evaluate: evaluate, rowAmounts: rowAmounts, extraAmount: extraAmount,
    pick: pick, provenance: provenance, meterName: meterName,
    BASES: BASES, BASIS_LABEL: BASIS_LABEL, DEFAULT_BASIS: DEFAULT_BASIS,
    FEE_BASES: ['flat', 'unit', 'acre', 'resSF', 'amenSF', 'bldgSF', 'pctHard']
  };
});
