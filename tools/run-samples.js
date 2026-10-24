#!/usr/bin/env node
// Run every sample project budget → pro forma → export and write the results
// to docs/sample-output/ (Phase 6).
//
//   node tools/run-samples.js
//
// For each sample: the engine budget (tools/samples/projects.js) is
// materialized into a budget document exactly as the app saves it; the whole
// project — and each component and phase — is handed to the pro forma through
// the same from-budget projection the API uses; the investment engine runs;
// and the estimate is exported to Excel and PDF with the same fs-render
// pipeline as the app. Deterministic apart from the PDF timestamp.
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../app/budget-engine.js');
const D = require('../app/research-data.js');
const calc = require('../api/shared/budget-calc');
const { projectFromBudget } = require('../api/shared/investment/from-budget');
const ID = require('../api/shared/investment/defaults');
const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const producer = require('../api/shared/investment/export-render');
const { toFsdoc } = require('../api/shared/investment/to-fsdoc');
const fsRender = require('fs-render');
const ExcelJS = require('exceljs');
const PdfPrinter = require('pdfmake');
const SAMPLES = require('./samples/projects');

const OUT = path.join(__dirname, '..', 'docs', 'sample-output');
const THEME = fsRender.themes['finishes-solutions'];
const F = f => path.join(__dirname, '../api/shared/fonts', f);
const printer = new PdfPrinter({ Montserrat: { normal: F('Montserrat-Regular.ttf'), bold: F('Montserrat-Bold.ttf'),
  italics: F('Montserrat-Regular.ttf'), bolditalics: F('Montserrat-Bold.ttf') } });

const money = v => (v === null || v === undefined || !isFinite(v)) ? '—' : '$' + Math.round(v).toLocaleString('en-US');
const pct = v => (v === null || v === undefined || !isFinite(v)) ? '—' : (100 * v).toFixed(1) + '%';
const unitL = id => { const u = D.units.find(x => x.id === id); return u ? u.label : id; };

function pdfBuffer(dd) {
  return new Promise((resolve, reject) => {
    const d = printer.createPdfKitDocument(dd);
    const chunks = [];
    d.on('data', c => chunks.push(c)); d.on('end', () => resolve(Buffer.concat(chunks))); d.on('error', reject); d.end();
  });
}

