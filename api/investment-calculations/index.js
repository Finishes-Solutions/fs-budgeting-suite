// Stateless preview: validate and calculate, persist nothing. The browser
// posts raw assumptions and renders the returned canonical result — the same
// engine the save path runs, so a preview and a saved result can never differ.
const { calculateInvestmentAnalysis } = require('../shared/investment/calculate');
const { jsonRes, validationRes } = require('../shared/investment-persistence');

module.exports = async function (context, req) {
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
