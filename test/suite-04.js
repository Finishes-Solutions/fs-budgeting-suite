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

 await p.click('button:has-text("+ New Multifamily Budget")');
 await p.fill('#pId','TST-9999'); await p.fill('#pName','Edit Flag Test');
 await p.click('button:has-text("Continue to Budget")'); await p.waitForTimeout(400);

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

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){ console.log(R.join('\n')); console.log('\nABORTED: '+e.message.split('\n')[0]); process.exit(1);} })();
