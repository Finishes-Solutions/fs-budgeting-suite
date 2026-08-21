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
 ok('purchase month is NOT invented', pre.month==='');
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
 ok('budget expenses shown with their total',
    /partial/i.test(expTxt)&&/7,800/.test(expTxt), expTxt.slice(0,120));
 ok('and the derived ratio shows the arithmetic it came from',
    /449,820/.test(await p.locator('#invExpDerived').textContent()),
    await p.locator('#invExpDerived').textContent());
 ok('with the source budget flagged as outside the guard rail',
    /guard rail/i.test(await p.locator('#invExpDerived').textContent()));

 // ---- the override is the only way to type into it, and it is visible
 await p.check('#invExpOverride'); await p.waitForTimeout(300);
 ok('overriding unlocks the field',
    !(await p.evaluate(()=>document.querySelector('[data-f="expenses.value"]').hasAttribute('readonly'))));
 ok('and the badge changes to say so',
    /Overridden/.test(await p.locator('#invExpLab').textContent()),
    await p.locator('#invExpLab').textContent());

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

 await p.locator('.inv-drift').click(); await p.waitForTimeout(1200);
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
 ok('the saved version is NOT restated by a re-sync',
    resynced.currentVersionNumber===1, String(resynced.currentVersionNumber));

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
 await p.locator('#invProjectPick tbody tr',{hasText:'TST-9911'}).first().click();
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
