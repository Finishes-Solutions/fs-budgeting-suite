'use strict';

const { assertValid } = require('../schema/validate');

/**
 * buildCsv(doc) -> string
 * Raw numbers (fractions for percents) so the file pivots cleanly; sections
 * separated by blank lines; one document, one file. Theme-free by design.
 */
function buildCsv(doc) {
  assertValid(doc);
  const lines = [];
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const M = doc.meta;
  lines.push(esc(M.title + (M.subline ? ' \u2014 ' + M.subline : '')));
  lines.push('');
  doc.sheets.forEach((sh) => {
    lines.push(esc('== ' + (sh.title || sh.name) + ' =='));
    sh.blocks.forEach((b) => {
      if (b.only === 'pdf') return;
      if (b.kind === 'group') lines.push(esc(b.label));
      else if (b.kind === 'note') lines.push(esc(b.text));
      else if (b.kind === 'kv') b.rows.forEach((r) => lines.push(esc(r.k) + ',' + esc(r.v)));
      else if (b.kind === 'matrixTable') {
        lines.push([''].concat(b.headers).map(esc).join(','));
        b.rows.forEach((r) => lines.push([r.label].concat(r.values).map(esc).join(',')));
      } else if (b.kind === 'table') {
        lines.push(b.columns.map((c) => esc(c.label)).join(','));
        b.rows.forEach((r) => lines.push(b.columns.map((c) => esc(r[c.key])).join(',')));
        if (b.totals) lines.push(b.columns.map((c, i) => (c.key in b.totals ? esc(b.totals[c.key]) : (i === 0 ? 'TOTAL' : ''))).join(','));
      }
    });
    lines.push('');
  });
  if (M.footnote) lines.push(esc(M.footnote));
  return lines.join('\r\n');
}

module.exports = { buildCsv };
