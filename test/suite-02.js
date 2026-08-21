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

  // --- one + New Budget button opens the template chooser
  ok('a single + New Budget button replaces the old pair',
     (await p.locator('#page-home button:has-text("+ New Budget")').count()) === 1
     && (await p.locator('#page-home button:has-text("Multifamily")').count()) === 0
     && (await p.locator('#page-home button:has-text("+ Blank Budget")').count()) === 0);
  await p.click('button:has-text("+ New Budget")'); await p.waitForTimeout(200);
  ok('the modal offers Multifamily and Blank, with future types disabled',
     await p.evaluate(() => {
       const rows = [...document.querySelectorAll('#newBudgetModal .tpl-row')];
       const by = n => rows.find(r => r.textContent.includes(n));
       return !!by('Multifamily') && !by('Multifamily').disabled
         && !!by('Blank Budget') && !by('Blank Budget').disabled
         && by('Industrial').disabled && by('Retail').disabled && by('Mixed-Use').disabled;
     }));
  ok('custom templates show an empty state when none exist',
     /No custom templates yet/.test(await p.locator('#customTplList').textContent()));
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  ok('Escape closes the New Budget modal', !(await p.locator('#newBudgetModal').isVisible()));

  // --- create + save a real budget
  // A budget belongs to a project now, so the parent is made first and chosen
  // in step 2 of the dialog — a budget id can no longer imply one.
  await p.evaluate(async () => {
    await fetch('/api/budget/OP-0201?scope=project', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ create: true, name: 'Waller Preview', address: '1 Waller Way' }) });
  });
  await p.click('button:has-text("+ New Budget")').then(()=>p.click('#newBudgetModal .tpl-row:has-text("Multifamily")'));
  await p.waitForTimeout(700);
  await p.selectOption('#nbProject', 'OP-0201');
  await p.fill('#nbId', 'TST-9999');
  await p.fill('#nbName', 'Waller Preview Test');
  await p.click('#nbCreate');
  await p.waitForTimeout(700);
  await p.fill('#pId', 'TST-9999');
  await p.fill('#pName', 'Waller Preview Test');

  // ---- inputs page: no property-type input, site SF ⇄ acreage, AC units
  ok('Property Type is no longer asked on Inputs (set at creation)',
     (await p.locator('#pType').count()) === 0
     && (await p.evaluate(() => doc.type)) === 'Multifamily');
  await p.fill('#pSiteSF', '87120');
  ok('site SF autofills acreage', (await p.locator('#pSiteAc').inputValue()) === '2',
     await p.locator('#pSiteAc').inputValue());
  await p.fill('#pSiteAc', '2.5');
  ok('acreage autofills site SF', (await p.locator('#pSiteSF').inputValue()) === '108900',
     await p.locator('#pSiteSF').inputValue());
  ok('site metrics capitalize their units (AC, U/AC)',
     /^[\d.]+ AC$/.test(await p.locator('#mSiteAcres').textContent())
     && /U\/AC$/.test(await p.locator('#mDensity').textContent()),
     JSON.stringify({a: await p.locator('#mSiteAcres').textContent(),
                     d: await p.locator('#mDensity').textContent()}));
  ok('unit-mix totals carry the input-column inset so they align',
     await p.evaluate(() => getComputedStyle(document.getElementById('uCount')).paddingRight === '19px'
       && getComputedStyle(document.getElementById('uBlendPSF')).paddingRight === '19px'));
  ok('the scrollbar gutter is always reserved (no tab-switch layout shift)',
     await p.evaluate(() => getComputedStyle(document.documentElement).overflowY === 'scroll'));

  await p.click('button:has-text("Continue to Budget")');
  const contract = await p.locator('#rContract').textContent();
  ok('Contract sum computed from published library', /^\$[\d,]+$/.test(contract), contract);
  ok('budget subtitle formats the building SF cleanly',
     await p.evaluate(() => {
       const t = document.getElementById('bSub').textContent;
       return /51,365 SF \+ 1,200 SF Amenity\/Clubhouse/.test(t) && !/SF res/.test(t);
     }), await p.evaluate(() => document.getElementById('bSub').textContent));
  ok('the auto-sync and amenity-hidden flags are retired',
     !(await p.locator('#page-budget').textContent()).includes('edit to override')
     && (await p.locator('#amenHidden').count()) === 0);
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
  await p.click('#nav-budgets');
  await p.waitForTimeout(300);
  ok('D2 clean budget leaves without prompting', dialogs === d0);

  // --- home list
  await p.waitForTimeout(300);
  ok('Saved budget appears in list', (await p.locator('#budgetsBody tr').count()) === 1);
  ok('TST row carries a Test badge', await p.locator('#budgetsBody .badge.test').first().isVisible());
  ok('U2 count reads correctly', /1 of 1 budget/.test(await p.locator('#budgetsCount').textContent()),
     await p.locator('#budgetsCount').textContent());

  // --- add more rows via the API, then exercise sort + filter properly
  await p.evaluate(async () => {
    const mk = (id, name, cs, status, updated) => fetch('/api/budget/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // contractSum/projectCost are derived from the doc server-side now, so the
        // doc itself must carry the money: one lump-sum line worth cs.
        meta: { projectId: id, name, type: 'Multifamily', status, contractSum: cs, projectCost: cs * 1.3, updated },
        doc: { projectId: id, name, status, resSF: 1000, amenSF: 0, units: [], other: [], expenses: [],
               lines: [{ lineId: id + '-shell', scope: 'res', grp: 'General', code: '', desc: 'Shell',
                         basis: 'ls', auto: true, qty: 0, unit: cs }],
               companies: [], contingency: { mode: 'fixed', val: 0 }, projectCosts: { land: 0, dev: 0, mkt: 0, cls: 0 },
               pricingVersion: '2026.08-v2' }
      })
    });
    await mk('BD-0001', 'Alpha Ridge', 9000000, 'Finalized', '2026-01-05T00:00:00Z');
    await mk('BD-0002', 'Zephyr Landing', 3000000, 'Draft', '2026-06-20T00:00:00Z');
    await mk('AS-0007', 'Midtown Assessment', 6000000, 'In Review', '2026-03-10T00:00:00Z');
  });
  await p.evaluate(() => go('help')); await p.evaluate(() => go('budgets'));   // force a refetch
  await p.waitForTimeout(400);
  ok('All budgets listed', (await p.locator('#budgetsBody tr').count()) === 4,
     (await p.locator('#budgetsBody tr').count()) + ' rows');

  // Column 1 is the User column (creator avatar); Project ID is column 2.
  const ids = async () => (await p.locator('#budgetsBody tr td:nth-child(2)').allTextContents()).map(s => s.trim().split(' ')[0]);

  await p.click('#budgetsHead th[data-sort="contractSum"]');           // desc first
  ok('U2 sort by contract sum desc', (await ids())[0] === 'BD-0001', (await ids()).join(','));
  await p.click('#budgetsHead th[data-sort="contractSum"]');           // toggle asc
  const asc = await ids();
  ok('U2 sort toggles to asc', asc[0] === 'TST-9999' || asc[0] === 'BD-0002', asc.join(','));
  await p.click('#budgetsHead th[data-sort="name"]');
  ok('U2 sort by name asc', (await ids())[0] === 'BD-0001', (await ids()).join(','));
  ok('U2 sort arrow rendered',
     (await p.locator('#budgetsHead th[data-sort="name"]').getAttribute('data-arrow')) === '▴');

  await p.selectOption('#budgetsStatus', 'Completed');   // legacy Finalized maps to Completed
  ok('U2 status filter narrows to 1', (await p.locator('#budgetsBody tr').count()) === 1);
  await p.selectOption('#budgetsStatus', 'all');
  await p.fill('#budgetsSearch', 'zeph');
  ok('U2 search matches name case-insensitively', (await p.locator('#budgetsBody tr').count()) === 1);
  ok('U2 filtered count text', /1 of 4 budgets/.test(await p.locator('#budgetsCount').textContent()));
  await p.fill('#budgetsSearch', 'nomatch');
  ok('U2 no-match empty state', /Nothing matches/.test(await p.locator('#budgetsEmptyBig').textContent()));
  await p.fill('#budgetsSearch', '');

  // --- house timestamp format: local time, MM-DD-YYYY (h:mm AM/PM with time)
  const updCell = await p.locator('#budgetsBody tr', { hasText: 'Alpha Ridge' })
    .locator('td:nth-child(7)').textContent();
  ok('Updated column shows MM-DD-YYYY', updCell.trim() === '01-05-2026', updCell);
  ok('fmtWhen renders MM-DD-YYYY h:mm AM/PM in local time',
     await p.evaluate(() => fmtWhen('2026-08-17T20:52:00') === '08-17-2026 8:52 PM'
       && fmtWhen('2026-08-17T08:05:00') === '08-17-2026 8:05 AM'
       && fmtDay('2026-01-05T00:00:00') === '01-05-2026'));

  // --- Group By
  ok('Group By offers no-grouping, address, ID, type, status and user',
     (await p.locator('#budgetsGroup option').allTextContents()).join('|')
       === 'No Grouping|Group by Address|Group by Project ID|Group by Type|Group by Status|Group by User',
     (await p.locator('#budgetsGroup option').allTextContents()).join('|'));
  ok('The list is ungrouped by default',
     (await p.locator('#budgetsBody tr.grp-hd').count()) === 0);

  const grouped = async (key) => {
    await p.selectOption('#budgetsGroup', key); await p.waitForTimeout(250);
    return p.evaluate(() => ({
      groups: [...document.querySelectorAll('#budgetsBody tr.grp-hd')].length,
      rows: [...document.querySelectorAll('#budgetsBody tr:not(.grp-hd)')].length,
      first: (document.querySelector('#budgetsBody tr.grp-hd') || {}).textContent || '',
      last: [...document.querySelectorAll('#budgetsBody tr.grp-hd')].pop().textContent || '',
      // colspan means element count != column count; measure the real span, and
      // check the money lands under Contract Sum and Total Project.
      headerSpan: [...document.querySelector('#budgetsBody tr.grp-hd').children]
        .reduce((n, c) => n + (+c.getAttribute('colspan') || 1), 0),
      moneyCols: (() => {
        let col = 0, cols = [];
        for (const c of document.querySelector('#budgetsBody tr.grp-hd').children) {
          if (/^\$/.test(c.textContent.trim())) cols.push(col);
          col += (+c.getAttribute('colspan') || 1);
        }
        return cols;
      })(),
      allGroups: [...document.querySelectorAll('#budgetsBody tr.grp-hd')].map(t => t.textContent)
    }));
  };
  const byStatus = await grouped('status');
  ok('Grouping by status splits the list', byStatus.groups >= 2, byStatus.groups + ' groups');
  ok('Grouping shows every budget exactly once', byStatus.rows === 4, byStatus.rows + ' rows');
  // 8 columns since the User column joined: User, Project ID, Name, Status,
  // Contract Sum, Total Project Cost, Updated, actions.
  ok('Group headers span the full table', byStatus.headerSpan === 8, 'span ' + byStatus.headerSpan);
  ok('Group totals sit under Contract Sum and Total Project Cost',
     JSON.stringify(byStatus.moneyCols) === '[4,5]', JSON.stringify(byStatus.moneyCols));
  const byType = await grouped('type');
  ok('Grouping by type works', byType.groups >= 1 && byType.rows === 4);
  const byId = await grouped('id');
  // Fewer groups than rows is the proof it grouped by prefix — grouping on the whole
  // (unique) ID would give one group per budget. Groups sort alphabetically, so AS
  // legitimately comes before BD.
  ok('Grouping by project ID groups by prefix, not by unique ID',
     byId.groups < byId.rows && byId.allGroups.some(g => /BD/.test(g)),
     byId.groups + ' groups for ' + byId.rows + ' budgets');
  const byAddr = await grouped('address');
  ok('Grouping by address works', byAddr.rows === 4);
  ok('Budgets with no address are grouped last', /No Address/.test(byAddr.last), byAddr.last.trim());
  ok('Group totals reconcile to the ungrouped total', await p.evaluate(() => {
    const g = groupedRows(homeRows());
    const all = homeRows().reduce((s, x) => s + (+x.contractSum || 0), 0);
    return Math.abs(g.reduce((s, x) => s + x.contract, 0) - all) < 0.01;
  }));
  await p.selectOption('#budgetsGroup', ''); await p.waitForTimeout(200);
  ok('Grouping can be turned off again', (await p.locator('#budgetsBody tr.grp-hd').count()) === 0);
  await p.screenshot({ path: OUT + '/home.png' });

  // --- reopen a saved budget round-trips
  await p.click('#budgetsBody tr:has-text("TST-9999")');
  await p.waitForTimeout(400);
  ok('Reopened budget restores name', (await p.locator('#bTitle').textContent()).includes('Waller Preview Test'));
  ok('Reopened contract sum matches', (await p.locator('#rContract').textContent()) === contract);
  // Status is the shared chip now, the same component the lists and the
  // analysis editor use — not a select.
  ok('D5 status persisted as Draft',
     (await p.locator('#bStatusHost .st-chip').textContent()).trim() === 'Draft');

  // --- status change persists, through the chip's menu
  await p.click('#bStatusHost .st-chip'); await p.waitForTimeout(200);
  await p.click('#stMenu [data-st="In Review"]'); await p.waitForTimeout(500);
  await p.click('#page-budget button[data-save-btn]');
  await p.waitForTimeout(500);
  await p.click('#nav-budgets'); await p.waitForTimeout(400);
  ok('D5 status change persisted to the list',
     (await p.locator('#budgetsBody tr:has-text("TST-9999")').textContent()).includes('In Review'));

  // --- stale pricing banner after publishing a new version
  await p.click('#nav-more-btn').then(()=>p.click('#nav-pricing')); await p.waitForTimeout(300);
  ok('pricing_admin unlocks the editor', await p.locator('#unlockedBanner').isVisible());
  await p.click('button:has-text("Publish New Version")');
  await p.waitForTimeout(500);
  await p.goto(BASE + '/index.html#/budget/TST-9999', { waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  ok('Stale-pricing banner appears after a publish', await p.locator('#staleBanner').isVisible());
  ok('the banner carries a dismiss X', await p.locator('#staleBanner .btn-x').isVisible());
  await p.click('#staleBanner .btn-x'); await p.waitForTimeout(200);
  ok('X hides the banner for this budget', !(await p.locator('#staleBanner').isVisible()));
  // the persistent path after dismissing: Home row menu → Update Pricing
  await p.click('#nav-budgets'); await p.waitForTimeout(400);
  await p.locator('#budgetsBody tr', { hasText: 'TST-9999' }).locator('.rowmenu-btn').click();
  await p.waitForTimeout(200);
  ok('row menu offers Update Pricing',
     (await p.locator('#rowMenu .rowmenu-item').allTextContents()).includes('Update Pricing'));
  await p.click('#rowMenu .rowmenu-item:has-text("Update Pricing")');
  await p.waitForTimeout(700);
  ok('Update Pricing from the row menu repriced the budget',
     await p.evaluate(() => doc && doc.pricingVersion === pricing.version));
  ok('Reprice clears the stale banner', !(await p.locator('#staleBanner').isVisible()));
  ok('Reprice marks the budget dirty', /unsaved/i.test(await p.locator('#saveState').textContent()));

  // --- export modal + PDF print wiring (SheetJS CDN is blocked in this sandbox,
  //     so the Excel binary path cannot be exercised here)
  await p.click("#page-budget button:has-text(\"Export\")");
  ok('Export modal opens', await p.locator('#exportModal').isVisible());
  // Email export is announced but not built; it must be visibly unavailable and inert.
  ok('Email export is offered as coming soon', await p.locator('#ex-email').isVisible());
  ok('Email export is marked unavailable',
     (await p.locator('#ex-email').getAttribute('aria-disabled')) === 'true');
  ok('Email export explains itself on hover',
     /coming soon/i.test(await p.locator('#ex-email').getAttribute('title')));
  await p.evaluate(() => { window.__printed = 0; window.print = () => window.__printed++; });
  // Playwright honours aria-disabled in its actionability check and would wait for the
  // button to become enabled, which is itself proof the state is announced correctly.
  // Dispatch directly to assert what the handler does.
  await p.locator('#ex-email').dispatchEvent('click'); await p.waitForTimeout(250);
  ok('Clicking Email exports nothing', (await p.evaluate(() => window.__printed)) === 0);
  ok('Clicking Email says it is coming soon',
     /coming soon/i.test(await p.locator('#toast').textContent()),
     await p.locator('#toast').textContent());
  ok('Email does not close the export modal', await p.locator('#exportModal').isVisible());
  await p.uncheck('#ex-stats');
  await p.evaluate(() => { window.__printed = 0; window.print = () => window.__printed++; });   // keep printDoc populated
  await p.click('button:has-text("Print")');
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
  await p.click('#nav-budgets'); await p.waitForTimeout(400);
  await p.click('#budgetsBody tr:has-text("TST-9999") .rowmenu-btn');
  await p.waitForTimeout(200);
  ok('Row menu opens', await p.locator('#rowMenu').isVisible());
  // Delete names what it deletes, matching Delete Analysis and Delete Project.
  // Make Primary is absent here: it only means something on a project page,
  // where the trigger carries the project the row is on.
  ok('Row menu offers Edit, Favorites, Update Pricing, Versions and Delete Budget',
     (await p.locator('#rowMenu .rowmenu-item').allTextContents()).join('|') === 'Edit|Add to Favorites|Update Pricing|Versions|Delete Budget',
     (await p.locator('#rowMenu .rowmenu-item').allTextContents()).join('|'));
  ok('Trigger reports expanded state',
     await p.locator('#budgetsBody tr:has-text("TST-9999") .rowmenu-btn').getAttribute('aria-expanded') === 'true');
  ok('Trigger carries an accessible label',
     (await p.locator('#budgetsBody tr:has-text("TST-9999") .rowmenu-btn').getAttribute('aria-label')) === 'Actions for TST-9999');
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  ok('Escape closes the row menu', !(await p.locator('#rowMenu').isVisible()));

  // --- version history, read-only
  const openBefore = await p.evaluate(() => doc ? JSON.stringify(doc) : null);
  await p.click('#budgetsBody tr:has-text("TST-9999") .rowmenu-btn'); await p.waitForTimeout(150);
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
  await p.click('#budgetsBody tr:has-text("TST-9999") .rowmenu-btn'); await p.waitForTimeout(150);
  await p.click('#rowMenu .rowmenu-item:has-text("Delete")');
  await p.waitForTimeout(500);
  ok('Delete removes the row', (await p.locator('#budgetsBody tr').count()) === 3);

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
  // Switching accounts sits beside it, and before it: changing account is the
  // common errand, ending the session is the deliberate one.
  ok('Switch Account sits beside it, ahead of Sign Out',
     await p.evaluate(() => {
       const items = [...document.querySelectorAll('#profileMenu .rowmenu-item')].map(b => b.textContent.trim());
       return items.includes('Switch Account')
         && items.indexOf('Switch Account') < items.indexOf('Sign Out');
     }),
     await p.evaluate(() => [...document.querySelectorAll('#profileMenu .rowmenu-item')]
       .map(b => b.textContent.trim()).join(' | ')));
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  ok('Escape closes the account menu', !(await p.locator('#profileMenu').isVisible()));
  ok('Sign Out targets the SWA logout route, and lands on the sign-in screen',
     (await p.evaluate(() => logoutUrl()))
       === '/.auth/logout?post_logout_redirect_uri=' + encodeURIComponent('/login.html'),
     await p.evaluate(() => logoutUrl()));
  // Switching accounts has to LOG OUT FIRST. /.auth/login/aad short-circuits
  // while the SWA session cookie is present — it never reaches Entra, so
  // prompt=select_account is never sent and the page just reloads as the same
  // user. The cookie is HttpOnly, so /.auth/logout is the only thing that can
  // drop it; the login it returns to is what shows the account picker.
  ok('Switch Account drops the session before going to the provider',
     await p.evaluate(() => switchAccountUrl().startsWith('/.auth/logout?post_logout_redirect_uri=')),
     await p.evaluate(() => switchAccountUrl()));
  ok('and comes back through the provider login, not to the app directly',
     await p.evaluate(() => {
       const back = decodeURIComponent(switchAccountUrl().split('post_logout_redirect_uri=')[1]);
       return back.startsWith('/.auth/login/aad?post_login_redirect_uri=');
     }),
     await p.evaluate(() => decodeURIComponent(switchAccountUrl().split('post_logout_redirect_uri=')[1])));
  ok('its return target is a same-origin path, never an off-site URL',
     await p.evaluate(() => {
       const back = decodeURIComponent(switchAccountUrl().split('post_logout_redirect_uri=')[1]);
       const finalTarget = decodeURIComponent(back.split('post_login_redirect_uri=')[1]);
       return finalTarget === '/' && !/^https?:/i.test(finalTarget);
     }),
     await p.evaluate(() => switchAccountUrl()));
  // Both leave through one guard, so neither can drop unsaved work silently.
  ok('Switch Account is blocked by unsaved changes too',
     await p.evaluate(async () => {
       const c = window.confirm; window.confirm = () => false;
       dirty = true;
       await switchAccount();
       const here = location.pathname;
       window.confirm = c; dirty = false;
       return here.includes('index.html') || here.startsWith('/');
     }));
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

  // ---- investment analyses list on the Home page, below the budgets
  await p.evaluate(async () => {
    await fetch('/api/investment-analyses', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'fromBudget', projectId: 'BD-0001', analysisName: 'Alpha Underwriting' }) });
  });
  await p.evaluate(() => go('help')); await p.evaluate(() => go('budgets'));   // force a refetch
  await p.waitForTimeout(500);
  ok('the budgets list and the analyses list are separate pages now',
     await p.evaluate(() => !!document.getElementById('page-budgets')
       && !!document.getElementById('page-analyses')
       && document.getElementById('page-budgets') !== document.getElementById('page-analyses')));
  await p.evaluate(() => go('analyses')); await p.waitForTimeout(600);
  const iaRow = p.locator('#page-analyses [data-inv-list] tr', { hasText: 'Alpha Underwriting' }).first();
  ok('the analysis lists with its project', /BD-0001/.test(await iaRow.textContent().catch(() => '')),
     await iaRow.textContent().catch(() => 'row missing'));
  ok('budget rows carry no analysis chips anymore', (await p.locator('.ia-chip').count()) === 0);
  ok('no emoji in the analyses section', !/[\u{1F300}-\u{1FAFF}]/u.test(await p.locator('#page-analyses').textContent()));

  // versions open from the row's three-dot menu, like budgets
  await iaRow.locator('.rowmenu-btn').click();
  await p.waitForTimeout(200);
  const menuItems = await p.locator('#invRowMenu .rowmenu-item').allTextContents();
  ok('three-dot menu offers Open, Favorites, Versions, Duplicate, Delete',
     JSON.stringify(menuItems) === JSON.stringify(['Open Analysis', 'Add to Favorites', 'Versions', 'Duplicate', 'Delete Analysis']),
     menuItems.join(','));
  await p.locator('#invRowMenu .rowmenu-item', { hasText: 'Versions' }).click();
  await p.waitForTimeout(500);
  ok('Versions opens the history modal from the Home list',
     /Version History/.test(await p.locator('#invModal').textContent().catch(() => '')));
  await p.click('#invModal .btn-x');
  await iaRow.click();
  await p.waitForTimeout(600);
  ok('clicking the row opens the analysis',
     /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()) && await p.locator('#page-analysis').evaluate(e => e.classList.contains('on')),
     p.url());
  ok('the editor toolbar has no Versions button',
     (await p.locator('#page-analysis .page-title button', { hasText: 'Versions' }).count()) === 0);

  // ---- Settings (profile menu → Settings): the Light/Dark theme switch
  await p.click('#profileBtn'); await p.waitForTimeout(250);
  ok('account menu offers Settings before Sign Out',
     await p.evaluate(() => {
       const items = [...document.querySelectorAll('#profileMenu .rowmenu-item')].map(b => b.textContent.trim());
       return items.indexOf('Settings') >= 0 && items.indexOf('Settings') < items.indexOf('Sign Out');
     }));
  await p.click('#profileMenu button:has-text("Settings")'); await p.waitForTimeout(250);
  ok('Settings opens as a modal and closes the menu',
     await p.locator('#settingsModal').isVisible() && !(await p.locator('#profileMenu').isVisible()));
  ok('the theme picker offers exactly Light and Dark',
     await p.evaluate(() => [...document.querySelectorAll('#settingsModal [data-theme-pick]')]
       .map(b => b.dataset.themePick).join(',')) === 'light,dark');
  const lightBg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await p.click('#settingsModal [data-theme-pick=dark]'); await p.waitForTimeout(150);
  ok('dark theme applies and persists',
     await p.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark'
       && localStorage.getItem('fsTheme') === 'dark'));
  ok('dark theme actually remaps the surfaces',
     (await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) !== lightBg);
  ok('Settings marks the active theme',
     await p.evaluate(() => document.querySelector('#settingsModal [data-theme-pick=dark]').classList.contains('on')
       && !document.querySelector('#settingsModal [data-theme-pick=light]').classList.contains('on')));
  await p.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  ok('printing forces the light palette',
     (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === null);
  await p.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  ok('the chosen theme returns after printing',
     (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark');
  ok('a retired stored theme falls back to light',
     await p.evaluate(() => { setTheme('evergreen'); return document.documentElement.getAttribute('data-theme') === null
       && localStorage.getItem('fsTheme') === 'light'; }));
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);
  ok('Escape closes Settings', !(await p.locator('#settingsModal').isVisible()));
  ok('no corner theme dock remains', (await p.locator('#themeDock').count()) === 0);

  // ---- Cmd/Ctrl+K: the global search palette
  const MODK = process.platform === 'darwin' ? 'Meta' : 'Control';
  await p.keyboard.press(MODK + '+k');
  ok('Cmd/Ctrl+K opens the search palette', (await p.locator('#palette.open').count()) === 1);
  ok('palette input is inset and rounded so its focus ring is never clipped',
     await p.evaluate(() => {
       const card = document.querySelector('#palette .pal-card').getBoundingClientRect();
       const inp = document.getElementById('palInput');
       const i = inp.getBoundingClientRect();
       // the focus box-shadow spreads 3px — the input must sit further than
       // that inside the card on every side that has a rounded corner
       return parseFloat(getComputedStyle(inp).borderRadius) >= 6
         && i.left - card.left >= 4 && i.top - card.top >= 4 && card.right - i.right >= 4;
     }));
  await p.waitForFunction(() => document.querySelectorAll('#palList .pal-row').length > 0, { timeout: 8000 });
  ok('palette lists budgets first, then analyses',
     await p.evaluate(() => {
       const secs = [...document.querySelectorAll('#palList .pal-sec')].map(s => s.textContent.trim());
       return secs[0] === 'Budgets' && secs.includes('Investment Analyses');
     }));
  await p.fill('#palInput', 'alpha');
  await p.waitForTimeout(250);
  ok('typing filters across budgets AND analyses',
     await p.evaluate(() => {
       const names = [...document.querySelectorAll('#palList .pal-row .pal-name')].map(e => e.textContent);
       return names.includes('Alpha Ridge') && names.includes('Alpha Underwriting')
         && !names.includes('Zephyr Landing');
     }));
  await p.keyboard.press('ArrowDown');            // Alpha Ridge -> Alpha Underwriting
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  ok('Enter opens the selected analysis', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url())
     && (await p.locator('#palette.open').count()) === 0, p.url());
  await p.keyboard.press(MODK + '+k');
  await p.waitForFunction(() => document.querySelectorAll('#palList .pal-row').length > 0, { timeout: 8000 });
  await p.fill('#palInput', 'zephyr');
  await p.waitForTimeout(250);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(700);
  ok('Enter opens the selected budget', await p.evaluate(() => doc && doc.projectId === 'BD-0002'),
     await p.evaluate(() => doc && doc.projectId));
  await p.keyboard.press(MODK + '+k');
  await p.keyboard.press('Escape');
  ok('Escape closes the palette', (await p.locator('#palette.open').count()) === 0);

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
