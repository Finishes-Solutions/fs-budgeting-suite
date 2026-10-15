// Stateless preview: validate and calculate, persist nothing. The browser
// posts raw assumptions and renders the returned canonical result — the same
// engine the save path runs, so a preview and a saved result can never differ.
const { calculateInvestmentAnalysis } = require('../shared/investment/calculate');
const { jsonRes, validationRes } = require('../shared/investment-persistence');

module.exports = async function (context, req) {
  // ---- POST ?scope=ask — the Budget Assistant, focused on an investment
  // analysis (the pro forma). A scope on an endpoint that already deploys, for
  // the same reason as /api/budget/{id}?scope=ask; a route rule cannot see the
  // query string, so the signed-in check inside ask() is the real gate. The
  // analysis is named in the body (an unsaved one may have no id yet).
  if (String((req.query && req.query.scope) || '') === 'ask') {
    const { getPool } = require('../shared/db');
    const { getPrincipal } = require('../shared/auth');
    const assistant = require('../shared/budget-assistant');
    const pool = await getPool();
    const principal = getPrincipal(req);
    const body = req.body || {};
    const id = body.analysisId ? String(body.analysisId).toLowerCase() : null;
    const out = await assistant.ask({
      store: () => assistant.sqlStore(pool, principal), principal, id, focus: 'analysis', body,
      log: m => context.log && context.log.warn && context.log.warn(m) });
    const activity = out.activity; delete out.activity;
    context.res = out;
    if (activity) await require('../shared/users').recordActivity(pool, principal, 'ai_ask',
      'analysis', activity.entityId || null, activity);
    return;
  }

  const input = req.body;
  try {
    const result = calculateInvestmentAnalysis(input);
    context.res = jsonRes(200, { ok: true, result });
  } catch (e) {
    if (e.validation) { context.res = validationRes(e.validation); return; }
    context.log.error('investment-calculations failed', e.message);
    context.res = jsonRes(500, { error: 'calculation_failed', message: 'The calculation could not be completed.' });
  }
};
