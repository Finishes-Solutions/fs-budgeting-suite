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
const budgets = new Map();   // id -> {meta, doc}
let pricing = JSON.parse(fs.readFileSync(path.join(__dirname, 'pricing.json'), 'utf8'));

const principal = {
  clientPrincipal: {
    identityProvider: 'aad', userId: 'abc123',
    userDetails: 'svc_automation@finishessolutions.com',
    userRoles: ['anonymous', 'authenticated', 'pricing_admin']
  }
};

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
    return json(res, 200, [...budgets.values()].map(x => x.meta));
  }

  if (p.startsWith('/api/budget/')) {
    const id = decodeURIComponent(p.slice('/api/budget/'.length)).toUpperCase();
    // Must stay in step with ID_RX in api/budget/index.js and app/index.html.
    if (!/^(OP-\d{4}|BD-\d{4}|AS-\d{4}|TST-\d{4})$/.test(id)) { res.writeHead(400); return res.end('Invalid project ID'); }
    if (req.method === 'GET') {
      if (!budgets.has(id)) { res.writeHead(404); return res.end('Not found'); }
      return json(res, 200, budgets.get(id).doc);
    }
    if (req.method === 'DELETE') { budgets.delete(id); res.writeHead(204); return res.end(); }
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => {
      const { meta, doc } = JSON.parse(b);
      if ((doc.projectId || '').toUpperCase() !== id) { res.writeHead(400); return res.end('id mismatch'); }
      budgets.set(id, { meta, doc });
      json(res, 200, { ok: true });
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
