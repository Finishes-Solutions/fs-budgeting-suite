/* Investment analysis export PRODUCER — the shared document model builder.
   Rendering moved to fs-render (fs-courier's engine): the browser vendors
   app/vendor/fs-render.browser.js and the API requires the vendored copy at
   api/shared/fs-render. This file builds content (buildExportDoc), which
   to-fsdoc.js adapts to fsdoc/1 for those renderers; it also appends the
   suite's Signature Needed approval page onto a finished docDefinition
   (appendApprovalPage) — a suite policy fsdoc/1 deliberately omits.

   One file, two runtimes: the browser loads it as a plain script (it hangs
   off window.FSExportRender) and the API requires it as CommonJS. A copy
   lives at api/shared/investment/export-render.js and MUST stay byte-identical
   — test/export-render.test.js fails the build if the two ever drift.

   Layering rule holds: this file knows finance and content; fs-render knows
   only formatting and brand. Everything reads the canonical engine result —
   nothing here recalculates. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSExportRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- brand tokens (mirrors the app's BRAND + print palette) ---- */
  var BRAND = {
    ink900: '16191A', ink700: '353B3D', ink600: '4E5456', ink500: '6B7174',
    ink200: 'DDE1E2', ink100: 'F1F3F3', green: '006527', green50: 'F1F8F4',
    hl: 'D8F3E0', white: 'FFFFFF'
  };

  /* ---- display formatting (strings for PDF/CSV headers; XLSX keeps numbers)
     null renders as an em dash (a value that does not exist, e.g. DSCR on an
     all-cash deal); undefined renders as a blank cell (a column that simply
     does not apply on this row, e.g. Qty on a subtotal). */
  function fmtValue(v, fmt) {
    if (v === null) return '—';
    if (v === undefined || v === '') return '';
    if (typeof v === 'string') return v;
    switch (fmt) {
      case 'money': return v < 0 ? '($' + Math.round(Math.abs(v)).toLocaleString('en-US') + ')'
        : '$' + Math.round(v).toLocaleString('en-US');
      case 'money2': return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'pct': return (v * 100).toFixed(2) + '%';
      case 'pct1': return (v * 100).toFixed(1) + '%';
      case 'rate': return (v * 100).toFixed(3) + '%';
      case 'ratio': return v.toFixed(2);
      case 'mult': return v.toFixed(2) + 'x';
      case 'qty': return Math.round(v).toLocaleString('en-US');
      default: return String(v);
    }
  }
  var XLSX_FMT = {
    money: '"$"#,##0', money2: '"$"#,##0.00', pct: '0.00%', pct1: '0.0%', rate: '0.000%',
    ratio: '0.00', mult: '0.00"x"', qty: '#,##0'
  };
  // Table rows may carry one fmt for every value column or an array, one per column.
  function colFmt(fmt, i) { return Array.isArray(fmt) ? fmt[i] : fmt; }

  function pcts(v) { return (v * 100).toFixed(2) + '%'; }

  // House timestamp display: MM-DD-YYYY h:mm AM/PM in this runtime's local
  // time (the browser when exporting client-side). ISO strings stay in
  // meta.generatedAt untouched — only the DISPLAYED stamps use this.
  function fmtStamp(iso) {
    if (!iso) return '';
    var d = iso instanceof Date ? iso : new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + d.getFullYear()
      + ' ' + h + ':' + p(d.getMinutes()) + ' ' + ap;
  }

  /* =============== the document model ===============
     buildExportDoc(result, opts, meta) -> doc
       result : canonical engine result (result.normalizedInput included)
       opts   : { kpis, cash, sale, returns, sens, assumptions, highlight }
       meta   : { savedVersion, generatedAt }  (server-owned context)
     doc.sheets[] each carry blocks:
       { kind:'group', label }                          — section heading
       { kind:'kv', rows:[{k, v, fmt, total}], only? }  — label/value list
       { kind:'kpiBand', tiles:[{k, v}], only:'pdf' }   — page-one stat band
       { kind:'note', text }
       { kind:'table', headers:[], rows:[{label, values:[], fmt, total, hl}] } */
  function buildExportDoc(result, opts, meta) {
    var o = opts || {};
    var R = result, s = R.summary, loan = R.loans[0] || null, N = R.normalizedInput;
    var src = N.source, yrs = R.annual.length;
    meta = meta || {};
    var propName = N.property.name || 'Investment Analysis';
    var yearHeads = R.annual.map(function (a) { return 'Y' + a.year + ' · ' + a.periodEnd; });
    var sheets = [];

    function kvRow(k, v, fmt, total) { return { k: k, v: v, fmt: fmt, total: !!total }; }
    function tRow(label, values, fmt, total, hl) {
      return { label: label, values: values, fmt: fmt, total: !!total, hl: !!hl };
    }
    function years(f) { return R.annual.map(f); }

    if (o.kpis) {
      var blocks1 = [
        { kind: 'group', label: 'PROPERTY', only: 'grid' },
        { kind: 'kv', only: 'grid', rows: [
          kvRow('Analysis', N.analysisName),
          kvRow('Property', propName),
          kvRow('Address', N.property.address || '—'),
          kvRow('Size', N.property.size.value + ' ' + (N.property.size.unit === 'squareFeet' ? 'SF' : N.property.size.unit)),
          N.property.unitCount ? kvRow('Units', N.property.unitCount, 'qty') : null,
          kvRow('Purchase Month', N.property.purchaseMonth),
          kvRow('Projection', yrs + '-Year Before-Tax Analysis'),
          kvRow('Source', src ? 'Budget ' + src.projectId + ' version ' + src.budgetVersionNumber : 'Standalone Analysis')
        ].filter(Boolean) },
        { kind: 'kpiBand', only: 'pdf', tiles: [
          { k: 'Purchase Price', v: fmtValue(s.purchasePrice, 'money') },
          { k: 'Acquisition Cap', v: fmtValue(s.acquisitionCapRate, 'pct') },
          { k: 'Initial Equity', v: fmtValue(s.initialEquity, 'money') },
          { k: 'Equity IRR', v: fmtValue(s.finalYearEquityIRR, 'pct') },
          { k: 'Optimal Hold', v: s.optimalHoldingYear ? 'Year ' + s.optimalHoldingYear + ' · ' + pcts(s.optimalHoldingYield) : '—' }
        ] },
        { kind: 'group', label: 'KEY METRICS', only: 'grid' },
        { kind: 'kv', only: 'grid', rows: [
          kvRow('Purchase Price', s.purchasePrice, 'money'),
          kvRow('Acquisition Cap Rate', s.acquisitionCapRate, 'pct'),
          kvRow('Initial Equity', s.initialEquity, 'money'),
          kvRow('Year-1 NOI', s.year1NOI, 'money'),
          kvRow('Final-Year Equity IRR', s.finalYearEquityIRR, 'pct'),
          kvRow('Final-Year Equity Multiple', s.finalYearEquityMultiple, 'mult'),
          kvRow('Optimal Holding Year', s.optimalHoldingYear || '—'),
          kvRow('Optimal Holding Yield', s.optimalHoldingYield, 'pct')
        ] },
        { kind: 'group', label: 'ACQUISITION & INITIAL INVESTMENT' },
        { kind: 'kv', rows: [
          kvRow('Purchase Price ', s.purchasePrice, 'money'),
          kvRow('Acquisition Costs (' + pcts(N.acquisition.costPercent) + ')', s.acquisitionCosts, 'money'),
          loan ? kvRow('Loan Fees (' + pcts(loan.feePercent) + ')', s.loanFees, 'money') : null,
          kvRow('Unleveraged Investment', s.unleveragedInitialInvestment, 'money'),
          loan ? kvRow('Less: Loan Principal', -loan.principal, 'money') : null,
          kvRow('Initial Equity Investment', s.initialEquity, 'money', true),
          kvRow('Gross Rent Multiplier', s.grossRentMultiplier, 'ratio'),
          s.pricePerSquareFoot !== null ? kvRow('Price / SF', s.pricePerSquareFoot, 'money2') : null,
          s.pricePerUnit !== null ? kvRow('Price / Unit', s.pricePerUnit, 'money') : null
        ].filter(Boolean), hlKeys: ['Purchase Price ', 'Initial Equity Investment'] },
        { kind: 'group', label: 'MORTGAGE' },
        { kind: 'kv', rows: loan ? [
          kvRow(loan.label, loan.principal, 'money'),
          kvRow('Annual Rate', loan.annualRate, 'rate'),
          kvRow('Amortization · Term', loan.amortizationYears + 'y · ' + loan.termYears + 'y'),
          kvRow('Interest Calculation', loan.interestCalculation),
          kvRow('Monthly Payment', loan.monthlyPayment, 'money2'),
          kvRow('Annual Debt Service', loan.annualDebtService, 'money'),
          kvRow('Initial LTV', s.initialLTV, 'pct')
        ] : [kvRow('Financing', 'All cash')] }
      ];
      sheets.push({ key: 'kpis', name: 'Investment Summary', title: 'Investment Summary', blocks: blocks1 });
    }

    if (o.cash) {
      sheets.push({ key: 'cash', name: 'Cash Flow', title: 'Operating Projection', blocks: [
        { kind: 'table', headers: yearHeads, rows: [
          tRow('Potential Rental Income', years(function (a) { return a.potentialIncome; }), 'money'),
          tRow('Vacancy / Credit Loss (' + pcts(N.vacancy.value) + ')', years(function (a) { return -a.vacancyLoss; }), 'money'),
          tRow('Effective Rental Income', years(function (a) { return a.effectiveRentalIncome; }), 'money'),
          tRow('Other Income', years(function (a) { return a.otherIncome; }), 'money'),
          tRow('Gross Operating Income', years(function (a) { return a.grossOperatingIncome; }), 'money', true, true),
          tRow('Operating Expenses', years(function (a) { return -a.operatingExpenses; }), 'money'),
          tRow('Net Operating Income', years(function (a) { return a.netOperatingIncome; }), 'money', true, true),
          tRow('Capital Expenses / Reserves', years(function (a) { return a.capitalExpenses ? -a.capitalExpenses : null; }), 'money'),
          tRow('Debt Service', years(function (a) { return a.debtService ? -a.debtService : null; }), 'money'),
          tRow('Cash Flow Before Taxes', years(function (a) { return a.cashFlowBeforeTaxes; }), 'money', true)
        ] },
        { kind: 'note', text: 'Expenses ' + (N.expenses.mode === 'percentOfGOI'
            ? pcts(N.expenses.value) + ' of GOI'
            : 'fixed, growing ' + pcts(N.expenses.growth.value) + '/yr')
          + ' · income growth ' + pcts(N.income.growth.value) + '/yr.' }
      ] });
    }

    if (o.sale) {
      var saleBlocks = [
        { kind: 'group', label: 'HYPOTHETICAL SALE AT END OF EACH YEAR' },
        { kind: 'note', text: 'Each sale is priced on the following year’s NOI at the '
          + pcts(N.disposition.exitCapRate.value) + ' exit cap, rounded to the nearest $1,000; selling costs ('
          + pcts(N.disposition.sellingCostPercent) + ') and the loan payoff come out of that rounded price.' },
        { kind: 'table', headers: yearHeads, rows: [
          tRow('Gross Sale Price', years(function (a) { return a.grossSalePrice; }), 'money'),
          tRow('Selling Costs', years(function (a) { return -a.sellingCosts; }), 'money'),
          loan ? tRow('Loan Payoff', years(function (a) { return -a.endingLoanBalance; }), 'money') : null,
          tRow('Net Sale Proceeds', years(function (a) { return a.netSaleProceeds; }), 'money', true)
        ].filter(Boolean) }
      ];
      if (loan) {
        saleBlocks.push({ kind: 'group', label: 'LTV · DSCR · DEBT YIELD' });
        saleBlocks.push({ kind: 'table', headers: yearHeads, rows: [
          tRow('Projected LTV (balance ÷ sale value)', years(function (a) { return a.projectedLTV; }), 'pct'),
          tRow('DSCR (NOI ÷ debt service)', years(function (a) { return a.dscr; }), 'ratio'),
          tRow('Debt Yield (NOI ÷ original loan)', years(function (a) { return a.debtYield; }), 'pct')
        ] });
      }
      sheets.push({ key: 'sale', name: 'Debt and Sale', title: 'Debt and Sale', blocks: saleBlocks });
    }

    if (o.returns) {
      sheets.push({ key: 'returns', name: 'Returns', title: 'Returns, IRR & Leverage', blocks: [
        { kind: 'table', headers: yearHeads, rows: [
          tRow('Cash-on-Cash', years(function (a) { return a.cashOnCash; }), 'pct', false, true),
          tRow('Return on Equity', years(function (a) { return a.returnOnEquity; }), 'pct'),
          tRow('Equity Multiple', years(function (a) { return a.equityMultiple; }), 'mult', false, true),
          tRow('Property IRR', years(function (a) { return a.propertyIRR; }), 'pct', false, true),
          loan ? tRow('Effective Borrowing Rate', years(function (a) { return a.effectiveLoanRate; }), 'pct') : null,
          tRow('Equity IRR', years(function (a) { return a.equityIRR; }), 'pct', true, true),
          loan ? tRow('Leverage Impact', years(function (a) {
            return a.equityIRR === null || a.propertyIRR === null ? null
              : Math.round(a.equityIRR * 10000) / 10000 - Math.round(a.propertyIRR * 10000) / 10000;
          }), 'pct') : null
        ].filter(Boolean) },
        { kind: 'note', text: 'Optimal holding period: ' + (s.optimalHoldingYear
            ? 'Year ' + s.optimalHoldingYear + ' at ' + pcts(s.optimalHoldingYield) + ' equity IRR'
            : 'not determinable') + '.'
          + (loan ? ' Leverage is positive when the equity IRR exceeds the property IRR.' : '') }
      ] });
    }

    if (o.sens && R.sensitivity) {
      var sens = R.sensitivity;
      function srows(label, key) {
        var out = [];
        for (var y = 0; y < yrs; y++) {
          (function (yy) {
            out.push(tRow(label + ' — Sale Y' + (yy + 1),
              sens.map(function (x) { return x[key][yy]; }), 'pct'));
          })(y);
        }
        return out;
      }
      sheets.push({ key: 'sens', name: 'Acquisition Sensitivity', title: 'Acquisition-Price Sensitivity', blocks: [
        { kind: 'note', text: 'Scenarios at 90–110% of the base price; base LTV, rates, operating cash flows and terminal sale prices preserved.' },
        { kind: 'table', headers: sens.map(function (x) { return Math.round(x.factor * 100) + '% of Price'; }), rows: [
          tRow('Purchase Price', sens.map(function (x) { return x.purchasePrice; }), 'money', true),
          tRow('Acquisition Cap Rate', sens.map(function (x) { return x.acquisitionCapRate; }), 'pct'),
          tRow('Loan Amount', sens.map(function (x) { return x.loanAmount; }), 'money'),
          tRow('Initial Equity', sens.map(function (x) { return x.initialEquity; }), 'money')
        ].concat(srows('Unleveraged CoC', 'unleveragedCoC'))
         .concat(srows('Leveraged CoC', 'leveragedCoC'))
         .concat(srows('Unleveraged IRR', 'unleveragedIRR'))
         .concat(srows('Leveraged IRR', 'leveragedIRR')) }
      ] });
    }

    // Assumptions travel on every grid export (the workbook's provenance
    // record); the PDF gates the section on opts like the print report does.
    var assumpBlocks = [
      { kind: 'group', label: 'ASSUMPTIONS' },
      { kind: 'kv', rows: [
        kvRow('Analysis Name', N.analysisName),
        kvRow('Property', propName),
        kvRow('Address', N.property.address || '—'),
        kvRow('Size', N.property.size.value + ' ' + N.property.size.unit),
        kvRow('Purchase Month', N.property.purchaseMonth),
        kvRow('Price Basis', N.acquisition.basis.mode),
        kvRow('Acquisition Costs %', N.acquisition.costPercent, 'pct'),
        kvRow('Year-1 Potential Income', N.income.year1PotentialIncome, 'money'),
        kvRow('Income Growth', N.income.growth.value, 'pct'),
        kvRow('Vacancy / Credit Loss', N.vacancy.value, 'pct'),
        kvRow('Expense Mode', N.expenses.mode),
        kvRow('Expense Value', N.expenses.value, N.expenses.mode === 'percentOfGOI' ? 'pct' : 'money'),
        N.expenses.mode !== 'percentOfGOI' ? kvRow('Expense Growth', N.expenses.growth.value, 'pct') : null,
        kvRow('Exit Cap Rate', N.disposition.exitCapRate.value, 'pct'),
        kvRow('Selling Costs', N.disposition.sellingCostPercent, 'pct')
      ].filter(Boolean) },
      { kind: 'group', label: 'PROVENANCE' },
      { kind: 'kv', rows: [
        kvRow('Input Schema Version', R.inputSchemaVersion),
        kvRow('Calculation Version', R.calculationVersion),
        kvRow('Saved Analysis Version', meta.savedVersion || '(unsaved)'),
        kvRow('Source', src ? 'Budget ' + src.projectId + ' version ' + src.budgetVersionNumber : 'Standalone'),
        kvRow('Generated', fmtStamp(meta.generatedAt))
      ] }
    ];
    if (R.warnings && R.warnings.length) {
      assumpBlocks.push({ kind: 'group', label: 'WARNINGS' });
      assumpBlocks.push({ kind: 'kv', rows: R.warnings.map(function (w) { return kvRow('Warning', w); }) });
    }
    sheets.push({ key: 'assumptions', name: 'Assumptions', title: 'Assumptions & Provenance',
      pdfHidden: !o.assumptions, blocks: assumpBlocks });

    // Signature Needed: a final approval page (PDF only). The identity rows
    // bind the page to this exact analysis so a signed page cannot be lifted
    // onto a different document.
    var signature = null;
    if (o.signature) {
      signature = {
        heading: 'Approval',
        statement: 'The signature below approves the investment analysis identified here, exactly as '
          + 'calculated and presented in this document. The identification binds this approval page to '
          + 'this document alone — an approval page whose identification does not match the document it '
          + 'accompanies is void.',
        identity: [
          ['Analysis', N.analysisName],
          ['Property', propName + (N.property.address ? ' · ' + N.property.address : '')],
          ['Source', src ? 'Budget ' + src.projectId + ' version ' + src.budgetVersionNumber : 'Standalone Analysis'],
          ['Saved Analysis Version', meta.savedVersion ? 'v' + meta.savedVersion : '(unsaved)'],
          ['Projection', yrs + '-Year Before-Tax'],
          ['Purchase Price', fmtValue(s.purchasePrice, 'money')],
          ['Initial Equity Investment', fmtValue(s.initialEquity, 'money')],
          ['Final-Year Equity IRR', fmtValue(s.finalYearEquityIRR, 'pct')],
          ['Calculation Engine', R.calculationVersion + ' · input schema v' + R.inputSchemaVersion],
          ['Generated', fmtStamp(meta.generatedAt)]
        ]
      };
    }

    return {
      meta: {
        product: 'FINISHES SOLUTIONS',
        propertyName: propName,
        analysisName: N.analysisName,
        address: N.property.address || '',
        years: yrs,
        sourceLine: src ? 'From budget ' + src.projectId + ' v' + src.budgetVersionNumber : 'Standalone Analysis',
        savedVersion: meta.savedVersion || 0,
        generatedAt: meta.generatedAt || '',
        engineLine: 'Calculated by engine ' + R.calculationVersion + ' · input schema v' + R.inputSchemaVersion,
        highlight: !!o.highlight,
        // Generic header fields — the PDF renderer reads ONLY these, so other
        // producers (the budget report) can drive it with their own identity.
        eyebrow: 'FINISHES SOLUTIONS · INVESTMENT ANALYSIS · ' + yrs + '-YEAR BEFORE-TAX',
        title: propName,
        subtitle: N.analysisName + (N.property.address ? ' · ' + N.property.address : ''),
        rightLines: [
          meta.generatedAt ? fmtStamp(meta.generatedAt) : '',
          src ? 'From budget ' + src.projectId + ' v' + src.budgetVersionNumber : 'Standalone Analysis',
          meta.savedVersion ? 'Analysis v' + meta.savedVersion : ''
        ].filter(Boolean),
        footerRight: N.analysisName
      },
      signature: signature,
      sheets: sheets
    };
  }

  /* =============== the approval page (Signature Needed) ===============
     fsdoc/1 deliberately has no signature concept — approval pages are a
     suite policy, so the suite appends them AFTER fs-render builds the
     pdfmake docDefinition. Pure data in, pure data out: this decorates the
     dd's content array with a final identified approval page and never
     touches anything fs-render produced. Works for any producer (the
     investment doc's signature object or the budget's). */
  function appendApprovalPage(dd, sig) {
    if (!sig) return dd;
    var C = { ink900: '#16191A', ink700: '#353B3D', ink600: '#4E5456', ink500: '#6B7174',
      ink200: '#DDE1E2', ink100: '#F1F3F3' };
    var dims = dd.pageOrientation === 'landscape' ? 792 : 612;
    var cw = dims - (dd.pageMargins ? dd.pageMargins[0] + dd.pageMargins[2] : 72);
    dd.content.push({ text: sig.heading, fontSize: 13, bold: true, color: C.ink900,
      pageBreak: 'before', margin: [0, 0, 0, 2] });
    dd.content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: cw, y2: 0,
      lineWidth: 0.8, lineColor: C.ink200 }], margin: [0, 0, 0, 8] });
    dd.content.push({ text: sig.statement, fontSize: 8.5, color: C.ink700, margin: [0, 0, 0, 12] });
    dd.content.push({ table: {
      widths: [200, '*'],
      body: sig.identity.map(function (r) { return [
        { text: r[0], fontSize: 8.5, color: C.ink700 },
        { text: r[1], fontSize: 8.5, bold: true }
      ]; })
    }, layout: {
      hLineWidth: function () { return 0.5; }, hLineColor: function () { return C.ink100; },
      vLineWidth: function () { return 0; },
      paddingTop: function () { return 3; }, paddingBottom: function () { return 3; }
    }, margin: [0, 0, 0, 8] });
    dd.content.push({ columns: [
      { width: 300, stack: [
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 300, y2: 0, lineWidth: 1.1, lineColor: C.ink900 }] },
        { text: 'Signature', fontSize: 7.5, color: C.ink600, margin: [0, 4, 0, 0] }
      ] },
      { width: 42, text: '' },
      { width: 190, stack: [
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 190, y2: 0, lineWidth: 1.1, lineColor: C.ink900 }] },
        { text: 'Date', fontSize: 7.5, color: C.ink600, margin: [0, 4, 0, 0] }
      ] }
    ], margin: [0, 64, 0, 0] });
    return dd;
  }

  /* =============== render provenance ===============
     Stamps WHICH renderer produced a PDF where people actually look: the
     Creator/Producer metadata fields (the ones viewers label "Content
     creator" / "Application", which pdfmake otherwise fills with its own
     name) and a small muted line at the very bottom of the document. Called
     by every PDF call site right after the docDefinition is built. */
  function stampRenderProvenance(dd, renderer) {
    // ASCII, no parentheses: PDF literal strings escape parens and encode
    // non-ASCII as UTF-16, either of which would defeat byte-level checks.
    var label = renderer === 'local'
      ? 'fs-budgeting-suite legacy renderer'
      : 'fs-render engine, fs-courier';
    dd.info = Object.assign({}, dd.info, { creator: label, producer: label + ' · pdfmake' });
    dd.content.push({ text: 'Rendered by ' + label, fontSize: 7, color: '#6B7174',
      margin: [0, 2, 0, 0] });
    return dd;
  }

  return { buildExportDoc: buildExportDoc, appendApprovalPage: appendApprovalPage,
    stampRenderProvenance: stampRenderProvenance, BRAND: BRAND, fmtValue: fmtValue };
});
