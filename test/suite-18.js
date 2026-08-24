// Suite 18 — Home as a personal dashboard: rotating greetings, favoriting from
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
 // What you were doing outranks what is nagging you.
 ok('Recent sits above Needs Attention',
    await (async()=>{ const s=await sections();
      return s.indexOf('Recent')>=0 && s.indexOf('Needs Attention')>=0
        && s.indexOf('Recent')<s.indexOf('Needs Attention'); })(),
    JSON.stringify(await sections()));
 ok('the activity list carries no View All link',
    await p.evaluate(()=>{
      const secs=[...document.querySelectorAll('#page-home .hm-sec')];
      const a=secs.find(x=>x.querySelector('.eyebrow').textContent.trim()==='Your Activity');
      return !!a && !a.querySelector('.hm-link');
    }));

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

 // ---------- 6. favoriting from the budget row menu ----------
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(800);
 await p.click('#budgetsBody tr:has-text("BD-6003") .rowmenu-btn'); await p.waitForTimeout(250);
 const bItems=await p.locator('#rowMenu .rowmenu-item').allTextContents();
 ok('the budget row menu offers Add to Favorites', bItems.includes('Add to Favorites'), bItems.join(','));
 await p.click('#rowMenu .rowmenu-item:has-text("Add to Favorites")'); await p.waitForTimeout(500);
 ok('favoriting persists', await p.evaluate(()=>FSHome.isFavorite('budget','BD-6003')));
 await p.evaluate(()=>go('home')); await p.waitForTimeout(800);
 ok('a Favorites section appears on Home', (await sections()).includes('Favorites'),
    JSON.stringify(await sections()));
 ok('the favorited budget is the one starred',
    /BD-6003/.test(await p.evaluate(()=>{
      const secs=[...document.querySelectorAll('#page-home .hm-sec')];
      const s=secs.find(x=>x.querySelector('.eyebrow').textContent.trim()==='Favorites');
      return s?s.textContent:'';
    })));

 // the menu label flips, and un-favoriting removes the section
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(800);
 await p.click('#budgetsBody tr:has-text("BD-6003") .rowmenu-btn'); await p.waitForTimeout(250);
 const bItems2=await p.locator('#rowMenu .rowmenu-item').allTextContents();
 ok('the menu label flips once favorited', bItems2.includes('Remove From Favorites'), bItems2.join(','));
 await p.click('#rowMenu .rowmenu-item:has-text("Remove From Favorites")'); await p.waitForTimeout(500);
 ok('un-favoriting clears it', !(await p.evaluate(()=>FSHome.isFavorite('budget','BD-6003'))));
 await p.evaluate(()=>go('home')); await p.waitForTimeout(800);
 ok('the Favorites section disappears when nothing is starred',
    !(await sections()).includes('Favorites'), JSON.stringify(await sections()));

 // ---------- 7. favoriting from the analysis row menu ----------
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(900);
 await p.locator('#page-analyses [data-inv-list] tr .rowmenu-btn').first().click();
 await p.waitForTimeout(250);
 const aItems=await p.locator('#invRowMenu .rowmenu-item').allTextContents();
 ok('the analysis row menu offers Add to Favorites', aItems.includes('Add to Favorites'), aItems.join(','));
 await p.locator('#invRowMenu .rowmenu-item',{hasText:'Add to Favorites'}).click(); await p.waitForTimeout(500);
 await p.evaluate(()=>go('home')); await p.waitForTimeout(800);
 ok('the favorited analysis shows on Home',
    await p.evaluate(()=>{
      const secs=[...document.querySelectorAll('#page-home .hm-sec')];
      const s=secs.find(x=>x.querySelector('.eyebrow').textContent.trim()==='Favorites');
      return !!s && /Analysis/.test(s.textContent);
    }));

 // ---------- 8. favorites live on the account, not in the browser ----------
 await p.waitForTimeout(1200);            // the settings save is debounced
 const svrPins=await p.evaluate(async()=>{
   const r=await fetch('/api/user-settings');
   const j=await r.json();
   return (j.settings&&j.settings.favorites)||null;
 });
 ok('the favorite is written to the account settings document',
    !!svrPins && Array.isArray(svrPins.analysis) && svrPins.analysis.length===1,
    JSON.stringify(svrPins));
 ok('nothing star-shaped is left behind in localStorage',
    await p.evaluate(()=>!Object.keys(localStorage).some(k=>/fs-home-pins/.test(k))),
    await p.evaluate(()=>Object.keys(localStorage).filter(k=>/fs-home-pins/.test(k)).join(',')));
 // A different browser is the same account: wipe every local trace and reload.
 await p.evaluate(()=>localStorage.clear());
 await p.reload({waitUntil:'networkidle'});
 await p.waitForTimeout(1400);
 ok('the favorite survives a browser with no local state',
    await p.evaluate(()=>FSHome.isFavorite('analysis',
      ((FSHome._favorites&&FSHome._favorites().analysis)||[])[0]||'')),
    JSON.stringify(await p.evaluate(()=>FSHome._favorites&&FSHome._favorites())));
 ok('the Favorites section renders from the account settings',
    (await sections()).includes('Favorites'), JSON.stringify(await sections()));

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

 // ---------- 11. card alignment and the pinned indicator ----------
 // A deliberately long name so one card in the grid wraps to two lines while
 // its neighbours take one: that is the case the old layout got wrong.
 await p.evaluate(async()=>{
   const doc={projectId:'BD-6009',name:'Riverside Commons Phase Two Redevelopment',status:'Draft',
     resSF:1000,amenSF:0,units:[],other:[],expenses:[],
     lines:[{lineId:'s1',scope:'res',grp:'General',code:'',desc:'Shell',basis:'ls',auto:true,qty:0,unit:98765432}],
     companies:[],contingency:{mode:'fixed',val:0},projectCosts:{land:0,dev:0,mkt:0,cls:0},
     pricingVersion:'2026.08-v2',updated:new Date().toISOString()};
   await fetch('/api/budget/BD-6009',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'BD-6009',name:doc.name,status:'Draft'},doc})});
 });
 await p.evaluate(()=>{FSHome.invalidate();return FSHome.show();});
 await p.waitForTimeout(900);

 // Measure each grid row on its own: cards that share a top edge.
 const rows=await p.evaluate(()=>{
   const round=n=>Math.round(n);
   return [...document.querySelectorAll('#page-home .hm-cards')].map(g=>{
     const cards=[...g.querySelectorAll('.hm-card')].map(c=>{
       const r=c.getBoundingClientRect();
       const m=c.querySelector('.hm-card-money').getBoundingClientRect();
       const f=c.querySelector('.hm-card-ft').getBoundingClientRect();
       // Real wrapped line boxes, not the height of the title area: the area
       // reserves two lines on purpose, so measuring it would say 2 always.
       const n=c.querySelector('.hm-card-name');
       const rg=document.createRange(); rg.selectNodeContents(n);
       const lines=rg.getClientRects().length;
       return {top:round(r.top),h:round(r.height),money:round(m.top),ft:round(f.top),lines,
               overflow:c.scrollWidth>c.clientWidth+1};
     });
     const by={};
     cards.forEach(c=>{(by[c.top]=by[c.top]||[]).push(c);});
     return Object.keys(by).map(k=>by[k]);
   }).reduce((a,b)=>a.concat(b),[]);
 });
 const uniq=(a,k)=>new Set(a.map(x=>x[k])).size;
 ok('cards in a row are the same height',
    rows.every(r=>uniq(r,'h')===1), JSON.stringify(rows.map(r=>r.map(c=>c.h))));
 ok('the metric row sits at the same height across a row',
    rows.every(r=>uniq(r,'money')===1), JSON.stringify(rows.map(r=>r.map(c=>c.money))));
 ok('the footer sits at the same height across a row',
    rows.every(r=>uniq(r,'ft')===1), JSON.stringify(rows.map(r=>r.map(c=>c.ft))));
 ok('a one-line and a multi-line title share a row, and still line up',
    rows.some(r=>r.length>1 && uniq(r,'lines')>1 && uniq(r,'ft')===1),
    JSON.stringify(rows.map(r=>r.map(c=>c.lines))));
 ok('no card overflows its own box', rows.every(r=>r.every(c=>!c.overflow)));

 // The favorited card: a star, and the same Updated · value every card shows.
 const pinCard=async()=>p.evaluate(()=>{
   const secs=[...document.querySelectorAll('#page-home .hm-sec')];
   const s=secs.find(x=>x.querySelector('.eyebrow').textContent.trim()==='Favorites');
   const c=s&&s.querySelector('.hm-card');
   if(!c) return null;
   const wrap=c.closest('.hm-card-wrap');
   const pin=wrap&&wrap.querySelector('.hm-star');
   const card=c.getBoundingClientRect();
   const id=c.querySelector('.hm-id').getBoundingClientRect();
   return {when:c.querySelector('.hm-when').textContent.trim(),
           hasPin:!!pin, tag:pin?pin.tagName:'', label:pin?pin.getAttribute('aria-label'):'',
           svg:!!(pin&&pin.querySelector('svg')),
           nested:!!(pin&&pin.closest('.hm-card')),
           fromRight:pin?Math.round(card.right-pin.getBoundingClientRect().right):-1,
           fromTop:pin?Math.round(pin.getBoundingClientRect().top-card.top):-1,
           overlaps:!!(pin&&pin.getBoundingClientRect().left<id.right)};
 });
 const pc=await pinCard();
 ok('a favorited card carries a filled star', !!pc && pc.hasPin && pc.svg, JSON.stringify(pc));
 ok('the star is a real button, not a button inside a button',
    !!pc && pc.tag==='BUTTON' && !pc.nested, JSON.stringify(pc&&{tag:pc.tag,nested:pc.nested}));
 // The star TOGGLES, so its label says which direction this click goes.
 ok('the star says what clicking it does',
    !!pc && /^Remove .+ from Favorites$/.test(pc.label||''), pc?pc.label:'none');
 ok('the star sits in the top right corner and clears the record id',
    !!pc && pc.fromRight>=4 && pc.fromRight<=14 && pc.fromTop>=4 && pc.fromTop<=14 && !pc.overlaps,
    JSON.stringify(pc));
 ok('the pinned card shows its real update time, not the word Pinned',
    !!pc && /^Updated · \S/.test(pc.when) && !/Pinned/.test(pc.when), pc?pc.when:'none');
 ok('no card anywhere puts Pinned where the timestamp goes',
    await p.evaluate(()=>[...document.querySelectorAll('#page-home .hm-when')]
      .every(w=>!/^Pinned$/.test(w.textContent.trim()))));
 // Clicking the star is the way back out: it un-favorites, says so, and the
 // section goes with it — while the record itself stays where it was.
 const recentBefore=await p.locator('#page-home .hm-card').count();
 await p.locator('#page-home .hm-sec .hm-star').first().click();
 await p.waitForTimeout(700);
 ok('clicking the star removes the favorite',
    !(await sections()).includes('Favorites'), JSON.stringify(await sections()));
 ok('and says so', /Removed from Favorites/i.test(await p.locator('#toast').textContent()),
    await p.locator('#toast').textContent());
 ok('un-favoriting does not delete anything — the record is still in Recent',
    (await p.locator('#page-home .hm-card').count())===recentBefore-1
    && /Riverside|Analysis/.test(await p.locator('#page-home').textContent()),
    (await p.locator('#page-home .hm-card').count())+' cards, was '+recentBefore);
 ok('the unpin reached the account, not just this browser',
    await p.evaluate(async()=>{
      await new Promise(r=>setTimeout(r,900));    // the settings save is debounced
      const j=await (await fetch('/api/user-settings')).json();
      const pin=(j.settings&&j.settings.pinned)||{budget:[],analysis:[]};
      return pin.budget.length===0 && pin.analysis.length===0;
    }),
    JSON.stringify(await p.evaluate(()=>FSHome._favorites())));
 // put it back for the checks that follow
 await p.evaluate(()=>{
   const a=(FSHome._recent(6)||[]).filter(x=>x.kind==='analysis')[0];
   if(a)FSHome.toggleFavorite('analysis',a.rec.analysisId);
 });
 await p.waitForTimeout(800);
 ok('the same record favorited and recent is marked in both places',
    await p.evaluate(()=>{
      // the star is a sibling of the card, inside the same wrapper
      return [...document.querySelectorAll('#page-home .hm-card-wrap')]
        .filter(w=>w.querySelector('.hm-star')).length>=1;
    }));

 // ---------- 12. narrow screens ----------
 await p.setViewportSize({width:390,height:900});
 await p.waitForTimeout(400);
 ok('cards do not overflow a phone-width screen',
    await p.evaluate(()=>[...document.querySelectorAll('#page-home .hm-card')]
      .every(c=>c.scrollWidth<=c.clientWidth+1)));
 ok('Home itself does not scroll sideways on a phone',
    await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),
    await p.evaluate(()=>document.documentElement.scrollWidth+' vs '+window.innerWidth));
 ok('the favorited card keeps its star and timestamp when narrow',
    await p.evaluate(()=>{
      const secs=[...document.querySelectorAll('#page-home .hm-sec')];
      const s=secs.find(x=>x.querySelector('.eyebrow').textContent.trim()==='Favorites');
      const w=s&&s.querySelector('.hm-card-wrap');
      return !!w && !!w.querySelector('.hm-star')
        && /^Updated · \S/.test(w.querySelector('.hm-when').textContent.trim());
    }));
 await p.setViewportSize({width:1400,height:1000});
 await p.waitForTimeout(300);

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
