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

 // Ctrl+S with no budget open should say so, not throw
 await p.keyboard.press(MOD+'+s'); await p.waitForTimeout(300);
 ok('Ctrl+S with no budget gives guidance',
    /Open or create a budget first/.test(await p.locator('#toast').textContent()));

 // A budget belongs to a project, so the parent is made first and chosen in
 // step 2 of the dialog — a budget id can no longer imply one.
 await p.evaluate(async a=>{
   await fetch('/api/budget/'+a.p+'?scope=project',{method:'PUT',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,name:a.n,address:'1 Test Way'})});
 },{p:'OP-0901',n:'Shortcut Save'});
 await p.click('button:has-text("+ New Budget")').then(()=>p.click('#newBudgetModal .tpl-row[data-tpl="multifamily"]'));
 await p.waitForTimeout(700);
 await p.selectOption('#nbProject','OP-0901');
 await p.fill('#nbId','TST-9996');
 await p.fill('#nbName','Shortcut Save');
 await p.click('#nbCreate');
 await p.waitForTimeout(700);

 await p.fill('#pId','TST-9996'); await p.fill('#pName','Shortcut Save');
 await p.waitForTimeout(200);
 ok('dirty before save', /unsaved/i.test(await p.locator('#saveState').textContent()));

 // Ctrl+S from the Inputs page
 await p.keyboard.press(MOD+'+s');
 await p.waitForTimeout(900);
 ok('Ctrl+S saves from Inputs', /^Saved /.test(await p.locator('#saveState').textContent()),
    await p.locator('#saveState').textContent());
 ok('budget really persisted',
    (await p.evaluate(async()=>(await fetch('/api/budgets')).json())).some(x=>x.projectId==='TST-9996'));

 // it must commit the focused field first, not save a stale value
 await p.click(".page.on [data-wf-pills] a:has-text('Budget')"); await p.waitForTimeout(400);
 const rate=p.locator('#budBody input[data-k$=".unit"]').first();
 await rate.click(); await rate.fill('12.34');
 await p.keyboard.press(MOD+'+s');                 // saving while the field still has focus
 await p.waitForTimeout(900);
 const saved=await p.evaluate(async()=>(await fetch('/api/budget/TST-9996')).json());
 ok('Ctrl+S commits the focused field before saving', saved.lines[0].unit===12.34, 'stored '+saved.lines[0].unit);
 ok('pill reads Saved after shortcut', /^Saved /.test(await p.locator('#saveState').textContent()));

 // the browser's own save dialog must be suppressed
 const prevented=await p.evaluate(()=>new Promise(res=>{
   document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='s')res(e.defaultPrevented);},{once:true});
   const ev=new KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true,cancelable:true});
   document.dispatchEvent(ev);
 }));
 ok('browser save dialog is suppressed', prevented===true);

 // ---- server budget-calc parity: the same document must total identically in
 // the browser and in api/shared/budget-calc.js, and stored summary money must
 // come from the doc, not from client meta.
 const calc = require('../api/shared/budget-calc');
 const pageState = await p.evaluate(()=>({doc:JSON.parse(JSON.stringify(doc)),
   parts:parts(), gross:grossIncome()}));
 const sp = calc.parts(pageState.doc), sg = calc.grossIncome(pageState.doc);
 const close=(a,z)=>Math.abs(a-z)<0.005;
 ok('server parts() matches the browser on a live document',
    ['res','amen','soft','hard','profit','cont','contract','fees','project']
      .every(k=>close(sp[k],pageState.parts[k])),
    JSON.stringify(sp)+' vs '+JSON.stringify(pageState.parts));
 ok('server grossIncome() matches the browser',
    ['rentMo','otherMo','expMo','netOtherMo','grossYr','netYr']
      .every(k=>close(sg[k],pageState.gross[k])));
 // Tamper: a forged meta.contractSum must not survive the save.
 const tampered = await p.evaluate(async()=>{
   const m={projectId:doc.projectId,name:doc.name,type:'Multifamily',status:'Draft',
            contractSum:999999999,projectCost:1};
   await fetch('/api/budget/TST-9996',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({meta:m,doc})});
   return (await (await fetch('/api/budgets')).json()).find(x=>x.projectId==='TST-9996');
 });
 ok('a forged contractSum is ignored — totals derive from the document',
    close(tampered.contractSum, sp.contract) && close(tampered.projectCost, sp.project),
    'stored '+tampered.contractSum+' expected '+sp.contract);

 // The Budget Assistant. The mock runs the real api/shared/budget-assistant.js
 // with a deterministic stand-in for Claude that quotes the facts it was given,
 // so what is pinned is that the SERVER'S figures reach the model, a tool round
 // works, an unsaved draft is what gets read, and the dialog behaves.
 const usd0=n=>'$'+Math.round(n).toLocaleString('en-US');
 await p.click('.page.on button:has-text("Ask AI")'); await p.waitForTimeout(300);
 ok('Ask AI opens the assistant on this budget',
    await p.locator('#assistantPanel.on').count()===1
    && /TST-9996/.test(await p.locator('#aiSub').textContent()));
 ok('the panel docks on the right and leaves the budget usable beside it',
    await p.evaluate(()=>{const r=document.getElementById('assistantPanel').getBoundingClientRect();
      return Math.abs(r.right-window.innerWidth)<2&&r.left>window.innerWidth/2
        &&document.body.classList.contains('ai-docked')&&!document.body.classList.contains('modal-open');}));
 ok('New conversation is an icon button with a name',
    await p.locator('#aiNew svg').count()===1 && (await p.locator('#aiNew').getAttribute('aria-label'))==='New conversation'
    && !/\S/.test(await p.locator('#aiNew').textContent()));
 ok('reasoning effort starts at Medium', (await p.locator('#aiEffortLabel').textContent())==='Medium');
 ok('a saved budget is read as saved', /as last saved/.test(await p.locator('#aiBasis').textContent()));
 await p.click('#aiLog [data-ai-suggest="0"]');
 await p.waitForSelector('#aiLog .ai-msg.bot:has-text("mock assistant answer")',{timeout:5000});
 const a1=await p.locator('#aiLog .ai-msg.bot').last().textContent();
 ok('the answer quotes the server-computed contract sum and project cost',
    a1.includes(usd0(sp.contract)) && a1.includes(usd0(sp.project)), a1);
 ok('the question is shown as the user turn',
    /How was the total project cost calculated/.test(await p.locator('#aiLog .ai-msg.user').first().textContent()));
 await p.fill('#aiQ','How many versions does it have?'); await p.press('#aiQ','Enter');
 await p.waitForSelector('#aiLog .ai-msg.bot:has-text("saved versions")',{timeout:5000});
 ok('a tool round reports what it looked up',
    /Looked up: list versions/.test(await p.locator('#aiLog .ai-msg.bot').last().textContent()));
 ok('the answer was asked at the effort shown',
    /Reasoning: medium/.test(await p.locator('#aiLog .ai-msg.bot').first().textContent())
    && /Medium reasoning/.test(await p.locator('#aiLog .ai-meta').last().textContent()));
 // Picking an effort: the menu, the label, the request, and the browser remembers it.
 await p.click('#aiEffortBtn');
 ok('the effort menu offers Low, Medium and High with Medium checked',
    (await p.locator('#aiEffortMenu:not([hidden]) [role=menuitemradio] b').allTextContents()).join(',')==='Low,Medium,High'
    && (await p.locator('#aiEffortMenu [aria-checked=true]').getAttribute('data-effort'))==='medium');
 await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter');
 ok('High is picked from the keyboard', (await p.locator('#aiEffortLabel').textContent())==='High'
    && await p.locator('#aiEffortMenu[hidden]').count()===1);
 await p.fill('#aiQ','Explain the contingency.'); await p.press('#aiQ','Enter');
 await p.waitForSelector('#aiLog .ai-msg.bot >> nth=2',{timeout:5000});
 ok('the next question is asked at High',
    /Reasoning: high/.test(await p.locator('#aiLog .ai-msg.bot').last().textContent())
    && /High reasoning/.test(await p.locator('#aiLog .ai-meta').last().textContent()));
 ok('the choice is remembered in this browser', await p.evaluate(()=>localStorage.getItem('fsAiEffort'))==='high');
 await p.click('#aiEffortBtn'); await p.click('#aiEffortMenu [data-effort="medium"]');
 // Docked, not modal: moving to another step of the same budget keeps it open.
 await p.click(".page.on [data-wf-pills] a >> nth=0"); await p.waitForTimeout(250);
 ok('the panel stays open across the steps of the same budget', await p.locator('#assistantPanel.on').count()===1);
 await p.click(".page.on [data-wf-pills] a:has-text('Budget')"); await p.waitForTimeout(250);
 await p.focus('#aiQ');
 const acts=await p.evaluate(async()=>(await (await fetch('/api/user-activity')).json()).events);
 ok('asking is logged as ai_ask with the question, not the answer',
    acts.some(e=>e.eventType==='ai_ask'&&e.entityId==='TST-9996'&&/versions/.test(e.detail.question)
      &&e.detail.answer===undefined));
 await p.keyboard.press('Escape'); await p.waitForTimeout(200);
 ok('Escape closes the assistant', await p.locator('#assistantPanel.on').count()===0
    && !(await p.evaluate(()=>document.body.classList.contains('ai-docked'))));
 // Unsaved edits: the on-screen document is what the assistant reads.
 const rate2=p.locator('#budBody input[data-k$=".unit"]').first();
 await rate2.fill('99'); await rate2.press('Tab'); await p.waitForTimeout(200);
 await p.click('.page.on button:has-text("Ask AI")'); await p.waitForTimeout(200);
 ok('the conversation continues on the same budget', await p.locator('#aiLog .ai-msg.user').count()===3);
 ok('unsaved changes are announced', /unsaved changes/.test(await p.locator('#aiBasis').textContent()));
 await p.fill('#aiQ','And now?'); await p.click('#aiSend');
 await p.waitForSelector('#aiLog .ai-msg.bot:has-text("unsaved-draft")',{timeout:5000});
 const draftContract=await p.evaluate(()=>parts().contract);
 ok('an unsaved draft is answered from the screen, not the save',
    (await p.locator('#aiLog .ai-msg.bot').last().textContent()).includes(usd0(draftContract)));
 await p.click('#aiNew');
 ok('New Conversation clears the thread', await p.locator('#aiLog .ai-msg').count()===0
    && await p.locator('#aiLog [data-ai-suggest]').count()===6);
 await p.keyboard.press('Escape');
 // ================= the save lifecycle =================
 const pill=async()=>(await p.locator('#saveState').textContent())||'';
 const toastText=async()=>(await p.locator('#toast').textContent())||'';
 const stored=async id=>p.evaluate(async i=>{const r=await fetch('/api/budget/'+i);return r.ok?r.json():null;},id);
 const saveNow=async()=>{await p.click('.page.on button[data-save-btn]');await p.waitForTimeout(700);};
 // A second budget on the same project, for the hash and id tests.
 await p.evaluate(async()=>{
   const d=JSON.parse(JSON.stringify(doc));d.projectId='TST-9993';d.name='Other Budget';
   await fetch('/api/budget/TST-9993',{method:'PUT',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,meta:{projectId:'TST-9993',name:'Other Budget',status:'Draft',projectKey:'OP-0901'},doc:d})});
 });

 // ---- the save toast says whether a version was recorded
 await p.evaluate(()=>go('input')); await p.waitForTimeout(300);
 await p.fill('#pName','Shortcut Save v2'); await p.waitForTimeout(100);
 await saveNow();
 ok('a save that changed something says which version it recorded',
    /^Saved TST-9996 — version \d+ recorded/.test(await toastText()), await toastText());
 await saveNow();
 ok('a save that changed nothing says so',
    /^Saved TST-9996 — no changes since version \d+/.test(await toastText()), await toastText());
 ok('the saved pill reads relative time', /^Saved · just now$/.test(await pill()), await pill());

 // ---- the id locks once the budget exists
 ok('the Budget ID is read-only after the first save',
    await p.locator('#pId').evaluate(e=>e.readOnly) && await p.locator('#pIdLocked').isVisible());
 // The field cannot be typed into; a value forced into it some other way
 // (autofill, devtools) must still not reach the server.
 const idRefused=await p.evaluate(async()=>{
   document.getElementById('pId').value='TST-9993';markDirty();
   await saveBudget(true);
   return {id:doc.projectId,field:document.getElementById('pId').value};
 });
 ok('a changed id is refused and put back, not saved over another budget',
    idRefused.id==='TST-9996' && idRefused.field==='TST-9996'
      && /fixed once it is saved/i.test(await toastText()),
    JSON.stringify(idRefused)+' '+await toastText());
 ok('and the other budget is untouched', (await stored('TST-9993')).name==='Other Budget');
 await saveNow();

 // ---- cancelling a hash navigation puts the address bar back
 await p.fill('#pName','Hash Cancel'); await p.waitForTimeout(100);
 await p.evaluate(()=>{window.__conf=window.confirm;window.confirm=()=>false;location.hash='#/budget/TST-9993';});
 await p.waitForTimeout(600);
 ok('declining the discard keeps the open budget',
    await p.evaluate(()=>doc.projectId)==='TST-9996', await p.evaluate(()=>doc.projectId));
 ok('and restores the hash, so a reload reopens the same budget',
    /#\/inputs\/TST-9996$/.test(p.url()), p.url());
 await p.evaluate(()=>{window.confirm=window.__conf;});

 // ---- "Leave without saving?" answered OK really discards
 await p.click('#nav-home'); await p.waitForTimeout(500);   // the dialog handler accepts
 ok('a confirmed discard clears the unsaved state', !/unsaved/i.test(await pill()), await pill());
 ok('and puts the budget back to its saved copy',
    await p.evaluate(()=>!dirty&&doc&&doc.name)==='Shortcut Save v2', await p.evaluate(()=>doc&&doc.name));
 ok('and drops its draft on this device',
    await p.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('fsDraft:')).length)===0);
 let asked=0; const countAsk=d=>{if(d.type()==='confirm')asked++;}; p.on('dialog',countAsk);
 await p.evaluate(()=>openBudget('TST-9996','input')); await p.waitForTimeout(500);
 ok('reopening does not ask again', asked===0, 'asked '+asked);
 ok('and shows the saved name', await p.inputValue('#pName')==='Shortcut Save v2', await p.inputValue('#pName'));
 p.off('dialog',countAsk);

 // ---- an edit made while a save is in flight stays unsaved
 await p.route('**/api/budget/TST-9996',async route=>{
   if(route.request().method()==='PUT')await new Promise(r=>setTimeout(r,1200));
   await route.continue();
 });
 await p.fill('#pName','Race One'); await p.waitForTimeout(100);
 await p.click('.page.on button[data-save-btn]'); await p.waitForTimeout(300);
 ok('the pill says Saving while the request is out', /Saving/.test(await pill()), await pill());
 await p.fill('#pName','Race Two'); await p.waitForTimeout(1500);
 await p.unroute('**/api/budget/TST-9996');
 ok('an edit made during the save is still unsaved afterwards',
    /unsaved/i.test(await pill()) && await p.evaluate(()=>dirty), await pill());
 ok('the server holds what was sent, not the later edit', (await stored('TST-9996')).name==='Race One');
 await saveNow();
 ok('the next save stores the later edit', (await stored('TST-9996')).name==='Race Two'
    && /^Saved /.test(await pill()), await pill());

 // ---- a failed save stays visible, says nothing raw, and retries from the pill
 await p.route('**/api/budget/TST-9996',route=>route.request().method()==='PUT'
   ?route.fulfill({status:500,contentType:'text/plain',body:"Login failed for user 'fs-api'."}):route.continue());
 await p.fill('#pName','After Failure'); await p.waitForTimeout(1000);
 await saveNow();
 ok('a failed save leaves a persistent Couldn’t Save pill', /Couldn.t Save — Retry/.test(await pill()), await pill());
 await p.waitForTimeout(2600);
 ok('which outlasts the toast', /Couldn.t Save/.test(await pill()), await pill());
 ok('the raw server error is never shown',
    !/Login failed/.test(await toastText()) && !/Login failed/.test(await p.locator('#saveState').getAttribute('title')||'')
      && !/Login failed/.test(await p.locator('#apiBannerMsg').textContent()),
    await toastText());
 ok('the message says the edits are kept on this device', /kept on this device/i.test(await toastText()), await toastText());
 await p.unroute('**/api/budget/TST-9996');
 await p.click('#saveState'); await p.waitForTimeout(800);
 ok('clicking the pill retries the save', /^Saved /.test(await pill())
    && (await stored('TST-9996')).name==='After Failure', await pill());

 // ---- edits survive a reload on this device
 await p.fill('#pName','Draft Survives'); await p.waitForTimeout(1200);
 ok('the pill says the unsaved edits are kept on this device',
    /Kept on This Device/i.test(await pill()), await pill());
 await p.reload({waitUntil:'networkidle'});
 await p.waitForTimeout(800);
 ok('reopening offers the draft', await p.locator('#draftBanner').isVisible()
    && /Unsaved changes to TST-9996/.test(await p.locator('#draftBannerMsg').textContent()),
    await p.locator('#draftBannerMsg').textContent());
 ok('without applying it until asked', await p.inputValue('#pName')==='After Failure');
 await p.click('#draftBanner button:has-text("Restore")'); await p.waitForTimeout(400);
 ok('Restore brings the edits back as unsaved changes',
    await p.inputValue('#pName')==='Draft Survives' && /unsaved/i.test(await pill()), await pill());
 await saveNow();
 ok('and Save keeps them and clears the draft', (await stored('TST-9996')).name==='Draft Survives'
    && await p.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('fsDraft:')).length)===0);

 // ---- a new budget that never reached its first save is offered at boot
 await p.evaluate(()=>{applyNewBudget('blank');doc.projectId='TST-9992';doc.name='Never Saved';
   doc.projectKey='OP-0901';doc.resSF=1000;docIsNew=true;fillForms();markDirty();});
 await p.waitForTimeout(1200);
 await p.goto('http://127.0.0.1:8100/index.html?again=1#/home',{waitUntil:'networkidle'});
 await p.waitForTimeout(800);
 ok('an unsaved new budget is offered on the next visit',
    /unsaved new budget \(TST-9992\)/.test(await p.locator('#draftBannerMsg').textContent()),
    await p.locator('#draftBannerMsg').textContent());
 await p.click('#draftBanner button:has-text("Restore")'); await p.waitForTimeout(500);
 ok('Restore reopens it as a new budget',
    await p.evaluate(()=>docIsNew&&doc.projectId==='TST-9992'&&dirty) && await p.locator('#page-input').isVisible()
      && !(await p.locator('#pId').evaluate(e=>e.readOnly)));
 await p.click('#nav-home'); await p.waitForTimeout(400);
 ok('discarding a never-saved budget drops it', await p.evaluate(()=>doc===null)
    && !(await p.locator('#saveState').isVisible()));

 // ---- two editors, one budget: the second save is asked, not silent
 await p.evaluate(()=>openBudget('TST-9996','input')); await p.waitForTimeout(600);
 const b2=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p2=await b2.newPage({viewport:{width:1400,height:1000}}); p2.on('dialog',d=>d.accept());
 await p2.goto('http://127.0.0.1:8100/index.html#/inputs/TST-9996',{waitUntil:'networkidle'});
 await p2.waitForTimeout(700);
 await p2.fill('#pName','Saved In Tab Two'); await p2.waitForTimeout(100);
 await p2.click('.page.on button[data-save-btn]'); await p2.waitForTimeout(800);
 await p.fill('#pName','Saved In Tab One'); await p.waitForTimeout(100);
 await saveNow();
 ok('a save over somebody else’s is refused with a conflict', await p.locator('#conflictDlg').isVisible()
    && (await stored('TST-9996')).name==='Saved In Tab Two', (await stored('TST-9996')).name);
 ok('and the pill keeps saying it did not save', /Couldn.t Save/.test(await pill()), await pill());
 await p.click('#conflictDlg button:has-text("Reload Latest")'); await p.waitForTimeout(700);
 ok('Reload Latest shows their version, clean', await p.inputValue('#pName')==='Saved In Tab Two'
    && !(await p.evaluate(()=>dirty)), await p.inputValue('#pName'));
 await p2.fill('#pName','Tab Two Again'); await p2.waitForTimeout(100);
 await p2.click('.page.on button[data-save-btn]'); await p2.waitForTimeout(800);
 ok('the other editor kept saving against its own new base', (await stored('TST-9996')).name==='Tab Two Again');
 await b2.close();
 await p.fill('#pName','Mine Wins'); await p.waitForTimeout(100);
 await saveNow();
 await p.click('#conflictDlg button:has-text("Overwrite Anyway")'); await p.waitForTimeout(800);
 ok('Overwrite Anyway saves over it', (await stored('TST-9996')).name==='Mine Wins' && /^Saved /.test(await pill()),
    await pill());
 // A status change from the list moves the stored document too; the editor
 // adopts the new base rather than calling its own change a conflict.
 await p.evaluate(()=>setEntityStatus('budget','TST-9996','In Review')); await p.waitForTimeout(400);
 await p.fill('#pName','After Status'); await p.waitForTimeout(100);
 await saveNow();
 ok('a quick status change does not make the next save a conflict',
    !(await p.locator('#conflictDlg').isVisible()) && (await stored('TST-9996')).name==='After Status',
    await pill());

 // efficiency documentation
 await p.evaluate(() => go('help')); await p.waitForTimeout(400);
 const t=await p.locator('#page-help').textContent();
 ok('efficiency has its own explanation', /What Efficiency Means/.test(t));
 ok('gives the formula', /total unit SF ÷ residential buildable SF/.test(t));
 ok('explains the unrentable gap', /corridors/.test(t)&&/stairwells/.test(t));
 ok('explains why it matters', /collect rent on only part of it/.test(t));
 ok('explains the amber warning', /cannot be true/.test(t));
 ok('notes amenity is excluded', /Amenity SF is deliberately excluded/.test(t));
 ok('documents the shortcut', /Cmd\+S/.test(t));
 ok('documents the investment analysis workflow',
    /Investment Analysis/.test(t) && /\+ New Investment Analysis/.test(t)
    && /snapshot, not a live link/.test(t) && /three-dot menu/.test(t)
    && /five or ten years/.test(t));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
