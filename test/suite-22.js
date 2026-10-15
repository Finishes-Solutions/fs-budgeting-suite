// Suite 22 — the review's own acceptance criteria, end to end in the browser.
//
// One theme runs through all of it: a PROJECT is a thing in its own right,
// with its own OP-#### identity, and a BUDGET is a different thing with a
// BD-#### identity that belongs to one. Everything the review asked for falls
// out of keeping those two apart and saying so on screen.
const { chromium } = require('playwright');
const R = []; const ok = (n, c, e = '') => R.push(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? ' — ' + e : ''}`);

(async () => { try {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
  const p = await ctx.newPage();
  const dialogs = [];
  p.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  // ================= comment 5 — Create Project =================
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(500);
  ok('the Projects page offers Create Project, not New Budget',
     await p.locator('#page-projects button:has-text("+ Create Project")').isVisible()
     && (await p.locator('#page-projects button:has-text("+ New Budget")').count()) === 0);

  await p.click('#page-projects button:has-text("+ Create Project")');
  await p.waitForTimeout(400);

  // ---- comment 3/5 — a real, centered dialog over a dimmed page
  ok('the dialog is fixed and centered in the viewport',
     await p.evaluate(() => {
       const m = document.getElementById('newProjectModal');
       const s = getComputedStyle(m);
       if (s.position !== 'fixed' || s.display !== 'flex') return false;
       const sheet = m.querySelector('.mod-sheet').getBoundingClientRect();
       const dx = Math.abs((sheet.left + sheet.right) / 2 - innerWidth / 2);
       const dy = Math.abs((sheet.top + sheet.bottom) / 2 - innerHeight / 2);
       return dx < 4 && dy < 60;   // vertical slack for a tall sheet
     }));
  ok('and the page behind it is dimmed',
     await p.evaluate(() => {
       const bg = getComputedStyle(document.getElementById('newProjectModal')).backgroundColor;
       const m = bg.match(/rgba?\(([^)]+)\)/);
       if (!m) return false;
       const parts = m[1].split(',').map(Number);
       return parts.length === 4 && parts[3] > 0.2 && parts[3] < 0.9;
     }),
     await p.evaluate(() => getComputedStyle(document.getElementById('newProjectModal')).backgroundColor));
  ok('and the page behind it does not scroll',
     await p.evaluate(() => getComputedStyle(document.body).overflow === 'hidden'));
  ok('focus enters the dialog',
     await p.evaluate(() => document.getElementById('newProjectModal').contains(document.activeElement)));

  // ---- the ID rule, in the UI
  ok('the ID field is offered a free OP-#### to start from',
     /^OP-\d{4}$/.test(await p.locator('#npId').inputValue()),
     await p.locator('#npId').inputValue());
  await p.fill('#npId', 'BD-0001');
  await p.waitForTimeout(150);
  ok('a budget-shaped ID is refused with the format message',
     await p.locator('#npIdErr').isVisible()
     && /Use the format OP-####\./.test(await p.locator('#npIdErr').textContent()),
     (await p.locator('#npIdErr').textContent()).trim());
  ok('and Create stays disabled while it is wrong',
     await p.locator('#npCreate').isDisabled());
  await p.fill('#npId', 'op-0900');
  await p.waitForTimeout(120);
  ok('lowercase is normalised to upper as it is typed',
     (await p.locator('#npId').inputValue()) === 'OP-0900');

  await p.fill('#npName', 'Riverbend Phase 1');
  await p.fill('#npAddress', '10514 Woodedge Dr');
  await p.waitForTimeout(150);
  ok('Create enables once all three required fields are in',
     await p.locator('#npCreate').isEnabled());
  await p.click('#npCreate');
  const opened = await p.waitForURL(/#\/project\/OP-0900/, { timeout: 15000 })
    .then(() => true).catch(() => false);
  await p.waitForTimeout(400);
  ok('creating the project opens it', opened && /#\/project\/OP-0900/.test(p.url()), p.url());
  ok('and the heading shows the project ID, not a budget ID',
     /^OP-0900 — Riverbend Phase 1/.test((await p.locator('#projectTitle').textContent()).trim()),
     (await p.locator('#projectTitle').textContent()).trim());

  // ---- uniqueness, decided by the API
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(500);
  await p.click('#page-projects button:has-text("+ Create Project")');
  await p.waitForTimeout(300);
  await p.fill('#npId', 'OP-0900');
  await p.fill('#npName', 'Duplicate');
  await p.fill('#npAddress', 'Nowhere');
  await p.click('#npCreate');
  await p.waitForTimeout(700);
  ok('a duplicate project ID is refused, inline, on the ID field',
     await p.locator('#npIdErr').isVisible()
     && /unique/i.test(await p.locator('#npIdErr').textContent()),
     (await p.locator('#npIdErr').textContent()).trim());
  ok('and the dialog stays open rather than pretending it worked',
     await p.locator('#newProjectModal').isVisible());
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  ok('Escape closes the dialog', !(await p.locator('#newProjectModal').isVisible()));
  ok('and the page scrolls again', await p.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden'));
  ok('and focus returns to the control that opened it',
     await p.evaluate(() => {
       const a = document.activeElement;
       return !!a && /Create Project/.test(a.textContent || '');
     }),
     await p.evaluate(() => (document.activeElement && document.activeElement.textContent || '').trim().slice(0, 40)));

  // ================= comment 8 — prefill and required size =================
  await p.evaluate(() => FSProjects.open('OP-0900'));
  await p.waitForSelector('#page-project button:has-text("+ New Budget")', { timeout: 15000 });
  await p.waitForTimeout(300);
  await p.click('#page-project button:has-text("+ New Budget")');
  await p.waitForTimeout(700);
  ok('creating a budget from a project preselects that project',
     (await p.locator('#nbProject').inputValue()) === 'OP-0900',
     await p.locator('#nbProject').inputValue());
  await p.click('#newBudgetModal .tpl-row:has-text("Multifamily")');
  await p.waitForTimeout(700);
  ok('the Budget ID suggested is the project\'s first child, BDG-0900-01',
     (await p.locator('#nbId').inputValue()) === 'BDG-0900-01',
     await p.locator('#nbId').inputValue());
  ok('the project name and address are carried across',
     (await p.locator('#nbName').inputValue()) === 'Riverbend Phase 1'
     && (await p.locator('#nbAddress').inputValue()) === '10514 Woodedge Dr',
     await p.locator('#nbName').inputValue() + ' | ' + await p.locator('#nbAddress').inputValue());
  const newBudgetId = await p.locator('#nbId').inputValue();
  await p.click('#nbCreate');
  await p.waitForTimeout(700);
  ok('the budget opens on Inputs carrying its project',
     await p.locator('#page-input').isVisible()
     && (await p.locator('#pProject').inputValue()) === 'OP-0900',
     await p.locator('#pProject').inputValue());
  ok('the Inputs page labels it a Budget ID',
     /Budget ID/.test(await p.locator('#page-input #sec-project, #page-input .card').first().textContent()));

  // ---- size is required, and refused by BOTH sides
  await p.fill('#pSF', '0');
  await p.fill('#pASF', '0');
  await p.click('button[data-save-btn]');
  await p.waitForTimeout(600);
  ok('a sizeless budget cannot be saved',
     await p.locator('#pSizeErr').isVisible(),
     (await p.locator('#pSizeErr').textContent()).trim());
  const apiSize = await p.evaluate(async () => {
    const r = await fetch('/api/budget/BD-9922', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ create: true,
        meta: { projectId: 'BD-9922', name: 'Sizeless', status: 'Draft', projectKey: 'OP-0900' },
        doc: { projectId: 'BD-9922', name: 'Sizeless', address: '', resSF: 0, amenSF: 0, siteSF: 0,
               units: [], other: [], expenses: [], lines: [], companies: [],
               contingency: { mode: 'fixed', val: 0 }, projectCosts: { land: 0, dev: 0, mkt: 0, cls: 0 } } }) });
    return { status: r.status, body: await r.json() };
  });
  ok('and the API refuses it independently of the form',
     apiSize.status === 422 && apiSize.body.error === 'size_required',
     JSON.stringify(apiSize.body).slice(0, 120));

  await p.fill('#pSF', '51365');
  await p.fill('#pASF', '1200');
  await p.waitForTimeout(200);
  ok('filling the size clears the error', !(await p.locator('#pSizeErr').isVisible()));
  await p.click('button[data-save-btn]');
  await p.waitForTimeout(900);

  // ================= comment 6 — the current pricing library =================
  const pricing = await p.evaluate(async () => {
    const cur = await (await fetch('/api/pricing')).json();
    const next = JSON.parse(JSON.stringify(cur));
    next.version = '2099.01-vTest';
    next.effective = '2099-01-01';
    await fetch('/api/pricing', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next) });
    return { was: cur.version, now: next.version };
  });
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(400);
  await p.evaluate(() => FSProjects.open('OP-0900'));
  await p.waitForSelector('#page-project button:has-text("+ New Budget")', { timeout: 15000 });
  await p.waitForTimeout(300);
  await p.click('#page-project button:has-text("+ New Budget")');
  await p.waitForTimeout(600);
  await p.click('#newBudgetModal .tpl-row:has-text("Multifamily")');
  await p.waitForTimeout(700);
  await p.fill('#nbName', 'Post-publish Budget');
  await p.click('#nbCreate');
  await p.waitForTimeout(900);
  ok('a budget created after a publish is born on the new library',
     (await p.evaluate(() => doc.pricingVersion)) === pricing.now,
     pricing.was + ' → ' + await p.evaluate(() => doc.pricingVersion));
  await p.evaluate(() => go('budget'));
  await p.waitForTimeout(500);
  ok('so it does not open flagged as outdated',
     !(await p.locator('#staleBanner').isVisible()));

  // ================= comment 7 — origin-aware Back =================
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(400);
  await p.evaluate(() => FSProjects.open('OP-0900'));
  await p.waitForTimeout(700);
  await p.click(`#page-project .pj-tbl-budgets tr:has-text("${newBudgetId}")`);
  await p.waitForTimeout(700);
  ok('a budget opened from a project remembers where it came from',
     await p.evaluate(() => budgetOrigin && budgetOrigin.page === 'project' && budgetOrigin.id === 'OP-0900'),
     JSON.stringify(await p.evaluate(() => budgetOrigin)));
  ok('and Back says so', /Back to OP-0900/.test(
     await p.locator('.page.on .btn-back').getAttribute('title') || ''),
     await p.locator('.page.on .btn-back').getAttribute('title'));
  await p.click('.page.on .btn-back');
  await p.waitForTimeout(800);
  ok('Back returns to that project, not to the Budgets list',
     /#\/project\/OP-0900/.test(p.url()), p.url());

  // opened from the Budgets list, Back goes to the Budgets list
  await p.evaluate(() => go('budgets'));
  await p.waitForTimeout(600);
  await p.evaluate(id => openBudget(id, 'budget'), newBudgetId);
  await p.waitForTimeout(700);
  await p.click('.page.on .btn-back');
  await p.waitForTimeout(600);
  ok('with no project origin, Back falls back to the Budgets list',
     await p.locator('#page-budgets').isVisible(), p.url());

  // ================= comments 1 and 2 — Make Primary =================
  await p.evaluate(() => FSProjects.open('OP-0900'));
  await p.waitForSelector('#projectBody .pj-stats', { timeout: 15000 });
  await p.waitForTimeout(400);
  await p.click('#page-project button:has-text("+ Add Alternate Budget")');
  await p.waitForTimeout(800);
  // make the alternate visibly more expensive, so "which budget" is provable
  await p.evaluate(() => { doc.projectCosts.land = 5000000; touch(); });
  await p.waitForTimeout(200);
  await p.click('button[data-save-btn]');
  await p.waitForTimeout(1000);
  await p.evaluate(() => FSProjects.open('OP-0900'));
  await p.waitForSelector('#projectBody .pj-stats', { timeout: 15000 });
  await p.waitForTimeout(400);

  ok('the summary card is named Total Project Cost (Primary)',
     /Total Project Cost \(Primary\)/.test(await p.locator('#projectBody .pj-stats').textContent()),
     (await p.locator('#projectBody .pj-stats').textContent()).replace(/\s+/g, ' ').slice(0, 160));

  const money = await p.evaluate(() => {
    const d = FSProjects._detail();
    return { card: d.project.liveProjectCost,
             budgets: d.budgets.map(x => ({ id: x.projectId, cost: x.projectCost, primary: x.isPrimary })) };
  });
  const primaryB = money.budgets.find(x => x.primary);
  ok('and it reports the primary budget alone',
     money.card === primaryB.cost
     && money.card !== money.budgets.reduce((s, x) => s + x.cost, 0),
     JSON.stringify(money));
  ok('exactly one budget is flagged primary',
     money.budgets.filter(x => x.primary).length === 1);

  // the row menu offers Make Primary only where it means something
  const altId = money.budgets.find(x => !x.primary).id;
  await p.click(`#page-project .pj-tbl-budgets tr:has-text("${primaryB.id}") .rowmenu-btn`);
  await p.waitForTimeout(300);
  ok('the budget that is already primary is not offered Make Primary',
     !/Make Primary/.test(await p.locator('#rowMenu').textContent()),
     (await p.locator('#rowMenu').textContent()).replace(/\s+/g, ' ').slice(0, 120));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);

  await p.click(`#page-project .pj-tbl-budgets tr:has-text("${altId}") .rowmenu-btn`);
  await p.waitForTimeout(300);
  ok('a non-primary budget is', /Make Primary/.test(await p.locator('#rowMenu').textContent()));
  ok('and Delete is red', await p.evaluate(() => {
    const d = [...document.querySelectorAll('#rowMenu .rowmenu-item')].find(x => /Delete/.test(x.textContent));
    if (!d) return false;
    const c = getComputedStyle(d).color;
    const m = c.match(/\d+/g).map(Number);
    return m[0] > 120 && m[1] < 90 && m[2] < 90;   // a red, not the default ink
  }), await p.evaluate(() => {
    const d = [...document.querySelectorAll('#rowMenu .rowmenu-item')].find(x => /Delete/.test(x.textContent));
    return d ? getComputedStyle(d).color : 'none';
  }));
  await p.click('#rowMenu .rowmenu-item:has-text("Make Primary")');
  await p.waitForTimeout(1200);

  const after = await p.evaluate(() => {
    const d = FSProjects._detail();
    return { primary: d.project.primaryBudgetId, card: d.project.liveProjectCost,
             flags: d.budgets.map(x => ({ id: x.projectId, primary: x.isPrimary, cost: x.projectCost })) };
  });
  ok('Make Primary moves the flag to that budget',
     after.primary === altId && after.flags.find(x => x.id === altId).primary,
     JSON.stringify(after));
  ok('and demotes the previous one in the same move — never two, never none',
     after.flags.filter(x => x.primary).length === 1);
  ok('and the project total follows the new primary',
     after.card === after.flags.find(x => x.id === altId).cost,
     JSON.stringify(after));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ok('and it survives a reload — it is stored, not painted',
     (await p.evaluate(async () => (await (await fetch('/api/budgets?scope=project&id=OP-0900')).json())
        .project.primaryBudgetId)) === altId);

  // ================= comments 3 and 4 — the analysis picker =================
  await p.evaluate(() => FSProjects.open('OP-0900'));
  await p.waitForSelector('#projectBody .pj-stats', { timeout: 15000 });
  await p.waitForTimeout(400);
  await p.click('#page-project button:has-text("+ Add Investment Analysis")');
  await p.waitForTimeout(600);
  ok('the Add Investment Analysis picker is a centered dialog',
     await p.evaluate(() => {
       const m = document.getElementById('invPickModal');
       const s = getComputedStyle(m);
       if (s.position !== 'fixed' || s.display !== 'flex') return false;
       const r = m.querySelector('.mod-sheet').getBoundingClientRect();
       return Math.abs((r.left + r.right) / 2 - innerWidth / 2) < 4;
     }));
  ok('over a dimmed page, with the page behind locked',
     await p.evaluate(() => getComputedStyle(document.body).overflow === 'hidden'
       && /rgba/.test(getComputedStyle(document.getElementById('invPickModal')).backgroundColor)));
  ok('and it is above the page content',
     await p.evaluate(() => +getComputedStyle(document.getElementById('invPickModal')).zIndex >= 50));
  ok('focus is inside it',
     await p.evaluate(() => document.getElementById('invPickModal').contains(document.activeElement)));

  // ---- comment 4: it must not survive leaving the project
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(600);
  ok('leaving the project unmounts the picker',
     !(await p.locator('#invPickModal').isVisible()));
  for (const page of ['budgets', 'analyses', 'home']) {
    await p.evaluate(x => go(x), page);
    await p.waitForTimeout(300);
    ok('and it does not reappear on ' + page, !(await p.locator('#invPickModal').isVisible()));
  }
  ok('and the page scrolls again after it goes',
     await p.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden'));

  // ================= project row menu, favorites and delete =================
  await p.evaluate(() => go('projects'));
  await p.waitForSelector('#projectsBody .pj-tbl-index', { timeout: 15000 });
  await p.waitForTimeout(300);
  ok('project rows carry a ⋮ menu instead of an Open arrow',
     (await p.locator('#projectsBody .pj-tbl-index .rowmenu-btn').count()) > 0
     && (await p.locator('#projectsBody .pj-go').count()) === 0);
  await p.click('#projectsBody .pj-tbl-index tr:has-text("OP-0900") .rowmenu-btn');
  await p.waitForTimeout(300);
  const pjMenu = await p.locator('#pjRowMenu').textContent();
  ok('it offers Favorite and Delete Project',
     /Favorites/.test(pjMenu) && /Delete Project/.test(pjMenu), pjMenu.replace(/\s+/g, ' '));
  ok('and Delete Project is red', await p.evaluate(() => {
    const d = [...document.querySelectorAll('#pjRowMenu .rowmenu-item')].find(x => /Delete/.test(x.textContent));
    const m = getComputedStyle(d).color.match(/\d+/g).map(Number);
    return m[0] > 120 && m[1] < 90 && m[2] < 90;
  }));
  await p.click('#pjRowMenu .rowmenu-item:has-text("Favorites")');
  await p.waitForTimeout(1400);

  // ================= a favorited project shows on Home =================
  await p.evaluate(() => go('home'));
  await p.waitForTimeout(1200);
  ok('a favorited project appears on Home',
     await p.evaluate(() => {
       const favs = FSHome._favorites();
       return favs.project.includes('OP-0900');
     }));
  const homeTxt = await p.locator('#homeContent').textContent();
  ok('and it is rendered there, labelled as a Project',
     /OP-0900/.test(homeTxt) && /Riverbend Phase 1/.test(homeTxt),
     homeTxt.replace(/\s+/g, ' ').slice(0, 200));
  ok('clicking it opens the project',
     await p.evaluate(async () => {
       const card = [...document.querySelectorAll('#homeContent .hm-card')]
         .find(c => /OP-0900/.test(c.textContent));
       if (!card) return false;
       card.click();
       await new Promise(r => setTimeout(r, 900));
       return location.hash.indexOf('#/project/OP-0900') === 0;
     }));

  // ================= the activity log says what happened =================
  await p.evaluate(() => go('home'));
  await p.waitForTimeout(1000);
  const log = await p.evaluate(async () => (await (await fetch('/api/user-activity')).json()).events);
  const fav = log.find(e => e.eventType === 'favorite_add' && e.entityType === 'project');
  ok('favoriting a project is logged as favoriting THAT project',
     !!fav && fav.entityId === 'OP-0900' && fav.detail && fav.detail.name === 'Riverbend Phase 1',
     JSON.stringify(fav || null));
  const homeLog = await p.locator('#homeContent .hm-log').textContent().catch(() => '');
  ok('and Home reads it back in words, not as "Updated settings"',
     /Favorited/.test(homeLog) && !/Updated settings/.test(homeLog),
     homeLog.replace(/\s+/g, ' ').slice(0, 200));

  // ================= comment 10 — Year 1 potential income =================
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(500);
  await p.evaluate(() => FSProjects.open('OP-0900'));
  await p.waitForSelector('#projectBody .pj-stats', { timeout: 15000 });
  await p.waitForTimeout(400);
  await p.click('#page-project button:has-text("+ Add Investment Analysis")');
  await p.waitForTimeout(600);
  if (await p.locator('#invPickModal').isVisible()) {
    await p.click('#invPickBody [data-pick]');
  }
  await p.waitForTimeout(1400);
  ok('an analysis opens from the project', /#\/analysis\//.test(p.url()), p.url());
  // The identifier model's display id: INA-<project number>-<item>, composed
  // by the one shared helper and shown beside the source budget.
  ok('the editor shows the INA display id',
     /INA-0900-01/.test(await p.locator('#page-analysis .sub, .page.on .sub').first().textContent()),
     (await p.locator('.page.on .sub').first().textContent()).replace(/\s+/g, ' ').slice(0, 120));
  await p.evaluate(() => FSInvestmentUI.goStep(2));
  await p.waitForTimeout(400);
  ok('the top income field is Year 1 - Potential Income',
     /Year 1 - Potential Income/.test(await p.locator('[data-steppane="2"]').textContent()));
  ok('and the rental component keeps its own field',
     /Unit \/ Rental Income/.test(await p.locator('[data-steppane="2"]').textContent()));
  const inc = await p.evaluate(() => {
    const i = FSInvestmentUI._state().input.income;
    const other = (i.otherIncome || []).reduce((s, r) => s + (+r.year1Amount || 0), 0);
    const shown = document.getElementById('invY1Total').value.replace(/[^0-9.]/g, '');
    return { unit: +i.year1PotentialIncome || 0, other: other, shown: +shown };
  });
  ok('the total shown is unit income plus other income',
     Math.abs(inc.shown - (inc.unit + inc.other)) < 1, JSON.stringify(inc));
  ok('and it is read-only — it is a sum, not a second owner of the number',
     await p.locator('#invY1Total').evaluate(e => e.readOnly));

  // nothing downstream double-counts: GOI is still rent-after-vacancy + other.
  // The assumptions an imported analysis cannot know are filled in first —
  // an exit cap and an expense ratio — so there is a result to read.
  await p.evaluate(() => FSInvestmentUI.goStep(5));
  await p.waitForTimeout(300);
  await p.fill('[data-f="disposition.exitCapRate.value"]', '6');
  await p.locator('[data-f="disposition.exitCapRate.value"]').dispatchEvent('change');
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const st = FSInvestmentUI._state();
    if (st.input.expenses.value === null || st.input.expenses.value === undefined) {
      st.input.expenses.value = 0.35;
    }
  });
  await p.evaluate(() => FSInvestmentUI.calculate());
  await p.waitForTimeout(1600);
  const yr1 = await p.evaluate(() => {
    const st = FSInvestmentUI._state();
    if (!st.result) return null;
    const a = st.result.annual[0];
    return { potential: a.potentialIncome, vac: a.vacancyLoss, eff: a.effectiveRentalIncome,
             other: a.otherIncome, goi: a.grossOperatingIncome,
             unitInput: +st.input.income.year1PotentialIncome || 0 };
  });
  if (yr1) {
    ok('the projection still applies vacancy to rent alone',
       Math.abs(yr1.potential - yr1.unitInput) < 1
       && Math.abs(yr1.eff - (yr1.potential - yr1.vac)) < 1,
       JSON.stringify(yr1));
    ok('and Gross Operating Income adds other income exactly once',
       Math.abs(yr1.goi - (yr1.eff + yr1.other)) < 1, JSON.stringify(yr1));
  } else {
    ok('the projection still applies vacancy to rent alone', false, 'no result');
    ok('and Gross Operating Income adds other income exactly once', false, 'no result');
  }

  // ================= comment 11 — the re-sync notice =================
  const analysisId = await p.evaluate(() => FSInvestmentUI.currentId());
  await p.evaluate(async id => {
    // move the source budget on by one version
    const src = FSInvestmentUI._state().source.projectId;
    const d = await (await fetch('/api/budget/' + src)).json();
    d.projectCosts.land = (d.projectCosts.land || 0) + 123456;
    await fetch('/api/budget/' + src, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: { projectId: src, name: d.name, status: d.status || 'Draft' }, doc: d }) });
    await FSInvestmentUI.open(id);
  }, analysisId);
  await p.waitForTimeout(1200);
  const drift = await p.locator('.inv-drift').textContent().catch(() => '');
  ok('the drift notice reads "Budget Updated to vN - Click to Re-Sync"',
     /^Budget Updated to v\d+ - Click to Re-Sync$/.test(drift.trim()), drift.trim());
  ok('and it is clickable',
     await p.locator('.inv-drift').evaluate(e => e.tagName === 'BUTTON'));
  const pinnedBefore = await p.evaluate(() => FSInvestmentUI._state().source.budgetVersionNumber);
  await p.click('.inv-drift');
  await p.waitForTimeout(1500);
  // The re-sync asks first and shows what moves; applying it re-pins the
  // analysis on screen (the Save that follows is what records it).
  await p.click('#invModal button:has-text("Apply Re-Sync")');
  await p.waitForTimeout(500);
  const pinnedAfter = await p.evaluate(() => FSInvestmentUI._state().source);
  ok('clicking it re-pins the analysis to the newer version',
     pinnedAfter.budgetVersionNumber > pinnedBefore && !pinnedAfter.drift,
     JSON.stringify({ pinnedBefore, after: pinnedAfter.budgetVersionNumber, drift: pinnedAfter.drift }));
  ok('and the notice clears once it has',
     (await p.locator('.inv-drift').count()) === 0);

  // ================= comment 9 — no redundant count sentence =================
  await p.evaluate(() => {
    const st = FSInvestmentUI._state();
    st.input.property.size.value = 0;
  });
  await p.evaluate(() => FSInvestmentUI.calculate());
  await p.waitForTimeout(1200);
  const banner = await p.locator('#invErrSummary').textContent();
  ok('the warning does not restate the count above the detail',
     !/assumptions? need/i.test(banner), banner.replace(/\s+/g, ' ').slice(0, 140));
  ok('but still names the step, the field and the reason',
     /Step 1/.test(banner) && /Size Value/.test(banner) && /greater than zero/i.test(banner),
     banner.replace(/\s+/g, ' ').slice(0, 160));

  // ================= delete a project, with the warning =================
  await p.evaluate(() => go('projects'));
  await p.waitForTimeout(800);
  const before = await p.evaluate(() => FSProjects._list().projects.length);
  dialogs.length = 0;
  await p.click('#projectsBody .pj-tbl-index tr:has-text("OP-0900") .rowmenu-btn');
  await p.waitForTimeout(300);
  await p.click('#pjRowMenu .rowmenu-item:has-text("Delete Project")');
  await p.waitForTimeout(1500);
  ok('deleting a project warns what goes with it',
     dialogs.length > 0 && /budget/i.test(dialogs[0]) && /analys/i.test(dialogs[0]),
     (dialogs[0] || '').replace(/\s+/g, ' ').slice(0, 200));
  ok('and says nothing is destroyed',
     /restore/i.test(dialogs[0] || ''), (dialogs[0] || '').slice(-120));
  await p.evaluate(() => FSProjects.render(true));
  await p.waitForTimeout(900);
  const gone = await p.evaluate(async () => {
    const r = await fetch('/api/budgets?scope=project&id=OP-0900');
    return r.status;
  });
  ok('the project is gone', gone === 404, String(gone));
  ok('and so are its budgets', (await p.evaluate(async () => {
    const list = await (await fetch('/api/budgets')).json();
    return list.filter(x => x.projectKey === 'OP-0900').length;
  })) === 0);
  ok('the list is one shorter',
     (await p.evaluate(() => FSProjects._list().projects.length)) === before - 1);

  // ================= responsive =================
  for (const w of [1280, 1024, 820, 480]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.evaluate(() => go('projects'));
    await p.waitForTimeout(400);
    await p.click('#page-projects button:has-text("+ Create Project")');
    await p.waitForTimeout(350);
    ok('the Create Project dialog fits at ' + w + 'px',
       await p.evaluate(() => {
         const r = document.querySelector('#newProjectModal .mod-sheet').getBoundingClientRect();
         return r.left >= -1 && r.right <= innerWidth + 1 && r.width > 260;
       }),
       await p.evaluate(() => {
         const r = document.querySelector('#newProjectModal .mod-sheet').getBoundingClientRect();
         return Math.round(r.left) + '..' + Math.round(r.right) + ' of ' + innerWidth;
       }));
    ok('and the page never scrolls sideways at ' + w + 'px',
       await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
       await p.evaluate(() => document.documentElement.scrollWidth + ' vs ' + innerWidth));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
  }

  ok('no JS errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  await b.close();
} catch (e) { R.push('FAIL  suite crashed — ' + (e && e.stack ? e.stack.split('\n')[0] : e)); }
console.log(R.join('\n'));
console.log('\n' + R.filter(x => x.startsWith('FAIL')).length + ' failures of ' + R.length);
process.exit(R.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
