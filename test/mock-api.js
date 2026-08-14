// Minimal stand-in for the SWA-managed Functions API + /.auth/me, so the frontend's
// save / load / list / publish paths can be exercised without Azure SQL.
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_DIR || require('path').join(__dirname,'..','app');
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
