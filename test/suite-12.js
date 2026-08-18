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
 ok('missing assumptions are rejected with highlighted fields',
    (await p.locator('.inv-err').count())>0 && /need attention/.test(await p.locator('#invErrSummary').textContent()));

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

 // save → version 1; reload and compare the persisted report values
 // (report fidelity is asserted against the SAVED canonical result below)
 await p.click('#invSaveBtn'); await p.waitForTimeout(800);
 ok('save shows the Saved pill', /Saved/.test(await p.locator('#invState').textContent()),
    await p.locator('#invState').textContent());
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
 const rpt3=await p.locator('#invReport').textContent();
 ok('financed recalculation adds mortgage, DSCR and leverage', /DSCR/.test(rpt3)&&/Leverage Impact/.test(rpt3));
 ok('monthly payment appears in the mortgage step', /\$[\d,]+\.\d\d/.test(await p.locator('#invMonthlyPay').inputValue()));

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

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
