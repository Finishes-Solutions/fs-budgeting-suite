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

 // ---------- 2. a project is created explicitly; a budget belongs to it ----------
 // A budget id can no longer name a project, so saving one does not conjure
 // its parent. The project is made first, with its own OP-#### identity.
 await p.click('#page-projects button:has-text("+ Create Project")');
 await p.waitForTimeout(500);
 await p.fill('#npId','OP-7301');
 await p.fill('#npName','Harbour Point');
 await p.fill('#npAddress','5 Dock Road');
 await p.click('#npCreate'); await p.waitForTimeout(1000);

 await p.click('#nav-projects'); await p.waitForTimeout(900);
 ok('the project is listed under its OP-#### id',
    /OP-7301/.test(await p.locator('#projectsBody').textContent()),
    (await p.locator('#projectsBody').textContent()).slice(0,160));
 ok('and no budget id is showing in the PROJECT ID column',
    !/BD-|TST-/.test(await p.evaluate(()=>[...document.querySelectorAll('#projectsBody .pj-id')]
      .map(e=>e.textContent).join(' '))),
    await p.evaluate(()=>[...document.querySelectorAll('#projectsBody .pj-id')].map(e=>e.textContent).join(' ')));
 const list=await p.evaluate(()=>FSProjects._list());
 ok('exactly one project per ID',
    list.projects.filter(x=>x.projectId==='OP-7301').length===1,
    JSON.stringify(list.projects.map(x=>x.projectId)));
 ok('it starts in the pipeline, not converted',
    list.projects.find(x=>x.projectId==='OP-7301').status==='Lead');

 // its first budget, created from the project so the name and address carry
 await p.click('#projectsBody tr:has-text("OP-7301")'); await p.waitForTimeout(900);
 await p.click('#page-project button:has-text("+ New Budget")');
 await p.waitForTimeout(700);
 await p.click('#newBudgetModal .tpl-row:has-text("Multifamily")');
 await p.waitForTimeout(800);
 await p.fill('#nbId','BD-7301');
 await p.click('#nbCreate'); await p.waitForTimeout(800);
 ok('the budget carries the project name and address across',
    (await p.inputValue('#pName'))==='Harbour Point'
      && (await p.inputValue('#pAddr'))==='5 Dock Road',
    await p.inputValue('#pName')+' | '+await p.inputValue('#pAddr'));
 await p.click('.page.on button[data-save-btn]'); await p.waitForTimeout(1200);
 ok('the budget saved', /^Saved /.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());

 // ---------- 3. the detail page shows what belongs to it ----------
 await p.click('#nav-projects'); await p.waitForTimeout(700);
 await p.click('#projectsBody tr:has-text("OP-7301")'); await p.waitForTimeout(900);
 ok('the project route carries its id', /#\/project\/OP-7301$/.test(p.url()), p.url());
 ok('the title names the project by its OP id, never a budget id',
    /^OP-7301 — Harbour Point/.test((await p.locator('#projectTitle').textContent()).trim()),
    await p.locator('#projectTitle').textContent());
 ok('its budget is listed under its own BD id',
    /BD-7301/.test(await p.locator('#projectBody').textContent()));
 ok('the budget is marked primary',
    /Primary/.test(await p.locator('#projectBody').textContent()));
 ok('guard-rail state is reported per budget',
    /Clear|blocking|to review|Not evaluated/.test(await p.locator('#projectBody').textContent()));

 // ---------- 4. an alternate budget under the same project ----------
 await p.click('#projectBody button:has-text("+ Add Alternate Budget")');
 await p.waitForTimeout(1200);
 ok('the alternate takes a namespaced id',
    (await p.inputValue('#pId'))==='BD-7301-02', await p.inputValue('#pId'));
 ok('it starts as a copy, not a blank sheet',
    (await p.evaluate(()=>doc.lines.length))>0,
    String(await p.evaluate(()=>doc.lines.length)));
 ok('and is unsaved until the user decides',
    /unsaved/i.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());
 await p.click('.page.on button[data-save-btn]'); await p.waitForTimeout(1100);
 ok('the alternate saves under the widened ID format',
    /^Saved /.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());

 await p.evaluate(()=>FSProjects.show('OP-7301',true)); await p.waitForTimeout(1000);
 const det=await p.evaluate(()=>FSProjects._detail());
 ok('both budgets hang off the one project', det.budgets.length===2,
    JSON.stringify(det.budgets.map(x=>x.projectId)));
 ok('the alternate is labelled as one',
    det.budgets.some(x=>x.projectId==='BD-7301-02'&&x.isAlternate));
 ok('and the base is still the primary',
    det.budgets.some(x=>x.projectId==='BD-7301'&&x.isPrimary));
 ok('there is still exactly one project',
    (await p.evaluate(async()=>(await (await fetch('/api/budgets?scope=projects')).json())
      .projects.filter(x=>x.projectId==='OP-7301').length))===1);

 // ---------- 5. an analysis rolls up to the project ----------
 const made=await p.evaluate(async()=>{
   const r=await fetch('/api/investment-analyses',{method:'POST',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({mode:'fromBudget',projectId:'BD-7301',analysisName:'Harbour Underwriting'})});
   return r.status;
 });
 ok('an analysis can be created from the budget', made===201, String(made));
 await p.evaluate(()=>FSProjects.show('OP-7301',true)); await p.waitForTimeout(1000);
 ok('and it appears under the project',
    /Harbour Underwriting/.test(await p.locator('#projectBody').textContent()));

 // ---------- 5b. the page as the review asked for it ----------
 // Four headline numbers as real cards, carrying the number and nothing that
 // merely restates their own label.
 ok('the four project metrics are cards',
    (await p.locator('#projectBody .pj-stat').count())===4,
    String(await p.locator('#projectBody .pj-stat').count()));
 ok('and they have dropped the restating sub-lines',
    !/Live, from the primary budget|All within guard rails|Linked to this project/
      .test(await p.locator('#projectBody').textContent()));
 ok('the metadata line capitalises and pluralises its counts',
    /2 Budgets/.test(await p.locator('#projectSub').textContent())
      && /1 Analysis/.test(await p.locator('#projectSub').textContent()),
    await p.locator('#projectSub').textContent());

 // Budget ID and Budget Name are two columns, not one stacked cell.
 const bHead=await p.evaluate(()=>[...document.querySelectorAll('#projectBody .pj-tbl-budgets thead th')]
   .map(t=>t.textContent.trim()));
 ok('the Budgets table splits the id from the name',
    bHead.includes('Budget ID')&&bHead.includes('Budget Name'), bHead.join('|'));

 // Open → is gone from both tables; the shared ⋮ row menus replace it.
 ok('neither table still ends in a bare Open link',
    (await p.locator('#projectBody .pj-go').count())===0);
 await p.locator('#projectBody .pj-tbl-budgets .rowmenu-btn').first().click();
 await p.waitForTimeout(250);
 const bMenu=await p.locator('#rowMenu').textContent();
 ok('a budget row opens the same menu the Budgets tab uses',
    /Edit/.test(bMenu)&&/Versions/.test(bMenu)&&/Update Pricing/.test(bMenu)
      &&/Favorites/.test(bMenu), bMenu);
 await p.keyboard.press('Escape'); await p.waitForTimeout(250);
 ok('Escape closes it', await p.evaluate(()=>document.getElementById('rowMenu').style.display==='none'));

 await p.locator('#projectBody .pj-tbl-analyses .rowmenu-btn').first().click();
 await p.waitForTimeout(250);
 const aMenu=await p.locator('#invRowMenu').textContent();
 ok('an analysis row opens the analysis menu',
    /Open Analysis/.test(aMenu)&&/Versions/.test(aMenu)&&/Favorites/.test(aMenu), aMenu);
 await p.keyboard.press('Escape'); await p.waitForTimeout(250);

 // Add Investment Analysis: two budgets here, so it must ASK which one.
 ok('the analyses card carries an Add Investment Analysis button',
    await p.locator('#projectBody button:has-text("+ Add Investment Analysis")').isVisible());
 await p.click('#projectBody button:has-text("+ Add Investment Analysis")');
 await p.waitForTimeout(400);
 ok('with two budgets it asks which one', await p.locator('#invPickModal').isVisible());
 const pickTxt=await p.locator('#invPickModal').textContent();
 ok('and offers only this project\u2019s budgets',
    /BD-7301/.test(pickTxt)&&!/TST-9911|BD-0001\b/.test(pickTxt), pickTxt.slice(0,200));
 await p.keyboard.press('Escape'); await p.waitForTimeout(300);
 ok('Escape closes the picker', !(await p.locator('#invPickModal').isVisible()));

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
   const doc2=await (await fetch('/api/budget/BD-7301')).json();
   doc2.projectCosts.land=(doc2.projectCosts.land||0)+5000000;
   await fetch('/api/budget/BD-7301',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:{projectId:'BD-7301',name:'Harbour Point',status:'Draft'},doc:doc2})});
 });
 await p.evaluate(()=>FSProjects.show('OP-7301',true)); await p.waitForTimeout(1000);
 const after=await p.evaluate(()=>FSProjects._detail().project);
 ok('editing the budget afterwards does not restate the snapshot',
    Math.abs(after.contractAmount-conv.contractAmount)<0.01,
    after.contractAmount+' vs '+conv.contractAmount);
 ok('while the live figure did move',
    after.liveProjectCost>conv.projectAmount,
    after.liveProjectCost+' vs '+conv.projectAmount);

 // ---------- 8. the index reports converted totals ----------
 await p.click('#nav-projects'); await p.waitForTimeout(1000);
 ok('the index metrics are cards too',
    (await p.locator('#projectsBody .pj-stat').count())===4,
    String(await p.locator('#projectsBody .pj-stat').count()));
 ok('and only the one number that needs context keeps a sub-line',
    !/still in pipeline|Snapshot taken at conversion/.test(await p.locator('#projectsBody').textContent())
      && /% of all projects/.test(await p.locator('#projectsBody').textContent()));
 const pHead=await p.evaluate(()=>[...document.querySelectorAll('#projectsBody thead th')]
   .map(t=>t.textContent.trim()));
 ok('the index splits Project ID from Project Name',
    pHead.includes('Project ID')&&pHead.includes('Project Name'), pHead.join('|'));

 // The same three views every other list offers, stored with the account.
 ok('a view selector sits beside the count',
    (await p.locator('#projectsBody [data-projectview-pick]').count())===3);
 await p.click('#projectsBody [data-projectview-pick="cards"]'); await p.waitForTimeout(600);
 ok('Card view renders cards instead of rows',
    (await p.locator('#projectsBody .hm-card').count())>0
      && (await p.locator('#projectsBody table').count())===0,
    String(await p.locator('#projectsBody .hm-card').count()));
 await p.waitForTimeout(1200);        // the settings save is debounced, like every preference
 ok('and the choice is stored on the account',
    (await p.evaluate(async()=>(await (await fetch('/api/user-settings')).json()).settings.projectView))==='cards');
 await p.click('#projectsBody [data-projectview-pick="compact"]'); await p.waitForTimeout(600);
 ok('Compact view is the list at the compact density',
    await p.evaluate(()=>{
      const w=document.querySelector('#projectsBody .pj-tbl-index');
      return !!w && w.closest('[data-density]').getAttribute('data-density')==='compact';
    }));
 await p.click('#projectsBody [data-projectview-pick="comfortable"]'); await p.waitForTimeout(600);

 ok('the index counts converted projects',
    /Converted to Project/.test(await p.locator('#projectsBody').textContent()));
 ok('and reports the captured contract amount',
    /Converted Contract Amount/.test(await p.locator('#projectsBody').textContent()));

 // ---------- 9. a project id is not a budget id ----------
 // Two namespaces, and the API refuses to confuse them in either direction.
 const asProject=await p.evaluate(async()=>{
   const out={};
   for(const id of ['BD-7301','BD-7301-02','TST-7301']){
     out[id]=(await fetch('/api/budgets?scope=project&id='+id)).status;
   }
   return out;
 });
 ok('a budget id is not a project id', Object.values(asProject).every(s2=>s2===404),
    JSON.stringify(asProject));
 const asBudget=await p.evaluate(async()=>(await fetch('/api/budget/OP-7301')).status);
 ok('and a project id is not a budget id', asBudget===404, String(asBudget));
 const shapes=await p.evaluate(async()=>{
   const d=await (await fetch('/api/budgets?scope=project&id=OP-7301')).json();
   return {project:d.project.projectId, budgets:d.budgets.map(x=>x.projectId)};
 });
 ok('the project reports an OP-#### id and its budgets report BD- ids',
    /^OP-\d{4}$/.test(shapes.project) && shapes.budgets.every(x=>/^BD-\d{4}(-\d{2})?$/.test(x)),
    JSON.stringify(shapes));

 ok('No uncaught JS errors', errs.length===0, errs.join(' | '));
 await b.close();
}catch(e){ R.push('ABORTED: '+e.message); }
console.log(R.join('\n'));
// The house summary line every other suite prints, so a run log reads the same
// way whichever suite produced it.
console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
process.exit(R.some(x=>x.startsWith('FAIL')||x.startsWith('ABORTED'))?1:0);
})();
