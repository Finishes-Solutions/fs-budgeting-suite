// Suite 19 — the bug button, in both of the ways a report can leave the app.
//
//   mail mode  (the default, and production today) — pick a kind and the
//              user's own mail client opens with the subject and every
//              diagnostic filled in.
//   app mode   (once the Graph app registration exists) — the report is typed
//              here, stored, and emailed from the automation mailbox.
//
// The server decides which, so both are driven here from the same build.
const { chromium } = require('playwright');
const R=[]; const ok=(n,c,e='')=>R.push(`${c?'PASS':'FAIL'}  ${n}${e?' — '+e:''}`);
const BASE='http://127.0.0.1:8100';
const mailMode=async(p,m)=>p.evaluate(mm=>fetch('/api/_mock/mail-mode',{method:'POST',body:mm}),m);

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
    await p.evaluate(()=>[...document.styleSheets].some(s=>{
      try{ return [...s.cssRules].some(r=>r.conditionText==='print' && /#fbFab/.test(r.cssText)); }
      catch(e){ return false; }
    })));

 // ---------- 2. mail mode, because the server cannot send mail yet ----------
 ok('with no mail configured the button hands reports to the mail client',
    (await p.evaluate(()=>FSFeedback.mode()))==='mail',
    await p.evaluate(()=>JSON.stringify(US.features)));
 await p.click('#fbFab'); await p.waitForTimeout(350);
 ok('the dialog asks which kind it is', await p.locator('#fbModal').isVisible()
    && /Report a Bug or Request a Feature/.test(await p.locator('#fbHeading').textContent()));
 ok('there is nothing to type here — that happens in the email',
    !(await p.locator('#fbForm').isVisible()) && !(await p.locator('#fbSend').isVisible()));
 ok('the diagnostics that will travel with it are shown first',
    (await p.locator('#fbCtx .fb-ctx-row').count())>=4);
 ok('the page is named in words, not just as a route',
    /Home \(#\/home\)/.test(await p.locator('#fbCtx').textContent()),
    await p.locator('#fbCtx').textContent());
 ok('it says what will happen and where it goes',
    /email app opens/i.test(await p.locator('#fbNote').textContent())
    && /matthews@finishessolutions\.com/.test(await p.locator('#fbNote').textContent()),
    await p.locator('#fbNote').textContent());
 ok('neither kind claims to be selected — they are actions here',
    await p.evaluate(()=>!document.getElementById('fbKindBug').hasAttribute('aria-pressed')
      && !document.getElementById('fbKindBug').classList.contains('on')));

 // picking a kind composes the mail
 const draft=await p.evaluate(()=>FSFeedback.pick('bug'));
 await p.waitForTimeout(300);
 const dec=decodeURIComponent(draft);
 ok('picking a kind closes the dialog and opens the mail client',
    !(await p.locator('#fbModal').isVisible()) && draft.startsWith('mailto:matthews@finishessolutions.com'),
    draft.slice(0,52));
 ok('the subject is written for you: type, page and who you are',
    /subject=/.test(draft) && /\[FS Suite · Bug\] Home — /.test(dec),
    dec.split('&body=')[0]);
 ok('the body starts with a prompt to describe it',
    /^Describe the problem here/m.test(dec.split('&body=')[1]||''),
    (dec.split('&body=')[1]||'').slice(0,70));
 ok('the body carries the build, the page and the browser',
    ['Type: Bug','Page: Home (#/home)','Environment:','Versions: pricing','Screen:',
     'Signed in:','Roles:','Browser:','Reported:'].every(k=>dec.includes(k)),
    ['Type: Bug','Page: Home (#/home)','Versions: pricing','Browser:']
      .filter(k=>!dec.includes(k)).join(' | ')||'all present');
 ok('the diagnostics are marked as the developer\'s, not the reporter\'s prose',
    /Details for the developer/.test(dec));
 ok('the draft is short enough for a mail client to accept whole',
    draft.length<1800, draft.length+' characters');

 // a feature request is worded for a feature request
 await p.click('#fbFab'); await p.waitForTimeout(300);
 const featDraft=decodeURIComponent(await p.evaluate(()=>FSFeedback.pick('feature')));
 ok('a feature request gets its own subject and prompt',
    /\[FS Suite · Feature Request\]/.test(featDraft)
    && /Describe what you would like the app to do/.test(featDraft),
    featDraft.split('&body=')[0]);
 ok('a feature request carries no severity',
    !/Severity:/.test(featDraft));

 // the page it was opened from travels with it
 await p.evaluate(()=>go('budgets')); await p.waitForTimeout(500);
 await p.click('#fbFab'); await p.waitForTimeout(300);
 const fromBudgets=decodeURIComponent(await p.evaluate(()=>FSFeedback.pick('bug')));
 ok('the report names the page it was opened from',
    /\[FS Suite · Bug\] Budgets/.test(fromBudgets)
    && /Page: Budgets \(#\/budgets\)/.test(fromBudgets),
    fromBudgets.split('&body=')[0]);
 await p.evaluate(()=>go('home')); await p.waitForTimeout(400);

 // and there is a way out when mailto: is blocked
 await p.click('#fbFab'); await p.waitForTimeout(300);
 const copied=await p.evaluate(()=>FSFeedback.copyDetails());
 ok('the details can be copied instead, for a desktop that blocks mailto',
    /^To: matthews@finishessolutions\.com/.test(copied)
    && /Subject: \[FS Suite/.test(copied) && /Browser:/.test(copied),
    copied.split('\n')[0]);
 ok('copying is offered in the dialog, not just in the API',
    await p.locator('#fbCopy').isVisible());
 await p.keyboard.press('Escape'); await p.waitForTimeout(250);
 ok('Escape closes it', !(await p.locator('#fbModal').isVisible()));

 ok('nothing was stored, because nothing reached the server',
    await p.evaluate(async()=>{
      const r=await fetch('/api/user-settings?scope=feedback');
      return (await r.json()).length===0;
    }));

 // ---------- 3. app mode, once mail is configured ----------
 await mailMode(p,'sent');
 await p.reload({waitUntil:'networkidle'});
 await p.waitForTimeout(900);
 ok('configuring mail switches the button over without a code change',
    (await p.evaluate(()=>FSFeedback.mode()))==='app',
    await p.evaluate(()=>JSON.stringify(US.features)));
 await p.click('#fbFab'); await p.waitForTimeout(350);
 ok('now there is a form', await p.locator('#fbForm').isVisible()
    && await p.locator('#fbSend').isVisible());
 ok('and the copy escape hatch steps aside', !(await p.locator('#fbCopy').isVisible()));
 ok('it is a labelled dialog',
    await p.evaluate(()=>{
      const d=document.querySelector('#fbModal [role=dialog]');
      return !!d && d.getAttribute('aria-modal')==='true'
        && d.getAttribute('aria-labelledby')==='fbHeading';
    }));
 ok('the title field takes focus',
    await p.evaluate(()=>document.activeElement&&document.activeElement.id==='fbTitle'));
 ok('severity is asked about a bug', await p.locator('#fbSevRow').isVisible());
 await p.click('#fbKindFeature'); await p.waitForTimeout(250);
 ok('a feature request is not asked how badly it hurts', !(await p.locator('#fbSevRow').isVisible()));
 ok('the chosen type is announced',
    await p.evaluate(()=>document.getElementById('fbKindFeature').getAttribute('aria-pressed')==='true'));
 await p.click('#fbKindBug'); await p.waitForTimeout(250);

 await p.click('#fbSend'); await p.waitForTimeout(300);
 ok('an empty report is refused', await p.locator('#fbError').isVisible());
 ok('the refusal says what to do',
    /short title/i.test(await p.locator('#fbError').textContent()),
    await p.locator('#fbError').textContent());
 // "Could not reach the server — send it as an email" is for the network,
 // never for a title that is merely too short.
 ok('a refusal the user can fix offers no email escape hatch',
    !(await p.locator('#fbFallback').isVisible()));
 await p.fill('#fbTitle','Export does nothing on the budget page');
 await p.click('#fbSend'); await p.waitForTimeout(300);
 ok('a report with no description is refused too',
    /what you expected/i.test(await p.locator('#fbError').textContent()));

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
    filed && /\[FS Suite · Bug · major\]/.test(filed.emailSubject||''), filed&&filed.emailSubject);
 ok('the form is empty the next time it opens',
    await (async()=>{
      await p.click('#fbFab'); await p.waitForTimeout(300);
      return (await p.inputValue('#fbTitle'))==='' && (await p.inputValue('#fbBody'))==='';
    })());
 await p.keyboard.press('Escape'); await p.waitForTimeout(200);

 // a feature request, so the board has one of each
 await p.click('#fbFab'); await p.waitForTimeout(300);
 await p.click('#fbKindFeature'); await p.waitForTimeout(150);
 await p.fill('#fbTitle','Group the budgets list by creator');
 await p.fill('#fbBody','It would help to group the list by who created each budget.');
 await p.click('#fbSend'); await p.waitForTimeout(800);

 // ---------- 4. a report nobody can lose ----------
 // The server refusing the report (a 400 from its own validation) is the
 // same kind of answer as the form's: the message, no email detour.
 await p.route('**/api/user-settings?scope=feedback',r=>r.request().method()==='POST'
   ? r.fulfill({status:400,contentType:'application/json',
       body:JSON.stringify({error:'bad_request',message:'Title is too short.'})})
   : r.continue());
 await p.click('#fbFab'); await p.waitForTimeout(300);
 await p.fill('#fbTitle','Server says no');
 await p.fill('#fbBody','The server validates this and refuses it.');
 await p.click('#fbSend'); await p.waitForTimeout(500);
 ok('a server-side refusal shows its message',
    /too short/i.test(await p.locator('#fbError').textContent()),
    await p.locator('#fbError').textContent());
 ok('without claiming the server could not be reached',
    !(await p.locator('#fbFallback').isVisible()));
 await p.unroute('**/api/user-settings?scope=feedback');
 await p.evaluate(()=>FSFeedback.close()); await p.waitForTimeout(200);
 await p.route('**/api/user-settings?scope=feedback',r=>r.abort());
 await p.click('#fbFab'); await p.waitForTimeout(300);
 await p.fill('#fbTitle','Something failed while offline');
 await p.fill('#fbBody','The network dropped halfway through.');
 await p.click('#fbSend'); await p.waitForTimeout(700);
 ok('a report that cannot be sent stays on screen', await p.locator('#fbModal').isVisible());
 ok('the escape hatch appears when the API cannot be reached',
    await p.locator('#fbFallback').isVisible());
 const fallback=decodeURIComponent(await p.evaluate(()=>FSFeedback.mailFallback()));
 ok('the fallback keeps the words the user already typed',
    /network dropped halfway through/.test(fallback) && /Browser:/.test(fallback),
    fallback.split('&body=')[1].slice(0,80));
 await p.unroute('**/api/user-settings?scope=feedback');
 await p.evaluate(()=>FSFeedback.close()); await p.waitForTimeout(200);

 // ---------- 5. the Admin board ----------
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
    })());

 await p.locator('#fbBoardBody .fb-row select').first().selectOption('Done');
 await p.waitForTimeout(700);
 ok('marking one Done takes it out of the open list',
    (await p.locator('#fbBoardBody .fb-row').count())===1);
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

 // The activity log names both feedback events in words, with what they
 // were about — an unlabelled event type printing as its raw keyword is a bug.
 await p.evaluate(()=>go('dashboard')); await p.waitForTimeout(300);
 await p.evaluate(()=>FSDashboard.refresh()); await p.waitForTimeout(900);
 const logTxt=(await p.locator('#dashActivityBody').textContent()).replace(/\s+/g,' ');
 ok('the Activity Log labels submitted feedback, with its kind and title',
    /Feedback Submitted/.test(logTxt) && /Bug · Export does nothing on the budget page/.test(logTxt)
    && !/feedback_submit/.test(logTxt), logTxt.slice(0,200));
 ok('and a status change on the board',
    /Feedback Updated/.test(logTxt) && /Status → Done/.test(logTxt) && !/feedback_update/.test(logTxt),
    logTxt.slice(0,200));

 // ---------- 6. honest about delivery ----------
 // Mail goes away again mid-session: the store still works, and neither the
 // toast nor the board pretends an email went out.
 await mailMode(p,'disabled');
 await p.evaluate(()=>go('home')); await p.waitForTimeout(400);
 await p.evaluate(()=>FSFeedback.show('bug')); await p.waitForTimeout(300);
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
    (await p.locator('#fbBoardBody .fb-mail').count())>=1);

 ok('no JS errors', errs.length===0, errs.join(' | '));
 console.log(R.join('\n')); console.log('\n'+R.filter(r=>r.startsWith('FAIL')).length+' failures of '+R.length);
 await b.close();
 }catch(e){console.log(R.join('\n'));console.log('\nABORTED: '+e.message.split('\n')[0]);process.exit(1);} })();
