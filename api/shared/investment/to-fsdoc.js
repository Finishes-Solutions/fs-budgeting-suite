/* toFsdoc(doc[, extra]) — adapt a buildExportDoc() document to fsdoc/1,
   the fs-courier document contract (api/shared/fs-render/src/schema/validate.js).

   One file, two runtimes: the browser loads it as a plain script (it hangs
   off window.FSToFsdoc) and the API requires it as CommonJS. A copy lives at
   app/to-fsdoc.js and MUST stay byte-identical — test/export-render.test.js
   fails if the two ever drift.

   The adapter is deliberately thin: buildExportDoc stays the single content
   authority, and this file only re-shapes its output — it composes the
   fsdoc meta strings from the doc's meta fields and renames the row-major
   'table' block kind to fsdoc's 'matrixTable' (headers and rows travel
   verbatim). group / kv / kpiBand / note blocks pass through unchanged, and
   sheets keep their key / name / title / pdfHidden. Nothing here reads the
   engine result, recalculates, or invents content.

   extra.docId (optional) — a caller-supplied identifier (e.g. the analysis
   GUID plus version); omitted from the output when absent. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSToFsdoc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toFsdoc(doc, extra) {
    var M = doc.meta;
    var e = extra || {};
    var subline = M.analysisName + (M.address ? ' · ' + M.address : '');

    var meta = {
      title: M.propertyName,
      eyebrow: M.product + ' · INVESTMENT ANALYSIS · ' + M.years + '-YEAR BEFORE-TAX',
      subline: subline,
      rightLines: [
        M.generatedAt ? String(M.generatedAt).slice(0, 10) : '',
        M.sourceLine,
        M.savedVersion ? 'Analysis v' + M.savedVersion : ''
      ].filter(Boolean),
      bandLine: M.propertyName + ' · ' + M.years + '-Year Before-Tax',
      footnote: M.engineLine,
      footerRight: M.analysisName,
      generatedAt: M.generatedAt,
      highlight: !!M.highlight
    };
    var docId = e.docId !== undefined ? e.docId : M.docId;
    if (docId !== undefined) meta.docId = docId;

    var sheets = doc.sheets.map(function (sh) {
      var out = { key: sh.key, name: sh.name, title: sh.title };
      if (sh.pdfHidden !== undefined) out.pdfHidden = sh.pdfHidden;
      out.blocks = sh.blocks.map(function (b) {
        if (b.kind !== 'table') return b;   // group / kv / kpiBand / note: unchanged
        var t = Object.assign({}, b, { kind: 'matrixTable' });
        return t;
      });
      return out;
    });

    return { fsdoc: '1', meta: meta, sheets: sheets };
  }

  return { toFsdoc: toFsdoc };
});
