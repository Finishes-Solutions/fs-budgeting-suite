// The sign-in path, asserted against the two files that decide it:
// app/staticwebapp.config.json (which routes are reachable without a session,
// and where a 401 goes) and app/login.html (what an anonymous visitor gets).
//
// Nothing else in the test tree can catch a regression here. The browser
// suites run against test/mock-api.js, which serves every path without a route
// guard, so an anonymous route that quietly disappeared — or a 401 override
// pointed back at a page that itself 401s, which is a redirect loop rather than
// a login screen — would leave every suite green and the deployed app shut.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'app');
const config = JSON.parse(fs.readFileSync(path.join(APP, 'staticwebapp.config.json'), 'utf8'));
const login = fs.readFileSync(path.join(APP, 'login.html'), 'utf8');

const ruleFor = p => config.routes.find(r => r.route === p);
const isPublic = r => !!r && (r.allowedRoles || []).includes('anonymous');

test('the login screen is reachable without a session', () => {
  assert.ok(isPublic(ruleFor('/login.html')), 'login.html must allow the anonymous role');
});

test('an unauthenticated request lands on the login screen, not the provider', () => {
  const o = config.responseOverrides && config.responseOverrides['401'];
  assert.ok(o, 'a 401 override must exist, or SWA answers a bare 401');
  assert.strictEqual(o.redirect, '/login.html');
  assert.strictEqual(o.statusCode, 302);
});

test('the anonymous rule precedes the catch-all that would swallow it', () => {
  // SWA takes the FIRST matching rule. Below /*, the login page would demand a
  // session, the 401 override would send the visitor back to it, and the
  // browser would bounce between the two.
  const routes = config.routes.map(r => r.route);
  assert.ok(routes.indexOf('/login.html') < routes.indexOf('/*'));
});

test('nothing but the login screen and its icon is anonymous', () => {
  const open = config.routes.filter(isPublic).map(r => r.route).sort();
  assert.deepStrictEqual(open, ['/favicon.ico', '/login.html']);
});

test('the app and its API still require a session', () => {
  for (const p of ['/*', '/api/*']) {
    const r = ruleFor(p);
    assert.ok(r, p + ' rule is missing');
    assert.deepStrictEqual(r.allowedRoles, ['authenticated']);
  }
});

test('the privileged API routes keep their role gates', () => {
  assert.deepStrictEqual(ruleFor('/api/analytics').allowedRoles, ['super_admin']);
  assert.deepStrictEqual(ruleFor('/api/pricing').allowedRoles, ['pricing_admin', 'super_admin']);
});

test('the login screen signs in through the platform auth route', () => {
  assert.ok(/\/\.auth\/login\/aad/.test(login), 'the sign-in link must target /.auth/login/aad');
  assert.ok(/post_login_redirect_uri/.test(login), 'it must say where to land afterwards');
});

test('the login screen is self-contained: no app code, no build step', () => {
  // It renders before there is a session, so it cannot depend on anything the
  // app loads — a <script src> or stylesheet link to an app file would be a 401
  // for the very visitor this page exists for. Comments are stripped first, so
  // this reads what the page actually loads rather than what it talks about.
  const markup = login.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/<script[^>]+\bsrc=/i.test(markup), 'no external scripts');
  assert.ok(!/(?:src|href)="[^"]*(?:index\.html|home\.js|investment-analysis|dashboard)/.test(markup),
    'no app dependencies');
  const links = markup.match(/<link[^>]*>/gi) || [];
  for (const l of links) assert.ok(/rel="icon"/.test(l), 'unexpected <link>: ' + l);
});

test('the login screen keeps a signed-in visitor off itself', () => {
  assert.ok(/\/\.auth\/me/.test(login) && /location\.replace/.test(login),
    'an existing session must be redirected into the app');
});

test('the post-login target can only be this app', () => {
  // The target is built from location.hash, which anyone can put anything in.
  // Run the page's own function rather than restating its pattern here: what
  // matters is the value it hands to post_login_redirect_uri and to
  // location.replace — always a path on this host, never an absolute or
  // protocol-relative URL pointing somewhere else.
  const src = login.match(/function target\(\)\{[\s\S]*?\n  \}/);
  assert.ok(src, 'login.html must derive its redirect target in one place');
  const target = h => new Function('location', src[0] + '\nreturn target();')({ hash: h });

  assert.strictEqual(target('#/budget/OP-1001'), '/#/budget/OP-1001', 'a deep link survives');
  assert.strictEqual(target(''), '/', 'no hash lands on the app root');
  for (const evil of ['#<script>alert(1)</script>', '#" onload="x', '#/\\evil.example.com']) {
    assert.strictEqual(target(evil), '/', 'a hash that is not ours is dropped: ' + evil);
  }
  // Even a hash that passes the pattern stays on this origin, because the value
  // is a fragment appended to '/' — it can never begin a new authority.
  for (const h of ['#//evil.example.com', '#https://evil.example.com', '']) {
    const t = target(h);
    assert.ok(t.startsWith('/') && !t.startsWith('//'), 'stays same-origin: ' + t);
  }
});
