// Suite 15 — per-account settings (dbo.Users stand-in): boot bootstrap and
// login counting, profile fields, accent / avatar / time format / density,
// Home card view, remembered export options, and the activity log.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);

 // Seed one budget (mock derives its money from the doc) and one linked analysis.
 await p.evaluate(async()=>{
   const doc={projectId:'TST-9955',name:'Settings Test',status:'Draft',resSF:1000,amenSF:0,
     units:[],other:[],expenses:[],
     lines:[{lineId:'s1',scope:'res',grp:'General',code:'',desc:'Shell',basis:'ls',auto:true,qty:0,unit:2000000}],
     companies:[],contingency:{mode:'fixed',val:0},projectCosts:{land:0,dev:0,mkt:0,cls:0},
     pricingVersion:'2026.08-v2',updated:new Date().toISOString()};
   await fetch('/api/budget/TST-9955',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'TST-9955',name:'Settings Test',status:'Draft'},doc})});
   await fetch('/api/investment-analyses',{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({mode:'fromBudget',projectId:'TST-9955',analysisName:'Settings Deal'})});
 });

 // ---- boot bootstrap: account row + counted login + activity
 const u0=await p.evaluate(async()=>await (await fetch('/api/user-settings')).json());
 ok('boot creates the account row and counts one login', u0.loginCount===1, JSON.stringify({login:u0.loginCount}));
 ok('boot login lands in the activity log',
    (await p.evaluate(async()=>(await (await fetch('/api/user-activity')).json()).events))
      .some(e=>e.eventType==='login'));
 ok('the seed save was recorded as budget_save activity',
    (await p.evaluate(async()=>(await (await fetch('/api/user-activity')).json()).events))
      .some(e=>e.eventType==='budget_save'&&e.entityId==='TST-9955'));

 // ---- profile: locked email, defaulted display name, editable phone
 await p.click('#profileBtn'); await p.waitForTimeout(200);
 await p.click('#profileMenu button:has-text("Settings")'); await p.waitForTimeout(300);
 ok('email is locked to the sign-in account',
    await p.evaluate(()=>{const e=document.getElementById('setEmail');
      return e.disabled&&e.value.includes('@');}),
    await p.evaluate(()=>document.getElementById('setEmail').value));
 ok('display name defaults from the sign-in identity',
    (await p.evaluate(()=>document.getElementById('setDisplayName').value)).trim().length>0,
    await p.evaluate(()=>document.getElementById('setDisplayName').value));
 await p.fill('#setDisplayName','Matt Tester');
 await p.fill('#setPhone','555-0100');
 await p.click('#settingsModal button:has-text("Save Profile")'); await p.waitForTimeout(500);
 const u1=await p.evaluate(async()=>await (await fetch('/api/user-settings')).json());
 ok('profile persists; email stays locked to the account',
    u1.displayName==='Matt Tester'&&u1.phone==='555-0100'&&u1.email===u1.userDetails,
    JSON.stringify({d:u1.displayName,e:u1.email,p:u1.phone,s:u1.userDetails}));
 ok('the header identity adopts the display name',
    await p.evaluate(()=>document.getElementById('profileInitials').textContent)==='MT'
    &&await p.evaluate(()=>document.getElementById('pmName').textContent)==='Matt Tester');

 // ---- appearance: named accents, red/orange, custom picker, avatar, time format
 await p.click('#settingsModal [data-accent-pick=red]'); await p.waitForTimeout(200);
 ok('red accent applies',
    await p.evaluate(()=>document.documentElement.getAttribute('data-accent')==='red'));
 await p.click('#settingsModal [data-accent-pick=orange]'); await p.waitForTimeout(200);
 ok('orange accent applies',
    await p.evaluate(()=>document.documentElement.getAttribute('data-accent')==='orange'));
 await p.evaluate(()=>chooseSetting('accentColor','#ff6600')); await p.waitForTimeout(1000);
 ok('a custom accent derives a full scale from the picked color',
    await p.evaluate(()=>document.documentElement.getAttribute('data-accent')===null
      &&document.documentElement.style.getPropertyValue('--green-700').trim()!==''
      &&document.querySelector('[data-accent-pick=custom]').classList.contains('on')));
 ok('the custom accent persists to the account',
    (await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).settings.accentColor))==='#ff6600');
 await p.click('#settingsModal [data-accent-pick=blue]'); await p.waitForTimeout(1000);
 ok('accent applies to the tokens',
    await p.evaluate(()=>document.documentElement.getAttribute('data-accent')==='blue'
      &&getComputedStyle(document.documentElement).getPropertyValue('--green-700').trim()==='#1a4fa3'));
 ok('accent persists to the account',
    (await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).settings.accentColor))==='blue');
 await p.click('#settingsModal [data-avatar-pick="#14418A"]'); await p.waitForTimeout(300);
 ok('avatar background applies to the header icon',
    await p.evaluate(()=>getComputedStyle(document.getElementById('profileBtn')).backgroundColor)==='rgb(20, 65, 138)');
 await p.evaluate(()=>chooseSetting('avatarColor','#336699')); await p.waitForTimeout(300);
 ok('a custom profile-icon color applies',
    await p.evaluate(()=>getComputedStyle(document.getElementById('profileBtn')).backgroundColor)==='rgb(51, 102, 153)');
 ok('the rainbow swatch marks custom as active',
    await p.evaluate(()=>document.querySelector('[data-avatar-pick=custom]').classList.contains('on')));
 await p.click('#settingsModal [data-timefmt-pick="24h"]'); await p.waitForTimeout(300);
 ok('24-hour format flips every timestamp helper',
    await p.evaluate(()=>fmtWhen('2026-08-17T20:52:00')==='08-17-2026 20:52'));
 await p.evaluate(()=>{const c=document.getElementById('setRememberExport');
   c.checked=true;c.dispatchEvent(new Event('change'));});
 ok('the Remember Export Settings toggle flips the setting',
    await p.evaluate(()=>usSettings().rememberExport===true
      &&document.getElementById('setRememberExport').checked));
 // ---- per-section views: three options each, budgets and analyses separate
 await p.click('#settingsModal [data-budgetview-pick=compact]'); await p.waitForTimeout(400);
 ok('compact view tightens the budgets card only',
    await p.evaluate(()=>document.getElementById('budgetsBudgetsCard').getAttribute('data-density')==='compact'
      &&usSettings().analysisView==='comfortable'));
 await p.click('#settingsModal [data-budgetview-pick=cards]'); await p.waitForTimeout(800);
 await p.keyboard.press('Escape'); await p.waitForTimeout(300);

 // ---- the Home toolbar three-way toggle drives the budgets view
 await p.click('#page-home .mini-seg [data-budgetview-pick=comfortable]'); await p.waitForTimeout(400);
 ok('the toolbar flips budgets back to the comfortable list',
    !(await p.evaluate(()=>document.getElementById('budgetsCards').classList.contains('on'))));
 const hComfy=await p.evaluate(()=>document.querySelector('#budgetsBody td').getBoundingClientRect().height);
 await p.click('#page-home .mini-seg [data-budgetview-pick=compact]'); await p.waitForTimeout(400);
 const hCompact=await p.evaluate(()=>document.querySelector('#budgetsBody td').getBoundingClientRect().height);
 ok('comfortable rows are dramatically taller than compact rows', hComfy-hCompact>=10,
    JSON.stringify({hComfy,hCompact}));
 ok('the toolbar marks the active choice',
    await p.evaluate(()=>document.querySelector('#page-home .mini-seg [data-budgetview-pick=compact]').classList.contains('on')));
 await p.click('#page-home .mini-seg [data-budgetview-pick=cards]'); await p.waitForTimeout(500);
 await p.evaluate(()=>chooseSetting('analysisView','cards')); await p.waitForTimeout(900);
 ok('card view replaces the budget table on Home',
    await p.evaluate(()=>document.getElementById('budgetsCards').classList.contains('on')
      &&document.querySelector('#page-home .tbl').style.display==='none'
      &&document.querySelectorAll('#budgetsCards .hcard').length>=1));
 ok('analyses render as cards too',
    (await p.locator('#page-analyses [data-inv-cards] .hcard').count())>=1);
 ok('a budget card carries the money and status',
    /Contract Sum/.test(await p.locator('#budgetsCards .hcard').first().textContent())
    &&/\$2,000,000|\$/.test(await p.locator('#budgetsCards .hcard').first().textContent()));
 await p.locator('#page-analyses [data-inv-cards] .hcard').first().click(); await p.waitForTimeout(700);
 ok('clicking an analysis card opens the editor', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());
 await p.click('#nav-home'); await p.waitForTimeout(500);
 await p.locator('#budgetsCards .hcard').first().click(); await p.waitForTimeout(700);
 ok('clicking a budget card opens the budget',
    await p.evaluate(()=>doc&&doc.projectId==='TST-9955'));

 // ---- remembered export options (budget side)
 await p.evaluate(()=>chooseSetting('rememberExport',true)); await p.waitForTimeout(1000);
 await p.click('#page-budget button:has-text("Export")'); await p.waitForTimeout(200);
 await p.uncheck('#ex-csi'); await p.waitForTimeout(1000);
 await p.click('#exportModal .btn-x');
 const exSaved=await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).settings.exportOptions);
 ok('export choices persist per product', exSaved.budget&&exSaved.budget.csi===false, JSON.stringify(exSaved));

 // ---- a fresh browser: local caches cleared, the account restores everything
 await p.evaluate(()=>localStorage.clear());
 await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(800);
 ok('account settings survive a cleared browser',
    await p.evaluate(()=>document.documentElement.getAttribute('data-accent')==='blue'
      &&usSettings().budgetView==='cards'&&usSettings().analysisView==='cards'
      &&(window.__fsTimeFormat||'')==='24h'));
 ok('a quick return visit is not another login',
    (await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).loginCount))===1);
 await p.click('#nav-home'); await p.waitForTimeout(500);
 await p.click('#page-home .hcard'); await p.waitForTimeout(700);
 await p.click('#page-budget button:has-text("Export")'); await p.waitForTimeout(300);
 ok('remembered export options seed the modal after reload',
    !(await p.locator('#ex-csi').isChecked()));
 await p.click('#exportModal .btn-x');

 // ---- the shared status system: editable chips everywhere
 await p.click('#nav-home'); await p.waitForTimeout(500);
 await p.click('#page-home .mini-seg [data-budgetview-pick=comfortable]'); await p.waitForTimeout(400);
 ok('budget rows carry editable status chips',
    (await p.locator('#budgetsBody .st-chip').count())>=1);
 await p.locator('#budgetsBody .st-chip').first().click(); await p.waitForTimeout(200);
 ok('clicking a chip opens the status menu with all four statuses',
    await p.evaluate(()=>['Draft','In Review','Completed','Cancelled'].every(x=>
      document.getElementById('stMenu').textContent.includes(x))));
 await p.click('#stMenu [data-st="In Review"]'); await p.waitForTimeout(600);
 ok('the budget status saves and repaints without a refresh',
    /In Review/.test(await p.locator('#budgetsBody .st-chip').first().textContent())
    &&(await p.evaluate(async()=>(await (await fetch('/api/budgets')).json())[0].status))==='In Review');
 ok('the analyses list chips are the same component',
    (await p.locator('#page-analyses .st-chip').count())>=1);
 await p.locator('#page-analyses .st-chip').first().click(); await p.waitForTimeout(200);
 await p.click('#stMenu [data-st="Completed"]'); await p.waitForTimeout(600);
 ok('the analysis status saves through the status-only PUT',
    (await p.evaluate(async()=>(await (await fetch('/api/investment-analyses')).json())[0].status))==='Completed');
 // the editors expose the same status controls (analyses are in card view here)
 await p.locator('#page-analyses [data-inv-cards] .hcard').first().click(); await p.waitForTimeout(700);
 ok('the analysis editor shows the editable status chip',
    /Completed/.test(await p.locator('#invStatusHost').textContent()));
 await p.locator('#invStatusHost .st-chip').click(); await p.waitForTimeout(200);
 await p.click('#stMenu [data-st="Cancelled"]'); await p.waitForTimeout(600);
 ok('changing status from the editor saves immediately',
    /Cancelled/.test(await p.locator('#invStatusHost').textContent())
    &&(await p.evaluate(async()=>(await (await fetch('/api/investment-analyses')).json())[0].status))==='Cancelled');

 // ---- activity log carries the whole story
 const evs=await p.evaluate(async()=>(await (await fetch('/api/user-activity')).json()).events.map(e=>e.eventType));
 ok('activity log records logins, saves and settings changes',
    evs.includes('login')&&evs.includes('budget_save')&&evs.includes('settings_update'),
    evs.slice(0,10).join(','));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
