// Outbound mail through Microsoft Graph, app-only.
//
// The tenant already runs on Entra ID, so sending as a real mailbox
// (automation@finishessolutions.com) needs no new Azure resource and no DNS
// work — only an app registration with the application permission Mail.Send,
// granted admin consent. That is the whole reason this uses Graph rather than
// a mail provider: the From address is a real, replyable company address on
// day one.
//
// Configuration (SWA → Configuration → Application settings):
//   GRAPH_TENANT_ID       directory (tenant) id of the app registration
//   GRAPH_CLIENT_ID       application (client) id
//   GRAPH_CLIENT_SECRET   client secret value
//   FEEDBACK_FROM         mailbox to send as, e.g. automation@finishessolutions.com
//   FEEDBACK_TO           where reports land, e.g. matthews@finishessolutions.com
//
// With any of those missing, isConfigured() is false and the caller records
// the report as 'disabled' rather than 'failed'. Nothing here ever throws: a
// mail problem must not cost the user their bug report, which is already
// safely in the database by the time send() is called.
//
// Node 22 has global fetch, so this needs no package.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 8000;

// One token per warm instance. Graph app tokens last an hour; this refreshes
// a minute early rather than discovering expiry through a 401.
let token = null;
let tokenExpires = 0;

function cfg() {
  const e = process.env;
  return {
    tenantId: e.GRAPH_TENANT_ID || '',
    clientId: e.GRAPH_CLIENT_ID || '',
    secret: e.GRAPH_CLIENT_SECRET || '',
    from: e.FEEDBACK_FROM || '',
    to: e.FEEDBACK_TO || ''
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.tenantId && c.clientId && c.secret && c.from && c.to);
}

async function withTimeout(url, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try { return await fetch(url, Object.assign({ signal: ac.signal }, init)); }
  finally { clearTimeout(t); }
}

async function getToken() {
  if (token && Date.now() < tokenExpires) return token;
  const c = cfg();
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const r = await withTimeout(
    `https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // The description names the actual cause (wrong secret, consent missing);
    // it is worth keeping rather than reporting a bare status.
    throw new Error('token request failed (' + r.status + '): '
      + (j.error_description || j.error || 'no access_token in response'));
  }
  token = j.access_token;
  tokenExpires = Date.now() + Math.max(0, (Number(j.expires_in) || 3600) - 60) * 1000;
  return token;
}

/* Sends one message. Returns { ok } or { ok: false, error } — never throws,
   and never rejects. `replyTo` lets the recipient answer the person who filed
   the report rather than the automation mailbox. */
async function send({ subject, html, text, to, replyTo }) {
  if (!isConfigured()) {
    return { ok: false, disabled: true,
             error: 'Mail is not configured: set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, '
                  + 'GRAPH_CLIENT_SECRET, FEEDBACK_FROM and FEEDBACK_TO.' };
  }
  const c = cfg();
  try {
    const t = await getToken();
    const message = {
      subject: String(subject || '(no subject)').slice(0, 255),
      body: html ? { contentType: 'HTML', content: html }
                 : { contentType: 'Text', content: String(text || '') },
      toRecipients: String(to || c.to).split(/[;,]/).map(a => a.trim()).filter(Boolean)
        .map(a => ({ emailAddress: { address: a } }))
    };
    if (replyTo) message.replyTo = [{ emailAddress: { address: replyTo } }];
    const r = await withTimeout(
      `${GRAPH}/users/${encodeURIComponent(c.from)}/sendMail`,
      { method: 'POST',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, saveToSentItems: true }) });
    if (r.status === 202) return { ok: true };
    // A 401 here usually means the token was fine but the permission is not
    // consented; drop the cached token so the next attempt re-reads config.
    if (r.status === 401) { token = null; tokenExpires = 0; }
    let detail = '';
    try {
      const j = await r.json();
      detail = (j && j.error && (j.error.message || j.error.code)) || '';
    } catch (e) { /* an error body is a bonus, not a requirement */ }
    return { ok: false, error: 'Graph sendMail failed (' + r.status + ')'
      + (detail ? ': ' + detail : '') };
  } catch (e) {
    const msg = e && e.name === 'AbortError'
      ? 'timed out after ' + TIMEOUT_MS + 'ms'
      : (e && e.message) || String(e);
    return { ok: false, error: msg };
  }
}

module.exports = { send, isConfigured, _resetToken: () => { token = null; tokenExpires = 0; } };
