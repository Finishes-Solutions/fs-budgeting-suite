// Pro forma golden regression — the budgeting-v2 upgrade's safety net.
//
// Seven realistic deals were run through the investment (pro forma) engine on
// staging @ 63ef1a4, before any upgrade code changed, and the complete result
// was frozen in test/fixtures/proforma-golden/. The upgrade may change how the
// engine RECEIVES inputs; it may not change the engine's math or behaviour. So
// every field of every result must reproduce exactly — no tolerance.
//
// Never re-capture these to make a failure go away (tools/capture-proforma-golden.js
// header): a difference here is an engine change, and that is a decision.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const { annualRows } = require('../api/shared/investment/result-rows');

const DIR = path.join(__dirname, 'fixtures', 'proforma-golden');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort();

test('at least five golden deals are present', () => {
  assert.ok(files.length >= 5, 'found ' + files.length);
});

for (const f of files) {
  test('pro forma golden: ' + f.replace(/\.json$/, ''), () => {
    const g = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    // JSON round-trip on both sides so -0/undefined serialise identically.
    const out = JSON.parse(JSON.stringify(calculateInvestmentAnalysis(g.input)));
    assert.deepStrictEqual(out, g.output);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(annualRows(out))), g.annualRows);
  });
}
