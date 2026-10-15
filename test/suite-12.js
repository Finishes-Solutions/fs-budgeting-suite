// Suite 12 — the six-step workflow: validation, calculate, report fidelity
// (every displayed number traces to the canonical server result), save,
// reload, stale state, and the keyboard shortcut.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 const isMac=process.platform==='darwin'; const MOD=isMac?'Meta':'Control';
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);

 // standalone creation through the shared New Investment Analysis modal
 await p.click('#nav-analyses'); await p.waitForTimeout(400);
 ok('list page offers the shared creation flow',
    await p.locator('#page-analyses button:has-text("+ New Investment Analysis")').isVisible());
 await p.click('#page-analyses button:has-text("+ New Investment Analysis")');
 await p.waitForTimeout(400);
 ok('the modal offers both linked and standalone creation',
    /From Existing Budget/.test(await p.locator('#invModal').textContent())
    && /Standalone Analysis/.test(await p.locator('#invModal').textContent()));
 // ---- it behaves like the app's other dialogs
 ok('the dialog is announced as a modal dialog and takes focus',
    await p.evaluate(()=>{const s=document.querySelector('#invModal .mod-sheet');
      return s.getAttribute('role')==='dialog'&&s.getAttribute('aria-modal')==='true'
        &&!!document.getElementById(s.getAttribute('aria-labelledby'))
        &&!!document.activeElement&&!!document.activeElement.closest('#invModal');}));
 await p.keyboard.press('Escape'); await p.waitForTimeout(200);
 ok('Escape closes it', (await p.locator('#invModal').count())===0);
 ok('and focus returns to the button that opened it',
    await p.evaluate(()=>/New Investment Analysis/.test((document.activeElement&&document.activeElement.textContent)||'')),
    await p.evaluate(()=>(document.activeElement&&document.activeElement.outerHTML||'').slice(0,80)));
 await p.click('#page-analyses button:has-text("+ New Investment Analysis")');
 await p.waitForTimeout(400);
 await p.fill('#invNewName','Workflow Deal');
 await p.click('button:has-text("Create Standalone Analysis")');
 await p.waitForTimeout(700);
 ok('standalone analysis opens in the editor', /#\/analysis\//.test(p.url()));
 ok('six steps are presented', (await p.locator('#invSteps button').count())===6);

 // ---- guided Next buttons: dark until the step's required fields are in
 const next1=p.locator('[data-stepnav="1"] .inv-next');
 ok('Next is disabled while step 1 is incomplete',
    await next1.isDisabled() && !(await next1.evaluate(e=>e.classList.contains('ready'))));
 ok('hint explains what to do', /Fill in the required fields/.test(
    await p.locator('[data-stepnav="1"] .inv-stepnav-hint').textContent()));

 // calculating with missing assumptions surfaces field-keyed errors
 await p.click('#invCalcBtn'); await p.waitForTimeout(500);
 // The banner names the FIELD and the step. It no longer carries a count
 // sentence above the detail — the amber flag already means "needs attention",
 // and restating it was the flag explaining itself.
 ok('missing assumptions are rejected with highlighted fields',
    (await p.locator('.inv-err').count())>0
    && (await p.locator('#invErrSummary .inv-errlist li').count())>0);
 ok('and the banner does not restate the count above the detail',
    !/assumptions? need/i.test(await p.locator('#invErrSummary').textContent()),
    (await p.locator('#invErrSummary').textContent()).replace(/\s+/g,' ').slice(0,120));

 // ---- the banner NAMES what is wrong and where it lives ----
 // "1 assumption needs attention" on its own sends you hunting through six
 // steps; each flagged assumption says which field and which step, and the
 // step button jumps straight there.
 const errTxt=await p.locator('#invErrSummary').textContent();
 ok('each flagged assumption is named',
    /Purchase Price/.test(errTxt)&&/Exit Cap Rate/.test(errTxt), errTxt.slice(0,240));
 ok('and says which step it lives on',
    /Step 1 · Source & Property/.test(errTxt)&&/Step 5 · Disposition/.test(errTxt), errTxt.slice(0,240));
 ok('the step buttons in the banner jump to that step',
    (await p.locator('#invErrSummary .inv-errjump').count())>0);
 const flagged=await p.evaluate(()=>[...document.querySelectorAll('#invSteps button[data-step]')]
   .filter(b=>b.classList.contains('flag')).map(b=>+b.dataset.step));
 ok('the step pills carry the same flag',
    flagged.includes(1)&&flagged.includes(5)&&!flagged.includes(4), JSON.stringify(flagged));
 ok('and the flag is the warning amber, not the default pill',
    await p.evaluate(()=>{
      const b=[...document.querySelectorAll('#invSteps button.flag')].find(x=>!x.classList.contains('on'));
      return b?getComputedStyle(b).backgroundColor==='rgb(251, 243, 228)':false;
    }),
    await p.evaluate(()=>{
      const b=[...document.querySelectorAll('#invSteps button.flag')].find(x=>!x.classList.contains('on'));
      return b?getComputedStyle(b).backgroundColor:'none';
    }));
 // Answering an assumption clears its flag immediately — a warning that
 // outlives its cause teaches people to ignore warnings.
 await p.click('#invSteps button[data-step="5"]'); await p.waitForTimeout(200);
 await p.fill('[data-f="disposition.exitCapRate.value"]','6.5');
 await p.locator('[data-f="disposition.exitCapRate.value"]').dispatchEvent('change');
 await p.waitForTimeout(250);
 ok('filling a flagged field clears its pill without recalculating',
    await p.evaluate(()=>!document.querySelector('#invSteps button[data-step="5"]').classList.contains('flag')));
 ok('and drops it from the banner, leaving the rest',
    !/Exit Cap Rate/.test(await p.locator('#invErrSummary').textContent())
      && /Purchase Price/.test(await p.locator('#invErrSummary').textContent()),
    (await p.locator('#invErrSummary').textContent()).slice(0,200));
 await p.click('#invSteps button[data-step="1"]'); await p.waitForTimeout(200);

 // fill everything (all-cash first)
 await p.fill('[data-f="property.size.value"]','100000');
 await p.fill('[data-f="property.purchaseMonth"]','2026-06');
 await p.fill('[data-f="acquisition.basis.value"]','2000000');
 await p.locator('[data-f="acquisition.basis.value"]').dispatchEvent('change');
 await p.waitForTimeout(150);
 ok('Next lights up when step 1 completes',
    await next1.isEnabled() && await next1.evaluate(e=>e.classList.contains('ready')));
 ok('the step pill earns its done mark',
    await p.locator('#invSteps button[data-step="1"]').evaluate(e=>e.classList.contains('done')));
 ok('the done mark is a green dot, not a check mark',
    await p.locator('#invSteps button[data-step="1"]').evaluate(e=>{
      const s=getComputedStyle(e,'::after');
      return s.content==='""'&&s.width==='7px'&&s.borderRadius==='50%';
    }));
 await next1.click(); await p.waitForTimeout(200);
 ok('Next advances to Income', await p.locator('[data-steppane="2"]').evaluate(e=>e.classList.contains('on')));
 await p.fill('[data-f="income.year1PotentialIncome"]','300000');
 await p.click('#invSteps button[data-step="3"]');
 // step 4 (all-cash) is already a complete answer — its Next is lit untouched
 ok('all-cash Mortgage step counts as complete',
    await p.locator('[data-stepnav="4"] .inv-next').evaluate(e=>e.classList.contains('ready')));
 await p.fill('[data-f="expenses.value"]','30');
 await p.click('#invSteps button[data-step="5"]');
 await p.fill('[data-f="disposition.exitCapRate.value"]','7');
 await p.waitForTimeout(150);
 await p.click('#invCalcBtn'); await p.waitForTimeout(800);
 ok('errors clear once assumptions are complete', (await p.locator('.inv-err').count())===0);
 ok('report renders', (await p.locator('#invReport .inv-kpis .kpi').count())>=5);
 ok('finishing the last step and calculating shows the results',
    await p.locator('[data-steppane="6"]').evaluate(e=>e.classList.contains('on')));
 // Every export names the saved version it came from, so a calculation that
 // has not been saved has no version to name.
 ok('a calculated but unsaved analysis cannot be exported yet',
    await p.evaluate(()=>{const b=document.getElementById('invExportBtn');
      return b.disabled&&/Save to export/.test(b.title);}),
    await p.evaluate(()=>document.getElementById('invExportBtn').title));

 // save → version 1; reload and compare the persisted report values
 // (report fidelity is asserted against the SAVED canonical result below)
 await p.click('#invSaveBtn'); await p.waitForTimeout(800);
 ok('save shows the Saved pill', /Saved/.test(await p.locator('#invState').textContent()),
    await p.locator('#invState').textContent());
 ok('saving enables Export', await p.evaluate(()=>!document.getElementById('invExportBtn').disabled));
 ok('save recorded version 1', (await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];return (await (await fetch('/api/investment-analysis/'+id)).json()).currentVersionNumber;}))===1);
 await p.evaluate(()=>FSInvestmentUI.showVersions(FSInvestmentUI.currentId()));
 await p.waitForTimeout(500);
 ok('version history stamps are local MM-DD-YYYY h:mm AM/PM',
    /\d{2}-\d{2}-\d{4} \d{1,2}:\d{2} [AP]M/.test(await p.locator('#invModal').textContent()),
    (await p.locator('#invModal').textContent()).replace(/\s+/g,' ').slice(0,140));
 await p.click('#invModal .btn-x'); await p.waitForTimeout(200);
 const aid=p.url().match(/analysis\/([0-9a-f-]{36})/)[1];
 const saved=await p.evaluate(async id=>await (await fetch('/api/investment-analysis/'+id)).json(),aid);
 const a1=saved.result.annual[0];
 // NOI: 300,000 − 10% vacancy = 270,000 GOI; 30% expenses → NOI 189,000 (from the server)
 ok('server NOI matches the assumptions', Math.round(a1.netOperatingIncome)===189000, String(a1.netOperatingIncome));
 const rpt=await p.locator('#invReport').textContent();
 const shows=v=>rpt.includes('$'+Math.round(v).toLocaleString('en-US'));
 ok('report shows the canonical NOI', shows(a1.netOperatingIncome));
 ok('report shows the canonical gross sale price (rounded $1,000)',
    shows(a1.grossSalePrice)&&a1.grossSalePrice%1000===0, String(a1.grossSalePrice));
 ok('report shows net sale proceeds', shows(a1.netSaleProceeds));
 ok('all-cash report hides debt tables', !/DSCR/.test(rpt));
 ok('on-screen report carries no engine version string', !/before-tax-1\.1\.0/.test(rpt));

 // reload from the hash — the persisted state must reproduce the same report
 await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(800);
 const rpt2=await p.locator('#invReport').textContent();
 ok('reload reproduces the saved report', rpt2.includes('$'+Math.round(a1.netOperatingIncome).toLocaleString('en-US')));
 ok('reopen restores Saved state', /Saved/.test(await p.locator('#invState').textContent()));
 ok('pill carries no version number', !/v\d/.test(await p.locator('#invState').textContent()));

 // switch to financed → stale → recalc shows debt tables
 await p.click('#invSteps button[data-step="4"]');
 await p.check('#invFinanced'); await p.waitForTimeout(400);
 ok('editing marks the result stale', /stale/i.test(await p.locator('#invState').textContent()));
 await p.click('#invCalcBtn'); await p.waitForTimeout(800);
 // Mid-form, Calculate no longer throws you onto the report.
 ok('calculating mid-form leaves you on the step you were on',
    await p.locator('[data-steppane="4"]').evaluate(e=>e.classList.contains('on')));
 ok('and offers View Results instead',
    await p.locator('#invState button:has-text("View Results")').isVisible());
 const rpt3=await p.locator('#invReport').textContent();
 ok('financed recalculation adds mortgage, DSCR and leverage', /DSCR/.test(rpt3)&&/Leverage Impact/.test(rpt3));
 ok('monthly payment appears in the mortgage step', /\$[\d,]+\.\d\d/.test(await p.locator('#invMonthlyPay').inputValue()));
 await p.click('#invState button:has-text("View Results")'); await p.waitForTimeout(250);
 ok('View Results opens the report',
    await p.locator('[data-steppane="6"]').evaluate(e=>e.classList.contains('on'))
    && (await p.locator('#invState button:has-text("View Results")').count())===0);

 // ---- ten-year projection
 await p.click('#invSteps button[data-step="1"]');
 await p.selectOption('[data-f="projection.years"]','10');
 await p.click('#invCalcBtn'); await p.waitForTimeout(500);
 ok('a five-year loan is rejected for a ten-year projection',
    /10-year projection/.test(await p.locator('#page-analysis').textContent()));
 await p.click('#invSteps button[data-step="4"]');
 await p.fill('[data-f="loan.termYears"]','10');
 await p.locator('[data-f="loan.termYears"]').dispatchEvent('change');
 await p.click('#invCalcBtn'); await p.waitForTimeout(800);
 const yearCols=await p.locator('#invReport .inv-rpt:has(td:text("Potential Rental Income"))')
   .locator('thead th').count();
 ok('ten-year report renders ten year columns', yearCols===11, yearCols+' header cells');
 ok('ten-year sensitivity carries ten sale years', /Sale Y10/.test(await p.locator('#invReport').textContent()));

 // keyboard save on the analysis page saves the analysis
 await p.keyboard.press(MOD+'+s'); await p.waitForTimeout(800);
 ok('Cmd/Ctrl+S saves the analysis', /Saved/.test(await p.locator('#invState').textContent()),
    await p.locator('#invState').textContent());
 ok('keyboard save recorded version 2', (await p.evaluate(async()=>{const id=location.hash.match(/analysis\/([0-9a-f-]{36})/)[1];return (await (await fetch('/api/investment-analysis/'+id)).json()).currentVersionNumber;}))===2);

 // ---- undo / redo: the budget's shortcuts act on the analysis inputs here
 await p.click('#invSteps button[data-step="3"]');
 const vac0=await p.locator('[data-f="vacancy.value"]').inputValue();
 await p.fill('[data-f="vacancy.value"]','22');
 await p.locator('[data-f="vacancy.value"]').dispatchEvent('change');
 await p.waitForTimeout(150);
 await p.keyboard.press(MOD+'+z'); await p.waitForTimeout(300);
 ok('Cmd/Ctrl+Z reverts the vacancy edit',
    (await p.locator('[data-f="vacancy.value"]').inputValue())===vac0,
    await p.locator('[data-f="vacancy.value"]').inputValue());
 await p.keyboard.press(MOD+'+Shift+z'); await p.waitForTimeout(300);
 ok('Cmd/Ctrl+Shift+Z redoes it',
    (await p.locator('[data-f="vacancy.value"]').inputValue())==='22');
 await p.keyboard.press(MOD+'+z'); await p.waitForTimeout(300);
 await p.keyboard.press(MOD+'+y'); await p.waitForTimeout(300);
 ok('Ctrl+Y also redoes',
    (await p.locator('[data-f="vacancy.value"]').inputValue())==='22');
 await p.fill('[data-f="vacancy.value"]','25');
 await p.locator('[data-f="vacancy.value"]').dispatchEvent('change');
 await p.waitForTimeout(150);
 await p.keyboard.press(MOD+'+y'); await p.waitForTimeout(300);
 ok('a new change clears the redo path',
    (await p.locator('[data-f="vacancy.value"]').inputValue())==='25');
 await p.keyboard.press(MOD+'+z'); await p.waitForTimeout(300);
 ok('undo still steps back after the fork',
    (await p.locator('[data-f="vacancy.value"]').inputValue())==='22');

 // navigation guard: dirty analysis prompts before leaving
 // (calculate jumped the editor to the Review step, so surface step 4 again)
 await p.click('#invSteps button[data-step="4"]');
 await p.fill('[data-f="loan.annualRate"]','7.1');
 await p.locator('[data-f="loan.annualRate"]').dispatchEvent('change');
 let confirmMsg='';
 await p.evaluate(()=>{const orig=window.confirm;window.confirm=m=>{window.__cm=m;return true;};});
 await p.click('#nav-home'); await p.waitForTimeout(300);
 confirmMsg=await p.evaluate(()=>window.__cm||'');
 ok('leaving a dirty analysis asks first', /unsaved changes/i.test(confirmMsg), confirmMsg);

 // ---- agreeing to leave IS the discard: nothing is held back or re-offered
 const draftKey=await p.evaluate(id=>FSInvestmentUI._draftKey(id),aid);
 const draftOf=()=>p.evaluate(k=>{try{return JSON.parse(localStorage.getItem(k)||'null');}catch(e){return 'unreadable';}},draftKey);
 ok('a confirmed leave discards the edits and their local copy',
    (await draftOf())===null && await p.evaluate(()=>!FSInvestmentUI.isDirty()));
 await p.evaluate(id=>{location.hash='#/analysis/'+id;},aid); await p.waitForTimeout(1000);
 ok('so reopening the analysis offers nothing to restore',
    (await p.locator('#invDraftBanner .inv-draft').count())===0);

 // ---- a full save keeps the workflow status (every save used to reset it to Draft)
 await p.evaluate(async id=>{await fetch('/api/investment-analysis/'+id,{method:'PUT',
   headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'In Review'})});},aid);
 await p.click('#invSteps button[data-step="3"]');
 await p.fill('[data-f="vacancy.value"]','12');
 await p.locator('[data-f="vacancy.value"]').dispatchEvent('change');
 await p.click('#invSaveBtn'); await p.waitForTimeout(900);
 const afterStatus=await p.evaluate(async id=>await (await fetch('/api/investment-analysis/'+id)).json(),aid);
 ok('saving the assumptions keeps the In Review status',
    afterStatus.status==='In Review' && Math.abs(afterStatus.input.vacancy.value-0.12)<1e-9,
    afterStatus.status);

 // ---- an edit made while a save is in flight stays unsaved
 const putPath='**/api/investment-analysis/'+aid;
 await p.route(putPath,async r=>{
   if(r.request().method()==='PUT') await new Promise(x=>setTimeout(x,1200));
   await r.continue();
 });
 await p.fill('[data-f="vacancy.value"]','13');
 await p.locator('[data-f="vacancy.value"]').dispatchEvent('change');
 await p.click('#invSaveBtn'); await p.waitForTimeout(250);
 await p.fill('[data-f="vacancy.value"]','14');
 await p.locator('[data-f="vacancy.value"]').dispatchEvent('change');
 await p.waitForTimeout(1600);
 await p.unroute(putPath);
 const race=await p.evaluate(()=>{const s=FSInvestmentUI._state();
   return {dirty:s.dirty,stale:s.stale,vac:s.input.vacancy.value,ver:s.loadedVersion,
     exportOff:document.getElementById('invExportBtn').disabled,
     pill:document.getElementById('invState').textContent};});
 const raceSrv=await p.evaluate(async id=>await (await fetch('/api/investment-analysis/'+id)).json(),aid);
 ok('the save in flight recorded what was on screen when it was pressed',
    Math.abs(raceSrv.input.vacancy.value-0.13)<1e-9 && raceSrv.currentVersionNumber===race.ver,
    JSON.stringify({srv:raceSrv.input.vacancy.value,v:raceSrv.currentVersionNumber,ver:race.ver}));
 ok('and the edit made while it was out is still unsaved, with a stale result',
    race.dirty && race.stale && Math.abs(race.vac-0.14)<1e-9 && /Unsaved/.test(race.pill), JSON.stringify(race));
 ok('so Export stays off until that is saved too', race.exportOff);

 // ---- local draft recovery: kept on this device, offered back, never applied unasked
 await p.waitForTimeout(1000);
 ok('unsaved edits are kept on this device',
    await (async()=>{const d=await draftOf();return !!d&&Math.abs(d.input.vacancy.value-0.14)<1e-9;})());
 const dialogTypes=[]; p.on('dialog',d=>dialogTypes.push(d.type()));
 await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(1000);
 ok('closing or reloading with unsaved edits asks first',
    dialogTypes.includes('beforeunload'), JSON.stringify(dialogTypes));
 const banner=(await p.locator('#invDraftBanner').textContent()).replace(/\s+/g,' ');
 ok('reopening offers the unsaved changes back, with when they were made',
    /Unsaved changes from \d{2}-\d{2}-\d{4} \d{1,2}:\d{2}/.test(banner)&&/Restore/.test(banner)&&/Discard/.test(banner),
    banner.slice(0,160));
 ok('without applying them on its own',
    await p.evaluate(()=>{const s=FSInvestmentUI._state();return !s.dirty&&Math.abs(s.input.vacancy.value-0.13)<1e-9;}));
 await p.click('#invDraftBanner button:has-text("Restore")'); await p.waitForTimeout(300);
 await p.click('#invSteps button[data-step="3"]'); await p.waitForTimeout(150);
 ok('Restore brings them back as unsaved changes',
    (await p.locator('[data-f="vacancy.value"]').inputValue())==='14'
    && await p.evaluate(()=>FSInvestmentUI._state().dirty)
    && (await p.locator('#invDraftBanner .inv-draft').count())===0);
 await p.click('#invSaveBtn'); await p.waitForTimeout(900);
 ok('and saving them clears the kept copy',
    (await draftOf())===null && /Saved/.test(await p.locator('#invState').textContent()));
 await p.fill('[data-f="vacancy.value"]','15');
 await p.locator('[data-f="vacancy.value"]').dispatchEvent('change');
 await p.waitForTimeout(1000);
 await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(1000);
 await p.click('#invDraftBanner button:has-text("Discard")'); await p.waitForTimeout(200);
 ok('Discard drops the kept copy and the offer',
    (await draftOf())===null && (await p.locator('#invDraftBanner .inv-draft').count())===0
    && await p.evaluate(()=>Math.abs(FSInvestmentUI._state().input.vacancy.value-0.14)<1e-9));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
