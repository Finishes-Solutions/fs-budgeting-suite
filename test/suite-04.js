const { chromium } = require('playwright');
const OUT = process.env.OUT_DIR || require('os').tmpdir();
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
const PASS='Basalt-Meridian-8538-27D5B4';
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);

 // no plaintext passcode anywhere in the served source
 const src=await p.content();
 ok('FS-ADMIN no longer in page source', !src.includes('FS-ADMIN'));
 ok('passphrase itself is not in page source', !src.includes(PASS));
 ok('only the digest is present', src.includes('52e20e96fd28257e018abac67cd8e1f4863b1cac1fdfb6cb0a96c963b9437548'));

 // A budget belongs to a project, so the parent is made first and chosen in
 // step 2 — a budget id can no longer imply one.
 await p.evaluate(async a=>{
   await fetch('/api/budget/'+a.p+'?scope=project',{method:'PUT',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,name:a.n,address:'1 Test Way'})});
 },{p:'OP-0401',n:'Edit Flag Test'});
 await p.click('button:has-text("+ New Budget")').then(()=>p.click('#newBudgetModal .tpl-row:has-text("Multifamily")'));
 await p.waitForTimeout(600);
 await p.selectOption('#nbProject','OP-0401');
 await p.fill('#nbId','BD-0401');
 await p.fill('#nbName','Edit Flag Test');
 await p.click('#nbCreate');
 await p.waitForTimeout(600);

 await p.fill('#pId','TST-9999'); await p.fill('#pName','Edit Flag Test');
 await p.click('#page-input button:has-text("Continue to Impact Fees")'); await p.waitForTimeout(250); await p.click('#page-fees button:has-text("Continue to Budget")'); await p.waitForTimeout(400);

 ok('a fresh budget has no edited lines', (await p.locator('#budBody .editdot.on').count())===0);
 ok('legend reads no manual edits', /no manual edits/.test(await p.locator('#editCount').textContent()));

 // change a rate -> dot appears
 // data-k keys are line.<lineId>.unit now — array indexes are no longer row identity
 const rate=p.locator('#budBody input[data-k$=".unit"]').first();
 const orig=await rate.inputValue();
 await rate.fill('9.99'); await rate.blur(); await p.waitForTimeout(300);
 ok('changing a rate flags the line', (await p.locator('#budBody tr.edited .editdot.on').count())===1);
 ok('legend counts one edit', /1 line manually edited/.test(await p.locator('#editCount').textContent()),
    await p.locator('#editCount').textContent());
 const tip=await p.locator('#budBody tr.edited .editdot.on').first().getAttribute('title');
 ok('tooltip explains the change', /rate changed from/.test(tip||''), tip);

 // restoring the library rate clears it
 await rate.fill(orig); await rate.blur(); await p.waitForTimeout(300);
 ok('restoring the library rate clears the flag', (await p.locator('#budBody .editdot.on').count())===0);

 // qty override flags
 const qty=p.locator('#budBody input[data-k$=".qty"]').first();
 await qty.fill('123'); await qty.blur(); await p.waitForTimeout(300);
 ok('overriding a quantity flags the line', (await p.locator('#budBody .editdot.on').count())===1);
 const tip2=await p.locator('#budBody tr.edited .editdot.on').first().getAttribute('title');
 ok('tooltip names the quantity override', /quantity overridden/.test(tip2||''), tip2);

 // hand-added line flags
 await p.click('button:has-text("+ Add Line Item")');
 await p.fill('#pickSearch','elevator'); await p.waitForTimeout(200);
 await p.click('#pickBody tr.clickable');
 await p.waitForTimeout(300);
 ok('a hand-added line is flagged', (await p.locator('#budBody .editdot.on').count())===2,
    (await p.locator('#budBody .editdot.on').count())+' flagged');
 ok('legend pluralises', /2 lines manually edited/.test(await p.locator('#editCount').textContent()));

 // dots stay aligned: every data row has exactly one editdot slot
 const rows=await p.locator('#budBody tr:not(.scope-hd):not(.grp-hd)').count();
 const slots=await p.locator('#budBody tr:not(.scope-hd):not(.grp-hd) .editdot').count();
 ok('every line row reserves the dot slot (alignment holds)', rows===slots, rows+' rows / '+slots+' slots');

 // flags survive save + reload
 await p.click('#page-budget button[data-save-btn]'); await p.waitForTimeout(600);
 await p.goto('http://127.0.0.1:8100/index.html#/budget/TST-9999',{waitUntil:'networkidle'});
 await p.waitForTimeout(700);
 ok('flags survive a save and reload', (await p.locator('#budBody .editdot.on').count())===2,
    (await p.locator('#budBody .editdot.on').count())+' after reload');
 await p.screenshot({path:OUT+'/shot-edited.png'});

 // ---- the edited FIELD says so, and can be put back ----
 // The qty overridden above still carries its own mark and a reset.
 const q0=p.locator('#budBody input[data-k$=".qty"]').first();
 ok('an overridden quantity marks the field itself',
    await q0.evaluate(e=>e.classList.contains('edited-val')));
 ok('the quantity carries thousands separators', (await q0.inputValue())==='123'
    && /,/.test(await p.locator('#budBody input[data-k$=".qty"]').nth(1).inputValue()),
    await p.locator('#budBody input[data-k$=".qty"]').nth(1).inputValue());
 ok('rates read as money — two decimals',
    /^\d+\.\d\d$/.test(await p.locator('#budBody input[data-k$=".unit"]').nth(1).inputValue()),
    await p.locator('#budBody input[data-k$=".unit"]').nth(1).inputValue());
 const q0id=await q0.evaluate(e=>e.dataset.k.split('.')[1]);
 const qReset=p.locator('#budBody button[aria-label="Reset to Derived Quantity"]');
 ok('an overridden quantity offers one reset', (await qReset.count())===1, String(await qReset.count()));
 await qReset.click(); await p.waitForTimeout(300);
 ok('the reset puts the derived quantity back',
    await p.evaluate(id=>lineById(id).auto===true,q0id) && !(await q0.evaluate(e=>e.classList.contains('edited-val'))));
 ok('and focus lands on the field that was reset',
    await p.evaluate(id=>document.activeElement.dataset.k==='line.'+id+'.qty',q0id));
 // a typed separator is decoration — the document stores the number
 const q1=p.locator('#budBody input[data-k$=".qty"]').nth(1);
 await q1.fill('1,234'); await q1.blur(); await p.waitForTimeout(300);
 const q1id=await q1.evaluate(e=>e.dataset.k.split('.')[1]);
 ok('a quantity typed with a separator is stored as a number',
    await p.evaluate(id=>lineById(id).qty===1234&&lineById(id).auto===false,q1id));
 // a changed rate shows the library rate and resets to it
 const r1=p.locator('#budBody input[data-k$=".unit"]').nth(2);
 const lib=await r1.inputValue();
 await r1.fill('99.5'); await r1.blur(); await p.waitForTimeout(300);
 ok('a changed rate marks the field and names the library rate',
    await r1.evaluate(e=>e.classList.contains('edited-val'))
      && (await r1.getAttribute('title'))==='Library $'+lib, await r1.getAttribute('title'));
 ok('an edited rate keeps the rate column aligned',
    new Set(await p.locator('#budBody input[data-k$=".unit"]').evaluateAll(
      els=>els.slice(0,25).map(e=>Math.round(e.getBoundingClientRect().right)))).size===1);
 const rReset=p.locator('#budBody button[aria-label="Reset to Library Rate"]');
 ok('a changed rate offers one reset', (await rReset.count())===1, String(await rReset.count()));
 await rReset.click(); await p.waitForTimeout(300);
 ok('the reset restores the library rate', (await r1.inputValue())===lib
    && !(await r1.evaluate(e=>e.classList.contains('edited-val'))), await r1.inputValue());
 ok('a hand-added line has no library rate to reset to',
    await p.evaluate(()=>{const l=doc.lines.find(x=>x.custom);
      const el=document.querySelector('#budBody [data-k="line.'+l.lineId+'.unit"]');
      return !!el&&!el.classList.contains('edited-val')&&!el.closest('td').querySelector('.rst-btn');}));

 // ---- spreadsheet keys: Enter / arrows walk the column ----
 const rates=p.locator('#budBody input[data-k$=".unit"]');
 const k=async i=>rates.nth(i).getAttribute('data-k');
 await rates.nth(0).focus();
 await p.keyboard.press('ArrowDown'); await p.waitForTimeout(150);
 ok('ArrowDown moves to the same field on the next row',
    await p.evaluate(()=>document.activeElement.dataset.k)===await k(1));
 await p.keyboard.type('4.25'); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
 ok('Enter commits the value and moves down',
    await p.evaluate(()=>document.activeElement.dataset.k)===await k(2)
      && await p.evaluate(key=>lineById(key.split('.')[1]).unit===4.25, await k(1)),
    await p.evaluate(()=>document.activeElement.dataset.k));
 await p.keyboard.press('ArrowUp'); await p.waitForTimeout(150);
 ok('ArrowUp moves back up the column',
    await p.evaluate(()=>document.activeElement.dataset.k)===await k(1));
 ok('arrows do not step the number', (await rates.nth(1).inputValue())==='4.25', await rates.nth(1).inputValue());
 await p.keyboard.press('Tab'); await p.waitForTimeout(150);
 ok('Tab still leaves the column', !/\.unit$/.test(await p.evaluate(()=>document.activeElement.dataset.k||'')));

 // unlock with the new passphrase (no principal -> control visible). Use a fresh page
 // without /.auth/me by blocking it.
 const p2=await b.newPage({viewport:{width:1200,height:900}});
 await p2.route('**/.auth/me', r=>r.abort());
 await p2.goto('http://127.0.0.1:8100/index.html#/pricing',{waitUntil:'networkidle'});
 await p2.waitForTimeout(600);
 ok('unlock control visible without a principal', await p2.locator('#lockCtl').isVisible());
 await p2.fill('#adminPass','FS-ADMIN'); await p2.click('button:has-text("Unlock")');
 await p2.waitForTimeout(300);
 ok('old FS-ADMIN passcode is rejected', !(await p2.locator('#unlockedBanner').isVisible()));
 await p2.fill('#adminPass',PASS); await p2.click('button:has-text("Unlock")');
 await p2.waitForTimeout(400);
 ok('new passphrase unlocks', await p2.locator('#unlockedBanner').isVisible());
 ok('passcode field is cleared after unlock', (await p2.locator('#adminPass').inputValue())==='');

 // A saved line id reaches inline handlers, where esc() cannot protect it, so
 // migrate() re-mints any id that is not the shape newLineId() makes.
 const xss=await p.evaluate(()=>{
   const d=JSON.parse(JSON.stringify(doc));
   d.lines[0].lineId="x');window.__pwned=1;('";
   d.lines[1].lineId=42;
   const keep=d.lines[2].lineId;
   const m=migrate(d);
   doc=m; recalc();
   const cb=document.querySelector('#budBody input[type=checkbox]');
   if(cb){cb.click();cb.click();}
   return {a:m.lines[0].lineId,b:m.lines[1].lineId,c:m.lines[2].lineId===keep,pwned:!!window.__pwned};
 });
 ok('a crafted line id is re-minted on load', /^[A-Za-z0-9_-]+$/.test(xss.a)&&typeof xss.b==='string', JSON.stringify(xss));
 ok('a well-formed line id is kept', xss.c);
 ok('a crafted line id never runs as script', !xss.pwned);

 // Update Pricing matches scope|code|desc, not basis. A library line re-based
 // to per-unit must not hand its per-unit rate to a per-SF line.
 const rp=await p.evaluate(()=>{
   const it=doc.lines.find(l=>l.scope==='res'&&l.basis==='sf');
   const lib=pricing.lines.find(l=>l.scope===it.scope&&l.code===it.code&&l.desc===it.desc);
   const saved={basis:lib.basis,unit:lib.unit,ver:pricing.version,docVer:doc.pricingVersion};
   const before=it.unit;
   lib.basis='unit';lib.unit=3081.9;doc.pricingVersion='old';
   repriceBudget();
   const after=it.unit,msg=document.getElementById('toast').textContent;
   lib.basis=saved.basis;lib.unit=saved.unit;
   return {before,after,msg};
 });
 ok('Update Pricing keeps a line whose library basis changed', rp.after===rp.before, JSON.stringify(rp));
 ok('and says so', /whose library basis has changed/.test(rp.msg), rp.msg);

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){ console.log(R.join('\n')); console.log('\nABORTED: '+e.message.split('\n')[0]); process.exit(1);} })();
