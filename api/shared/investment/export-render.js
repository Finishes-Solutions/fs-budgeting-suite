/* Investment analysis export renderer — the shared document model and the
   per-format renderers (PDF via pdfmake, XLSX via ExcelJS, CSV as text).
   One file, two runtimes: the browser loads it as a plain script (it hangs
   off window.FSExportRender) and the API requires it as CommonJS. A copy
   lives at api/shared/investment/export-render.js and MUST stay byte-identical
   — test/export-render.test.js fails the build if the two ever drift.

   Layering rule: buildExportDoc knows finance and content; the renderers
   know only formatting and brand. New formats add a renderer, never a
   second content builder. Everything reads the canonical engine result —
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

  /* ---- display formatting (strings for PDF/CSV headers; XLSX keeps numbers) */
  function fmtValue(v, fmt) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'string') return v;
    switch (fmt) {
      case 'money': return v < 0 ? '($' + Math.round(Math.abs(v)).toLocaleString('en-US') + ')'
        : '$' + Math.round(v).toLocaleString('en-US');
      case 'money2': return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'pct': return (v * 100).toFixed(2) + '%';
      case 'rate': return (v * 100).toFixed(3) + '%';
      case 'ratio': return v.toFixed(2);
      case 'mult': return v.toFixed(2) + 'x';
      case 'qty': return Math.round(v).toLocaleString('en-US');
      default: return String(v);
    }
  }
  var XLSX_FMT = {
    money: '"$"#,##0', money2: '"$"#,##0.00', pct: '0.00%', rate: '0.000%',
    ratio: '0.00', mult: '0.00"x"', qty: '#,##0'
  };

  function pcts(v) { return (v * 100).toFixed(2) + '%'; }

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
        kvRow('Generated', meta.generatedAt || '')
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
          ['Generated', meta.generatedAt || '']
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
        highlight: !!o.highlight
      },
      signature: signature,
      sheets: sheets
    };
  }

  /* =============== PDF renderer (pdfmake docDefinition) ===============
     Pure data out — the caller hands the definition to pdfMake.createPdf in
     the browser or to a PdfPrinter on the server. Fonts must be registered
     as "Montserrat" in either runtime. */
  function buildPdfDocDefinition(doc) {
    var M = doc.meta, HL = M.highlight;
    var C = {
      ink900: '#16191A', ink700: '#353B3D', ink600: '#4E5456', ink500: '#6B7174',
      ink200: '#DDE1E2', ink100: '#F1F3F3', green: '#006527', hl: '#D8F3E0', white: '#FFFFFF'
    };
    var content = [];

    // header: identity left, date/source/version right
    content.push({ columns: [
      { stack: [
        { text: 'FINISHES SOLUTIONS · INVESTMENT ANALYSIS · ' + M.years + '-YEAR BEFORE-TAX',
          fontSize: 7, characterSpacing: 1, color: C.ink500 },
        { text: M.propertyName, fontSize: 17, bold: true, margin: [0, 3, 0, 1] },
        { text: M.analysisName + (M.address ? ' · ' + M.address : ''), fontSize: 8.5, color: C.ink500 }
      ] },
      { stack: [
        { text: M.generatedAt ? String(M.generatedAt).slice(0, 10) : '', alignment: 'right' },
        { text: M.sourceLine, alignment: 'right' },
        M.savedVersion ? { text: 'Analysis v' + M.savedVersion, alignment: 'right' } : null
      ].filter(Boolean), fontSize: 8.5, color: C.ink600, width: 170 }
    ], margin: [0, 0, 0, 12] });

    function groupHead(label) {
      return { stack: [
        { text: label, fontSize: 8, bold: true, color: C.green, characterSpacing: 0.8 },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 720, y2: 0, lineWidth: 0.5, lineColor: C.ink200 }],
          margin: [0, 2, 0, 0] }
      ], margin: [0, 8, 0, 4] };
    }

    doc.sheets.forEach(function (sh) {
      if (sh.pdfHidden) return;
      if (sh.key !== 'kpis') {
        content.push({ text: sh.title, fontSize: 11, bold: true, color: C.ink900,
          margin: [0, 12, 0, 2] });
        content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 720, y2: 0,
          lineWidth: 0.8, lineColor: C.ink200 }], margin: [0, 0, 0, 6] });
      }
      sh.blocks.forEach(function (b) {
        if (b.only === 'grid') return;
        if (b.kind === 'group') { content.push(groupHead(b.label)); return; }
        if (b.kind === 'note') {
          content.push({ text: b.text, fontSize: 7.5, italics: true, color: C.ink500,
            margin: [0, 2, 0, 4] });
          return;
        }
        if (b.kind === 'kpiBand') {
          content.push({ table: {
            widths: b.tiles.map(function () { return '*'; }),
            body: [ b.tiles.map(function (t) { return { stack: [
              { text: t.k.toUpperCase(), fontSize: 6.5, characterSpacing: 0.8, color: '#9BA1A3', margin: [0, 2, 0, 2] },
              { text: t.v, fontSize: 11, bold: true, color: C.white }
            ], fillColor: C.ink900, margin: [8, 6, 8, 6] }; }) ]
          }, layout: {
            hLineWidth: function () { return 0; },
            vLineWidth: function (i) { return i === 0 ? 0 : 2; },
            vLineColor: function () { return C.green; }
          }, margin: [0, 6, 0, 10] });
          return;
        }
        if (b.kind === 'kv') {
          var hlKeys = HL && b.hlKeys ? b.hlKeys : [];
          content.push({ table: {
            widths: [220, '*'],
            body: b.rows.map(function (r) {
              var hl = hlKeys.indexOf(r.k) !== -1;
              return [
                { text: r.k, fontSize: 8.5, color: r.total ? C.ink900 : C.ink700,
                  bold: !!r.total, fillColor: hl ? C.hl : null },
                { text: fmtValue(r.v, r.fmt), fontSize: 8.5, bold: true,
                  alignment: 'left', fillColor: hl ? C.hl : null }
              ];
            })
          }, layout: {
            hLineWidth: function (i, node) {
              var rows = b.rows;
              return rows[i] && rows[i].total ? 1.2 : 0.5;
            },
            hLineColor: function (i) { return b.rows[i] && b.rows[i].total ? C.ink900 : C.ink100; },
            vLineWidth: function () { return 0; },
            paddingTop: function () { return 2.5; }, paddingBottom: function () { return 2.5; }
          }, margin: [0, 2, 0, 6] });
          return;
        }
        if (b.kind === 'table') {
          var headerCells = [{ text: '', border: [false, false, false, true] }]
            .concat(b.headers.map(function (h) {
              return { text: h.toUpperCase(), fontSize: 6.5, bold: true, color: C.ink600,
                characterSpacing: 0.5, alignment: 'right' };
            }));
          var body = [headerCells].concat(b.rows.map(function (r) {
            var hl = HL && r.hl;
            return [{ text: r.label, fontSize: 8, bold: !!r.total,
              color: r.total ? C.ink900 : C.ink700, fillColor: hl ? C.hl : null }]
              .concat(r.values.map(function (v) {
                return { text: fmtValue(v, r.fmt), fontSize: 8, alignment: 'right',
                  bold: !!r.total, fillColor: hl ? C.hl : null };
              }));
          }));
          content.push({ table: {
            headerRows: 1, widths: ['*'].concat(b.headers.map(function () { return 'auto'; })),
            body: body
          }, layout: {
            hLineWidth: function (i, node) {
              if (i === 1) return 0.8;
              var r = b.rows[i - 1];
              return r && r.total ? 1.2 : 0.5;
            },
            hLineColor: function (i) {
              if (i === 1) return C.ink500;
              var r = b.rows[i - 1];
              return r && r.total ? C.ink900 : C.ink100;
            },
            vLineWidth: function () { return 0; },
            paddingTop: function () { return 2.5; }, paddingBottom: function () { return 2.5; },
            paddingLeft: function () { return 4; }, paddingRight: function () { return 4; }
          }, margin: [0, 2, 0, 6] });
        }
      });
    });

    // engine identity — bottom of the document, nowhere else
    content.push({ text: M.engineLine, fontSize: 7.5, color: C.ink500, margin: [0, 16, 0, 0] });

    // Signature Needed: the approval page, always the LAST page.
    if (doc.signature) {
      var sig = doc.signature;
      content.push({ text: sig.heading, fontSize: 13, bold: true, color: C.ink900,
        pageBreak: 'before', margin: [0, 0, 0, 2] });
      content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 720, y2: 0,
        lineWidth: 0.8, lineColor: C.ink200 }], margin: [0, 0, 0, 8] });
      content.push({ text: sig.statement, fontSize: 8.5, color: C.ink700, margin: [0, 0, 0, 12] });
      content.push({ table: {
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
      content.push({ columns: [
        { width: 330, stack: [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 330, y2: 0, lineWidth: 1.1, lineColor: C.ink900 }] },
          { text: 'Signature', fontSize: 7.5, color: C.ink600, margin: [0, 4, 0, 0] }
        ] },
        { width: 50, text: '' },
        { width: 200, stack: [
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 1.1, lineColor: C.ink900 }] },
          { text: 'Date', fontSize: 7.5, color: C.ink600, margin: [0, 4, 0, 0] }
        ] }
      ], margin: [0, 64, 0, 0] });
    }

    return {
      pageSize: 'LETTER', pageOrientation: 'landscape',
      pageMargins: [36, 34, 36, 40],
      defaultStyle: { font: 'Montserrat', fontSize: 9, color: C.ink900 },
      footer: function (page, pages) {
        return { columns: [
          { text: 'Finishes Solutions — Building a Future Together', fontSize: 7, color: C.ink500 },
          { text: page + ' of ' + pages, alignment: 'center', fontSize: 7, color: C.ink500 },
          { text: M.analysisName, alignment: 'right', fontSize: 7, color: C.ink500 }
        ], margin: [36, 12, 36, 0] };
      },
      info: { title: M.propertyName + ' — Investment Analysis', author: 'Finishes Solutions Budgeting Suite' },
      content: content
    };
  }

  /* =============== XLSX renderer (ExcelJS instance passed in) =============== */
  function buildWorkbook(ExcelJSLib, doc) {
    var M = doc.meta;
    var wb = new ExcelJSLib.Workbook();
    wb.creator = 'Finishes Solutions Budgeting Suite';
    wb.created = new Date();
    var A = function (hex) { return 'FF' + hex; };
    var F = function (n, ov) {
      return Object.assign({ name: 'Montserrat', size: n, color: { argb: A(BRAND.ink900) } }, ov || {});
    };
    var fillOf = function (hex) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: A(hex) } }; };
    var thin = { style: 'thin', color: { argb: A(BRAND.ink200) } };
    var box = { top: thin, left: thin, bottom: thin, right: thin };
    var emTop = { style: 'medium', color: { argb: A(BRAND.ink900) } };

    doc.sheets.forEach(function (sh) {
      var span = 1 + Math.max(2,
        sh.blocks.reduce(function (m, b) { return b.kind === 'table' ? Math.max(m, b.headers.length) : m; }, 0));
      var cols = [{ width: sh.blocks.some(function (b) { return b.kind === 'table'; }) ? 34 : 38 }];
      for (var i = 1; i < span; i++) cols.push({ width: i === 1 && span <= 3 ? 26 : 17 });
      var ws = wb.addWorksheet(sh.name, { pageSetup: { orientation: 'landscape',
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
        headerFooter: { oddFooter: '&L&"Montserrat"Finishes Solutions — Building a Future Together&C&P of &N&R' + (M.analysisName || '') } });
      ws.columns = cols;
      // brand title band
      ws.mergeCells(1, 1, 1, span);
      var t = ws.getCell(1, 1);
      t.value = M.product;
      t.font = F(12, { bold: true, color: { argb: A(BRAND.white) } });
      t.fill = fillOf(BRAND.ink900); t.alignment = { vertical: 'middle', indent: 1 };
      ws.getRow(1).height = 26;
      ws.mergeCells(2, 1, 2, span);
      var u = ws.getCell(2, 1);
      u.value = sh.title + '   ·   ' + M.propertyName + '   ·   ' + M.years + '-Year Before-Tax';
      u.font = F(9, { bold: true, color: { argb: A(BRAND.white) } });
      u.fill = fillOf(BRAND.green); u.alignment = { vertical: 'middle', indent: 1 };
      ws.getRow(2).height = 18;
      ws.addRow([]);

      sh.blocks.forEach(function (b) {
        if (b.only === 'pdf') return;
        if (b.kind === 'group') {
          var r = ws.addRow([b.label]);
          r.getCell(1).font = F(9, { bold: true, color: { argb: A(BRAND.green) } });
          r.getCell(1).border = { bottom: thin };
          ws.mergeCells(r.number, 1, r.number, span);
          return;
        }
        if (b.kind === 'note') {
          var nr = ws.addRow([b.text]);
          nr.getCell(1).font = F(8.5, { italic: true, color: { argb: A(BRAND.ink500) } });
          nr.getCell(1).alignment = { wrapText: true, vertical: 'top' };
          ws.mergeCells(nr.number, 1, nr.number, span);
          return;
        }
        if (b.kind === 'kv') {
          b.rows.forEach(function (row) {
            var r = ws.addRow([row.k, row.v]);
            if (row.total) {
              r.eachCell(function (c) { c.font = F(11, { bold: true }); c.border = { top: emTop }; });
            } else {
              r.getCell(1).font = F(10, { color: { argb: A(BRAND.ink700) } });
              r.getCell(2).font = F(10, { bold: true });
            }
            if (row.fmt && typeof row.v === 'number') r.getCell(2).numFmt = XLSX_FMT[row.fmt];
          });
          return;
        }
        if (b.kind === 'table') {
          var hr = ws.addRow([''].concat(b.headers));
          hr.eachCell(function (c) { c.font = F(9, { bold: true, color: { argb: A(BRAND.white) } });
            c.fill = fillOf(BRAND.ink700); c.border = box; c.alignment = { vertical: 'middle', wrapText: true }; });
          hr.height = 20;
          if (!ws.views || !ws.views.length) ws.views = [{ state: 'frozen', xSplit: 1, ySplit: hr.number }];
          b.rows.forEach(function (row) {
            var r = ws.addRow([row.label].concat(row.values));
            r.eachCell(function (c) { c.border = box; });
            r.getCell(1).font = row.total ? F(10, { bold: true }) : F(10, { color: { argb: A(BRAND.ink700) } });
            if (row.total) r.getCell(1).border = Object.assign({}, box, { top: emTop });
            for (var ci = 2; ci <= row.values.length + 1; ci++) {
              var c = r.getCell(ci);
              if (row.fmt) c.numFmt = XLSX_FMT[row.fmt];
              c.font = F(10, row.total ? { bold: true } : null);
              if (row.total) { c.fill = fillOf(BRAND.green50); c.border = Object.assign({}, box, { top: emTop }); }
            }
          });
        }
      });
    });
    return wb;
  }

  /* =============== CSV renderer ===============
     Raw numbers (fractions for percents) so the file pivots cleanly;
     sections separated by blank lines, one workbook in one file. */
  function buildCsv(doc) {
    var lines = [];
    var esc = function (v) {
      if (v === null || v === undefined) return '';
      var s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    lines.push(esc(doc.meta.product + ' — ' + doc.meta.propertyName + ' — ' + doc.meta.years + '-Year Before-Tax Investment Analysis'));
    lines.push('');
    doc.sheets.forEach(function (sh) {
      lines.push(esc('== ' + sh.title + ' =='));
      sh.blocks.forEach(function (b) {
        if (b.only === 'pdf') return;
        if (b.kind === 'group') lines.push(esc(b.label));
        else if (b.kind === 'note') lines.push(esc(b.text));
        else if (b.kind === 'kv') b.rows.forEach(function (r) { lines.push(esc(r.k) + ',' + esc(r.v)); });
        else if (b.kind === 'table') {
          lines.push([''].concat(b.headers).map(esc).join(','));
          b.rows.forEach(function (r) { lines.push([r.label].concat(r.values).map(esc).join(',')); });
        }
      });
      lines.push('');
    });
    lines.push(esc(doc.meta.engineLine));
    return lines.join('\r\n');
  }

  return { buildExportDoc: buildExportDoc, buildPdfDocDefinition: buildPdfDocDefinition,
    buildWorkbook: buildWorkbook, buildCsv: buildCsv, BRAND: BRAND, XLSX_FMT: XLSX_FMT,
    fmtValue: fmtValue };
});
