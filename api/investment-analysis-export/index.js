// GET /api/investment-analysis/{id}/export?format=pdf|xlsx|csv[&version=N][&signature=1]
//
// Server-side rendering of the SAVED analysis through the same pipeline the
// browser uses: the shared producer (export-render.js) builds the content
// document, to-fsdoc adapts it to fsdoc/1, and the vendored fs-render engine
// (api/shared/fs-render — fs-courier's renderer) lays it out. Renders the
// current ResultDoc by default, or an exact immutable version when
// ?version=N is given. Nothing is ever recalculated. All sections are always
// included: a server export is the canonical, complete record.
const path = require('path');
const { getPool, sql } = require('../shared/db');
const { GUID_RX, jsonRes } = require('../shared/investment-persistence');
const producer = require('../shared/investment/export-render');
const { toFsdoc } = require('../shared/investment/to-fsdoc');
const fsRender = require('../shared/fs-render/src/index');

const FORMATS = {
  pdf: { mime: 'application/pdf', ext: 'pdf' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  csv: { mime: 'text/csv; charset=utf-8', ext: 'csv' }
};
const ALL_SECTIONS = { kpis: true, cash: true, sale: true, returns: true,
  sens: true, assumptions: true, highlight: false, signature: false };
const THEME = fsRender.themes['finishes-solutions'];

// The engine's fontDescriptors() points at its own fonts dir, which the
// vendored copy does not carry — the suite already ships the same subset
// TTFs in api/shared/fonts.
const FONTS = {
  Montserrat: {
    normal: path.join(__dirname, '../shared/fonts/Montserrat-Regular.ttf'),
    bold: path.join(__dirname, '../shared/fonts/Montserrat-Bold.ttf'),
    italics: path.join(__dirname, '../shared/fonts/Montserrat-Regular.ttf'),
    bolditalics: path.join(__dirname, '../shared/fonts/Montserrat-Bold.ttf')
  }
};

function pdfBuffer(dd) {
  const PdfPrinter = require('pdfmake');
  const printer = new PdfPrinter(FONTS);
  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(dd);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

module.exports = async function (context, req) {
  const id = (context.bindingData.id || '').toLowerCase();
  if (!GUID_RX.test(id)) { context.res = jsonRes(400, { error: 'bad_request', message: 'Invalid analysis ID.' }); return; }
  const format = String((req.query && req.query.format) || 'pdf').toLowerCase();
  const spec = FORMATS[format];
  if (!spec) { context.res = jsonRes(400, { error: 'bad_request', message: 'format must be pdf, xlsx or csv.' }); return; }
  const versionParam = req.query && req.query.version;
  if (versionParam !== undefined && versionParam !== '' && !/^\d+$/.test(String(versionParam))) {
    context.res = jsonRes(400, { error: 'bad_request', message: 'version must be a positive integer.' }); return;
  }

  const pool = await getPool();
  let resultDoc, savedVersion, analysisName;
  if (versionParam) {
    const r = await pool.request()
      .input('id', sql.UniqueIdentifier, id)
      .input('vn', sql.Int, parseInt(versionParam, 10))
      .query(`SELECT v.VersionNumber, v.ResultDoc, v.Name
              FROM dbo.InvestmentAnalysisVersions v
              JOIN dbo.InvestmentAnalyses a ON a.AnalysisId = v.AnalysisId AND a.IsDeleted = 0
              WHERE v.AnalysisId = @id AND v.VersionNumber = @vn`);
    if (!r.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Version not found.' }); return; }
    resultDoc = r.recordset[0].ResultDoc;
    savedVersion = r.recordset[0].VersionNumber;
    analysisName = r.recordset[0].Name;
  } else {
    const r = await pool.request().input('id', sql.UniqueIdentifier, id)
      .query(`SELECT Name, CurrentVersionNumber, ResultDoc
              FROM dbo.InvestmentAnalyses WHERE AnalysisId = @id AND IsDeleted = 0`);
    if (!r.recordset.length) { context.res = jsonRes(404, { error: 'not_found', message: 'Not found' }); return; }
    resultDoc = r.recordset[0].ResultDoc;
    savedVersion = r.recordset[0].CurrentVersionNumber;
    analysisName = r.recordset[0].Name;
  }
  if (!resultDoc) {
    context.res = jsonRes(409, { error: 'no_result', message: 'This analysis has no saved calculation yet — save it first.' });
    return;
  }

  const result = typeof resultDoc === 'string' ? JSON.parse(resultDoc) : resultDoc;
  // ?signature=1 appends the identified approval page to the PDF.
  const opts = Object.assign({}, ALL_SECTIONS,
    { signature: /^(1|true)$/i.test(String((req.query && req.query.signature) || '')) });
  const doc = producer.buildExportDoc(result, opts,
    { savedVersion, generatedAt: new Date().toISOString() });
  const fsdoc = toFsdoc(doc, { docId: id + '-v' + savedVersion });

  let body;
  if (format === 'pdf') {
    // Ten-year projections (11 matrix columns) physically need landscape on
    // letter — the engine's stated policy; five-year docs stay portrait.
    const preset = doc.meta.years > 5 ? 'landscape' : 'portrait';
    const dd = fsRender.buildPdfDocDefinition(fsdoc, THEME, preset);
    producer.appendApprovalPage(dd, doc.signature);
    body = await pdfBuffer(dd);
  } else if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = fsRender.buildWorkbook(ExcelJS, fsdoc, THEME);
    body = Buffer.from(await wb.xlsx.writeBuffer());
  } else {
    body = Buffer.from(fsRender.buildCsv(fsdoc), 'utf8');
  }

  const base = (analysisName || 'Investment_Analysis').replace(/[^\w]+/g, '_') + '_Investment_Analysis'
    + (versionParam ? '_v' + savedVersion : '');
  context.res = {
    status: 200, isRaw: true,
    headers: {
      'Content-Type': spec.mime,
      'Content-Disposition': 'attachment; filename="' + base + '.' + spec.ext + '"',
      'Cache-Control': 'no-store'
    },
    body
  };
};
