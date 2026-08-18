// Suite 17 — unified navigation: the four-item primary nav with Pricing
// Library under More, the dedicated Budgets page, the shared workflow pills on
// the budget pages, Back buttons, the linked-budget icon on an analysis, and
// the budget status chip.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
const BASE='http://127.0.0.1:8100';
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto(BASE+'/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(600);

 // Seed two budgets and an analysis linked to one of them.
 await p.evaluate(async()=>{
   const mk=(pid,nm,st,rate)=>({projectId:pid,name:nm,status:st,resSF:1000,amenSF:0,
     units:[],other:[],expenses:[],
     lines:[{lineId:'s1',scope:'res',grp:'General',code:'',desc:'Shell',basis:'ls',auto:true,qty:0,unit:rate}],
     companies:[],contingency:{mode:'fixed',val:0},projectCosts:{land:0,dev:0,mkt:0,cls:0},
     pricingVersion:'2026.08-v2',updated:new Date().toISOString()});
   for(const [pid,nm,st,rate] of [['BD-8101','Cedar Yard','Draft',3200000],
                                  ['BD-8102','Maple Court','In Review',2100000]]){
     await fetch('/api/budget/'+pid,{method:'PUT',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({meta:{projectId:pid,name:nm,status:st},doc:mk(pid,nm,st,rate)})});
   }
   await fetch('/api/investment-analyses',{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({mode:'fromBudget',projectId:'BD-8101',analysisName:'Cedar Yard Deal'})});
 });

 // ---------- 1. the primary nav is exactly four items ----------
 const navItems=await p.evaluate(()=>[...document.querySelectorAll('nav > button')].map(b=>b.textContent.trim()));
 ok('the primary nav is Home, Budgets, Investment Analysis and More',
    JSON.stringify(navItems)===JSON.stringify(['Home','Budgets','Investment Analysis']),
    JSON.stringify(navItems));
 ok('More is present as the fourth item',
    await p.evaluate(()=>!!document.getElementById('nav-more-btn')));
 ok('Inputs, Budget and CSI Schedule are gone from the global nav',
    await p.evaluate(()=>!document.getElementById('nav-input')
      &&!document.getElementById('nav-csi')));
 ok('Pricing Library moved into the More dropdown',
    await p.evaluate(()=>{
      const pr=document.getElementById('nav-pricing');
      return !!pr && !!pr.closest('.nav-drop');
    }));
 ok('the other More items are still there',
    await p.evaluate(()=>['nav-help','nav-version'].every(id=>{
      const e=document.getElementById(id);return e&&e.closest('.nav-drop');})));

 // More is keyboard reachable and its items are real menu items
 ok('the More button reports its expanded state',
    await p.evaluate(()=>document.getElementById('nav-more-btn').getAttribute('aria-expanded')==='false'));
 await p.click('#nav-more-btn'); await p.waitForTimeout(200);
 ok('opening More flips aria-expanded',
    await p.evaluate(()=>document.getElementById('nav-more-btn').getAttribute('aria-expanded')==='true'));
 ok('More items carry the menuitem role',
    await p.evaluate(()=>document.getElementById('nav-pricing').getAttribute('role')==='menuitem'));
 ok('Pricing Library still routes to the pricing screen',
    await (async()=>{ await p.click('#nav-pricing'); await p.waitForTimeout(400);
      return p.evaluate(()=>document.getElementById('page-pricing').classList.contains('on')); })());
 ok('Pricing keeps More lit rather than a top-level tab',
    await p.evaluate(()=>document.getElementById('nav-more-btn').classList.contains('on')));

 // ---------- 2. the dedicated Budgets page ----------
 await p.click('#nav-budgets'); await p.waitForTimeout(700);
 ok('the Budgets nav item opens the Budgets page',
    await p.evaluate(()=>document.getElementById('page-budgets').classList.contains('on')));
 ok('the Budgets route is /budgets', (await p.evaluate(()=>location.hash))==='#/budgets',
    await p.evaluate(()=>location.hash));
 ok('the Budgets page lists the seeded budgets',
    (await p.locator('#budgetsBody tr').count())>=2,
    'rows='+await p.locator('#budgetsBody tr').count());
 ok('it shows real budget data, not placeholders',
    await p.evaluate(()=>{
      const t=document.getElementById('budgetsBody').textContent;
      return t.includes('BD-8101')&&t.includes('Cedar Yard');
    }));
 ok('it carries the same list controls as the analyses page',
    await p.evaluate(()=>['budgetsSearch','budgetsStatus','budgetsGroup','budgetsCount']
      .every(id=>!!document.getElementById(id))));
 ok('its rows use the shared status chip',
    (await p.locator('#budgetsBody .st-chip').count())>=2);
 ok('search filters the Budgets page',
    await (async()=>{ await p.fill('#budgetsSearch','Maple'); await p.waitForTimeout(300);
      const n=await p.locator('#budgetsBody tr').count();
      await p.fill('#budgetsSearch',''); await p.waitForTimeout(300);
      return n===1; })());
 ok('the empty state appears when nothing matches',
    await (async()=>{ await p.fill('#budgetsSearch','zzzznope'); await p.waitForTimeout(300);
      const vis=await p.evaluate(()=>document.getElementById('budgetsEmpty').style.display==='block');
      await p.fill('#budgetsSearch',''); await p.waitForTimeout(300);
      return vis; })());
 ok('Home and the Budgets page show the same budgets',
    await p.evaluate(()=>{
      const a=[...document.querySelectorAll('#homeBody tr')].length;
      const c=[...document.querySelectorAll('#budgetsBody tr')].length;
      return a===c&&a>0;
    }));

 // opening a budget from the Budgets page
 // Click the Project ID cell: the status cell swallows the click by design.
 await p.click('#budgetsBody tr:has-text("BD-8101") td:nth-child(2)'); await p.waitForTimeout(900);
 ok('a Budgets-page row opens that budget\'s workflow',
    await p.evaluate(()=>document.getElementById('page-budget').classList.contains('on')),
    await p.evaluate(()=>{const e=document.querySelector('.page.on');return e?e.id:'none';}));
 ok('it opened the budget that was clicked',
    (await p.locator('#bTitle').textContent()).includes('Cedar Yard'),
    await p.locator('#bTitle').textContent());

 // ---------- 3. workflow pills ----------
 await p.click('#page-budget [data-wf-pills] a:has-text("Inputs")'); await p.waitForTimeout(600);
 ok('the Inputs page shows the workflow pills',
    (await p.locator('#page-input [data-wf-pills] a').count())===3);
 ok('the pills are Inputs, Budget and CSI Schedule',
    (await p.evaluate(()=>[...document.querySelectorAll('#page-input [data-wf-pills] a')]
      .map(a=>a.textContent.replace(/^\d/,'').trim()).join('|')))==='Inputs|Budget|CSI Schedule',
    await p.evaluate(()=>[...document.querySelectorAll('#page-input [data-wf-pills] a')]
      .map(a=>a.textContent.trim()).join('|')));
 ok('the current section pill is marked active',
    await p.evaluate(()=>{
      const on=document.querySelector('#page-input [data-wf-pills] a.on');
      return !!on&&on.textContent.includes('Inputs')&&on.getAttribute('aria-current')==='page';
    }));
 ok('Budgets stays lit while inside the workflow',
    await p.evaluate(()=>document.getElementById('nav-budgets').classList.contains('on')));

 // pills are the same component the analysis steps use
 ok('budget pills and analysis steps are the same component',
    await p.evaluate(()=>!!document.querySelector('#page-input .wf-steps')));
 const pillStyle=await p.evaluate(()=>{
   const a=document.querySelector('#page-input [data-wf-pills] a');
   const s=getComputedStyle(a);
   return {radius:s.borderRadius,size:s.fontSize,pad:s.paddingLeft};
 });
 ok('the pills are the rounded pill shape', pillStyle.radius==='999px', JSON.stringify(pillStyle));

 // navigating by pill preserves the loaded budget
 await p.click('#page-input [data-wf-pills] a:has-text("Budget")'); await p.waitForTimeout(600);
 ok('a pill navigates to its section',
    await p.evaluate(()=>document.getElementById('page-budget').classList.contains('on')));
 ok('the Budget pill is now the active one',
    await p.evaluate(()=>{
      const on=document.querySelector('#page-budget [data-wf-pills] a.on');
      return !!on&&on.textContent.includes('Budget')&&!on.textContent.includes('CSI');
    }));
 ok('the open budget survives pill navigation',
    (await p.locator('#bTitle').textContent()).includes('Cedar Yard'),
    await p.locator('#bTitle').textContent());
 await p.click('#page-budget [data-wf-pills] a:has-text("CSI Schedule")'); await p.waitForTimeout(600);
 ok('the CSI pill reaches the CSI Schedule',
    await p.evaluate(()=>document.getElementById('page-csi').classList.contains('on')));
 ok('the CSI page shows the pills too',
    (await p.locator('#page-csi [data-wf-pills] a').count())===3);
 ok('the CSI pill is the active one there',
    await p.evaluate(()=>{
      const on=document.querySelector('#page-csi [data-wf-pills] a.on');
      return !!on&&on.textContent.includes('CSI');
    }));

 // ---------- 4. budget status chip ----------
 ok('every workflow page carries the status chip',
    await p.evaluate(()=>['iStatusHost','bStatusHost','cStatusHost']
      .every(id=>!!document.querySelector('#'+id+' .st-chip'))));
 ok('the old heavy STATUS select is gone',
    await p.evaluate(()=>!document.getElementById('bStatus')));
 const chipStyles=await p.evaluate(()=>{
   const bu=document.querySelector('#bStatusHost .st-chip');
   const li=document.querySelector('#budgetsBody .st-chip');
   if(!bu||!li) return null;
   const a=getComputedStyle(bu),c=getComputedStyle(li);
   return {same:a.fontSize===c.fontSize&&a.borderRadius===c.borderRadius&&a.textTransform===c.textTransform,
           size:a.fontSize};
 });
 ok('the budget chip matches the list chip exactly',
    !!chipStyles&&chipStyles.same, JSON.stringify(chipStyles));
 // editable, and still routed through the unsaved-changes path
 await p.click('#page-csi [data-wf-pills] a:has-text("Budget")'); await p.waitForTimeout(500);
 await p.click('#bStatusHost .st-chip'); await p.waitForTimeout(250);
 ok('clicking the chip opens the shared status menu',
    await p.evaluate(()=>{const m=document.getElementById('stMenu');
      return m&&m.style.display==='block'&&m.querySelectorAll('[data-st]').length===4;}));
 await p.click('#stMenu [data-st="Completed"]'); await p.waitForTimeout(400);
 ok('the chip updates to the chosen status',
    (await p.locator('#bStatusHost .st-chip').textContent()).trim()==='Completed');
 ok('changing status marks the budget unsaved rather than saving silently',
    await p.evaluate(()=>document.getElementById('saveState').textContent.toLowerCase().includes('unsaved')),
    await p.evaluate(()=>document.getElementById('saveState').textContent));
 await p.click('#page-budget button[data-save-btn]'); await p.waitForTimeout(700);

 // ---------- 5. Back buttons ----------
 ok('the Budget page has a Back to Budgets control',
    await p.evaluate(()=>{const b=[...document.querySelectorAll('#page-budget button')]
      .find(x=>(x.getAttribute('aria-label')||'')==='Back to Budgets');return !!b;}));
 ok('the Back control reads Back',
    (await p.evaluate(()=>{const b=document.querySelector('#page-budget button[aria-label="Back to Budgets"]');
      return b?b.textContent.replace(/[^A-Za-z]/g,''):'';}))==='Back',
    await p.evaluate(()=>{const b=document.querySelector('#page-budget button[aria-label="Back to Budgets"]');
      return b?b.textContent.trim():'none';}));
 // It belongs with the title on the left, not among Save/Export on the right.
 ok('Back sits on the left, above the page title',
    await p.evaluate(()=>{
      const t=document.querySelector('#page-budget .page-title');
      const b=t.querySelector('button[aria-label="Back to Budgets"]');
      const h=t.querySelector('h1');
      if(!b||!h) return false;
      const left=t.firstElementChild;
      return left.contains(b)                                   // in the title group
        && (b.compareDocumentPosition(h)&Node.DOCUMENT_POSITION_FOLLOWING)!==0  // before the heading
        && b.getBoundingClientRect().left < h.getBoundingClientRect().right;
    }),
    await p.evaluate(()=>{
      const t=document.querySelector('#page-budget .page-title');
      const b=t.querySelector('button[aria-label="Back to Budgets"]');
      const h=t.querySelector('h1');
      return JSON.stringify({back:Math.round(b.getBoundingClientRect().left),
                             title:Math.round(h.getBoundingClientRect().left),
                             top:Math.round(b.getBoundingClientRect().top),
                             titleTop:Math.round(h.getBoundingClientRect().top)});
    }));

 await p.click('#page-budget button[aria-label="Back to Budgets"]'); await p.waitForTimeout(700);
 ok('Back goes to the Budgets list, not Home',
    await p.evaluate(()=>document.getElementById('page-budgets').classList.contains('on')
      &&location.hash==='#/budgets'),
    await p.evaluate(()=>location.hash));

 // Back works after loading a nested URL directly
 await p.goto(BASE+'/index.html#/csi/BD-8102',{waitUntil:'networkidle'});
 await p.waitForTimeout(1000);
 ok('a deep CSI link loads that budget',
    await p.evaluate(()=>document.getElementById('page-csi').classList.contains('on')));
 ok('Back is present after a direct deep load',
    await p.evaluate(()=>!!document.querySelector('#page-csi button[aria-label="Back to Budgets"]')));
 await p.click('#page-csi button[aria-label="Back to Budgets"]'); await p.waitForTimeout(700);
 ok('Back from a deep load still reaches the Budgets list',
    await p.evaluate(()=>document.getElementById('page-budgets').classList.contains('on')));

 // ---------- 6. analysis Back + linked budget ----------
 await p.click('#nav-analyses'); await p.waitForTimeout(800);
 await p.click('#page-analyses [data-inv-list] tr'); await p.waitForTimeout(1000);
 ok('the analysis editor opened',
    await p.evaluate(()=>document.getElementById('page-analysis').classList.contains('on')));
 ok('the analysis has a Back to Analyses control',
    await p.evaluate(()=>!!document.querySelector('#page-analysis button[aria-label="Back to Investment Analyses"]')));
 ok('the analysis Back reads Back and sits left of the title',
    await p.evaluate(()=>{
      const t=document.querySelector('#page-analysis .page-title');
      const b=t.querySelector('button[aria-label="Back to Investment Analyses"]');
      const h=t.querySelector('h1');
      if(!b||!h) return false;
      return b.textContent.replace(/[^A-Za-z]/g,'')==='Back'
        && t.firstElementChild.contains(b)
        && b.getBoundingClientRect().top < h.getBoundingClientRect().top;
    }),
    await p.evaluate(()=>{
      const b=document.querySelector('#page-analysis button[aria-label="Back to Investment Analyses"]');
      return b?b.textContent.trim():'none';
    }));
 const link=await p.evaluate(()=>{
   const a=document.querySelector('#page-analysis .inv-srclink');
   if(!a) return null;
   return {label:a.getAttribute('aria-label'),href:a.getAttribute('href'),
           id:a.querySelector('.mono')?a.querySelector('.mono').textContent.trim():'',
           icon:!!a.querySelector('svg')};
 });
 ok('the source budget is a link with an accessible label',
    !!link&&/^Open linked budget BD-\d{4}$/.test(link.label), JSON.stringify(link));
 ok('the link carries the square-with-arrow icon', !!link&&link.icon);
 ok('the link uses the real linked budget id, not a constant',
    !!link&&link.id==='BD-8101'&&link.href==='#/inputs/BD-8101', JSON.stringify(link));
 await p.click('#page-analysis .inv-srclink'); await p.waitForTimeout(900);
 ok('the link opens the linked budget',
    await p.evaluate(()=>document.getElementById('page-input').classList.contains('on')));
 ok('it opened the right budget',
    (await p.locator('#pId').inputValue())==='BD-8101',
    await p.locator('#pId').inputValue());

 // analysis Back returns to the analyses list, not Budgets
 await p.goto(BASE+'/index.html#/analyses',{waitUntil:'networkidle'}); await p.waitForTimeout(800);
 await p.click('#page-analyses [data-inv-list] tr'); await p.waitForTimeout(1000);
 await p.click('#page-analysis button[aria-label="Back to Investment Analyses"]'); await p.waitForTimeout(700);
 ok('analysis Back returns to the analyses list',
    await p.evaluate(()=>document.getElementById('page-analyses').classList.contains('on')));

 // ---------- 7. deep links and refresh ----------
 await p.goto(BASE+'/index.html#/budgets',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
 ok('the Budgets page survives a direct load and refresh',
    await p.evaluate(()=>document.getElementById('page-budgets').classList.contains('on'))
    &&(await p.locator('#budgetsBody tr').count())>0);
 ok('Budgets is the lit nav item after a direct load',
    await p.evaluate(()=>document.getElementById('nav-budgets').classList.contains('on')));
 await p.goto(BASE+'/index.html#/inputs/BD-8102',{waitUntil:'networkidle'}); await p.waitForTimeout(1000);
 ok('Budgets stays lit on a nested budget route after a direct load',
    await p.evaluate(()=>document.getElementById('nav-budgets').classList.contains('on')));

 // ---------- 8. Home is untouched ----------
 await p.goto(BASE+'/index.html#/home',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
 ok('Home still lists budgets', (await p.locator('#homeBody tr').count())>=2);
 ok('Home still opens a budget',
    await (async()=>{ await p.click('#homeBody tr:has-text("BD-8102") td:nth-child(2)'); await p.waitForTimeout(900);
      return p.evaluate(()=>document.getElementById('page-budget').classList.contains('on')); })());
 ok('Home and Budgets open the same underlying budget',
    (await p.locator('#bTitle').textContent()).includes('Maple Court'),
    await p.locator('#bTitle').textContent());

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
