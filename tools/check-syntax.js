#!/usr/bin/env node
// The repo has no build step, so a syntax error ships (AGENTS.md ground rule 1).
// This parses every first-party script — app/, api/, tools/, test/ and the
// inline <script> blocks of the HTML pages — and exits 1 on any error.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SKIP = /(^|\/)(node_modules|vendor|fs-render)(\/|$)/;
const bad = [];
let n = 0;
function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap(x => {
    const p = path.join(d, x.name), rel = path.relative(ROOT, p);
    if (SKIP.test(rel)) return [];
    return x.isDirectory() ? walk(p) : [p];
  });
}
function parse(code, file) {
  n++;
  try { new vm.Script(code, { filename: file }); }
  catch (e) { bad.push(path.relative(ROOT, file) + ': ' + e.message); }
}
['app', 'api', 'tools', 'test'].forEach(dir => walk(path.join(ROOT, dir)).forEach(f => {
  if (f.endsWith('.js')) {
    let code = fs.readFileSync(f, 'utf8');
    if (code.startsWith('#!')) code = '//' + code;
    parse('(function(){' + code + '\n})', f);
  } else if (f.endsWith('.html')) {
    const html = fs.readFileSync(f, 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m, i = 0;
    while ((m = re.exec(html))) parse(m[1], f + '#script' + (i++));
  }
}));
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
console.log('syntax ok — ' + n + ' scripts parsed');