// The analysis input the API would build from the saved version (create path
// in api/investment-analyses/index.js), with the sample's exit cap and a loan
// at the organisation's default LTV.
function analysisInput(doc, scope, s, completion) {
  const proj = projectFromBudget(doc, { Id: 1, VersionNumber: 1, Name: doc.name }, { projectId: doc.projectId, vacancy: ID.vacancy, scope });
  const i = proj.imported;
  return {
    input: {
      schemaVersion: 1, analysisName: (doc.name + ' — ' + (scope.kind === 'project' ? 'whole project' : scope.kind + ' ' + scope.id)).slice(0, 200),
      property: { name: i.property.name, address: i.property.address, size: i.property.size && i.property.size.value > 0 ? i.property.size : { unit: 'units', value: 1 },
        unitCount: i.property.unitCount, purchaseMonth: completion },
      projection: { years: 5, taxMode: 'beforeTax' },
      acquisition: { basis: i.acquisition.basis, costPercent: 0 },
      income: { mode: 'aggregate', year1PotentialIncome: i.income.year1PotentialIncome, growth: { mode: 'constant', value: ID.incomeGrowth },
        otherIncome: i.income.otherIncome },
      vacancy: { mode: 'constant', value: i.vacancy !== null && i.vacancy !== undefined ? i.vacancy : ID.vacancy },
      expenses: { mode: 'percentOfGOI', value: i.expenses.value !== null ? i.expenses.value : 0.35 },
      capitalExpenses: [],
      financing: { loans: [{ label: 'Permanent loan', kind: 'newAmortizing', amount: { mode: 'ltv', value: ID.ltv }, annualRate: 0.065,
        amortizationYears: ID.amortizationYears, termYears: 5, feePercent: ID.loanFeePercent, interestCalculation: '30/360' }] },
      disposition: { exitCapRate: { mode: 'constant', value: s.exitCap }, sellingCostPercent: ID.sellingCostPercent },
      reportOptions: { includeSensitivity: true }
    },
    proj
  };
}

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const rows = [], pfRows = [];
  for (const s of SAMPLES) {
    const dir = path.join(OUT, s.id);
    fs.mkdirSync(dir, { recursive: true });
    const project = JSON.parse(JSON.stringify(s.project));
    const r = E.calculate(project, D);
    const m = E.toBudgetDoc(r, project);
    const doc = Object.assign({ projectId: 'BDG-9' + s.id.slice(0, 2).padStart(3, '0') + '-01', name: s.name, address: s.address,
      type: r.components.length === 1 ? r.components[0].typeName : 'Mixed-use', units: [], other: [], expenses: [],
      engine: project, status: 'Draft' }, m);
    const tie = Math.round(calc.parts(doc).project * 100) === Math.round(r.totals.total * 100);
    if (!tie) throw new Error(s.id + ': parts() does not tie to the engine total');

    // Pro forma — whole project, then each component and phase.
    const lastPhase = r.phases[r.phases.length - 1];
    const completion = lastPhase.start ? E._.addMonths(lastPhase.start, lastPhase.months) : '2028-01';
    const scopes = [{ kind: 'project', id: 'project' }].concat(
      r.components.length > 1 ? r.components.map(c => ({ kind: 'component', id: c.id })) : [],
      r.phases.length > 1 ? r.phases.map(x => ({ kind: 'phase', id: x.id })) : []);
    const proformas = [];
    for (const sc of scopes) {
      const { input, proj } = analysisInput(doc, sc, s, completion);
      let res = null, err = null;
      try { res = calculateInvestmentAnalysis(input); } catch (e) { err = e.validation || e.message; }
      proformas.push({ scope: sc, purchasePrice: input.acquisition.basis.value, year1PotentialIncome: input.income.year1PotentialIncome,
        size: input.property.size, unitCount: input.property.unitCount, error: err,
        summary: res ? { year1NOI: res.summary.year1NOI, yieldOnCost: res.summary.acquisitionCapRate, equityIRR: res.summary.finalYearEquityIRR,
          equityMultiple: res.summary.finalYearEquityMultiple, warnings: res.warnings } : null, fieldOrigins: proj.fieldOrigins });
      if (sc.kind === 'project' && res) {
        const edoc = producer.buildExportDoc(res, { kpis: true, cash: true, sale: true, returns: true, sens: true, assumptions: true, highlight: false },
          { generatedAt: '2026-10-24T00:00:00.000Z' });
        const wb = fsRender.buildWorkbook(ExcelJS, toFsdoc(edoc), THEME);
        fs.writeFileSync(path.join(dir, 'proforma.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()));
        const pr = proformas[proformas.length - 1];
        pr.irrRow = res.annual.map(a => ({ year: a.year, NOI: a.netOperatingIncome, cashFlow: a.cashFlowBeforeTaxes, equityIRR: a.equityIRR }));
      }
    }

    // Estimate exports (the same fsdoc the app builds).
    const fsdoc = { fsdoc: '1', meta: { title: s.name, eyebrow: 'FINISHES SOLUTIONS · PROJECT ESTIMATE (SAMPLE)', subline: s.address,
      rightLines: ['Research data ' + D.version], bandLine: s.name + ' · Total ' + money(r.totals.total),
      footnote: 'Sample output — revenue, land and exit-cap inputs are illustrative. Engine ' + r.engineVersion + '.',
      footerRight: s.id, generatedAt: '2026-10-24T00:00:00.000Z' }, sheets: E.toFsdocSheets(r, project, D) };
    const v = fsRender.validate(fsdoc);
    if (v && v.ok === false) throw new Error(s.id + ' fsdoc invalid: ' + JSON.stringify(v.errors));
    const wb = fsRender.buildWorkbook(ExcelJS, fsdoc, THEME);
    fs.writeFileSync(path.join(dir, 'estimate.xlsx'), Buffer.from(await wb.xlsx.writeBuffer()));
    const pdf = await pdfBuffer(fsRender.buildPdfDocDefinition(fsdoc, THEME, 'landscape'));
    fs.writeFileSync(path.join(dir, 'estimate.pdf'), pdf);
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ sample: { id: s.id, name: s.name, address: s.address, exitCap: s.exitCap },
      engine: project }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ totals: r.totals, metrics: r.metrics, split: r.split,
      components: r.components.map(c => ({ id: c.id, name: c.name, type: c.typeName, size: c.size, unit: c.unit, totals: c.totals,
        metrics: c.metrics, range: c.range })), phases: r.phases.map(x => ({ id: x.id, name: x.name, start: x.start, months: x.months,
        midpoint: x.midpoint, escalation: x.escalation.factor, totals: x.totals, financing: x.financing })),
      shared: r.shared, warnings: r.warnings, proformas }, null, 2) + '\n');

    const pu = r.metrics.unit ? money(r.metrics.perPrimaryUnit) + ' / ' + unitL(r.metrics.unit) : 'mixed — see components';
    rows.push(`| [${s.id}](${s.id}/) | ${s.name} | ${s.address} | ${money(r.totals.total)} | ${pu} | ${r.metrics.perSF ? '$' + r.metrics.perSF.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'} | ${pct(r.split.hard)} / ${pct(r.split.soft)} / ${pct(r.split.land)} | ${r.components.map(c => c.range ? c.range.status : '—').join(', ')} |`);
    proformas.forEach(pf => {
      const sc = pf.scope.kind === 'project' ? 'whole project' : pf.scope.kind + ' ' + (pf.scope.kind === 'component'
        ? r.components.find(c => c.id === pf.scope.id).name : r.phases.find(x => x.id === pf.scope.id).name);
      pfRows.push(`| ${s.id} | ${sc} | ${money(pf.purchasePrice)} | ${money(pf.year1PotentialIncome)} | ${pf.summary ? money(pf.summary.year1NOI) : '—'} | ${pf.summary ? pct(pf.summary.yieldOnCost) : '—'} | ${pf.summary ? pct(pf.summary.equityIRR) : (pf.error ? 'not run: ' + JSON.stringify(pf.error).slice(0, 60) : '—')} |`);
    });
    console.log(s.id.padEnd(30), money(r.totals.total).padStart(16), r.components.map(c => c.range && c.range.status).join(','));
  }
  const md = `# Sample output

Sixteen sample projects run through the v2 engine → budget document → pro forma → export by
\`node tools/run-samples.js\` (research data \`${D.version}\`). Each folder holds:

- \`estimate.xlsx\` / \`estimate.pdf\` — the estimate export (summary, components, phases, detail, draw schedules, sources & assumptions), built with the same fs-render pipeline as the app;
- \`proforma.xlsx\` — the whole-project investment analysis export from the unchanged pro forma engine;
- \`project.json\` — the engine inputs exactly as the Inputs page saves them;
- \`result.json\` — totals, per-component and per-phase results, range checks, warnings, and every pro forma scope that was run.

**Costs** come from the research bundle. **Revenue, land prices and exit caps are illustrative inputs** chosen only so each
sample can run through the pro forma; they are not research and should not be read as market rents or values.
Every budget ties to the classic budget arithmetic (\`parts(doc).project\`) to the cent — the runner refuses to write one that does not.

## Estimates

| Sample | Project | Location | Total project cost | Cost per primary unit | $/SF | Hard / soft / land | Range check |
|---|---|---|---:|---:|---:|---|---|
${rows.join('\n')}

## Pro forma handoff (per project, component and phase)

Purchase price = the scope's total project cost; Year-1 income from the component revenue inputs; 65% LTV permanent loan at 6.5%,
5-year hold, organisation defaults otherwise. "Yield on cost" is Year-1 NOI ÷ total cost.

| Sample | Scope | Cost (purchase price) | Year-1 potential income | Year-1 NOI | Yield on cost | 5-yr equity IRR |
|---|---|---:|---:|---:|---:|---:|
${pfRows.join('\n')}
`;
  fs.writeFileSync(path.join(OUT, 'README.md'), md);
  console.log('wrote', path.relative(process.cwd(), OUT));
}

run().catch(e => { console.error(e); process.exit(1); });
