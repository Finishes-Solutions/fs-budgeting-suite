// Every investment fixture, run through the real pipeline —
// calculate → buildExportDoc (all sections) → toFsdoc — must produce a
// document the fs-courier engine's own validator accepts with zero errors.
// This is migration step 1's proof: the suite can speak fsdoc/1 today,
// against the actual contract (fs-render is the sibling checkout's engine,
// linked as a file: devDependency), without touching any renderer.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const render = require('../api/shared/investment/export-render');
const { toFsdoc } = require('../api/shared/investment/to-fsdoc');
const { validate, SCHEMA_VERSION } = require('fs-render');

const ALL = { kpis: true, cash: true, sale: true, returns: true, sens: true,
  assumptions: true, highlight: true };
const FIXTURE_DIR = path.join(__dirname, 'fixtures/investment');
const fixtures = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json')).sort();

test('the fixture directory is populated', () => {
  assert.ok(fixtures.length >= 5, 'expected the five reference deals, found ' + fixtures.length);
  assert.strictEqual(SCHEMA_VERSION, 'fsdoc/1');
});

for (const file of fixtures) {
  test('fixture ' + file + ' adapts to a valid fsdoc/1 document', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
    const result = calculateInvestmentAnalysis(fixture.input);
    const doc = render.buildExportDoc(result, ALL,
      { savedVersion: 1, generatedAt: '2026-08-17T00:00:00.000Z' });
    const fsdoc = toFsdoc(doc, { docId: file.replace(/\.json$/, '') + '-v1' });
    const v = validate(fsdoc);
    assert.deepStrictEqual(v.errors, [], file + ' produced validation errors');
    assert.strictEqual(v.ok, true);
    // spot-invariants: the adapter re-shaped, never re-authored
    assert.strictEqual(fsdoc.fsdoc, '1');
    assert.strictEqual(fsdoc.meta.title, doc.meta.propertyName);
    assert.strictEqual(fsdoc.meta.footnote, doc.meta.engineLine);
    assert.strictEqual(fsdoc.sheets.length, doc.sheets.length);
    assert.ok(fsdoc.sheets.every((sh, i) => sh.name === doc.sheets[i].name));
    assert.ok(!JSON.stringify(fsdoc.sheets).includes('"kind":"table"'),
      'row-major tables must all be matrixTable in fsdoc/1');
  });
}
