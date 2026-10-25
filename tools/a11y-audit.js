#!/usr/bin/env node
// WCAG 2.1 AA audit of the estimate screens with axe-core (dev-only tool).
//   PORT=8111 node test/mock-api.js &   then   BASE=http://127.0.0.1:8111 node tools/a11y-audit.js
// Scoped to the v2 markup (#v2Inputs, #v2Detail, picker, drawer) in light and
// dark themes. Exit 1 on any violation.
'use strict';
const fs = require('fs');
const { chromium } = require('playwright');
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const BASE = process.env.BASE || 'http://127.0.0.1:8111';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  p.on('dialog', d => d.accept());
  const all = [];
  async function audit(label, include) {
    await p.waitForTimeout(250);
    await p.addScriptTag({ content: AXE });
    const res = await p.evaluate(async ({ include, TAGS }) => {
      const ctx = include.filter(s => document.querySelector(s));
      if (!ctx.length) return { violations: [], none: true };
      const r = await axe.run({ include: ctx.map(s => [s]) }, { runOnly: { type: 'tag', values: TAGS } });
      return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help,
        nodes: v.nodes.slice(0, 40).map(n => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(0, 2).join(' ') })), count: v.nodes.length })) };
    }, { include, TAGS });
    res.violations.forEach(v => all.push(Object.assign({ screen: label }, v)));
    console.log((res.violations.length ? '✖ ' : '✔ ') + label + (res.violations.length ? ' — ' + res.violations.map(v => v.id + '×' + v.count).join(', ') : ''));
  }
  await p.goto(BASE + '/index.html', { waitUntil: 'networkidle' }); await p.waitForTimeout(500);
  await p.evaluate(async () => { await fetch('/api/budget/OP-3901?scope=project', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ create: true, name: 'A11y', address: 'x' }) }); });
  for (const theme of ['light', 'dark']) {
    await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    await p.evaluate(() => { location.hash = '#/home'; }); await p.waitForTimeout(300);
    await p.click('button:has-text("+ New Budget")'); await p.waitForTimeout(300);
    await p.click('#newBudgetModal .tpl-row[data-tpl="engine"]'); await p.waitForTimeout(400);
    await p.selectOption('#nbProject', 'OP-3901'); await p.fill('#nbName', 'A11y ' + theme); await p.click('#nbCreate'); await p.waitForTimeout(700);
    await audit(theme + ': type picker', ['.v2-picker']);
    await p.click('.v2-type[data-type="hotel-select-service"]'); await p.waitForTimeout(300);
    await audit(theme + ': quick estimate', ['#v2Inputs']);
    await p.click('[data-act="toggle"][data-key^="adv:"]');
    await audit(theme + ': component details', ['#v2Inputs']);
    await p.click('[data-act="mode"][data-mode="mixed"]'); await p.click('[data-act="add-phase"]'); await p.click('[data-act="add-shared"]');
    await audit(theme + ': mixed-use & phases', ['#v2Inputs']);
    await p.click('[data-act="mode"][data-mode="custom"]'); await p.click('[data-act="add-custom"]'); await p.click('.v2-blockbtn >> nth=0');
    await audit(theme + ': custom builder', ['#v2Inputs']);
    await p.click('[data-act="goto-detail"]'); await p.waitForTimeout(300); await p.click('[data-act="expand-all"]');
    await audit(theme + ': budget detail', ['#v2Detail']);
    await p.click('.v2-line [data-act="source"] >> nth=0');
    await audit(theme + ': source drawer', ['.v2-drawer']);
    await p.keyboard.press('Escape');
    for (const v of ['draws', 'scenarios', 'sensitivity', 'sources']) {
      await p.click(`[data-act="view"][data-view="${v}"]`);
      if (v === 'scenarios') await p.click('[data-act="add-scenario"]');
      await audit(theme + ': ' + v, ['#v2Detail']);
    }
  }
  fs.writeFileSync(process.env.OUT || '/dev/stdout', '');
  if (all.length) {
    console.log('\nDetails:');
    const seen = {};
    all.forEach(v => { const k = v.screen + v.id; if (seen[k]) return; seen[k] = 1; console.log('  [' + v.screen + ']');
      console.log('- ' + v.id + ' (' + v.impact + '): ' + v.help); v.nodes.forEach(n => console.log('    ' + n.target + ' — ' + n.summary)); });
  }
  await b.close();
  process.exit(all.length ? 1 : 0);
})();
