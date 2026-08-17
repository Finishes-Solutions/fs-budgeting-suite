// Minimal stand-in for the SWA-managed Functions API + /.auth/me, so the frontend's
// save / load / list / publish paths can be exercised without Azure SQL.
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_DIR || require('path').join(__dirname,'..','app');
// The real module, not a copy: summary money is derived from the doc exactly as
// api/budget/index.js derives it, so a client-supplied meta.contractSum is
// ignored here too and parity cannot drift.
const { parts } = require('../api/shared/budget-calc');
// The investment routes run the REAL engine and hash convention, so preview,
// save-recomputation, and no-op detection behave byte-for-byte like Azure.
const bc = require('../api/shared/budget-calc');
const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const INV_C = require('../api/shared/investment/constants');
const INV_D = require('../api/shared/investment/defaults');
const crypto = require('crypto');
const GUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// id -> {projectId, name, status, sourceBudgetVersionNumber, input, result,
//        currentVersionNumber, deleted, versions:[...]}  (mirrors the SQL rows)
const invAnalyses = new Map();
const invHash = (rawInput, sourceBudgetVersionId) =>
  crypto.createHash('sha256').update(canonical({ rawInput,
    sourceBudgetVersionId: sourceBudgetVersionId || null,
    calculationVersion: INV_C.CALCULATION_VERSION }), 'utf8').digest('hex');
const invSummary = a => ({
  analysisId: a.id, projectId: a.projectId, name: a.name, status: a.status,
  currentVersionNumber: a.currentVersionNumber,
  sourceBudgetVersionNumber: a.sourceBudgetVersionNumber,
  purchasePrice: a.result ? a.result.summary.purchasePrice : null,
  year1NOI: a.result ? a.result.summary.year1NOI : null,
  initialEquity: a.result ? a.result.summary.initialEquity : null,
  finalYearEquityIRR: a.result ? a.result.summary.finalYearEquityIRR : null,
  optimalHoldingYear: a.result ? a.result.summary.optimalHoldingYear : null,
  calculationVersion: INV_C.CALCULATION_VERSION,
  createdAt: a.createdAt, updatedAt: a.updatedAt });
const PORT = +(process.env.PORT || 8100);
// NO_API=1 serves the frontend with every /api/* route dead, which is how the offline
// banner and the built-in pricing fallback get exercised (suite-01 runs against this).
const NO_API = process.env.NO_API === '1';
// id -> {meta, doc, deleted, versions:[{versionNumber, meta, doc, createdAt, ...}]}
// Mirrors the real API: deletion is a soft flag that keeps history, and a
// meaningful save appends an immutable version.
const budgets = new Map();

