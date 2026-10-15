// Projection of a budget document into normalized SOV rows.
//
// Deliberately free of any database driver, so the arithmetic that decides
// what the lender-package pipeline reads can be tested on its own
// (test/sov.test.js, test/canonical.test.js) without an Azure SQL connection.
//
// The quantity rule and amenity suppression are budget-calc.js's, not a copy.
// This file used to keep a third copy of the rule (after the browser and
// budget-calc.js); it decided "typed quantity" with `auto === false`, summed
// unit counts without coercion (string counts concatenated) and ignored
// amenity suppression — so dbo.SovLines could disagree with the ContractSum
// saved beside it (BUDGET-SYSTEM.md §17 D1, D10).
const { nz, lineQty, scopeActive } = require('./budget-calc');

// Kept for callers of the old signature; a trailing units argument is ignored
// because budget-calc's totUnits() is the one unit count.
function qtyOf(line, doc) { return lineQty(doc || {}, line); }

// LineOrder is document order and is what keeps a version's rows in the order
// the user saw. LineKey is the stable lineId where the document carries one;
// duplicates and missing IDs fall back to NULL so a save can never trip the
// filtered unique index on (ProjectId, LineKey).
//
// A line in a SUPPRESSED scope (amenity with amenSF <= 0) is still written —
// Qty 0, Total 0, its Rate unchanged — rather than dropped. Suppression is
// arithmetic, not hiding (the line stays in the document and comes back when
// amenity SF does), and keeping the row keeps its LineKey continuous across
// versions, so a lender diff sees "amenity went to $0" instead of a line that
// vanished and reappeared. Either way Σ Total over res+amen = parts(doc).hard
// and over soft = parts(doc).soft, which is what ContractSum is built from.
function sovRows(doc) {
  const seen = new Set();
  return (doc.lines || []).map((l, i) => {
    let key = typeof l.lineId === 'string' && l.lineId ? l.lineId.slice(0, 64) : null;
    if (key && seen.has(key)) key = null;
    if (key) seen.add(key);
    const scope = l.scope || 'res';
    const qty = scopeActive(doc, scope) ? lineQty(doc, l) : 0;
    const rate = nz(l.unit);
    return {
      lineOrder: i + 1,
      lineKey: key,
      scope,
      grp: l.grp || '',
      code: l.code || '',
      descr: l.desc || '',
      basis: l.basis || 'ls',
      qty,
      rate,
      total: qty * rate
    };
  });
}

module.exports = { sovRows, qtyOf };
