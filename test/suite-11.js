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

 // ---- the badge follows the value: editing away hides it, reverting restores
 const nameBadge=p.locator('[data-origin="property.name"]');
 ok('badge visible while the value matches the import', await nameBadge.isVisible());
 const origName=await p.locator('[data-f="property.name"]').inputValue();
 await p.fill('[data-f="property.name"]','Changed Name');
 await p.locator('[data-f="property.name"]').dispatchEvent('change');
 await p.waitForTimeout(150);
 ok('editing an imported value removes its From Budget badge', !(await nameBadge.isVisible()));
 await p.fill('[data-f="property.name"]',origName);
 await p.locator('[data-f="property.name"]').dispatchEvent('change');
 await p.waitForTimeout(150);
 ok('restoring the imported value brings the badge back', await nameBadge.isVisible());

 // ---- the baseline survives persistence: the server stores the original
 // import in source.originalValues, so a field edited AND SAVED still knows
 // what the budget said after a full reload
 await p.fill('[data-f="property.purchaseMonth"]','2026-07');
 await p.locator('[data-f="property.purchaseMonth"]').dispatchEvent('change');
 await p.click('#invSteps button[data-step="3"]');
 await p.fill('[data-f="expenses.value"]','33');
 await p.locator('[data-f="expenses.value"]').dispatchEvent('change');
 await p.click('#invSteps button[data-step="5"]');
 await p.fill('[data-f="disposition.exitCapRate.value"]','7');
 await p.locator('[data-f="disposition.exitCapRate.value"]').dispatchEvent('change');
 await p.click('#invSteps button[data-step="1"]');
 await p.fill('[data-f="property.name"]','Changed Name');
 await p.locator('[data-f="property.name"]').dispatchEvent('change');
 await p.click('#invSaveBtn'); await p.waitForTimeout(900);
 await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(800);
 await p.click('#invSteps button[data-step="1"]'); await p.waitForTimeout(200);
 ok('after save + reload the edited field still shows no badge',
    !(await p.locator('[data-origin="property.name"]').isVisible()));
 await p.fill('[data-f="property.name"]',origName);
 await p.locator('[data-f="property.name"]').dispatchEvent('change');
 await p.waitForTimeout(150);
 ok('after reload, retyping the original import restores the badge',
    await p.locator('[data-origin="property.name"]').isVisible());

 // ---- inputs align across a grid row even when a label carries the badge
 await p.click('#invSteps button[data-step="2"]');
 const aBox=await p.locator('[data-f="income.year1PotentialIncome"]').boundingBox();
 const bBox=await p.locator('[data-f="income.growth.value"]').boundingBox();
 ok('income inputs align despite the From Budget badge', Math.abs(aBox.y-bBox.y)<2,
    JSON.stringify({a:aBox.y,b:bBox.y}));
 await p.click('#invSteps button[data-step="1"]');

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

 // ---- Home-page creation buttons, mirroring the budget buttons above them
 await p.click('#nav-home'); await p.waitForTimeout(600);
 ok('Home offers both analysis creation buttons',
    (await p.locator('#page-home button:has-text("+ New Investment Analysis")').count())===1
    && (await p.locator('#page-home button:has-text("+ Blank Investment Analysis")').count())===1);
 // title row above the card, exactly like Project Budgets
 ok('Investment Analyses heading and buttons sit above the list card',
    await p.evaluate(()=>{
      const hs=[...document.querySelectorAll('#page-home .page-title h1')].map(x=>x.textContent.trim());
      if(JSON.stringify(hs)!==JSON.stringify(['Project Budgets','Investment Analyses']))return false;
      const t=[...document.querySelectorAll('#page-home .page-title')][1];
      return !t.closest('.card')&&!!t.nextElementSibling&&t.nextElementSibling.classList.contains('card');
    }));
 const bBtn=await p.locator('#page-home button:has-text("+ New Multifamily Budget")').boundingBox();
 const iBtn=await p.locator('#page-home button:has-text("+ New Investment Analysis")').boundingBox();
 ok('creation buttons right-align across both sections',
    Math.abs((bBtn.x+bBtn.width)-(iBtn.x+iBtn.width))<2,
    JSON.stringify({budget:bBtn.x+bBtn.width,analysis:iBtn.x+iBtn.width}));
 await p.click('#page-home button:has-text("+ New Investment Analysis")');
 await p.waitForTimeout(400);
 ok('New Investment Analysis asks which project it is for',
    (await p.locator('#invProjectPick tbody tr',{hasText:'TST-9911'}).count())===1);
 await p.locator('#invProjectPick tbody tr',{hasText:'TST-9911'}).first().click();
 await p.waitForTimeout(900);
 ok('picking a project opens a linked analysis', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());
 const linked=await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   return await (await fetch('/api/investment-analysis/'+id)).json();});
 ok('the picked analysis is linked to the selected project',
    linked.source&&linked.source.projectId==='TST-9911', JSON.stringify(linked.source||null));
 await p.click('#nav-home'); await p.waitForTimeout(600);
 await p.click('#page-home button:has-text("+ Blank Investment Analysis")');
 await p.waitForTimeout(900);
 ok('Blank Investment Analysis opens a new editor directly', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());
 const blank=await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   return await (await fetch('/api/investment-analysis/'+id)).json();});
 ok('the blank analysis is unlinked and carries the placeholder name',
    !blank.source && blank.input.analysisName==='Untitled Analysis',
    JSON.stringify({source:blank.source,name:blank.input&&blank.input.analysisName}));

 // ---- analyses list search, status filter and grouping — like the budgets
 await p.click('#nav-analyses'); await p.waitForTimeout(700);
 ok('analyses list carries search, status and grouping controls',
    await p.evaluate(()=>!!document.querySelector('#page-analyses [data-inv-q]')
      &&!!document.querySelector('#page-analyses [data-inv-status]')
      &&!!document.querySelector('#page-analyses [data-inv-group]')));
 ok('count reads N of M analyses',
    /3 of 3 analyses/.test(await p.locator('#page-analyses [data-inv-count]').textContent()),
    await p.locator('#page-analyses [data-inv-count]').textContent());
 await p.fill('#page-analyses [data-inv-q]','untitled'); await p.waitForTimeout(200);
 ok('search narrows by analysis name',
    (await p.locator('#page-analyses [data-inv-list] tr').count())===1
    && /1 of 3/.test(await p.locator('#page-analyses [data-inv-count]').textContent()));
 await p.fill('#page-analyses [data-inv-q]','tst-9911'); await p.waitForTimeout(200);
 ok('search matches project IDs case-insensitively',
    (await p.locator('#page-analyses [data-inv-list] tr').count())===2);
 await p.fill('#page-analyses [data-inv-q]',''); await p.waitForTimeout(200);
 await p.selectOption('#page-analyses [data-inv-group]','project'); await p.waitForTimeout(250);
 ok('grouping by project splits linked from standalone, standalone last',
    await p.evaluate(()=>{
      const heads=[...document.querySelectorAll('#page-analyses tr.inv-grp')].map(t=>t.textContent.trim());
      return heads.length===2&&/^TST-9911/.test(heads[0])&&/^Standalone/.test(heads[1]);
    }),
    await p.evaluate(()=>[...document.querySelectorAll('#page-analyses tr.inv-grp')].map(t=>t.textContent.trim()).join('|')));
 ok('grouping shows every analysis exactly once',
    (await p.locator('#page-analyses [data-inv-list] tr:not(.inv-grp)').count())===3);
 await p.selectOption('#page-analyses [data-inv-group]',''); await p.waitForTimeout(200);
 await p.click('#nav-home'); await p.waitForTimeout(600);
 ok('the embedded Home list carries the same controls',
    await p.evaluate(()=>!!document.querySelector('#homeAnalyses [data-inv-q]')
      &&!!document.querySelector('#homeAnalyses [data-inv-group]')));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
