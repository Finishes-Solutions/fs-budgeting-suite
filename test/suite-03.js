const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);
 await p.click('button:has-text("+ New Multifamily Budget")');
 await p.fill('#pId','TST-9999'); await p.fill('#pName','Print Test');
 await p.click('button:has-text("Continue to Budget")'); await p.waitForTimeout(400);
 const full = await p.locator('#budBody tr').count();
 await p.click('button:has-text("Collapse All")'); await p.waitForTimeout(200);
 ok('collapsed on screen', (await p.locator('#budBody tr').count()) < full);

 // The report is composed from the data model, so a collapsed grid cannot truncate it.
 await p.evaluate(()=>{window.__rpt=null;window.print=()=>{window.__rpt=document.getElementById('printDoc').innerHTML;};});
 await p.click("#page-budget button:has-text(\"Export…\")");
 await p.click('button:has-text("PDF (Print)")');
 await p.waitForTimeout(300);
 const rpt=await p.evaluate(()=>window.__rpt||'');
 const lineCount=(rpt.match(/class="mono code"/g)||[]).length;
 ok('report carries every line despite the collapsed grid', lineCount>=100,
    lineCount+' coded lines in report vs 3 rows on screen');
 await p.waitForTimeout(700);
 ok('on-screen collapse state untouched by exporting', (await p.locator('#budBody tr').count()) < full);

 // print stylesheet must not clip the scroll container
 await p.emulateMedia({media:'print'});
 await p.waitForTimeout(200);
 const cs = await p.locator('.budget-scroll').evaluate(e=>{const s=getComputedStyle(e);return s.maxHeight+'|'+s.overflowY;});
 ok('print CSS unclips the budget grid', cs.startsWith('none'), cs);
 const th = await p.locator('.budget-scroll thead th').first().evaluate(e=>getComputedStyle(e).position);
 ok('print CSS unsticks the header', th === 'static', th);
 await p.emulateMedia({media:'screen'});

 // ---- charts: composed from the model, reconciling to it exactly
 // Mark one line edited first so the edited-flag toggle has something to show.
 await p.evaluate(()=>{doc.lines[0].unit+=1;touch();});
 await p.waitForTimeout(250);
 await p.click("#page-budget button:has-text(\"Export…\")");
 await p.click('button:has-text("PDF (Print)")');
 await p.waitForTimeout(300);
 const chartRpt=await p.evaluate(()=>window.__rpt||'');
 const cd=await p.evaluate(()=>{
   const d=document.createElement('div');d.innerHTML=window.__rpt;
   const q=x=>d.querySelector(x);
   const sum=(el,sel)=>el?[...el.querySelectorAll(sel)].reduce((s,r)=>s+ +r.dataset.v,0):-1;
   const b=q('svg[data-chart="buildup"]'),v=q('svg[data-chart="divisions"]'),r=q('svg[data-chart="revenue"]');
   const g=grossIncome();
   return {charts:d.querySelectorAll('svg[data-chart]').length,
     legends:d.querySelectorAll('.rpt-legend').length,
     buildComp:sum(b,'rect[data-comp]'), buildTotal:b?+b.dataset.total:-1,
     project:Math.round(parts().project),
     divParts:sum(v,'rect[data-part]'), contract:Math.round(csiSchedule().contract),
     softParts:sum(v,'rect[data-softpart]'), softTotal:Math.round(csiSchedule().softTotal),
     net:r?+r.dataset.net:-1, netCalc:Math.round(g.rentMo+g.netOtherMo)};
 });
 ok('report carries all three charts', cd.charts===3, cd.charts+' charts');
 ok('every chart has a legend', cd.legends===3, cd.legends+' legends');
 ok('build-up components sum to total project',
    Math.abs(cd.buildComp-cd.project)<=2 && Math.abs(cd.buildTotal-cd.project)<=2,
    cd.buildComp+' vs '+cd.project);
 ok('division bars sum to the contract sum', Math.abs(cd.divParts-cd.contract)<=2,
    cd.divParts+' vs '+cd.contract);
 ok('soft-cost bars sum to the soft total', Math.abs(cd.softParts-cd.softTotal)<=2,
    cd.softParts+' vs '+cd.softTotal);
 ok('revenue chart nets to the same NOI as the stats', Math.abs(cd.net-cd.netCalc)<=2,
    cd.net+' vs '+cd.netCalc);
 ok('edited flag shown when Show Edited Line Flags is on', chartRpt.includes('edited-mark'));
 await p.waitForTimeout(700);

 // ---- both toggles off: no charts, no edited flags
 await p.click("#page-budget button:has-text(\"Export…\")");
 await p.uncheck('#ex-charts'); await p.uncheck('#ex-edits');
 await p.click('button:has-text("PDF (Print)")');
 await p.waitForTimeout(300);
 const bare=await p.evaluate(()=>window.__rpt||'');
 ok('unchecking Charts & Graphs removes every chart', !bare.includes('data-chart'));
 ok('unchecking Show Edited Line Flags removes the edited badges', !bare.includes('edited-mark'));
 ok('the report tables are unaffected by the toggles',
    (bare.match(/class="mono code"/g)||[]).length>=100);
 await p.waitForTimeout(700);
 await p.click("#page-budget button:has-text(\"Export…\")");
 await p.check('#ex-charts'); await p.check('#ex-edits');   // leave defaults restored
 await p.click('#exportModal .btn-x');

 ok('no JS errors', errs.length===0, errs.join('|'));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
})();
