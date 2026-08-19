// The feedback contract and the Graph mailer, without a database or a network.
// Both modules are shared by the real API and test/mock-api.js, so what is
// asserted here is what both of them do.
const { test } = require('node:test');
const assert = require('node:assert');
const FB = require('../api/shared/feedback');
const mailer = require('../api/shared/mailer');

test('a complete bug report is accepted and trimmed', () => {
  const r = FB.sanitizeSubmission({
    kind: 'bug', title: '  Export does nothing  ', body: '  I clicked Export and no PDF came.  ',
    severity: 'major',
    context: { route: '#/budgets', environment: 'Staging', appVersion: 'pricing 2026.08',
               userAgent: 'UA', viewport: '1400x900', rows: [['Host', 'x.com']] }
  });
  assert.ok(r.ok);
  assert.strictEqual(r.report.title, 'Export does nothing');
  assert.strictEqual(r.report.body, 'I clicked Export and no PDF came.');
  assert.strictEqual(r.report.severity, 'major');
  assert.strictEqual(r.report.pageRoute, '#/budgets');
  assert.deepStrictEqual(JSON.parse(r.report.contextDoc), { rows: [['Host', 'x.com']] });
});

test('a report needs a kind, a title and a description', () => {
  assert.match(FB.sanitizeSubmission({}).message, /bug or a feature request/);
  assert.match(FB.sanitizeSubmission({ kind: 'bug', title: 'x', body: 'long enough' }).message, /short title/);
  assert.match(FB.sanitizeSubmission({ kind: 'bug', title: 'Real title', body: 'no' }).message, /what you expected/);
  assert.match(FB.sanitizeSubmission({ kind: 'feature', title: 'Real title', body: '' }).message, /like the app to do/);
});

test('severity belongs to bugs and is dropped elsewhere', () => {
  const feat = FB.sanitizeSubmission({ kind: 'feature', title: 'Group by user',
    body: 'Filter the list by creator.', severity: 'blocking' });
  assert.strictEqual(feat.report.severity, null);
  const bad = FB.sanitizeSubmission({ kind: 'bug', title: 'Broken thing',
    body: 'It does not work.', severity: 'catastrophic' });
  assert.strictEqual(bad.report.severity, null);
});

test('the diagnostics block cannot carry arbitrary structure', () => {
  const r = FB.sanitizeSubmission({ kind: 'bug', title: 'Some bug', body: 'It broke.',
    context: { rows: [['ok', 'value'], 'not a pair', ['too', 'many', 'cells'],
                      { evil: true }, ['long', 'x'.repeat(900)]] } });
  const rows = JSON.parse(r.report.contextDoc).rows;
  assert.deepStrictEqual(rows.map(x => x[0]), ['ok', 'long']);
  assert.strictEqual(rows[1][1].length, 500);
});

test('oversized text is cut rather than refused', () => {
  const r = FB.sanitizeSubmission({ kind: 'bug', title: 'T'.repeat(400), body: 'B'.repeat(20000) });
  assert.strictEqual(r.report.title.length, FB.LIM.title);
  assert.strictEqual(r.report.body.length, FB.LIM.body);
});

test('a body that arrives as a JSON string is parsed', () => {
  const r = FB.sanitizeSubmission(JSON.stringify({ kind: 'bug', title: 'From a string',
    body: 'Sent as text/plain.' }));
  assert.ok(r.ok);
  assert.strictEqual(r.report.title, 'From a string');
});

test('a status update names a report and a known status', () => {
  assert.match(FB.sanitizeStatusUpdate({ status: 'Done' }).message, /feedbackId/);
  assert.match(FB.sanitizeStatusUpdate({ feedbackId: 2, status: 'Nope' }).message, /must be one of/);
  const ok = FB.sanitizeStatusUpdate({ feedbackId: '7', status: 'Triaged', notes: ' looked at it ' });
  assert.deepStrictEqual(ok.update, { feedbackId: 7, status: 'Triaged', notes: 'looked at it' });
});

