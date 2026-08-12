const { chromium } = require('playwright');
const OUT = process.env.OUT_DIR || require('os').tmpdir();
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const ctx=await b.newContext({viewport:{width:1400,height:1000},acceptDownloads:true});
 const p=await ctx.newPage();
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
 p.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push('CONSOLE '+m.text());});
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(600);
 ok('ExcelJS vendored and loaded', await p.evaluate(()=>typeof ExcelJS)==='function' || await p.evaluate(()=>typeof ExcelJS)==='object',
    await p.evaluate(()=>typeof ExcelJS));
 ok('no CDN script tag remains', !(await p.content()).includes('cdnjs.cloudflare.com'));

 // ---- BLANK budget
 await p.click('button:has-text("+ Blank Budget")');
 await p.waitForTimeout(300);
 ok('blank: no unit rows', (await p.locator('#unitBody tr').count())===0);
 ok('blank: no income rows', (await p.locator('#otherBody tr').count())===0);
 ok('blank: no expense rows', (await p.locator('#expBody tr').count())===0);
 ok('blank: resSF is 0', (await p.locator('#pSF').inputValue())==='0');
 ok('blank: type select reads Blank', (await p.locator('#pType').inputValue())==='Blank');
 ok('blank: land cost 0', (await p.locator('#pcLand').inputValue())==='0');
 ok('Land & project costs now on Inputs page',
    await p.locator('#page-input #sec-project').count()===1 && await p.locator('#page-budget #sec-project').count()===0);
 await p.fill('#pId','TST-9999'); await p.fill('#pName','Blank Scratch Build');
 await p.click('button:has-text("Continue to Budget")'); await p.waitForTimeout(300);
 ok('blank: budget grid empty state shows', await p.locator('#budEmpty').isVisible());
 ok('blank: contract sum is $0', (await p.locator('#rContract').textContent())==='$0');

 // ---- ADD LINE ITEM (the reported bug) incl. from a fully collapsed grid
 await p.click('button:has-text("+ Add Line Item")');
 await p.waitForTimeout(300);
 ok('add-line modal opens on a blank budget', await p.locator('#pickModal').isVisible());
 await p.fill('#pickSearch','elevator'); await p.waitForTimeout(200);
 await p.click('#pickBody tr.clickable'); await p.waitForTimeout(300);
 ok('line added to blank budget', (await p.locator('#budBody tr').count())>0);
 ok('empty state cleared', !(await p.locator('#budEmpty').isVisible()));
 await p.click('button:has-text("Collapse All")'); await p.waitForTimeout(200);
 const collapsedRows=await p.locator('#budBody tr').count();
 await p.click('button:has-text("+ Add Line Item")'); await p.waitForTimeout(250);
 await p.fill('#pickSearch','flooring'); await p.waitForTimeout(200);
 await p.click('#pickBody tr.clickable'); await p.waitForTimeout(300);
 ok('adding while collapsed reveals the new line',
    (await p.locator('#budBody tr').count())>collapsedRows,
    `${collapsedRows} -> ${await p.locator('#budBody tr').count()}`);
 ok('Collapse/Expand are separate buttons',
    (await p.locator('#sec-budget button:has-text("Collapse All")').count())===1 &&
    (await p.locator('#sec-budget button:has-text("Expand All")').count())===1);

 // ---- CSI view on the multifamily template
 await p.click('#nav-home'); await p.waitForTimeout(200);
 await p.click('button:has-text("+ New Multifamily Budget")'); await p.waitForTimeout(300);
 await p.fill('#pId','TST-9998'); await p.fill('#pName','CSI Format Check');
 await p.click('button:has-text("Continue to Budget")'); await p.waitForTimeout(400);
 await p.click('#nav-csi'); await p.waitForTimeout(500);
 ok('CSI tab renders', await p.locator('#page-csi').isVisible());
 ok('CSI hash route', p.url().endsWith('#/csi/TST-9998'), p.url());
 const divs=await p.locator('#csiBody tr.scope-hd').count();
 ok('CSI divisions grouped', divs>5, divs+' division headers');
 const codes=await p.locator('#csiBody tr:not(.scope-hd):not(.total) td:first-child').allTextContents();
 const nums=codes.map(c=>c.trim().slice(0,2)).filter(c=>/^\d\d$/.test(c));
 ok('CSI codes ascend by division', JSON.stringify(nums)===JSON.stringify([...nums].sort()));
 ok('markups present as Division 99', (await p.locator('#csiBody').textContent()).includes('Division 99'));
 ok('contingency shown as 99 03 00', (await p.locator('#csiBody').textContent()).includes('99 03 00'));
 const csiTotal=(await p.locator('#csiBody tr.total td').nth(1).textContent()).trim();
 await p.click('#nav-budget'); await p.waitForTimeout(300);
 ok('CSI contract sum matches Budget page', csiTotal===(await p.locator('#rContract').textContent()).trim(),
    csiTotal+' vs '+(await p.locator('#rContract').textContent()));
 await p.click('#nav-csi'); await p.waitForTimeout(300);
 ok('soft costs listed separately', (await p.locator('#csiSoftBody tr').count())>10);
 await p.screenshot({path:OUT+'/shot-csi.png'});

 // ---- PDF report
 await p.evaluate(()=>{window.__printed=0;window.print=()=>{window.__printed++;};});
 await p.click("#page-csi button:has-text(\"Export…\")"); await p.waitForTimeout(200);
 ok('CSI export option present', await p.locator('#ex-csi').isVisible());
 await p.click('button:has-text("PDF (Print)")'); await p.waitForTimeout(300);
 ok('print invoked', await p.evaluate(()=>window.__printed)===1);
 const rpt=await p.locator('#printDoc').innerHTML();
 ok('report has branded header + logo', rpt.includes('finishes-logo-black.png'));
 ok('report has stats band', rpt.includes('rpt-stats'));
 ok('report includes CSI section', rpt.includes('CSI Schedule of Values'));
 ok('report includes tagline footer', rpt.includes('Building a Future Together'));
 ok('report is substantial', rpt.length>8000, rpt.length+' chars');
 await p.waitForTimeout(900);                     // let exportPDF's cleanup timer finish
 await p.emulateMedia({media:'print'});
 await p.evaluate(()=>{document.getElementById('printDoc').innerHTML=buildReport(sel());
                       document.body.classList.add('printing');});
 await p.waitForTimeout(400);
 ok('printDoc visible in print media', await p.locator('#printDoc').isVisible());
 ok('app chrome hidden in print media', !(await p.locator('body > header').isVisible()));
 await p.screenshot({path:OUT+'/shot-pdf.png',fullPage:true});
 await p.pdf({path:OUT+'/report.pdf',format:'Letter',printBackground:true});
 await p.evaluate(()=>document.body.classList.remove('printing'));
 await p.emulateMedia({media:'screen'});
 await p.waitForTimeout(200);

 // ---- Excel
 const dl=p.waitForEvent('download',{timeout:20000});
 await p.click("#page-csi button:has-text(\"Export…\")"); await p.waitForTimeout(200);
 await p.click('button:has-text("Excel")');
 const file=await dl;
 const path=OUT+'/out.xlsx';
 await file.saveAs(path);
 ok('Excel downloads', !!path, file.suggestedFilename());

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
