// The export pipeline after the fs-render cutover: the browser and API
// copies of the PRODUCER files must stay byte-identical, the document model
// must reconcile with the engine result it was built from, and the vendored
// fs-render engine must render real files from the adapted fsdoc/1.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const producer = require('../api/shared/investment/export-render');
const { toFsdoc } = require('../api/shared/investment/to-fsdoc');
const fsRender = require('fs-render');
const THEME = fsRender.themes['finishes-solutions'];

// combo-15ac is the fixture with includeSensitivity: true, so the full
// six-sheet document (sensitivity included) gets exercised.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/investment/combo-15ac.json'), 'utf8'));
const result = calculateInvestmentAnalysis(fixture.input);
const ALL = { kpis: true, cash: true, sale: true, returns: true, sens: true, assumptions: true, highlight: false };
const doc = producer.buildExportDoc(result, ALL, { savedVersion: 3, generatedAt: '2026-08-17T00:00:00.000Z' });
const fsdoc = toFsdoc(doc, { docId: 'combo-15ac-v3' });

test('the app and api copies of the producer files are byte-identical', () => {
  for (const f of ['export-render.js', 'to-fsdoc.js', 'legacy-render.js']) {
    const a = fs.readFileSync(path.join(__dirname, '../app', f), 'utf8');
    const b = fs.readFileSync(path.join(__dirname, '../api/shared/investment', f), 'utf8');
    assert.strictEqual(a, b, 'app/' + f + ' and api/shared/investment/' + f + ' have drifted');
  }
});

test('the legacy fallback still renders all three formats from the same doc', async () => {
  const legacy = require('../api/shared/investment/legacy-render');
  const sd = producer.buildExportDoc(result, Object.assign({}, ALL, { signature: true }),
    { savedVersion: 1, generatedAt: '2026-08-17T00:00:00.000Z' });
  const dd = legacy.buildPdfDocDefinition(sd);
  assert.strictEqual(dd.pageOrientation, 'portrait');
  const s = JSON.stringify(dd);
  assert.match(s, /Approval/);          // the legacy renderer draws the approval page itself
  assert.match(s, /accompanies is void/);
  const ExcelJS = require('exceljs');
  const wb = legacy.buildWorkbook(ExcelJS, sd);
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  assert.deepStrictEqual(wb2.worksheets.map(w => w.name),
    ['Investment Summary', 'Cash Flow', 'Debt and Sale', 'Returns', 'Acquisition Sensitivity', 'Assumptions']);
  assert.strictEqual(wb2.worksheets[0].getCell(1, 1).value, 'FINISHES SOLUTIONS');
  assert.match(legacy.buildCsv(sd), /Net Operating Income/);
});

test('document model reconciles with the canonical engine result', () => {
  assert.deepStrictEqual(doc.sheets.map(s => s.name),
    ['Investment Summary', 'Cash Flow', 'Debt and Sale', 'Returns', 'Acquisition Sensitivity', 'Assumptions']);
  const cash = doc.sheets.find(s => s.key === 'cash').blocks.find(b => b.kind === 'table');
  const noi = cash.rows.find(r => r.label === 'Net Operating Income');
  assert.deepStrictEqual(noi.values, result.annual.map(a => a.netOperatingIncome));
  const cfbt = cash.rows.find(r => r.label === 'Cash Flow Before Taxes');
  assert.deepStrictEqual(cfbt.values, result.annual.map(a => a.cashFlowBeforeTaxes));
  const sale = doc.sheets.find(s => s.key === 'sale').blocks.find(b => b.kind === 'table');
  const gsp = sale.rows.find(r => r.label === 'Gross Sale Price');
  assert.ok(gsp.values.every((v, i) => v === result.annual[i].grossSalePrice && v % 1000 === 0));
  const irr = doc.sheets.find(s => s.key === 'returns').blocks.find(b => b.kind === 'table')
    .rows.find(r => r.label === 'Equity IRR');
  assert.deepStrictEqual(irr.values, result.annual.map(a => a.equityIRR));
  const sensT = doc.sheets.find(s => s.key === 'sens').blocks.find(b => b.kind === 'table');
  assert.deepStrictEqual(sensT.rows.find(r => r.label === 'Purchase Price').values,
    result.sensitivity.map(x => x.purchasePrice));
  const prov = doc.sheets.find(s => s.key === 'assumptions').blocks.filter(b => b.kind === 'kv')
    .flatMap(b => b.rows);
  assert.strictEqual(prov.find(r => r.k === 'Calculation Version').v, result.calculationVersion);
  assert.strictEqual(prov.find(r => r.k === 'Saved Analysis Version').v, 3);
  assert.match(doc.meta.engineLine, /Calculated by engine before-tax-/);
});

test('section options gate the document model', () => {
  const slim = producer.buildExportDoc(result, { kpis: true, cash: false, sale: false,
    returns: true, sens: false, assumptions: false, highlight: true }, {});
  assert.deepStrictEqual(slim.sheets.map(s => s.key), ['kpis', 'returns', 'assumptions']);
  assert.strictEqual(slim.sheets.find(s => s.key === 'assumptions').pdfHidden, true);
  assert.strictEqual(slim.meta.highlight, true);
});

test('the adapted fsdoc validates against the engine contract', () => {
  const v = fsRender.validate(fsdoc);
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.ok, true);
});

