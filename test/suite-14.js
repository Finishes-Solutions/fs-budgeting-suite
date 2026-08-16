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

 await p.fill('#invNewName','Workbook Deal');
 await p.click('button:has-text("+ New Standalone Analysis")');
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

 // ---- PDF (Print): reached through the Export… modal (like the budget),
 // composed from the canonical result into #printDoc. Tables only — no charts.
 await p.evaluate(()=>{window.__rpt=null;window.print=()=>{window.__rpt=document.getElementById('printDoc').innerHTML;};});
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 ok('Export button opens the options modal with the highlight choice',
    await p.locator('#invModal #inv-ex-highlight').count()===1
    && !(await p.locator('#invModal #inv-ex-highlight').isChecked()));
 await p.click('#invModal button:has-text("PDF (Print)")');
 await p.waitForTimeout(400);
 const pdf=await p.evaluate(()=>window.__rpt||'');
 ok('export modal closes after producing the PDF', (await p.locator('#invModal').count())===0);
 ok('PDF export produces a print document', pdf.length>2000, pdf.length+' chars');
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
 await p.waitForTimeout(700);
 ok('screen state untouched by printing', /Saved/.test(await p.locator('#invState').textContent()));

 // ---- Highlight Key Metrics: rerun the PDF with the option ticked — GOI,
 // NOI, purchase price, initial investment, equity multiple, CoC and IRR
 // rows carry the light green hl class.
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 await p.check('#inv-ex-highlight');
 await p.click('#invModal button:has-text("PDF (Print)")');
 await p.waitForTimeout(400);
 const pdfH=await p.evaluate(()=>window.__rpt||'');
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
 // the choice sticks for the next export from this page
 await p.click('#invExportBtn'); await p.waitForTimeout(200);
 ok('highlight choice is remembered in the modal', await p.locator('#inv-ex-highlight').isChecked());
 await p.click('#invModal .btn-x'); await p.waitForTimeout(150);

 // exporting with stale inputs is refused (both exports must match the inputs)
 await p.click('#invSteps button[data-step="2"]');
 await p.fill('[data-f="income.year1PotentialIncome"]','430000');
 await p.locator('[data-f="income.year1PotentialIncome"]').dispatchEvent('change');
 await p.waitForTimeout(200);
 ok('stale result disables the Export button', await p.evaluate(()=>document.getElementById('invExportBtn').disabled));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
