// Period arithmetic on "YYYY-MM" strings — pure integer month math, so there
// is no Date object and no local-timezone drift. Year t of an analysis
// purchased in month M ends one month before the t-th anniversary: a purchase
// in 2025-12 makes Year 1 end 2026-11.
const MONTH_RX = /^\d{4}-(0[1-9]|1[0-2])$/;

function isValidMonth(s) { return typeof s === 'string' && MONTH_RX.test(s); }

function periodEndFromPurchaseMonth(purchaseMonth, yearNumber) {
  const [y, m] = purchaseMonth.split('-').map(Number);
  const idx = y * 12 + (m - 1) + yearNumber * 12 - 1;   // zero-based month index
  const ey = Math.floor(idx / 12), em = idx % 12 + 1;
  return ey + '-' + String(em).padStart(2, '0');
}

module.exports = { isValidMonth, periodEndFromPurchaseMonth };
