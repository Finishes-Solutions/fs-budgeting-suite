'use strict';

const { assertValid } = require('../schema/validate');
const { fmtValue } = require('./format');
const { resolvePreset } = require('../presets');

/**
 * buildPdfDocDefinition(doc, theme, preset?, options?) -> pdfmake docDefinition
 *
 * Pure data out. Browser: hand it to the vendored pdfMake.createPdf (fonts
 * registered via the app's vfs module). Node: hand it to a PdfPrinter
 * constructed with fontDescriptors() from the engine root.
 *
 * The layout is the budgeting suite's proven export design, generalized:
 * header composed from meta strings, group heads with hairline rules, kv
 * tables with total rules and optional highlight, dark kpi tiles with green
 * dividers, matrix tables with uppercase right-aligned column heads. The
 * renderer knows formatting and brand — never content.
 */
const PAGE_DIMS = { LETTER: { w: 612, h: 792 }, A4: { w: 595, h: 842 }, LEGAL: { w: 612, h: 1008 } };

function contentWidth(P) {
  const dims = PAGE_DIMS[P.pageSize] || PAGE_DIMS.LETTER;
  const pageW = P.orientation === 'landscape' ? dims.h : dims.w;
  return pageW - P.margins[0] - P.margins[2];
}

function buildPdfDocDefinition(doc, theme, preset, options) {
  assertValid(doc);
  const P = Object.assign({}, resolvePreset(preset).pdf);
  if (!P.ruleWidth) P.ruleWidth = contentWidth(P); // 720 landscape / 540 portrait LETTER
  const C = theme.palette;
  const O = options || {};
  const HL = O.highlight !== undefined ? !!O.highlight : !!(doc.meta && doc.meta.highlight);
  const M = doc.meta;
  const content = [];

  // ---- header: identity left, context right ----
  content.push({
    columns: [
      { stack: [
        M.eyebrow ? { text: M.eyebrow, fontSize: 7, characterSpacing: 1, color: C.ink500 } : null,
        { text: M.title, fontSize: 17, bold: true, margin: [0, 3, 0, 1] },
        M.subline ? { text: M.subline, fontSize: 8.5, color: C.ink500 } : null,
      ].filter(Boolean) },
      (M.rightLines && M.rightLines.length) ? {
        stack: M.rightLines.map((t) => ({ text: String(t), alignment: 'right' })),
        fontSize: 8.5, color: C.ink600, width: 170,
      } : null,
    ].filter(Boolean),
    margin: [0, 0, 0, 12],
  });

  function groupHead(label) {
    return { stack: [
      { text: label, fontSize: 8, bold: true, color: C.green, characterSpacing: 0.8 },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: P.ruleWidth, y2: 0, lineWidth: 0.5, lineColor: C.ink200 }],
        margin: [0, 2, 0, 0] },
    ], margin: [0, 8, 0, 4] };
  }

  function pushMatrix(headers, rows) {
    const headerCells = [{ text: '', border: [false, false, false, true] }]
      .concat(headers.map((h) => ({
        text: String(h).toUpperCase(), fontSize: 6.5, bold: true, color: C.ink600,
        characterSpacing: 0.5, alignment: 'right',
      })));
    const body = [headerCells].concat(rows.map((r) => {
      const hl = HL && r.hl;
      return [{ text: r.label, fontSize: 8, bold: !!r.total,
        color: r.total ? C.ink900 : C.ink700, fillColor: hl ? C.hl : null }]
        .concat(r.values.map((v) => ({
          text: fmtValue(v, r.fmt), fontSize: 8, alignment: 'right',
          bold: !!r.total, fillColor: hl ? C.hl : null,
        })));
    }));
    content.push({
      table: { headerRows: 1, widths: ['*'].concat(headers.map(() => 'auto')), body },
      layout: {
        hLineWidth: (i) => {
          if (i === 1) return 0.8;
          const r = rows[i - 1];
          return r && r.total ? 1.2 : 0.5;
        },
        hLineColor: (i) => {
          if (i === 1) return C.ink500;
          const r = rows[i - 1];
          return r && r.total ? C.ink900 : C.ink100;
        },
        vLineWidth: () => 0,
        paddingTop: () => 2.5, paddingBottom: () => 2.5,
        paddingLeft: () => 4, paddingRight: () => 4,
      },
      margin: [0, 2, 0, 6],
    });
  }

  doc.sheets.forEach((sh, si) => {
    if (sh.pdfHidden) return;
    if (si > 0 || sh.title) {
      if (si > 0 || (sh.title && doc.sheets.length > 1)) {
        // Sheet section head (first sheet's identity already lives in the header)
        if (si > 0) {
          content.push({ text: sh.title || sh.name, fontSize: 11, bold: true, color: C.ink900, margin: [0, 12, 0, 2] });
          content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: P.ruleWidth, y2: 0, lineWidth: 0.8, lineColor: C.ink200 }],
            margin: [0, 0, 0, 6] });
        }
      }
    }
    sh.blocks.forEach((b) => {
      if (b.only === 'grid') return;
      switch (b.kind) {
        case 'group': content.push(groupHead(b.label)); return;
        case 'note':
          content.push({ text: b.text, fontSize: 7.5, italics: true, color: C.ink500, margin: [0, 2, 0, 4] });
          return;
        case 'kpiBand':
          content.push({ table: {
            widths: b.tiles.map(() => '*'),
            body: [b.tiles.map((t) => ({ stack: [
              { text: String(t.k).toUpperCase(), fontSize: 6.5, characterSpacing: 0.8, color: C.tileLabel, margin: [0, 2, 0, 2] },
              { text: String(t.v), fontSize: 11, bold: true, color: C.white },
            ], fillColor: C.ink900, margin: [8, 6, 8, 6] }))],
          }, layout: {
            hLineWidth: () => 0,
            vLineWidth: (i) => (i === 0 ? 0 : 2),
            vLineColor: () => C.green,
          }, margin: [0, 6, 0, 10] });
          return;
        case 'kv': {
          const hlKeys = HL && b.hlKeys ? b.hlKeys : [];
          content.push({ table: {
            widths: [220, '*'],
            body: b.rows.map((r) => {
              const hl = hlKeys.indexOf(r.k) !== -1;
              return [
                { text: r.k, fontSize: 8.5, color: r.total ? C.ink900 : C.ink700,
                  bold: !!r.total, fillColor: hl ? C.hl : null },
                { text: fmtValue(r.v, r.fmt), fontSize: 8.5, bold: true,
                  alignment: 'left', fillColor: hl ? C.hl : null },
              ];
            }),
          }, layout: {
            hLineWidth: (i) => (b.rows[i] && b.rows[i].total ? 1.2 : 0.5),
            hLineColor: (i) => (b.rows[i] && b.rows[i].total ? C.ink900 : C.ink100),
            vLineWidth: () => 0,
            paddingTop: () => 2.5, paddingBottom: () => 2.5,
          }, margin: [0, 2, 0, 6] });
          return;
        }
        case 'matrixTable':
          pushMatrix(b.headers, b.rows);
          return;
        case 'table': {
          // Columnar tables render through the matrix path: transpose columns
          // into per-row cells with the column's fmt applied per cell.
          const headers = b.columns.slice(1).map((c) => c.label);
          const first = b.columns[0];
          const rows = b.rows.map((r) => ({
            label: fmtValue(r[first.key], first.fmt),
            values: b.columns.slice(1).map((c) => (r[c.key] === undefined ? null : r[c.key])),
            fmt: null, // per-cell fmt handled below via column map — pdfmake path formats per cell
            _cols: b.columns.slice(1),
          }));
          // Custom body honoring per-column fmt:
          const headerCells = [{ text: String(first.label).toUpperCase(), fontSize: 6.5, bold: true,
            color: C.ink600, characterSpacing: 0.5, border: [false, false, false, true] }]
            .concat(headers.map((h) => ({ text: String(h).toUpperCase(), fontSize: 6.5, bold: true,
              color: C.ink600, characterSpacing: 0.5, alignment: 'right' })));
          const body = [headerCells].concat(rows.map((r) => (
            [{ text: r.label, fontSize: 8, color: C.ink700 }]
              .concat(r.values.map((v, ci) => ({
                text: fmtValue(v, r._cols[ci].fmt), fontSize: 8, alignment: 'right',
              })))
          )));
          if (b.totals) {
            body.push([{ text: 'TOTAL', fontSize: 8, bold: true, color: C.ink900 }]
              .concat(b.columns.slice(1).map((c) => ({
                text: c.key in b.totals ? fmtValue(b.totals[c.key], c.fmt) : '',
                fontSize: 8, bold: true, alignment: 'right',
              }))));
          }
          content.push({
            table: { headerRows: 1, widths: ['*'].concat(headers.map(() => 'auto')), body },
            layout: {
              hLineWidth: (i) => (i === 1 ? 0.8 : (b.totals && i === body.length - 1 ? 1.2 : 0.5)),
              hLineColor: (i) => (i === 1 ? C.ink500 : (b.totals && i === body.length - 1 ? C.ink900 : C.ink100)),
              vLineWidth: () => 0,
              paddingTop: () => 2.5, paddingBottom: () => 2.5,
              paddingLeft: () => 4, paddingRight: () => 4,
            },
            margin: [0, 2, 0, 6],
          });
          return;
        }
        case 'pageBreak': content.push({ text: '', pageBreak: 'after' }); return;
        case 'spacer': content.push({ text: '', margin: [0, 0, 0, b.height || 10] }); return;
      }
    });
  });

  if (M.footnote) {
    content.push({ text: M.footnote, fontSize: 7.5, color: C.ink500, margin: [0, 16, 0, 0] });
  }

  return {
    pageSize: P.pageSize,
    pageOrientation: P.orientation,
    pageMargins: P.margins,
    defaultStyle: { font: theme.fonts.display, fontSize: 9, color: C.ink900 },
    footer: (page, pages) => ({ columns: [
      { text: theme.footer.left, fontSize: 7, color: C.ink500 },
      theme.footer.showPageNumbers
        ? { text: page + ' of ' + pages, alignment: 'center', fontSize: 7, color: C.ink500 } : null,
      M.footerRight ? { text: M.footerRight, alignment: 'right', fontSize: 7, color: C.ink500 } : null,
    ].filter(Boolean), margin: [P.margins[0], 12, P.margins[2], 0] }),
    info: { title: M.title, author: theme.band.productLine },
    content,
  };
}

module.exports = { buildPdfDocDefinition };
