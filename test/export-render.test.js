// The shared export renderer: the browser copy and the API copy must be
// byte-identical, the document model must reconcile with the engine result
// it was built from, and each renderer must produce a real file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const render = require('../api/shared/investment/export-render');

// combo-15ac is the fixture with includeSensitivity: true, so the full
// six-sheet document (sensitivity included) gets exercised.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/investment/combo-15ac.json'), 'utf8'));
const result = calculateInvestmentAnalysis(fixture.input);
const ALL = { kpis: true, cash: true, sale: true, returns: true, sens: true, assumptions: true, highlight: false };
const doc = render.buildExportDoc(result, ALL, { savedVersion: 3, generatedAt: '2026-08-17T00:00:00.000Z' });

test('the app and api copies of export-render.js are byte-identical', () => {
  const a = fs.readFileSync(path.join(__dirname, '../app/export-render.js'), 'utf8');
  const b = fs.readFileSync(path.join(__dirname, '../api/shared/investment/export-render.js'), 'utf8');
  assert.strictEqual(a, b, 'app/export-render.js and api/shared/investment/export-render.js have drifted');
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
  const slim = render.buildExportDoc(result, { kpis: true, cash: false, sale: false,
    returns: true, sens: false, assumptions: false, highlight: true }, {});
  assert.deepStrictEqual(slim.sheets.map(s => s.key), ['kpis', 'returns', 'assumptions']);
  assert.strictEqual(slim.sheets.find(s => s.key === 'assumptions').pdfHidden, true);
  assert.strictEqual(slim.meta.highlight, true);
});

test('PDF renderer produces a real branded PDF', async () => {
  const PdfPrinter = require('pdfmake');
  const F = f => path.join(__dirname, '../api/shared/fonts', f);
  const printer = new PdfPrinter({ Montserrat: {
    normal: F('Montserrat-Regular.ttf'), bold: F('Montserrat-Bold.ttf'),
    italics: F('Montserrat-Regular.ttf'), bolditalics: F('Montserrat-Bold.ttf') } });
  const dd = render.buildPdfDocDefinition(doc);
  assert.strictEqual(dd.defaultStyle.font, 'Montserrat');
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
});

test('XLSX renderer produces the six branded sheets', async () => {
  const ExcelJS = require('exceljs');
  const wb = render.buildWorkbook(ExcelJS, doc);
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

test('CSV renderer carries the tables and the engine line', () => {
  const csv = render.buildCsv(doc);
  assert.match(csv, /Net Operating Income/);
  assert.match(csv, /Gross Sale Price/);
  assert.match(csv, /Calculation Version,before-tax-/);
  assert.match(csv, /Calculated by engine before-tax-/);
  const noiLine = csv.split('\r\n').find(l => l.startsWith('Net Operating Income'));
  assert.strictEqual(noiLine.split(',').length, 1 + result.annual.length);
});
