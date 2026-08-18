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
 p.on('request',r=>{ if(r.url().includes('/api/analytics-activity')) filterReq.push(r.url()); });
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
   const wide=await (await fetch('/api/analytics-activity?limit=5&offset=0')).json();
   const none=await (await fetch('/api/analytics-activity?from=2099-01-01T00:00:00Z')).json();
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
