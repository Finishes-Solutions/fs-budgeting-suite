// Financial primitives. Dependency-free, full double precision — rounding
// happens only at named boundaries (the terminal gross sale price) or at
// display time, never inside these functions.

// Monthly payment of a fully amortizing loan (30/360: rate/12 per period).
// A zero-rate loan amortizes linearly.
function pmt(ratePerPeriod, numberOfPeriods, principal) {
  if (numberOfPeriods <= 0) return 0;
  if (ratePerPeriod === 0) return principal / numberOfPeriods;
  return principal * ratePerPeriod / (1 - Math.pow(1 + ratePerPeriod, -numberOfPeriods));
}

// Outstanding balance after `paidPeriods` payments.
function remainingBalance(principal, ratePerPeriod, payment, paidPeriods) {
  if (paidPeriods <= 0) return principal;
  if (ratePerPeriod === 0) return Math.max(0, principal - payment * paidPeriods);
  const f = Math.pow(1 + ratePerPeriod, paidPeriods);
  return Math.max(0, principal * f - payment * (f - 1) / ratePerPeriod);
}

// The recovered convention: gross sale price is rounded to the nearest $1,000
// and that ROUNDED number feeds selling costs and net proceeds downstream.
function roundToNearestThousand(value) {
  return Math.round(value / 1000) * 1000;
}

// Deterministic annual IRR: bracket by grid scan, then bisection. Returns null
// when the cash flows have no sign change or no root in the search range —
// never NaN, never Infinity, never a misleading zero.
const IRR_LO = -0.9999;   // -99.99%/yr
const IRR_HI = 100;       // 10,000%/yr — far beyond any plausible deal
function irr(cashFlows) {
  if (!Array.isArray(cashFlows) || cashFlows.length < 2) return null;
  let sawPos = false, sawNeg = false;
  for (const c of cashFlows) { if (c > 0) sawPos = true; if (c < 0) sawNeg = true; }
  if (!sawPos || !sawNeg) return null;

  const npv = r => {
    let v = 0;
    for (let t = 0; t < cashFlows.length; t++) v += cashFlows[t] / Math.pow(1 + r, t);
    return v;
  };

  // Grid scan from the left finds the lowest bracketing interval; the cash-flow
  // shapes this engine produces (one sign change) have a unique root.
  const STEPS = 4000;
  let lo = IRR_LO, hi = null, prevR = IRR_LO, prevV = npv(IRR_LO);
  if (!Number.isFinite(prevV)) return null;
  for (let i = 1; i <= STEPS; i++) {
    // Log-spaced toward the high end so small rates keep fine resolution.
    const r = IRR_LO + (Math.exp(i / STEPS * Math.log(1 + IRR_HI - IRR_LO)) - 1);
    const v = npv(r);
    if (Number.isFinite(v) && ((prevV < 0 && v >= 0) || (prevV > 0 && v <= 0))) {
      lo = prevR; hi = r; break;
    }
    prevR = r; prevV = v;
  }
  if (hi === null) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const v = npv(mid);
    if (!Number.isFinite(v)) return null;
    if (Math.abs(v) < 1e-9 || (hi - lo) < 1e-12) return mid;
    if ((npv(lo) < 0) === (v < 0)) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

module.exports = { pmt, remainingBalance, roundToNearestThousand, irr };
