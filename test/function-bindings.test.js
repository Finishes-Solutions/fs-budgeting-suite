// Every HTTP method a Function's code handles must be BOUND in its
// function.json. The host answers an unbound method with a 404 before the code
// ever runs, so a branch for it is dead on arrival — and nothing else in the
// test tree can notice: the browser suites talk to test/mock-api.js, which has
// no bindings at all. That is how POST /api/user-settings?scope=feedback (the
// in-app bug report) shipped unreachable while every suite passed.
//
// Static on purpose: it reads the source rather than running it, so it covers
// every endpoint, including ones no other test loads.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const API = path.join(__dirname, '..', 'api');

// `req.method === 'POST'`, `req.method !== 'GET'`, and the templates idiom of
// copying it first (`const method = req.method.toUpperCase(); method === 'PUT'`).
function methodsUsed(src) {
  const used = new Set();
  const direct = /\breq\.method(?:\.toUpperCase\(\))?\s*[!=]==?\s*['"]([A-Za-z]+)['"]/g;
  let m;
  while ((m = direct.exec(src))) used.add(m[1].toUpperCase());
  const alias = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:\(\s*)?req\.method\b/.exec(src);
  if (alias) {
    const rx = new RegExp('\\b' + alias[1] + '\\s*[!=]==?\\s*[\'"]([A-Za-z]+)[\'"]', 'g');
    while ((m = rx.exec(src))) used.add(m[1].toUpperCase());
  }
  return used;
}

const functions = fs.readdirSync(API, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(API, d.name, 'function.json')))
  .map(d => d.name);

test('the scan finds the endpoints it is meant to police', () => {
  // A path or regex change that matched nothing would pass vacuously.
  for (const f of ['budget', 'user-settings', 'investment-analysis', 'templates', 'pricing'])
    assert.ok(functions.includes(f), f + ' is scanned');
  const us = fs.readFileSync(path.join(API, 'user-settings', 'index.js'), 'utf8');
  assert.ok(methodsUsed(us).has('POST'), 'the feedback POST branch is detected');
  const tpl = fs.readFileSync(path.join(API, 'templates', 'index.js'), 'utf8');
  assert.ok(methodsUsed(tpl).has('PATCH'), 'the aliased method idiom is detected');
});

for (const name of functions) {
  test('api/' + name + ' binds every method its code handles', () => {
    const fj = JSON.parse(fs.readFileSync(path.join(API, name, 'function.json'), 'utf8'));
    const trig = (fj.bindings || []).find(b => b.type === 'httpTrigger');
    assert.ok(trig, 'an httpTrigger binding exists');
    // No `methods` list means the host accepts every method.
    if (!Array.isArray(trig.methods)) return;
    const bound = new Set(trig.methods.map(x => String(x).toUpperCase()));
    const file = path.join(API, name, 'index.js');
    if (!fs.existsSync(file)) return;
    const src = fs.readFileSync(file, 'utf8');
    const missing = [...methodsUsed(src)].filter(x => !bound.has(x));
    assert.deepStrictEqual(missing, [],
      'api/' + name + '/index.js handles ' + missing.join(', ')
      + ' but function.json binds only ' + [...bound].join(', '));
  });
}
