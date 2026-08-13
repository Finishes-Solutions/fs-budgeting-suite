const { chromium } = require('playwright');
const OUT = process.env.OUT_DIR || require('os').tmpdir();
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',async d=>{ if(d.type()==='prompt') await d.accept('Sitework Extras'); else await d.accept(); });
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);
 await p.click('button:has-text("+ New Multifamily Budget")');
 await p.fill('#pId','TST-9994');
 await p.click('button:has-text("Continue to Budget")'); await p.waitForTimeout(400);

 // --- group selector
 await p.click('button:has-text("+ Add Line Item")'); await p.waitForTimeout(300);
 ok('group selector present', await p.locator('#pickGroup').isVisible());
 const opts=await p.locator('#pickGroup option').allTextContents();
 ok('lists the residential groups in use',
    opts.includes('Site Finish')&&opts.includes('Interiors')&&opts.includes('Shell of Building'),
    opts.join(' | '));
 ok('offers Auto and New group', opts[0].startsWith('Auto')&&opts[opts.length-1].startsWith('New group'));

 // add explicitly into "Site Finish"
 await p.selectOption('#pickGroup','Site Finish');
 await p.fill('#pickSearch','bike'); await p.waitForTimeout(250);
 await p.click('#pickBody tr.clickable'); await p.waitForTimeout(400);

 // the line must sit INSIDE the existing Site Finish block, not start a second one
 const heads=await p.locator('#budBody tr.grp-hd').allTextContents();
 const siteHeads=heads.filter(h=>h.includes('Site Finish')).length;
 ok('no duplicate Site Finish heading', siteHeads===1, siteHeads+' headings');
 const groups=await p.evaluate(()=>doc.lines.filter(l=>l.scope==='res').map(l=>l.grp));
 const idx=groups.map((g,i)=>g==='Site Finish'?i:-1).filter(i=>i>=0);
 ok('Site Finish lines stay contiguous', idx[idx.length-1]-idx[0]===idx.length-1,
    'indices '+idx[0]+'..'+idx[idx.length-1]+' for '+idx.length+' lines');
 ok('the added line really is in Site Finish',
    await p.evaluate(()=>doc.lines.some(l=>l.grp==='Site Finish'&&l.custom===true)));

 // scope change repopulates groups
 await p.click('button:has-text("+ Add Line Item")'); await p.waitForTimeout(250);
 await p.selectOption('#pickScope','soft'); await p.waitForTimeout(250);
 const softOpts=await p.locator('#pickGroup option').allTextContents();
 ok('groups follow the scope', softOpts.some(o=>o.includes('Impact & Fees')), softOpts.join(' | '));

 // Auto still behaves as before
 await p.selectOption('#pickScope','res'); await p.waitForTimeout(200);
 await p.selectOption('#pickGroup','');
 await p.fill('#pickSearch','elevator'); await p.waitForTimeout(250);
 await p.click('#pickBody tr.clickable'); await p.waitForTimeout(400);
 ok('Auto files under the CSI division',
    await p.evaluate(()=>doc.lines.some(l=>l.custom&&/^Division 14/.test(l.grp))));

 // New group… prompts and uses the name
 await p.click('button:has-text("+ Add Line Item")'); await p.waitForTimeout(250);
 await p.selectOption('#pickGroup','__new');
 await p.fill('#pickSearch','irrigation'); await p.waitForTimeout(250);
 await p.click('#pickBody tr.clickable'); await p.waitForTimeout(500);
 ok('New group… uses the typed name',
    await p.evaluate(()=>doc.lines.some(l=>l.grp==='Sitework Extras')));

 // totals still tie
 const before=await p.locator('#rContract').textContent();
 ok('contract sum still renders', /^\$[\d,]+$/.test(before), before);

 // --- Download Guide
 await p.click('#nav-help'); await p.waitForTimeout(400);
 ok('Download Guide button present', await p.locator('button:has-text("Download Guide")').isVisible());
 await p.evaluate(()=>{window.__g=null;window.print=()=>{window.__g=document.getElementById('printDoc').innerHTML;};});
 await p.click('button:has-text("Download Guide")'); await p.waitForTimeout(500);
 const g=await p.evaluate(()=>window.__g||'');
 ok('guide PDF is built', g.length>10000, g.length+' chars');
 ok('has the logo header', g.includes('finishes-logo-black.png'));
 ok('has a contents list', g.includes('guide-toc'));
 ok('carries every section heading',
    ['What This Is','Quick Start','Project IDs','Inputs Reference','The Budget Page','CSI Schedule',
     'Pricing Library and Versioning','Exports','Who Can Do What','Troubleshooting'].every(h=>g.includes(h)));
 ok('drops the contents rail from the body', !g.includes('id="helpToc"'));
 ok('has the tagline footer', g.includes('Building a Future Together'));
 await p.waitForTimeout(900);                    // let downloadGuide's cleanup timer finish
 await p.emulateMedia({media:'print'});
 await p.evaluate(()=>{document.getElementById('printDoc').innerHTML=window.__g;document.body.classList.add('printing');});
 await p.waitForTimeout(500);
 ok('guide renders in print media', await p.locator('.rpt-guide').isVisible());
 await p.screenshot({path:OUT+'/shot-guide.png',clip:{x:0,y:0,width:1000,height:900}});
 await p.emulateMedia({media:'screen'});

 // ---- editable CSI codes move a line to the matching division
 await p.click('#nav-budget'); await p.waitForTimeout(400);
 const moved = await p.evaluate(() => {
   const l = doc.lines.find(x => x.scope === 'res' && x.grp === 'Interiors');
   const b = {id:l.lineId, qty:lineQty(l), unit:l.unit, scope:l.scope, basis:l.basis,
              auto:l.auto, base:l.baseUnit, desc:l.desc, total:lineQty(l)*l.unit};
   setLineCode(l.lineId, '033000');                  // unspaced input, recognized division
   const a = doc.lines.find(x => x.lineId === b.id);
   const heads = [...document.querySelectorAll('#budBody .grp-hd')]
     .map(t => t.textContent.replace(/[▾▸]/g, '').split('$')[0].trim());
   return {code:a.code, grp:a.grp, id:a.lineId, occurrences:doc.lines.filter(x=>x.lineId===b.id).length,
           rows:[...document.querySelectorAll('#budBody input[data-k="line.'+b.id+'.code"]')].length,
           dupHeads:heads.length !== new Set(heads).size, before:b,
           after:{qty:lineQty(a), unit:a.unit, scope:a.scope, basis:a.basis, auto:a.auto,
                  base:a.baseUnit, desc:a.desc, total:lineQty(a)*a.unit}};
 });
 ok('An unspaced CSI code is normalized', moved.code === '03 30 00', moved.code);
 ok('The line moves to the matching division', moved.grp === 'Division 03 — Concrete', moved.grp);
 ok('The line still exists exactly once', moved.occurrences === 1);
 ok('The line renders exactly once', moved.rows === 1, moved.rows + ' rendered rows');
 ok('No duplicate group heading appears', !moved.dupHeads);
 ok('Quantity, basis, scope, rate and total are untouched',
    JSON.stringify(moved.before.qty) === JSON.stringify(moved.after.qty)
    && moved.before.unit === moved.after.unit && moved.before.scope === moved.after.scope
    && moved.before.basis === moved.after.basis && moved.before.auto === moved.after.auto
    && moved.before.base === moved.after.base && moved.before.desc === moved.after.desc
    && moved.before.total === moved.after.total);
 ok('The line ID survives the move', moved.id === moved.before.id);

 const codes = await p.evaluate(() => {
   const soft = doc.lines.find(x => /^SC-0/.test(x.code));
   const fee  = doc.lines.find(x => /^SC-2/.test(x.code));
   return {softGrp: grpForCode(soft.code, {grp:''}), feeGrp: grpForCode(fee.code, {grp:''}),
           dashed: normalizeCsi('03-30-00'), dotted: normalizeCsi('03.30.00'),
           custom: normalizeCsi('WIDGET-9'), customGrp: grpForCode('WIDGET-9', {grp:'x'})};
 });
 ok('Hyphenated and dotted codes normalize', codes.dashed === '03 30 00' && codes.dotted === '03 30 00');
 ok('SC- design codes stay in the design soft-cost group', /Engineering & Design/.test(codes.softGrp), codes.softGrp);
 ok('SC- fee codes stay in the impact and fees group', /Impact & Fees/.test(codes.feeGrp), codes.feeGrp);
 ok('An unrecognized code is preserved and filed under Custom',
    codes.custom === 'WIDGET-9' && codes.customGrp === 'Custom');

 // ---- batch selection and deletion
 await p.evaluate(() => { clearSelection(); expandAll(); });
 await p.waitForTimeout(250);
 ok('Toolbar is hidden with nothing selected', !(await p.locator('#selBar').isVisible()));
 const boxes = p.locator('#budBody input[type="checkbox"]');
 await boxes.nth(0).check(); await boxes.nth(1).check(); await p.waitForTimeout(150);
 ok('Toolbar counts the selection',
    (await p.locator('#selCount').textContent()) === '2 Items Selected',
    await p.locator('#selCount').textContent());
 await boxes.nth(1).uncheck(); await p.waitForTimeout(120);
 ok('Deselecting one line updates the count',
    (await p.locator('#selCount').textContent()) === '1 Item Selected');
 ok('Selection survives a recalc',
    await p.evaluate(() => { const n = selected.size; touch(); return selected.size === n && n === 1; }));
 ok('Group and scope headers are never selectable',
    (await p.locator('#budBody .scope-hd input[type="checkbox"], #budBody .grp-hd input[type="checkbox"]').count()) === 0);
 await p.click('#selAll'); await p.waitForTimeout(250);
 const visCount = await p.evaluate(() => visibleLineIds().length);
 ok('Select All Visible selects every visible leaf line',
    (await p.evaluate(() => selected.size)) === visCount, visCount + ' visible');

 // This suite installs a global dialog handler that accepts everything, so the
 // confirm outcome is steered in-page instead of via a second dialog listener.
 const beforeN = await p.evaluate(() => {
   window.__confirm = window.confirm; window.confirm = () => false; return doc.lines.length;
 });
 await p.click('#selBar button:has-text("Delete Items")'); await p.waitForTimeout(300);
 ok('Cancelling the batch delete removes nothing',
    (await p.evaluate(() => doc.lines.length)) === beforeN);

 await p.evaluate(() => { clearSelection(); });
 await p.waitForTimeout(200);
 ok('Clear Selection empties the toolbar', !(await p.locator('#selBar').isVisible()));

 await boxes.nth(0).check(); await boxes.nth(2).check(); await p.waitForTimeout(150);
 const pre = await p.evaluate(() => {
   window.confirm = () => true;
   return {n: doc.lines.length, contract: parts().contract};
 });
 await p.click('#selBar button:has-text("Delete Items")'); await p.waitForTimeout(400);
 const post = await p.evaluate(() => ({n: doc.lines.length, contract: parts().contract, sel: selected.size}));
 ok('Confirming deletes exactly the selected lines', post.n === pre.n - 2, pre.n + ' → ' + post.n);
 ok('Totals recalculate after a batch delete', post.contract !== pre.contract);
 ok('Deleted IDs are cleared from the selection', post.sel === 0);
 ok('Batch delete leaves the budget dirty but unsaved',
    await p.evaluate(() => dirty === true));
 await p.evaluate(() => { window.confirm = window.__confirm; });

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
