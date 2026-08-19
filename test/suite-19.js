// Suite 19 — the bug button, the report dialog, and the Admin feedback board.
// A report must be impossible to lose: stored before mail is attempted, and
// offered as an email when the API cannot be reached at all.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
const BASE='http://127.0.0.1:8100';
(async()=>{ try{
 const b=await chromium.launch({executablePath: process.env.CHROMIUM_PATH || undefined});
 const p=await b.newPage({viewport:{width:1400,height:1000}});
 p.on('dialog',d=>d.accept());
 const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto(BASE+'/index.html',{waitUntil:'networkidle'});
 await p.waitForTimeout(900);

 // ---------- 1. the launcher ----------
 ok('the bug button is on the page', await p.locator('#fbFab').isVisible());
 ok('it is anchored to the bottom left',
    await p.evaluate(()=>{
      const r=document.getElementById('fbFab').getBoundingClientRect();
      return r.left<40 && (window.innerHeight-r.bottom)<40;
    }),
    await p.evaluate(()=>JSON.stringify(document.getElementById('fbFab').getBoundingClientRect())));
 ok('it says what it is, for a screen reader too',
    await p.evaluate(()=>{
      const f=document.getElementById('fbFab');
      return /bug/i.test(f.getAttribute('aria-label')||'') && /report/i.test(f.textContent);
    }));
 ok('it stays put on every page',
    await (async()=>{
      for(const pg of ['budgets','analyses','help','version']){
        await p.evaluate(g=>go(g),pg); await p.waitForTimeout(350);
        if(!await p.locator('#fbFab').isVisible())return false;
      }
      await p.evaluate(()=>go('home')); await p.waitForTimeout(350);
      return true;
    })());
 ok('it is left out of anything printed',
    await p.evaluate(()=>{
      // the rule is @media print; assert it exists rather than guessing at
      // print rendering, which headless Chromium will not show us.
      return [...document.styleSheets].some(s=>{
        try{ return [...s.cssRules].some(r=>r.conditionText==='print'
          && /#fbFab/.test(r.cssText)); }catch(e){ return false; }
      });
    }));

 // ---------- 2. the dialog ----------
 await p.click('#fbFab'); await p.waitForTimeout(350);
 ok('the dialog opens on a bug report', await p.locator('#fbModal').isVisible()
    && (await p.locator('#fbHeading').textContent()).includes('Bug'));
 ok('it is a labelled dialog',
    await p.evaluate(()=>{
      const d=document.querySelector('#fbModal [role=dialog]');
      return !!d && d.getAttribute('aria-modal')==='true'
        && d.getAttribute('aria-labelledby')==='fbHeading';
    }));
 ok('the title field takes focus',
    await p.evaluate(()=>document.activeElement&&document.activeElement.id==='fbTitle'));
 ok('severity is asked about a bug', await p.locator('#fbSevRow').isVisible());
 ok('the diagnostics that will be sent are shown first',
    (await p.locator('#fbCtx .fb-ctx-row').count())>=4);
 ok('the diagnostics name the page the user is on',
    /#\/home/.test(await p.locator('#fbCtx').textContent()),
    await p.locator('#fbCtx').textContent());
 ok('it says where the report goes',
    /matthews@finishessolutions\.com/.test(await p.locator('#fbModal').textContent()));

 // switching to a feature request rewords the form
 await p.click('#fbKindFeature'); await p.waitForTimeout(250);
 ok('a feature request is not asked how badly it hurts', !(await p.locator('#fbSevRow').isVisible()));
 ok('a feature request is asked what it should do',
    /like it to do/i.test(await p.locator('#fbBodyLab').textContent()),
    await p.locator('#fbBodyLab').textContent());
 ok('the chosen type is announced',
    await p.evaluate(()=>document.getElementById('fbKindFeature').getAttribute('aria-pressed')==='true'
      && document.getElementById('fbKindBug').getAttribute('aria-pressed')==='false'));
 await p.click('#fbKindBug'); await p.waitForTimeout(250);

 // ---------- 3. it refuses an empty report, kindly ----------
 await p.click('#fbSend'); await p.waitForTimeout(300);
 ok('an empty report is refused', await p.locator('#fbError').isVisible());
 ok('the refusal says what to do',
    /short title/i.test(await p.locator('#fbError').textContent()),
    await p.locator('#fbError').textContent());
 await p.fill('#fbTitle','Export does nothing on the budget page');
 await p.click('#fbSend'); await p.waitForTimeout(300);
 ok('a report with no description is refused too',
    /what you expected/i.test(await p.locator('#fbError').textContent()),
    await p.locator('#fbError').textContent());

 // ---------- 4. a report that goes through ----------
 await p.fill('#fbBody','I clicked Export and nothing downloaded. I expected the PDF to open.');
 await p.selectOption('#fbSev','major');
 await p.click('#fbSend'); await p.waitForTimeout(800);
 ok('the dialog closes once the report is filed', !(await p.locator('#fbModal').isVisible()));
 ok('the user is told it reached Matthew',
    /Matthew/.test(await p.locator('#toast').textContent()),
    await p.locator('#toast').textContent());
 const filed=await p.evaluate(async()=>{
   const r=await fetch('/api/user-settings?scope=feedback');
   return (await r.json())[0];
 });
 ok('the report is stored with what was typed',
    filed && filed.title==='Export does nothing on the budget page'
    && /nothing downloaded/.test(filed.body||''), JSON.stringify(filed&&filed.title));
 ok('the report carries the severity and the type',
    filed && filed.kind==='bug' && filed.severity==='major');
 ok('the report carries where the user was and what they were running',
    filed && /#\//.test(filed.pageRoute||'') && !!filed.userAgent && !!filed.viewport
    && /engine/.test(filed.appVersion||''),
    JSON.stringify({r:filed&&filed.pageRoute,v:filed&&filed.appVersion}));
 ok('the report carries the full diagnostics table',
    (()=>{ try{ return JSON.parse(filed.contextDoc).rows.length>=10; }catch(e){ return false; } })());
 ok('the report is attributed to the signed-in account',
    filed && /@/.test(filed.userEmail||''), filed&&filed.userEmail);
 ok('the email that would go out names the reporter and the title',
    filed && /\[FS Suite · Bug · major\]/.test(filed.emailSubject||'')
    && /Export does nothing/.test(filed.emailSubject||''), filed&&filed.emailSubject);
 ok('the form is empty the next time it opens',
    await (async()=>{
      await p.click('#fbFab'); await p.waitForTimeout(300);
      const t=await p.inputValue('#fbTitle'); const bd=await p.inputValue('#fbBody');
      return t==='' && bd==='';
    })());
 ok('Escape closes it',
    await (async()=>{ await p.keyboard.press('Escape'); await p.waitForTimeout(250);
      return !(await p.locator('#fbModal').isVisible()); })());

 // a feature request, so the board has one of each
 await p.click('#fbFab'); await p.waitForTimeout(300);
 await p.click('#fbKindFeature'); await p.waitForTimeout(150);
 await p.fill('#fbTitle','Group the budgets list by creator');
 await p.fill('#fbBody','It would help to group the list by who created each budget.');
 await p.click('#fbSend'); await p.waitForTimeout(800);

 // ---------- 5. a report nobody can lose ----------
 await p.route('**/api/user-settings?scope=feedback',r=>r.abort());
 await p.click('#fbFab'); await p.waitForTimeout(300);
 await p.fill('#fbTitle','Something failed while offline');
 await p.fill('#fbBody','The network dropped halfway through.');
 await p.click('#fbSend'); await p.waitForTimeout(700);
 ok('a report that cannot be sent stays on screen', await p.locator('#fbModal').isVisible());
 ok('the escape hatch appears when the API cannot be reached',
    await p.locator('#fbFallback').isVisible());
 const draft=await p.evaluate(()=>FSFeedback.mailFallback());
 await p.waitForTimeout(200);
 ok('the escape hatch is an email to Matthew',
    draft.startsWith('mailto:matthews@finishessolutions.com'), draft.slice(0,60));
 ok('the draft carries the report and the diagnostics',
    /Something%20failed/.test(draft) && /Browser/.test(decodeURIComponent(draft))
    && /network dropped/.test(decodeURIComponent(draft)),
    decodeURIComponent(draft).slice(0,160));
 await p.unroute('**/api/user-settings?scope=feedback');
 await p.evaluate(()=>FSFeedback.close()); await p.waitForTimeout(200);

 // ---------- 6. the Admin board ----------
 await p.evaluate(()=>go('admin')); await p.waitForTimeout(700);
 ok('the Admin page opens on users, as before',
    await p.locator('#adminUsersPane').isVisible() && !(await p.locator('#adminFeedbackPane').isVisible()));
 await p.click('#adminTab-feedback'); await p.waitForTimeout(700);
 ok('the feedback board is a second tab, not a second page',
    await p.locator('#adminFeedbackPane').isVisible() && !(await p.locator('#adminUsersPane').isVisible()));
 ok('the page title follows the tab',
    (await p.locator('#adminHeading').textContent()).trim()==='Feedback');
 ok('both reports are on the board', (await p.locator('#fbBoardBody .fb-row').count())===2,
    String(await p.locator('#fbBoardBody .fb-row').count()));
 ok('each report is labelled bug or feature',
    (await p.locator('#fbBoardBody .fb-kind-bug').count())===1
    && (await p.locator('#fbBoardBody .fb-kind-feature').count())===1);
 ok('the board counts what is open',
    /2 open · 2 total/.test(await p.locator('#fbCounts').textContent()),
    await p.locator('#fbCounts').textContent());
 ok('a report opens to show everything it carries',
    await (async()=>{
      await p.locator('#fbBoardBody .fb-open').first().click(); await p.waitForTimeout(300);
      const t=await p.locator('#fbBoardBody .fb-detail:visible').textContent();
      return /Reported by/.test(t)&&/User Agent/.test(t)&&/Notification/.test(t)
        &&/Pricing Library Version/.test(t);
    })(),
    (await p.locator('#fbBoardBody .fb-detail:visible').count())+' open');

 // triage moves it out of the open view
 await p.locator('#fbBoardBody .fb-row select').first().selectOption('Done');
 await p.waitForTimeout(700);
 ok('marking one Done takes it out of the open list',
    (await p.locator('#fbBoardBody .fb-row').count())===1,
    String(await p.locator('#fbBoardBody .fb-row').count()));
 await p.click('#fbFilter-all'); await p.waitForTimeout(300);
 ok('All still shows it', (await p.locator('#fbBoardBody .fb-row').count())===2);
 await p.click('#fbFilter-closed'); await p.waitForTimeout(300);
 ok('Closed shows exactly the one that was finished',
    (await p.locator('#fbBoardBody .fb-row').count())===1);
 ok('the status stuck on the server',
    await p.evaluate(async()=>{
      const rows=await (await fetch('/api/user-settings?scope=feedback')).json();
      return rows.filter(x=>x.status==='Done').length===1;
    }));
 await p.click('#fbFilter-open'); await p.waitForTimeout(300);

 // ---------- 7. honest about delivery ----------
 await p.evaluate(()=>fetch('/api/_mock/mail-mode',{method:'POST',body:'disabled'}));
 await p.click('#fbFab'); await p.waitForTimeout(300);
 await p.fill('#fbTitle','Filed while mail is switched off');
 await p.fill('#fbBody','This one should still be stored and shown as undelivered.');
 await p.click('#fbSend'); await p.waitForTimeout(800);
 ok('a report still goes through when mail is not configured',
    !(await p.locator('#fbModal').isVisible()));
 ok('and the user is told the email did not go, not that it did',
    /not switched on|saved/i.test(await p.locator('#toast').textContent()),
    await p.locator('#toast').textContent());
 await p.evaluate(()=>go('admin')); await p.waitForTimeout(500);
 await p.click('#adminTab-feedback'); await p.waitForTimeout(700);
 ok('the board flags the report that was never emailed',
    (await p.locator('#fbBoardBody .fb-mail').count())>=1,
    await p.locator('#fbBoardBody').textContent().then(t=>t.slice(0,120)));

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
