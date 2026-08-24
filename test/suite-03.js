const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);
 // A budget belongs to a project, so the parent is made first and chosen in
 // step 2 of the dialog — a budget id can no longer imply one.
 await p.evaluate(async a=>{
   await fetch('/api/budget/'+a.p+'?scope=project',{method:'PUT',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,name:a.n,address:'1 Test Way'})});
 },{p:'OP-0301',n:'Print Test'});
 await p.click('button:has-text("+ New Budget")').then(()=>p.click('#newBudgetModal .tpl-row:has-text("Multifamily")'));
 await p.waitForTimeout(700);
 await p.selectOption('#nbProject','OP-0301');
 await p.fill('#nbId','TST-9999');
 await p.fill('#nbName','Print Test');
 await p.click('#nbCreate');
 await p.waitForTimeout(700);

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

 // ---- undo: Cmd/Ctrl+Z restores committed changes, up to five back
 await p.click('button:has-text("Expand All")'); await p.waitForTimeout(300);
 const lineIds0=await p.evaluate(()=>JSON.stringify(doc.lines.map(l=>l.lineId)));
 const rows0=await p.evaluate(()=>doc.lines.length);
 await p.locator('#budBody .btn-x').first().click(); await p.waitForTimeout(250);
 ok('a line item deletes', (await p.evaluate(()=>doc.lines.length))===rows0-1);
 await p.keyboard.press('Control+z'); await p.waitForTimeout(350);
 ok('Ctrl+Z restores the deleted line exactly',
    (await p.evaluate(()=>JSON.stringify(doc.lines.map(l=>l.lineId))))===lineIds0);
 // an edited rate reverts too
 const rate0=await p.evaluate(()=>doc.lines[0].unit);
 await p.evaluate(()=>{doc.lines[0].unit=123456;touch();});
 await p.keyboard.press('Control+z'); await p.waitForTimeout(350);
 ok('Ctrl+Z reverts an edited rate', (await p.evaluate(()=>doc.lines[0].unit))===rate0,
    String(await p.evaluate(()=>doc.lines[0].unit)));
 // ---- redo: Ctrl+Shift+Z / Ctrl+Y re-applies undone changes
 await p.locator('#budBody .btn-x').first().click(); await p.waitForTimeout(200);
 await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
 await p.keyboard.press('Control+Shift+z'); await p.waitForTimeout(300);
 ok('Ctrl+Shift+Z redoes the undone delete', (await p.evaluate(()=>doc.lines.length))===rows0-1);
 await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
 await p.keyboard.press('Control+y'); await p.waitForTimeout(300);
 ok('Ctrl+Y redoes too', (await p.evaluate(()=>doc.lines.length))===rows0-1);
 await p.keyboard.press('Control+z'); await p.waitForTimeout(300);   // back to rows0
 // a NEW change after an undo clears the redo path
 await p.locator('#budBody .btn-x').first().click(); await p.waitForTimeout(200);
 await p.keyboard.press('Control+y'); await p.waitForTimeout(250);
 ok('a new change forks history — redo is cleared', (await p.evaluate(()=>doc.lines.length))===rows0-1);
 await p.keyboard.press('Control+z'); await p.waitForTimeout(300);   // back to rows0
 // depth cap: twelve deletes, only ten undos recover
 for(let i=0;i<12;i++){await p.locator('#budBody .btn-x').first().click();await p.waitForTimeout(140);}
 for(let i=0;i<14;i++){await p.keyboard.press('Control+z');await p.waitForTimeout(170);}
 ok('undo depth is capped at ten changes', (await p.evaluate(()=>doc.lines.length))===rows0-2,
    (await p.evaluate(()=>doc.lines.length))+' vs '+rows0);
 // redo runs the other way, up to the same depth
 for(let i=0;i<3;i++){await p.keyboard.press('Control+Shift+z');await p.waitForTimeout(170);}
 ok('redo replays forward after a deep undo', (await p.evaluate(()=>doc.lines.length))===rows0-5,
    String(await p.evaluate(()=>doc.lines.length)));

 ok('no JS errors', errs.length===0, errs.join('|'));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
})();
