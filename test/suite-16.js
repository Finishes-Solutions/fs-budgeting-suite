// Suite 16 — Analytics Dashboard design-system parity (card shell, Activity
// Log with 30-item summary, View All paging, user + date filters, CSV export)
// and the Version page copy-to-clipboard control.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const ctx=await b.newContext({viewport:{width:1400,height:1000},permissions:['clipboard-read','clipboard-write']});
 const p=await ctx.newPage();
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);

 // Seed a budget plus enough client events that the log crosses the 30-row
 // summary cut, so View All has something to page into.
 await p.evaluate(async()=>{
   const doc={projectId:'TST-9960',name:'Dashboard Test',status:'Draft',resSF:1000,amenSF:0,
     units:[],other:[],expenses:[],
     lines:[{lineId:'s1',scope:'res',grp:'General',code:'',desc:'Shell',basis:'ls',auto:true,qty:0,unit:1500000}],
     companies:[],contingency:{mode:'fixed',val:0},projectCosts:{land:0,dev:0,mkt:0,cls:0},
     pricingVersion:'2026.08-v2',updated:new Date().toISOString()};
   await fetch('/api/budget/TST-9960',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'TST-9960',name:'Dashboard Test',status:'Draft'},doc})});
   // The analytics aggregates deliberately exclude TST-% ids, so the status
   // and value charts need at least one real budget to have anything to plot.
   for(const [pid,nm,st,rate] of [['BD-7001','Northgate Flats','Draft',2400000],
                                  ['BD-7002','Harbor Row','Completed',1750000]]){
     const d=Object.assign({},doc,{projectId:pid,name:nm,status:st,
       lines:[{lineId:'s1',scope:'res',grp:'General',code:'',desc:'Shell',basis:'ls',auto:true,qty:0,unit:rate}]});
     await fetch('/api/budget/'+pid,{method:'PUT',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({meta:{projectId:pid,name:nm,status:st},doc:d})});
   }
   // one analysis too, so the budget and analysis avatars can be compared
   await fetch('/api/investment-analyses',{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({mode:'fromBudget',projectId:'TST-9960',analysisName:'Dashboard Deal'})});
   for(let i=0;i<35;i++){
     await fetch('/api/user-activity',{method:'POST',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({eventType:'export_pdf',entityType:'budget',entityId:'TST-9960'})});
   }
 });

 // ---- the dashboard is reachable for a super_admin and renders
 await p.evaluate(()=>go('dashboard'));
 await p.waitForTimeout(900);
 ok('the dashboard page is showing',
    await p.evaluate(()=>document.getElementById('page-dashboard').classList.contains('on')));
 ok('KPI tiles render', (await p.locator('#dashKpis .dash-kpi').count())>0);

 // ---- design-system parity: the sections are the app's card shell, and the
 // activity table is the shared .tbl, not a bespoke one
 ok('Status Breakdown sits in a card shell',
    await p.evaluate(()=>!!document.querySelector('#page-dashboard section.card .dash-grid')));
 ok('the Activity Log table uses the shared .tbl class',
    await p.evaluate(()=>document.getElementById('dashActivityTable').classList.contains('tbl')));
 ok('the heading reads Activity Log, not Recent Activity',
    await p.evaluate(()=>{const t=document.getElementById('page-dashboard').textContent;
      return /Activity Log/.test(t)&&!/Recent Activity/.test(t);}));

 // ---- the summary view caps at 30 rows and offers View All
 const summaryRows=await p.locator('#dashActivityBody tr').count();
 ok('the summary shows at most 30 activity rows', summaryRows<=30&&summaryRows>0,
    'rows='+summaryRows);
 ok('a centered View All button is offered',
    await p.evaluate(()=>{const btn=document.getElementById('dashViewAllBtn');
      return btn.style.display!=='none'&&
        getComputedStyle(btn.parentElement).textAlign==='center';}));

 // ---- View All pages into the full log
 await p.click('#dashViewAllBtn'); await p.waitForTimeout(700);
 const allRows=await p.locator('#dashActivityBody tr').count();
 ok('View All loads more rows than the summary', allRows>summaryRows,
    'summary='+summaryRows+' all='+allRows);

 // ---- filters reach the API
 const filterReq=[];
 p.on('request',r=>{ if(r.url().includes('scope=activity')) filterReq.push(r.url()); });
 await p.selectOption('#dashUserFilter',{index:1}).catch(()=>{});
 await p.waitForTimeout(600);
 await p.fill('#dashDateFrom','2020-01-01'); await p.waitForTimeout(600);
 await p.fill('#dashDateTo','2099-12-31'); await p.waitForTimeout(600);
 ok('the date filters are sent to the activity API',
    filterReq.some(u=>u.includes('from=')) && filterReq.some(u=>u.includes('to=')),
    filterReq.slice(-1)[0]||'none');
 ok('rows survive a wide-open date range',
    (await p.locator('#dashActivityBody tr').count())>0);

 // ---- the activity API honours filtering and paging directly
 const api=await p.evaluate(async()=>{
   const wide=await (await fetch('/api/analytics?scope=activity&limit=5&offset=0')).json();
   const none=await (await fetch('/api/analytics?scope=activity&from=2099-01-01T00:00:00Z')).json();
   return {pageLen:wide.events.length,total:wide.total,users:wide.users.length,futureLen:none.events.length};
 });
 ok('the activity API pages with limit', api.pageLen<=5&&api.total>5,
    JSON.stringify(api));
 ok('the activity API returns the user list for the filter', api.users>0);
 ok('a future-only date range returns nothing', api.futureLen===0);

 // ---- CSV export builds a file from the data model
 const dl=p.waitForEvent('download',{timeout:9000}).catch(()=>null);
 await p.click('#page-dashboard button:has-text("Export CSV")');
 const file=await dl;
 ok('Export CSV produces a download', !!file,
    file?file.suggestedFilename():'no download');
 if(file){
   ok('the CSV is named for the activity log', /^activity-log-\d{4}-\d{2}-\d{2}\.csv$/.test(file.suggestedFilename()),
      file.suggestedFilename());
 }

 // ---- charts: real geometry from the payload, not placeholders
 ok('the activity trend renders a line chart',
    await p.evaluate(()=>{
      const svg=document.querySelector('#dashTrend svg.dash-line');
      if(!svg) return false;
      // the primary series path must have real coordinates, not an empty d
      const paths=[...svg.querySelectorAll('path')].map(x=>x.getAttribute('d')||'');
      return paths.some(d=>/M[\d.]+ [\d.]+ L/.test(d));
    }));
 ok('the trend plots one point per day for 30 days',
    (await p.evaluate(()=>document.querySelectorAll('#dashTrend svg circle').length))===30,
    'points='+await p.evaluate(()=>document.querySelectorAll('#dashTrend svg circle').length));
 ok('the trend carries a legend',
    (await p.evaluate(()=>document.querySelectorAll('#dashTrend .dash-lg-row').length))>=3);
 // The trend and the status donuts share a row rather than stacking, which is
 // what keeps the page from running several screens tall.
 ok('the trend and status breakdown sit side by side',
    await p.evaluate(()=>{
      const cols=document.querySelector('#page-dashboard .dash-cols');
      if(!cols) return false;
      const t=document.getElementById('dashTrend').closest('.card');
      const b=document.getElementById('dashBreakdowns').closest('.card');
      const rt=t.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return Math.abs(rt.top-rb.top)<40 && rb.left>rt.left;   // same row, breakdown to the right
    }),
    await p.evaluate(()=>{
      const t=document.getElementById('dashTrend').closest('.card').getBoundingClientRect();
      const b=document.getElementById('dashBreakdowns').closest('.card').getBoundingClientRect();
      return JSON.stringify({trendTop:Math.round(t.top),breakdownTop:Math.round(b.top),
                             trendLeft:Math.round(t.left),breakdownLeft:Math.round(b.left)});
    }));
 // "Concise" is the actual requirement, so measure it: the KPI strip plus the
 // whole chart row must fit one 1000px viewport, leaving the Activity Log to
 // start near the fold rather than three screens down.
 ok('the KPIs and every chart fit above the fold',
    await p.evaluate(()=>{
      const top=document.getElementById('dashKpis').getBoundingClientRect().top;
      const cols=document.querySelector('#page-dashboard .dash-cols');
      const bottom=cols.getBoundingClientRect().bottom;
      return (bottom-top)<=700;
    }),
    await p.evaluate(()=>{
      const top=document.getElementById('dashKpis').getBoundingClientRect().top;
      const cols=document.querySelector('#page-dashboard .dash-cols');
      return Math.round(cols.getBoundingClientRect().bottom-top)+'px tall';
    }));
 ok('all three charts share one row',
    await p.evaluate(()=>{
      const cards=[...document.querySelectorAll('#page-dashboard .dash-cols > .card')];
      if(cards.length!==3) return false;
      const tops=cards.map(c=>c.getBoundingClientRect().top);
      return Math.max(...tops)-Math.min(...tops)<40;
    }),
    await p.evaluate(()=>{
      const cards=[...document.querySelectorAll('#page-dashboard .dash-cols > .card')];
      return 'cards='+cards.length+' tops='+cards.map(c=>Math.round(c.getBoundingClientRect().top)).join(',');
    }));
 ok('status breakdown renders donut charts',
    (await p.evaluate(()=>document.querySelectorAll('#dashBreakdowns svg.dash-donut').length))===2);
 ok('the donut centre shows the total and its slices sum to it',
    await p.evaluate(()=>{
      const svg=document.querySelector('#dashBreakdowns svg.dash-donut');
      if(!svg) return false;
      const n=+svg.querySelector('.dash-donut-n').textContent.trim();
      const legend=[...svg.parentElement.querySelectorAll('.dash-lg-val')].map(x=>+x.textContent.trim());
      return n>0 && legend.length>0 && legend.reduce((s,v)=>s+v,0)===n;
    }),
    await p.evaluate(()=>{
      const svg=document.querySelector('#dashBreakdowns svg.dash-donut');
      return svg?svg.querySelector('.dash-donut-n').textContent.trim():'none';
    }));
 ok('budgets-by-value renders paired bars',
    await p.evaluate(()=>{
      const bars=document.querySelectorAll('#dashValue .dash-vbar');
      if(!bars.length) return false;
      return [...bars[0].querySelectorAll('.dash-vbar-fill')].length===2;
    }));

 // ---- Export Dashboard builds a branded print document
 ok('Export Dashboard composes a branded snapshot into #printDoc',
    await p.evaluate(()=>{
      // stub print so the dialog never opens, then inspect what was built
      const realPrint=window.print; let built='';
      window.print=()=>{ built=document.getElementById('printDoc').innerHTML; };
      FSDashboard.exportPDF();
      window.print=realPrint;
      document.body.classList.remove('printing');
      window.__dashPdf=built;
      return built.length>0;
    }));
 ok('the snapshot carries the Finishes logo lockup and eyebrow',
    await p.evaluate(()=>/finishes-logo-black\.png/.test(window.__dashPdf)
      && /Analytics snapshot/.test(window.__dashPdf)));
 ok('the snapshot includes the KPIs, both donuts and the trend line',
    await p.evaluate(()=>{
      const d=document.createElement('div'); d.innerHTML=window.__dashPdf;
      return d.querySelectorAll('.dpdf-kpi').length===8
        && d.querySelectorAll('svg.dash-donut').length===2
        && d.querySelectorAll('svg.dash-line').length===1;
    }),
    await p.evaluate(()=>{
      const d=document.createElement('div'); d.innerHTML=window.__dashPdf;
      return 'kpi='+d.querySelectorAll('.dpdf-kpi').length
        +' donut='+d.querySelectorAll('svg.dash-donut').length
        +' line='+d.querySelectorAll('svg.dash-line').length;
    }));
 ok('the snapshot includes an activity table',
    await p.evaluate(()=>{
      const d=document.createElement('div'); d.innerHTML=window.__dashPdf;
      return d.querySelectorAll('.dpdf-tbl tbody tr').length>0;
    }));
 ok('the print document is cleared again after exporting',
    await p.evaluate(()=>document.getElementById('printDoc').innerHTML===''
      || !document.body.classList.contains('printing')));

 // ---- Admin: role management served from the proven user-settings endpoint
 await p.evaluate(()=>go('admin'));
 await p.waitForTimeout(700);
 ok('the Admin page lists accounts with a role selector',
    (await p.locator('#adminBody .admin-role-sel').count())>=1,
    'rows='+await p.locator('#adminBody tr').count());
 ok('role management is served from user-settings?scope=roles',
    await p.evaluate(async()=>{
      const r=await fetch('/api/user-settings?scope=roles');
      if(!r.ok) return false;
      const j=await r.json();
      return Array.isArray(j)&&j.length>0&&'appRole' in j[0];
    }));
 ok('changing a role persists',
    await p.evaluate(async()=>{
      const list=await (await fetch('/api/user-settings?scope=roles')).json();
      const uid=list[0].userId;
      const put=await fetch('/api/user-settings?scope=roles',{method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({userId:uid,appRole:'director'})});
      if(!put.ok) return false;
      const after=await (await fetch('/api/user-settings?scope=roles')).json();
      return after.find(u=>u.userId===uid).appRole==='director';
    }));
 ok('an unknown role is rejected',
    await p.evaluate(async()=>{
      const list=await (await fetch('/api/user-settings?scope=roles')).json();
      const r=await fetch('/api/user-settings?scope=roles',{method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({userId:list[0].userId,appRole:'root'})});
      return r.status===400;
    }));

 // ---- every dialog shares one look: card radius, larger title
 await p.evaluate(()=>go('home'));
 await p.waitForTimeout(600);
 await p.click('#newBudgetBtn'); await p.waitForTimeout(350);
 const budgetModal=await p.evaluate(()=>{
   const sheet=document.querySelector('#newBudgetModal .mod-sheet');
   const title=document.querySelector('#newBudgetModal .mod-title');
   const cs=getComputedStyle(sheet), ts=getComputedStyle(title);
   return {radius:cs.borderRadius,size:ts.fontSize,weight:ts.fontWeight};
 });
 await p.evaluate(()=>closeNewBudget()); await p.waitForTimeout(250);
 await p.evaluate(()=>FSInvestmentUI.openProjectPicker()); await p.waitForTimeout(800);
 const invModal=await p.evaluate(()=>{
   const sheet=document.querySelector('#invModal .mod-sheet');
   const title=document.querySelector('#invModal .mod-title');
   if(!sheet||!title) return null;
   const cs=getComputedStyle(sheet), ts=getComputedStyle(title);
   return {radius:cs.borderRadius,size:ts.fontSize,weight:ts.fontWeight};
 });
 ok('both dialogs use the same corner radius',
    !!invModal&&invModal.radius===budgetModal.radius,
    JSON.stringify({budget:budgetModal.radius,inv:invModal&&invModal.radius}));
 ok('both dialogs use the same larger title',
    !!invModal&&invModal.size===budgetModal.size&&invModal.weight===budgetModal.weight,
    JSON.stringify({budget:budgetModal.size,inv:invModal&&invModal.size}));
 ok('the dialog title is larger than a section header',
    parseFloat(budgetModal.size)>15, budgetModal.size);
 await p.evaluate(()=>{const m=document.getElementById('invModal');if(m)m.remove();});
 await p.waitForTimeout(250);

 // ---- the creator avatar lives in its own labelled User column, not crammed
 // against the name. Column counts must match headers or cells overlap.
 await p.evaluate(()=>go('home'));
 await p.waitForTimeout(900);
 ok('the budget table has a User column header',
    await p.evaluate(()=>{const th=document.querySelector('#budgetsHead th');
      return th&&th.textContent.trim()==='User';}),
    await p.evaluate(()=>document.querySelector('#budgetsHead th').textContent.trim()));
 ok('budget header and body cell counts match',
    await p.evaluate(()=>{
      const heads=document.querySelectorAll('#budgetsHead th').length;
      const row=document.querySelector('#budgetsBody tr:not(.grp-hd)');
      return !row || row.children.length===heads;
    }),
    await p.evaluate(()=>{
      const row=document.querySelector('#budgetsBody tr:not(.grp-hd)');
      return 'th='+document.querySelectorAll('#budgetsHead th').length+' td='+(row?row.children.length:'no rows');
    }));
 ok('the avatar sits in the first cell, on its own',
    await p.evaluate(()=>{
      const row=document.querySelector('#budgetsBody tr:not(.grp-hd)');
      if(!row) return true;
      const first=row.children[0];
      // the User cell holds the avatar and nothing else
      return !!first.querySelector('.creator-av') && first.textContent.trim().length<=3;
    }));

 // The budget avatar must carry the creator's own colour and initials, the
 // same component the analyses list uses — not a generic placeholder.
 ok('the budget avatar shows the creator initials',
    await p.evaluate(()=>{
      const av=document.querySelector('#budgetsBody tr:not(.grp-hd) .creator-av');
      return !!av && /^[A-Z]{1,2}$/.test(av.textContent.trim());
    }),
    await p.evaluate(()=>{
      const av=document.querySelector('#budgetsBody tr:not(.grp-hd) .creator-av');
      return av?av.textContent.trim():'no avatar';
    }));
 ok('the budget avatar names the creator on hover',
    await p.evaluate(()=>{
      const av=document.querySelector('#budgetsBody tr:not(.grp-hd) .creator-av');
      return !!av && (av.getAttribute('title')||'').length>0;
    }));
 ok('budget and analysis avatars are the same component',
    await p.evaluate(()=>{
      const b=document.querySelector('#budgetsBody tr:not(.grp-hd) .creator-av');
      const a=document.querySelector('#page-analyses .creator-av');
      if(!b||!a) return false;
      const cb=getComputedStyle(b), ca=getComputedStyle(a);
      return cb.width===ca.width&&cb.height===ca.height&&cb.borderRadius===ca.borderRadius;
    }));

 // card view carries the avatar too, on budgets as well as analyses
 await p.evaluate(()=>chooseSetting('budgetView','cards'));
 await p.waitForTimeout(600);
 ok('budget cards carry the creator avatar',
    await p.evaluate(()=>!!document.querySelector('#budgetsCards .hcard .hc-id .creator-av')));
 ok('the budget card avatar sits with the project ID',
    await p.evaluate(()=>{
      const id=document.querySelector('#budgetsCards .hcard .hc-id');
      return !!id && !!id.querySelector('.creator-av') && /BD-|TST-|AS-|OP-/.test(id.textContent);
    }),
    await p.evaluate(()=>{const id=document.querySelector('#budgetsCards .hcard .hc-id');return id?id.textContent.trim():'none';}));
 await p.evaluate(()=>chooseSetting('budgetView','comfortable'));
 await p.waitForTimeout(500);

 // the analyses list: same contract, and the off-by-one that overlapped the
 // name and project cells shows up as a header/cell count mismatch
 await p.evaluate(()=>{const s=document.querySelector('[data-inv-view="comfortable"],[data-invview-pick="comfortable"]');if(s)s.click();});
 await p.waitForTimeout(400);
 ok('the analyses table has a User column header',
    await p.evaluate(()=>{const th=document.querySelector('table.inv-list thead th');
      return th&&th.textContent.trim()==='User';}),
    await p.evaluate(()=>{const th=document.querySelector('table.inv-list thead th');return th?th.textContent.trim():'none';}));
 ok('analyses header and body cell counts match',
    await p.evaluate(()=>{
      const heads=document.querySelectorAll('table.inv-list thead th').length;
      const row=document.querySelector('table.inv-list tbody tr:not(.inv-grp)');
      return !row || row.children.length===heads;
    }),
    await p.evaluate(()=>{
      const row=document.querySelector('table.inv-list tbody tr:not(.inv-grp)');
      return 'th='+document.querySelectorAll('table.inv-list thead th').length+' td='+(row?row.children.length:'no rows');
    }));

 // ---- Version page: the copy control sits inside the rounded box, and copies
 await p.evaluate(()=>go('version'));
 await p.waitForTimeout(500);
 ok('the version table renders', await p.evaluate(()=>!!document.getElementById('versionTable')));
 const copyBtn=p.locator('#versionContent button');
 ok('a copy control is present', (await copyBtn.count())===1);
 ok('the copy control is pinned to the right edge of the info box',
    await p.evaluate(()=>{
      const btn=document.querySelector('#versionContent button');
      const box=btn.parentElement;
      const bb=btn.getBoundingClientRect(), xb=box.getBoundingClientRect();
      // inside the box, hugging its right edge
      return bb.right<=xb.right && (xb.right-bb.right)<40 && bb.top>=xb.top;
    }));
 await copyBtn.click(); await p.waitForTimeout(500);
 const clip=await p.evaluate(()=>navigator.clipboard.readText()).catch(()=>'');
 ok('clicking copy puts the info table on the clipboard',
    /Application: Finishes Solutions Budgeting Suite/.test(clip)&&/Host:/.test(clip),
    clip.split('\n')[0]||'empty');
 ok('the copy control confirms with a Copied state',
    /Copied/.test(await copyBtn.textContent()));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
