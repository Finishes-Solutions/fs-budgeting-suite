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

 // Creation happens through the shared New Investment Analysis modal — the
 // budget editor no longer carries its own creation button.
 await p.goto('http://127.0.0.1:8100/index.html#/budget/TST-9911',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);
 ok('the budget page carries no Create Investment Analysis button',
    (await p.locator('#page-budget button:has-text("Create Investment Analysis")').count())===0);
 await p.click('#nav-home'); await p.waitForTimeout(500);
 await p.click('#page-home button:has-text("+ New Investment Analysis")');
 await p.waitForTimeout(500);
 await p.locator('#invProjectPick tbody tr',{hasText:'TST-9911'}).first().click();
 await p.waitForTimeout(900);
 ok('editor opens on a GUID route', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());

 // Several of these fields now RENDER with a $, commas or a unit suffix. The
 // decoration is display only, so the suite strips it back off — and asserts
 // separately, below, that the decoration is actually there.
 const raw=s=>+String(s).replace(/[^0-9.-]/g,'');
 const pre=await p.evaluate(()=>({
   priTxt:document.querySelector('[data-f="income.year1PotentialIncome"]').value,
   priceTxt:document.querySelector('[data-f="acquisition.basis.value"]').value,
   sizeTxt:document.querySelector('[data-f="property.size.value"]').value,
   costPctTxt:document.querySelector('[data-f="acquisition.costPercent"]').value,
   growthTxt:document.querySelector('[data-f="income.growth.value"]').value,
   units:+document.querySelector('[data-f="property.unitCount"]').value,
   month:document.querySelector('[data-f="property.purchaseMonth"]').value,
   exp:document.querySelector('[data-f="expenses.value"]').value,
   cap:document.querySelector('[data-f="disposition.exitCapRate.value"]').value,
   name:document.querySelector('[data-f="property.name"]').value,
   addr:document.querySelector('[data-f="property.address"]').value}));
 pre.pri=raw(pre.priTxt); pre.price=raw(pre.priceTxt); pre.size=raw(pre.sizeTxt);
 // gross scheduled rent: (20×1500 + 5×2000) × 12 = 480,000 — never the budget's net figure
 ok('Year-1 potential income = gross unit rent × 12', pre.pri===480000, String(pre.pri));
 // project cost: 4,000,000 + 5% profit + land 800,000 = 5,000,000
 ok('purchase price suggests total project cost', pre.price===5000000, String(pre.price));
 // The BUILDING, never the site. doc.siteSF is land — importing it as property
 // size made every $/SF figure a price per square foot of dirt.
 ok('size is the building, not the site', pre.size===50000, String(pre.size));
 ok('and the site area is carried separately as land',
    (await p.evaluate(()=>FSInvestmentUI._state?FSInvestmentUI._state().input.source.support.landSquareFeet:null))===120000
      || (await p.evaluate(async()=>{
           const r=await fetch('/api/investment-analysis/'+location.hash.split('/').pop());
           const j=await r.json();
           return j.input.source.support.landSquareFeet;})) ===120000);
 ok('unit count imported', pre.units===25);
 ok('property name and address imported', pre.name==='Import Source'&&pre.addr==='11 Origin Ave');
 // A new analysis opens in the month it was created — the common answer, and
 // one step 1 can change. It is set at CREATION, never written over a saved one.
 ok('purchase month defaults to the current month',
    pre.month===new Date().toISOString().slice(0,7), pre.month);

 // ---- the review's number formatting: decoration on screen, numbers underneath
 ok('purchase price reads as money', /^\$5,000,000$/.test(pre.priceTxt), pre.priceTxt);
 ok('size value carries commas and its unit', /^50,000 SF$/.test(pre.sizeTxt), pre.sizeTxt);
 ok('acquisition costs read as 0.00%', /^\d+\.\d{2}%$/.test(pre.costPctTxt), pre.costPctTxt);
 ok('year-1 potential income reads as money', /^\$480,000$/.test(pre.priTxt), pre.priTxt);
 ok('income growth reads as 0.00%', /^\d+\.\d{2}%$/.test(pre.growthTxt), pre.growthTxt);
 ok('and the stored values are still plain numbers',
    await p.evaluate(async()=>{
      const j=await (await fetch('/api/investment-analysis/'+location.hash.split('/').pop())).json();
      return typeof j.input.acquisition.basis.value==='number'
        && typeof j.input.property.size.value==='number'
        && typeof j.input.acquisition.costPercent==='number';}));

 // ---- budget-derived fields are locked until the card's menu says otherwise
 ok('imported property fields are read-only by default',
    await p.evaluate(()=>['property.name','property.address','property.size.value','acquisition.basis.value']
      .every(f=>document.querySelector('[data-f="'+f+'"]').hasAttribute('readonly'))));
 ok('and the fields that are the user\u2019s stay editable',
    await p.evaluate(()=>!document.querySelector('[data-f="acquisition.costPercent"]').hasAttribute('readonly')
      && !document.querySelector('[data-f="property.purchaseMonth"]').hasAttribute('readonly')));
 // Derived from the budget against GOI — 7,800 OPEX ÷ (499,800 × 0.9) = 1.73%.
 // Visibly low, which is exactly what the 35–55% guard rail exists to catch;
 // the number is reported honestly rather than invented.
 ok('expense ratio is derived from the budget', pre.exp==='1.73', pre.exp);
 ok('and the field is locked until overridden',
    await p.evaluate(()=>document.querySelector('[data-f="expenses.value"]').hasAttribute('readonly')));
 ok('badged as coming from the budget',
    /From Budget/.test(await p.locator('#invExpLab').textContent()),
    await p.locator('#invExpLab').textContent());
 ok('exit cap is NOT invented', pre.cap==='');

 // other income rows imported as annual suggestions: Parking 50×25×12=15,000 · Signage 200×2×12=4,800
 await p.click('#invSteps button[data-step="2"]');
 const other=await p.evaluate(()=>[...document.querySelectorAll('#invOtherRows tbody tr')].map(tr=>{
   const ins=[...tr.querySelectorAll('input')];
   return {label:ins[0].value, amount:+String(ins[1].value).replace(/[^0-9.-]/g,''),
           lockedLabel:ins[0].hasAttribute('readonly'), lockedAmount:ins[1].hasAttribute('readonly'),
           growthEditable:!ins[2].hasAttribute('readonly')};
 }));
 ok('other-income rows imported ×12 with labels',
    other.length===2&&other[0].label==='Parking'&&other[0].amount===15000
    &&other[1].label==='Signage'&&other[1].amount===4800, JSON.stringify(other));
 // Budget-derived other income is the budget's to state; only the growth rate
 // is the underwriter's, so the lock covers labels, amounts, Add and Remove.
 ok('imported other-income rows are read-only except their growth rate',
    other.every(r=>r.lockedLabel&&r.lockedAmount&&r.growthEditable), JSON.stringify(other));
 ok('and there is no Add Other Income while they come from the budget',
    (await p.locator('#page-analysis button:has-text("+ Add Other Income")').count())===0);
 ok('nor a per-row remove button',
    (await p.locator('#invOtherRows .btn-x').count())===0);

 // ---- the Unit & Other Income summary, after the reconciliation
 const sumTxt=(await p.locator('#invIncomeSummary').textContent()).replace(/\u00a0/g,' ');
 ok('a Unit & Other Income table shows how the total is built',
    /Unit Income/.test(sumTxt)&&/Other Income/.test(sumTxt)&&/Total Income/.test(sumTxt), sumTxt.slice(0,120));
 ok('and its total is unit income plus other income',
    /\$480,000/.test(sumTxt)&&/\$19,800/.test(sumTxt)&&/\$499,800/.test(sumTxt), sumTxt.slice(0,200));
 ok('unit-mix support table reconciles rent to income',
    /40,000\/mo scheduled rent × 12 = \$480,000/.test((await p.locator('#invUnitMix').textContent()).replace(/ /g,' ')),
    (await p.locator('#invUnitMix .inv-provenance').textContent()));

 // service expenses appear only as a warned partial reference: 10×25×12 + 400×12 = 7,800
 await p.click('#invSteps button[data-step="3"]');
 const expTxt=await p.locator('#invExpSupport').textContent();
 ok('budget expenses shown with their total',
    /partial/i.test(expTxt)&&/7,800/.test(expTxt), expTxt.slice(0,120));
 ok('and the derived ratio shows the arithmetic it came from',
    // GOI = rent × (1 − vacancy) + other income, as the engine computes it:
    // 480,000 × 0.9 + 19,800 = 451,800 (vacancy on rent only — BUDGET-SYSTEM.md §15).
    /451,800/.test(await p.locator('#invExpDerived').textContent())
      && /rent less 10\.0% vacancy, plus \$19,800 other income/.test(await p.locator('#invExpDerived').textContent()),
    await p.locator('#invExpDerived').textContent());
 ok('with the source budget flagged as outside the guard rail',
    /guard rail/i.test(await p.locator('#invExpDerived').textContent()));

 // Vacancy, Expense Mode and the ratio share one row, aligned on their inputs.
 const vBox=await p.locator('[data-f="vacancy.value"]').boundingBox();
 const mBox=await p.locator('[data-f="expenses.mode"]').boundingBox();
 const eBox=await p.locator('[data-f="expenses.value"]').boundingBox();
 // A select renders a couple of pixels taller than a text input, so the row is
 // aligned on the BOTTOM edge — which is what .inv-grid .fld does.
 const bot=b2=>b2.y+b2.height;
 ok('vacancy, expense mode and the ratio sit on one aligned row',
    Math.abs(bot(vBox)-bot(mBox))<2&&Math.abs(bot(vBox)-bot(eBox))<2,
    JSON.stringify({v:bot(vBox),m:bot(mBox),e:bot(eBox)}));
 ok('the expense total row is named and bold',
    await p.evaluate(()=>{
      const tr=[...document.querySelectorAll('#invExpSupport tr.tot')][0];
      return !!tr && /Total Operating Expenses/.test(tr.textContent)
        && tr.querySelectorAll('b').length===2;}));

 // ---- the override moved from a bare checkbox to the card's ⋮ menu
 ok('the standalone override checkbox is gone',
    (await p.locator('#invExpOverride').count())===0);
 await p.click('#page-analysis [data-steppane="3"] [data-step-menu]'); await p.waitForTimeout(200);
 ok('the card menu offers Override Budget Inputs',
    /Override Budget Inputs/.test(await p.locator('#invStepMenu').textContent()),
    await p.locator('#invStepMenu').textContent());
 await p.locator('#invStepMenu .rowmenu-item').first().click(); await p.waitForTimeout(400);
 ok('overriding unlocks the field',
    !(await p.evaluate(()=>document.querySelector('[data-f="expenses.value"]').hasAttribute('readonly'))));
 ok('and the badge changes to say so',
    /Overridden/.test(await p.locator('#invExpLab').textContent()),
    await p.locator('#invExpLab').textContent());

 // origin badges on imported fields
 await p.click('#invSteps button[data-step="1"]');
 ok('origin badges mark imported values', (await p.locator('.inv-origin').count())>=4,
    (await p.locator('.inv-origin').count())+' badges');

 // ---- unlocking is deliberate, and changes nothing on its own
 const beforeUnlock=await p.locator('[data-f="property.name"]').inputValue();
 await p.click('#page-analysis [data-steppane="1"] [data-step-menu]'); await p.waitForTimeout(200);
 ok('the Source & Property menu offers Override Budget Inputs',
    /Override Budget Inputs/.test(await p.locator('#invStepMenu').textContent()),
    await p.locator('#invStepMenu').textContent());
 await p.locator('#invStepMenu .rowmenu-item').first().click(); await p.waitForTimeout(400);
 ok('overriding unlocks the imported property fields',
    await p.evaluate(()=>!document.querySelector('[data-f="property.name"]').hasAttribute('readonly')));
 ok('and does not change the imported value',
    (await p.locator('[data-f="property.name"]').inputValue())===beforeUnlock);

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
 // An override is a decision about the edit being made now, so a reload relocks.
 ok('a reload relocks the budget-derived fields',
    await p.evaluate(()=>document.querySelector('[data-f="property.name"]').hasAttribute('readonly')));
 await p.click('#page-analysis [data-steppane="1"] [data-step-menu]'); await p.waitForTimeout(200);
 await p.locator('#invStepMenu .rowmenu-item').first().click(); await p.waitForTimeout(400);
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

 // ---- drift is REPORTED, never applied on its own
 ok('the analysis knows the budget has moved past it',
    after.source.drift===true && after.source.budgetCurrentVersionNumber===2,
    JSON.stringify(after.source));
 // A same-URL goto is a same-document navigation, so it does NOT refetch —
 // reload explicitly, which is what a user opening the analysis fresh does.
 await p.reload({waitUntil:'networkidle'});
 await p.waitForTimeout(1200);
 ok('and offers the re-sync in the header',
    (await p.locator('.inv-drift').count())===1,
    await p.locator('#page-analysis .page-title .sub').textContent());

 // The list flags it too, quietly — the re-sync button stays in the editor,
 // where the consequences of pressing it are visible.
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(900);
 ok('the list marks an analysis whose budget has moved on',
    (await p.locator('#page-analyses .inv-drift-dot').count())>=1,
    await p.locator('#page-analyses').textContent().then(t=>t.replace(/\s+/g,' ').slice(0,140)));
 await p.goto('http://127.0.0.1:8100/index.html#/analysis/'+aid,{waitUntil:'networkidle'});
 await p.waitForTimeout(1000);

 // ---- re-sync is a proposal: it asks first, names what will change, and
 // stores nothing until the analysis is saved
 await p.locator('.inv-drift').click(); await p.waitForTimeout(1200);
 const rsTxt=(await p.locator('#invModal').textContent().catch(()=>'')).replace(/\s+/g,' ');
 ok('re-sync asks first, naming what will change from old to new',
    /Re-Sync From Budget v2/.test(rsTxt) && /Purchase Price \$5,000,000 → \$[\d,]+/.test(rsTxt),
    rsTxt.slice(0,260));
 ok('and flags a value the user had typed over before replacing it',
    /Changed Name/.test(rsTxt) && /Overridden/.test(rsTxt), rsTxt.slice(0,260));
 await p.click('#invModal button:has-text("Apply Re-Sync")'); await p.waitForTimeout(400);
 const applied=await p.evaluate(()=>{const s=FSInvestmentUI._state();
   return {dirty:s.dirty,stale:s.stale,v:s.source.budgetVersionNumber,price:s.input.acquisition.basis.value,
     exportOff:document.getElementById('invExportBtn').disabled};});
 ok('applying it makes the re-sync an unsaved change with a stale result',
    applied.dirty && applied.stale && applied.v===2 && applied.price>5000000, JSON.stringify(applied));
 ok('so the export waits for the save', applied.exportOff);
 const notYet=await p.evaluate(async id=>await (await fetch('/api/investment-analysis/'+id)).json(),aid);
 ok('the saved version is NOT restated by a re-sync',
    notYet.currentVersionNumber===1 && notYet.source.budgetVersionNumber===1 && notYet.source.drift===true
    && notYet.input.acquisition.basis.value===5000000,
    JSON.stringify({v:notYet.currentVersionNumber,src:notYet.source,price:notYet.input.acquisition.basis.value}));
 // Walking away discards the re-sync with every other unsaved edit.
 await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(1200);
 ok('discarding the edits discards the re-sync: the budget update is offered again',
    (await p.locator('.inv-drift').count())===1
    && await p.evaluate(()=>FSInvestmentUI._state().source.budgetVersionNumber===1));
 await p.locator('.inv-drift').click(); await p.waitForTimeout(1200);
 await p.click('#invModal button:has-text("Apply Re-Sync")'); await p.waitForTimeout(400);
 await p.click('#invSaveBtn'); await p.waitForTimeout(1000);
 const resynced=await p.evaluate(async id=>await (await fetch('/api/investment-analysis/'+id)).json(),aid);
 ok('re-syncing pulls the new purchase price',
    resynced.input.acquisition.basis.value>5000000,
    String(resynced.input.acquisition.basis.value));
 ok('and re-pins to the current budget version',
    resynced.source.budgetVersionNumber===2 && resynced.source.drift===false,
    JSON.stringify(resynced.source));
 ok('an explicit expense override survives the re-sync',
    resynced.input.expenses.override===true && resynced.input.expenses.value===0.33,
    JSON.stringify(resynced.input.expenses));
 ok('but its provenance refreshes so the warning can name what it no longer matches',
    resynced.input.expenses.derivedFrom
      && resynced.input.expenses.derivedFrom.budgetVersionNumber===2,
    JSON.stringify(resynced.input.expenses.derivedFrom));
 ok('the save records the re-sync as a new version, with a matching result',
    resynced.currentVersionNumber===2
    && resynced.result.summary.purchasePrice===resynced.input.acquisition.basis.value,
    String(resynced.currentVersionNumber));

 // ---- Ask AI on the analysis page. The mock runs the real assistant module
 // with a deterministic stand-in for Claude; what is pinned is that the
 // analysis, its engine-computed drivers and its source budget reach the
 // model, and that a what-if runs through the engine via run_scenario.
 await p.click('#page-analysis button:has-text("Ask AI")'); await p.waitForTimeout(300);
 ok('Ask AI opens the assistant on this analysis',
    await p.locator('#assistantPanel.on').count()===1
    && /Investment analysis · /.test(await p.locator('#aiSub').textContent())
    && (await p.locator('#aiLog [data-ai-suggest]').count())===6);
 await p.click('#aiLog [data-ai-suggest="0"]');
 await p.waitForSelector('#aiLog .ai-msg.bot:has-text("mock pro forma answer")',{timeout:5000});
 const aiA=await p.locator('#aiLog .ai-msg.bot').last().textContent();
 ok('the answer carries the engine IRR, a ranked driver and the source budget',
    /Equity IRR: -?\d+\.\d\d%/.test(aiA) && /Top driver: (?!none)/.test(aiA) && /Source budget: loaded/.test(aiA), aiA);
 await p.fill('#aiQ','What would RUBS add?'); await p.press('#aiQ','Enter');
 await p.waitForSelector('#aiLog .ai-msg.bot:has-text("With RUBS")',{timeout:5000});
 ok('a what-if runs through the engine',
    /Looked up: run scenario/.test(await p.locator('#aiLog .ai-msg.bot').last().textContent()));
 // One conversation across pages: from the pro forma to its budget and on,
 // the panel stays open, follows the screen and keeps the thread.
 await p.evaluate(()=>openBudget('TST-9911','budget')); await p.waitForTimeout(400);
 ok('the panel stays open when you move from the pro forma to its budget',
    await p.locator('#assistantPanel.on').count()===1 && /^TST-9911/.test(await p.locator('#aiSub').textContent()),
    await p.locator('#aiSub').textContent());
 ok('the pro forma questions are still in the thread, with a marker for the move',
    await p.locator('#aiLog .ai-msg.user').count()===2
    && /Now viewing budget TST-9911/.test(await p.locator('#aiLog .ai-ctx').last().textContent()));
 await p.fill('#aiQ','And what does this budget total?'); await p.press('#aiQ','Enter');
 await p.waitForSelector('#aiLog .ai-msg.bot:has-text("mock assistant answer")',{timeout:5000});
 const aiB=await p.locator('#aiLog .ai-msg.bot').last().textContent();
 ok('the budget question is answered from the budget, with the pro forma questions as history',
    /Contract Sum: \$[1-9]/.test(aiB) && /Earlier questions: 2 \(some from another screen\)/.test(aiB), aiB);
 ok('the thread reads as about the pro forma, then about the budget',
    (await p.locator('#aiLog .ai-ctx').allTextContents()).map(t=>t.replace(/ .*$/,'')).join(',')==='About,About'
    && /investment analysis/.test(await p.locator('#aiLog .ai-ctx').first().textContent())
    && /budget TST-9911/.test(await p.locator('#aiLog .ai-ctx').last().textContent()));
 await p.click('#nav-home'); await p.waitForTimeout(400);
 ok('on a page about neither, it stays open on the last one you had open',
    await p.locator('#assistantPanel.on').count()===1 && /^Last opened · TST-9911/.test(await p.locator('#aiSub').textContent()));
 await p.focus('#aiQ'); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
 ok('Escape closes the panel', await p.locator('#assistantPanel.on').count()===0);
 // From the budget side, the same pro forma is in reach.
 const proFormaCount=await p.evaluate(async()=>{
   const r=await fetch('/api/budget/TST-9911?scope=ask',{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({question:'How does the pro forma look?'})});
   return (await r.json()).answer;});
 ok('a budget question sees the pro forma built from it', /Pro formas: [1-9]/.test(proFormaCount), proFormaCount);

 // ---- Home-page creation: ONE button, the shared modal
 await p.click('#nav-home'); await p.waitForTimeout(600);
 ok('Home offers a single New Investment Analysis button',
    (await p.locator('#page-home button:has-text("+ New Investment Analysis")').count())===1
    && (await p.locator('#page-home button:has-text("+ Blank Investment Analysis")').count())===0);
 // Home is a dashboard now: one hero carrying both create actions, rather
 // than two titled list sections stacked down the page.
 ok('both create actions sit together in the Home hero',
    await p.evaluate(()=>{
      const hero=document.querySelector('#page-home .hm-actions');
      if(!hero)return false;
      const t=[...hero.querySelectorAll('button')].map(b=>b.textContent.trim());
      return t.some(x=>/\+ New Budget/.test(x))&&t.some(x=>/\+ New Investment Analysis/.test(x));
    }),
    await p.evaluate(()=>{const h=document.querySelector('#page-home .hm-actions');
      return h?[...h.querySelectorAll('button')].map(b=>b.textContent.trim()).join('|'):'no hero';}));
 const bBtn=await p.locator('#page-home button:has-text("+ New Budget")').boundingBox();
 const iBtn=await p.locator('#page-home button:has-text("+ New Investment Analysis")').boundingBox();
 ok('the two create buttons share one row',
    Math.abs(bBtn.y-iBtn.y)<4,
    JSON.stringify({budgetY:Math.round(bBtn.y),analysisY:Math.round(iBtn.y)}));
 // The titled-heading-above-a-card layout now belongs to the Analyses page.
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(700);
 ok('Investment Analyses heading and buttons sit above its list card',
    await p.evaluate(()=>{
      const t=document.querySelector('#page-analyses .page-title');
      if(!t||!/Investment Analyses/.test(t.textContent))return false;
      return !t.closest('.card')&&!!t.nextElementSibling&&t.nextElementSibling.classList.contains('card');
    }));
 await p.evaluate(()=>go('home')); await p.waitForTimeout(600);
 await p.click('#page-home button:has-text("+ New Investment Analysis")');
 await p.waitForTimeout(400);
 ok('the modal offers linked creation AND standalone in one place',
    (await p.locator('#invProjectPick tbody tr',{hasText:'TST-9911'}).count())===1
    && await p.locator('#invModal #invNewName').isVisible());
 // Two namespaces: rows are BUDGETS, grouped under the project they belong to.
 ok('the picker heads its id column Budget, never Project ID',
    await p.evaluate(()=>{const h=[...document.querySelectorAll('#invProjectPick thead th')].map(x=>x.textContent.trim());
      return h[0]==='Budget'&&!h.includes('Project ID');}));
 ok('a budget with no project is grouped as such, not passed off as a project',
    /Not Linked to a Project/.test(await p.locator('#invProjectPick').textContent()));
 ok('the search box takes focus', await p.evaluate(()=>document.activeElement&&document.activeElement.id==='invPickQ'));
 ok('the search box wears the app field style, not the browser default',
    await p.evaluate(()=>{const s=getComputedStyle(document.getElementById('invPickQ'));
      return s.appearance==='none'&&s.borderTopStyle==='solid'&&parseFloat(s.paddingLeft)>=10&&parseFloat(s.borderTopLeftRadius)>=4;}));
 await p.fill('#invPickQ','no-such-budget'); await p.waitForTimeout(100);
 ok('searching filters the list',
    (await p.locator('#invProjectPick tr[data-pick]:visible').count())===0
    && await p.locator('#invProjectPick .inv-pick-none').isVisible());
 await p.fill('#invPickQ','9911'); await p.waitForTimeout(100);
 ok('and finds a budget by its id',
    (await p.locator('#invProjectPick tr[data-pick]:visible').count())===1);
 // Keyboard: ArrowDown from the search lands on the row, Enter picks it.
 await p.press('#invPickQ','ArrowDown');
 ok('rows are keyboard reachable',
    await p.evaluate(()=>!!document.activeElement&&document.activeElement.matches('#invProjectPick tr[data-pick]')));
 await p.keyboard.press('Enter');
 await p.waitForTimeout(900);
 ok('picking a project opens a linked analysis', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());
 const linked=await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   return await (await fetch('/api/investment-analysis/'+id)).json();});
 ok('the picked analysis is linked to the selected project',
    linked.source&&linked.source.projectId==='TST-9911', JSON.stringify(linked.source||null));
 await p.click('#nav-home'); await p.waitForTimeout(600);
 await p.click('#page-home button:has-text("+ New Investment Analysis")');
 await p.waitForTimeout(400);
 await p.click('#invModal button:has-text("Create Standalone Analysis")');   // name left blank
 await p.waitForTimeout(900);
 ok('a nameless standalone opens a new editor directly', /#\/analysis\/[0-9a-f-]{36}$/.test(p.url()), p.url());
 const blank=await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];
   return await (await fetch('/api/investment-analysis/'+id)).json();});
 ok('the standalone analysis is unlinked and carries the placeholder name',
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
 ok('the analyses toolbar carries the three-option view toggle',
    await p.evaluate(()=>['comfortable','compact','cards'].every(v=>
      !!document.querySelector('#page-analyses .mini-seg [data-analysisview-pick='+v+']'))));
 await p.click('#page-analyses .mini-seg [data-analysisview-pick=cards]'); await p.waitForTimeout(700);
 ok('card view works on the analyses tab too',
    (await p.locator('#page-analyses [data-inv-cards] .hcard').count())>=3
    && await p.evaluate(()=>document.querySelector('#page-analyses table.inv-list').style.display==='none'),
    await p.evaluate(()=>({
      cards:document.querySelectorAll('#page-analyses [data-inv-cards] .hcard').length,
      tableDisplay:document.querySelector('#page-analyses table.inv-list')?.style.display,
      view:(window.US&&US.settings&&US.settings.analysisView)||'?'
    })).then(JSON.stringify));
 await p.click('#page-analyses .mini-seg [data-analysisview-pick=comfortable]'); await p.waitForTimeout(700);
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(700);
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(700);
 ok('the analyses list carries the same controls',
    await p.evaluate(()=>!!document.querySelector('#page-analyses [data-inv-q]')
      &&!!document.querySelector('#page-analyses [data-inv-group]')));
 ok('analyses list mirrors the budget list styling: mono headers, compact rows',
    await p.evaluate(()=>{
      const bTh=getComputedStyle(document.querySelector('#budgetsHead th'));
      const aTh=getComputedStyle(document.querySelector('#page-analyses .inv-list th'));
      const bTd=getComputedStyle(document.querySelector('#budgetsBody tr.clickable td'));
      const aTd=getComputedStyle(document.querySelector('#page-analyses [data-inv-list] tr td'));
      return bTh.fontFamily===aTh.fontFamily&&bTh.fontSize===aTh.fontSize
        &&bTh.letterSpacing===aTh.letterSpacing&&bTd.paddingTop===aTd.paddingTop;
    }),
    await p.evaluate(()=>JSON.stringify({
      b:getComputedStyle(document.querySelector('#budgetsHead th')).fontFamily,
      a:getComputedStyle(document.querySelector('#page-analyses .inv-list th')).fontFamily})));
 ok('analyses numbers use the budget list\'s mono calc styling',
    await p.evaluate(()=>{
      const cell=document.querySelector('#page-analyses [data-inv-list] tr td.calc');
      const ref=getComputedStyle(document.querySelector('#budgetsBody tr.clickable td.calc'));
      return !!cell&&getComputedStyle(cell).fontFamily===ref.fontFamily
        &&getComputedStyle(cell).fontSize===ref.fontSize;
    }));
 ok('analyses Updated column right-aligns beside the row menu',
    await p.evaluate(()=>{
      const row=document.querySelector('#page-analyses [data-inv-list] tr');
      return getComputedStyle(row.children[9]).textAlign==='right';
    }));
 ok('analysis statuses render as the shared status chips',
    (await p.locator('#page-analyses [data-inv-list] .st-chip').count())>=1);
 // The two lists are separate pages now, so absolute positions cannot be
 // compared in one shot. Measure each while it is the visible page and compare
 // offsets from its own table's left edge — that is what "line up" means.
 const colOffsets=async(pageId,headSel)=>p.evaluate(([pid,hs])=>{
   const head=document.querySelector(hs);
   const tbl=head.closest('table');
   const base=tbl.getBoundingClientRect();
   const ths=[...head.querySelectorAll('th')];
   return {width:Math.round(base.width),
           left:ths.map(t=>Math.round(t.getBoundingClientRect().left-base.left)),
           right:ths.map(t=>Math.round(base.right-t.getBoundingClientRect().right))};
 },[pageId,headSel]);
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(700);
 const bCols=await colOffsets('page-budgets','#budgetsHead');
 await p.evaluate(()=>go('analyses')); await p.waitForTimeout(700);
 const aCols=await colOffsets('page-analyses','#page-analyses .inv-list thead tr');
 const near=(x,y)=>Math.abs(x-y)<14;
 ok('the two lists are the same width',
    near(bCols.width,aCols.width), JSON.stringify({b:bCols.width,a:aCols.width}));
 ok('Status starts at the same offset in both lists',
    near(bCols.left[3],aCols.left[3]),
    JSON.stringify({budget:bCols.left[3],analysis:aCols.left[3]}));
 ok('Updated ends at the same offset in both lists',
    near(bCols.right[6],aCols.right[9]),
    JSON.stringify({budget:bCols.right[6],analysis:aCols.right[9]}));
 ok('the action column starts at the same offset in both lists',
    near(bCols.right[7],aCols.right[10]),
    JSON.stringify({budget:bCols.right[7],analysis:aCols.right[10]}));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
