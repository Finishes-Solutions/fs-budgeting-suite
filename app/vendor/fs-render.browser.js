"use strict";
var fsRender = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/schema/validate.js
  var require_validate = __commonJS({
    "src/schema/validate.js"(exports2, module2) {
      "use strict";
      var SCHEMA_VERSION2 = "fsdoc/1";
      var BLOCK_KINDS = /* @__PURE__ */ new Set([
        "group",
        // section heading                  { label }
        "kv",
        // label/value list                 { rows:[{k,v,fmt?,total?}], hlKeys?, only? }
        "kpiBand",
        // stat tiles band                  { tiles:[{k,v}], only? }
        "matrixTable",
        // row-major table (fmt per ROW)    { headers:[], rows:[{label,values:[],fmt?,total?,hl?}], only? }
        "table",
        // columnar table (fmt per COLUMN)  { columns:[{key,label,fmt?,width?}], rows:[{}], totals?, only? }
        "note",
        // small-print paragraph            { text, only? }
        "pageBreak",
        // PDF only; ignored elsewhere
        "spacer"
        // { height? }
      ]);
      var FORMATS = /* @__PURE__ */ new Set(["money", "money2", "pct", "rate", "ratio", "mult", "qty"]);
      var ONLY = /* @__PURE__ */ new Set(["pdf", "grid"]);
      function isObj(v) {
        return v !== null && typeof v === "object" && !Array.isArray(v);
      }
      function checkOnly(block, path2, errors) {
        if (block.only !== void 0 && !ONLY.has(block.only)) {
          errors.push(`${path2}: "only" must be 'pdf' or 'grid' (got ${JSON.stringify(block.only)})`);
        }
      }
      function checkFmt(fmt, path2, errors) {
        if (fmt !== void 0 && fmt !== null && !FORMATS.has(fmt)) {
          errors.push(`${path2}: unknown fmt "${fmt}"`);
        }
      }
      function validateBlock(block, path2, errors) {
        if (!isObj(block)) {
          errors.push(`${path2}: block must be an object`);
          return;
        }
        if (!BLOCK_KINDS.has(block.kind)) {
          errors.push(`${path2}: unknown block kind "${block.kind}"`);
          return;
        }
        checkOnly(block, path2, errors);
        switch (block.kind) {
          case "group": {
            if (typeof block.label !== "string" || !block.label.length) {
              errors.push(`${path2}: group requires non-empty "label"`);
            }
            break;
          }
          case "kv": {
            if (!Array.isArray(block.rows) || !block.rows.length) {
              errors.push(`${path2}: kv requires non-empty "rows"`);
              break;
            }
            block.rows.forEach((r, i) => {
              if (!isObj(r) || typeof r.k !== "string") {
                errors.push(`${path2}.rows[${i}]: kv row requires string "k" and a "v"`);
                return;
              }
              checkFmt(r.fmt, `${path2}.rows[${i}]`, errors);
            });
            if (block.hlKeys !== void 0 && !Array.isArray(block.hlKeys)) {
              errors.push(`${path2}: "hlKeys", when present, must be an array of row keys`);
            }
            break;
          }
          case "kpiBand": {
            if (!Array.isArray(block.tiles) || !block.tiles.length) {
              errors.push(`${path2}: kpiBand requires non-empty "tiles"`);
              break;
            }
            block.tiles.forEach((t, i) => {
              if (!isObj(t) || typeof t.k !== "string" || !("v" in t)) {
                errors.push(`${path2}.tiles[${i}]: tile requires "k" and "v"`);
              }
            });
            break;
          }
          case "matrixTable": {
            if (!Array.isArray(block.headers) || !block.headers.length) {
              errors.push(`${path2}: matrixTable requires non-empty "headers"`);
              break;
            }
            if (!Array.isArray(block.rows)) {
              errors.push(`${path2}: matrixTable requires "rows"`);
              break;
            }
            block.rows.forEach((r, i) => {
              if (!isObj(r) || typeof r.label !== "string" || !Array.isArray(r.values)) {
                errors.push(`${path2}.rows[${i}]: row requires "label" and "values" array`);
                return;
              }
              if (r.values.length !== block.headers.length) {
                errors.push(`${path2}.rows[${i}]: values length ${r.values.length} !== headers length ${block.headers.length}`);
              }
              checkFmt(r.fmt, `${path2}.rows[${i}]`, errors);
            });
            break;
          }
          case "table": {
            if (!Array.isArray(block.columns) || !block.columns.length) {
              errors.push(`${path2}: table requires non-empty "columns"`);
              break;
            }
            const keys = /* @__PURE__ */ new Set();
            block.columns.forEach((c, i) => {
              if (!isObj(c) || typeof c.key !== "string" || typeof c.label !== "string") {
                errors.push(`${path2}.columns[${i}]: column requires string "key" and "label"`);
                return;
              }
              if (keys.has(c.key)) errors.push(`${path2}.columns[${i}]: duplicate column key "${c.key}"`);
              keys.add(c.key);
              checkFmt(c.fmt, `${path2}.columns[${i}]`, errors);
            });
            if (!Array.isArray(block.rows)) errors.push(`${path2}: table requires "rows" array`);
            else block.rows.forEach((r, i) => {
              if (!isObj(r)) errors.push(`${path2}.rows[${i}]: row must be an object`);
            });
            if (block.totals !== void 0 && !isObj(block.totals)) {
              errors.push(`${path2}: "totals", when present, must be an object keyed by column key`);
            }
            break;
          }
          case "note": {
            if (typeof block.text !== "string") errors.push(`${path2}: note requires string "text"`);
            break;
          }
          case "pageBreak":
          case "spacer":
            break;
        }
      }
      function validate2(doc) {
        const errors = [];
        if (!isObj(doc)) return { ok: false, errors: ["document must be an object"] };
        if (doc.fsdoc !== "1") errors.push(`"fsdoc" must be "1" (got ${JSON.stringify(doc.fsdoc)})`);
        if (!isObj(doc.meta)) errors.push('"meta" object is required');
        else {
          if (typeof doc.meta.title !== "string" || !doc.meta.title.length) {
            errors.push('"meta.title" is required and must be a non-empty string');
          }
          if (doc.meta.rightLines !== void 0 && !Array.isArray(doc.meta.rightLines)) {
            errors.push('"meta.rightLines", when present, must be an array of strings');
          }
        }
        if (!Array.isArray(doc.sheets) || !doc.sheets.length) {
          errors.push('"sheets" must be a non-empty array');
        } else {
          doc.sheets.forEach((sh, si) => {
            const sp = `sheets[${si}]`;
            if (!isObj(sh)) {
              errors.push(`${sp}: sheet must be an object`);
              return;
            }
            if (typeof sh.name !== "string" || !sh.name.length) errors.push(`${sp}: sheet requires non-empty "name"`);
            if (!Array.isArray(sh.blocks)) errors.push(`${sp}: sheet requires "blocks" array`);
            else sh.blocks.forEach((b, bi) => validateBlock(b, `${sp}.blocks[${bi}]`, errors));
          });
        }
        return { ok: errors.length === 0, errors };
      }
      function assertValid2(doc) {
        const r = validate2(doc);
        if (!r.ok) {
          const err = new Error(`Invalid fsdoc: ${r.errors.join("; ")}`);
          err.code = "FSDOC_INVALID";
          err.errors = r.errors;
          throw err;
        }
        return doc;
      }
      module2.exports = { SCHEMA_VERSION: SCHEMA_VERSION2, BLOCK_KINDS, FORMATS, validate: validate2, assertValid: assertValid2 };
    }
  });

  // src/themes/finishes-solutions.js
  var require_finishes_solutions = __commonJS({
    "src/themes/finishes-solutions.js"(exports2, module2) {
      "use strict";
      module2.exports = {
        name: "finishes-solutions",
        version: 1,
        palette: {
          ink900: "#16191A",
          ink700: "#353B3D",
          ink600: "#4E5456",
          ink500: "#6B7174",
          ink200: "#DDE1E2",
          ink100: "#F1F3F3",
          green: "#006527",
          green50: "#F1F8F4",
          hl: "#D8F3E0",
          // row-highlight tint
          tileLabel: "#9BA1A3",
          // kpi tile label on dark
          white: "#FFFFFF"
        },
        fonts: {
          display: "Montserrat"
          // registered in both runtimes; engine/fonts ships the TTFs for Node
        },
        band: {
          // workbook brand band (rows 1–2)
          productLine: "FINISHES SOLUTIONS",
          row1Fill: "#16191A",
          row2Fill: "#006527"
        },
        footer: {
          left: "Finishes Solutions \u2014 Building a Future Together",
          showPageNumbers: true
        }
      };
    }
  });

  // src/presets/index.js
  var require_presets = __commonJS({
    "src/presets/index.js"(exports2, module2) {
      "use strict";
      var PORTRAIT_PDF = {
        pageSize: "LETTER",
        orientation: "portrait",
        margins: [36, 34, 36, 40]
        // ruleWidth (section underline length) is computed from orientation and
        // margins unless a preset overrides it explicitly.
      };
      var LANDSCAPE_PDF = Object.assign({}, PORTRAIT_PDF, { orientation: "landscape" });
      var XLSX_DEFAULT = {
        orientation: "landscape",
        // workbooks stay landscape — the proven suite layout
        fitToPage: true,
        freezePanes: true,
        brandBand: true,
        widths: { label: 34, labelNoTables: 38, firstWide: 26, rest: 17 },
        footer: true
      };
      var REGISTRY2 = {
        // House default: portrait reports, landscape workbooks.
        default: { pdf: Object.assign({}, PORTRAIT_PDF), xlsx: Object.assign({}, XLSX_DEFAULT) },
        // One-word orientation switches for the PDF path.
        portrait: { pdf: Object.assign({}, PORTRAIT_PDF), xlsx: Object.assign({}, XLSX_DEFAULT) },
        landscape: { pdf: Object.assign({}, LANDSCAPE_PDF), xlsx: Object.assign({}, XLSX_DEFAULT) },
        // The budgeting suite's export layout, pinned independently of default:
        // landscape PDF (wide year-matrix tables), landscape fitted workbook.
        "budget-export": { pdf: Object.assign({}, LANDSCAPE_PDF), xlsx: Object.assign({}, XLSX_DEFAULT) }
      };
      function resolvePreset2(preset) {
        const defaults = REGISTRY2.default;
        if (!preset) return defaults;
        if (typeof preset === "string") {
          const p = REGISTRY2[preset];
          if (!p) {
            const e = new Error(`Unknown preset "${preset}"`);
            e.code = "PRESET_UNKNOWN";
            throw e;
          }
          return p;
        }
        return {
          pdf: Object.assign({}, defaults.pdf, preset.pdf || {}),
          xlsx: Object.assign({}, defaults.xlsx, preset.xlsx || {})
        };
      }
      module2.exports = { REGISTRY: REGISTRY2, resolvePreset: resolvePreset2 };
    }
  });

  // src/renderers/format.js
  var require_format = __commonJS({
    "src/renderers/format.js"(exports2, module2) {
      "use strict";
      function fmtValue2(v, fmt) {
        if (v === null || v === void 0 || v === "") return "\u2014";
        if (typeof v === "string") return v;
        switch (fmt) {
          case "money":
            return v < 0 ? "($" + Math.round(Math.abs(v)).toLocaleString("en-US") + ")" : "$" + Math.round(v).toLocaleString("en-US");
          case "money2":
            return (v < 0 ? "\u2212$" : "$") + Math.abs(v).toLocaleString(
              "en-US",
              { minimumFractionDigits: 2, maximumFractionDigits: 2 }
            );
          case "pct":
            return (v * 100).toFixed(2) + "%";
          case "rate":
            return (v * 100).toFixed(3) + "%";
          case "ratio":
            return v.toFixed(2);
          case "mult":
            return v.toFixed(2) + "x";
          case "qty":
            return Math.round(v).toLocaleString("en-US");
          default:
            return String(v);
        }
      }
      var XLSX_FMT2 = {
        money: '"$"#,##0',
        money2: '"$"#,##0.00',
        pct: "0.00%",
        rate: "0.000%",
        ratio: "0.00",
        mult: '0.00"x"',
        qty: "#,##0"
      };
      module2.exports = { fmtValue: fmtValue2, XLSX_FMT: XLSX_FMT2 };
    }
  });

  // src/renderers/pdf.js
  var require_pdf = __commonJS({
    "src/renderers/pdf.js"(exports2, module2) {
      "use strict";
      var { assertValid: assertValid2 } = require_validate();
      var { fmtValue: fmtValue2 } = require_format();
      var { resolvePreset: resolvePreset2 } = require_presets();
      var PAGE_DIMS = { LETTER: { w: 612, h: 792 }, A4: { w: 595, h: 842 }, LEGAL: { w: 612, h: 1008 } };
      function contentWidth(P) {
        const dims = PAGE_DIMS[P.pageSize] || PAGE_DIMS.LETTER;
        const pageW = P.orientation === "landscape" ? dims.h : dims.w;
        return pageW - P.margins[0] - P.margins[2];
      }
      function buildPdfDocDefinition2(doc, theme, preset, options) {
        assertValid2(doc);
        const P = Object.assign({}, resolvePreset2(preset).pdf);
        if (!P.ruleWidth) P.ruleWidth = contentWidth(P);
        const C = theme.palette;
        const O = options || {};
        const HL = O.highlight !== void 0 ? !!O.highlight : !!(doc.meta && doc.meta.highlight);
        const M = doc.meta;
        const content = [];
        content.push({
          columns: [
            { stack: [
              M.eyebrow ? { text: M.eyebrow, fontSize: 7, characterSpacing: 1, color: C.ink500 } : null,
              { text: M.title, fontSize: 17, bold: true, margin: [0, 3, 0, 1] },
              M.subline ? { text: M.subline, fontSize: 8.5, color: C.ink500 } : null
            ].filter(Boolean) },
            M.rightLines && M.rightLines.length ? {
              stack: M.rightLines.map((t) => ({ text: String(t), alignment: "right" })),
              fontSize: 8.5,
              color: C.ink600,
              width: 170
            } : null
          ].filter(Boolean),
          margin: [0, 0, 0, 12]
        });
        function groupHead(label) {
          return { stack: [
            { text: label, fontSize: 8, bold: true, color: C.green, characterSpacing: 0.8 },
            {
              canvas: [{ type: "line", x1: 0, y1: 0, x2: P.ruleWidth, y2: 0, lineWidth: 0.5, lineColor: C.ink200 }],
              margin: [0, 2, 0, 0]
            }
          ], margin: [0, 8, 0, 4] };
        }
        function pushMatrix(headers, rows) {
          const headerCells = [{ text: "", border: [false, false, false, true] }].concat(headers.map((h) => ({
            text: String(h).toUpperCase(),
            fontSize: 6.5,
            bold: true,
            color: C.ink600,
            characterSpacing: 0.5,
            alignment: "right"
          })));
          const body = [headerCells].concat(rows.map((r) => {
            const hl = HL && r.hl;
            return [{
              text: r.label,
              fontSize: 8,
              bold: !!r.total,
              color: r.total ? C.ink900 : C.ink700,
              fillColor: hl ? C.hl : null
            }].concat(r.values.map((v) => ({
              text: fmtValue2(v, r.fmt),
              fontSize: 8,
              alignment: "right",
              bold: !!r.total,
              fillColor: hl ? C.hl : null
            })));
          }));
          content.push({
            table: { headerRows: 1, widths: ["*"].concat(headers.map(() => "auto")), body },
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
              paddingTop: () => 2.5,
              paddingBottom: () => 2.5,
              paddingLeft: () => 4,
              paddingRight: () => 4
            },
            margin: [0, 2, 0, 6]
          });
        }
        doc.sheets.forEach((sh, si) => {
          if (sh.pdfHidden) return;
          if (si > 0 || sh.title) {
            if (si > 0 || sh.title && doc.sheets.length > 1) {
              if (si > 0) {
                content.push({ text: sh.title || sh.name, fontSize: 11, bold: true, color: C.ink900, margin: [0, 12, 0, 2] });
                content.push({
                  canvas: [{ type: "line", x1: 0, y1: 0, x2: P.ruleWidth, y2: 0, lineWidth: 0.8, lineColor: C.ink200 }],
                  margin: [0, 0, 0, 6]
                });
              }
            }
          }
          sh.blocks.forEach((b) => {
            if (b.only === "grid") return;
            switch (b.kind) {
              case "group":
                content.push(groupHead(b.label));
                return;
              case "note":
                content.push({ text: b.text, fontSize: 7.5, italics: true, color: C.ink500, margin: [0, 2, 0, 4] });
                return;
              case "kpiBand":
                content.push({ table: {
                  widths: b.tiles.map(() => "*"),
                  body: [b.tiles.map((t) => ({ stack: [
                    { text: String(t.k).toUpperCase(), fontSize: 6.5, characterSpacing: 0.8, color: C.tileLabel, margin: [0, 2, 0, 2] },
                    { text: String(t.v), fontSize: 11, bold: true, color: C.white }
                  ], fillColor: C.ink900, margin: [8, 6, 8, 6] }))]
                }, layout: {
                  hLineWidth: () => 0,
                  vLineWidth: (i) => i === 0 ? 0 : 2,
                  vLineColor: () => C.green
                }, margin: [0, 6, 0, 10] });
                return;
              case "kv": {
                const hlKeys = HL && b.hlKeys ? b.hlKeys : [];
                content.push({ table: {
                  widths: [220, "*"],
                  body: b.rows.map((r) => {
                    const hl = hlKeys.indexOf(r.k) !== -1;
                    return [
                      {
                        text: r.k,
                        fontSize: 8.5,
                        color: r.total ? C.ink900 : C.ink700,
                        bold: !!r.total,
                        fillColor: hl ? C.hl : null
                      },
                      {
                        text: fmtValue2(r.v, r.fmt),
                        fontSize: 8.5,
                        bold: true,
                        alignment: "left",
                        fillColor: hl ? C.hl : null
                      }
                    ];
                  })
                }, layout: {
                  hLineWidth: (i) => b.rows[i] && b.rows[i].total ? 1.2 : 0.5,
                  hLineColor: (i) => b.rows[i] && b.rows[i].total ? C.ink900 : C.ink100,
                  vLineWidth: () => 0,
                  paddingTop: () => 2.5,
                  paddingBottom: () => 2.5
                }, margin: [0, 2, 0, 6] });
                return;
              }
              case "matrixTable":
                pushMatrix(b.headers, b.rows);
                return;
              case "table": {
                const headers = b.columns.slice(1).map((c) => c.label);
                const first = b.columns[0];
                const rows = b.rows.map((r) => ({
                  label: fmtValue2(r[first.key], first.fmt),
                  values: b.columns.slice(1).map((c) => r[c.key] === void 0 ? null : r[c.key]),
                  fmt: null,
                  // per-cell fmt handled below via column map — pdfmake path formats per cell
                  _cols: b.columns.slice(1)
                }));
                const headerCells = [{
                  text: String(first.label).toUpperCase(),
                  fontSize: 6.5,
                  bold: true,
                  color: C.ink600,
                  characterSpacing: 0.5,
                  border: [false, false, false, true]
                }].concat(headers.map((h) => ({
                  text: String(h).toUpperCase(),
                  fontSize: 6.5,
                  bold: true,
                  color: C.ink600,
                  characterSpacing: 0.5,
                  alignment: "right"
                })));
                const body = [headerCells].concat(rows.map((r) => [{ text: r.label, fontSize: 8, color: C.ink700 }].concat(r.values.map((v, ci) => ({
                  text: fmtValue2(v, r._cols[ci].fmt),
                  fontSize: 8,
                  alignment: "right"
                })))));
                if (b.totals) {
                  body.push([{ text: "TOTAL", fontSize: 8, bold: true, color: C.ink900 }].concat(b.columns.slice(1).map((c) => ({
                    text: c.key in b.totals ? fmtValue2(b.totals[c.key], c.fmt) : "",
                    fontSize: 8,
                    bold: true,
                    alignment: "right"
                  }))));
                }
                content.push({
                  table: { headerRows: 1, widths: ["*"].concat(headers.map(() => "auto")), body },
                  layout: {
                    hLineWidth: (i) => i === 1 ? 0.8 : b.totals && i === body.length - 1 ? 1.2 : 0.5,
                    hLineColor: (i) => i === 1 ? C.ink500 : b.totals && i === body.length - 1 ? C.ink900 : C.ink100,
                    vLineWidth: () => 0,
                    paddingTop: () => 2.5,
                    paddingBottom: () => 2.5,
                    paddingLeft: () => 4,
                    paddingRight: () => 4
                  },
                  margin: [0, 2, 0, 6]
                });
                return;
              }
              case "pageBreak":
                content.push({ text: "", pageBreak: "after" });
                return;
              case "spacer":
                content.push({ text: "", margin: [0, 0, 0, b.height || 10] });
                return;
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
            theme.footer.showPageNumbers ? { text: page + " of " + pages, alignment: "center", fontSize: 7, color: C.ink500 } : null,
            M.footerRight ? { text: M.footerRight, alignment: "right", fontSize: 7, color: C.ink500 } : null
          ].filter(Boolean), margin: [P.margins[0], 12, P.margins[2], 0] }),
          info: { title: M.title, author: theme.band.productLine },
          content
        };
      }
      module2.exports = { buildPdfDocDefinition: buildPdfDocDefinition2 };
    }
  });

  // src/renderers/xlsx.js
  var require_xlsx = __commonJS({
    "src/renderers/xlsx.js"(exports2, module2) {
      "use strict";
      var { assertValid: assertValid2 } = require_validate();
      var { XLSX_FMT: XLSX_FMT2 } = require_format();
      var { resolvePreset: resolvePreset2 } = require_presets();
      function buildWorkbook2(ExcelJSLib, doc, theme, preset) {
        assertValid2(doc);
        const X = resolvePreset2(preset).xlsx;
        const C = theme.palette;
        const M = doc.meta;
        const wb = new ExcelJSLib.Workbook();
        wb.creator = theme.band.productLine;
        wb.created = /* @__PURE__ */ new Date();
        const A = (hex) => "FF" + String(hex).replace("#", "").toUpperCase();
        const F = (n, ov) => Object.assign({ name: theme.fonts.display, size: n, color: { argb: A(C.ink900) } }, ov || {});
        const fillOf = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: A(hex) } });
        const thin = { style: "thin", color: { argb: A(C.ink200) } };
        const box = { top: thin, left: thin, bottom: thin, right: thin };
        const emTop = { style: "medium", color: { argb: A(C.ink900) } };
        doc.sheets.forEach((sh) => {
          const tableSpan = sh.blocks.reduce((m, b) => {
            if (b.only === "pdf") return m;
            if (b.kind === "matrixTable") return Math.max(m, b.headers.length);
            if (b.kind === "table") return Math.max(m, b.columns.length - 1);
            return m;
          }, 0);
          const hasTables = tableSpan > 0;
          const span = 1 + Math.max(2, tableSpan);
          const cols = [{ width: hasTables ? X.widths.label : X.widths.labelNoTables }];
          for (let i = 1; i < span; i++) cols.push({ width: i === 1 && span <= 3 ? X.widths.firstWide : X.widths.rest });
          const wsOpts = {};
          if (X.orientation || X.fitToPage) {
            wsOpts.pageSetup = {
              orientation: X.orientation,
              fitToPage: !!X.fitToPage,
              fitToWidth: 1,
              fitToHeight: 0,
              margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
            };
          }
          if (X.footer) {
            wsOpts.headerFooter = {
              oddFooter: '&L&"' + theme.fonts.display + '"' + theme.footer.left + "&C&P of &N&R" + (M.footerRight || "")
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
            t.alignment = { vertical: "middle", indent: 1 };
            ws.getRow(1).height = 26;
            ws.mergeCells(2, 1, 2, span);
            const u = ws.getCell(2, 1);
            u.value = (sh.title || sh.name) + (M.bandLine ? "   \xB7   " + M.bandLine : "");
            u.font = F(9, { bold: true, color: { argb: A(C.white) } });
            u.fill = fillOf(theme.band.row2Fill);
            u.alignment = { vertical: "middle", indent: 1 };
            ws.getRow(2).height = 18;
            ws.addRow([]);
          }
          sh.blocks.forEach((b) => {
            if (b.only === "pdf") return;
            switch (b.kind) {
              case "group": {
                const r = ws.addRow([b.label]);
                r.getCell(1).font = F(9, { bold: true, color: { argb: A(C.green) } });
                r.getCell(1).border = { bottom: thin };
                ws.mergeCells(r.number, 1, r.number, span);
                return;
              }
              case "note": {
                const nr = ws.addRow([b.text]);
                nr.getCell(1).font = F(8.5, { italic: true, color: { argb: A(C.ink500) } });
                nr.getCell(1).alignment = { wrapText: true, vertical: "top" };
                ws.mergeCells(nr.number, 1, nr.number, span);
                return;
              }
              case "kv": {
                b.rows.forEach((row) => {
                  const r = ws.addRow([row.k, row.v]);
                  if (row.total) {
                    r.eachCell((c) => {
                      c.font = F(11, { bold: true });
                      c.border = { top: emTop };
                    });
                  } else {
                    r.getCell(1).font = F(10, { color: { argb: A(C.ink700) } });
                    r.getCell(2).font = F(10, { bold: true });
                  }
                  if (row.fmt && typeof row.v === "number") r.getCell(2).numFmt = XLSX_FMT2[row.fmt];
                });
                return;
              }
              case "kpiBand":
                return;
              // pdf-native block; producers mark only:'pdf' but be safe either way
              case "matrixTable": {
                const hr = ws.addRow([""].concat(b.headers));
                hr.eachCell((c) => {
                  c.font = F(9, { bold: true, color: { argb: A(C.white) } });
                  c.fill = fillOf(C.ink700);
                  c.border = box;
                  c.alignment = { vertical: "middle", wrapText: true };
                });
                hr.height = 20;
                if (X.freezePanes && (!ws.views || !ws.views.length)) {
                  ws.views = [{ state: "frozen", xSplit: 1, ySplit: hr.number }];
                }
                b.rows.forEach((row) => {
                  const r = ws.addRow([row.label].concat(row.values));
                  r.eachCell((c) => {
                    c.border = box;
                  });
                  r.getCell(1).font = row.total ? F(10, { bold: true }) : F(10, { color: { argb: A(C.ink700) } });
                  if (row.total) r.getCell(1).border = Object.assign({}, box, { top: emTop });
                  for (let ci = 2; ci <= row.values.length + 1; ci++) {
                    const c = r.getCell(ci);
                    if (row.fmt) c.numFmt = XLSX_FMT2[row.fmt];
                    c.font = F(10, row.total ? { bold: true } : null);
                    if (row.total) {
                      c.fill = fillOf(C.green50);
                      c.border = Object.assign({}, box, { top: emTop });
                    }
                  }
                });
                return;
              }
              case "table": {
                const hr = ws.addRow(b.columns.map((c) => c.label));
                hr.eachCell((c) => {
                  c.font = F(9, { bold: true, color: { argb: A(C.white) } });
                  c.fill = fillOf(C.ink700);
                  c.border = box;
                  c.alignment = { vertical: "middle", wrapText: true };
                });
                hr.height = 20;
                if (X.freezePanes && (!ws.views || !ws.views.length)) {
                  ws.views = [{ state: "frozen", xSplit: 1, ySplit: hr.number }];
                }
                b.rows.forEach((row) => {
                  const r = ws.addRow(b.columns.map((c) => row[c.key] === void 0 ? null : row[c.key]));
                  r.eachCell((c) => {
                    c.border = box;
                  });
                  b.columns.forEach((c, ci) => {
                    const cell = r.getCell(ci + 1);
                    cell.font = F(10, ci === 0 ? { color: { argb: A(C.ink700) } } : null);
                    if (c.fmt && typeof row[c.key] === "number") cell.numFmt = XLSX_FMT2[c.fmt];
                  });
                });
                if (b.totals) {
                  const r = ws.addRow(b.columns.map((c, i) => c.key in b.totals ? b.totals[c.key] : i === 0 ? "TOTAL" : null));
                  b.columns.forEach((c, ci) => {
                    const cell = r.getCell(ci + 1);
                    cell.font = F(10, { bold: true });
                    cell.fill = fillOf(C.green50);
                    cell.border = Object.assign({}, box, { top: emTop });
                    if (c.fmt && typeof cell.value === "number") cell.numFmt = XLSX_FMT2[c.fmt];
                  });
                }
                return;
              }
              case "spacer":
                ws.addRow([]);
                return;
              case "pageBreak":
                return;
            }
          });
        });
        return wb;
      }
      module2.exports = { buildWorkbook: buildWorkbook2 };
    }
  });

  // src/renderers/csv.js
  var require_csv = __commonJS({
    "src/renderers/csv.js"(exports2, module2) {
      "use strict";
      var { assertValid: assertValid2 } = require_validate();
      function buildCsv2(doc) {
        assertValid2(doc);
        const lines = [];
        const esc = (v) => {
          if (v === null || v === void 0) return "";
          const s = String(v);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const M = doc.meta;
        lines.push(esc(M.title + (M.subline ? " \u2014 " + M.subline : "")));
        lines.push("");
        doc.sheets.forEach((sh) => {
          lines.push(esc("== " + (sh.title || sh.name) + " =="));
          sh.blocks.forEach((b) => {
            if (b.only === "pdf") return;
            if (b.kind === "group") lines.push(esc(b.label));
            else if (b.kind === "note") lines.push(esc(b.text));
            else if (b.kind === "kv") b.rows.forEach((r) => lines.push(esc(r.k) + "," + esc(r.v)));
            else if (b.kind === "matrixTable") {
              lines.push([""].concat(b.headers).map(esc).join(","));
              b.rows.forEach((r) => lines.push([r.label].concat(r.values).map(esc).join(",")));
            } else if (b.kind === "table") {
              lines.push(b.columns.map((c) => esc(c.label)).join(","));
              b.rows.forEach((r) => lines.push(b.columns.map((c) => esc(r[c.key])).join(",")));
              if (b.totals) lines.push(b.columns.map((c, i) => c.key in b.totals ? esc(b.totals[c.key]) : i === 0 ? "TOTAL" : "").join(","));
            }
          });
          lines.push("");
        });
        if (M.footnote) lines.push(esc(M.footnote));
        return lines.join("\r\n");
      }
      module2.exports = { buildCsv: buildCsv2 };
    }
  });

  // src/index.js
  var require_src = __commonJS({
    "src/index.js"(exports, module) {
      var { SCHEMA_VERSION, validate, assertValid } = require_validate();
      var finishesSolutions = require_finishes_solutions();
      var { REGISTRY, resolvePreset } = require_presets();
      var { fmtValue, XLSX_FMT } = require_format();
      var { buildPdfDocDefinition } = require_pdf();
      var { buildWorkbook } = require_xlsx();
      var { buildCsv } = require_csv();
      function fontDescriptors() {
        const nodeRequire = eval("require");
        const path = nodeRequire("path");
        const dir = path.join(__dirname, "..", "fonts");
        return {
          Montserrat: {
            normal: path.join(dir, "Montserrat-Regular.ttf"),
            bold: path.join(dir, "Montserrat-Bold.ttf"),
            italics: path.join(dir, "Montserrat-Regular.ttf"),
            bolditalics: path.join(dir, "Montserrat-Bold.ttf")
          }
        };
      }
      module.exports = {
        SCHEMA_VERSION,
        validate,
        assertValid,
        themes: { "finishes-solutions": finishesSolutions },
        presets: REGISTRY,
        resolvePreset,
        buildPdfDocDefinition,
        buildWorkbook,
        buildCsv,
        fmtValue,
        XLSX_FMT,
        fontDescriptors
      };
    }
  });
  return require_src();
})();