test('fs-render produces a real branded PDF, portrait for five-year docs', async () => {
  const dd = fsRender.buildPdfDocDefinition(fsdoc, THEME, 'portrait');
  assert.strictEqual(dd.defaultStyle.font, 'Montserrat');
  assert.strictEqual(dd.pageOrientation, 'portrait');
  const PdfPrinter = require('pdfmake');
  const F = f => path.join(__dirname, '../api/shared/fonts', f);
  const printer = new PdfPrinter({ Montserrat: {
    normal: F('Montserrat-Regular.ttf'), bold: F('Montserrat-Bold.ttf'),
    italics: F('Montserrat-Regular.ttf'), bolditalics: F('Montserrat-Bold.ttf') } });
  const buf = await new Promise((resolve, reject) => {
    const d = printer.createPdfKitDocument(dd);
    const chunks = [];
    d.on('data', c => chunks.push(c));
    d.on('end', () => resolve(Buffer.concat(chunks)));
    d.on('error', reject);
    d.end();
  });
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 30000, 'suspiciously small PDF: ' + buf.length + ' bytes');
  assert.match(buf.toString('latin1'), /MediaBox\s*\[\s*0\s+0\s+612\s+792/);
});

test('ten-year documents take the landscape preset (11 matrix columns)', () => {
  const input10 = JSON.parse(JSON.stringify(fixture.input));
  input10.projection.years = 10;
  if (input10.financing && input10.financing.loans && input10.financing.loans[0]) {
    input10.financing.loans[0].termYears = 10;
  }
  const r10 = calculateInvestmentAnalysis(input10);
  const d10 = producer.buildExportDoc(r10, ALL, {});
  assert.strictEqual(d10.meta.years, 10);
  const dd = fsRender.buildPdfDocDefinition(toFsdoc(d10), THEME,
    d10.meta.years > 5 ? 'landscape' : 'portrait');
  assert.strictEqual(dd.pageOrientation, 'landscape');
});

test('fs-render produces the six branded sheets', async () => {
  const ExcelJS = require('exceljs');
  const wb = fsRender.buildWorkbook(ExcelJS, fsdoc, THEME);
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  assert.deepStrictEqual(wb2.worksheets.map(w => w.name),
    ['Investment Summary', 'Cash Flow', 'Debt and Sale', 'Returns', 'Acquisition Sensitivity', 'Assumptions']);
  wb2.eachSheet(ws => assert.strictEqual(ws.getCell(1, 1).value, 'FINISHES SOLUTIONS', ws.name));
  let noiRow = null;
  wb2.getWorksheet('Cash Flow').eachRow(r => {
    if (r.getCell(1).value === 'Net Operating Income') noiRow = r.values.slice(2);
  });
  assert.ok(noiRow && noiRow.every((v, i) => Math.abs(v - result.annual[i].netOperatingIncome) < 0.01));
  assert.strictEqual((wb2.model.media || []).length, 0, 'workbook must stay media-free');
});

test('Signature Needed appends the identified approval page after the engine renders', () => {
  const sd = producer.buildExportDoc(result, Object.assign({}, ALL, { signature: true }),
    { savedVersion: 2, generatedAt: '2026-08-17T00:00:00.000Z' });
  assert.strictEqual(sd.signature.heading, 'Approval');
  const ids = Object.fromEntries(sd.signature.identity);
  assert.strictEqual(ids['Saved Analysis Version'], 'v2');
  assert.strictEqual(ids['Analysis'], result.normalizedInput.analysisName);
  assert.match(ids['Calculation Engine'], /before-tax-/);
  assert.match(ids['Purchase Price'], /^\$/);
  const dd = fsRender.buildPdfDocDefinition(toFsdoc(sd), THEME, 'portrait');
  const before = JSON.stringify(dd);
  assert.ok(!before.includes('Approval'), 'the engine itself must not render approval pages');
  producer.appendApprovalPage(dd, sd.signature);
  const after = JSON.stringify(dd);
  assert.match(after, /Approval/);
  assert.match(after, /"Signature"/);
  assert.match(after, /"Date"/);
  assert.match(after, /accompanies is void/);
  // without the option, no signature block and nothing appended
  assert.strictEqual(doc.signature, null);
  const clean = fsRender.buildPdfDocDefinition(fsdoc, THEME, 'portrait');
  producer.appendApprovalPage(clean, doc.signature);
  assert.ok(!JSON.stringify(clean).includes('Approval'));
});

test('render provenance stamps the identity fields and a bottom line', () => {
  const dd = fsRender.buildPdfDocDefinition(fsdoc, THEME, 'portrait');
  producer.stampRenderProvenance(dd, 'engine');
  assert.strictEqual(dd.info.creator, 'fs-render engine, fs-courier');
  assert.match(dd.info.producer, /fs-render engine, fs-courier · pdfmake/);
  assert.match(JSON.stringify(dd.content[dd.content.length - 1]), /Rendered by fs-render/);
  const legacyMod = require('../api/shared/investment/legacy-render');
  const ldd = legacyMod.buildPdfDocDefinition(doc);
  producer.stampRenderProvenance(ldd, 'local');
  assert.strictEqual(ldd.info.creator, 'fs-budgeting-suite legacy renderer');
  assert.match(JSON.stringify(ldd.content[ldd.content.length - 1]), /Rendered by fs-budgeting-suite legacy renderer/);
});

test('CSV carries the tables and the engine line', () => {
  const csv = fsRender.buildCsv(fsdoc);
  assert.match(csv, /Net Operating Income/);
  assert.match(csv, /Gross Sale Price/);
  assert.match(csv, /Calculation Version,before-tax-/);
  assert.match(csv, /Calculated by engine before-tax-/);
  const noiLine = csv.split('\r\n').find(l => l.startsWith('Net Operating Income'));
  assert.strictEqual(noiLine.split(',').length, 1 + result.annual.length);
});
