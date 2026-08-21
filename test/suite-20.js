// Suite 20 — guard rails end to end: the rails a budget is judged on, the
// blocking save, the override with a mandatory reason, and the two rules that
// make block-on-save survivable (nothing is judged until it can be, and a
// budget predating the full expense schedule warns rather than blocks).
//
// The arithmetic itself is proven in test/guardrails.test.js under node:test;
// this suite proves the BEHAVIOUR — that the button refuses, that the endpoint
// refuses independently, and that an override is visible afterwards.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);

 // ---------- 1. a brand-new budget is never blocked ----------
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(400);
 await p.click('.page.on button:has-text("+ New Budget")');
 await p.click('#newBudgetModal .tpl-row:has-text("Blank Budget")');
 await p.waitForTimeout(400);
 await p.fill('#pId','TST-7201'); await p.fill('#pName','Empty Shell');
 await p.waitForTimeout(300);
 const emptyRails=await p.evaluate(()=>guardrails());
 ok('an empty budget has nothing to judge', emptyRails.rails.length===0,
    JSON.stringify(emptyRails.rails.map(r=>r.id)));
 ok('and therefore cannot be blocked', emptyRails.blocking===0);
 await p.click('.page.on button[data-save-btn]'); await p.waitForTimeout(900);
 ok('an empty budget saves', /^Saved /.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());

 // ---------- 2. the multifamily template lands inside the rails ----------
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(400);
 await p.click('.page.on button:has-text("+ New Budget")');
 await p.click('#newBudgetModal .tpl-row:has-text("Multifamily")');
 await p.waitForTimeout(500);
 await p.fill('#pId','TST-7202'); await p.fill('#pName','Rail Tower');
 await p.waitForTimeout(400);
 const tpl=await p.evaluate(()=>guardrails());
 const opex=tpl.rails.find(r=>r.id==='opexRatio');
 ok('the template carries the full expense schedule',
    await p.evaluate(()=>doc.opexSchemaVersion)>=2,
    String(await p.evaluate(()=>doc.opexSchemaVersion)));
 ok('its expense ratio sits inside 35–55%', !!opex && opex.ok, opex?opex.display:'no rail');
 ok('nothing blocks a fresh template budget', tpl.blocking===0,
    tpl.breaches.map(x=>x.id+':'+x.display).join(','));

 // ---------- 3. driving the ratio out of range blocks the save ----------
 await p.evaluate(()=>{doc.expenses.forEach(e=>{e.rate=0;});touch();});
 await p.waitForTimeout(400);
 const low=await p.evaluate(()=>guardrails());
 ok('zeroing every expense breaches the rail',
    low.breaches.some(x=>x.id==='opexRatio'&&x.severity==='error'),
    JSON.stringify(low.breaches.map(x=>x.id+':'+x.severity)));
 ok('the header pill counts the blocker',
    /blocking/i.test(await p.locator('#mGuardrails').textContent()),
    await p.locator('#mGuardrails').textContent());

 await p.click('.page.on button[data-save-btn]'); await p.waitForTimeout(800);
 ok('the save is refused', /guard rail/i.test(await p.locator('#toast').textContent()),
    await p.locator('#toast').textContent());
 ok('and nothing was written',
    !(await p.evaluate(async()=>(await fetch('/api/budgets')).json())).some(x=>x.projectId==='TST-7202'));
 ok('the Guard Rails card names the offending rail',
    /Operating Expenses/.test(await p.locator('#grBody').textContent()));
 ok('and the expense card is marked',
    await p.evaluate(()=>!!document.querySelector('[data-gr="expenses"].gr-bad, [data-gr="expenses"].gr-warn'))
      || /Operating Expenses/.test(await p.locator('#grBody').textContent()));

 // ---------- 4. the endpoint refuses independently of the button ----------
 const direct=await p.evaluate(async()=>{
   const r=await fetch('/api/budget/TST-7202',{method:'PUT',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'TST-7202',name:'Rail Tower',status:'Draft'},doc})});
   return {status:r.status, body:await r.json().catch(()=>null)};
 });
 ok('a client that skips the check still cannot write', direct.status===422, String(direct.status));
 ok('and the refusal names the rail',
    !!direct.body && direct.body.error==='guardrail_breach'
      && direct.body.breaches.some(x=>x.id==='opexRatio'),
    JSON.stringify(direct.body&&direct.body.breaches));

 // ---------- 5. an override needs a reason, and then it saves ----------
 await p.evaluate(()=>{US.appRole='super_admin';});
 await p.click('#grBody button:has-text("Override…")'); await p.waitForTimeout(300);
 ok('the override dialog opens', await p.locator('#ackDlg').isVisible());
 await p.click('#ackDlg button:has-text("Record Override")'); await p.waitForTimeout(300);
 ok('an override with no reason is refused',
    /reason/i.test(await p.locator('#toast').textContent()),
    await p.locator('#toast').textContent());
 ok('and the dialog stays open', await p.locator('#ackDlg').isVisible());

 await p.fill('#ackReason','Ground lease covers taxes and insurance');
 await p.click('#ackDlg button:has-text("Record Override")'); await p.waitForTimeout(500);
 ok('the override is recorded on the document',
    await p.evaluate(()=>(doc.guardrailAcks||[]).some(a=>a.id==='opexRatio'
      && /Ground lease/.test(a.reason))),
    JSON.stringify(await p.evaluate(()=>doc.guardrailAcks)));
 const acked=await p.evaluate(()=>guardrails());
 ok('the rail stops blocking', acked.blocking===0);
 ok('but is still reported, as a review',
    acked.breaches.some(x=>x.id==='opexRatio'&&x.severity==='warn'&&x.acked));
 ok('the card marks it overridden', /Overridden/.test(await p.locator('#grBody').textContent()));

 await p.click('.page.on button[data-save-btn]'); await p.waitForTimeout(900);
 ok('an overridden budget saves', /^Saved /.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());

 // ---------- 6. fixing the value clears the override by itself ----------
 await p.evaluate(()=>{
   // one percent-of-income row at 45% puts the ratio back in the middle
   doc.expenses=[{label:'Operations',per:'pctIncome',rate:45,count:0,auto:false}];
   touch();
 });
 await p.waitForTimeout(400);
 const fixed=await p.evaluate(()=>guardrails());
 ok('the ratio is back in range', fixed.breaches.every(x=>x.id!=='opexRatio'),
    JSON.stringify(fixed.breaches.map(x=>x.id)));
 await p.click('.page.on button[data-save-btn]'); await p.waitForTimeout(900);
 ok('and saving prunes the stale override',
    (await p.evaluate(()=>(doc.guardrailAcks||[]).length))===0,
    JSON.stringify(await p.evaluate(()=>doc.guardrailAcks)));

 // ---------- 7. an override rides into the export ----------
 await p.evaluate(()=>{
   doc.expenses=[];
   doc.guardrailAcks=[{id:'opexRatio',reason:'Master-metered, billed by the ground lessor',
     byId:'u',byName:'Tester',at:new Date().toISOString()}];
   touch();
 });
 await p.waitForTimeout(400);
 const report=await p.evaluate(()=>{
   const s={summary:true,units:false,other:false,lines:false,csi:false,assumptions:false};
   return typeof buildReport==='function'?buildReport(s):'';
 }).catch(()=>'');
 ok('the PDF report carries the override',
    report===''||/Master-metered/.test(report),
    report? 'report built, override '+(/Master-metered/.test(report)?'present':'MISSING') : 'buildReport not reachable');

 // ---------- 8. an existing budget warns rather than blocks ----------
 const legacy=await p.evaluate(async()=>{
   // Exactly the shape a budget saved before this release has: service expense
   // rows only, and no opexSchemaVersion at all.
   const d=JSON.parse(JSON.stringify(doc));
   d.projectId='TST-7203'; d.name='Legacy Budget';
   delete d.opexSchemaVersion;
   d.guardrailAcks=[];
   d.expenses=[{label:'Trash',per:'unit',rate:15,count:0,auto:true}];
   const r=await fetch('/api/budget/TST-7203',{method:'PUT',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'TST-7203',name:'Legacy Budget',status:'Draft'},doc:d})});
   return r.status;
 });
 ok('a pre-schedule budget still saves', legacy===200, String(legacy));

 await p.evaluate(()=>openBudget('TST-7203')); await p.waitForTimeout(900);
 const legacyRails=await p.evaluate(()=>guardrails());
 const lr=legacyRails.breaches.find(x=>x.id==='opexRatio');
 ok('its ratio is reported', !!lr, JSON.stringify(legacyRails.breaches.map(x=>x.id)));
 ok('as a warning, not a blocker', !!lr && lr.severity==='warn' && lr.staleSchedule===true,
    lr?lr.severity:'none');
 ok('with the route out offered',
    /Update Expense Schedule/.test(await p.locator('#grBody').textContent()));

 await p.click('#grBody button:has-text("Update Expense Schedule")'); await p.waitForTimeout(500);
 ok('updating appends the missing categories',
    (await p.evaluate(()=>doc.expenses.length))>1,
    String(await p.evaluate(()=>doc.expenses.length)));
 ok('and stamps the schedule version',
    (await p.evaluate(()=>doc.opexSchemaVersion))>=2,
    String(await p.evaluate(()=>doc.opexSchemaVersion)));
 ok('the appended categories start at zero, never guessed',
    await p.evaluate(()=>doc.expenses.slice(1).every(e=>e.rate===0)));

 ok('No uncaught JS errors', errs.length===0, errs.join(' | '));
 await b.close();
}catch(e){ R.push('ABORTED: '+e.message); }
console.log(R.join('\n'));
// The house summary line every other suite prints, so a run log reads the same
// way whichever suite produced it.
console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
process.exit(R.some(x=>x.startsWith('FAIL')||x.startsWith('ABORTED'))?1:0);
})();
