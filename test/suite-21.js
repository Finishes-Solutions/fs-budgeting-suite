// Suite 21 — Projects: one project per ID, the budgets and analyses that hang
// off it, alternate budgets under a namespaced id, the star that toggles
// everywhere, and the status flow that ends in Converted to Project —
// including the money snapshot that conversion takes.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);

 // ---------- 1. the tab exists and routes ----------
 ok('the primary nav carries Projects', await p.locator('#nav-projects').isVisible());
 await p.click('#nav-projects'); await p.waitForTimeout(700);
 ok('Projects routes to #/projects', /#\/projects$/.test(p.url()), p.url());
 ok('the Projects tab lights up',
    await p.locator('#nav-projects').evaluate(e=>e.classList.contains('on')));

 // ---------- 2. saving a budget creates its project ----------
 await p.click('#nav-budgets'); await p.waitForTimeout(400);
 await p.click('button:has-text("+ New Budget")');
 await p.click('#newBudgetModal .tpl-row:has-text("Multifamily")');
 await p.waitForTimeout(500);
 await p.fill('#pId','TST-7301'); await p.fill('#pName','Harbour Point');
 await p.fill('#pAddr','5 Dock Road');
 await p.waitForTimeout(300);
 await p.click('button[data-save-btn]'); await p.waitForTimeout(1000);
 ok('the budget saved', /^Saved /.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());

 await p.click('#nav-projects'); await p.waitForTimeout(900);
 ok('a project row appeared for it',
    /TST-7301/.test(await p.locator('#projectsBody').textContent()),
    (await p.locator('#projectsBody').textContent()).slice(0,160));
 const list=await p.evaluate(()=>FSProjects._list());
 ok('exactly one project per ID',
    list.projects.filter(x=>x.projectId==='TST-7301').length===1,
    JSON.stringify(list.projects.map(x=>x.projectId)));
 ok('it starts in the pipeline, not converted',
    list.projects.find(x=>x.projectId==='TST-7301').status==='Lead');

 // ---------- 3. the detail page shows what belongs to it ----------
 await p.click('#projectsBody tr:has-text("TST-7301")'); await p.waitForTimeout(900);
 ok('the project route carries its id', /#\/project\/TST-7301$/.test(p.url()), p.url());
 ok('the title names the project',
    /TST-7301/.test(await p.locator('#projectTitle').textContent()),
    await p.locator('#projectTitle').textContent());
 ok('its budget is listed',
    /TST-7301/.test(await p.locator('#projectBody').textContent()));
 ok('the budget is marked primary',
    /Primary/.test(await p.locator('#projectBody').textContent()));
 ok('guard-rail state is reported per budget',
    /Clear|blocking|to review|Not evaluated/.test(await p.locator('#projectBody').textContent()));

 // ---------- 4. an alternate budget under the same project ----------
 await p.click('#projectBody button:has-text("+ Add Alternate Budget")');
 await p.waitForTimeout(1200);
 ok('the alternate takes a namespaced id',
    (await p.inputValue('#pId'))==='TST-7301-02', await p.inputValue('#pId'));
 ok('it starts as a copy, not a blank sheet',
    (await p.evaluate(()=>doc.lines.length))>0,
    String(await p.evaluate(()=>doc.lines.length)));
 ok('and is unsaved until the user decides',
    /unsaved/i.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());
 await p.click('button[data-save-btn]'); await p.waitForTimeout(1100);
 ok('the alternate saves under the widened ID format',
    /^Saved /.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());

 await p.evaluate(()=>FSProjects.show('TST-7301',true)); await p.waitForTimeout(1000);
 const det=await p.evaluate(()=>FSProjects._detail());
 ok('both budgets hang off the one project', det.budgets.length===2,
    JSON.stringify(det.budgets.map(x=>x.projectId)));
 ok('the alternate is labelled as one',
    det.budgets.some(x=>x.projectId==='TST-7301-02'&&x.isAlternate));
 ok('and the base is still the primary',
    det.budgets.some(x=>x.projectId==='TST-7301'&&x.isPrimary));
 ok('there is still exactly one project',
    (await p.evaluate(async()=>(await (await fetch('/api/budgets?scope=projects')).json())
      .projects.filter(x=>x.projectId==='TST-7301').length))===1);

 // ---------- 5. an analysis rolls up to the project ----------
 const made=await p.evaluate(async()=>{
   const r=await fetch('/api/investment-analyses',{method:'POST',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({mode:'fromBudget',projectId:'TST-7301',analysisName:'Harbour Underwriting'})});
   return r.status;
 });
 ok('an analysis can be created from the budget', made===201, String(made));
 await p.evaluate(()=>FSProjects.show('TST-7301',true)); await p.waitForTimeout(1000);
 ok('and it appears under the project',
    /Harbour Underwriting/.test(await p.locator('#projectBody').textContent()));

 // ---------- 6. the star toggles, and the strip follows ----------
 ok('no Favorites strip before anything is starred',
    !/Favorites/.test(await p.locator('#projectBody').textContent()));
 await p.locator('#projectBody .hm-star').first().click(); await p.waitForTimeout(900);
 ok('starring says so', /Added to Favorites/i.test(await p.locator('#toast').textContent()),
    await p.locator('#toast').textContent());
 ok('a Favorites strip appears on the project',
    /Favorites/.test(await p.locator('#projectBody').textContent()));
 ok('the star reads as pressed',
    await p.locator('#projectBody .hm-star.is-on').first().isVisible());
 await p.locator('#projectBody .hm-star.is-on').first().click(); await p.waitForTimeout(900);
 ok('and clicking again removes it',
    /Removed from Favorites/i.test(await p.locator('#toast').textContent()),
    await p.locator('#toast').textContent());

 // ---------- 7. status, ending in Converted to Project ----------
 await p.click('#projectStatusHost .st-chip'); await p.waitForTimeout(300);
 const opts=await p.locator('#pjStMenu [data-st]').allTextContents();
 ok('the pipeline offers every stage',
    ['Lead','Qualified','Budgeting','Proposal Sent','Awarded','Converted to Project','On Hold','Lost']
      .every(s=>opts.some(o=>o.trim()===s)), opts.join('|'));
 ok('and ends in Converted to Project',
    opts[5] && opts[5].trim()==='Converted to Project', opts.join('|'));

 await p.locator('#pjStMenu [data-st="Awarded"]').click(); await p.waitForTimeout(900);
 const awarded=await p.evaluate(()=>FSProjects._detail().project);
 ok('a non-converting status does not stamp money',
    awarded.status==='Awarded' && awarded.contractAmount===null && awarded.convertedAt===null,
    JSON.stringify({s:awarded.status,c:awarded.contractAmount}));

 const liveBefore=awarded.liveContractSum;
 await p.click('#projectStatusHost .st-chip'); await p.waitForTimeout(300);
 await p.locator('#pjStMenu [data-st="Converted to Project"]').click(); await p.waitForTimeout(1100);
 const conv=await p.evaluate(()=>FSProjects._detail().project);
 ok('converting stamps the date', !!conv.convertedAt, String(conv.convertedAt));
 ok('and captures the contract amount from the primary budget',
    Math.abs(conv.contractAmount-liveBefore)<0.01,
    conv.contractAmount+' vs live '+liveBefore);
 ok('and the project amount too', conv.projectAmount>0, String(conv.projectAmount));
 ok('the page says the amounts are frozen',
    /no longer move with the budget/.test(await p.locator('#projectBody').textContent()));

 // The snapshot must NOT follow a later budget edit — that is the whole point.
 await p.evaluate(async()=>{
   const doc2=await (await fetch('/api/budget/TST-7301')).json();
   doc2.projectCosts.land=(doc2.projectCosts.land||0)+5000000;
   await fetch('/api/budget/TST-7301',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'TST-7301',name:'Harbour Point',status:'Draft'},doc:doc2})});
 });
 await p.evaluate(()=>FSProjects.show('TST-7301',true)); await p.waitForTimeout(1000);
 const after=await p.evaluate(()=>FSProjects._detail().project);
 ok('editing the budget afterwards does not restate the snapshot',
    Math.abs(after.contractAmount-conv.contractAmount)<0.01,
    after.contractAmount+' vs '+conv.contractAmount);
 ok('while the live figure did move',
    after.liveProjectCost>conv.projectAmount,
    after.liveProjectCost+' vs '+conv.projectAmount);

 // ---------- 8. the index reports converted totals ----------
 await p.click('#nav-projects'); await p.waitForTimeout(1000);
 ok('the index counts converted projects',
    /Converted to Project/.test(await p.locator('#projectsBody').textContent()));
 ok('and reports the captured contract amount',
    /Converted Contract Amount/.test(await p.locator('#projectsBody').textContent()));

 // ---------- 9. a project id is not a budget id ----------
 const bad=await p.evaluate(async()=>
   (await fetch('/api/budgets?scope=project&id=TST-7301-02')).status);
 ok('an alternate id is not a project id', bad===404, String(bad));

 ok('No uncaught JS errors', errs.length===0, errs.join(' | '));
 await b.close();
}catch(e){ R.push('ABORTED: '+e.message); }
console.log(R.join('\n'));
process.exit(R.some(x=>x.startsWith('FAIL')||x.startsWith('ABORTED'))?1:0);
})();
