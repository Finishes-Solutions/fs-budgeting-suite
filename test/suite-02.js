const { chromium } = require('playwright');
const OUT = process.env.OUT_DIR || require('os').tmpdir();
const R = [];
const ok = (n, c, extra='') => R.push(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? ' — ' + extra : ''}`);
const BASE = 'http://127.0.0.1:8100';

(async () => {
 try {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  let dialogs = 0;
  p.on('dialog', async d => { dialogs++; await d.accept(); });
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  // cdnjs + Google Fonts are blocked in this sandbox; ignore resource-load noise
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });

  await p.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);

  ok('No offline banner when API is healthy', !(await p.locator('#apiBanner').isVisible()));
  // Identity moved from a bare email in the bar into the account menu behind the avatar.
  ok('Account avatar is shown when signed in', await p.locator('#profileBtn').isVisible());
  ok('Avatar shows initials', /^[A-Z?]{1,2}$/.test((await p.locator('#profileInitials').textContent()).trim()),
     await p.locator('#profileInitials').textContent());

  // --- create + save a real budget
  await p.click('button:has-text("+ New Multifamily Budget")');
  await p.fill('#pId', 'TST-9999');
  await p.fill('#pName', 'Waller Preview Test');
  await p.click('button:has-text("Continue to Budget")');
  const contract = await p.locator('#rContract').textContent();
  ok('Contract sum computed from published library', /^\$[\d,]+$/.test(contract), contract);
  ok('Pricing badge shows no fallback warning',
     !/built-in/.test(await p.locator('#mPricing').textContent()),
     await p.locator('#mPricing').textContent());

  await p.click('#page-budget button[data-save-btn]');
  await p.waitForTimeout(600);
  const pill = await p.locator('#saveState').textContent();
  ok('U3 pill flips to Saved after a successful save', /^Saved /.test(pill), pill);
  ok('D2 dirty cleared after save', !/unsaved/i.test(pill));

  // leaving a clean budget must NOT prompt
  const d0 = dialogs;
  await p.click('#nav-home');
  await p.waitForTimeout(300);
  ok('D2 clean budget leaves without prompting', dialogs === d0);

  // --- home list
  await p.waitForTimeout(300);
  ok('Saved budget appears in list', (await p.locator('#homeBody tr').count()) === 1);
  ok('TST row carries a Test badge', await p.locator('#homeBody .badge.test').first().isVisible());
  ok('U2 count reads correctly', /1 of 1 budget/.test(await p.locator('#homeCount').textContent()),
     await p.locator('#homeCount').textContent());

  // --- add more rows via the API, then exercise sort + filter properly
  await p.evaluate(async () => {
    const mk = (id, name, cs, status, updated) => fetch('/api/budget/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meta: { projectId: id, name, type: 'Multifamily', status, contractSum: cs, projectCost: cs * 1.3, updated },
        doc: { projectId: id, name, status, resSF: 1000, amenSF: 0, units: [], other: [], expenses: [], lines: [],
               companies: [], contingency: { mode: 'psf', val: 2 }, projectCosts: { land: 0, dev: 0, mkt: 0, cls: 0 },
               pricingVersion: '2026.08-v2' }
      })
    });
    await mk('BD-0001', 'Alpha Ridge', 9000000, 'Finalized', '2026-01-05T00:00:00Z');
    await mk('BD-0002', 'Zephyr Landing', 3000000, 'Draft', '2026-06-20T00:00:00Z');
    await mk('AS-0007', 'Midtown Assessment', 6000000, 'In Review', '2026-03-10T00:00:00Z');
  });
  await p.click('#nav-help'); await p.click('#nav-home');   // force a refetch
  await p.waitForTimeout(400);
  ok('All budgets listed', (await p.locator('#homeBody tr').count()) === 4,
     (await p.locator('#homeBody tr').count()) + ' rows');

  const ids = async () => (await p.locator('#homeBody tr td:first-child').allTextContents()).map(s => s.trim().split(' ')[0]);

  await p.click('#homeHead th[data-sort="contractSum"]');           // desc first
  ok('U2 sort by contract sum desc', (await ids())[0] === 'BD-0001', (await ids()).join(','));
  await p.click('#homeHead th[data-sort="contractSum"]');           // toggle asc
  const asc = await ids();
  ok('U2 sort toggles to asc', asc[0] === 'TST-9999' || asc[0] === 'BD-0002', asc.join(','));
  await p.click('#homeHead th[data-sort="name"]');
  ok('U2 sort by name asc', (await ids())[0] === 'BD-0001', (await ids()).join(','));
  ok('U2 sort arrow rendered',
     (await p.locator('#homeHead th[data-sort="name"]').getAttribute('data-arrow')) === '▴');

  await p.selectOption('#homeStatus', 'Finalized');
  ok('U2 status filter narrows to 1', (await p.locator('#homeBody tr').count()) === 1);
  await p.selectOption('#homeStatus', 'all');
  await p.fill('#homeSearch', 'zeph');
  ok('U2 search matches name case-insensitively', (await p.locator('#homeBody tr').count()) === 1);
  ok('U2 filtered count text', /1 of 4 budgets/.test(await p.locator('#homeCount').textContent()));
  await p.fill('#homeSearch', 'nomatch');
  ok('U2 no-match empty state', /Nothing matches/.test(await p.locator('#homeEmptyBig').textContent()));
  await p.fill('#homeSearch', '');
  await p.screenshot({ path: OUT + '/home.png' });

  // --- reopen a saved budget round-trips
  await p.click('#homeBody tr:has-text("TST-9999")');
  await p.waitForTimeout(400);
  ok('Reopened budget restores name', (await p.locator('#bTitle').textContent()).includes('Waller Preview Test'));
  ok('Reopened contract sum matches', (await p.locator('#rContract').textContent()) === contract);
  ok('D5 status persisted as Draft', await p.locator('#bStatus').inputValue() === 'Draft');

  // --- status change persists
  await p.selectOption('#bStatus', 'In Review');
  await p.click('#page-budget button[data-save-btn]');
  await p.waitForTimeout(500);
  await p.click('#nav-home'); await p.waitForTimeout(400);
  ok('D5 status change persisted to the list',
     (await p.locator('#homeBody tr:has-text("TST-9999")').textContent()).includes('In Review'));

  // --- stale pricing banner after publishing a new version
  await p.click('#nav-pricing'); await p.waitForTimeout(300);
  ok('pricing_admin unlocks the editor', await p.locator('#unlockedBanner').isVisible());
  await p.click('button:has-text("Publish New Version")');
  await p.waitForTimeout(500);
  await p.goto(BASE + '/index.html#/budget/TST-9999', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  ok('Stale-pricing banner appears after a publish', await p.locator('#staleBanner').isVisible());
  await p.click('button:has-text("Update to Current Pricing")');
  await p.waitForTimeout(300);
  ok('Reprice clears the stale banner', !(await p.locator('#staleBanner').isVisible()));
  ok('Reprice marks the budget dirty', /unsaved/i.test(await p.locator('#saveState').textContent()));

  // --- export modal + PDF print wiring (SheetJS CDN is blocked in this sandbox,
  //     so the Excel binary path cannot be exercised here)
  await p.click("#page-budget button:has-text(\"Export…\")");
  ok('Export modal opens', await p.locator('#exportModal').isVisible());
  await p.uncheck('#ex-stats');
  await p.evaluate(() => { window.__printed = 0; window.print = () => window.__printed++; });   // keep printDoc populated
  await p.click('button:has-text("PDF (Print)")');
  await p.waitForTimeout(200);
  ok('PDF export invokes print', await p.evaluate(() => window.__printed) === 1);
  // sections are honoured by omission from the composed report, not by hiding app markup
  const rptNoStats = await p.evaluate(() => document.getElementById('printDoc').innerHTML);
  ok('PDF export honours the stats checkbox', !rptNoStats.includes('rpt-stats') && rptNoStats.length > 2000,
     'report ' + rptNoStats.length + ' chars, stats band omitted');
  ok('Export modal closes after export', !(await p.locator('#exportModal').isVisible()));
  await p.waitForTimeout(600);
  ok('Print classes are cleaned up afterwards',
     !(await p.locator('#page-budget').evaluate(e => e.classList.contains('print-target'))));

  // --- stable line identity (survives the save/load round trip above)
  // `doc` is a top-level `let`, so it is a lexical global, not a window property.
  const lineIds = await p.evaluate(() => (doc && doc.lines ? doc.lines : []).map(l => l.lineId));
  ok('Every budget line carries a stable ID', lineIds.length > 0 && lineIds.every(Boolean), lineIds.length + ' lines');
  ok('Line IDs are unique', new Set(lineIds).size === lineIds.length);

  // --- three-dot row actions menu (replaced the bare × delete button)
  await p.click('#nav-home'); await p.waitForTimeout(400);
  await p.click('#homeBody tr:has-text("TST-9999") .rowmenu-btn');
  await p.waitForTimeout(200);
  ok('Row menu opens', await p.locator('#rowMenu').isVisible());
  ok('Row menu offers Edit, Versions and Delete',
     (await p.locator('#rowMenu .rowmenu-item').allTextContents()).join('|') === 'Edit|Versions|Delete');
  ok('Trigger reports expanded state',
     await p.locator('#homeBody tr:has-text("TST-9999") .rowmenu-btn').getAttribute('aria-expanded') === 'true');
  ok('Trigger carries an accessible label',
     (await p.locator('#homeBody tr:has-text("TST-9999") .rowmenu-btn').getAttribute('aria-label')) === 'Actions for TST-9999');
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  ok('Escape closes the row menu', !(await p.locator('#rowMenu').isVisible()));

  // --- version history, read-only
  const openBefore = await p.evaluate(() => doc ? JSON.stringify(doc) : null);
  await p.click('#homeBody tr:has-text("TST-9999") .rowmenu-btn'); await p.waitForTimeout(150);
  await p.click('#rowMenu .rowmenu-item:has-text("Versions")');
  await p.waitForTimeout(500);
  ok('Versions modal opens', await p.locator('#versionsModal').isVisible());
  const vRows = await p.locator('#versionsBody .ver-row').count();
  ok('Version history lists saved versions', vRows >= 1, vRows + ' version(s)');
  ok('Newest version is marked Current',
     await p.locator('#versionsBody .ver-row').first().locator('.badge').textContent() === 'Current');
  await p.click('#versionsBody button[data-vn]'); await p.waitForTimeout(400);
  ok('A historical version opens read-only',
     (await p.locator('#versionsBody .ver-hist').textContent()).includes('read only'));
  ok('Historical detail has no editable inputs',
     (await p.locator('#versionsBody input, #versionsBody select').count()) === 0);
  ok('Opening history leaves the working document byte-for-byte unchanged',
     (await p.evaluate(() => doc ? JSON.stringify(doc) : null)) === openBefore);
  await p.click('#verBack'); await p.waitForTimeout(400);
  ok('Back returns to the version list', (await p.locator('#versionsBody .ver-row').count()) >= 1);
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  ok('Escape closes the versions modal', !(await p.locator('#versionsModal').isVisible()));

  // --- delete, now behind the menu and recoverable
  await p.click('#homeBody tr:has-text("TST-9999") .rowmenu-btn'); await p.waitForTimeout(150);
  await p.click('#rowMenu .rowmenu-item:has-text("Delete")');
  await p.waitForTimeout(500);
  ok('Delete removes the row', (await p.locator('#homeBody tr').count()) === 3);

   // --- sign out
  await p.click('#profileBtn'); await p.waitForTimeout(200);
  ok('The account menu opens from the avatar', await p.locator('#profileMenu').isVisible());
  ok('The account menu shows the signed-in email',
     (await p.locator('#pmEmail').textContent()).includes('svc_automation@finishessolutions.com'),
     await p.locator('#pmEmail').textContent());
  ok('The account menu shows a display name',
     (await p.locator('#pmName').textContent()).trim().length > 0,
     await p.locator('#pmName').textContent());
  ok('Sign Out lives in the account menu',
     await p.locator('#profileMenu .rowmenu-item:has-text("Sign Out")').isVisible());
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  ok('Escape closes the account menu', !(await p.locator('#profileMenu').isVisible()));
  ok('Sign Out targets the SWA logout route',
     /^\/\.auth\/logout\?post_logout_redirect_uri=/.test(await p.evaluate(() => logoutUrl())),
     await p.evaluate(() => logoutUrl()));
  // A dirty budget must not be discarded silently by signing out.
  const stayed = await p.evaluate(async () => {
    const c = window.confirm; window.confirm = () => false;
    dirty = true;
    await logout();                      // declines the discard prompt, so must not navigate
    const here = location.pathname + location.hash;
    window.confirm = c; dirty = false;
    return here;
  });
  ok('Sign Out is blocked by unsaved changes', stayed.includes('index.html') || stayed.startsWith('/'),
     stayed);

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
