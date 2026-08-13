// Projection of a budget document into normalized SOV rows.
//
// Deliberately dependency-free — no database driver — so the arithmetic that
// decides what the lender-package pipeline reads can be tested on its own
// (test/canonical.test.js) without an Azure SQL connection.

// The quantity a line contributes, mirroring the frontend's basis rules.
function qtyOf(line, doc, units) {
  if (line.auto === false) return line.qty || 0;
  if (line.basis === 'sf') return doc.resSF || 0;
  if (line.basis === 'asf') return doc.amenSF || 0;
  if (line.basis === 'unit') return units;
  return 1;
}

// LineOrder is document order and is what keeps a version's rows in the order
// the user saw. LineKey is the stable lineId where the document carries one;
// duplicates and missing IDs fall back to NULL so a save can never trip the
// filtered unique index on (ProjectId, LineKey).
function sovRows(doc) {
  const units = (doc.units || []).reduce((s, u) => s + (u.count || 0), 0);
  const seen = new Set();
  return (doc.lines || []).map((l, i) => {
    let key = typeof l.lineId === 'string' && l.lineId ? l.lineId.slice(0, 64) : null;
    if (key && seen.has(key)) key = null;
    if (key) seen.add(key);
    const qty = qtyOf(l, doc, units);
    const rate = l.unit || 0;
    return {
      lineOrder: i + 1,
      lineKey: key,
      scope: l.scope || 'res',
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
