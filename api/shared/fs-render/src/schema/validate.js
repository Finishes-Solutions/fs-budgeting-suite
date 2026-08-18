'use strict';

/**
 * fsdoc/1 — schema validation.
 *
 * The contract. Any app in any language produces a JSON document of this
 * shape and hands it over the wall; renderers only ever read this shape
 * plus a theme and a preset. The block grammar and format vocabulary are
 * adopted from the fs-budgeting-suite export model (export-render.js),
 * generalized: nothing here knows about investments, budgets, or any app.
 *
 * Discipline rule: ADDITIVE CHANGES ONLY within fsdoc/1 (new optional
 * fields, new block kinds, new formats). Breaking changes mean fsdoc/2,
 * and fsdoc/1 stays renderable forever — saved exports never die.
 *
 * Zero dependencies; runs identically in any browser and any Node service.
 */

const SCHEMA_VERSION = 'fsdoc/1';

const BLOCK_KINDS = new Set([
  'group',       // section heading                  { label }
  'kv',          // label/value list                 { rows:[{k,v,fmt?,total?}], hlKeys?, only? }
  'kpiBand',     // stat tiles band                  { tiles:[{k,v}], only? }
  'matrixTable', // row-major table (fmt per ROW)    { headers:[], rows:[{label,values:[],fmt?,total?,hl?}], only? }
  'table',       // columnar table (fmt per COLUMN)  { columns:[{key,label,fmt?,width?}], rows:[{}], totals?, only? }
  'note',        // small-print paragraph            { text, only? }
  'pageBreak',   // PDF only; ignored elsewhere
  'spacer',      // { height? }
]);

// Finance-native display formats (from the budgeting suite; renderers own
// the exact rendering — e.g. money shows negatives as ($1,234)).
const FORMATS = new Set(['money', 'money2', 'pct', 'rate', 'ratio', 'mult', 'qty']);

// Per-format visibility: 'pdf' = PDF only; 'grid' = workbook/CSV only.
const ONLY = new Set(['pdf', 'grid']);

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function checkOnly(block, path, errors) {
  if (block.only !== undefined && !ONLY.has(block.only)) {
    errors.push(`${path}: "only" must be 'pdf' or 'grid' (got ${JSON.stringify(block.only)})`);
  }
}
function checkFmt(fmt, path, errors) {
  if (fmt !== undefined && fmt !== null && !FORMATS.has(fmt)) {
    errors.push(`${path}: unknown fmt "${fmt}"`);
  }
}

function validateBlock(block, path, errors) {
  if (!isObj(block)) { errors.push(`${path}: block must be an object`); return; }
  if (!BLOCK_KINDS.has(block.kind)) { errors.push(`${path}: unknown block kind "${block.kind}"`); return; }
  checkOnly(block, path, errors);
  switch (block.kind) {
    case 'group': {
      if (typeof block.label !== 'string' || !block.label.length) {
        errors.push(`${path}: group requires non-empty "label"`);
      }
      break;
    }
    case 'kv': {
      if (!Array.isArray(block.rows) || !block.rows.length) {
        errors.push(`${path}: kv requires non-empty "rows"`); break;
      }
      block.rows.forEach((r, i) => {
        if (!isObj(r) || typeof r.k !== 'string') {
          errors.push(`${path}.rows[${i}]: kv row requires string "k" and a "v"`);
          return;
        }
        checkFmt(r.fmt, `${path}.rows[${i}]`, errors);
      });
      if (block.hlKeys !== undefined && !Array.isArray(block.hlKeys)) {
        errors.push(`${path}: "hlKeys", when present, must be an array of row keys`);
      }
      break;
    }
    case 'kpiBand': {
      if (!Array.isArray(block.tiles) || !block.tiles.length) {
        errors.push(`${path}: kpiBand requires non-empty "tiles"`); break;
      }
      block.tiles.forEach((t, i) => {
        if (!isObj(t) || typeof t.k !== 'string' || !('v' in t)) {
          errors.push(`${path}.tiles[${i}]: tile requires "k" and "v"`);
        }
      });
      break;
    }
    case 'matrixTable': {
      if (!Array.isArray(block.headers) || !block.headers.length) {
        errors.push(`${path}: matrixTable requires non-empty "headers"`); break;
      }
      if (!Array.isArray(block.rows)) { errors.push(`${path}: matrixTable requires "rows"`); break; }
      block.rows.forEach((r, i) => {
        if (!isObj(r) || typeof r.label !== 'string' || !Array.isArray(r.values)) {
          errors.push(`${path}.rows[${i}]: row requires "label" and "values" array`);
          return;
        }
        if (r.values.length !== block.headers.length) {
          errors.push(`${path}.rows[${i}]: values length ${r.values.length} !== headers length ${block.headers.length}`);
        }
        checkFmt(r.fmt, `${path}.rows[${i}]`, errors);
      });
      break;
    }
    case 'table': {
      if (!Array.isArray(block.columns) || !block.columns.length) {
        errors.push(`${path}: table requires non-empty "columns"`); break;
      }
      const keys = new Set();
      block.columns.forEach((c, i) => {
        if (!isObj(c) || typeof c.key !== 'string' || typeof c.label !== 'string') {
          errors.push(`${path}.columns[${i}]: column requires string "key" and "label"`);
          return;
        }
        if (keys.has(c.key)) errors.push(`${path}.columns[${i}]: duplicate column key "${c.key}"`);
        keys.add(c.key);
        checkFmt(c.fmt, `${path}.columns[${i}]`, errors);
      });
      if (!Array.isArray(block.rows)) errors.push(`${path}: table requires "rows" array`);
      else block.rows.forEach((r, i) => { if (!isObj(r)) errors.push(`${path}.rows[${i}]: row must be an object`); });
      if (block.totals !== undefined && !isObj(block.totals)) {
        errors.push(`${path}: "totals", when present, must be an object keyed by column key`);
      }
      break;
    }
    case 'note': {
      if (typeof block.text !== 'string') errors.push(`${path}: note requires string "text"`);
      break;
    }
    case 'pageBreak':
    case 'spacer':
      break;
  }
}

