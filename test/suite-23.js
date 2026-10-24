// Suite 23 — Budgeting v2 estimates: New Budget → Estimate Any Project Type,
// the type picker, quick mode, location, mixed-use with phases and a shared
// element, the custom builder, line overrides, the source drawer, scenarios,
// sensitivity, exports, save and reopen, the per-component pro forma handoff,
// project files, and a phone-width layout. Classic budgets must not change.
const { chromium } = require('playwright');
const fs = require('fs');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
const BASE='http://127.0.0.1:8100';
const num=t=>+String(t||'').replace(/[^0-9.\-]/g,'');
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const ctx=await b.newContext({viewport:{width:1400,height:1000},acceptDownloads:true});
 const p=await ctx.newPage();
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto(BASE+'/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);
 await p.evaluate(async()=>{
   await fetch('/api/budget/OP-2301?scope=project',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,name:'Harbor Point',address:'1 Bay Rd, Kemah TX'})});
 });

 // ---------- 1. New Budget offers the estimate first ----------
 await p.click('button:has-text("+ New Budget")'); await p.waitForTimeout(300);
 const first=await p.evaluate(()=>document.querySelector('#newBudgetModal .tpl-list .tpl-row .tpl-name').textContent.trim());
 ok('New Budget leads with Estimate Any Project Type', first==='Estimate Any Project Type', first);
 await p.click('#newBudgetModal .tpl-row:has-text("Estimate Any Project Type")'); await p.waitForTimeout(500);
 await p.selectOption('#nbProject','OP-2301');
 await p.fill('#nbName','Harbor Point Hotel');
 await p.click('#nbCreate'); await p.waitForTimeout(800);
 ok('the type picker opens on the Inputs page', await p.locator('.v2-picker').isVisible());
 ok('the classic unit-mix card is hidden for an estimate', !(await p.locator('#page-input section:has-text("Unit Mix")').isVisible()));
 const nTypes=await p.locator('.v2-type').count();
 ok('the picker lists 90+ types grouped by category', nTypes>=90 && await p.locator('.v2-cat').count()>=9, String(nTypes));

 // ---------- 2. search and pick ----------
 await p.fill('.v2-search[data-ui="q"]','marina'); await p.waitForTimeout(200);
 ok('search narrows the list', await p.locator('.v2-type').count()<5);
 await p.fill('.v2-search[data-ui="q"]','select-service'); await p.waitForTimeout(200);
 await p.click('.v2-type[data-type="hotel-select-service"]'); await p.waitForTimeout(400);
 const t1=num(await p.textContent('.v2-total'));
 ok('quick mode shows a total right away', t1>1e6, String(t1));
 ok('the baseline field shows the researched default as its placeholder',
    +(await p.getAttribute('[data-f$=".baseline.price"]','placeholder'))>50000);
 ok('the researched range and a Sources link are shown', /Researched \$[\d,]+–\$[\d,]+/.test(await p.textContent('.v2-pricehelp'))
    && await p.locator('.v2-pricehelp [data-act="source-type"]').count()===1);

 // ---------- 3. inputs move the total ----------
 await p.fill('[data-f$=".size"]','150'); await p.waitForTimeout(250);
 const t2=num(await p.textContent('.v2-total'));
 ok('more keys cost more', t2>t1, t1+' → '+t2);
 await p.selectOption('[data-f="p.location.region"]','CA-SanFrancisco'); await p.waitForTimeout(250);
 const t3=num(await p.textContent('.v2-total'));
 ok('a high-cost location raises the total', t3>t2*1.1, t2+' → '+t3);
 await p.selectOption('[data-f="p.location.region"]','TX-Houston'); await p.waitForTimeout(250);
 await p.fill('[data-f$=".baseline.price"]','150000'); await p.selectOption('[data-f$=".baseline.basis"]','local'); await p.waitForTimeout(250);
 const hardLocal=await p.evaluate(()=>FSBudgetV2.result().lines.filter(l=>l.category==='hard'&&(/:div:/.test(l.key)||l.carveOut)).reduce((s,l)=>s+l.amount,0));
 const esc=await p.evaluate(()=>FSBudgetV2.result().phases[0].escalation.factor);
 const qf=await p.evaluate(()=>FSBudgetV2.result().components[0].factors);
 // Fixed in-baseline items do not scale with size, so this is a ratio check: a
 // regional factor (Houston ≈ 0.82) would move it ~18%.
 ok('a local baseline price is not regionalized (≈ baseline × size × size factor × escalation)',
    Math.abs(hardLocal/(150000*150*qf.size*esc)-1)<0.005, hardLocal+' vs '+150000*150*qf.size*esc);
 await p.fill('[data-f$=".baseline.price"]',''); await p.selectOption('[data-f$=".baseline.basis"]','national'); await p.waitForTimeout(250);

 // ---------- 4. save, then the budget page detail ----------
 await p.click('#page-input [data-save-btn]'); await p.waitForTimeout(1200);
 const saved=await p.evaluate(()=>({dirty,id:doc.projectId,type:doc.type}));
 ok('an estimate saves', !saved.dirty && /^BDG-2301-\d\d$/.test(saved.id), JSON.stringify(saved));
 ok('the budget type is the project type', saved.type==='Select-service hotel', saved.type);
 await p.click('[data-act="goto-detail"]'); await p.waitForTimeout(500);
 ok('the Budget page shows the estimate detail, not the classic grid',
    await p.locator('#v2Detail .v2-tree').isVisible() && !(await p.locator('#sec-budget').isVisible()));
 const totDetail=num(await p.textContent('.v2-stats .stat .v'));
 const parts=await p.evaluate(()=>parts().project);
 ok('the detail total is the classic budget arithmetic total', Math.abs(totDetail-parts)<1, totDetail+' vs '+parts);

 // ---------- 5. override a line, then reset ----------
 await p.click('[data-act="expand-all"]'); await p.waitForTimeout(300);
 const firstOv=p.locator('.v2-ov').first();
 const key=await firstOv.getAttribute('data-ov');
 const before=num(await firstOv.inputValue());
 await firstOv.fill(String(Math.round(before+250000))); await firstOv.press('Tab'); await p.waitForTimeout(400);
 const afterTot=await p.evaluate(()=>FSBudgetV2.result().totals.total);
 ok('an override marks the line edited', await p.locator('.v2-edited').count()===1);
 ok('an override flows into the total (with contingency and soft costs following)', afterTot>parts+250000, parts+' → '+afterTot);
 ok('the override is stored on the project', await p.evaluate(k=>!!doc.engine.overrides[k],key));
 await p.click('.v2-edited [data-act="reset-ov"]'); await p.waitForTimeout(300);
 ok('reset puts the line back', await p.locator('.v2-edited').count()===0
    && Math.abs(await p.evaluate(()=>FSBudgetV2.result().totals.total)-parts)<1);

 // ---------- 6. source drawer ----------
 await p.click('.v2-line [data-act="source"] >> nth=0'); await p.waitForTimeout(300);
 ok('a line opens its source trail', await p.locator('.v2-drawer').isVisible()
    && /research|Derived|derived/i.test(await p.textContent('.v2-drawer')));
 await p.keyboard.press('Escape'); await p.waitForTimeout(200);
 ok('Escape closes the drawer', !(await p.locator('.v2-drawer').count()));

 // ---------- 7. views ----------
 await p.click('[data-act="view"][data-view="draws"]'); await p.waitForTimeout(300);
 ok('a draw schedule renders by month', await p.locator('#v2Detail .v2-bar').count()>5);
 await p.click('[data-act="view"][data-view="scenarios"]'); await p.waitForTimeout(300);
 await p.click('[data-act="add-scenario"]'); await p.waitForTimeout(300);
 await p.selectOption('[data-f$=".q"]','premium'); await p.waitForTimeout(400);
 const scen=await p.evaluate(()=>[...document.querySelectorAll('#v2Detail .v2-tbl tbody tr:first-child td')].map(t=>t.textContent));
 ok('scenarios compare side by side', scen.length===3 && num(scen[2])>num(scen[1]), JSON.stringify(scen));
 await p.click('[data-act="view"][data-view="sensitivity"]'); await p.waitForTimeout(500);
 ok('sensitivity ranks the drivers', await p.locator('.v2-tornado tbody tr').count()>=5);
 await p.click('[data-act="view"][data-view="sources"]'); await p.waitForTimeout(300);
 ok('sources & assumptions list linked evidence', await p.locator('#v2Detail .v2-tbl a[href^="http"]').count()>3);

 // ---------- 8. exports ----------
 const [x]=await Promise.all([p.waitForEvent('download'),p.click('[data-act="export-xlsx"]')]);
 const xp=await x.path();
 ok('the estimate exports to Excel', /\.xlsx$/.test(x.suggestedFilename()) && fs.statSync(xp).size>10000, x.suggestedFilename());
 const [pd]=await Promise.all([p.waitForEvent('download'),p.click('[data-act="export-pdf"]')]);
 const pp=await pd.path();
 ok('the estimate exports to PDF', fs.readFileSync(pp).slice(0,5).toString()==='%PDF-', pd.suggestedFilename());

 // ---------- 9. mixed use: components, phases, shared ----------
 await p.click('.wf-steps button:has-text("Inputs") >> nth=0').catch(()=>p.evaluate(()=>go('input'))); await p.waitForTimeout(300);
 if(!(await p.locator('#v2Inputs').isVisible()))await p.evaluate(()=>go('input'));
 await p.click('[data-act="mode"][data-mode="mixed"]'); await p.waitForTimeout(300);
 await p.click('[data-act="open-picker"][data-purpose="add"]'); await p.waitForTimeout(200);
 await p.fill('.v2-search[data-ui="q"]','strip'); await p.click('.v2-type[data-type="retail-strip"]'); await p.waitForTimeout(300);
 await p.click('[data-act="add-phase"]'); await p.waitForTimeout(300);
 await p.click('[data-act="add-shared"]'); await p.waitForTimeout(300);
 await p.selectOption('[data-f^="sh."][data-f$=".itemId"]','parking-structured-above');
 await p.fill('[data-f^="sh."][data-f$=".qty"]','200'); await p.press('[data-f^="sh."][data-f$=".qty"]','Tab'); await p.waitForTimeout(300);
 const ids=await p.evaluate(()=>({c:doc.engine.components.map(c=>c.id),ph:doc.engine.phases.map(x=>x.id)}));
 await p.selectOption(`[data-f="c.${ids.c[1]}.phaseId"]`,ids.ph[1]); await p.waitForTimeout(300);
 const mx=await p.evaluate(()=>{const r=FSBudgetV2.result();const c=x=>Math.round(x*100);
   return {comp:r.components.reduce((s,x)=>s+c(x.totals.total),0)+r.lines.filter(l=>!l.comp).reduce((s,l)=>s+c(l.amount),0),
     ph:r.phases.reduce((s,x)=>s+c(x.totals.total),0),tot:c(r.totals.total),shared:r.shared[0]&&r.shared[0].shares.length,
     p2:r.phases[1].start,gantt:document.querySelectorAll('.v2-gantt-bar').length};});
 ok('component totals add up to the project total', mx.comp===mx.tot, JSON.stringify(mx));
 ok('phase totals add up to the project total', mx.ph===mx.tot);
 ok('the shared garage is split across both components', mx.shared===2);
 ok('phase 2 follows phase 1 on the timeline', !!mx.p2 && mx.gantt===2);

 // ---------- 10. custom builder ----------
 await p.click('[data-act="mode"][data-mode="custom"]'); await p.waitForTimeout(300);
 await p.click('[data-act="add-custom"]'); await p.waitForTimeout(300);
 await p.fill('.v2-search[data-ui="blockQ"]','pool'); await p.waitForTimeout(200);
 const tb=num(await p.textContent('.v2-total'));
 await p.click('.v2-blockbtn >> nth=0'); await p.waitForTimeout(300);
 ok('a building block adds to the custom component and the total', num(await p.textContent('.v2-total'))>tb);

 // ---------- 11. save, reopen, pro forma per component ----------
 await p.click('#page-input [data-save-btn]'); await p.waitForTimeout(1200);
 const pid=await p.evaluate(()=>doc.projectId);
 const savedTotal=await p.evaluate(()=>FSBudgetV2.result().totals.total);
 await p.goto(BASE+'/index.html#/budget/'+pid,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
 ok('a reopened estimate shows the same total and opens clean',
    Math.abs(await p.evaluate(()=>FSBudgetV2.result().totals.total)-savedTotal)<0.01 && !(await p.evaluate(()=>dirty)));
 const scopeVal=await p.$$eval('[data-ui="scope"] option',o=>o.map(x=>x.value).find(v=>/^component:/.test(v)));
 await p.selectOption('[data-ui="scope"]',scopeVal); await p.waitForTimeout(200);
 const compId=scopeVal.split(':')[1];
 const compTotal=await p.evaluate(id=>FSBudgetV2.result().components.find(c=>c.id===id).totals.total,compId);
 await p.click('[data-act="proforma"]'); await p.waitForTimeout(1800);
 const an=await p.evaluate(async()=>{const id=location.hash.split('/')[2];
   const r=await fetch('/api/investment-analysis/'+id);return r.ok?await r.json():null;});
 const inp=an&&(an.input||an.inputDoc||an.analysis&&an.analysis.input);
 ok('the pro forma opens from the chosen component', /#\/analysis\//.test(await p.evaluate(()=>location.hash)));
 ok('its purchase price is that component’s total cost', !!inp && Math.abs(inp.acquisition.basis.value-compTotal)<1,
    inp?inp.acquisition.basis.value+' vs '+compTotal:'no input');
 ok('the scope is recorded for re-sync', !!inp && inp.source && inp.source.scope && inp.source.scope.id===compId);

 // ---------- 12. classic budgets are untouched ----------
 await p.evaluate(()=>{location.hash='#/home';}); await p.waitForTimeout(500);
 await p.click('button:has-text("+ New Budget")'); await p.waitForTimeout(300);
 await p.click('#newBudgetModal .tpl-row:has-text("Multifamily")'); await p.waitForTimeout(500);
 await p.selectOption('#nbProject','OP-2301'); await p.fill('#nbName','Classic'); await p.click('#nbCreate'); await p.waitForTimeout(800);
 ok('a Multifamily template budget still shows the classic inputs',
    await p.locator('#page-input section:has-text("Unit Mix")').isVisible() && !(await p.locator('#v2Inputs').isVisible()));
 ok('…and has no engine', await p.evaluate(()=>!doc.engine));

 // ---------- 13. phone width ----------
 const m=await ctx.newPage(); await m.setViewportSize({width:390,height:844});
 await m.goto(BASE+'/index.html#/inputs/'+pid,{waitUntil:'networkidle'}); await m.waitForTimeout(1200);
 const over=await m.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth);
 ok('the estimate inputs fit a phone without horizontal page scroll', over<=1, 'overflow '+over);
 ok('the total is visible on a phone', await m.locator('.v2-total').isVisible());

 ok('no JS errors', errs.length===0, errs.slice(0,3).join(' | '));
 await b.close();
 }catch(e){ R.push('FAIL  harness — '+e.stack); }
 console.log(R.join('\n'));
 const f=R.filter(x=>x.startsWith('FAIL')).length;
 console.log(`\n${f} failures of ${R.length}`);
 process.exit(f?1:0);
})();
