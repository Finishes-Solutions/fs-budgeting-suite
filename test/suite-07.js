const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:900}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html#/help',{waitUntil:'networkidle'});
 await p.waitForTimeout(600);
 ok('help page open', await p.locator('#page-help').isVisible());

 // every TOC entry must scroll within the guide, never navigate away
 const links=await p.locator('#helpToc a').all();
 ok('TOC has 11 entries', links.length===11, links.length+'');
 let bad=[];
 for(const a of links){
   const href=await a.getAttribute('href');
   const label=(await a.textContent()).trim();
   await p.evaluate(()=>window.scrollTo(0,0));
   await p.waitForTimeout(120);
   await a.click();
   await p.waitForTimeout(750);
   const stillHelp=await p.locator('#page-help').isVisible();
   const url=p.url();
   const target=await p.locator(href).boundingBox();
   // sections near the end of the document cannot reach the top — the page is simply at
   // its maximum scroll, which still counts as "jumped there".
   const atBottom=await p.evaluate(()=>Math.ceil(window.scrollY+window.innerHeight)>=document.body.scrollHeight-2);
   const scrolledTo = target && (Math.abs(target.y) < 160 || atBottom);
   if(!stillHelp||!scrolledTo||!url.endsWith('#/help')) bad.push(`${label}[help=${stillHelp} pos=${target?Math.round(target.y):'?'} bottom=${atBottom} url=${url.split('#')[1]}]`);
 }
 ok('every TOC link scrolls to its section and stays on the guide', bad.length===0, bad.join(' | '));
 ok('route survives: url still #/help', p.url().endsWith('#/help'), p.url());

 // refresh keeps you on the guide
 await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(500);
 ok('refresh keeps the guide open', await p.locator('#page-help').isVisible());

 // real routes still work
 await p.goto('http://127.0.0.1:8100/index.html#/pricing',{waitUntil:'networkidle'});
 await p.waitForTimeout(500);
 ok('#/ routes still work', await p.locator('#page-pricing').isVisible());

 // new guide content
 await p.click('#nav-help'); await p.waitForTimeout(400);
 const txt=await p.locator('#page-help').textContent();
 ok('explains the three scopes',
    /Residential Construction/.test(txt)&&/Amenity \/ Clubhouse/.test(txt)&&/Soft Costs/.test(txt));
 ok('explains scope vs CSI code', /where the money goes/.test(txt)&&/what the work is/.test(txt));
 ok('explains duplicate codes across scopes', /09 60 00/.test(txt)&&/two scopes, two rates/.test(txt));
 ok('explains SC- codes are not CSI', /SC-##/.test(txt)&&/work results/.test(txt));
 ok('explains the picker scope sets basis', /per amen SF/.test(txt)&&/per res SF/.test(txt));
 ok('explains soft costs sit outside the contract', /outside the construction contract/.test(txt));

 // logo tagline legible
 const svg=await (await fetch('http://127.0.0.1:8100/assets/finishes-logo-white.svg')).text();
 ok('logo tagline has an explicit font-size', /font-size:92px/.test(svg));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
