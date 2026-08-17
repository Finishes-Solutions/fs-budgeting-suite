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
 await p.click("#page-budget button:has-text(\"Export\")");
 // the one button order shared with the investment analysis export modal
 ok('budget export buttons are Email (Soon), Print, PDF, Excel (.xlsx) in order',
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#exportModal .btn')]
      .map(b=>b.textContent.trim().replace(/\s+/g,' '))))
    ===JSON.stringify(['Email Soon','Print','PDF','Excel (.xlsx)']),
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#exportModal .btn')]
      .map(b=>b.textContent.trim().replace(/\s+/g,' ')))));
 ok('edited-flags and signature both live under Options',
    await p.evaluate(()=>{
      const groups=[...document.querySelectorAll('#exportModal .eyebrow')];
      const opts=groups.find(g=>g.textContent==='Options');
      const grid=opts&&opts.nextElementSibling;
      return !!grid&&!!grid.querySelector('#ex-edits')&&!!grid.querySelector('#ex-sign');
    }));
 await p.click('button:has-text("Print")');
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

 // ---- edited flags: shown by default, removable with the export toggle
 // Mark one line edited first so the toggle has something to show.
 await p.evaluate(()=>{doc.lines[0].unit+=1;touch();});
 await p.waitForTimeout(250);
 await p.click("#page-budget button:has-text(\"Export\")");
 await p.click('button:has-text("Print")');
 await p.waitForTimeout(300);
 const flagged=await p.evaluate(()=>window.__rpt||'');
 ok('edited flag shown when Show Edited Line Flags is on', flagged.includes('edited-mark'));
 await p.waitForTimeout(700);

 // ---- toggle off: no edited flags
 await p.click("#page-budget button:has-text(\"Export\")");
 await p.uncheck('#ex-edits');
 await p.click('button:has-text("Print")');
 await p.waitForTimeout(300);
 const bare=await p.evaluate(()=>window.__rpt||'');
 ok('unchecking Show Edited Line Flags removes the edited badges', !bare.includes('edited-mark'));
 ok('the report tables are unaffected by the toggle',
    (bare.match(/class="mono code"/g)||[]).length>=100);
 await p.waitForTimeout(700);
 await p.click("#page-budget button:has-text(\"Export\")");
 await p.check('#ex-edits');   // leave the default restored
 await p.click('#exportModal .btn-x');

 // ---- Signature Needed: off by default, and when ticked the report ends
 // with an approval page identified to this exact budget.
 ok('no approval page unless Signature Needed is ticked', !/rpt-sig|Approval/.test(bare));
 await p.click("#page-budget button:has-text(\"Export\")");
 await p.check('#ex-sign');
 await p.click('button:has-text("Print")');
 await p.waitForTimeout(300);
 const signed=await p.evaluate(()=>window.__rpt||'');
 const sigPart=signed.split('rpt-sig')[1]||'';
 ok('Signature Needed appends the approval page',
    /Approval/.test(sigPart) && /accompanies is void/.test(sigPart)
    && /sig-cap">Signature</.test(sigPart) && /sig-cap">Date</.test(sigPart));
 ok('the approval page identifies this exact budget',
    /TST-9999/.test(sigPart) && /Print Test/.test(sigPart) && /Contract Sum/.test(sigPart)
    && /Total Project Cost/.test(sigPart));
 await p.waitForTimeout(700);
 await p.click("#page-budget button:has-text(\"Export\")");
 await p.uncheck('#ex-sign');   // leave the default restored
 await p.click('#exportModal .btn-x');

 // ---- real PDF download: the budget's PDF button renders the same document
 // through the shared renderer as a portrait-letter file.
 await p.evaluate(()=>{window.__dl=null;
   const orig=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(){window.__dl={href:this.href,name:this.download};};
   window.__restoreClick=()=>{HTMLAnchorElement.prototype.click=orig;};});
 await p.click("#page-budget button:has-text(\"Export\")");
 await p.click('#exportModal button:has-text("PDF")');
 await p.waitForFunction(()=>window.__dl,{timeout:15000});
 const pdfDl=await p.evaluate(async()=>{
   window.__restoreClick();
   const buf=await (await fetch(window.__dl.href)).arrayBuffer();
   const txt=new TextDecoder('latin1').decode(buf);
   return {name:window.__dl.name,len:buf.byteLength,
     head:txt.slice(0,5),portrait:/MediaBox\s*\[\s*0\s+0\s+612\s+792/.test(txt)};
 });
 ok('budget PDF button downloads a real PDF file', pdfDl.head==='%PDF-'&&pdfDl.len>20000,
    JSON.stringify({name:pdfDl.name,len:pdfDl.len}));
 ok('budget PDF is portrait letter', pdfDl.portrait);
 ok('budget PDF filename carries the project', /TST-9999.*\.pdf$/.test(pdfDl.name), pdfDl.name);

 ok('no JS errors', errs.length===0, errs.join('|'));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
})();
