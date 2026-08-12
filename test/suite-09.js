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

 await p.click('button:has-text("+ New Multifamily Budget")');
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
 await p.click('#nav-budget'); await p.waitForTimeout(400);
 const rate=p.locator('[data-k="line.0.unit"]');
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

 // efficiency documentation
 await p.click('#nav-help'); await p.waitForTimeout(400);
 const t=await p.locator('#page-help').textContent();
 ok('efficiency has its own explanation', /What Efficiency Means/.test(t));
 ok('gives the formula', /total unit SF ÷ residential buildable SF/.test(t));
 ok('explains the unrentable gap', /corridors/.test(t)&&/stairwells/.test(t));
 ok('explains why it matters', /collect rent on only part of it/.test(t));
 ok('explains the amber warning', /cannot be true/.test(t));
 ok('notes amenity is excluded', /Amenity SF is deliberately excluded/.test(t));
 ok('documents the shortcut', /Cmd\+S/.test(t));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
