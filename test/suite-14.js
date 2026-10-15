// Suite 14 — the table-only Excel workbook: six sheets, numeric cells that
// reconcile with the canonical result, provenance, and no chart objects.
// The generated blob is captured in-page and re-read with the same vendored
// ExcelJS build, so what is asserted is the actual file a user downloads.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html#/analyses',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);

 await p.click('#page-analyses button:has-text("+ New Investment Analysis")'); await p.waitForTimeout(400);
 await p.fill('#invNewName','Workbook Deal');
 await p.click('button:has-text("Create Standalone Analysis")');
 await p.waitForTimeout(700);
 await p.fill('[data-f="property.size.value"]','80000');
 await p.fill('[data-f="property.purchaseMonth"]','2026-05');
 await p.fill('[data-f="acquisition.basis.value"]','3000000');
 await p.click('#invSteps button[data-step="2"]');
 await p.fill('[data-f="income.year1PotentialIncome"]','420000');
 await p.click('#invSteps button[data-step="3"]');
 await p.fill('[data-f="expenses.value"]','32');
 await p.click('#invSteps button[data-step="4"]');
 await p.check('#invFinanced'); await p.waitForTimeout(300);
 await p.click('#invSteps button[data-step="5"]');
 await p.fill('[data-f="disposition.exitCapRate.value"]','6.8');
 await p.click('#invSaveBtn'); await p.waitForTimeout(900);
 ok('analysis saved for export', /Saved/.test(await p.locator('#invState').textContent()));

 // capture the download and re-open the workbook with the same ExcelJS build
 const wb=await p.evaluate(async()=>{
   let captured=null;
   const orig=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(){captured=this.href;};
   try{ await FSInvestmentUI.exportWorkbook(); }
   finally{ HTMLAnchorElement.prototype.click=orig; }
   if(!captured)return {error:'no download produced'};
   const buf=await (await fetch(captured)).arrayBuffer();
   const wb2=new ExcelJS.Workbook();
   await wb2.xlsx.load(buf);
   const sheets={};
   wb2.eachSheet(ws=>{
     const rows=[];
     ws.eachRow({includeEmpty:false},r=>{
       rows.push(r.values.slice(1).map(v=>v&&v.richText?v.richText.map(t=>t.text).join(''):v));
     });
     sheets[ws.name]=rows;
   });
   return {names:wb2.worksheets.map(w=>w.name),sheets,
     mediaCount:(wb2.model.media||[]).length,bytes:buf.byteLength};
 });
 ok('workbook produced', !wb.error, wb.error||'');
 ok('six sheets, in order', JSON.stringify(wb.names)===JSON.stringify(
    ['Investment Summary','Cash Flow','Debt and Sale','Returns','Acquisition Sensitivity','Assumptions']),
    JSON.stringify(wb.names));
 ok('no embedded media or chart images anywhere', wb.mediaCount===0, wb.mediaCount+' media parts');

 const saved=await p.evaluate(async()=>{
   const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   return await (await fetch('/api/investment-analysis/'+id)).json();
 });
 const A=saved.result.annual, S=saved.result.summary;
 const find=(sheet,label)=>{const r=(wb.sheets[sheet]||[]).find(x=>x[0]===label);return r?r.slice(1):null;};

 const noi=find('Cash Flow','Net Operating Income');
 ok('NOI row is numeric and reconciles with the canonical result',
    noi&&noi.every((v,i)=>typeof v==='number'&&Math.abs(v-A[i].netOperatingIncome)<0.01),
    JSON.stringify(noi));
 const cfbt=find('Cash Flow','Cash Flow Before Taxes');
 ok('CFBT row reconciles', cfbt&&cfbt.every((v,i)=>Math.abs(v-A[i].cashFlowBeforeTaxes)<0.01));
 const gsp=find('Debt and Sale','Gross Sale Price');
 ok('gross sale prices are the rounded thousands, as numbers',
    gsp&&gsp.every((v,i)=>v===A[i].grossSalePrice&&v%1000===0), JSON.stringify(gsp));
 const irr=find('Returns','Equity IRR');
 ok('equity IRR row is numeric fractions matching the result',
    irr&&irr.every((v,i)=>A[i].equityIRR===null?v===null:Math.abs(v-A[i].equityIRR)<1e-9));
 const price=find('Investment Summary','Purchase Price');
 ok('summary purchase price reconciles', price&&Math.abs(price[0]-S.purchasePrice)<0.01);
 const sens=find('Acquisition Sensitivity','Purchase Price');
 ok('sensitivity sheet carries the five scenario prices',
    sens&&sens.length===5&&sens.every(v=>typeof v==='number'));
 const eng=find('Assumptions','Calculation Version');
 ok('workbook records the calculation version', eng&&eng[0]==='before-tax-1.1.0', JSON.stringify(eng));
 const sv=find('Assumptions','Saved Analysis Version');
 ok('workbook records the saved analysis version', sv&&sv[0]===1);
 ok('every sheet opens with the brand band',
    wb.names.every(n=>wb.sheets[n][0]&&wb.sheets[n][0][0]==='FINISHES SOLUTIONS'),
    JSON.stringify(wb.names.map(n=>wb.sheets[n][0]&&wb.sheets[n][0][0])));
 ok('summary sheet carries the mortgage details like the PDF',
    find('Investment Summary','Monthly Payment')!==null
    && find('Investment Summary','Initial LTV')!==null);
 ok('sale sheet carries the loan payoff', (()=>{const lp=find('Debt and Sale','Loan Payoff');
    return lp&&lp.every((v,i)=>Math.abs(-v-A[i].endingLoanBalance)<0.01);})());
 ok('returns sheet notes the optimal holding period',
    wb.sheets['Returns'].some(r=>/Optimal holding period/.test(String(r[0]))));

 // ---- real PDF download: the modal's PDF button renders through the shared
 // document model + vendored pdfmake and saves an actual .pdf file.
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 ok('Export button opens the options modal with the highlight and signature choices',
    await p.locator('#invModal #inv-ex-highlight').count()===1
    && !(await p.locator('#invModal #inv-ex-highlight').isChecked())
    && await p.locator('#invModal #inv-ex-signature').count()===1
    && !(await p.locator('#invModal #inv-ex-signature').isChecked()));
 // centered on screen, like the budget's export modal (viewport 1400x1000)
 const mbb=await p.locator('#invModal > div').boundingBox();
 ok('export popup centers on screen',
    Math.abs((mbb.x+mbb.width/2)-700)<40 && Math.abs((mbb.y+mbb.height/2)-500)<40,
    JSON.stringify(mbb));
 // the one button order shared with the budget's export modal
 ok('modal buttons are Email (Soon), Print, PDF, Excel (.xlsx) in that order',
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#invModal .btn')]
      .map(b=>b.textContent.trim().replace(/\s+/g,' '))))
    ===JSON.stringify(['Email Soon','Print','PDF','Excel (.xlsx)']),
    JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('#invModal .btn')]
      .map(b=>b.textContent.trim().replace(/\s+/g,' ')))));
 await p.evaluate(()=>{window.__dl=null;
   const orig=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(){window.__dl={href:this.href,name:this.download};};
   window.__restoreClick=()=>{HTMLAnchorElement.prototype.click=orig;};});
 await p.click('#invModal button:has-text("PDF")');
 await p.waitForFunction(()=>window.__dl,{timeout:15000});
 const pdfDl=await p.evaluate(async()=>{
   window.__restoreClick();
   const buf=await (await fetch(window.__dl.href)).arrayBuffer();
   const txt=new TextDecoder('latin1').decode(buf);
   return {name:window.__dl.name,len:buf.byteLength,head:txt.slice(0,5),
     portrait:/MediaBox\s*\[\s*0\s+0\s+612\s+792/.test(txt),
     engineStamp:txt.indexOf('fs-render engine, fs-courier')>=0};
 });
 ok('PDF button downloads a real PDF file', pdfDl.head==='%PDF-'&&pdfDl.len>30000,
    JSON.stringify({name:pdfDl.name,len:pdfDl.len,head:pdfDl.head}));
 ok('PDF is portrait letter with the shared layout', pdfDl.portrait);
 ok('PDF metadata names the engine as its renderer', pdfDl.engineStamp, 'no fs-render creator stamp');
 ok('PDF filename carries the analysis name', /Workbook_Deal.*\.pdf$/.test(pdfDl.name), pdfDl.name);
 ok('export modal closes after the PDF download', (await p.locator('#invModal').count())===0);

 // ---- server-side rendering endpoint: the same shared renderer running in
 // the API returns real files for pdf, xlsx and csv.
 const srv=await p.evaluate(async()=>{
   const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   const pdfB=await (await fetch('/api/investment-analysis/'+id+'/export?format=pdf')).arrayBuffer();
   const csvR=await fetch('/api/investment-analysis/'+id+'/export?format=csv');
   const csv=await csvR.text();
   const xlsxB=await (await fetch('/api/investment-analysis/'+id+'/export?format=xlsx')).arrayBuffer();
   const wb3=new ExcelJS.Workbook(); await wb3.xlsx.load(xlsxB);
   const bad=await fetch('/api/investment-analysis/'+id+'/export?format=exe');
   return {pdfHead:String.fromCharCode.apply(null,new Uint8Array(pdfB.slice(0,5))),
     pdfLen:pdfB.byteLength,
     csvDisp:csvR.headers.get('content-disposition')||'',
     csvHasNOI:/Net Operating Income/.test(csv)&&/Calculated by engine/.test(csv),
     sheets:wb3.worksheets.map(w=>w.name),badStatus:bad.status};
 });
 ok('API renders a real PDF', srv.pdfHead==='%PDF-'&&srv.pdfLen>30000, JSON.stringify(srv.pdfLen));
 ok('API renders the six-sheet workbook', JSON.stringify(srv.sheets)===JSON.stringify(
    ['Investment Summary','Cash Flow','Debt and Sale','Returns','Acquisition Sensitivity','Assumptions']),
    JSON.stringify(srv.sheets));
 ok('API renders CSV with the tables and engine line', srv.csvHasNOI);
 ok('API export downloads as an attachment', /attachment/.test(srv.csvDisp), srv.csvDisp);
 ok('API rejects unknown formats', srv.badStatus===400, String(srv.badStatus));

 // ---- FS_EXPORT_RENDERER: the repair fallback. The config endpoint reports
 // the deployment default; ?renderer=local flips one API request to the
 // frozen legacy renderers; a localStorage override flips this browser.
 const swtch=await p.evaluate(async()=>{
   const cfg=await (await fetch('/api/export-config')).json();
   const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   const legPdf=await (await fetch('/api/investment-analysis/'+id+'/export?format=pdf&renderer=local')).arrayBuffer();
   const legCsv=await (await fetch('/api/investment-analysis/'+id+'/export?format=csv&renderer=local')).text();
   const bad=await fetch('/api/investment-analysis/'+id+'/export?format=pdf&renderer=fax');
   return {cfg:cfg.renderer,
     legHead:String.fromCharCode.apply(null,new Uint8Array(legPdf.slice(0,5))),
     legLen:legPdf.byteLength,legCsvOk:/Net Operating Income/.test(legCsv),badStatus:bad.status};
 });
 ok('config endpoint defaults to the engine renderer', swtch.cfg==='engine', swtch.cfg);
 ok('renderer=local renders a real PDF through the legacy fallback',
    swtch.legHead==='%PDF-'&&swtch.legLen>30000, JSON.stringify(swtch.legLen));
 ok('renderer=local CSV carries the tables', swtch.legCsvOk);
 ok('unknown renderer values are rejected', swtch.badStatus===400, String(swtch.badStatus));
 await p.evaluate(()=>{localStorage.setItem('fsExportRenderer','local');
   window.__dl=null;
   const orig=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(){window.__dl={href:this.href,name:this.download};};
   window.__restoreClick=()=>{HTMLAnchorElement.prototype.click=orig;};});
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 await p.click('#invModal button:has-text("PDF")');
 await p.waitForFunction(()=>window.__dl,{timeout:15000});
 const legDl=await p.evaluate(async()=>{
   window.__restoreClick();
   localStorage.removeItem('fsExportRenderer');   // restore the engine default
   const buf=await (await fetch(window.__dl.href)).arrayBuffer();
   const txt=new TextDecoder('latin1').decode(buf);
   return {head:txt.slice(0,5),len:buf.byteLength,
     portrait:/MediaBox\s*\[\s*0\s+0\s+612\s+792/.test(txt),
     legacyStamp:txt.indexOf('fs-budgeting-suite legacy renderer')>=0};
 });
 ok('localStorage override routes the PDF button through the legacy renderer',
    legDl.head==='%PDF-'&&legDl.len>30000&&legDl.portrait, JSON.stringify(legDl));
 ok('legacy PDF metadata names the legacy renderer', legDl.legacyStamp, 'no legacy creator stamp');

 // ---- Print: the original #printDoc pipeline, kept as the third option.
 await p.evaluate(()=>{window.__rpt=null;window.print=()=>{window.__rpt=document.getElementById('printDoc').innerHTML;};});
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 await p.click('#invModal button:has-text("Print")');
 await p.waitForTimeout(400);
 const pdf=await p.evaluate(()=>window.__rpt||'');
 ok('export modal closes after printing', (await p.locator('#invModal').count())===0);
 ok('Print produces a composed print document', pdf.length>2000, pdf.length+' chars');
 ok('print doc carries the branded KPI band', /rpt-stats/.test(pdf) && /Purchase Price/.test(pdf));
 const showsPdf=v=>pdf.includes('$'+Math.round(v).toLocaleString('en-US'));
 ok('print doc shows the canonical NOI and sale price',
    showsPdf(A[0].netOperatingIncome) && showsPdf(A[4].grossSalePrice));
 ok('print doc shows net proceeds and equity', showsPdf(A[4].netSaleProceeds) && showsPdf(S.initialEquity));
 ok('print doc carries provenance and engine version',
    /before-tax-1\.1\.0/.test(pdf) && /Analysis v1/.test(pdf));
 ok('print doc includes the sensitivity matrix', /Acquisition-Price Sensitivity/.test(pdf));
 ok('print doc has no charts or SVG', !/<svg|data-chart/.test(pdf));
 ok('highlight is off by default — no hl classes in the PDF', !/class="[^"]*\bhl\b/.test(pdf));
 ok('signature page absent by default', !/rpt-sig|Approval/.test(pdf));
 await p.waitForTimeout(700);
 ok('screen state untouched by printing', /Saved/.test(await p.locator('#invState').textContent()));

 // ---- Highlight Key Metrics: rerun the PDF with the option ticked — GOI,
 // NOI, purchase price, initial investment, equity multiple, CoC and IRR
 // rows carry the light green hl class.
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 await p.check('#inv-ex-highlight');
 await p.click('#invModal button:has-text("Print")');
 await p.waitForTimeout(400);
 const pdfH=await p.evaluate(()=>window.__rpt||'');
 // the downloaded PDF gets the same treatment: its docDefinition carries the
 // light green fill on highlighted rows (and no fills when highlight is off)
 const ddHl=await p.evaluate(async()=>{
   const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   const result=(await (await fetch('/api/investment-analysis/'+id)).json()).result;
   const dd=h=>JSON.stringify(fsRender.buildPdfDocDefinition(
     FSToFsdoc.toFsdoc(FSExportRender.buildExportDoc(
       result, {kpis:1,cash:1,sale:1,returns:1,sens:1,assumptions:1,highlight:h}, {})),
     fsRender.themes['finishes-solutions'], 'portrait'));
   return {on:/D8F3E0/.test(dd(true)),off:/D8F3E0/.test(dd(false))};
 });
 ok('downloaded PDF highlights rows only when the option is on', ddHl.on&&!ddHl.off, JSON.stringify(ddHl));
 const hlRow=l=>new RegExp('<tr class="[^"]*\\bhl\\b[^"]*"><td>'+l).test(pdfH);
 ok('highlighted PDF marks GOI and NOI', hlRow('Gross Operating Income')&&hlRow('Net Operating Income'));
 ok('highlighted PDF marks CoC, equity multiple and IRR rows',
    hlRow('Cash-on-Cash')&&hlRow('Equity Multiple')&&hlRow('Equity IRR')&&hlRow('Property IRR'));
 ok('highlighted PDF marks the purchase price and initial investment line items',
    /class="rr hl"><span>Purchase Price/.test(pdfH)
    && /class="[^"]*\bhl\b[^"]*"><span>Initial Equity Investment/.test(pdfH));
 ok('the KPI band at the top never highlights',
    !/rpt-stats[^]*?class="[^"]*\bhl\b/.test(pdfH.split('rpt-sec')[0]));
 ok('the on-screen report never carries the highlight',
    !/class="[^"]*\bhl\b/.test(await p.evaluate(()=>document.getElementById('invReport').innerHTML)));
 // ---- Signature Needed: the identified approval page on the printed report,
 // the downloaded PDF's docDefinition, and the API export.
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 ok('highlight choice is remembered in the modal', await p.locator('#inv-ex-highlight').isChecked());
 await p.check('#inv-ex-signature');
 await p.click('#invModal button:has-text("Print")');
 await p.waitForTimeout(400);
 const pdfS=await p.evaluate(()=>window.__rpt||'');
 ok('Signature Needed appends the approval page to the print',
    /rpt-sig/.test(pdfS) && /Approval/.test(pdfS) && /accompanies is void/.test(pdfS)
    && /sig-cap">Signature</.test(pdfS) && /sig-cap">Date</.test(pdfS));
 ok('the approval page identifies this exact analysis',
    /Workbook Deal/.test(pdfS.split('rpt-sig')[1]||'') && /v1/.test(pdfS.split('rpt-sig')[1]||''));
 const sigSrv=await p.evaluate(async()=>{
   const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   const withSig=(await (await fetch('/api/investment-analysis/'+id+'/export?format=pdf&signature=1')).arrayBuffer()).byteLength;
   const noSig=(await (await fetch('/api/investment-analysis/'+id+'/export?format=pdf')).arrayBuffer()).byteLength;
   return {withSig,noSig};
 });
 ok('API export honors signature=1 (approval page grows the PDF)', sigSrv.withSig>sigSrv.noSig,
    JSON.stringify(sigSrv));
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 ok('signature choice is remembered in the modal', await p.locator('#inv-ex-signature').isChecked());
 await p.click('#invModal .btn-x'); await p.waitForTimeout(150);

 // exporting with stale inputs is refused (both exports must match the inputs)
 await p.click('#invSteps button[data-step="2"]');
 await p.fill('[data-f="income.year1PotentialIncome"]','430000');
 await p.locator('[data-f="income.year1PotentialIncome"]').dispatchEvent('change');
 await p.waitForTimeout(200);
 ok('stale result disables the Export button', await p.evaluate(()=>document.getElementById('invExportBtn').disabled));

 // ---- The BUDGET workbook (exportExcel), re-read with the same ExcelJS build.
 // A budget priced from the template's expense schedule (two % of income rows)
 // with the impact-fee line derived from the City of Waller schedule.
 // BUDGET-SYSTEM.md §16 D2 (expense rows printed $0) and D3 (derived as edited).
 await p.evaluate(async()=>{
   await fetch('/api/budget/OP-1401?scope=project',{method:'PUT',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,name:'Workbook Budget',address:'1 Test Way'})});
 });
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);
 await p.click('button:has-text("+ New Budget")').then(()=>p.click('#newBudgetModal .tpl-row:has-text("Multifamily")'));
 await p.waitForTimeout(700);
 await p.selectOption('#nbProject','OP-1401');
 await p.fill('#nbId','TST-1401');
 await p.fill('#nbName','Workbook Budget');
 await p.click('#nbCreate'); await p.waitForTimeout(700);
 await p.click('#page-input button:has-text("Continue to Impact Fees")'); await p.waitForTimeout(400);
 await p.selectOption('#feeSchedule','tx-waller'); await p.waitForTimeout(600);
 await p.fill('#feeMeterTbl input[data-k="fee.m-4-250.qty"]','2'); await p.waitForTimeout(500);
 const bx=await p.evaluate(async()=>{
   let captured=null;
   const orig=HTMLAnchorElement.prototype.click;
   HTMLAnchorElement.prototype.click=function(){captured=this.href;};
   try{ await exportExcel(); }
   finally{ HTMLAnchorElement.prototype.click=orig; }
   if(!captured)return {error:'no download produced'};
   const wb2=new ExcelJS.Workbook();
   await wb2.xlsx.load(await (await fetch(captured)).arrayBuffer());
   const rows=name=>{const out=[];wb2.getWorksheet(name).eachRow({includeEmpty:false},r=>{
     out.push({v:r.values.slice(1),fmt:r.getCell(3).numFmt});});return out;};
   const g=grossIncome();
   return {ie:rows('Income & Expenses'),sov:rows('Budget-SOV').map(r=>r.v),
     want:doc.expenses.map(e=>({label:e.label,pct:e.per==='pctIncome',rate:e.rate,mo:expenseMonthly(e,g.incomeMo)})),
     expMo:g.expMo,feeLine:doc.lines.find(l=>l.derived==='impactFees')};
 });
 ok('budget workbook produced', !bx.error, bx.error||'');
 const ieRow=l=>(bx.ie||[]).find(r=>r.v[0]===l);
 const pctW=(bx.want||[]).filter(w=>w.pct);
 ok('budget carries % of income expense rows', pctW.length>0&&pctW.every(w=>w.mo>0), JSON.stringify(pctW));
 ok('Excel: a % of income row exports its real monthly and annual amount, as numbers',
    pctW.every(w=>{const r=ieRow(w.label);return r&&typeof r.v[4]==='number'&&typeof r.v[5]==='number'
      &&Math.abs(r.v[4]-w.mo)<1e-6&&Math.abs(r.v[5]-12*w.mo)<1e-6;}),
    JSON.stringify(pctW.map(w=>ieRow(w.label))));
 ok('Excel: its rate is a numeric percent cell, basis "% of income", no count',
    pctW.every(w=>{const r=ieRow(w.label);return r&&r.v[1]==='% of income'&&typeof r.v[2]==='number'
      &&Math.abs(r.v[2]-w.rate/100)<1e-9&&/%$/.test(r.fmt)&&(r.v[3]===undefined||r.v[3]===null);}),
    JSON.stringify(pctW.map(w=>ieRow(w.label))));
 const expRows=(bx.want||[]).map(w=>ieRow(w.label));
 const expTot=ieRow('Total Operating Expenses');
 ok('Excel: expense rows sum to the operating-expense total',
    expRows.every(Boolean)&&expTot
    &&Math.abs(expRows.reduce((a,r)=>a+r.v[4],0)-expTot.v[expTot.v.length-1])<0.01
    &&Math.abs(expTot.v[expTot.v.length-1]-bx.expMo)<0.01,
    JSON.stringify({rows:expRows.reduce((a,r)=>a+(r?r.v[4]:0),0),total:expTot&&expTot.v,expMo:bx.expMo}));
 // Budget-SOV columns: Code, Description, Basis, Qty, Rate, Total, Edited, Library Rate, Provenance
 const sc20=(bx.sov||[]).find(r=>r[0]==='SC-20');
 ok('Excel: the derived impact-fee line is "Derived", not "YES" edited',
    !!sc20&&sc20[6]==='Derived', JSON.stringify(sc20));
 ok('Excel: it carries no $/SF library rate, and its provenance names the schedule',
    !!sc20&&(sc20[7]===undefined||sc20[7]===null)
    &&/^Derived from the impact fee schedule — City of Waller, TX \(high side, v1\)$/.test(sc20[8]),
    JSON.stringify(sc20));
 ok('Excel: the derived line still totals the fee', !!sc20&&!!bx.feeLine
    &&Math.abs(sc20[5]-bx.feeLine.unit)<0.01&&Math.round(bx.feeLine.unit*100)===Math.round(2*318972.18*100),
    JSON.stringify(sc20));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
