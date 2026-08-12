const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);

 // --- logo
 ok('SVG logo loads in header', await p.locator('.brand img').evaluate(e=>e.naturalWidth>0));
 ok('logo is the reversed (white) lockup',
    (await p.locator('.brand img').getAttribute('src')).includes('finishes-logo-white.svg'));
 ok('old text wordmark gone', (await p.locator('.wordmark').count())===0);

 // --- header single line at several widths
 for(const w of [1440,1280,1100,980]){
   await p.setViewportSize({width:w,height:900});
   await p.waitForTimeout(150);
   const h=await p.locator('body > header').evaluate(e=>e.getBoundingClientRect().height);
   ok('header is one line at '+w+'px', h===60, 'height='+h);
 }
 await p.setViewportSize({width:1400,height:1000});

 // --- OP id now four digits
 await p.click('button:has-text("+ New Multifamily Budget")'); await p.waitForTimeout(300);
 const bad=async v=>{await p.fill('#pId',v);await p.locator('#pName').click();
   return await p.locator('#pId').evaluate(e=>e.classList.contains('err'));};
 ok('OP-001 (3 digits) now rejected', await bad('OP-001'));
 ok('OP-0001 (4 digits) accepted', !(await bad('OP-0001')));
 ok('BD-0001 still accepted', !(await bad('BD-0001')));
 ok('AS-0001 still accepted', !(await bad('AS-0001')));
 ok('TST-9999 still accepted', !(await bad('TST-9999')));
 ok('inline error text says OP-####',
    /OP-####/.test(await p.locator('#pIdErr').textContent()));
 ok('ID format hint says OP-0001',
    /OP-0001/.test(await p.locator('#page-input .card-hd .eyebrow').first().textContent()));

 // --- auto dot no longer shifts the numbers
 await p.fill('#pId','TST-9999');
 const xs=await p.locator('#otherBody tr td:nth-child(3) input').evaluateAll(
   els=>els.map(e=>Math.round(e.getBoundingClientRect().right)));
 ok('income counts share one right edge', new Set(xs).size===1, 'edges: '+[...new Set(xs)].join(','));
 const dots=await p.locator('#otherBody .autodot').count();
 const rows=await p.locator('#otherBody tr').count();
 ok('every income row reserves a dot slot', dots===rows, rows+' rows / '+dots+' slots');
 const lit=await p.locator('#otherBody .autodot.on').count();
 ok('only auto rows have a lit dot', lit>0 && lit<rows, lit+' lit of '+rows);

 const xe=await p.locator('#expBody tr td:nth-child(4) input').evaluateAll(
   els=>els.map(e=>Math.round(e.getBoundingClientRect().right)));
 ok('expense counts share one right edge', new Set(xe).size===1, 'edges: '+[...new Set(xe)].join(','));

 // --- profit % stays on one line
 const cell=p.locator('#coBody tr td:nth-child(2)').first();
 ok('profit % cell is single line', (await cell.evaluate(e=>e.getBoundingClientRect().height))<44,
    'height='+Math.round(await cell.evaluate(e=>e.getBoundingClientRect().height)));

 // --- budget qty column alignment
 await p.click('button:has-text("Continue to Budget")'); await p.waitForTimeout(400);
 const xq=await p.locator('#budBody tr td:nth-child(3) input').evaluateAll(
   els=>els.slice(0,25).map(e=>Math.round(e.getBoundingClientRect().right)));
 ok('budget quantities share one right edge', new Set(xq).size===1, 'edges: '+[...new Set(xq)].join(','));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