/**
 * meta — presentation strings composed by the PRODUCER, laid out by the
 * renderer. This is how per-app headers stay per-app without the renderer
 * knowing any app: the layout is generic, every string is caller-supplied.
 *   title       (required)  main heading (e.g. property name)
 *   eyebrow     small caps line above the title
 *   subline     small line under the title (e.g. analysis · address)
 *   rightLines  [] right-aligned header lines (date, source, version...)
 *   bandLine    workbook brand-band suffix (row 2, after sheet title)
 *   footnote    end-of-document provenance line (engine/version identity)
 *   footerRight PDF footer right slot
 *   highlight   default for the render-time highlight option
 *   docId, generatedAt  free identifiers
 */
function validate(doc) {
  const errors = [];
  if (!isObj(doc)) return { ok: false, errors: ['document must be an object'] };
  if (doc.fsdoc !== '1') errors.push(`"fsdoc" must be "1" (got ${JSON.stringify(doc.fsdoc)})`);
  if (!isObj(doc.meta)) errors.push('"meta" object is required');
  else {
    if (typeof doc.meta.title !== 'string' || !doc.meta.title.length) {
      errors.push('"meta.title" is required and must be a non-empty string');
    }
    if (doc.meta.rightLines !== undefined && !Array.isArray(doc.meta.rightLines)) {
      errors.push('"meta.rightLines", when present, must be an array of strings');
    }
  }
  if (!Array.isArray(doc.sheets) || !doc.sheets.length) {
    errors.push('"sheets" must be a non-empty array');
  } else {
    doc.sheets.forEach((sh, si) => {
      const sp = `sheets[${si}]`;
      if (!isObj(sh)) { errors.push(`${sp}: sheet must be an object`); return; }
      if (typeof sh.name !== 'string' || !sh.name.length) errors.push(`${sp}: sheet requires non-empty "name"`);
      if (!Array.isArray(sh.blocks)) errors.push(`${sp}: sheet requires "blocks" array`);
      else sh.blocks.forEach((b, bi) => validateBlock(b, `${sp}.blocks[${bi}]`, errors));
    });
  }
  return { ok: errors.length === 0, errors };
}

function assertValid(doc) {
  const r = validate(doc);
  if (!r.ok) {
    const err = new Error(`Invalid fsdoc: ${r.errors.join('; ')}`);
    err.code = 'FSDOC_INVALID';
    err.errors = r.errors;
    throw err;
  }
  return doc;
}

module.exports = { SCHEMA_VERSION, BLOCK_KINDS, FORMATS, validate, assertValid };
