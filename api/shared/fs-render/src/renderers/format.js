'use strict';

/* Display formatting — lifted verbatim in behavior from the budgeting
   suite's export renderer (paren negatives for money, 3-dec rates, "x"
   multiples). Strings for PDF/CSV; XLSX keeps raw numbers + numFmt. */

function fmtValue(v, fmt) {
  if (v === null || v === undefined || v === '') return '\u2014';
  if (typeof v === 'string') return v;
  switch (fmt) {
    case 'money': return v < 0 ? '($' + Math.round(Math.abs(v)).toLocaleString('en-US') + ')'
      : '$' + Math.round(v).toLocaleString('en-US');
    case 'money2': return (v < 0 ? '\u2212$' : '$') + Math.abs(v).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'pct': return (v * 100).toFixed(2) + '%';
    case 'rate': return (v * 100).toFixed(3) + '%';
    case 'ratio': return v.toFixed(2);
    case 'mult': return v.toFixed(2) + 'x';
    case 'qty': return Math.round(v).toLocaleString('en-US');
    default: return String(v);
  }
}

const XLSX_FMT = {
  money: '"$"#,##0', money2: '"$"#,##0.00', pct: '0.00%', rate: '0.000%',
  ratio: '0.00', mult: '0.00"x"', qty: '#,##0',
};

module.exports = { fmtValue, XLSX_FMT };