test('the subject line names the type, the title and the reporter', () => {
  assert.strictEqual(
    FB.subjectFor({ kind: 'bug', severity: 'blocking', title: 'Cannot save', userName: 'Matthew' }),
    '[FS Suite · Bug · blocking] Cannot save — Matthew');
  assert.strictEqual(
    FB.subjectFor({ kind: 'feature', title: 'Group by user', userEmail: 'a@b.com' }),
    '[FS Suite · Feature Request] Group by user — a@b.com');
});

test('the email escapes what the reporter typed', () => {
  const html = FB.htmlFor({ kind: 'bug', title: '<script>x</script>',
    body: 'a & b <img onerror=1>', userName: 'A"B', contextDoc: '{"rows":[["K","<b>"]]}' });
  assert.ok(!/<script>/.test(html), 'no raw script tag');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('a &amp; b'));
  assert.ok(html.includes('&lt;b&gt;'));
});

test('the email survives a report with nothing but the essentials', () => {
  const html = FB.htmlFor({ kind: 'feature', title: 'T', body: 'B' });
  assert.ok(html.includes('Feature Request'));
  assert.ok(html.includes('—'), 'missing values render as a dash');
});

// ---- mailer

test('mail is reported as disabled, not failed, when it is not configured', async () => {
  const keep = {};
  ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'FEEDBACK_FROM', 'FEEDBACK_TO']
    .forEach(k => { keep[k] = process.env[k]; delete process.env[k]; });
  assert.strictEqual(mailer.isConfigured(), false);
  const r = await mailer.send({ subject: 's', text: 'b' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.disabled, true);
  assert.match(r.error, /GRAPH_TENANT_ID/);
  Object.keys(keep).forEach(k => { if (keep[k] !== undefined) process.env[k] = keep[k]; });
});

test('a send posts to Graph as the configured mailbox and never throws', async () => {
  const env = { GRAPH_TENANT_ID: 't1', GRAPH_CLIENT_ID: 'c1', GRAPH_CLIENT_SECRET: 's1',
    FEEDBACK_FROM: 'automation@finishessolutions.com', FEEDBACK_TO: 'matthews@finishessolutions.com' };
  const keep = {};
  Object.keys(env).forEach(k => { keep[k] = process.env[k]; process.env[k] = env[k]; });
  mailer._resetToken();
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('login.microsoftonline.com')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    }
    return { ok: true, status: 202, json: async () => ({}) };
  };
  try {
    const r = await mailer.send({ subject: 'Subject', html: '<p>hi</p>', replyTo: 'user@x.com' });
    assert.strictEqual(r.ok, true);
    assert.match(calls[0].url, /login\.microsoftonline\.com\/t1\/oauth2\/v2\.0\/token/);
    assert.match(calls[1].url,
      /graph\.microsoft\.com\/v1\.0\/users\/automation%40finishessolutions\.com\/sendMail/);
    assert.strictEqual(calls[1].init.headers.Authorization, 'Bearer tok');
    const sent = JSON.parse(calls[1].init.body);
    assert.strictEqual(sent.message.toRecipients[0].emailAddress.address, 'matthews@finishessolutions.com');
    assert.strictEqual(sent.message.replyTo[0].emailAddress.address, 'user@x.com');
    assert.strictEqual(sent.message.body.contentType, 'HTML');

    // A refused send comes back as a value, not an exception: the report is
    // already stored by the time this runs.
    global.fetch = async (url) => String(url).includes('login')
      ? { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
      : { ok: false, status: 403, json: async () => ({ error: { message: 'Access denied' } }) };
    const bad = await mailer.send({ subject: 's', text: 'b' });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /403.*Access denied/);

    // So does a token the tenant will not issue.
    mailer._resetToken();
    global.fetch = async () => ({ ok: false, status: 401,
      json: async () => ({ error_description: 'AADSTS7000215: invalid client secret' }) });
    const noTok = await mailer.send({ subject: 's', text: 'b' });
    assert.strictEqual(noTok.ok, false);
    assert.match(noTok.error, /invalid client secret/);
  } finally {
    global.fetch = realFetch;
    mailer._resetToken();
    Object.keys(env).forEach(k => { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; });
  }
});
