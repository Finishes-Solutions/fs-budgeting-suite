// Batch-order lint for sql/migrate_impact_fees.sql.
//
// This exists because the script shipped once and failed on the first line with
// "Invalid object name 'dbo.FeeSchedules'". A T-SQL batch is compiled statement
// by statement AS IT RUNS, so a statement that NAMES a table which does not
// exist yet fails outright — even when the CASE around it would never have
// evaluated that branch. The preflight ran before the CREATE TABLE, so it could
// not compile.
//
// The rule, and the whole of what this file checks: a bare reference to one of
// the new tables is legal only after that table's CREATE TABLE — later in the
// same batch, or in a batch after it. A reference inside a string literal is
// always fine, because that is either dynamic SQL (compiled when executed) or
// an OBJECT_ID() argument.
//
// No database is involved. This is a parser, not a substitute for running the
// migration — but it catches the one failure mode that is invisible on disk.
//
//   node --test test/migration-batches.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'sql', 'migrate_impact_fees.sql');
const TABLES = ['dbo.FeeSchedules', 'dbo.FeeScheduleVersions'];

// Remove -- comments and '...' literals (with '' escapes) so only real SQL
// object references remain. Order matters: a quote inside a comment is not a
// literal, so comments go first.
function strip(sql) {
  let out = '', i = 0;
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += "''";
      continue;
    }
    out += sql[i++];
  }
  return out;
}

const batches = strip(fs.readFileSync(FILE, 'utf8'))
  .split(/^\s*GO\s*$/m)
  .map(b => b.trim())
  .filter(Boolean);

// A reference is "bare" when the table name appears outside any string literal.
// Longest-first so FeeScheduleVersions is not counted as a FeeSchedules hit.
function bareRefs(text, table) {
  const rx = new RegExp(table.replace('.', '\\.') + '(?![A-Za-z0-9_])', 'g');
  const hits = [];
  let m;
  while ((m = rx.exec(text)) !== null) hits.push(m.index);
  return hits;
}

test('the script is split into batches — sections cannot share one', () => {
  assert.ok(batches.length >= 3,
    'preflight, migration and verification must be separated by GO; found ' + batches.length + ' batch(es)');
});

for (const table of TABLES) {
  test(`every bare reference to ${table} comes after its CREATE TABLE`, () => {
    const createBatch = batches.findIndex(b => b.includes('CREATE TABLE ' + table));
    assert.notStrictEqual(createBatch, -1, 'CREATE TABLE ' + table + ' not found');
    const createAt = batches[createBatch].indexOf('CREATE TABLE ' + table);

    batches.forEach((batch, bi) => {
      for (const at of bareRefs(batch, table)) {
        if (bi > createBatch) return;              // a later batch: the table exists
        assert.ok(bi === createBatch && at >= createAt,
          `${table} is named in batch ${bi + 1} at offset ${at}, before its CREATE TABLE ` +
          `(batch ${createBatch + 1}). That statement cannot compile. Put it in a later ` +
          `batch, or read it through sp_executesql.\n  ...` +
          batch.slice(Math.max(0, at - 90), at + 60).replace(/\s+/g, ' '));
      }
    });
  });
}

test('the preflight batch names neither new table outside a string', () => {
  // Stated separately from the rule above because it is the specific mistake
  // that shipped: the preflight runs first, so nothing there may name them.
  for (const table of TABLES) {
    assert.strictEqual(bareRefs(batches[0], table).length, 0,
      `the preflight batch names ${table}; it must use OBJECT_ID() or sp_executesql`);
  }
});

test('the migration batch rolls back on failure', () => {
  const mig = batches.find(b => b.includes('BEGIN TRANSACTION'));
  assert.ok(mig, 'no transactional batch found');
  assert.ok(/BEGIN TRY/.test(mig) && /ROLLBACK TRANSACTION/.test(mig),
    'the migration must be wrapped in TRY/CATCH with a rollback');
  assert.ok(/SET XACT_ABORT ON/.test(mig), 'XACT_ABORT must be on');
});
