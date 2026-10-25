const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);

 // --- logo
 ok('SVG logo loads in header', await p.locator('.brand img').evaluate(e=>e.naturalWidth>0));
 ok('logo is the reversed (white) lockup',
    (await p.locator('.brand img').getAttribute('src')).includes('finishes-logo-white.svg'));
 ok('old text wordmark gone', (await p.locator('.wordmark').count())===0);

 // --- header single line at several widths
 for(const w of [1440,1280,1100,980]){
   await p.setViewportSize({width:w,height:900});
   await p.waitForTimeout(150);
   const h=await p.locator('body > header').evaluate(e=>e.getBoundingClientRect().height);
   ok('header is one line at '+w+'px', h===60, 'height='+h);
 }
 await p.setViewportSize({width:1400,height:1000});

 // --- OP id now four digits
 // A budget belongs to a project, so the parent is made first and chosen in
 // step 2 — a budget id can no longer imply one.
 await p.evaluate(async a=>{
   await fetch('/api/budget/'+a.p+'?scope=project',{method:'PUT',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,name:a.n,address:'1 Test Way'})});
 },{p:'OP-0601',n:'Validation Test'});
 await p.click('button:has-text("+ New Budget")').then(()=>p.click('#newBudgetModal .tpl-row[data-tpl="multifamily"]')); await p.waitForTimeout(300);
 await p.waitForTimeout(600);
 await p.selectOption('#nbProject','OP-0601');
 await p.fill('#nbId','BD-0601');
 await p.fill('#nbName','Validation Test');
 await p.click('#nbCreate');
 await p.waitForTimeout(600);

 const bad=async v=>{await p.fill('#pId',v);await p.locator('#pName').click();
   return await p.locator('#pId').evaluate(e=>e.classList.contains('err'));};
 ok('OP-001 (3 digits) now rejected', await bad('OP-001'));
 ok('OP-0001 (4 digits) accepted', !(await bad('OP-0001')));
 ok('BD-0001 still accepted', !(await bad('BD-0001')));
 ok('AS-0001 still accepted', !(await bad('AS-0001')));
 ok('TST-9999 still accepted', !(await bad('TST-9999')));
 // The field is the BUDGET namespace. New budgets are minted under the
 // identifier model as BDG-####-## children; the legacy prefixes are still
 // accepted so an older budget can be opened and saved, and the copy says
 // which is which.
 ok('inline error text names the budget formats, new model first',
    /BDG-####-##/.test(await p.locator('#pIdErr').textContent())
      && /BD-####/.test(await p.locator('#pIdErr').textContent()),
    (await p.locator('#pIdErr').textContent()).trim());
 ok('and the hint keeps the two namespaces apart',
    /Budget IDs are BDG-####-##/.test(await p.locator('#page-input .card-hd .eyebrow').first().textContent())
      && /projects are OP-####/.test(await p.locator('#page-input .card-hd .eyebrow').first().textContent()),
    (await p.locator('#page-input .card-hd .eyebrow').first().textContent()).trim());
 ok('a BDG child id is accepted by the validator', !(await bad('BDG-0042-01')));

 // --- auto dot no longer shifts the numbers
 await p.fill('#pId','TST-9999');
 const xs=await p.locator('#otherBody tr td:nth-child(3) input').evaluateAll(
   els=>els.map(e=>Math.round(e.getBoundingClientRect().right)));
 ok('income counts share one right edge', new Set(xs).size===1, 'edges: '+[...new Set(xs)].join(','));
 const dots=await p.locator('#otherBody .autodot').count();
 const rows=await p.locator('#otherBody tr').count();
 ok('every income row reserves a dot slot', dots===rows, rows+' rows / '+dots+' slots');
 const lit=await p.locator('#otherBody .autodot.on').count();
 ok('only auto rows have a lit dot', lit>0 && lit<rows, lit+' lit of '+rows);

 const xe=await p.locator('#expBody tr td:nth-child(4) input').evaluateAll(
   els=>els.map(e=>Math.round(e.getBoundingClientRect().right)));
 ok('expense counts share one right edge', new Set(xe).size===1, 'edges: '+[...new Set(xe)].join(','));

 // --- profit % stays on one line
 const cell=p.locator('#coBody tr td:nth-child(2)').first();
 ok('profit % cell is single line', (await cell.evaluate(e=>e.getBoundingClientRect().height))<44,
    'height='+Math.round(await cell.evaluate(e=>e.getBoundingClientRect().height)));

 // --- budget qty column alignment
 await p.click('#page-input button:has-text("Continue to Impact Fees")'); await p.waitForTimeout(250); await p.click('#page-fees button:has-text("Continue to Budget")'); await p.waitForTimeout(400);
 // Qty moved from column 3 to column 4 when the selection checkbox column landed
 const xq=await p.locator('#budBody tr td:nth-child(4) input').evaluateAll(
   els=>els.slice(0,25).map(e=>Math.round(e.getBoundingClientRect().right)));
 ok('budget quantities share one right edge', new Set(xq).size===1, 'edges: '+[...new Set(xq)].join(','));

 // --- line-item row layout (compactness, inline edit dot, no clipped text)
 await p.evaluate(() => { const l = doc.lines[2]; l.unit = l.unit + 1; touch(); });
 await p.waitForTimeout(300);
 const layout = await p.evaluate(() => {
   const mid = el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
   const row = [...document.querySelectorAll('#budBody tr')].find(t => t.className.includes('edited'));
   const li = row.querySelector('.lineitem');
   const dot = li.querySelector('.editdot'), code = li.querySelector('.codein'), desc = li.querySelector('.descin');
   const sels = [...document.querySelectorAll('#budBody select.basisin')];
   sels.forEach(x => { x.value = 'asf'; });          // the longest option
   const codes = [...document.querySelectorAll('#budBody input.codein')];
   const leaf = [...document.querySelectorAll('#budBody tr')].filter(t => !t.className.includes('-hd'));
   return {
     dotInline: Math.abs(mid(dot) - mid(code)) < 2 && Math.abs(mid(code) - mid(desc)) < 2,
     rowH: Math.round(leaf[0].getBoundingClientRect().height),
     clippedCodes: codes.filter(i => i.scrollWidth > i.clientWidth + 1).length,
     clippedSelects: sels.filter(x => x.scrollWidth > x.clientWidth + 1).length,
     codeLefts: new Set(codes.slice(0, 8).map(i => Math.round(i.getBoundingClientRect().left))).size
   };
 });
 ok('The edit dot sits inline with the code and description', layout.dotInline);
 ok('Line rows stay compact', layout.rowH <= 40, layout.rowH + 'px');
 ok('CSI codes are never clipped', layout.clippedCodes === 0, layout.clippedCodes + ' clipped');
 ok('The basis dropdown fits its longest option', layout.clippedSelects === 0,
    layout.clippedSelects + ' clipped');
 ok('Codes stay left-aligned whether or not a line is edited', layout.codeLefts === 1,
    layout.codeLefts + ' distinct left edges');
 ok('Selection checkboxes are rounded', await p.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('#budBody input[type=checkbox]')).borderRadius) >= 4));

 // --- favicon: one self-contained icon, legible on light and dark tab strips
 const fav = await p.evaluate(() => {
   const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')];
   return links.map(l => ({rel: l.getAttribute('rel'), href: l.getAttribute('href'),
                           sizes: l.getAttribute('sizes')}));
 });
 ok('A favicon is declared', fav.length >= 3, fav.length + ' icon links');
 ok('It ships 16 and 32 px PNGs',
    fav.some(f => /favicon-16\.png$/.test(f.href)) && fav.some(f => /favicon-32\.png$/.test(f.href)));
 ok('It ships an apple-touch-icon', fav.some(f => f.rel === 'apple-touch-icon'));
 // No media-scoped variants: a browser that ignores `media` would pick one at random,
 // and half the time that is the invisible one. The tile is legible either way.
 ok('The icon does not depend on prefers-color-scheme',
    await p.evaluate(() => ![...document.querySelectorAll('link[rel~="icon"]')]
      .some(l => (l.getAttribute('media') || '').includes('prefers-color-scheme'))));
 const favOk = await p.evaluate(async () => {
   const r = await fetch('assets/favicon-32.png');
   if (!r.ok) return 'status ' + r.status;
   const b = await r.blob();
   return b.size > 200 && b.type.includes('png') ? 'ok' : 'bad blob ' + b.size + ' ' + b.type;
 });
 ok('The favicon actually serves', favOk === 'ok', favOk);

 // ================= MOBILE — FULLY CAPABLE =================
 // Small screens get the whole app: every tab, editor, and action works. The
 // layout reflows — tables pan inside their cards, grids collapse to one
 // column — instead of restricting what the user can do.
 ok('The read-only mobile bar is gone', await p.evaluate(() =>
    !document.getElementById('mobileBar')));

 const m = await b.newPage({viewport:{width:390,height:844}});
 const merrs = []; m.on('pageerror', e => merrs.push(e.message));
 m.on('dialog', d => d.accept());
 await m.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await m.waitForTimeout(900);

 // The primary nav is four items now; the workflow sections are reached
 // through the budget pills, and Pricing Library lives under More.
 ok('Every nav tab is present on a phone', await m.evaluate(() =>
    ['nav-home','nav-budgets','nav-analyses','nav-more-btn']
      .every(id => document.getElementById(id).offsetParent !== null)
    && document.getElementById('nav-help') !== null
    && document.getElementById('nav-pricing') !== null));
 // The tab bar scrolls sideways on a phone, and its overflow used to clip the
 // More dropdown to nothing — Pricing Library, How to Use and Version were
 // unreachable. Hit-test the items: each must be the element under its own
 // centre, inside the viewport.
 await m.click('#nav-more-btn'); await m.waitForTimeout(250);
 const moreHits = await m.evaluate(() => ['nav-pricing','nav-help','nav-version'].map(id => {
   const e = document.getElementById(id), r = e.getBoundingClientRect();
   const x = r.left + r.width / 2, y = r.top + r.height / 2;
   const hit = document.elementFromPoint(x, y);
   return { id, w: Math.round(r.width), h: Math.round(r.height),
     inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
     hit: !!hit && (hit === e || e.contains(hit)) };
 }));
 ok('Every More item is visible and clickable on a phone',
    moreHits.every(h => h.w > 40 && h.h > 20 && h.inView && h.hit), JSON.stringify(moreHits));
 await m.click('#nav-version'); await m.waitForTimeout(400);
 ok('and a More item actually navigates on a phone',
    (await m.evaluate(() => currentPage)) === 'version', await m.evaluate(() => currentPage));
 ok('the More dropdown closes after choosing', await m.evaluate(() =>
    !document.getElementById('navMore').classList.contains('open')));
 // Navigating pans the tab bar so the lit tab is in view.
 await m.evaluate(() => { document.querySelector('.hd>nav').scrollLeft = 0; go('analyses'); });
 await m.waitForTimeout(300);
 ok('the active tab is scrolled into view on a phone', await m.evaluate(() => {
   const nav = document.querySelector('.hd>nav').getBoundingClientRect();
   const r = document.getElementById('nav-analyses').getBoundingClientRect();
   return r.left >= nav.left - 1 && r.right <= nav.right + 1;
 }), await m.evaluate(() => {
   const nav = document.querySelector('.hd>nav').getBoundingClientRect();
   const r = document.getElementById('nav-analyses').getBoundingClientRect();
   return Math.round(r.left) + '..' + Math.round(r.right) + ' in ' + Math.round(nav.left) + '..' + Math.round(nav.right);
 }));
 await m.evaluate(() => go('home')); await m.waitForTimeout(500);
 ok('The home page does not overflow the phone viewport', await m.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1),
    await m.evaluate(() => document.documentElement.scrollWidth + 'px wide in a '
      + window.innerWidth + 'px viewport'));
 ok('The + New Budget action is available on a phone', await m.evaluate(() =>
    document.getElementById('newBudgetBtn').offsetParent !== null));

 // Seed a budget so deep links and the row menu have something to act on.
 await m.evaluate(async () => {
   const meta = {projectId:'BD-4821', name:'Mobile Row', type:'Multifamily', status:'Draft',
                 contractSum:100, projectCost:130, updated:new Date().toISOString()};
   const doc = {projectId:'BD-4821', name:'Mobile Row', resSF:1, amenSF:0,
                units:[], other:[], expenses:[], lines:[], companies:[],
                contingency:{mode:'psf', val:0},
                projectCosts:{land:0, dev:0, mkt:0, cls:0}, pricingVersion:'x'};
   await fetch('/api/budget/BD-4821', {
     method:'PUT',
     headers:{'Content-Type':'application/json'},
     body: JSON.stringify({meta, doc})
   });
   await renderHome();
 });
 await m.evaluate(() => go('budgets'));
 await m.waitForTimeout(700);
 ok('The budgets table pans inside its card instead of crushing', await m.evaluate(() => {
   const bd = document.querySelector('#budgetsBudgetsCard .card-bd');
   return bd.scrollWidth > bd.clientWidth;
 }));
 await m.click('#budgetsBody tr .rowmenu-btn'); await m.waitForTimeout(300);
 ok('The row menu offers the full action set on a phone',
    (await m.locator('#rowMenu .rowmenu-item').allTextContents()).join('|')
      === 'Edit|Add to Favorites|Update Pricing|Versions|Delete Budget',
    (await m.locator('#rowMenu .rowmenu-item').allTextContents()).join('|'));
 await m.keyboard.press('Escape'); await m.waitForTimeout(150);

 // Editing pages open and accept input on a phone.
 await m.goto('http://127.0.0.1:8100/index.html#/inputs/BD-4821',{waitUntil:'networkidle'});
 await m.waitForTimeout(900);
 ok('A deep link opens the Inputs editor on a phone',
    (await m.evaluate(() => currentPage)) === 'input', await m.evaluate(() => currentPage));
 ok('The Inputs editor does not overflow the phone viewport', await m.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1),
    await m.evaluate(() => document.documentElement.scrollWidth + 'px wide in a '
      + window.innerWidth + 'px viewport'));
 ok('An input accepts an edit on a phone', await m.evaluate(() => {
   const f = document.getElementById('pName');
   f.value = 'Edited On Phone'; f.dispatchEvent(new Event('input', {bubbles:true}));
   return dirty === true;
 }));
 ok('Every editing page is reachable on a phone', await m.evaluate(() => {
   go('budget'); const bOk = currentPage === 'budget';
   go('csi');    const cOk = currentPage === 'csi';
   go('pricing');const pOk = currentPage === 'pricing';
   return bOk && cOk && pOk;
 }));
 // Panned to Qty/Rate, the group headers and the footer keep their labels in
 // view: they pin inside their own wide cell rather than scrolling off.
 const pan = await m.evaluate(async () => {
   // The seeded phone budget has no lines; borrow the template's.
   const d = blankDoc(); doc.lines = d.lines; doc.resSF = 51365;
   go('budget'); recalc(); await new Promise(r => setTimeout(r, 200));
   const pane = document.querySelector('#sec-budget .budget-scroll');
   const out = {};
   for (const x of [330, 470]) {
     pane.scrollLeft = x; await new Promise(r => setTimeout(r, 60));
     const left = pane.getBoundingClientRect().left;
     const inView = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left >= left - 1 && r.left <= left + 40; };
     out[x] = { grp: inView(document.querySelector('#budBody tr.grp-hd .hd-pin')),
       scope: inView(document.querySelector('#budBody tr.scope-hd .hd-pin')),
       k: inView(document.querySelector('.bud-foot .bf-k')), sub: inView(document.querySelector('.bud-foot .bf-sub')) };
   }
   pane.scrollLeft = 0; return out;
 });
 ok('Panned on a phone, group and scope labels stay in view',
    [330, 470].every(x => pan[x].grp && pan[x].scope), JSON.stringify(pan));
 ok('and so do the footer labels', [330, 470].every(x => pan[x].k && pan[x].sub), JSON.stringify(pan));
 ok('No JS errors on mobile', merrs.length === 0, merrs.join(' | '));
 await m.close();

 // Printing switches the browser to print media; exports must stay on the page
 // being exported. (The old width-query mobile mode is gone, but the invariant
 // it once broke is still worth pinning.)
 await p.click(".page.on [data-wf-pills] a:has-text('CSI Schedule')").catch(() => {});
 await p.waitForTimeout(300);
 const pageBefore = await p.evaluate(() => currentPage);
 await p.emulateMedia({media:'print'});
 await p.waitForTimeout(300);
 ok('Printing does not navigate away from the page being exported',
    (await p.evaluate(() => currentPage)) === pageBefore,
    pageBefore + ' → ' + (await p.evaluate(() => currentPage)));
 await p.emulateMedia({media:'screen'});
 await p.waitForTimeout(200);

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
