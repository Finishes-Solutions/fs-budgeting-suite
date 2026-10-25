const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:8100/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(400);
 // A budget belongs to a project, so the parent is made first and chosen in
 // step 2 of the dialog — a budget id can no longer imply one.
 await p.evaluate(async a=>{
   await fetch('/api/budget/'+a.p+'?scope=project',{method:'PUT',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({create:true,name:a.n,address:'1 Test Way'})});
 },{p:'OP-0801',n:'No Clubhouse'});
 await p.click('button:has-text("+ New Budget")').then(()=>p.click('#newBudgetModal .tpl-row[data-tpl="multifamily"]'));
 await p.waitForTimeout(700);
 await p.selectOption('#nbProject','OP-0801');
 await p.fill('#nbId','TST-9997');
 await p.fill('#nbName','No Clubhouse');
 await p.click('#nbCreate');
 await p.waitForTimeout(700);

 await p.fill('#pId','TST-9997'); await p.fill('#pName','No Clubhouse');
 await p.waitForTimeout(200);

 // --- baseline WITH amenity
 await p.click('#page-input button:has-text("Continue to Impact Fees")'); await p.waitForTimeout(250); await p.click('#page-fees button:has-text("Continue to Budget")'); await p.waitForTimeout(400);
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
 await p.click(".page.on [data-wf-pills] a:has-text('Inputs')"); await p.waitForTimeout(200);
 await p.fill('#pASF','0'); await p.locator('#pSF').click(); await p.waitForTimeout(300);
 const nAmen=await p.evaluate(()=>doc.lines.filter(l=>l.scope==='amen').length);
 // Said where it can be changed: a helper note under the Amenity SF input.
 ok('Inputs explains the excluded amenity lines under Amenity SF',
    await p.locator('#pASFNote').isVisible()
    && (await p.locator('#pASFNote').textContent()).includes('the '+nAmen+' amenity lines are excluded from the budget'),
    await p.locator('#pASFNote').textContent());
 await p.click(".page.on [data-wf-pills] a:has-text('Budget')"); await p.waitForTimeout(400);

 ok('amenity scope gone from the grid',
    !(await p.locator('#budBody .scope-hd').allTextContents()).some(t=>t.includes('Amenity / Clubhouse'))
    && (await p.locator('#budBody').textContent()).match(/Amenity \/ Clubhouse/g).length===1);
 // ...but it does not silently vanish: one muted, non-interactive row stands
 // where the scope was and says why. Display only — no money, no controls.
 const off=p.locator('#budBody tr.scope-off');
 ok('a muted row says the amenity lines are excluded',
    (await off.count())===1
    && /Amenity \/ Clubhouse\s*— (\d+) lines excluded because Amenity SF is 0/.test(await off.textContent())
    && (await off.textContent()).includes('— '+nAmen+' lines excluded'),
    (await off.count())+' row(s): '+(await off.textContent().catch(()=>'')));
 ok('the excluded-scope row is not interactive',
    (await off.getAttribute('data-toggle'))===null
    && (await off.locator('input,button,select').count())===0);
 const offRows=await p.locator('#budBody tr').count();
 await off.dispatchEvent('click'); await p.waitForTimeout(200);
 ok('clicking it changes nothing', (await p.locator('#budBody tr').count())===offRows);
 ok('it sits between the residential and soft-cost scopes',
    await p.evaluate(()=>{const r=[...document.querySelectorAll('#budBody tr.scope-hd,#budBody tr.scope-off')]
      .map(t=>t.classList.contains('scope-off')?'off':/Residential/.test(t.textContent)?'res':/Soft Costs/.test(t.textContent)?'soft':'?');
      return r.join(',')==='res,off,soft';}));
 ok('grid has fewer rows', (await p.locator('#budBody tr').count()) < withAmenRows,
    withAmenRows+' -> '+(await p.locator('#budBody tr').count()));
 ok('amenity summary row hidden', !(await p.locator('#rAmenRow').isVisible()));
 ok('the amenity-hidden flag is retired from the toolbar', (await p.locator('#amenHidden').count())===0);
 ok('THE KEY ONE: hidden lump-sum amenity money is excluded from the contract sum',
    (await p.locator('#rContract').textContent())!==withLump,
    'with amenity '+withLump+' -> without '+(await p.locator('#rContract').textContent()));
 ok('residential still intact', (await p.locator('#budBody').textContent()).includes('Residential Construction'));
 ok('soft costs still intact', (await p.locator('#budBody').textContent()).includes('Soft Costs'));

 // --- CSI view
 await p.click(".page.on [data-wf-pills] a:has-text('CSI Schedule')"); await p.waitForTimeout(500);
 const csi=await p.locator('#csiBody').textContent();
 ok('CSI view has no Amenity tags', !csi.includes('Amenity'), 'found Amenity tag');
 ok('CSI contract sum matches budget page',
    (await p.locator('#csiBody tr.total td').nth(1).textContent()).trim()===(await p.locator('#page-budget #rContract').textContent()).trim());

 // --- exports
 await p.evaluate(()=>{window.__rpt=null;window.print=()=>{window.__rpt=document.getElementById('printDoc').innerHTML;};});
 await p.click('#page-csi button:has-text("Export")'); await p.waitForTimeout(200);
 await p.click('button:has-text("Print")'); await p.waitForTimeout(400);
 const rpt=await p.evaluate(()=>window.__rpt||'');
 ok('PDF omits the amenity scope band', !rpt.includes('Amenity / Clubhouse'));
 ok('PDF omits the amenity summary row', !rpt.includes('Amenity / clubhouse'));
 ok('PDF still has residential detail', rpt.includes('Residential Construction'));

 // --- turning it back on restores everything
 await p.waitForTimeout(700);
 await p.click(".page.on [data-wf-pills] a:has-text('Inputs')"); await p.waitForTimeout(200);
 await p.fill('#pASF','1200'); await p.locator('#pSF').click(); await p.waitForTimeout(300);
 ok('the Amenity SF note clears once there is a clubhouse', !(await p.locator('#pASFNote').isVisible()));
 await p.click(".page.on [data-wf-pills] a:has-text('Budget')"); await p.waitForTimeout(400);
 ok('amenity returns when SF is set again',
    (await p.locator('#budBody').textContent()).includes('Amenity / Clubhouse'));
 ok('the excluded-scope row is gone again', (await p.locator('#budBody tr.scope-off').count())===0);
 ok('contract sum returns to its earlier value',
    (await p.locator('#rContract').textContent())===withLump,
    (await p.locator('#rContract').textContent())+' vs '+withLump);

 // --- division header totals and percentages (CSI schedule)
 await p.click(".page.on [data-wf-pills] a:has-text('CSI Schedule')"); await p.waitForTimeout(400);
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

 // --- missing numerics must never render as $NaN (HANDOFF §8)
 // The trigger is an ABSENT property, which is what an older saved document or an
 // imported one looks like — not a field the user typed into and cleared, which
 // already coerces to 0.
 await p.click(".page.on [data-wf-pills] a:has-text('Budget')"); await p.waitForTimeout(400);
 const nanScan = async () => p.evaluate(() =>
   /NaN|Infinity/.test(document.body.innerText));
 await p.evaluate(() => { doc.lines.forEach(l => { delete l.unit; delete l.qty; }); touch(); });
 await p.waitForTimeout(300);
 ok('Lines with no rate do not render NaN', !(await nanScan()));
 await p.evaluate(() => {
   doc.units.forEach(u => { delete u.count; delete u.sf; delete u.rent; });
   delete doc.resSF; delete doc.amenSF; delete doc.contingency.val;
   doc.companies.forEach(c => delete c.pct);
   ['land','dev','mkt','cls'].forEach(k => delete doc.projectCosts[k]);
   touch();
 });
 await p.waitForTimeout(300);
 ok('A document stripped of every numeric does not render NaN', !(await nanScan()));
 await p.click(".page.on [data-wf-pills] a:has-text('CSI Schedule')"); await p.waitForTimeout(400);
 ok('The CSI schedule survives it too', !(await nanScan()));
 await p.click(".page.on [data-wf-pills] a:has-text('Inputs')"); await p.waitForTimeout(400);
 ok('The inputs page survives it too', !(await nanScan()));
 const repaired = await p.evaluate(() => {
   const d = migrate({units:[{label:'x'}], other:[], expenses:[], lines:[{code:'01 01 00'}],
                      projectCosts:{}, companies:[{name:'c'}], contingency:{mode:'psf'}});
   return [d.lines[0].unit, d.lines[0].qty, d.units[0].count, d.resSF,
           d.companies[0].pct, d.contingency.val, d.projectCosts.land];
 });
 ok('migrate() repairs a legacy document rather than only masking it',
    repaired.every(v => v === 0), JSON.stringify(repaired));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
