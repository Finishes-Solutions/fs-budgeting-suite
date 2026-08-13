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

 ok('no JS errors', errs.length===0, errs.join('|'));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
})();
