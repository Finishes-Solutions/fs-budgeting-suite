/* LEGACY export renderers — the suite's own PDF/XLSX/CSV renderers exactly
   as they shipped before the fs-render cutover, preserved as the FALLBACK
   path behind the FS_EXPORT_RENDERER setting ('local'). They consume the
   same buildExportDoc document (and the budget's legacy producer document)
   the engine path adapts to fsdoc/1, and they render the Signature Needed
   approval page themselves from doc.signature.

   One file, two runtimes: the browser loads it as a plain script (global
   FSLegacyRender) and the API requires it as CommonJS. A copy lives at
   api/shared/investment/legacy-render.js and MUST stay byte-identical —
   test/export-render.test.js fails if the two ever drift.

   Repair playbook: set FS_EXPORT_RENDERER=local (SWA application setting)
   to flip every export back to these renderers while fs-render is being
   fixed; flip to engine (or unset) when done. Do not evolve this file —
   new export work happens in the producers + fs-render. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSLegacyRender = factory();
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

  /* =============== PDF renderer (pdfmake docDefinition) ===============
     Pure data out — the caller hands the definition to pdfMake.createPdf in
     the browser or to a PdfPrinter on the server. Fonts must be registered
     as "Montserrat" in either runtime.

     Reads only the GENERIC parts of the document: meta.eyebrow / title /
     subtitle / rightLines / footerRight / engineLine / highlight, the
     sheets' blocks, and the optional signature. Any producer that fills
     those in (the investment builder above, the budget builder in the app)
     gets the same branded portrait-letter document. */
  function buildPdfDocDefinition(doc) {
    var M = doc.meta, HL = M.highlight;
    var C = {
      ink900: '#16191A', ink700: '#353B3D', ink600: '#4E5456', ink500: '#6B7174',
      ink200: '#DDE1E2', ink100: '#F1F3F3', green: '#006527', hl: '#D8F3E0', white: '#FFFFFF'
    };
    var CW = 532;   // letter portrait 612pt − 2 × 40pt margins
    var content = [];

    // header: identity left, context right
    content.push({ columns: [
      { stack: [
        { text: M.eyebrow || M.product || '', fontSize: 7, characterSpacing: 1, color: C.ink500 },
        { text: M.title || '', fontSize: 16, bold: true, margin: [0, 3, 0, 1] },
        M.subtitle ? { text: M.subtitle, fontSize: 8.5, color: C.ink500 } : null
      ].filter(Boolean) },
      { stack: (M.rightLines || []).map(function (t) {
          return { text: t, alignment: 'right' };
        }), fontSize: 8.5, color: C.ink600, width: 170 }
    ], margin: [0, 0, 0, 12] });

    function groupHead(label) {
      return { stack: [
        { text: label, fontSize: 8, bold: true, color: C.green, characterSpacing: 0.8 },
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: CW, y2: 0, lineWidth: 0.5, lineColor: C.ink200 }],
          margin: [0, 2, 0, 0] }
      ], margin: [0, 8, 0, 4] };
    }

    doc.sheets.forEach(function (sh) {
      if (sh.pdfHidden) return;
      if (sh.key !== 'kpis' && sh.title) {
        content.push({ text: sh.title, fontSize: 11, bold: true, color: C.ink900,
          margin: [0, 12, 0, 2] });
        content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: CW, y2: 0,
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
              { text: t.v, fontSize: 10.5, bold: true, color: C.white }
            ], fillColor: C.ink900, margin: [7, 6, 7, 6] }; }) ]
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
            widths: [210, '*'],
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
          // Wide year/scenario tables drop a point so portrait letter fits.
          var fs = b.headers.length > 6 ? 7 : 8;
          var hfs = b.headers.length > 6 ? 6 : 6.5;
          var headerCells = [{ text: '', border: [false, false, false, true] }]
            .concat(b.headers.map(function (h) {
              return { text: String(h).toUpperCase(), fontSize: hfs, bold: true, color: C.ink600,
                characterSpacing: 0.4, alignment: 'right' };
            }));
          var body = [headerCells].concat(b.rows.map(function (r) {
            // Band rows are full-width scope/group headings carried inside the
            // table so a heading never separates from its lines across pages.
            if (r.band) {
              var dark = r.band === 'dark';
              return [{ text: r.label, fontSize: fs, bold: true,
                color: dark ? C.white : C.ink700, fillColor: dark ? C.ink900 : C.ink100 }]
                .concat(r.values.map(function (v, i) {
                  return { text: v === null || v === undefined ? '' : fmtValue(v, colFmt(r.fmt, i)),
                    fontSize: fs, alignment: 'right', bold: true,
                    color: dark ? C.white : C.ink700, fillColor: dark ? C.ink900 : C.ink100 };
                }));
            }
            var hl = HL && r.hl;
            return [{ text: r.label, fontSize: fs, bold: !!r.total,
              color: r.total ? C.ink900 : C.ink700, fillColor: hl ? C.hl : null }]
              .concat(r.values.map(function (v, i) {
                return { text: fmtValue(v, colFmt(r.fmt, i)), fontSize: fs, alignment: 'right',
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
    if (M.engineLine) {
      content.push({ text: M.engineLine, fontSize: 7.5, color: C.ink500, margin: [0, 16, 0, 0] });
    }

    // Signature Needed: the approval page, always the LAST page.
    if (doc.signature) {
      var sig = doc.signature;
      content.push({ text: sig.heading, fontSize: 13, bold: true, color: C.ink900,
        pageBreak: 'before', margin: [0, 0, 0, 2] });
      content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: CW, y2: 0,
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
    }

    return {
      pageSize: 'LETTER', pageOrientation: 'portrait',
      pageMargins: [40, 42, 40, 46],
      defaultStyle: { font: 'Montserrat', fontSize: 9, color: C.ink900 },
      footer: function (page, pages) {
        return { columns: [
          { text: 'Finishes Solutions — Building a Future Together', fontSize: 7, color: C.ink500 },
          { text: page + ' of ' + pages, alignment: 'center', fontSize: 7, color: C.ink500 },
          { text: M.footerRight || '', alignment: 'right', fontSize: 7, color: C.ink500 }
        ], margin: [40, 14, 40, 0] };
      },
      info: { title: (M.title || 'Report') + ' — Finishes Solutions', author: 'Finishes Solutions Budgeting Suite' },
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

  return { buildPdfDocDefinition: buildPdfDocDefinition, buildWorkbook: buildWorkbook,
    buildCsv: buildCsv };
});