// Same canonicalization the API uses to decide whether a save changed anything
// (sorted keys, `updated` excluded), so no-op saves create no version here either.
const VOLATILE = new Set(['updated']);
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter(k => !VOLATILE.has(k) && v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
let pricing = JSON.parse(fs.readFileSync(path.join(__dirname, 'pricing.json'), 'utf8'));

const principal = {
  clientPrincipal: {
    identityProvider: 'aad', userId: 'abc123',
    userDetails: 'svc_automation@finishessolutions.com',
    userRoles: ['anonymous', 'authenticated', 'pricing_admin']
  }
};

// Same SOV projection as api/shared/versioning.js, so a versioned snapshot in
// the mock carries the same shape the real one does.
function sovRows(doc) {
  const units = (doc.units || []).reduce((s, u) => s + (u.count || 0), 0);
  const seen = new Set();
  return (doc.lines || []).map((l, i) => {
    let key = typeof l.lineId === 'string' && l.lineId ? l.lineId : null;
    if (key && seen.has(key)) key = null;
    if (key) seen.add(key);
    const qty = l.auto === false ? (l.qty || 0)
      : l.basis === 'sf' ? (doc.resSF || 0)
      : l.basis === 'asf' ? (doc.amenSF || 0)
      : l.basis === 'unit' ? units : 1;
    const rate = l.unit || 0;
    return { lineOrder: i + 1, lineKey: key, scope: l.scope || 'res', grp: l.grp || '',
             code: l.code || '', desc: l.desc || '', basis: l.basis || 'ls',
             qty, rate, total: qty * rate, provenance: 'parametric-estimate' };
  });
}

// Templates, seeded with `multifamily` from test/pricing.json plus the same
// defaults blankDoc() carries — the migration seeds the real one the same way.
const templates = new Map();
function pushVersion(key, body, defaultLabel) {
  const t = templates.get(key);
  const n = t.versions.length + 1;
  t.versions.push({versionNumber:n, versionLabel: body.versionLabel || defaultLabel || ('Version ' + n),
    changeSummary: body.changeSummary || null, pricingVersion: body.doc.pricingVersion || null,
    createdByName: principal.clientPrincipal.userDetails, templateSchemaVersion: 1,
    createdAt: new Date().toISOString(), publishedAt: new Date().toISOString(),
    doc: JSON.parse(JSON.stringify(body.doc))});
  return n;
}
const tmeta = (t) => ({templateKey:t.templateKey, name:t.name, budgetType:t.budgetType,
  description:t.description, isActive:t.isActive,
  currentVersion: t.versions.length || null,
  pricingVersion: t.versions.length ? t.versions[t.versions.length-1].pricingVersion : null,
  publishedAt: t.versions.length ? t.versions[t.versions.length-1].publishedAt : null,
  updatedAt: new Date().toISOString()});
const tvmeta = (v) => ({versionNumber:v.versionNumber, versionLabel:v.versionLabel,
  isCurrent: v.versionNumber === templatesCurrent(v), pricingVersion:v.pricingVersion,
  changeSummary:v.changeSummary, createdByName:v.createdByName,
  templateSchemaVersion:v.templateSchemaVersion, createdAt:v.createdAt, publishedAt:v.publishedAt});
function templatesCurrent(v){
  for (const t of templates.values()) if (t.versions.includes(v)) return t.versions.length;
  return v.versionNumber;
}

const vmeta = (v, maxV) => ({
  versionNumber: v.versionNumber, isCurrent: v.versionNumber === maxV,
  createdAt: v.createdAt, createdByName: v.createdByName, changeSummary: v.changeSummary,
  status: v.meta.status, contractSum: v.meta.contractSum, projectCost: v.meta.projectCost,
  pricingVersion: v.doc.pricingVersion, templateKey: v.doc.templateKey || null,
  templateName: null, templateVersion: null
});

templates.set('multifamily', {templateKey:'multifamily', name:'Multifamily', budgetType:'Multifamily',
  description:'Default multifamily budget template.', isActive:true, versions:[]});
pushVersion('multifamily', {doc:{
  templateSchemaVersion:1, name:'Multifamily', type:'Multifamily',
  resSF:51365, amenSF:1200, siteSF:0,
  units:[{label:'Studio (630)',bd:0,bth:1,sf:630,count:16,rent:1203},
         {label:'Studio (400)',bd:0,bth:1,sf:400,count:14,rent:1160},
         {label:'Townhome (1,063)',bd:2,bth:2,sf:1063,count:14,rent:1520},
         {label:'Townhome (1,200)',bd:2,bth:2.5,sf:1200,count:14,rent:1500}],
  other:[{label:'Utilities billback',rate:77,count:0,auto:true},
         {label:'Parking (reserved spaces)',rate:25,count:15,auto:false}],
  expenses:[{label:'Water & sewer',per:'unit',rate:60,count:0,auto:true},
            {label:'Valet trash',per:'unit',rate:15,count:0,auto:true}],
  lines: pricing.lines.map(l => ({...l, lineId:'tpl-'+Math.random().toString(36).slice(2,10),
    qty: l.basis==='ls'?1:0, auto: l.basis!=='ls', baseUnit:l.unit})),
  companies:[{name:'Finishes Solutions LLC',pct:12}],
  contingency:{mode:'psf',val:2},
  projectCosts:{land:1200000,dev:200000,mkt:75000,cls:0},
  status:'Draft', pricingVersion: pricing.version
}, changeSummary:'Seeded from the pricing library.'}, 'Initial Version');

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (NO_API && (p === '/.auth/me' || p.startsWith('/api/'))) { res.writeHead(500); return res.end('offline'); }

  if (p === '/.auth/me') return json(res, 200, principal);

  if (p === '/api/pricing') {
    if (req.method === 'GET') return json(res, 200, pricing);
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => { pricing = JSON.parse(b); json(res, 200, { ok: true, version: pricing.version }); });
  }

  // ---- budget templates ----
  if (p === '/api/templates' || p.startsWith('/api/templates/')) {
    const seg = p === '/api/templates' ? [] : decodeURIComponent(p.slice('/api/templates/'.length)).split('/');
    const key = seg[0] || '';
    // x-mock-noadmin drops the role for one request, so the 403 path is exercised
    // the same way hasRole(req,'pricing_admin') gates it in api/templates/index.js.
    const admin = !req.headers['x-mock-noadmin']
      && principal.clientPrincipal.userRoles.includes('pricing_admin');
    const t = templates.get(key);

    if (req.method === 'GET') {
      if (!key) {
        return json(res, 200, { isAdmin: admin, templates: [...templates.values()]
          .filter(x => admin || x.isActive).map(tmeta) });
      }
      if (!t) { res.writeHead(404); return res.end('Template not found'); }
      if (seg[1] === 'versions' && seg[2] === undefined) {
        return json(res, 200, { templateKey: key, versions: t.versions.map(tvmeta).reverse() });
      }
      if (seg[1] === 'versions') {
        const v = t.versions[parseInt(seg[2], 10) - 1];
        if (!v) { res.writeHead(404); return res.end('Version not found'); }
        return json(res, 200, { templateKey: key, version: tvmeta(v), doc: v.doc });
      }
      const cur = t.versions[t.versions.length - 1];
      return json(res, 200, { ...tmeta(t), currentVersionId: cur ? cur.versionNumber : null,
        changeSummary: cur ? cur.changeSummary : null, doc: cur ? cur.doc : null });
    }

    // Every mutation is admin-only, mirroring hasRole(req,'pricing_admin').
    if (!admin) { res.writeHead(403); return res.end('pricing_admin required'); }
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      if (req.method === 'POST') {
        const k = String(body.templateKey || '').toLowerCase();
        if (!/^[a-z0-9-]{1,64}$/.test(k)) { res.writeHead(400); return res.end('bad key'); }
        if (templates.has(k)) { res.writeHead(409); return res.end('exists'); }
        templates.set(k, {templateKey:k, name:body.name, budgetType:body.budgetType||body.name,
          description:body.description||'', isActive:true, versions:[]});
        return json(res, 200, {ok:true, templateKey:k, versionNumber: pushVersion(k, body, 'Initial version')});
      }
      if (!t) { res.writeHead(404); return res.end('Template not found'); }
      if (req.method === 'PUT') {
        if (!body.doc) { res.writeHead(400); return res.end('doc required'); }
        return json(res, 200, {ok:true, templateKey:key, versionNumber: pushVersion(key, body, null)});
      }
      if (req.method === 'PATCH') {
        ['name','budgetType','description'].forEach(f => { if (body[f] !== undefined) t[f] = body[f]; });
        if (body.isActive !== undefined) t.isActive = !!body.isActive;
        return json(res, 200, {ok:true, templateKey:key});
      }
      res.writeHead(405); res.end('method');
    });
  }

  if (p === '/api/budgets') {
    // Address comes off the document, mirroring the JSON_VALUE the real API uses.
    return json(res, 200, [...budgets.values()].filter(x => !x.deleted)
      .map(x => ({ ...x.meta, address: (x.doc && x.doc.address) || '' })));
  }

  if (p.startsWith('/api/budget/')) {
    const rest = decodeURIComponent(p.slice('/api/budget/'.length));
    const seg = rest.split('/');
    const id = (seg[0] || '').toUpperCase();
    // Must stay in step with ID_RX in api/budget/index.js and app/index.html.
    if (!/^(OP-\d{4}|BD-\d{4}|AS-\d{4}|TST-\d{4})$/.test(id)) { res.writeHead(400); return res.end('Invalid project ID'); }
    const rec = budgets.get(id);
    const live = rec && !rec.deleted ? rec : null;

    // /api/budget/{id}/versions[/{n}] — read-only history
    if (seg[1] === 'versions') {
      if (req.method !== 'GET') { res.writeHead(405); return res.end('Method not allowed'); }
      if (!live) { res.writeHead(404); return res.end('Not found'); }
      const maxV = live.versions.length;
      if (seg[2] === undefined || seg[2] === '') {
        return json(res, 200, { projectId: id, currentVersion: maxV,
          versions: live.versions.map(v => vmeta(v, maxV)).reverse() });
      }
      if (!/^\d+$/.test(seg[2])) { res.writeHead(400); return res.end('Version number must be a positive integer'); }
      const v = live.versions[parseInt(seg[2], 10) - 1];
      if (!v) { res.writeHead(404); return res.end('Version not found'); }
      return json(res, 200, { projectId: id, currentVersion: maxV,
        version: vmeta(v, maxV), doc: v.doc, sovLines: v.sovLines });
    }
    if (seg.length > 1) { res.writeHead(404); return res.end('Not found'); }

    if (req.method === 'GET') {
      if (!live) { res.writeHead(404); return res.end('Not found'); }
      return json(res, 200, live.doc);
    }
    // Soft delete: the record and its history stay, the budget just goes invisible.
    if (req.method === 'DELETE') {
      if (!rec) { res.writeHead(404); return res.end('Not found'); }
      rec.deleted = true;
      res.writeHead(204); return res.end();
    }
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      const { meta, doc } = JSON.parse(b);
      if ((doc.projectId || '').toUpperCase() !== id) { res.writeHead(400); return res.end('id mismatch'); }
      const calc = parts(doc);
      meta.contractSum = Math.round(calc.contract * 100) / 100;
      meta.projectCost = Math.round(calc.project * 100) / 100;
      const prev = budgets.get(id) || { versions: [] };
      const entry = { meta, doc, deleted: false, versions: prev.versions };  // PUT restores
      const last = entry.versions[entry.versions.length - 1];
      let versionCreated = false;
      if (!last || canonical(last.doc) !== canonical(doc)) {
        entry.versions.push({
          versionNumber: entry.versions.length + 1,
          createdAt: new Date().toISOString(),
          createdByName: principal.clientPrincipal.userDetails,
          changeSummary: typeof meta.changeSummary === 'string' ? meta.changeSummary : null,
          meta, doc: JSON.parse(JSON.stringify(doc)), sovLines: sovRows(doc)
        });
        versionCreated = true;
      }
      budgets.set(id, entry);
      json(res, 200, { ok: true, versionNumber: entry.versions.length, versionCreated });
    });
  }

  // ---- investment analyses: same semantics as the four Azure Functions ----
  if (p === '/api/investment-calculations' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      try { return json(res, 200, { ok: true, result: calculateInvestmentAnalysis(JSON.parse(b)) }); }
      catch (e) {
        if (e.validation) return json(res, 400, { error: 'validation_failed',
          message: 'Correct the highlighted assumptions.', fields: e.validation });
        return json(res, 500, { error: 'calculation_failed', message: 'The calculation could not be completed.' });
      }
    });
  }

  if (p === '/api/investment-analyses') {
    if (req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      const pid = (q.get('projectId') || '').toUpperCase();
      if (pid && !/^(OP-\d{4}|BD-\d{4}|AS-\d{4}|TST-\d{4})$/.test(pid))
        return json(res, 400, { error: 'bad_request', message: 'Invalid project ID filter.' });
      return json(res, 200, [...invAnalyses.values()]
        .filter(a => !a.deleted && (!pid || a.projectId === pid))
        .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
        .map(invSummary));
    }
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      const body = JSON.parse(b || '{}');
      let input, projectId = null, sourceBudgetVersionNumber = null;
      if (body.mode === 'fromBudget') {
        projectId = (body.projectId || '').toUpperCase();
        const rec = budgets.get(projectId);
        const live = rec && !rec.deleted ? rec : null;
        const vn = body.budgetVersionNumber !== undefined ? body.budgetVersionNumber
          : (live ? live.versions.length : 0);
        const v = live ? live.versions[vn - 1] : null;
        if (!v) { return json(res, 404, { error: 'not_found', message: 'Budget version not found.' }); }
        sourceBudgetVersionNumber = vn;
        const doc = v.doc, p2 = bc.parts(doc), gi = bc.grossIncome(doc), tu = bc.totUnits(doc);
        const siteSF = bc.nz(doc.siteSF), bldgSF = bc.nz(doc.resSF) + bc.nz(doc.amenSF);
        const round2 = x => Math.round(x * 100) / 100;
        input = {
          schemaVersion: 1,
          analysisName: (body.analysisName || (v.meta.name + ' — Investment Analysis')).slice(0, 200),
          source: { projectId, budgetVersionId: vn, budgetVersionNumber: vn,
            importedAt: new Date().toISOString(),
            fieldOrigins: {
              'property.name': 'Budget name', 'property.address': 'Budget address',
              'property.size': siteSF > 0 ? 'Budget Site SF' : 'Budget Residential + Amenity SF',
              'property.unitCount': 'Budget unit mix',
              'acquisition.basis': 'Budget Total Project Cost',
              'income.year1PotentialIncome': 'Budget unit mix — gross scheduled rent × 12',
              'income.otherIncome': 'Budget other-income rows × 12' },
            support: { contractSum: round2(p2.contract), projectCost: round2(p2.project),
              annualServiceExpenses: round2(12 * gi.expMo),
              serviceExpenseRows: (doc.expenses || []).map(e => ({ label: e.label,
                annualAmount: round2(12 * bc.nz(e.rate) * (e.per === 'fixed' ? (bc.nz(e.count) || 1) : (e.auto ? tu : bc.nz(e.count)))) })),
              unitMix: (doc.units || []).map(u => ({ label: u.label, count: bc.nz(u.count), rent: bc.nz(u.rent) })) } },
          property: { name: doc.name || projectId, address: doc.address || '',
            size: { unit: 'squareFeet', value: siteSF > 0 ? siteSF : bldgSF },
            unitCount: tu || null, purchaseMonth: null },
          projection: { years: 5, taxMode: 'beforeTax' },
          acquisition: { basis: { mode: 'purchasePrice', value: round2(p2.project) }, costPercent: INV_D.acquisitionCostPercent },
          income: { mode: 'aggregate', year1PotentialIncome: round2(12 * gi.rentMo),
            growth: { mode: 'constant', value: INV_D.incomeGrowth },
            otherIncome: (doc.other || []).map(o => ({ label: o.label || 'Other Income',
              year1Amount: round2(12 * bc.nz(o.rate) * (o.auto ? tu : bc.nz(o.count))),
              growth: { mode: 'constant', value: INV_D.otherIncomeGrowth } })) },
          vacancy: { mode: 'constant', value: INV_D.vacancy },
          expenses: { mode: 'percentOfGOI', value: null },
          capitalExpenses: [],
          financing: { loans: [] },
          disposition: { exitCapRate: { mode: 'constant', value: null }, sellingCostPercent: INV_D.sellingCostPercent },
          reportOptions: { includeSensitivity: true }
        };
      } else if (body.mode === 'standalone') {
        const name = (body.analysisName || (body.input && body.input.analysisName) || '').trim();
        if (!name) return json(res, 400, { error: 'bad_request', message: 'analysisName is required.' });
        input = Object.assign({
          schemaVersion: 1,
          property: { name, address: '', size: { unit: 'squareFeet', value: null }, purchaseMonth: null },
          projection: { years: 5, taxMode: 'beforeTax' },
          acquisition: { basis: { mode: 'purchasePrice', value: null }, costPercent: INV_D.acquisitionCostPercent },
          income: { mode: 'aggregate', year1PotentialIncome: null, growth: { mode: 'constant', value: INV_D.incomeGrowth }, otherIncome: [] },
          vacancy: { mode: 'constant', value: INV_D.vacancy },
          expenses: { mode: 'percentOfGOI', value: null },
          capitalExpenses: [],
          financing: { loans: [] },
          disposition: { exitCapRate: { mode: 'constant', value: null }, sellingCostPercent: INV_D.sellingCostPercent },
          reportOptions: { includeSensitivity: true }
        }, body.input || {}, { schemaVersion: 1, analysisName: name.slice(0, 200), source: null });
      } else {
        return json(res, 400, { error: 'bad_request', message: "mode must be 'fromBudget' or 'standalone'." });
      }
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      invAnalyses.set(id, { id, projectId, name: input.analysisName, status: 'Draft',
        sourceBudgetVersionNumber, input, result: null, currentVersionNumber: 0,
        deleted: false, versions: [], createdAt: now, updatedAt: now });
      return json(res, 201, { ok: true, analysisId: id, input, currentVersionNumber: 0,
        source: input.source ? { projectId, budgetVersionId: sourceBudgetVersionNumber,
          budgetVersionNumber: sourceBudgetVersionNumber } : null });
    });
  }

  if (p.startsWith('/api/investment-analysis/')) {
    const seg = decodeURIComponent(p.slice('/api/investment-analysis/'.length)).split('/');
    const id = (seg[0] || '').toLowerCase();
    if (!GUID_RX.test(id)) return json(res, 400, { error: 'bad_request', message: 'Invalid analysis ID.' });
    const a = invAnalyses.get(id);
    const live = a && !a.deleted ? a : null;

    // Server-rendered exports — the SAME shared renderer module the real
    // function uses, so suites assert the genuine file bytes.
    if (seg[1] === 'export') {
      if (req.method !== 'GET') { res.writeHead(405); return res.end('Method not allowed'); }
      if (!live) return json(res, 404, { error: 'not_found', message: 'Not found' });
      const q = new URL(req.url, 'http://x').searchParams;
      const format = String(q.get('format') || 'pdf').toLowerCase();
      const versionParam = q.get('version');
      let result = live.result, savedVersion = live.currentVersionNumber;
      if (versionParam) {
        if (!/^\d+$/.test(versionParam)) return json(res, 400, { error: 'bad_request', message: 'version must be a positive integer.' });
        const v = live.versions[parseInt(versionParam, 10) - 1];
        if (!v) return json(res, 404, { error: 'not_found', message: 'Version not found.' });
        result = v.result; savedVersion = v.versionNumber;
      }
      if (!result) return json(res, 409, { error: 'no_result', message: 'This analysis has no saved calculation yet — save it first.' });
      if (!['pdf', 'xlsx', 'csv'].includes(format))
        return json(res, 400, { error: 'bad_request', message: 'format must be pdf, xlsx or csv.' });
      const render = require('../api/shared/investment/export-render');
      const doc = render.buildExportDoc(result,
        { kpis: true, cash: true, sale: true, returns: true, sens: true, assumptions: true, highlight: false,
          signature: /^(1|true)$/i.test(String(q.get('signature') || '')) },
        { savedVersion, generatedAt: new Date().toISOString() });
      const base = (live.name || 'Investment_Analysis').replace(/[^\w]+/g, '_')
        + '_Investment_Analysis' + (versionParam ? '_v' + savedVersion : '');
      const send = (mime, ext, buf) => {
        res.writeHead(200, { 'Content-Type': mime,
          'Content-Disposition': 'attachment; filename="' + base + '.' + ext + '"' });
        res.end(buf);
      };
      if (format === 'csv')
        return send('text/csv; charset=utf-8', 'csv', Buffer.from(render.buildCsv(doc), 'utf8'));
      if (format === 'xlsx') {
        const ExcelJS = require('exceljs');
        return render.buildWorkbook(ExcelJS, doc).xlsx.writeBuffer()
          .then(buf => send('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', Buffer.from(buf)))
          .catch(e => json(res, 500, { error: 'render_failed', message: e.message }));
      }
      try {
        const PdfPrinter = require('pdfmake');
        const F = f => path.join(__dirname, '..', 'api', 'shared', 'fonts', f);
        const printer = new PdfPrinter({ Montserrat: {
          normal: F('Montserrat-Regular.ttf'), bold: F('Montserrat-Bold.ttf'),
          italics: F('Montserrat-Regular.ttf'), bolditalics: F('Montserrat-Bold.ttf') } });
        const pdoc = printer.createPdfKitDocument(render.buildPdfDocDefinition(doc));
        const chunks = [];
        pdoc.on('data', c => chunks.push(c));
        pdoc.on('end', () => send('application/pdf', 'pdf', Buffer.concat(chunks)));
        pdoc.on('error', e => json(res, 500, { error: 'render_failed', message: e.message }));
        pdoc.end();
        return;
      } catch (e) { return json(res, 500, { error: 'render_failed', message: e.message }); }
    }

    if (seg[1] === 'versions') {
      if (req.method !== 'GET') { res.writeHead(405); return res.end('Method not allowed'); }
      if (!live) return json(res, 404, { error: 'not_found', message: 'Not found' });
      if (seg[2] === undefined || seg[2] === '') {
        return json(res, 200, { analysisId: id, currentVersion: live.currentVersionNumber,
          versions: live.versions.map(v => ({
            versionNumber: v.versionNumber, name: v.name, changeSummary: v.changeSummary,
            calculationVersion: v.calculationVersion, inputSchemaVersion: 1,
            purchasePrice: v.result.summary.purchasePrice, year1NOI: v.result.summary.year1NOI,
            initialEquity: v.result.summary.initialEquity,
            finalYearEquityIRR: v.result.summary.finalYearEquityIRR,
            optimalHoldingYear: v.result.summary.optimalHoldingYear,
            createdByName: v.createdByName, createdAt: v.createdAt,
            isCurrent: v.versionNumber === live.currentVersionNumber
          })).reverse() });
      }
      if (!/^\d+$/.test(seg[2])) return json(res, 400, { error: 'bad_request', message: 'Version number must be a positive integer.' });
      const v = live.versions[parseInt(seg[2], 10) - 1];
      if (!v) return json(res, 404, { error: 'not_found', message: 'Version not found' });
      return json(res, 200, { analysisId: id, currentVersion: live.currentVersionNumber,
        version: { versionNumber: v.versionNumber, name: v.name, changeSummary: v.changeSummary,
          calculationVersion: v.calculationVersion, inputSchemaVersion: 1,
          sourceBudgetVersionId: live.sourceBudgetVersionNumber,
          createdByName: v.createdByName, createdAt: v.createdAt,
          isCurrent: v.versionNumber === live.currentVersionNumber },
        input: v.input, result: v.result });
    }
    if (seg.length > 1) return json(res, 404, { error: 'not_found', message: 'Not found' });

    if (req.method === 'GET') {
      if (!live) return json(res, 404, { error: 'not_found', message: 'Not found' });
      return json(res, 200, { analysisId: id, projectId: live.projectId, name: live.name,
        status: live.status, currentVersionNumber: live.currentVersionNumber,
        source: live.sourceBudgetVersionNumber ? { projectId: live.projectId,
          budgetVersionId: live.sourceBudgetVersionNumber,
          budgetVersionNumber: live.sourceBudgetVersionNumber } : null,
        input: live.input, result: live.result,
        inputSchemaVersion: 1, calculationVersion: INV_C.CALCULATION_VERSION,
        createdAt: live.createdAt, updatedAt: live.updatedAt });
    }
    if (req.method === 'DELETE') {
      if (!a) return json(res, 404, { error: 'not_found', message: 'Not found' });
      if (a.deleted) return json(res, 404, { error: 'not_found', message: 'Not found' });
      a.deleted = true; a.deletedAt = new Date().toISOString();
      res.writeHead(204); return res.end();
    }
    // PUT — recalculate server-side, ignore client results, 409 on stale saves
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      if (!a) return json(res, 404, { error: 'not_found', message: 'Not found' });
      const body = JSON.parse(b || '{}');
      const input = body.input;
      if (!input || typeof input !== 'object')
        return json(res, 400, { error: 'bad_request', message: 'Body must be { input, expectedVersionNumber }.' });
      if (body.expectedVersionNumber !== undefined && body.expectedVersionNumber !== null
          && body.expectedVersionNumber !== a.currentVersionNumber)
        return json(res, 409, { error: 'version_conflict',
          message: 'Someone saved a newer version of this analysis after you loaded it.',
          currentVersionNumber: a.currentVersionNumber });
      let result;
      try { result = calculateInvestmentAnalysis(input); }
      catch (e) {
        if (e.validation) return json(res, 400, { error: 'validation_failed',
          message: 'Correct the highlighted assumptions.', fields: e.validation });
        return json(res, 500, { error: 'calculation_failed', message: 'The calculation could not be completed.' });
      }
      if (input.source && typeof input.source === 'object')
        input.source.budgetVersionId = a.sourceBudgetVersionNumber;   // provenance is server-owned
      const hash = invHash(input, a.sourceBudgetVersionNumber);
      const unchanged = a.currentVersionNumber >= 1 && a.contentHash === hash;
      if (!unchanged) {
        a.currentVersionNumber += 1;
        a.versions.push({ versionNumber: a.currentVersionNumber,
          name: result.normalizedInput.analysisName,
          changeSummary: typeof body.changeSummary === 'string' ? body.changeSummary : null,
          calculationVersion: INV_C.CALCULATION_VERSION,
          input: JSON.parse(JSON.stringify(input)), result,
          createdByName: principal.clientPrincipal.userDetails,
          createdAt: new Date().toISOString() });
      }
      a.name = result.normalizedInput.analysisName;
      a.status = typeof body.status === 'string' ? body.status.slice(0, 30) : 'Draft';
      a.input = input; a.result = result; a.contentHash = hash;
      a.deleted = false; a.deletedAt = null;
      a.updatedAt = new Date().toISOString();
      return json(res, 200, { ok: true, versionNumber: a.currentVersionNumber,
        versionCreated: !unchanged, result });
    });
  }

  // static
  const f = path.join(APP, p === '/' ? 'index.html' : p);
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nf'); }
    const ext = path.extname(f).toLowerCase();
    const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
                   '.png':'image/png', '.svg':'image/svg+xml', '.json':'application/json', '.txt':'text/plain' };
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log('mock on ' + PORT));
