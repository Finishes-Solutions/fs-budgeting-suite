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

const vmeta = (v, maxV) => ({
  versionNumber: v.versionNumber, isCurrent: v.versionNumber === maxV,
  createdAt: v.createdAt, createdByName: v.createdByName, changeSummary: v.changeSummary,
  status: v.meta.status, contractSum: v.meta.contractSum, projectCost: v.meta.projectCost,
  pricingVersion: v.doc.pricingVersion, templateKey: v.doc.templateKey || null,
  templateName: null, templateVersion: null
});

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

  if (p === '/api/budgets') {
    return json(res, 200, [...budgets.values()].filter(x => !x.deleted).map(x => x.meta));
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
