// Throwaway visual-verification harness. Captures the seven screens the review
// annotates, at desktop and the app's breakpoints. Deleted after use.
const { chromium } = require('playwright');
const OUT = process.env.SHOT_OUT;
const PORT = process.env.SHOT_PORT || '8100';
const BASE = 'http://127.0.0.1:' + PORT + '/index.html';
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);

  const shot = async (name, full) => {
    await p.screenshot({ path: OUT + '/' + name + '.png', fullPage: !!full });
  };

  // ---- seed: a project, two budgets, an analysis
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(500);
  await p.click('#page-projects button:has-text("+ Create Project")');
  await p.waitForTimeout(500);
  await shot('01-create-project-modal');
  await p.fill('#npId', 'OP-0301');
  await p.fill('#npName', 'Greenville Townhomes');
  await p.fill('#npAddress', '2519 Washington St, Waller, TX 77484');
  await p.click('#npCreate');
  await p.waitForTimeout(1200);

  await p.click('#page-project button:has-text("+ New Budget")');
  await p.waitForTimeout(700);
  await shot('02-new-budget-step1');
  await p.click('#newBudgetModal .tpl-row:has-text("Multifamily")');
  await p.waitForTimeout(900);
  await shot('03-new-budget-step2');
  await p.click('#nbCreate');
  await p.waitForTimeout(900);
  await p.click('button[data-save-btn]');
  await p.waitForTimeout(1400);

  // an alternate, priced differently
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(400);
  await p.evaluate(() => FSProjects.open('OP-0301'));
  await p.waitForTimeout(900);
  await p.click('#page-project button:has-text("+ Add Alternate Budget")');
  await p.waitForTimeout(1200);
  await p.evaluate(() => { doc.projectCosts.land = 3200000; touch(); });
  await p.click('button[data-save-btn]');
  await p.waitForTimeout(1400);

  await p.evaluate(() => FSProjects.open('OP-0301'));
  await p.waitForTimeout(1100);
  await shot('04-project-detail', true);

  // the budget row menu, showing Make Primary and a red Delete
  const alt = await p.evaluate(() => FSProjects._detail().budgets.find(b => !b.isPrimary).projectId);
  await p.click(`#page-project .pj-tbl-budgets tr:has-text("${alt}") .rowmenu-btn`);
  await p.waitForTimeout(400);
  await shot('05-budget-row-menu');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);

  // the analysis picker, centered over a dimmed page
  await p.click('#page-project button:has-text("+ Add Investment Analysis")');
  await p.waitForTimeout(700);
  await shot('06-analysis-picker');
  await p.click('#invPickBody [data-pick]');
  await p.waitForTimeout(1600);

  // step 1 with a long validation message
  await p.evaluate(() => {
    const st = FSInvestmentUI._state();
    st.input.property.size.value = 0;
  });
  await p.evaluate(() => FSInvestmentUI.calculate());
  await p.waitForTimeout(1400);
  await shot('07-analysis-step1-warning', true);

  await p.evaluate(() => FSInvestmentUI.goStep(2));
  await p.waitForTimeout(500);
  await shot('08-analysis-income', true);

  await p.evaluate(() => FSInvestmentUI.goStep(6));
  await p.waitForTimeout(500);
  await shot('09-analysis-review', true);

  // projects index, both views
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(800);
  await shot('10-projects-list', true);
  await p.click('#projectsBody [data-projectview-pick="cards"]');
  await p.waitForTimeout(800);
  await shot('11-projects-cards', true);
  await p.click('#projectsBody [data-projectview-pick="comfortable"]');
  await p.waitForTimeout(600);
  await p.click('#projectsBody .pj-tbl-index .rowmenu-btn');
  await p.waitForTimeout(400);
  await shot('12-project-row-menu');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);

  // favorite it, then Home
  await p.click('#projectsBody .pj-tbl-index .rowmenu-btn');
  await p.waitForTimeout(350);
  await p.click('#pjRowMenu .rowmenu-item:has-text("Favorites")');
  await p.waitForTimeout(1300);
  await p.evaluate(() => go('home'));
  await p.waitForTimeout(1400);
  await shot('13-home-with-project', true);

  // admin activity log
  await p.evaluate(() => go('dashboard'));
  await p.waitForTimeout(1600);
  await shot('14-admin-activity', true);

  // budget editor, no stale banner
  await p.evaluate(() => go('budgets'));
  await p.waitForTimeout(700);
  await shot('15-budgets-list', true);

  // ---- breakpoints on the two busiest screens
  for (const w of [1180, 980, 760, 390]) {
    await p.setViewportSize({ width: w, height: 1000 });
    await p.evaluate(() => go('projects'));
    await p.waitForTimeout(600);
    await shot('bp-' + w + '-projects', true);
    await p.evaluate(() => FSProjects.open('OP-0301'));
    await p.waitForTimeout(900);
    await shot('bp-' + w + '-project', true);
    await p.evaluate(() => go('projects'));
    await p.waitForTimeout(400);
    await p.click('#page-projects button:has-text("+ Create Project")');
    await p.waitForTimeout(400);
    await shot('bp-' + w + '-modal');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
  }
  console.log('errors:', errs.length ? errs.join(' | ') : 'none');
  await b.close();
})();
