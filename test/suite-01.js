const { chromium } = require('playwright');
const OUT = process.env.OUT_DIR || require('os').tmpdir();
const R = [];
const ok = (n, c, extra='') => R.push(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? ' — ' + extra : ''}`);

(async () => {
 try {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  let dialogs = 0;
  p.on('dialog', async d => { dialogs++; await d.accept(); });
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });

  await p.goto('http://127.0.0.1:8099/index.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  // The cold-start screen must clear even when the API is dead, or a paused
  // database would leave the app stuck behind an overlay forever.
  ok('Cold-start screen clears when the API is down',
     (await p.locator('#bootScreen').count()) === 0);
  ok('The app is usable behind it', await p.locator('#page-home').isVisible());

  ok('The account avatar is hidden with no signed-in principal',
     await p.locator('#profileBtn').isHidden());

  // D3 — API is absent here, so the offline banner must be visible
  ok('D3 offline banner shows when API is unreachable', await p.locator('#apiBanner').isVisible());
  ok('D3 banner text is specific', /pricing library/i.test(await p.locator('#apiBannerMsg').textContent()));

  // Nav + routing
  ok('Help tab exists in More dropdown', (await p.locator('#nav-help').count()) === 1);
  await p.evaluate(() => go('help')); await p.waitForTimeout(300);
  ok('U4 hash set for help', p.url().endsWith('#/help'), p.url());
  ok('Help page visible', await p.locator('#page-help').isVisible());
  ok('Help TOC has 15 entries', (await p.locator('#helpToc a').count()) === 15,
     String(await p.locator('#helpToc a').count()));
  await p.screenshot({ path: OUT + '/help.png', fullPage: false });

  // New budget
  await p.click('#nav-home');
  // Creating a budget is async now — it fetches the template's current published
  // version first, and offline it falls back to the built-in defaults. isVisible()
  // does not auto-wait, so give the fallback a moment to land.
  await p.click('button:has-text("+ New Budget")').then(()=>p.click('#newBudgetModal .tpl-row:has-text("Multifamily")'));
  await p.waitForTimeout(400);
  // A budget belongs to a project, so the dialog asks which one. Offline the
  // list cannot be read at all, so the field says so and stops being required
  // — there is nothing to link to and nothing can be saved anyway.
  ok('the project step says the list is unavailable offline',
     await p.locator('#nbProject').isDisabled()
     && /offline/i.test(await p.locator('#nbProject').textContent()),
     (await p.locator('#nbProject').textContent()).trim());
  await p.fill('#nbId','BD-0001');
  await p.fill('#nbName','Offline Budget');
  await p.click('#nbCreate');
  await p.waitForTimeout(400);
  ok('Inputs page after new budget', await p.locator('#page-input').isVisible());
  ok('U4 hash for inputs', p.url().endsWith('#/inputs'), p.url());

  // TST id validation
  await p.fill('#pId', 'TST-9999');
  await p.locator('#pName').click();
  ok('TST-9999 accepted by validator', !(await p.locator('#pId').evaluate(e => e.classList.contains('err'))));
  await p.fill('#pId', 'ZZ-1');
  await p.locator('#pName').click();
  ok('Bad ID still rejected', await p.locator('#pId').evaluate(e => e.classList.contains('err')));
  await p.fill('#pId', 'TST-9999');
  await p.fill('#pName', 'Preview <Test> & Co');   // D4 escaping
  await p.locator('#pSF').click();

  // D2 — dirty pill
  ok('D2 save pill shows unsaved changes', /unsaved/i.test(await p.locator('#saveState').textContent()));

  // D1 — tab-through focus retention (the core bug)
  const cnt = p.locator('[data-k="units.0.count"]');
  await cnt.click();
  await cnt.fill('20');
  await p.keyboard.press('Tab');
  await p.waitForTimeout(250);
  const focusKey = await p.evaluate(() => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null);
  ok('D1 Tab moves to next field instead of losing focus', focusKey === 'units.0.rent', 'focus=' + focusKey);
  const recalced = await p.locator('#uCount').textContent();
  ok('D1 totals still recalculated on commit', recalced.trim() === '62', 'units=' + recalced);

  // Caret restoration inside a text field
  const lbl = p.locator('[data-k="units.0.label"]');
  await lbl.click();
  await lbl.press('End');
  await lbl.type('X');
  await p.waitForTimeout(150);
  ok('D1 text edits keep focus', await lbl.evaluate(e => e === document.activeElement));

  // Budget page
  await p.click('button:has-text("Continue to Budget")');
  ok('Budget page visible', await p.locator('#page-budget').isVisible());
  ok('U4 hash carries project id', p.url().endsWith('#/budget/TST-9999'), p.url());
  ok('TST banner visible', await p.locator('#testBanner').isVisible());
  ok('D3 pricing badge flags fallback', /built-in fallback/.test(await p.locator('#mPricing').textContent()));

  // D4 — name with < > & renders literally, no broken markup
  const sub = await p.locator('#bTitle').textContent();
  ok('D4 unsafe name renders literally', sub.includes('Preview <Test> & Co'), sub);

  // D5 — status
  // Status is the shared chip, opened from the budget header.
  await p.click('#bStatusHost .st-chip'); await p.waitForTimeout(200);
  await p.click('#stMenu [data-st="Completed"]'); await p.waitForTimeout(300);
  ok('D5 status settable',
     (await p.locator('#bStatusHost .st-chip').textContent()).trim() === 'Completed');

  // U1 — collapse
  const before = await p.locator('#budBody tr').count();
  await p.click('button:has-text("Collapse All")');
  const after = await p.locator('#budBody tr').count();
  ok('U1 collapse all hides lines', after < before, `${before} → ${after} rows`);
  // Header totals moved from a floating .div-sum into real Total / % cells so they
  // align with the columns beneath; they must survive collapsing.
  const scopeHd = p.locator('#budBody .scope-hd').first();
  ok('U1 scope subtotal still shown when collapsed',
     (await scopeHd.locator('td.calc.strong').textContent()).startsWith('$'));
  ok('U1 scope percentage still shown when collapsed',
     /^(100\.0%|—)$/.test((await scopeHd.locator('td.calc').nth(1).textContent()).trim()));
  ok('U1 scope header cells align with the Total and % columns',
     (await scopeHd.locator('td').count()) === 4
     && (await scopeHd.locator('td').first().getAttribute('colspan')) === '5');
  // collapse state survives a recalc
  await p.evaluate(()=>touch());        // force a recalc without needing a visible field
  await p.waitForTimeout(250);
  ok('U1 collapse survives recalc', (await p.locator('#budBody tr').count()) === after);
  await p.click('button:has-text("Expand All")');
  ok('U1 expand all restores', (await p.locator('#budBody tr').count()) === before);
  await p.screenshot({ path: OUT + '/budget.png', fullPage: false });

  // U1 sticky header
  await p.locator('.budget-scroll').evaluate(e => e.scrollTop = 400);
  await p.waitForTimeout(200);
  const stickyOk = await p.locator('.budget-scroll thead th').first().evaluate(e => getComputedStyle(e).position === 'sticky');
  ok('U1 header is sticky', stickyOk);

  // D2 — the unsaved guard must fire when leaving a dirty budget
  const before2 = dialogs;
  await p.click('#nav-budgets');
  ok('D2 leaving a dirty budget prompts', dialogs === before2 + 1, `dialogs=${dialogs}`);

  // U2 — the budgets list controls (no data, but they must wire without error)
  await p.fill('#budgetsSearch', 'BD');
  await p.selectOption('#budgetsStatus', 'Draft');
  await p.click('#budgetsHead th[data-sort="name"]');
  ok('U2 budgets list controls operate without error', true);
  ok('U2 empty state message switches', /No budgets yet/.test(await p.locator('#budgetsEmptyBig').textContent()));

  // U4 — deep link on cold load
  await p.goto('http://127.0.0.1:8099/index.html#/pricing', { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  ok('U4 deep link to pricing on cold load', await p.locator('#page-pricing').isVisible());
  ok('Pricing renders from fallback seed', (await p.locator('#priceBody tr').count()) > 100,
     (await p.locator('#priceBody tr').count()) + ' rows');
  await p.screenshot({ path: OUT + '/pricing.png' });

  ok('No uncaught JS errors', errs.length === 0, errs.join(' | '));

  console.log(R.join('\n'));
  console.log('\n' + R.filter(r => r.startsWith('FAIL')).length + ' failures of ' + R.length);
  await b.close();
 } catch (e) {
  console.log(R.join('\n'));
  console.log('\nABORTED: ' + e.message.split('\n')[0]);
  process.exit(1);
 }
})();
