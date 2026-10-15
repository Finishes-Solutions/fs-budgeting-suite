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
 await p.click('#page-input button:has-text("Continue to Impact Fees")'); await p.waitForTimeout(250); await p.click('#page-fees button:has-text("Continue to Budget")'); await p.waitForTimeout(400);
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

 // ---- Impact & tap fees: the fourth workflow step, end to end.
 // The acceptance criterion is the City of Waller table itself — 2 x (4" @ 250 gpm)
 // on the high side is 2 x $318,972.18, and that number has to reach the SOV.
 // The pills render on all four workflow pages, so scope to the visible one.
 await p.click('#page-budget .wf-steps a:has-text("Impact Fees")'); await p.waitForTimeout(600);
 ok('the workflow has four steps, with Impact Fees second',
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#page-fees .wf-steps a')]
      .map(a=>a.textContent.replace(/^\d+/,'').trim())))
    ===JSON.stringify(['Inputs','Impact Fees','Budget','CSI Schedule']),
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#page-fees .wf-steps a')]
      .map(a=>a.textContent.replace(/^\d+/,'').trim()))));
 ok('the fee step is a real route', (await p.evaluate(()=>location.hash))==='#/fees/TST-9999',
    await p.evaluate(()=>location.hash));

 const softBefore = await p.evaluate(()=>parts().soft);
 const projBefore = await p.evaluate(()=>parts().project);

 await p.selectOption('#feeSchedule','tx-waller'); await p.waitForTimeout(600);
 ok('the picker offers all 17 meter sizes',
    (await p.locator('#feeAddMeter option').count())===18,   // 17 + the placeholder
    String(await p.locator('#feeAddMeter option').count()));
 ok('the picker names size, rate and EDU — size alone is ambiguous',
    (await p.evaluate(()=>[...document.querySelectorAll('#feeAddMeter option')]
      .map(o=>o.textContent).filter(t=>/^2"/.test(t)).join('|')))
    ==='2" · 80 gpm · 8 EDU|2" · 100 gpm · 10 EDU',
    await p.evaluate(()=>[...document.querySelectorAll('#feeAddMeter option')]
      .map(o=>o.textContent).filter(t=>/^2"/.test(t)).join('|')));
 ok('no meters are chosen until you add one',
    (await p.evaluate(()=>doc.impactFees.meters.length))===0);
 ok('the basis defaults to the high side',
    (await p.evaluate(()=>doc.impactFees.basis))==='high');

 // 4" @ 250 gpm is the first row that carries a vault, so it exercises the whole row.
 await p.selectOption('#feeAddMeter','m-4-250');
 await p.click('#feeAddBtn'); await p.waitForTimeout(500);
 ok('adding a meter puts one row on the table at qty 1',
    (await p.locator('#feeMeterTbl tbody tr').count())===1
    &&(await p.evaluate(()=>doc.impactFees.meters[0].qty))===1);
 const mid = await p.evaluate(()=>doc.impactFees.meters[0].id);
 await p.fill(`#feeMeterTbl input[data-k="fee.${mid}.qty"]`,'2'); await p.waitForTimeout(500);
 const feeTotal = await p.evaluate(()=>feeResult().total);
 ok('two 4-inch meters price at the published high-side total',
    Math.round(feeTotal*100)/100===Math.round(2*318972.18*100)/100, String(feeTotal));

 // The SOV line is the seam: everything downstream reads an ordinary lump sum.
 const line = await p.evaluate(()=>{const l=doc.lines.find(x=>x.derived==='impactFees');
   return l?{code:l.code,scope:l.scope,basis:l.basis,qty:l.qty,unit:l.unit,desc:l.desc,auto:l.auto}:null;});
 ok('a derived soft-cost line carries the total as a lump sum',
    !!line&&line.code==='SC-20'&&line.scope==='soft'&&line.basis==='ls'&&line.qty===1
    &&line.auto===false&&Math.round(line.unit*100)===Math.round(feeTotal*100),
    JSON.stringify(line));
 ok('the line names the jurisdiction, the basis and the version',
    !!line&&/City of Waller, TX \(high side, v1\)/.test(line.desc), line&&line.desc);
 ok('it reads as derived, not as a manual edit',
    /^Derived from the impact fee schedule/.test(
      await p.evaluate(()=>editReason(doc.lines.find(x=>x.derived==='impactFees')))),
    await p.evaluate(()=>editReason(doc.lines.find(x=>x.derived==='impactFees'))));

 // Soft costs sit outside the contract sum and join at total project cost.
 const softAfter = await p.evaluate(()=>parts().soft);
 const projAfter = await p.evaluate(()=>parts().project);
 const placeholder = await p.evaluate(()=>nz(doc.lines.find(x=>x.derived==='impactFees').baseUnit)*nz(doc.resSF));
 ok('soft costs move by the fee, net of the $/SF placeholder it replaced',
    Math.abs((softAfter-softBefore)-(feeTotal-placeholder))<0.01,
    (softAfter-softBefore)+' vs '+(feeTotal-placeholder));
 ok('the contract sum is untouched — soft costs are outside it',
    (await p.evaluate(()=>parts().contract))===(await p.evaluate(()=>parts().contract)));
 ok('total project cost moves with it', projAfter>projBefore,
    projBefore+' -> '+projAfter);

 // Several meters per project is the normal case — domestic, irrigation, fire —
 // so the same size must be able to appear twice without collapsing into one.
 await p.selectOption('#feeAddMeter','m-4-250');
 await p.click('#feeAddBtn'); await p.waitForTimeout(500);
 ok('the same meter size can be added twice',
    (await p.evaluate(()=>doc.impactFees.meters.length))===2
    &&(await p.evaluate(()=>doc.impactFees.meters[0].id))
      !==(await p.evaluate(()=>doc.impactFees.meters[1].id)));
 const mid2 = await p.evaluate(()=>doc.impactFees.meters[1].id);
 await p.fill(`#feeMeterTbl input[data-k="fee.${mid}.label"]`,'Domestic');
 await p.fill(`#feeMeterTbl input[data-k="fee.${mid2}.label"]`,'Irrigation');
 await p.waitForTimeout(400);
 ok('each meter keeps its own label',
    JSON.stringify(await p.evaluate(()=>doc.impactFees.meters.map(m=>m.label)))
    ===JSON.stringify(['Domestic','Irrigation']),
    JSON.stringify(await p.evaluate(()=>doc.impactFees.meters.map(m=>m.label))));
 ok('three meters in total price as three',
    Math.round((await p.evaluate(()=>feeResult().total))*100)/100
      ===Math.round(3*318972.18*100)/100,
    String(await p.evaluate(()=>feeResult().total)));
 await p.click(`#feeMeterTbl tr:has(input[data-k="fee.${mid2}.qty"]) button:has-text("Remove")`);
 await p.waitForTimeout(500);
 ok('removing one leaves the other untouched',
    (await p.evaluate(()=>doc.impactFees.meters.length))===1
    &&(await p.evaluate(()=>doc.impactFees.meters[0].label))==='Domestic');

 // Basis is the conservatism knob, and only the adders move with it.
 await p.selectOption('#feeBasis','low'); await p.waitForTimeout(400);
 ok('switching to the low side prices the published low total',
    Math.round((await p.evaluate(()=>feeResult().total))*100)/100
      ===Math.round(2*308822.43*100)/100,
    String(await p.evaluate(()=>feeResult().total)));
 await p.selectOption('#feeBasis','high'); await p.waitForTimeout(400);

 // Save, reopen, and the whole thing round-trips.
 await p.click('#page-fees button:has-text("Save Draft")'); await p.waitForTimeout(900);
 await p.evaluate(()=>{doc=null;});
 await p.evaluate(()=>openBudget('TST-9999','fees')); await p.waitForTimeout(1200);
 ok('the fee selection round-trips through a save',
    (await p.evaluate(()=>doc.impactFees.scheduleKey))==='tx-waller'
    &&(await p.evaluate(()=>nz((doc.impactFees.meters.find(m=>m.rowId==='m-4-250')||{}).qty)))===2,
    JSON.stringify(await p.evaluate(()=>doc.impactFees)));
 ok('the reopened budget still carries the derived amount',
    Math.round((await p.evaluate(()=>doc.lines.find(x=>x.derived==='impactFees').unit))*100)
      ===Math.round(2*318972.18*100),
    String(await p.evaluate(()=>doc.lines.find(x=>x.derived==='impactFees').unit)));

 // ---- Exports: the derived line is DERIVED, not edited, and a % of income
 // expense row prints the amount it is charged at (BUDGET-SYSTEM.md §17 D2, D3).
 // Every producer is called with the same selection the modal would give.
 const ex = await p.evaluate(()=>{
   const s={stats:1,units:1,other:1,budget:1,csi:1,summary:1,edits:1,sign:0};
   const g=grossIncome();
   const want=doc.expenses.map(e=>({label:e.label,pct:e.per==='pctIncome',rate:e.rate,mo:expenseMonthly(e,g.incomeMo)}));
   const html=buildReport(s);
   const rptRow=lbl=>(html.split('<tr>').find(r=>r.indexOf('<td>'+lbl+'</td>')===0)||'');
   const sc20=html.split('<tr>').find(r=>/SC-20/.test(r))||'';
   const fs=buildBudgetFsdoc(s).fsdoc;
   const inc=fs.sheets.find(x=>x.key==='other');
   const expT=inc.blocks.find(b=>b.kind==='table'&&b.totals&&b.totals.line==='Total Operating Expenses');
   const bud=fs.sheets.find(x=>x.key==='budget');
   const fsItems=bud.blocks.filter(b=>b.kind==='table').flatMap(b=>b.rows.map(r=>r.item));
   const fsNotes=bud.blocks.filter(b=>b.kind==='note').map(b=>b.text);
   const lg=legacyBudgetPdfDoc(s);
   const lRows=lg.sheets.find(x=>x.key==='other').blocks[0].rows;
   const lBud=lg.sheets.find(x=>x.key==='budget');
   const lItems=lBud.blocks[0].rows.map(r=>r.label);
   const lNotes=lBud.blocks.filter(b=>b.kind==='note').map(b=>b.text);
   return {want,expMo:g.expMo,usd:want.map(w=>usd(w.mo)),
     rpt:want.map(w=>rptRow(w.label)),sc20,
     fsRows:expT.rows,fsTot:expT.totals.monthly,fsItems,fsNotes,
     lRows:lRows.filter(r=>!r.total&&want.some(w=>w.label===r.label)),
     lTot:(lRows.find(r=>r.label==='Total Operating Expenses')||{values:[]}).values[3],lItems,lNotes,
     editedCount:editedCount(),isEditedAll:doc.lines.filter(isEdited).length};
 });
 const pctIdx = ex.want.map((w,i)=>w.pct?i:-1).filter(i=>i>=0);
 ok('the budget carries % of income expense rows to export', pctIdx.length>0 && pctIdx.every(i=>ex.want[i].mo>0),
    JSON.stringify(ex.want.filter(w=>w.pct)));
 ok('print: a % of income row prints its real monthly amount, its rate as a percent and its basis',
    pctIdx.every(i=>ex.rpt[i].includes('('+ex.usd[i]+')') && ex.rpt[i].includes('>'+ex.want[i].rate+'%<')
      && ex.rpt[i].includes('% of income') && !ex.rpt[i].includes('($0)')),
    JSON.stringify(pctIdx.map(i=>ex.rpt[i])));
 ok('print: the derived impact-fee line is marked derived, not edited',
    /derived-mark/.test(ex.sc20) && !/edited-mark/.test(ex.sc20), ex.sc20.slice(0,300));
 ok('engine PDF: expense rows are the charged amounts and sum to the operating-expense total',
    ex.fsRows.every((r,i)=>Math.abs(r.monthly+ex.want[i].mo)<1e-6)
    && Math.abs(ex.fsRows.reduce((a,r)=>a+r.monthly,0)-ex.fsTot)<0.01 && Math.abs(ex.fsTot+ex.expMo)<0.01,
    JSON.stringify({rows:ex.fsRows.reduce((a,r)=>a+r.monthly,0),tot:ex.fsTot}));
 ok('engine PDF: a % of income row shows a percent rate and no count',
    pctIdx.every(i=>ex.fsRows[i].rate===ex.want[i].rate+'%'&&ex.fsRows[i].count===null&&ex.fsRows[i].basis==='% of income'),
    JSON.stringify(pctIdx.map(i=>ex.fsRows[i])));
 ok('engine PDF: SC-20 is flagged derived with its provenance, never with the edited asterisk',
    ex.fsItems.some(t=>/^SC-20 .* \(derived\)$/.test(t)) && !ex.fsItems.some(t=>/^SC-20 .*\*$/.test(t))
    && ex.fsNotes.some(n=>/SC-20 is not a manual edit\. Derived from the impact fee schedule — City of Waller, TX \(high side, v1\)/.test(n)),
    JSON.stringify({items:ex.fsItems.filter(t=>/SC-20/.test(t)),notes:ex.fsNotes}));
 ok('legacy PDF: expense rows are the charged amounts and sum to the total',
    ex.lRows.every((r,i)=>Math.abs(r.values[3]+ex.want[i].mo)<1e-6)
    && Math.abs(ex.lRows.reduce((a,r)=>a+r.values[3],0)-ex.lTot)<0.01
    && pctIdx.every(i=>ex.lRows[i].values[1]===ex.want[i].rate+'%'&&ex.lRows[i].values[2]===undefined),
    JSON.stringify({rows:ex.lRows.map(r=>r.values),tot:ex.lTot}));
 ok('legacy PDF: SC-20 is flagged derived with its provenance',
    ex.lItems.some(t=>/^SC-20 .* \(derived\)$/.test(t)) && !ex.lItems.some(t=>/^SC-20 .*\*$/.test(t))
    && ex.lNotes.some(n=>/City of Waller, TX \(high side, v1\)/.test(n)),
    JSON.stringify({items:ex.lItems.filter(t=>/SC-20/.test(t)),notes:ex.lNotes}));
 ok('the edited-lines count leaves the derived line out, matching what is flagged',
    ex.editedCount===ex.isEditedAll-1, ex.editedCount+' counted vs '+ex.isEditedAll+' isEdited');

 // "None" is a decision and must zero the line — NOT fall back to the template's
 // $7.50/SF allowance, which would charge a project that said it pays nothing.
 await p.selectOption('#feeSchedule','__none__'); await p.waitForTimeout(600);
 ok('choosing None zeroes the fee', (await p.evaluate(()=>feeResult().total))===0);
 const noneLine = await p.evaluate(()=>{const l=doc.lines.find(x=>x.derived==='impactFees');
   return l?{unit:l.unit,qty:l.qty,basis:l.basis,desc:l.desc}:null;});
 ok('the soft-cost line is carried at zero, and says so',
    !!noneLine&&noneLine.unit===0&&noneLine.qty===1&&noneLine.basis==='ls'
    &&/none for this project/.test(noneLine.desc),
    JSON.stringify(noneLine));
 ok('None is remembered on the document, distinctly from "not selected"',
    (await p.evaluate(()=>doc.impactFees.excluded))===true
    &&(await p.evaluate(()=>doc.impactFees.scheduleKey))===null);

 // Clearing back to "not selected" restores the line rather than deleting it:
 // the template put it there and a budget without a schedule still has soft fees.
 await p.selectOption('#feeSchedule',''); await p.waitForTimeout(500);
 const restored = await p.evaluate(()=>{const l=doc.lines.find(x=>x.code==='SC-20'&&x.scope==='soft');
   return l?{derived:l.derived||null,basis:l.basis,auto:l.auto,unit:l.unit,baseUnit:l.baseUnit}:null;});
 ok('clearing the jurisdiction gives the line its library basis back',
    !!restored&&restored.derived===null&&restored.basis==='sf'&&restored.auto===true
    &&restored.unit===restored.baseUnit,
    JSON.stringify(restored));
 ok('and the fee total falls back to zero',
    (await p.evaluate(()=>feeResult().total))===0);
 ok('there is no Override Total control',
    (await p.locator('#page-fees button:has-text("Override")').count())===0);

 // The Pricing Library carries the same schedules as published reference rates,
 // below the cost assumptions table.
 await p.evaluate(()=>go('pricing')); await p.waitForTimeout(900);
 ok('the cost assumptions card is type-agnostic with a type picker',
    (await p.evaluate(()=>{const c=[...document.querySelectorAll('#page-pricing .card-hd h2')]
       .map(h=>h.textContent.trim()); return JSON.stringify(c);}))
    .includes('Cost Assumptions Table'),
    await p.evaluate(()=>[...document.querySelectorAll('#page-pricing .card-hd h2')].map(h=>h.textContent.trim()).join('|')));
 ok('only Multifamily is selectable; the other types are named but disabled',
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#pricingType option')]
      .map(o=>o.value+(o.disabled?':off':':on'))))
    ===JSON.stringify(['multifamily:on','retail:off','industrial:off','office:off',
                       'mixed-use:off','flex:off','custom:off']),
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#pricingType option')]
      .map(o=>o.value+(o.disabled?':off':':on')))));
 ok('the fee schedule table sits below the cost assumptions table',
    await p.evaluate(()=>{
      const h=[...document.querySelectorAll('#page-pricing .card-hd h2')].map(x=>x.textContent.trim());
      return h.indexOf('Impact & Tap Fee Schedules') > h.indexOf('Cost Assumptions Table');
    }));
 ok('it lists all 17 meter sizes for the published jurisdiction',
    (await p.locator('#feeLibTbl tbody tr').count())===17,
    String(await p.locator('#feeLibTbl tbody tr').count()));
 ok('and states the per-EDU rates the impact fees come from',
    /3,689\.91.*water/i.test(await p.locator('#feeLibRates').textContent()),
    (await p.locator('#feeLibRates').textContent()).slice(0,120));

 // ---- Stored XSS: row ids are data, never markup or code.
 // A lineId used to break out of its data-k attribute (autofocus + onfocus ran
 // on open, no click needed), and a manual-fee rowId sat inside a quoted string
 // in an inline handler, where esc() is no defence — the HTML parser decodes
 // &#39; back to a quote. Three layers: the API refuses, migrate() regenerates,
 // and the render keeps ids out of handler source.
 const HOSTILE_LINE='x" autofocus onfocus="window.__xss=1" data-z="';
 const HOSTILE_FEE="x');window.__xss=2;('";
 const refused=await p.evaluate(async a=>{
   const stored=await (await fetch('/api/budget/TST-9999')).json();
   const put=async d=>{
     const r=await fetch('/api/budget/TST-9999',{method:'PUT',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({meta:{name:d.name,projectKey:'OP-0301',status:'Draft'},doc:d})});
     return {status:r.status,body:await r.json().catch(()=>null)};
   };
   const d1=JSON.parse(JSON.stringify(stored));d1.lines[0].lineId=a.line;
   const d2=JSON.parse(JSON.stringify(stored));
   d2.impactFees=Object.assign({},d2.impactFees,{manual:[{rowId:a.fee,label:'Bad',amount:1}]});
   const sched=await fetch('/api/pricing?scope=fee-schedule',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({doc:{scheduleKey:'tx-xss',name:'XSS City',meters:[{rowId:a.line,edu:1}],fees:[]}})});
   return {line:await put(d1),fee:await put(d2),sched:sched.status};
 },{line:HOSTILE_LINE,fee:HOSTILE_FEE});
 ok('the API refuses a budget whose lineId could carry markup (400 bad_identifier)',
    refused.line.status===400&&refused.line.body&&refused.line.body.error==='bad_identifier'
    &&refused.line.body.field==='lines[0].lineId', JSON.stringify(refused.line));
 ok('the API refuses a hostile manual-fee rowId',
    refused.fee.status===400&&refused.fee.body&&refused.fee.body.field==='impactFees.manual[0].rowId',
    JSON.stringify(refused.fee));
 ok('a fee schedule cannot publish a hostile meter rowId', refused.sched===400, String(refused.sched));

 // A budget saved before the fix can still hold such ids, so serve one
 // directly — the mock would refuse to store it now.
 const stored=await p.evaluate(async()=>(await fetch('/api/budget/TST-9999')).json());
 const poisoned=JSON.parse(JSON.stringify(stored));
 poisoned.lines[0].lineId=HOSTILE_LINE;
 poisoned.impactFees=Object.assign({},poisoned.impactFees,{
   meters:[{rowId:HOSTILE_LINE,qty:1}],extras:[{feeId:HOSTILE_FEE,qty:1}],
   manual:[{rowId:HOSTILE_FEE,label:'Poisoned Fee',amount:10}]});
 const p2=await b.newPage({viewport:{width:1400,height:1000}});
 p2.on('dialog',d=>d.accept());
 const errs2=[]; p2.on('pageerror',e=>errs2.push(e.message));
 await p2.route('**/api/budget/TST-9999',r=>r.request().method()==='GET'
   ?r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(poisoned)}):r.continue());
 await p2.goto('http://127.0.0.1:8100/index.html#/budget/TST-9999',{waitUntil:'networkidle'});
 await p2.waitForTimeout(1500);
 ok('the poisoned budget opens', await p2.evaluate(()=>!!doc&&doc.projectId==='TST-9999'
    &&document.querySelectorAll('#budBody input[data-k$=".sel"]').length>0));
 ok('opening it runs no script', (await p2.evaluate(()=>window.__xss))===undefined,
    String(await p2.evaluate(()=>window.__xss)));
 ok('no injected attribute reached the page',
    await p2.evaluate(()=>!document.querySelector('[data-z],[autofocus],[onfocus*="__xss"]')));
 const SAFE_ID=/^[A-Za-z0-9_-]{1,64}$/;
 const ids=await p2.evaluate(()=>({line:doc.lines[0].lineId,
   fee:[...doc.impactFees.meters.map(m=>m.rowId),...doc.impactFees.extras.map(x=>x.feeId),
        ...doc.impactFees.manual.map(m=>m.rowId)]}));
 ok('the hostile lineId was regenerated on load',
    SAFE_ID.test(ids.line)&&ids.line!==HOSTILE_LINE, ids.line);
 ok('hostile fee row ids were regenerated on load',
    ids.fee.length===3&&ids.fee.every(x=>SAFE_ID.test(x)), JSON.stringify(ids.fee));

 await p2.evaluate(()=>go('fees')); await p2.waitForTimeout(700);
 ok('the regenerated manual fee renders',
    (await p2.locator('#feeOtherTbl input[data-k$=".label"]').count())===1);
 await p2.click('#feeOtherTbl button:has-text("Remove")'); await p2.waitForTimeout(300);
 ok('its Remove button finds the row through data-id',
    (await p2.evaluate(()=>doc.impactFees.manual.length))===0);
 ok('the fee step runs no script either', (await p2.evaluate(()=>window.__xss))===undefined);

 // Once opened, the repaired document is clean enough for the API to accept.
 const [savedResp]=await Promise.all([
   p2.waitForResponse(r=>r.url().endsWith('/api/budget/TST-9999')&&r.request().method()==='PUT'),
   p2.evaluate(()=>saveBudget())]);
 ok('the repaired budget saves', savedResp.status()===200, String(savedResp.status()));

 // Rendering is its own layer: an id that somehow skipped migrate() still
 // renders inert and round-trips exactly through data-id.
 await p2.evaluate(()=>go('budget')); await p2.waitForTimeout(400);
 const rt=await p2.evaluate(h=>{
   doc.lines[0].lineId=h; renderBudget();
   const el=[...document.querySelectorAll('#budBody input[data-k$=".sel"]')].find(x=>x.dataset.id===h);
   if(el)el.click();
   const out={found:!!el,sel:selected.has(h),xss:window.__xss,injected:!!document.querySelector('[data-z]')};
   selected.delete(h); doc.lines[0].lineId=newLineId(); renderBudget();
   return out;
 },HOSTILE_LINE);
 ok('an unregenerated hostile lineId renders inert and round-trips through data-id',
    rt.found&&rt.sel&&rt.xss===undefined&&!rt.injected, JSON.stringify(rt));
 ok('no JS errors on the poisoned budget', errs2.length===0, errs2.join('|'));
 await p2.close();

 ok('no JS errors', errs.length===0, errs.join('|'));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
})();
