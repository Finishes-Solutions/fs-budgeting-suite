// Suite 23 — Financials: the derived views over one internal budget. The bank
// budget reconciles (internal + uplift, to the cent), the profit allocation
// shows markup AND margin, the waterfall toggles $/%, the intercompany section
// never double-counts, and the executive summary reads the same model. Also the
// Project Entity: the Project Information card sets it, and changing it under a
// budget still works without an approved budget or contract.
const { chromium } = require('playwright');
const R = []; const ok = (n, c, e = '') => R.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`);
(async () => { try {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  p.on('dialog', d => d.accept());
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);

  // ---------- seed a project + budget through the API ----------
  await p.evaluate(async () => {
    await fetch('/api/budget/OP-9301?scope=project', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ create: true, name: 'Financials Test', address: '9 Ledger Ln' }) });
    const doc = blankDoc('full');
    doc.projectId = 'BDG-9301-01'; doc.projectKey = 'OP-9301'; doc.name = 'Financials Budget';
    await fetch('/api/budget/BDG-9301-01', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: { projectId: 'BDG-9301-01', name: 'Financials Budget', projectKey: 'OP-9301' }, doc }) });
  });

  // ---------- 1. the Financials workflow step exists and routes ----------
  await p.goto('http://127.0.0.1:8100/index.html#/budget/BDG-9301-01', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  ok('the workflow pills include Financials',
    /Financials/.test(await p.locator('[data-wf-pills]').first().textContent()));
  await p.goto('http://127.0.0.1:8100/index.html#/financials/BDG-9301-01', { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ok('Financials routes to #/financials/<id>', /#\/financials\/BDG-9301-01$/.test(p.url()), p.url());

  // ---------- 2. the bank budget reconciles ----------
  const bank = await p.evaluate(() => {
    const m = FSBudgetFinancials._model();
    return { internal: m.bank.internalTotal, bank: m.bank.bankTotal, uplift: m.bank.upliftUsd,
      rowsSum: m.bank.rows.reduce((s, r) => s + r.bank, 0) };
  });
  ok('bank total is internal + uplift', Math.abs(bank.bank - (bank.internal + bank.uplift)) < 0.02,
    bank.internal + ' + ' + bank.uplift + ' vs ' + bank.bank);
  ok('bank rows sum to the bank total', Math.abs(bank.rowsSum - bank.bank) < 0.02, bank.rowsSum + ' vs ' + bank.bank);
  ok('the default uplift is 10% of internal cost', Math.abs(bank.bank - bank.internal * 1.10) < 0.02,
    (bank.bank / bank.internal).toFixed(4));
  ok('the bank table renders on screen', /Bank .+Budget/.test(await p.locator('#bankBody').textContent()));

  // ---------- 3. profit allocation shows markup AND margin ----------
  const split = await p.evaluate(() => {
    const m = FSBudgetFinancials._model();
    const fs = m.alloc.rows.find(r => r.entityKey === 'finishes-solutions');
    return { count: m.alloc.rows.length, profit: m.alloc.totalProfit, partsProfit: m.parts.profit,
      markup: fs && fs.markupPct, margin: fs && fs.marginPct };
  });
  ok('the default budget yields a Finishes Solutions split', split.count >= 1);
  ok('allocated profit equals parts().profit', Math.abs(split.profit - split.partsProfit) < 0.02,
    split.profit + ' vs ' + split.partsProfit);
  ok('both markup and margin are present', split.markup != null && split.margin != null,
    'markup=' + split.markup + ' margin=' + split.margin);
  ok('the splits table headers name Markup and Margin',
    /Markup/.test(await p.locator('#splitsBody').textContent()) && /Margin/.test(await p.locator('#splitsBody').textContent()));

  // ---------- 4. the waterfall toggles $ / % ----------
  ok('the waterfall draws an SVG', await p.locator('#waterfallBody svg.wf-svg').count() > 0);
  await p.click('#waterfallBody .fin-toggle button:has-text("%")');
  await p.waitForTimeout(300);
  ok('switching to % re-renders the waterfall with a percentage',
    /%/.test(await p.locator('#waterfallBody').textContent()));
  await p.click('#waterfallBody .fin-toggle button:has-text("$")');
  await p.waitForTimeout(300);
  ok('switching back to $ re-renders with dollars',
    /\$/.test(await p.locator('#waterfallBody').textContent()));

  // ---------- 5. intercompany reconciliation identity ----------
  const con = await p.evaluate(() => {
    const m = FSBudgetFinancials._model();
    const gross = m.con.entityRevenue.reduce((s, e) => s + e.total, 0);
    return { ok: m.con.checks.identity, gross, ext: m.con.consolidatedExternalRevenue, inter: m.con.intercompanyTotal };
  });
  ok('consolidated external = gross − intercompany',
    Math.abs((con.gross - con.inter) - con.ext) < 0.02 && con.ok,
    con.gross + ' - ' + con.inter + ' vs ' + con.ext);

  // ---------- 6. executive summary on the budget page reads the same model ----------
  await p.goto('http://127.0.0.1:8100/index.html#/budget/BDG-9301-01', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  const exec = await p.locator('#execBody').textContent();
  ok('the executive summary shows the internal project cost', /Internal Project Cost/.test(exec));
  ok('and the bank budget', /Bank .*Budget/.test(exec));
  ok('and the reconciliation status', /Reconcil/.test(exec));

  // ---------- 7. Project Entity via the Project Information card ----------
  await p.goto('http://127.0.0.1:8100/index.html#/project/OP-9301', { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ok('the Project Information card is present', await p.locator('#sec-projinfo').count() > 0);
  ok('and offers a Project Entity picker', await p.locator('#pjEntity').count() > 0);
  await p.selectOption('#pjEntity', { label: 'Finishes Solutions (Finishes Solutions LLC)' }).catch(() => {});
  await p.click('#sec-projinfo button:has-text("Save Project Info")');
  await p.waitForTimeout(800);
  const sub = await p.locator('#projectSub').textContent();
  ok('the project sub-line shows the entity', /Finishes Solutions/.test(sub), sub);

  ok('no JS errors', errs.length === 0, errs.join(' | '));
  console.log(R.join('\n'));
  console.log('\n' + R.filter(r => r.startsWith('FAIL')).length + ' failures of ' + R.length);
  await b.close();
} catch (e) { console.log(R.join('\n')); console.log('\nABORTED: ' + e.message.split('\n')[0]); process.exit(1); } })();
