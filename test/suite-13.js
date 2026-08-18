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
 ok('duplicate carries the assumptions', (await p.locator('[data-f="acquisition.basis.value"]').inputValue())==='1500000');
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

 // ---- soft delete from the list
 await p.click('#nav-analyses'); await p.waitForTimeout(500);
 const listRows='#page-analyses [data-inv-list] tr';
 const rows0=await p.locator(listRows).count();
 await p.locator(listRows).first().locator('.rowmenu-btn').click(); await p.waitForTimeout(200);
 await p.locator('#invRowMenu .rowmenu-item',{hasText:'Delete Analysis'}).click();
 await p.waitForTimeout(600);
 ok('delete from the row menu removes the analysis from the list',
    (await p.locator(listRows).count())===rows0-1);

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
