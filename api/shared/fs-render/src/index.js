'use strict';

const { SCHEMA_VERSION, validate, assertValid } = require('./schema/validate');
const finishesSolutions = require('./themes/finishes-solutions');
const { REGISTRY, resolvePreset } = require('./presets');
const { fmtValue, XLSX_FMT } = require('./renderers/format');
const { buildPdfDocDefinition } = require('./renderers/pdf');
const { buildWorkbook } = require('./renderers/xlsx');
const { buildCsv } = require('./renderers/csv');

/**
 * Node-side pdfmake font descriptors pointing at the TTFs this package
 * ships (engine/fonts). Browser consumers use their vendored vfs module
 * instead (e.g. the budgeting suite's fs-pdf-fonts.js).
 */
function fontDescriptors() {
  // Node-only: the browser path is a vendored vfs module, not TTF files.
  // Indirect require so esbuild leaves this alone in the browser bundle
  // (calling fontDescriptors() in a browser throws, which is correct).
  const nodeRequire = eval('require');
  const path = nodeRequire('path');
  const dir = path.join(__dirname, '..', 'fonts');
  return {
    Montserrat: {
      normal: path.join(dir, 'Montserrat-Regular.ttf'),
      bold: path.join(dir, 'Montserrat-Bold.ttf'),
      italics: path.join(dir, 'Montserrat-Regular.ttf'),
      bolditalics: path.join(dir, 'Montserrat-Bold.ttf'),
    },
  };
}

module.exports = {
  SCHEMA_VERSION, validate, assertValid,
  themes: { 'finishes-solutions': finishesSolutions },
  presets: REGISTRY, resolvePreset,
  buildPdfDocDefinition, buildWorkbook, buildCsv,
  fmtValue, XLSX_FMT, fontDescriptors,
};
