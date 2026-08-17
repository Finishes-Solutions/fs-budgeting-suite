'use strict';

/**
 * Presets — per-application LAYOUT behavior as data (the third knob beside
 * doc and theme). Everything here is an option the renderers know how to
 * honor generically; adding a preset requires zero renderer code. Additive
 * discipline applies: new capabilities are new optional fields.
 *
 * Orientation policy: PDF defaults to PORTRAIT (easy printing/reading —
 * the house preference for reports). Wide matrix tables (e.g. 10-year
 * projections, 11+ columns) physically need landscape on LETTER; use the
 * 'landscape' preset or 'budget-export' for those. This is a per-REQUEST
 * choice, never a deployment-wide switch — the host may set a default
 * preset via env (FS_COURIER_DEFAULT_PRESET) but every request can
 * override it.
 */
const PORTRAIT_PDF = {
  pageSize: 'LETTER',
  orientation: 'portrait',
  margins: [36, 34, 36, 40],
  // ruleWidth (section underline length) is computed from orientation and
  // margins unless a preset overrides it explicitly.
};
const LANDSCAPE_PDF = Object.assign({}, PORTRAIT_PDF, { orientation: 'landscape' });

const XLSX_DEFAULT = {
  orientation: 'landscape',   // workbooks stay landscape — the proven suite layout
  fitToPage: true,
  freezePanes: true,
  brandBand: true,
  widths: { label: 34, labelNoTables: 38, firstWide: 26, rest: 17 },
  footer: true,
};

const REGISTRY = {
  // House default: portrait reports, landscape workbooks.
  default: { pdf: Object.assign({}, PORTRAIT_PDF), xlsx: Object.assign({}, XLSX_DEFAULT) },
  // One-word orientation switches for the PDF path.
  portrait: { pdf: Object.assign({}, PORTRAIT_PDF), xlsx: Object.assign({}, XLSX_DEFAULT) },
  landscape: { pdf: Object.assign({}, LANDSCAPE_PDF), xlsx: Object.assign({}, XLSX_DEFAULT) },
  // The budgeting suite's export layout, pinned independently of default:
  // landscape PDF (wide year-matrix tables), landscape fitted workbook.
  'budget-export': { pdf: Object.assign({}, LANDSCAPE_PDF), xlsx: Object.assign({}, XLSX_DEFAULT) },
};

function resolvePreset(preset) {
  const defaults = REGISTRY.default;
  if (!preset) return defaults;
  if (typeof preset === 'string') {
    const p = REGISTRY[preset];
    if (!p) { const e = new Error(`Unknown preset "${preset}"`); e.code = 'PRESET_UNKNOWN'; throw e; }
    return p;
  }
  return {
    pdf: Object.assign({}, defaults.pdf, preset.pdf || {}),
    xlsx: Object.assign({}, defaults.xlsx, preset.xlsx || {}),
  };
}

module.exports = { REGISTRY, resolvePreset };
