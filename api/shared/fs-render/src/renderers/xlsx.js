'use strict';

const { assertValid } = require('../schema/validate');
const { XLSX_FMT } = require('./format');
const { resolvePreset } = require('../presets');

/**
 * buildWorkbook(ExcelJSLib, doc, theme, preset?) -> ExcelJS Workbook
 *
 * ExcelJS is injected (vendored global in the browser, npm dep in Node).
 * Layout behavior — orientation, fitToPage, frozen panes, brand band,
 * widths, footer — comes from the preset; brand comes from the theme;
 * content comes from the doc. Nothing else.
 */
function buildWorkbook(ExcelJSLib, doc, theme, preset) {
  assertValid(doc);
  const X = resolvePreset(preset).xlsx;
  const C = theme.palette;
  const M = doc.meta;
  const wb = new ExcelJSLib.Workbook();
  wb.creator = theme.band.productLine;
  wb.created = new Date();

  const A = (hex) => 'FF' + String(hex).replace('#', '').toUpperCase();
  const F = (n, ov) => Object.assign({ name: theme.fonts.display, size: n, color: { argb: A(C.ink900) } }, ov || {});
  const fillOf = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: A(hex) } });
  const thin = { style: 'thin', color: { argb: A(C.ink200) } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const emTop = { style: 'medium', color: { argb: A(C.ink900) } };

  doc.sheets.forEach((sh) => {
    const tableSpan = sh.blocks.reduce((m, b) => {
      if (b.only === 'pdf') return m;
      if (b.kind === 'matrixTable') return Math.max(m, b.headers.length);
      if (b.kind === 'table') return Math.max(m, b.columns.length - 1);
      return m;
    }, 0);
    const hasTables = tableSpan > 0;
    const span = 1 + Math.max(2, tableSpan);
    const cols = [{ width: hasTables ? X.widths.label : X.widths.labelNoTables }];
    for (let i = 1; i < span; i++) cols.push({ width: i === 1 && span <= 3 ? X.widths.firstWide : X.widths.rest });

    const wsOpts = {};
    if (X.orientation || X.fitToPage) {
      wsOpts.pageSetup = {
        orientation: X.orientation, fitToPage: !!X.fitToPage, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      };
    }
    if (X.footer) {
      wsOpts.headerFooter = {
        oddFooter: '&L&"' + theme.fonts.display + '"' + theme.footer.left + '&C&P of &N&R' + (M.footerRight || ''),
      };
    }
    const ws = wb.addWorksheet(String(sh.name).slice(0, 31), wsOpts);
    ws.columns = cols;

    if (X.brandBand) {
      ws.mergeCells(1, 1, 1, span);
      const t = ws.getCell(1, 1);
      t.value = theme.band.productLine;
      t.font = F(12, { bold: true, color: { argb: A(C.white) } });
      t.fill = fillOf(theme.band.row1Fill);
      t.alignment = { vertical: 'middle', indent: 1 };
      ws.getRow(1).height = 26;
      ws.mergeCells(2, 1, 2, span);
      const u = ws.getCell(2, 1);
      u.value = (sh.title || sh.name) + (M.bandLine ? '   \u00b7   ' + M.bandLine : '');
      u.font = F(9, { bold: true, color: { argb: A(C.white) } });
      u.fill = fillOf(theme.band.row2Fill);
      u.alignment = { vertical: 'middle', indent: 1 };
      ws.getRow(2).height = 18;
      ws.addRow([]);
    }

    sh.blocks.forEach((b) => {
      if (b.only === 'pdf') return;
      switch (b.kind) {
        case 'group': {
          const r = ws.addRow([b.label]);
          r.getCell(1).font = F(9, { bold: true, color: { argb: A(C.green) } });
          r.getCell(1).border = { bottom: thin };
          ws.mergeCells(r.number, 1, r.number, span);
          return;
        }
        case 'note': {
          const nr = ws.addRow([b.text]);
          nr.getCell(1).font = F(8.5, { italic: true, color: { argb: A(C.ink500) } });
          nr.getCell(1).alignment = { wrapText: true, vertical: 'top' };
          ws.mergeCells(nr.number, 1, nr.number, span);
          return;
        }
        case 'kv': {
          b.rows.forEach((row) => {
            const r = ws.addRow([row.k, row.v]);
            if (row.total) {
              r.eachCell((c) => { c.font = F(11, { bold: true }); c.border = { top: emTop }; });
            } else {
              r.getCell(1).font = F(10, { color: { argb: A(C.ink700) } });
              r.getCell(2).font = F(10, { bold: true });
            }
            if (row.fmt && typeof row.v === 'number') r.getCell(2).numFmt = XLSX_FMT[row.fmt];
          });
          return;
        }
        case 'kpiBand':
          return; // pdf-native block; producers mark only:'pdf' but be safe either way
        case 'matrixTable': {
          const hr = ws.addRow([''].concat(b.headers));
          hr.eachCell((c) => {
            c.font = F(9, { bold: true, color: { argb: A(C.white) } });
            c.fill = fillOf(C.ink700); c.border = box;
            c.alignment = { vertical: 'middle', wrapText: true };
          });
          hr.height = 20;
          if (X.freezePanes && (!ws.views || !ws.views.length)) {
            ws.views = [{ state: 'frozen', xSplit: 1, ySplit: hr.number }];
          }
          b.rows.forEach((row) => {
            const r = ws.addRow([row.label].concat(row.values));
            r.eachCell((c) => { c.border = box; });
            r.getCell(1).font = row.total ? F(10, { bold: true }) : F(10, { color: { argb: A(C.ink700) } });
            if (row.total) r.getCell(1).border = Object.assign({}, box, { top: emTop });
            for (let ci = 2; ci <= row.values.length + 1; ci++) {
              const c = r.getCell(ci);
              if (row.fmt) c.numFmt = XLSX_FMT[row.fmt];
              c.font = F(10, row.total ? { bold: true } : null);
              if (row.total) { c.fill = fillOf(C.green50); c.border = Object.assign({}, box, { top: emTop }); }
            }
          });
          return;
        }
        case 'table': {
          const hr = ws.addRow(b.columns.map((c) => c.label));
          hr.eachCell((c) => {
            c.font = F(9, { bold: true, color: { argb: A(C.white) } });
            c.fill = fillOf(C.ink700); c.border = box;
            c.alignment = { vertical: 'middle', wrapText: true };
          });
          hr.height = 20;
          if (X.freezePanes && (!ws.views || !ws.views.length)) {
            ws.views = [{ state: 'frozen', xSplit: 1, ySplit: hr.number }];
          }
          b.rows.forEach((row) => {
            const r = ws.addRow(b.columns.map((c) => (row[c.key] === undefined ? null : row[c.key])));
            r.eachCell((c) => { c.border = box; });
            b.columns.forEach((c, ci) => {
              const cell = r.getCell(ci + 1);
              cell.font = F(10, ci === 0 ? { color: { argb: A(C.ink700) } } : null);
              if (c.fmt && typeof row[c.key] === 'number') cell.numFmt = XLSX_FMT[c.fmt];
            });
          });
          if (b.totals) {
            const r = ws.addRow(b.columns.map((c, i) => (c.key in b.totals ? b.totals[c.key] : (i === 0 ? 'TOTAL' : null))));
            b.columns.forEach((c, ci) => {
              const cell = r.getCell(ci + 1);
              cell.font = F(10, { bold: true });
              cell.fill = fillOf(C.green50);
              cell.border = Object.assign({}, box, { top: emTop });
              if (c.fmt && typeof cell.value === 'number') cell.numFmt = XLSX_FMT[c.fmt];
            });
          }
          return;
        }
        case 'spacer': ws.addRow([]); return;
        case 'pageBreak': return;
      }
    });
  });
  return wb;
}

module.exports = { buildWorkbook };
