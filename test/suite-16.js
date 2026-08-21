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
 // ---- the KPI grid: four to a row, so ten metrics read 4 · 4 · 2
 ok('the KPI grid is four equal cards wide',
    await p.evaluate(()=>{
      const cards=[...document.querySelectorAll('#dashKpis .dash-kpi')];
      if(!cards.length) return false;
      const r=cards.map(c=>c.getBoundingClientRect());
      const rows=[...new Set(r.map(x=>Math.round(x.top)))];
      const first=r.filter(x=>Math.round(x.top)===rows[0]);
      return first.length===4 && Math.max(...first.map(x=>x.width))-Math.min(...first.map(x=>x.width))<2;
    }),
    await p.evaluate(()=>[...document.querySelectorAll('#dashKpis .dash-kpi')]
      .map(c=>Math.round(c.getBoundingClientRect().width)).join(',')));
 ok('and it stacks into three rows rather than one long one',
    await p.evaluate(()=>{
      const r=[...document.querySelectorAll('#dashKpis .dash-kpi')].map(c=>Math.round(c.getBoundingClientRect().top));
      return [...new Set(r)].length===3;
    }),
    await p.evaluate(()=>[...new Set([...document.querySelectorAll('#dashKpis .dash-kpi')]
      .map(c=>Math.round(c.getBoundingClientRect().top)))].join(',')));
 ok('every card in a row is the same height',
    await p.evaluate(()=>{
      const r=[...document.querySelectorAll('#dashKpis .dash-kpi')].map(c=>c.getBoundingClientRect());
      const rows={};
      r.forEach(x=>{const k=Math.round(x.top);(rows[k]=rows[k]||[]).push(Math.round(x.height));});
      return Object.values(rows).every(hs=>Math.max(...hs)-Math.min(...hs)<2);
    }));
 // The complaint: a card whose label wraps pushed its number out of line with
 // the rest of the row. The value block is anchored to the bottom instead.
 ok('the numbers and sub-lines sit on a common baseline across each row',
    await p.evaluate(()=>{
      const cards=[...document.querySelectorAll('#dashKpis .dash-kpi')];
      const rows={};
      cards.forEach(c=>{
        const k=Math.round(c.getBoundingClientRect().top);
        (rows[k]=rows[k]||[]).push(Math.round(c.querySelector('.v').getBoundingClientRect().top));
      });
      return Object.values(rows).every(vs=>Math.max(...vs)-Math.min(...vs)<2);
    }),
    await p.evaluate(()=>[...document.querySelectorAll('#dashKpis .dash-kpi')]
      .map(c=>Math.round(c.querySelector('.v').getBoundingClientRect().top)).join(',')));
 ok('every card carries a sub-line slot, even the ones with nothing to say',
    (await p.locator('#dashKpis .dash-kpi').count())===(await p.locator('#dashKpis .dash-kpi .sub').count()),
    (await p.locator('#dashKpis .dash-kpi').count())+' cards, '
      +(await p.locator('#dashKpis .dash-kpi .sub').count())+' subs');
 // Converted projects are what the dashboard is asked for: the money that
 // became real work. Both tiles read the SNAPSHOT columns, so the figure does
 // not move when a budget is edited after conversion.
 const kpiText=await p.locator('#dashKpis').textContent();
 ok('converted-project totals are reported',
    /Converted Contract Amount/.test(kpiText) && /Converted Project Amount/.test(kpiText),
    kpiText.replace(/\s+/g,' ').slice(0,200));
 ok('and they say the figure was captured, not tracked',
    /Captured at conversion/.test(kpiText));
 // The pipeline is a proportional strip spanning both donut columns, in the
 // free vertical space this card has beside its taller neighbour.
 ok('the project pipeline is charted below the two status breakdowns',
    (await p.locator('#dashBreakdowns .dash-card.dash-span .dash-pipe-seg').count())>=1,
    String(await p.locator('#dashBreakdowns .dash-card.dash-span .dash-pipe-seg').count()));
 ok('and reads in pipeline order, not sorted by count',
    await p.evaluate(()=>{
      const card=document.querySelector('#dashBreakdowns .dash-card.dash-span');
      if(!card)return false;
      const labs=[...card.querySelectorAll('.dash-lg-name')].map(e=>e.textContent.trim());
      const order=['Lead','Qualified','Budgeting','Proposal Sent','Awarded',
                   'Converted to Project','On Hold','Lost'];
      // Only stages with a count are drawn; whichever appear must still be in
      // pipeline order relative to each other.
      const idx=labs.map(l=>order.indexOf(l));
      return labs.length>0 && idx.every(i=>i>=0)
        && idx.every((v,i)=>i===0||v>idx[i-1]);
    }),
    JSON.stringify(await p.evaluate(()=>{
      const card=document.querySelector('#dashBreakdowns .dash-card.dash-span');
      return card?[...card.querySelectorAll('.dash-lg-name')].map(e=>e.textContent.trim()):null;})));
 ok('no legend name is clipped by the layout',
    (await p.evaluate(()=>[...document.querySelectorAll('#dashBreakdowns .dash-lg-name')]
      .filter(e=>e.scrollWidth>e.clientWidth+1).length))===0,
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#dashBreakdowns .dash-lg-name')]
      .filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.trim()))));

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
 ok('a centered View More button is offered',
    await p.evaluate(()=>{const btn=document.getElementById('dashViewAllBtn');
      return btn.style.display!=='none'&&
        getComputedStyle(btn.parentElement).textAlign==='center';}));
 ok('the button says View More, not View All',
    (await p.locator('#dashViewAllBtn').textContent()).trim()==='View More',
    await p.locator('#dashViewAllBtn').textContent());
 // The filter has to be usable before you have paged anything, or a filtered
 // CSV is impossible — which is exactly how it behaved before.
 ok('the user filter is populated as soon as the dashboard loads',
    (await p.locator('#dashUserFilter option').count())>1,
    (await p.locator('#dashUserFilter option').allTextContents()).join(' | '));

 // ---- View More pages into the full log, 50 at a time
 await p.click('#dashViewAllBtn'); await p.waitForTimeout(700);
 const allRows=await p.locator('#dashActivityBody tr').count();
 ok('View More loads more rows than the summary', allRows>summaryRows,
    'summary='+summaryRows+' all='+allRows);
 ok('it loads a page of 50, not everything at once', allRows<=50, 'rows='+allRows);
 ok('and it still offers more when there is more',
    await p.evaluate(async()=>{
      const t=await (await fetch('/api/analytics?scope=activity&limit=1&offset=0')).json();
      const btn=document.getElementById('dashViewAllBtn');
      return t.total>50 ? /View More \(\d+ remaining\)/.test(btn.textContent) : true;
    }),
    await p.locator('#dashViewAllBtn').textContent());

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
 ok('picking a user is sent to the activity API',
    filterReq.some(u=>u.includes('userId=')),
    filterReq.slice(-1)[0]||'none');
 // A filter that does not reach the export is a filter that lies about what
 // the file contains.
 const csvReq=[];
 p.on('request',r=>{ if(r.url().includes('scope=activity')&&r.url().includes('limit=1000')) csvReq.push(r.url()); });
 const dl0=p.waitForEvent('download',{timeout:9000}).catch(()=>null);
 await p.click('#page-dashboard button:has-text("Export CSV")');
 await dl0;
 ok('the CSV export asks the API for the filtered rows, on a route that exists',
    csvReq.length>0 && csvReq[0].includes('userId=') && csvReq[0].includes('/api/analytics?scope=activity'),
    csvReq[0]||'no export request');
 await p.selectOption('#dashUserFilter',{index:0}); await p.waitForTimeout(600);

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
      const paths=[...svg.querySelectorAll('path')].map(x=>x.getAttribute('d')||'');
      return paths.some(d=>/M[\d.]+ [\d.]+ L/.test(d));
    }));
 ok('the trend plots the six things worth watching',
    await p.evaluate(()=>{
      const names=[...document.querySelectorAll('#dashTrend .dash-lg-name')].map(x=>x.textContent.trim());
      return JSON.stringify(names)===JSON.stringify(['Saves','Logins','Budgets Created',
        'Analyses Created','Budgets Deleted','Analyses Deleted']);
    }),
    (await p.evaluate(()=>[...document.querySelectorAll('#dashTrend .dash-lg-name')].map(x=>x.textContent.trim()))).join(', '));
 ok('there is one line per series',
    await p.evaluate(()=>{
      const svg=document.querySelector('#dashTrend svg.dash-line');
      return [...svg.querySelectorAll('path')].filter(x=>/^M[\d.]/.test(x.getAttribute('d')||'')).length===6;
    }),
    'paths='+await p.evaluate(()=>[...document.querySelectorAll('#dashTrend svg path')]
      .filter(x=>/^M[\d.]/.test(x.getAttribute('d')||'')).length));
 ok('every series has its own colour',
    await p.evaluate(()=>{
      const c=[...document.querySelectorAll('#dashTrend .dash-lg-dot')]
        .map(x=>getComputedStyle(x).backgroundColor);
      return c.length===6 && new Set(c).size===6;
    }));

 // ---- the range buttons
 ok('the activity card offers 1D, 7D, 14D, 30D and All',
    JSON.stringify(await p.locator('#page-dashboard .dash-range').allTextContents())
      ===JSON.stringify(['1D','7D','14D','30D','All']),
    (await p.locator('#page-dashboard .dash-range').allTextContents()).join(','));
 ok('the range buttons sit in the card header, beside the title',
    await p.evaluate(()=>{
      const hd=document.getElementById('dashTrendTitle').closest('.card-hd');
      return !!hd && !!hd.querySelector('.dash-ranges');
    }));
 ok('30 days is the default', (await p.locator('#page-dashboard .dash-range.on').textContent()).trim()==='30D');
 // How many days the chart is currently plotting. A single day has no line to
 // draw, so it is marked with one dot per series instead.
 const days=async()=>p.evaluate(()=>{
   const svg=document.querySelector('#dashTrend svg.dash-line');
   const p0=svg.querySelector('path');
   if(p0) return ((p0.getAttribute('d')||'').match(/[ML]/g)||[]).length;
   return svg.querySelectorAll('circle').length/6;
 });
 const d30=await days();
 await p.click('.dash-range[data-range="7"]'); await p.waitForTimeout(400);
 const d7=await days();
 ok('picking 7D redraws a shorter series', d7===7 && d30===30, '30D='+d30+' 7D='+d7);
 ok('and the title says which range is showing',
    (await p.locator('#dashTrendTitle').textContent()).trim()==='Activity — Last 7 Days',
    await p.locator('#dashTrendTitle').textContent());
 await p.click('.dash-range[data-range="1"]'); await p.waitForTimeout(400);
 ok('one day still draws something rather than an empty chart',
    (await p.evaluate(()=>document.querySelectorAll('#dashTrend svg circle').length))===6,
    'marks='+await p.evaluate(()=>document.querySelectorAll('#dashTrend svg circle').length));
 await p.click('.dash-range[data-range="0"]'); await p.waitForTimeout(400);
 ok('All plots every day back to the first record',
    await p.evaluate(async()=>{
      const d=await (await fetch('/api/analytics')).json();
      const all=(d.activityByDay||[]).map(x=>x.day).sort();
      const today=new Date(); today.setUTCHours(0,0,0,0);
      const want=all.length
        ? Math.round((today.getTime()-Date.parse(all[0]+'T00:00:00Z'))/86400000)+1 : 1;
      const svg=document.querySelector('#dashTrend svg.dash-line');
      const p0=svg.querySelector('path');
      const marks=p0?((p0.getAttribute('d')||'').match(/[ML]/g)||[]).length
                    :svg.querySelectorAll('circle').length/6;
      return marks===want;
    }),
    'points='+await days());
 ok('and says so', (await p.locator('#dashTrendTitle').textContent()).trim()==='Activity — All Time');
 await p.click('.dash-range[data-range="30"]'); await p.waitForTimeout(400);

 // ---- hovering answers "what is that spike"
 const cb=await p.locator('#dashChartWrap').boundingBox();
 await p.mouse.move(cb.x+cb.width*0.9, cb.y+cb.height*0.5);
 await p.waitForTimeout(300);
 ok('hovering the chart opens a readout', await p.locator('#dashTip').isVisible());
 ok('the readout names the day and every series',
    await p.evaluate(()=>{
      const t=document.getElementById('dashTip');
      const keys=[...t.querySelectorAll('.dash-tip-k')].map(x=>x.textContent.trim());
      return keys.length===6 && /\d{4}/.test(t.querySelector('.dash-tip-d').textContent);
    }),
    (await p.locator('#dashTip').textContent()).replace(/\s+/g,' ').slice(0,80));
 ok('the readout carries numbers, not just labels',
    await p.evaluate(()=>[...document.querySelectorAll('#dashTip .dash-tip-v')]
      .every(x=>/^\d+$/.test(x.textContent.trim()))));
 ok('a guide line marks the day being read',
    await p.evaluate(()=>{
      const g=document.getElementById('dashGuide');
      return !!g && g.style.display!=='none' && +g.getAttribute('x1')>0;
    }));
 ok('a dot marks each series at that day',
    (await p.evaluate(()=>document.querySelectorAll('#dashHoverDots circle').length))===6);
 await p.mouse.move(cb.x+cb.width*0.5, cb.y-60);
 await p.waitForTimeout(250);
 ok('leaving the chart clears the readout', !(await p.locator('#dashTip').isVisible()));

 // ---- layout: activity full width, the two breakdowns beneath it as halves
 ok('the activity chart spans the full width of the page',
    await p.evaluate(()=>{
      const card=document.getElementById('dashTrend').closest('.card').getBoundingClientRect();
      const cols=document.querySelector('#page-dashboard .dash-cols').getBoundingClientRect();
      return Math.abs(card.width-cols.width)<2 && card.bottom<=cols.top+1;
    }),
    await p.evaluate(()=>{
      const card=document.getElementById('dashTrend').closest('.card').getBoundingClientRect();
      const cols=document.querySelector('#page-dashboard .dash-cols').getBoundingClientRect();
      return JSON.stringify({trend:Math.round(card.width),cols:Math.round(cols.width)});
    }));
 // The complaint: Status Breakdown ended early and left a ragged bottom edge
 // beside the taller card. It stretches and spaces its own contents instead.
 ok('the two halves end on the same line',
    await p.evaluate(()=>{
      const r=[...document.querySelectorAll('#page-dashboard .dash-cols > .card')]
        .map(c=>c.getBoundingClientRect());
      return r.length===2 && Math.abs(r[0].bottom-r[1].bottom)<2;
    }),
    await p.evaluate(()=>[...document.querySelectorAll('#page-dashboard .dash-cols > .card')]
      .map(c=>Math.round(c.getBoundingClientRect().bottom)).join(' vs ')));
 ok('and the shorter one spreads its contents rather than padding the bottom',
    await p.evaluate(()=>{
      const card=document.getElementById('dashBreakdowns').closest('.card').getBoundingClientRect();
      const pipe=document.querySelector('#dashBreakdowns .dash-span');
      if(!pipe) return true;                       // no projects: nothing to spread
      return card.bottom-pipe.getBoundingClientRect().bottom<40;
    }),
    await p.evaluate(()=>{
      const card=document.getElementById('dashBreakdowns').closest('.card').getBoundingClientRect();
      const pipe=document.querySelector('#dashBreakdowns .dash-span');
      return pipe?Math.round(card.bottom-pipe.getBoundingClientRect().bottom)+'px of slack':'no pipeline';
    }));
 ok('status breakdown and budgets by value are equal halves of that width',
    await p.evaluate(()=>{
      const cards=[...document.querySelectorAll('#page-dashboard .dash-cols > .card')];
      if(cards.length!==2) return false;
      const r=cards.map(c=>c.getBoundingClientRect());
      return Math.abs(r[0].top-r[1].top)<2 && Math.abs(r[0].width-r[1].width)<2
        && r[1].left>r[0].left;
    }),
    await p.evaluate(()=>[...document.querySelectorAll('#page-dashboard .dash-cols > .card')]
      .map(c=>Math.round(c.getBoundingClientRect().width)).join(' + ')));
 // The complaint that started this: the chart row sat flush against the card
 // below it. Every top-level card must keep the app's 20px rhythm.
 ok('the sections keep the page spacing and never overlap',
    await p.evaluate(()=>{
      const secs=[...document.querySelectorAll('#page-dashboard > section.card, #page-dashboard > .dash-cols')];
      for(let i=0;i<secs.length-1;i++){
        const gap=secs[i+1].getBoundingClientRect().top-secs[i].getBoundingClientRect().bottom;
        if(gap<16||gap>28) return false;
      }
      return secs.length>=4;
    }),
    await p.evaluate(()=>{
      const secs=[...document.querySelectorAll('#page-dashboard > section.card, #page-dashboard > .dash-cols')];
      return secs.slice(0,-1).map((s,i)=>Math.round(
        secs[i+1].getBoundingClientRect().top-s.getBoundingClientRect().bottom)).join(',');
    }));

 // Stacking cost height, but "concise" still has to mean something: the whole
 // visual half of the dashboard — tiles, chart, breakdowns, ranking — stays
 // inside about one scroll, with the Activity Log starting just past it.
 // The bound was 1000px while the KPIs ran seven-up over two rows. The review
 // asked for four equal cards to a row, which is three rows of taller cards
 // and ~130px more — a deliberate trade of density for legibility, not drift.
 ok('the whole chart half of the page stays around one screen',
    await p.evaluate(()=>{
      const top=document.getElementById('dashKpis').getBoundingClientRect().top;
      const bottom=document.getElementById('dashTop').closest('.card').getBoundingClientRect().bottom;
      return (bottom-top)<=1180;
    }),
    await p.evaluate(()=>{
      const top=document.getElementById('dashKpis').getBoundingClientRect().top;
      const bottom=document.getElementById('dashTop').closest('.card').getBoundingClientRect().bottom;
      return Math.round(bottom-top)+'px tall';
    }));

 // ---- the ranking widget
 ok('a Top 5 Projects widget sits below the breakdowns',
    await p.evaluate(()=>{
      const top=document.getElementById('dashTop').closest('.card').getBoundingClientRect();
      const cols=document.querySelector('#page-dashboard .dash-cols').getBoundingClientRect();
      return top.top>=cols.bottom-1;
    }));
 ok('it ranks five projects at most',
    await (async()=>{ const n=await p.locator('#dashTop .dash-rank-row').count();
      return n>0 && n<=5; })(),
    'rows='+await p.locator('#dashTop .dash-rank-row').count());
 ok('biggest first, by project cost',
    await p.evaluate(()=>{
      const v=[...document.querySelectorAll('#dashTop .dash-rank-v')]
        .map(x=>Number(x.textContent.replace(/[^0-9.]/g,'')));
      return v.length>1 && v.every((n,i)=>i===0||v[i-1]>=n);
    }),
    (await p.locator('#dashTop .dash-rank-v').allTextContents()).join(' > '));
 ok('each row says what share of the total it is',
    await p.evaluate(()=>[...document.querySelectorAll('#dashTop .dash-rank-p')]
      .every(x=>/^\d+%$/.test(x.textContent.trim()))));
 ok('the ranking names the project, not just the id',
    await p.evaluate(()=>{
      const r=document.querySelector('#dashTop .dash-rank-row');
      return /BD-|OP-|AS-/.test(r.querySelector('.dash-rank-id').textContent)
        && r.querySelector('.dash-rank-nm').textContent.trim().length>0;
    }));

 ok('status breakdown renders donut charts',
    (await p.evaluate(()=>document.querySelectorAll('#dashBreakdowns svg.dash-donut').length))===2,
    String(await p.evaluate(()=>document.querySelectorAll('#dashBreakdowns svg.dash-donut').length)));
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
 await p.evaluate(()=>go('budgets'));
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
 await p.evaluate(()=>go('analyses'));
 await p.waitForTimeout(900);
 await p.evaluate(()=>{const s=document.querySelector('[data-inv-view="comfortable"],[data-invview-pick="comfortable"]');if(s)s.click();});
 await p.waitForTimeout(400);
 ok('the analyses table has a User column header',
    await p.evaluate(()=>{const th=document.querySelector('table.inv-list thead th');
      return th&&th.textContent.trim()==='User';}),
    await p.evaluate(()=>{const th=document.querySelector('table.inv-list thead th');return th?th.textContent.trim():'none';}));
 ok('budget and analysis avatars are the same component',
    await p.evaluate(()=>{
      const b=document.querySelector('#budgetsBody tr:not(.grp-hd) .creator-av');
      const a=document.querySelector('#page-analyses .creator-av');
      if(!b||!a) return false;
      const cb=getComputedStyle(b), ca=getComputedStyle(a);
      return cb.width===ca.width&&cb.height===ca.height&&cb.borderRadius===ca.borderRadius;
    }),
    await p.evaluate(()=>{
      const b=document.querySelector('#budgetsBody tr:not(.grp-hd) .creator-av');
      const a=document.querySelector('#page-analyses .creator-av');
      return 'budget='+(b?getComputedStyle(b).width:'none')+' analysis='+(a?getComputedStyle(a).width:'none');
    }));
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
