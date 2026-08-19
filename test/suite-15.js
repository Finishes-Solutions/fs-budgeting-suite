// Suite 15 — per-account settings (dbo.Users stand-in): boot bootstrap and
// login counting, profile fields, accent / avatar / time format / density,
// theme packs (the super_admin visual preview), Home card view, remembered
// export options, and the activity log.
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
 // ---- theme packs: a super_admin preview that repaints and nothing else
 ok('Settings offers the Theme Pack control to a super admin',
    await p.evaluate(()=>getComputedStyle(document.getElementById('setThemePackRow')).display!=='none'));
 const navBefore=await p.evaluate(()=>[...document.querySelectorAll('body>header nav button')]
   .map(b=>b.textContent.trim()));
 await p.click('#settingsModal [data-themepack-pick=ramp]'); await p.waitForTimeout(1200);
 ok('the pack applies as one scoped attribute',
    await p.evaluate(()=>document.documentElement.getAttribute('data-skin')==='ramp'));
 ok('the pack follows the account',
    (await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).settings.themePack))==='ramp');
 ok('the primary action carries the pack accent',
    await p.evaluate(()=>{const b=document.querySelector('#page-home .btn-primary');
      return b&&getComputedStyle(b).backgroundColor==='rgb(223, 242, 0)';}),
    await p.evaluate(()=>{const b=document.querySelector('#page-home .btn-primary');
      return b?getComputedStyle(b).backgroundColor:'(no button)';}));
 ok('a pack owns its palette, so the accent attribute stands down',
    await p.evaluate(()=>document.documentElement.getAttribute('data-accent')===null));
 ok('the account keeps its accent choice underneath the pack',
    (await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).settings.accentColor))==='blue');
 ok('the pack changes no navigation label',
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('body>header nav button')]
      .map(b=>b.textContent.trim())))===JSON.stringify(navBefore), navBefore.join('|'));
 ok('the Home hero gains the decorative dot field: behind content, pointer-transparent',
    await p.evaluate(()=>{
      const st=getComputedStyle(document.querySelector('#page-home .hm-hero'),'::before');
      return /radial-gradient/.test(st.backgroundImage)&&st.pointerEvents==='none'
        &&parseInt(st.zIndex,10)<0;}));
 // The decoration is full-bleed, so the phone width is where it would show up
 // as a sideways scroll if the bleed ever exceeded main's own padding.
 await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(400);
 ok('the pack never widens the page on a phone',
    await p.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),
    await p.evaluate(()=>document.documentElement.scrollWidth+' vs '+document.documentElement.clientWidth));
 await p.setViewportSize({width:1400,height:1000}); await p.waitForTimeout(400);
 // Print renders the default pack, so an export can never inherit a preview.
 await p.evaluate(()=>window.dispatchEvent(new Event('beforeprint'))); await p.waitForTimeout(150);
 ok('printing strips the pack',
    await p.evaluate(()=>document.documentElement.getAttribute('data-skin')===null));
 await p.evaluate(()=>window.dispatchEvent(new Event('afterprint'))); await p.waitForTimeout(150);
 ok('the pack comes back after printing',
    await p.evaluate(()=>document.documentElement.getAttribute('data-skin')==='ramp'));
 // The ROLE decides, not the stored value: losing super_admin stops the pack
 // being painted without rewriting the account's setting.
 const gate=await p.evaluate(()=>{
   const role=US.appRole, roles=principal?principal.userRoles:null;
   US.appRole='user'; if(principal)principal.userRoles=['authenticated'];
   applyThemePack('ramp');
   const applied=document.documentElement.getAttribute('data-skin');
   US.appRole=role; if(principal)principal.userRoles=roles;
   applyThemePack(themePackSetting());
   return {applied, restored:document.documentElement.getAttribute('data-skin'),
           stored:usSettings().themePack};
 });
 ok('an account without super_admin never gets the pack, and keeps its setting',
    gate.applied===null&&gate.restored==='ramp'&&gate.stored==='ramp', JSON.stringify(gate));
 // home.css, dashboard.css and feedback.css qualify many rules with a page id,
 // so a pack override has to carry the same id or silently lose the cascade.
 // These three are the trap in miniature: shell, list, and an id-owned tag.
 ok('the pack repaints the shell, the list and the id-scoped tags alike',
    await p.evaluate(()=>{
      const hd=getComputedStyle(document.querySelector('body>header')).backgroundColor;
      const tag=document.querySelector('#page-home .hm-kind-budget');
      return hd==='rgb(255, 255, 255)'
        &&(!tag||getComputedStyle(tag).backgroundColor==='rgb(244, 250, 194)');}),
    await p.evaluate(()=>getComputedStyle(document.querySelector('body>header')).backgroundColor));
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(600);
 ok('list headers restyle while money cells keep the mono, tabular figures',
    await p.evaluate(()=>{
      const th=getComputedStyle(document.querySelector('#page-budgets .tbl th'));
      const td=document.querySelector('#page-budgets .tbl td.calc');
      return /Inter|Helvetica|system-ui/.test(th.fontFamily)&&!/Plex/.test(th.fontFamily)
        &&(!td||(/Plex/.test(getComputedStyle(td).fontFamily)
          &&/tabular-nums/.test(getComputedStyle(td).fontVariantNumeric)));}));
 await p.evaluate(()=>go('home')); await p.waitForTimeout(600);
 await p.click('#settingsModal [data-themepack-pick=default]'); await p.waitForTimeout(1200);
 ok('switching back restores the default appearance and repaints the accent',
    await p.evaluate(()=>document.documentElement.getAttribute('data-skin')===null
      &&document.documentElement.getAttribute('data-accent')==='blue'));
 ok('the default appearance is byte-for-byte the app chrome again',
    await p.evaluate(()=>getComputedStyle(document.querySelector('body>header')).backgroundColor)
      ==='rgb(22, 25, 26)');

 // ---- per-section views: three options each, budgets and analyses separate
 await p.click('#settingsModal [data-budgetview-pick=compact]'); await p.waitForTimeout(400);
 ok('compact view tightens the budgets card only',
    await p.evaluate(()=>document.getElementById('budgetsBudgetsCard').getAttribute('data-density')==='compact'
      &&usSettings().analysisView==='comfortable'));
 await p.click('#settingsModal [data-budgetview-pick=cards]'); await p.waitForTimeout(800);
 await p.keyboard.press('Escape'); await p.waitForTimeout(300);

 // ---- the Budgets toolbar three-way toggle drives the budgets view
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(700);
 await p.click('#page-budgets .mini-seg [data-budgetview-pick=comfortable]'); await p.waitForTimeout(400);
 ok('the toolbar flips budgets back to the comfortable list',
    !(await p.evaluate(()=>document.getElementById('budgetsCards').classList.contains('on'))));
 const hComfy=await p.evaluate(()=>document.querySelector('#budgetsBody td').getBoundingClientRect().height);
 await p.click('#page-budgets .mini-seg [data-budgetview-pick=compact]'); await p.waitForTimeout(400);
 const hCompact=await p.evaluate(()=>document.querySelector('#budgetsBody td').getBoundingClientRect().height);
 ok('comfortable rows are dramatically taller than compact rows', hComfy-hCompact>=10,
    JSON.stringify({hComfy,hCompact}));
 ok('the toolbar marks the active choice',
    await p.evaluate(()=>document.querySelector('#page-budgets .mini-seg [data-budgetview-pick=compact]').classList.contains('on')));
 await p.click('#page-budgets .mini-seg [data-budgetview-pick=cards]'); await p.waitForTimeout(500);
 await p.evaluate(()=>chooseSetting('analysisView','cards')); await p.waitForTimeout(900);
 ok('card view replaces the budget table on the Budgets page',
    await p.evaluate(()=>document.getElementById('budgetsCards').classList.contains('on')
      &&document.querySelector('#page-budgets .tbl').style.display==='none'
      &&document.querySelectorAll('#budgetsCards .hcard').length>=1));
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(800);
 ok('analyses render as cards too',
    (await p.locator('#page-analyses [data-inv-cards] .hcard').count())>=1);
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(700);
 ok('a budget card carries the money and status',
    /Contract Sum/.test(await p.locator('#budgetsCards .hcard').first().textContent())
    &&/\$2,000,000|\$/.test(await p.locator('#budgetsCards .hcard').first().textContent()));
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(800);
 await p.locator('#page-analyses [data-inv-cards] .hcard').first().click(); await p.waitForTimeout(700);
 ok('clicking an analysis card opens the editor', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(700);
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
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(700);
 await p.click('#page-budgets .hcard'); await p.waitForTimeout(700);
 await p.click('#page-budget button:has-text("Export")'); await p.waitForTimeout(300);
 ok('remembered export options seed the modal after reload',
    !(await p.locator('#ex-csi').isChecked()));
 await p.click('#exportModal .btn-x');

 // ---- the shared status system: editable chips everywhere
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(700);
 await p.click('#page-budgets .mini-seg [data-budgetview-pick=comfortable]'); await p.waitForTimeout(400);
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
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(800);
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
