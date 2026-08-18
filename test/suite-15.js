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

 // ---- profile: display name, email, phone save to the account
 await p.click('#profileBtn'); await p.waitForTimeout(200);
 await p.click('#profileMenu button:has-text("Settings")'); await p.waitForTimeout(300);
 ok('Settings shows the signed-in identity',
    /Signed in as .+@/.test(await p.locator('#setSignedInAs').textContent()));
 await p.fill('#setDisplayName','Matt Tester');
 await p.fill('#setEmail','matt@example.com');
 await p.fill('#setPhone','555-0100');
 await p.click('#settingsModal button:has-text("Save Profile")'); await p.waitForTimeout(500);
 const u1=await p.evaluate(async()=>await (await fetch('/api/user-settings')).json());
 ok('profile fields persist to the account',
    u1.displayName==='Matt Tester'&&u1.email==='matt@example.com'&&u1.phone==='555-0100',
    JSON.stringify({d:u1.displayName,e:u1.email,p:u1.phone}));
 ok('the header identity adopts the display name',
    await p.evaluate(()=>document.getElementById('profileInitials').textContent)==='MT'
    &&await p.evaluate(()=>document.getElementById('pmName').textContent)==='Matt Tester');

 // ---- appearance: accent, avatar, time format, density
 await p.click('#settingsModal [data-accent-pick=blue]'); await p.waitForTimeout(1000);
 ok('accent applies to the tokens',
    await p.evaluate(()=>document.documentElement.getAttribute('data-accent')==='blue'
      &&getComputedStyle(document.documentElement).getPropertyValue('--green-700').trim()==='#1a4fa3'));
 ok('accent persists to the account',
    (await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).settings.accentColor))==='blue');
 await p.click('#settingsModal [data-avatar-pick="#14418A"]'); await p.waitForTimeout(300);
 ok('avatar background applies to the header icon',
    await p.evaluate(()=>getComputedStyle(document.getElementById('profileBtn')).backgroundColor)==='rgb(20, 65, 138)');
 await p.click('#settingsModal [data-timefmt-pick="24h"]'); await p.waitForTimeout(300);
 ok('24-hour format flips every timestamp helper',
    await p.evaluate(()=>fmtWhen('2026-08-17T20:52:00')==='08-17-2026 20:52'));
 await p.click('#settingsModal [data-density-pick=compact]'); await p.waitForTimeout(300);
 ok('compact density tightens the tables',
    await p.evaluate(()=>document.documentElement.getAttribute('data-density')==='compact'));

 // ---- home cards view (Home page only)
 await p.click('#settingsModal [data-homeview-pick=cards]'); await p.waitForTimeout(1000);
 await p.keyboard.press('Escape'); await p.waitForTimeout(300);
 ok('card view replaces the budget table on Home',
    await p.evaluate(()=>document.getElementById('homeCards').classList.contains('on')
      &&document.querySelector('#page-home .tbl').style.display==='none'
      &&document.querySelectorAll('#homeCards .hcard').length>=1));
 ok('analyses render as cards too',
    (await p.locator('#homeAnalyses [data-inv-cards] .hcard').count())>=1);
 ok('a budget card carries the money and status',
    /Contract Sum/.test(await p.locator('#homeCards .hcard').first().textContent())
    &&/\$2,000,000|\$/.test(await p.locator('#homeCards .hcard').first().textContent()));
 await p.locator('#homeAnalyses [data-inv-cards] .hcard').first().click(); await p.waitForTimeout(700);
 ok('clicking an analysis card opens the editor', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());
 await p.click('#nav-home'); await p.waitForTimeout(500);
 await p.locator('#homeCards .hcard').first().click(); await p.waitForTimeout(700);
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
      &&document.documentElement.getAttribute('data-density')==='compact'
      &&(window.__fsTimeFormat||'')==='24h'));
 ok('a quick return visit is not another login',
    (await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).loginCount))===1);
 await p.click('#nav-home'); await p.waitForTimeout(500);
 await p.click('#page-home .hcard'); await p.waitForTimeout(700);
 await p.click('#page-budget button:has-text("Export")'); await p.waitForTimeout(300);
 ok('remembered export options seed the modal after reload',
    !(await p.locator('#ex-csi').isChecked()));
 await p.click('#exportModal .btn-x');

 // ---- activity log carries the whole story
 const evs=await p.evaluate(async()=>(await (await fetch('/api/user-activity')).json()).events.map(e=>e.eventType));
 ok('activity log records logins, saves and settings changes',
    evs.includes('login')&&evs.includes('budget_save')&&evs.includes('settings_update'),
    evs.slice(0,10).join(','));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
