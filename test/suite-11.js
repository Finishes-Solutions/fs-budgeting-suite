// Suite 11 — Create Investment Analysis from a budget: prefill values, field
// origins, import safeguards, and version pinning.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);

 // Seed a budget with known units / other income / service expenses via the API.
 await p.evaluate(async()=>{
   const doc={projectId:'TST-9911',name:'Import Source',address:'11 Origin Ave',
     resSF:50000,amenSF:0,siteSF:120000,
     units:[{label:'1BR',count:20,sf:700,rent:1500},{label:'2BR',count:5,sf:950,rent:2000}],
     other:[{label:'Parking',rate:50,auto:true,count:0},{label:'Signage',rate:200,auto:false,count:2}],
     expenses:[{label:'Trash',per:'unit',rate:10,auto:true,count:0},{label:'Internet',per:'fixed',rate:400,auto:false,count:1}],
     lines:[{lineId:'a1',scope:'res',grp:'G',code:'',desc:'Shell',basis:'ls',auto:true,qty:0,unit:4000000}],
     companies:[{name:'A',pct:5}],contingency:{mode:'fixed',val:0},
     projectCosts:{land:800000,dev:0,mkt:0,cls:0},updated:new Date().toISOString()};
   await fetch('/api/budget/TST-9911',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'TST-9911',name:'Import Source'},doc})});
 });

 await p.goto('http://127.0.0.1:8100/index.html#/budget/TST-9911',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);
 await p.click('button:has-text("Create Investment Analysis")');
 await p.waitForTimeout(900);
 ok('editor opens on a GUID route', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());

 const pre=await p.evaluate(()=>({
   pri:+document.querySelector('[data-f="income.year1PotentialIncome"]').value,
   price:+document.querySelector('[data-f="acquisition.basis.value"]').value,
   size:+document.querySelector('[data-f="property.size.value"]').value,
   units:+document.querySelector('[data-f="property.unitCount"]').value,
   month:document.querySelector('[data-f="property.purchaseMonth"]').value,
   exp:document.querySelector('[data-f="expenses.value"]').value,
   cap:document.querySelector('[data-f="disposition.exitCapRate.value"]').value,
   name:document.querySelector('[data-f="property.name"]').value,
   addr:document.querySelector('[data-f="property.address"]').value}));
 // gross scheduled rent: (20×1500 + 5×2000) × 12 = 480,000 — never the budget's net figure
 ok('Year-1 potential income = gross unit rent × 12', pre.pri===480000, String(pre.pri));
 // project cost: 4,000,000 + 5% profit + land 800,000 = 5,000,000
 ok('purchase price suggests total project cost', pre.price===5000000, String(pre.price));
 ok('size prefers Site SF when present', pre.size===120000, String(pre.size));
 ok('unit count imported', pre.units===25);
 ok('property name and address imported', pre.name==='Import Source'&&pre.addr==='11 Origin Ave');
 ok('purchase month is NOT invented', pre.month==='');
 ok('expense ratio is NOT prefilled from service expenses', pre.exp==='');
 ok('exit cap is NOT invented', pre.cap==='');

 // other income rows imported as annual suggestions: Parking 50×25×12=15,000 · Signage 200×2×12=4,800
 await p.click('#invSteps button[data-step="2"]');
 const other=await p.evaluate(()=>[...document.querySelectorAll('#invOtherRows tbody tr')].map(tr=>({
   label:tr.querySelector('input[type="text"]').value,
   amount:+tr.querySelector('input[type="number"]').value})));
 ok('other-income rows imported ×12 with labels',
    other.length===2&&other[0].label==='Parking'&&other[0].amount===15000
    &&other[1].label==='Signage'&&other[1].amount===4800, JSON.stringify(other));
 ok('unit-mix support table reconciles rent to income',
    /40,000\/mo scheduled rent × 12 = \$480,000/.test((await p.locator('#invUnitMix').textContent()).replace(/ /g,' ')),
    (await p.locator('#invUnitMix .inv-provenance').textContent()));

 // service expenses appear only as a warned partial reference: 10×25×12 + 400×12 = 7,800
 await p.click('#invSteps button[data-step="3"]');
 const expTxt=await p.locator('#invExpSupport').textContent();
 ok('service expenses shown as partial reference with warning',
    /partial/i.test(expTxt)&&/never applied automatically/i.test(expTxt)&&/7,800/.test(expTxt));

 // origin badges on imported fields
 await p.click('#invSteps button[data-step="1"]');
 ok('origin badges mark imported values', (await p.locator('.inv-origin').count())>=4,
    (await p.locator('.inv-origin').count())+' badges');

 // ---- version pinning: editing + saving the budget must NOT touch the analysis
 const aid=p.url().match(/analysis\/([0-9a-f-]{36})/)[1];
 await p.evaluate(async()=>{
   const d=await (await fetch('/api/budget/TST-9911')).json();
   d.lines[0].unit=9999999; d.updated=new Date().toISOString();
   await fetch('/api/budget/TST-9911',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'TST-9911',name:d.name},doc:d})});
 });
 const after=await p.evaluate(async id=>await (await fetch('/api/investment-analysis/'+id)).json(),aid);
 ok('analysis stays pinned to budget version 1 after the budget changes',
    after.source&&after.source.budgetVersionNumber===1,
    JSON.stringify(after.source));
 ok('analysis input unchanged by the budget edit',
    after.input.acquisition.basis.value===5000000);

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
