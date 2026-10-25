// Suite 13 — versions, duplicate, soft delete, and the save-conflict path.
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
 await p.fill('#invNewName','History Deal');
 await p.click('button:has-text("Create Standalone Analysis")');
 await p.waitForTimeout(700);
 const aid=p.url().match(/analysis\/([0-9a-f-]{36})/)[1];

 // complete + save v1
 await p.fill('[data-f="property.size.value"]','50000');
 await p.fill('[data-f="property.purchaseMonth"]','2026-04');
 await p.fill('[data-f="acquisition.basis.value"]','1500000');
 await p.click('#invSteps button[data-step="2"]');
 await p.fill('[data-f="income.year1PotentialIncome"]','240000');
 await p.click('#invSteps button[data-step="3"]');
 await p.fill('[data-f="expenses.value"]','35');
 await p.click('#invSteps button[data-step="5"]');
 await p.fill('[data-f="disposition.exitCapRate.value"]','7.5');
 await p.click('#invSaveBtn'); await p.waitForTimeout(800);
 ok('v1 saved', /Saved/.test(await p.locator('#invState').textContent()) && (await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];return (await (await fetch('/api/investment-analysis/'+id)).json()).currentVersionNumber;}))===1);

 // v2 with a changed vacancy
 await p.click('#invSteps button[data-step="3"]');
 await p.fill('[data-f="vacancy.value"]','8');
 await p.locator('[data-f="vacancy.value"]').dispatchEvent('change');
 await p.click('#invSaveBtn'); await p.waitForTimeout(800);
 ok('v2 saved', /Saved/.test(await p.locator('#invState').textContent()) && (await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];return (await (await fetch('/api/investment-analysis/'+id)).json()).currentVersionNumber;}))===2);

 // versions modal: opened from the three-dot row menu on the tab's list —
 // the editor toolbar deliberately has no Versions button (matches budgets).
 ok('editor toolbar has neither Versions nor Duplicate buttons',
    (await p.locator('#page-analysis .page-title button', { hasText: 'Versions' }).count())===0
    && (await p.locator('#page-analysis .page-title button', { hasText: 'Duplicate' }).count())===0);
 await p.click('#nav-analyses'); await p.waitForTimeout(500);
 const histRow=p.locator('#page-analyses [data-inv-list] tr',{hasText:'History Deal'}).first();
 await histRow.locator('.rowmenu-btn').click(); await p.waitForTimeout(200);
 await p.locator('#invRowMenu .rowmenu-item',{hasText:'Versions'}).click();
 await p.waitForTimeout(500);
 ok('two versions listed, newest first and marked current',
    (await p.locator('#invModal tbody tr').count())===2
    && /v2 ·current/.test(await p.locator('#invModal tbody tr').first().textContent()));
 await p.click('#invModal tbody tr:last-child'); await p.waitForTimeout(500);
 const v1txt=await p.locator('#invModal').textContent();
 ok('version 1 opens read-only with its original vacancy', /Read-Only/.test(v1txt)&&/Vacancy 10\.00%/.test(v1txt));
 ok('version view offers no edit controls', (await p.locator('#invModal input').count())===0);
 await p.click('#invModal .btn-x');

 // duplicate from the row menu: separate analysis, same assumptions, fresh history
 await histRow.locator('.rowmenu-btn').click(); await p.waitForTimeout(200);
 await p.locator('#invRowMenu .rowmenu-item',{hasText:'Duplicate'}).click();
 await p.waitForTimeout(800);
 const aid2=p.url().match(/analysis\/([0-9a-f-]{36})/)[1];
 ok('duplicate opens a new analysis', aid2!==aid, aid2);
 // The price field renders as money; the assumption it carries is the number.
 ok('duplicate carries the assumptions',
    (await p.locator('[data-f="acquisition.basis.value"]').inputValue())==='$1,500,000',
    await p.locator('[data-f="acquisition.basis.value"]').inputValue());
 ok('duplicate name marks the copy', /\(Copy\)/.test(await p.locator('#invTitle').textContent()));
 const dupVersions=await p.evaluate(async id=>
   (await (await fetch('/api/investment-analysis/'+id+'/versions')).json()).versions.length,aid2);
 ok('duplicate starts with no version history', dupVersions===0);

 // ---- conflict: another session saves v3 behind this tab's back
 await p.goto('http://127.0.0.1:8100/index.html#/analysis/'+aid,{waitUntil:'networkidle'});
 await p.waitForTimeout(700);
 await p.evaluate(async id=>{
   const cur=await (await fetch('/api/investment-analysis/'+id)).json();
   cur.input.vacancy.value=0.12;
   await fetch('/api/investment-analysis/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({input:cur.input,expectedVersionNumber:cur.currentVersionNumber})});
 },aid);
 await p.click('#invSteps button[data-step="2"]');
 await p.fill('[data-f="income.year1PotentialIncome"]','250000');
 await p.locator('[data-f="income.year1PotentialIncome"]').dispatchEvent('change');
 await p.click('#invSaveBtn'); await p.waitForTimeout(800);
 ok('stale save shows the conflict, does not overwrite',
    /newer version/i.test(await p.locator('#invConflict').textContent()));
 const vAfter=await p.evaluate(async id=>
   (await (await fetch('/api/investment-analysis/'+id)).json()).currentVersionNumber,aid);
 ok('the other session\'s v3 survives', vAfter===3, 'v'+vAfter);
 await p.click('#invConflict button:has-text("Reload Latest")'); await p.waitForTimeout(800);
 ok('Reload Latest loads v3', /Saved/.test(await p.locator('#invState').textContent()) && (await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];return (await (await fetch('/api/investment-analysis/'+id)).json()).currentVersionNumber;}))===3);
 ok('reloaded vacancy is the other session\'s value',
    (await p.locator('[data-f="vacancy.value"]').inputValue())==='12');

 // ---- Save As Copy: keep the inputs ON SCREEN as their own analysis. The
 // list's Duplicate fetches the server's copy, which is exactly what the
 // conflict says is no longer yours.
 await p.evaluate(async id=>{
   const cur=await (await fetch('/api/investment-analysis/'+id)).json();
   cur.input.vacancy.value=0.11;
   await fetch('/api/investment-analysis/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({input:cur.input,expectedVersionNumber:cur.currentVersionNumber})});
 },aid);
 await p.click('#invSteps button[data-step="2"]');
 await p.fill('[data-f="income.year1PotentialIncome"]','260000');
 await p.locator('[data-f="income.year1PotentialIncome"]').dispatchEvent('change');
 await p.click('#invSaveBtn'); await p.waitForTimeout(800);
 ok('the conflict offers Save As Copy beside Reload Latest',
    (await p.locator('#invConflict button:has-text("Save As Copy")').count())===1
    && (await p.locator('#invConflict button:has-text("Reload Latest")').count())===1);
 await p.click('#invConflict button:has-text("Save As Copy")'); await p.waitForTimeout(1200);
 const aid3=(p.url().match(/analysis\/([0-9a-f-]{36})/)||[])[1];
 const copy=await p.evaluate(async id=>await (await fetch('/api/investment-analysis/'+id)).json(),aid3);
 ok('Save As Copy opens a new analysis carrying the inputs that were on screen',
    aid3 && aid3!==aid && copy.input.income.year1PotentialIncome===260000 && /\(Copy\)/.test(copy.name||''),
    JSON.stringify({aid3,inc:copy.input&&copy.input.income.year1PotentialIncome,name:copy.name}));
 const orig=await p.evaluate(async id=>await (await fetch('/api/investment-analysis/'+id)).json(),aid);
 ok('and leaves the other session’s version as it was',
    orig.currentVersionNumber===4 && orig.input.vacancy.value===0.11 && orig.input.income.year1PotentialIncome!==260000,
    JSON.stringify({v:orig.currentVersionNumber,vac:orig.input.vacancy.value}));

 // ---- soft delete from the list
 await p.click('#nav-analyses'); await p.waitForTimeout(500);
 const listRows='#page-analyses [data-inv-list] tr';
 const rows0=await p.locator(listRows).count();
 const delMsgs=[]; p.on('dialog',d=>delMsgs.push(d.message()));
 await p.locator(listRows).first().locator('.rowmenu-btn').click(); await p.waitForTimeout(200);
 await p.locator('#invRowMenu .rowmenu-item',{hasText:'Delete Analysis'}).click();
 await p.waitForTimeout(600);
 ok('delete from the row menu removes the analysis from the list',
    (await p.locator(listRows).count())===rows0-1);
 ok('and the confirm promises no restore the app cannot do',
    delMsgs.length>0 && !/restored by an administrator/i.test(delMsgs[0]) && /cannot be restored/i.test(delMsgs[0]),
    delMsgs[0]||'no dialog');

 // ---- budgets: the Budget ID is fixed once saved (BUDGET-SYSTEM.md D13).
 // Editing it used to re-point the next save at whichever budget had the new
 // id, overwrite it, and version the replacement as its next revision.
 const seededIds=await p.evaluate(async()=>{
   await fetch('/api/budget/OP-7130?scope=project',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,name:'ID Lock Project',address:'1 Test Way'})});
   const mk=async(id,name)=>{
     const d={projectId:id,name,type:'Multifamily',status:'Draft',resSF:1000,amenSF:0,siteSF:0,
       units:[],other:[],expenses:[],lines:[],companies:[],contingency:{mode:'pct',val:0},
       projectCosts:{land:0},guardrailAcks:[]};
     const r=await fetch('/api/budget/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},
       body:JSON.stringify({create:true,meta:{projectId:id,name,type:'Multifamily',status:'Draft',projectKey:'OP-7130'},doc:d})});
     return r.status;
   };
   return [await mk('BD-7131','Lock Source'),await mk('BD-7132','Innocent Bystander')];
 });
 ok('two budgets seeded', seededIds.every(s=>s===200), JSON.stringify(seededIds));
 await p.evaluate(()=>openBudget('BD-7131','input')); await p.waitForTimeout(800);
 ok('a saved budget\'s Budget ID field is read-only',
    await p.locator('#pId').evaluate(e=>e.readOnly));
 ok('with a note saying why',
    await p.locator('#pIdLocked').isVisible()
      && /fixed once it is saved/.test(await p.locator('#pIdLocked').textContent()),
    await p.locator('#pIdLocked').textContent());
 // Force the field anyway (devtools, an old tab) and save.
 await p.evaluate(()=>{const el=document.getElementById('pId');el.readOnly=false;el.value='BD-7132';});
 await p.evaluate(()=>saveBudget(true)); await p.waitForTimeout(800);
 const lockToast=await p.locator('#toast').textContent();
 ok('saving under a changed ID is refused, with the reason',
    /BD-7131/.test(lockToast)&&/fixed once it is saved/.test(lockToast), lockToast);
 ok('the field goes back to the budget\'s own ID',
    (await p.inputValue('#pId'))==='BD-7131' && await p.locator('#pId').evaluate(e=>e.readOnly),
    await p.inputValue('#pId'));
 const bystander=await p.evaluate(async()=>{
   const d=await (await fetch('/api/budget/BD-7132')).json();
   const v=await (await fetch('/api/budget/BD-7132/versions')).json();
   return {name:d.name,versions:v.versions.length};
 });
 ok('the other budget is untouched, with no new version',
    bystander.name==='Innocent Bystander'&&bystander.versions===1, JSON.stringify(bystander));
 const direct409=await p.evaluate(async()=>{
   const d=await (await fetch('/api/budget/BD-7131')).json();
   d.projectId='BD-7132';
   const r=await fetch('/api/budget/BD-7132',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'BD-7132',name:d.name,type:'Multifamily',status:'Draft',originalId:'BD-7131'},doc:d})});
   return {status:r.status,body:await r.json().catch(()=>null)};
 });
 ok('the endpoint refuses it independently (409 budget_id_changed)',
    direct409.status===409&&direct409.body&&direct409.body.error==='budget_id_changed'
      &&direct409.body.field==='projectId', JSON.stringify(direct409));
 // A legitimate save under a new id is a create, and still works.
 await p.evaluate(()=>{dirty=false;});
 await p.evaluate(()=>duplicateBudgetAs('BD-7131','BD-7131-02','OP-7130')); await p.waitForTimeout(900);
 ok('an alternate starts with its ID still open',
    (await p.inputValue('#pId'))==='BD-7131-02' && !(await p.locator('#pId').evaluate(e=>e.readOnly)),
    await p.inputValue('#pId'));
 await p.evaluate(()=>saveBudget(true)); await p.waitForTimeout(800);
 ok('the alternate saves as a new budget',
    /^Saved /.test(await p.locator('#saveState').textContent())
      && (await p.evaluate(async()=>(await fetch('/api/budget/BD-7131-02')).status))===200,
    await p.locator('#saveState').textContent());
 ok('and its ID locks once saved', await p.locator('#pId').evaluate(e=>e.readOnly));
 const src=await p.evaluate(async()=>(await (await fetch('/api/budget/BD-7131/versions')).json()).versions.length);
 ok('the source budget gained no version from any of this', src===1, 'v'+src);

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
