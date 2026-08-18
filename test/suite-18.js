// Suite 18 — Home as a personal dashboard: rotating greetings, pinning from
// either row menu, personal recency, the attention queue, and the activity
// feed. Home must NOT be a third copy of the two index lists.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
const BASE='http://127.0.0.1:8100';
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto(BASE+'/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(900);

 // ---------- 1. Home is a dashboard, not a list ----------
 ok('Home is the landing page',
    await p.evaluate(()=>document.getElementById('page-home').classList.contains('on')));
 ok('Home carries no budgets table',
    await p.evaluate(()=>!document.querySelector('#page-home .tbl')
      && !document.getElementById('budgetsBody')?.closest('#page-home')));
 ok('Home carries no analyses table',
    await p.evaluate(()=>!document.querySelector('#page-home [data-inv-list]')));
 ok('the greeting renders',
    (await p.locator('#page-home .hm-greet').count())===1);
 ok('the greeting has a subline',
    (await p.evaluate(()=>{const s=document.querySelector('.hm-greet-sub');return s?s.textContent.trim():'';})).length>5);
 ok('both create actions are on Home',
    (await p.locator('#page-home button:has-text("+ New Budget")').count())===1
    && (await p.locator('#page-home button:has-text("+ New Investment Analysis")').count())===1);

 // An empty account is greeted differently from a returning one.
 const emptyGreet=await p.evaluate(()=>document.querySelector('.hm-greet').textContent.trim());
 ok('an empty account gets a getting-started greeting',
    await p.evaluate(()=>{
      const t=document.querySelector('.hm-greet').textContent.trim();
      return FSHome._greetingPools.empty.some(g=>g[0]===t);
    }), emptyGreet);
 ok('the empty account is not greeted by name', !/,/.test(emptyGreet), emptyGreet);
 ok('Home tells a new account what to do first',
    /No budgets yet/.test(await p.locator('#page-home').textContent()));

 // ---------- 2. seed real work ----------
 await p.evaluate(async()=>{
   const mk=(pid,nm,st,rate,updated)=>({projectId:pid,name:nm,status:st,resSF:1000,amenSF:0,
     units:[],other:[],expenses:[],
     lines:[{lineId:'s1',scope:'res',grp:'General',code:'',desc:'Shell',basis:'ls',auto:true,qty:0,unit:rate}],
     companies:[],contingency:{mode:'fixed',val:0},projectCosts:{land:0,dev:0,mkt:0,cls:0},
     pricingVersion:'2026.08-v2',updated:updated||new Date().toISOString()});
   const rows=[['BD-6001','Cedar Yard','Draft',3200000],
               ['BD-6002','Maple Court','In Review',2100000],
               ['BD-6003','Harbor Row','Draft',1500000]];
   for(const [pid,nm,st,rate] of rows){
     await fetch('/api/budget/'+pid,{method:'PUT',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({meta:{projectId:pid,name:nm,status:st},doc:mk(pid,nm,st,rate)})});
   }
   await fetch('/api/investment-analyses',{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({mode:'fromBudget',projectId:'BD-6001',analysisName:'Cedar Deal'})});
 });
 await p.evaluate(()=>{FSHome.invalidate();return FSHome.show();});
 await p.waitForTimeout(900);

 const sections=async()=>p.evaluate(()=>[...document.querySelectorAll('#page-home .hm-sec .eyebrow')].map(e=>e.textContent.trim()));
 ok('Home shows Recent and Your Activity once there is work',
    (await sections()).includes('Recent') && (await sections()).includes('Your Activity'),
    JSON.stringify(await sections()));

 // ---------- 3. needs attention ----------
 ok('the attention queue appears', (await sections()).includes('Needs Attention'));
 const att=await p.evaluate(()=>[...document.querySelectorAll('#page-home .hm-att')]
   .map(a=>({tag:a.querySelector('.hm-att-tag').textContent.trim(),
             txt:a.textContent.replace(/\s+/g,' ').trim()})));
 ok('an In Review budget is flagged for a decision',
    att.some(x=>x.tag==='In Review'&&/BD-6002/.test(x.txt)), JSON.stringify(att.map(x=>x.tag)));
 ok('budgets with no analysis are surfaced',
    att.some(x=>x.tag==='No Analysis'&&/BD-6003/.test(x.txt)), JSON.stringify(att));
 ok('a budget that already has an analysis is not nagged about it',
    !att.some(x=>x.tag==='No Analysis'&&/BD-6001/.test(x.txt)));
 ok('each record appears at most once in the queue',
    await p.evaluate(()=>{
      const ids=[...document.querySelectorAll('#page-home .hm-att .hm-att-id')].map(e=>e.textContent.trim());
      return new Set(ids).size===ids.length;
    }));
 // In Review outranks the softer reasons for the same record.
 ok('the most pressing reason wins for a record',
    att.filter(x=>/BD-6002/.test(x.txt)).every(x=>x.tag==='In Review'));

 // ---------- 4. recency is personal ----------
 ok('Recent lists work this account touched',
    (await p.locator('#page-home .hm-card').count())>0);
 ok('Recent says why and when',
    await p.evaluate(()=>{
      const w=document.querySelector('#page-home .hm-card .hm-when');
      return !!w && /ago|Updated|Saved|just now|\d/.test(w.textContent);
    }),
    await p.evaluate(()=>{const w=document.querySelector('#page-home .hm-card .hm-when');return w?w.textContent:'none';}));
 ok('a Recent card opens its record',
    await (async()=>{
      await p.locator('#page-home .hm-card').first().click();
      await p.waitForTimeout(900);
      const on=await p.evaluate(()=>{const e=document.querySelector('.page.on');return e?e.id:'';});
      return on==='page-budget'||on==='page-input'||on==='page-analysis';
    })(),
    await p.evaluate(()=>{const e=document.querySelector('.page.on');return e?e.id:'';}));
 await p.evaluate(()=>go('home')); await p.waitForTimeout(700);

 // ---------- 5. activity feed ----------
 ok('the activity feed lists events',
    (await p.locator('#page-home .hm-log-row').count())>0,
    'rows='+await p.locator('#page-home .hm-log-row').count());
 ok('activity events are labelled in plain words',
    await p.evaluate(()=>{
      const t=[...document.querySelectorAll('#page-home .hm-log-ev')].map(e=>e.textContent.trim());
      return t.length>0 && !t.some(x=>/_/.test(x));      // never raw event keys
    }),
    await p.evaluate(()=>[...document.querySelectorAll('#page-home .hm-log-ev')].map(e=>e.textContent.trim()).join(',')));
 ok('the feed is capped so Home stays short',
    (await p.locator('#page-home .hm-log-row').count())<=8);

 // ---------- 6. pinning from the budget row menu ----------
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(800);
 await p.click('#budgetsBody tr:has-text("BD-6003") .rowmenu-btn'); await p.waitForTimeout(250);
 const bItems=await p.locator('#rowMenu .rowmenu-item').allTextContents();
 ok('the budget row menu offers Pin to Home', bItems.includes('Pin to Home'), bItems.join(','));
 await p.click('#rowMenu .rowmenu-item:has-text("Pin to Home")'); await p.waitForTimeout(500);
 ok('pinning persists', await p.evaluate(()=>FSHome.isPinned('budget','BD-6003')));
 await p.evaluate(()=>go('home')); await p.waitForTimeout(800);
 ok('a Pinned section appears on Home', (await sections()).includes('Pinned'),
    JSON.stringify(await sections()));
 ok('the pinned budget is the one pinned',
    /BD-6003/.test(await p.evaluate(()=>{
      const secs=[...document.querySelectorAll('#page-home .hm-sec')];
      const s=secs.find(x=>x.querySelector('.eyebrow').textContent.trim()==='Pinned');
      return s?s.textContent:'';
    })));

 // the menu label flips, and unpinning removes the section
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(800);
 await p.click('#budgetsBody tr:has-text("BD-6003") .rowmenu-btn'); await p.waitForTimeout(250);
 const bItems2=await p.locator('#rowMenu .rowmenu-item').allTextContents();
 ok('the menu label flips to Unpin once pinned', bItems2.includes('Unpin From Home'), bItems2.join(','));
 await p.click('#rowMenu .rowmenu-item:has-text("Unpin From Home")'); await p.waitForTimeout(500);
 ok('unpinning clears it', !(await p.evaluate(()=>FSHome.isPinned('budget','BD-6003'))));
 await p.evaluate(()=>go('home')); await p.waitForTimeout(800);
 ok('the Pinned section disappears when nothing is pinned',
    !(await sections()).includes('Pinned'), JSON.stringify(await sections()));

 // ---------- 7. pinning from the analysis row menu ----------
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(900);
 await p.locator('#page-analyses [data-inv-list] tr .rowmenu-btn').first().click();
 await p.waitForTimeout(250);
 const aItems=await p.locator('#invRowMenu .rowmenu-item').allTextContents();
 ok('the analysis row menu offers Pin to Home', aItems.includes('Pin to Home'), aItems.join(','));
 await p.locator('#invRowMenu .rowmenu-item',{hasText:'Pin to Home'}).click(); await p.waitForTimeout(500);
 await p.evaluate(()=>go('home')); await p.waitForTimeout(800);
 ok('the pinned analysis shows on Home',
    await p.evaluate(()=>{
      const secs=[...document.querySelectorAll('#page-home .hm-sec')];
      const s=secs.find(x=>x.querySelector('.eyebrow').textContent.trim()==='Pinned');
      return !!s && /Analysis/.test(s.textContent);
    }));

 // ---------- 8. pins are scoped to the account ----------
 ok('pins are stored under the signed-in account',
    await p.evaluate(()=>Object.keys(localStorage).some(k=>/^fs-home-pins-v1:/.test(k))),
    await p.evaluate(()=>Object.keys(localStorage).filter(k=>/fs-home-pins/.test(k)).join(',')));

 // ---------- 9. greetings vary ----------
 ok('there are many greetings to draw from',
    await p.evaluate(()=>{
      const pools=FSHome._greetingPools;
      return Object.keys(pools).reduce((n,k)=>n+pools[k].length,0)>=25;
    }),
    await p.evaluate(()=>{
      const pools=FSHome._greetingPools;
      return Object.keys(pools).reduce((n,k)=>n+pools[k].length,0)+' greetings';
    }));
 ok('every greeting has a title and a subline',
    await p.evaluate(()=>{
      const pools=FSHome._greetingPools;
      return Object.keys(pools).every(k=>pools[k].every(g=>
        Array.isArray(g)&&g.length===2&&g[0].length>2&&g[1].length>10));
    }));
 // The pick is random, so assert the deterministic part: with work present the
 // greeting comes from a working pool (never the empty-account one) and is
 // either a bare pool title or that title followed by ", Name".
 ok('a returning greeting comes from a working pool, optionally named',
    await p.evaluate(()=>{
      const pools=FSHome._greetingPools;
      const working=[].concat(pools.morning,pools.afternoon,pools.evening,pools.night,pools.returning);
      const t=document.querySelector('.hm-greet').textContent.trim();
      const base=t.split(',')[0].trim();
      return working.some(g=>g[0]===base) && !pools.empty.some(g=>g[0]===base);
    }),
    await p.evaluate(()=>document.querySelector('.hm-greet').textContent));

 // ---------- 10. Home stays short ----------
 ok('Home fits a couple of screens, not a scroll of lists',
    await p.evaluate(()=>document.getElementById('page-home').getBoundingClientRect().height<1800),
    await p.evaluate(()=>Math.round(document.getElementById('page-home').getBoundingClientRect().height)+'px'));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
