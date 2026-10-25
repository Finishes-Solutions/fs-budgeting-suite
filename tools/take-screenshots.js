#!/usr/bin/env node
// Capture the key estimate screens into docs/screenshots/ against a local mock.
//   PORT=8111 node test/mock-api.js &   then   BASE=http://127.0.0.1:8111 node tools/take-screenshots.js
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8111';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 960 } });
  p.on('dialog', d => d.accept());
  const shot = async (name, full) => { await p.waitForTimeout(350); await p.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!full }); };
  await p.goto(BASE + '/index.html', { waitUntil: 'networkidle' }); await p.waitForTimeout(500);
  await p.evaluate(async () => { await fetch('/api/budget/OP-3001?scope=project', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ create: true, name: 'Brazos Crossing', address: 'Fort Worth, TX' }) }); });
  await p.click('button:has-text("+ New Budget")'); await shot('00-new-budget');
  await p.click('#newBudgetModal .tpl-row[data-tpl="engine"]'); await p.waitForTimeout(400);
  await p.selectOption('#nbProject', 'OP-3001'); await p.fill('#nbName', 'Brazos Crossing'); await p.click('#nbCreate'); await p.waitForTimeout(700);
  await shot('01-type-picker');
  await p.fill('.v2-search[data-ui="q"]', 'garden'); await p.click('.v2-type[data-type="garden-multifamily"]'); await p.waitForTimeout(300);
  await p.selectOption('[data-f="p.location.region"]', 'TX-FortWorth');
  await p.fill('[data-f="p.land.value"]', '4500000'); await p.press('[data-f="p.land.value"]', 'Tab');
  await shot('02-quick-estimate');
  await p.click('[data-act="toggle"][data-key^="adv:"]'); await shot('03-component-details', true);
  await p.click('[data-act="mode"][data-mode="mixed"]');
  await p.click('[data-act="open-picker"][data-purpose="add"]'); await p.fill('.v2-search[data-ui="q"]', 'grocery'); await p.click('.v2-type[data-type="grocery-anchored-center"]');
  await p.click('[data-act="open-picker"][data-purpose="add"]'); await p.fill('.v2-search[data-ui="q"]', 'select-service'); await p.click('.v2-type[data-type="hotel-select-service"]');
  await p.click('[data-act="add-phase"]'); await p.click('[data-act="add-phase"]');
  const ids = await p.evaluate(() => ({ c: doc.engine.components.map(c => c.id), ph: doc.engine.phases.map(x => x.id) }));
  await p.selectOption(`[data-f="c.${ids.c[1]}.phaseId"]`, ids.ph[1]); await p.selectOption(`[data-f="c.${ids.c[2]}.phaseId"]`, ids.ph[2]);
  await p.click('[data-act="add-shared"]'); await p.selectOption('[data-f^="sh."][data-f$=".itemId"]', 'private-road');
  await p.fill('[data-f^="sh."][data-f$=".qty"]', '3800'); await p.press('[data-f^="sh."][data-f$=".qty"]', 'Tab');
  await p.evaluate(() => { doc.engine.shared[0].name = 'Spine road'; FSBudgetV2.materialize(doc); FSBudgetV2.paint(); });
  await shot('04-mixed-use-phases', true);
  await p.click('[data-act="mode"][data-mode="custom"]'); await p.click('[data-act="add-custom"]');
  await p.fill('.v2-search[data-ui="blockQ"]', 'pavilion'); await p.click('.v2-blockbtn >> nth=0');
  await p.fill('.v2-search[data-ui="blockQ"]', 'splash'); await p.click('.v2-blockbtn >> nth=0');
  await p.evaluate(() => { const c = doc.engine.components.find(x => x.typeId === 'custom'); c.name = 'Town green & splash pad'; FSBudgetV2.materialize(doc); FSBudgetV2.paint(); });
  await p.fill('.v2-search[data-ui="blockQ"]', ''); await shot('05-custom-builder', true);
  await p.click('#page-input [data-save-btn]'); await p.waitForTimeout(1000);
  await p.click('[data-act="goto-detail"]'); await p.waitForTimeout(400);
  await p.click('[data-act="expand-all"]');
  const ov = p.locator('.v2-ov').nth(3); const v = await ov.inputValue(); await ov.fill(String(Math.round(+v * 1.08))); await ov.press('Tab');
  await shot('06-detail-overrides');
  await p.click('.v2-line [data-act="source"] >> nth=1'); await shot('07-source-drawer');
  await p.keyboard.press('Escape');
  for (const [v2, n] of [['draws', '08-draw-schedule'], ['scenarios', '09-scenarios'], ['sensitivity', '10-sensitivity'], ['sources', '11-sources']]) {
    await p.click(`[data-act="view"][data-view="${v2}"]`);
    if (v2 === 'scenarios') { await p.click('[data-act="add-scenario"]'); await p.selectOption('[data-f$=".q"]', 'premium'); await p.click('[data-act="add-scenario"]');
      await p.fill('[data-f$=".esc"] >> nth=1', '6'); await p.press('[data-f$=".esc"] >> nth=1', 'Tab'); }
    await shot(n, v2 !== 'draws');
  }
  await p.click('[data-act="view"][data-view="detail"]');
  const sc = await p.$$eval('[data-ui="scope"] option', o => o.map(x => x.value).find(x => /^component:/.test(x)));
  await p.selectOption('[data-ui="scope"]', sc); await p.click('[data-act="proforma"]'); await p.waitForTimeout(1600);
  await shot('12-proforma-from-component');
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  const pid = await p.evaluate(() => { const h = location.hash; return null; });
  void pid;
  const bid = await p.evaluate(async () => { const r = await fetch('/api/budgets'); const j = await r.json(); return (j.find(x => /Brazos/.test(x.name || '')) || j[0]).projectId; });
  await m.goto(BASE + '/index.html#/inputs/' + bid, { waitUntil: 'networkidle' }); await m.waitForTimeout(1000);
  await m.screenshot({ path: path.join(OUT, '13-phone-inputs.png'), fullPage: false });
  await m.goto(BASE + '/index.html#/budget/' + bid, { waitUntil: 'networkidle' }); await m.waitForTimeout(1000);
  await m.screenshot({ path: path.join(OUT, '14-phone-detail.png'), fullPage: false });
  await p.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); location.hash = '#/inputs/' + doc.projectId; });
  await p.waitForTimeout(800); await shot('15-dark-theme');
  await b.close();
  console.log('screenshots written to docs/screenshots/');
})();
