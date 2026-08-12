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

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
