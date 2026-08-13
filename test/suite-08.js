const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);
 await p.click('button:has-text("+ New Multifamily Budget")');
 await p.fill('#pId','TST-9997'); await p.fill('#pName','No Clubhouse');
 await p.waitForTimeout(200);

 // --- baseline WITH amenity
 await p.click('button:has-text("Continue to Budget")'); await p.waitForTimeout(400);
 const withAmenContract=await p.locator('#rContract').textContent();
 const withAmenRows=await p.locator('#budBody tr').count();
 ok('amenity scope present when amenity SF > 0',
    (await p.locator('#budBody').textContent()).includes('Amenity / Clubhouse'));
 ok('amenity summary row visible', await p.locator('#rAmenRow').isVisible());
 const amenValue=await p.locator('#rAmen').textContent();
 ok('amenity carries value', amenValue!=='$0', amenValue);

 // --- prove hidden money cannot survive: make an amenity line lump-sum with a real rate
 await p.evaluate(()=>{
   const i=doc.lines.findIndex(l=>l.scope==='amen');
   doc.lines[i].basis='ls'; doc.lines[i].auto=false; doc.lines[i].qty=1; doc.lines[i].unit=250000;
   touch();
 });
 await p.waitForTimeout(300);
 const withLump=await p.locator('#rContract').textContent();
 ok('lump-sum amenity line counts while amenity is on', withLump!==withAmenContract, withAmenContract+' -> '+withLump);

 // --- switch amenity off
 await p.click('#nav-input'); await p.waitForTimeout(200);
 await p.fill('#pASF','0'); await p.locator('#pSF').click(); await p.waitForTimeout(300);
 await p.click('#nav-budget'); await p.waitForTimeout(400);

 ok('amenity scope gone from the grid',
    !(await p.locator('#budBody').textContent()).includes('Amenity / Clubhouse'));
 ok('grid has fewer rows', (await p.locator('#budBody tr').count()) < withAmenRows,
    withAmenRows+' -> '+(await p.locator('#budBody tr').count()));
 ok('amenity summary row hidden', !(await p.locator('#rAmenRow').isVisible()));
 ok('explains why amenity vanished', await p.locator('#amenHidden').isVisible());
 ok('THE KEY ONE: hidden lump-sum amenity money is excluded from the contract sum',
    (await p.locator('#rContract').textContent())!==withLump,
    'with amenity '+withLump+' -> without '+(await p.locator('#rContract').textContent()));
 ok('residential still intact', (await p.locator('#budBody').textContent()).includes('Residential Construction'));
 ok('soft costs still intact', (await p.locator('#budBody').textContent()).includes('Soft Costs'));

 // --- CSI view
 await p.click('#nav-csi'); await p.waitForTimeout(500);
 const csi=await p.locator('#csiBody').textContent();
 ok('CSI view has no Amenity tags', !csi.includes('Amenity'), 'found Amenity tag');
 ok('CSI contract sum matches budget page',
    (await p.locator('#csiBody tr.total td').nth(1).textContent()).trim()===(await p.locator('#page-budget #rContract').textContent()).trim());

 // --- exports
 await p.evaluate(()=>{window.__rpt=null;window.print=()=>{window.__rpt=document.getElementById('printDoc').innerHTML;};});
 await p.click('#page-csi button:has-text("Export…")'); await p.waitForTimeout(200);
 await p.click('button:has-text("PDF (Print)")'); await p.waitForTimeout(400);
 const rpt=await p.evaluate(()=>window.__rpt||'');
 ok('PDF omits the amenity scope band', !rpt.includes('Amenity / Clubhouse'));
 ok('PDF omits the amenity summary row', !rpt.includes('Amenity / clubhouse'));
 ok('PDF still has residential detail', rpt.includes('Residential Construction'));

 // --- turning it back on restores everything
 await p.waitForTimeout(700);
 await p.click('#nav-input'); await p.waitForTimeout(200);
 await p.fill('#pASF','1200'); await p.locator('#pSF').click(); await p.waitForTimeout(300);
 await p.click('#nav-budget'); await p.waitForTimeout(400);
 ok('amenity returns when SF is set again',
    (await p.locator('#budBody').textContent()).includes('Amenity / Clubhouse'));
 ok('contract sum returns to its earlier value',
    (await p.locator('#rContract').textContent())===withLump,
    (await p.locator('#rContract').textContent())+' vs '+withLump);

 // --- division header totals and percentages (CSI schedule)
 await p.click('#nav-csi'); await p.waitForTimeout(400);
 const div = await p.evaluate(() => {
   const sch = csiSchedule();
   const d = sch.divisions[0];
   return { title: d.title, total: d.total,
            leafSum: d.rows.reduce((s, r) => s + r.total, 0),
            contract: sch.contract,
            markupsTotal: sch.markupsTotal,
            softTotal: sch.softTotal,
            softGroupSum: sch.softGroups.reduce((s, g) => s + g.total, 0) };
 });
 ok('Division total equals the sum of its leaf lines',
    Math.abs(div.total - div.leafSum) < 0.005, div.total + ' vs ' + div.leafSum);
 ok('Soft group totals reconcile to total soft costs',
    Math.abs(div.softGroupSum - div.softTotal) < 0.005);
 const hd = p.locator('#csiBody .scope-hd').first();
 ok('Division header has separate Total and % cells', (await hd.locator('td').count()) === 3
    && (await hd.locator('td').first().getAttribute('colspan')) === '6');
 const hdPct = parseFloat((await hd.locator('td.calc').nth(1).textContent()).replace('%',''));
 ok('Division percentage uses Contract Sum as the denominator',
    Math.abs(hdPct - (100*div.total/div.contract)) < 0.06,
    hdPct + '% vs ' + (100*div.total/div.contract).toFixed(1) + '%');
 // The line-item % column must share that denominator, or the two cannot reconcile.
 const firstRowPct = parseFloat((await p.locator('#csiBody tr:not(.scope-hd):not(.total)').first()
   .locator('td.calc').last().textContent()).replace('%',''));
 const firstRowTotal = await p.evaluate(() => csiSchedule().divisions[0].rows[0].total);
 ok('Line-item percentage uses the same denominator as the division header',
    Math.abs(firstRowPct - (100*firstRowTotal/div.contract)) < 0.06);
 ok('Soft costs are labelled with their own denominator',
    (await p.locator('#page-csi').textContent()).includes('% Soft'));

 // A zero contract sum must show an em dash rather than NaN% or Infinity.
 const dash = await p.evaluate(() => {
   const keep = doc.lines.map(l => l.unit);
   doc.lines.forEach(l => l.unit = 0);
   const co = doc.companies.map(c => c.pct), cv = doc.contingency.val;
   doc.companies.forEach(c => c.pct = 0); doc.contingency.val = 0;
   recalc();
   const t = document.getElementById('csiBody').textContent;
   doc.lines.forEach((l, i) => l.unit = keep[i]);
   doc.companies.forEach((c, i) => c.pct = co[i]); doc.contingency.val = cv;
   recalc();
   return t;
 });
 ok('A zero contract sum shows an em dash, not NaN', !/NaN|Infinity/.test(dash) && dash.includes('—'));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
