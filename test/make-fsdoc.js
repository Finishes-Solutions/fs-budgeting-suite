// Writes an adapted fsdoc/1 document for one investment fixture — the
// hand-off artifact for fs-courier (its engine test fixture was generated
// exactly this way). Not a *.test.js file, so the test runner ignores it.
//
//   node test/make-fsdoc.js [fixture-name] [out-path]
//
// Defaults: combo-15ac (the all-sections + sensitivity deal, highlight on)
// to /tmp/suite-export.fsdoc.json. Prints the absolute output path.
'use strict';
const fs = require('fs');
const path = require('path');

const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const render = require('../api/shared/investment/export-render');
const { toFsdoc } = require('../api/shared/investment/to-fsdoc');
const { assertValid } = require('fs-render');

const name = process.argv[2] || 'combo-15ac';
const out = path.resolve(process.argv[3] || '/tmp/suite-export.fsdoc.json');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/investment', name + '.json'), 'utf8'));
const result = calculateInvestmentAnalysis(fixture.input);
const doc = render.buildExportDoc(result,
  { kpis: true, cash: true, sale: true, returns: true, sens: true,
    assumptions: true, highlight: true },
  { savedVersion: 1, generatedAt: new Date().toISOString() });
const fsdoc = assertValid(toFsdoc(doc, { docId: name + '-v1' }));

fs.writeFileSync(out, JSON.stringify(fsdoc, null, 2));
console.log(out);
