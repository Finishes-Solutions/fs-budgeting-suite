// A small, synthetic research bundle for the engine's MATH tests. These
// numbers are round on purpose and are not research — the shipped bundle is
// app/research-data.js. Keeping the math tests on fixed inputs means a research
// update can never make an arithmetic test fail (or pass) by accident.
const src = (derived) => ({ file: 'test', evidence: derived ? [] : ['test#e1'], derived: !!derived, method: 'fixture' });
const money = (low, mid, high) => ({ low, mid, high, source: src(false) });
const pct = (low, mid, high) => ({ low, mid, high, source: src(true) });

function type(id, o) {
  return Object.assign({
    id, name: id, category: 'test', description: '', primaryUnit: 'unit', altUnits: [], file: 'test/' + id + '.json',
    summary: '', sizing: { typicalSize: { low: 50, mid: 100, high: 200 }, sfPerPrimaryUnit: { low: 900, mid: 1000, high: 1100 },
      primaryUnitsPerAcre: { low: 15, mid: 20, high: 25 }, parkingPerPrimaryUnit: null },
    hardCost: { perPrimaryUnit: money(100000, 200000, 300000), perSF: null, scope: { includesSitework: true } },
    qualityTiers: { economy: 0.8, standard: 1, premium: 1.25, luxury: 1.5, source: src(true) },
    systemSplit: { lines: [{ division: '01', pct: 0.1 }, { division: '03', pct: 0.3 }, { division: '06', pct: 0.4 }, { division: '26', pct: 0.2 }], source: src(true) },
    lineItems: [], ffe: null,
    softCosts: { pctOfHard: pct(0.15, 0.2, 0.25), breakdown: null, notes: '' },
    contingency: { design: pct(0.03, 0.05, 0.07), hard: pct(0.03, 0.05, 0.07), soft: pct(0.03, 0.05, 0.07) },
    rangeCheck: { min: 150000, max: 400000 }, template: null, evidenceCount: 1, openQuestions: []
  }, o);
}

module.exports = {
  schemaVersion: 1, version: 'test.1', baseYear: 2026,
  units: [{ id: 'unit', label: 'unit', plural: 'units' }, { id: 'sf', label: 'SF', plural: 'SF' },
    { id: 'pad', label: 'pad', plural: 'pads' }, { id: 'ea', label: 'ea', plural: 'ea' }, { id: 'space', label: 'space', plural: 'spaces' }],
  indices: {
    escalation: { series: { 2025: 100, 2026: 104 }, forecast: { 2026: 0.04, 2027: 0.05, 2028: 0.03 }, method: 'fixture', file: 'test' },
    regional: { factors: { US: 1, TX: 0.9, 'TX-Austin': 0.95, CA: 1.25 }, labels: { TX: 'Texas', 'TX-Austin': 'Austin, TX', CA: 'California' }, method: 'fixture' }
  },
  common: {
    'soft-costs': { items: {
      architectureEngineering: { id: 'architectureEngineering', name: 'A&E', basis: 'pctOfHard', range: pct(0.04, 0.06, 0.08) },
      permitsPlanReview: { id: 'permitsPlanReview', name: 'Permits', basis: 'pctOfHard', range: pct(0.01, 0.02, 0.03) },
      legalAccounting: { id: 'legalAccounting', name: 'Legal', basis: 'pctOfHard', range: pct(0.01, 0.02, 0.03) },
      developerFee: { id: 'developerFee', name: 'Developer fee', basis: 'pctOfTotalCost', range: pct(0.03, 0.04, 0.05) }
    } },
    contingency: { items: {} },
    financing: { items: {
      loanToCost: { id: 'loanToCost', range: pct(0.55, 0.6, 0.65) },
      constructionLoanRate: { id: 'constructionLoanRate', range: pct(0.07, 0.08, 0.09) },
      constructionLoanFee: { id: 'constructionLoanFee', range: pct(0.005, 0.01, 0.015) }
    } },
    adjustments: { items: {} },
    'land-closing': { items: { landClosingCosts: { id: 'landClosingCosts', range: pct(0.01, 0.02, 0.03) } } },
    schedule: { items: { 'constructionMonths-default': { id: 'constructionMonths-default', range: pct(10, 12, 14) } } }
  },
  blocks: {
    'parking-structured-above': { id: 'parking-structured-above', name: 'Structured parking', division: '03', unit: 'space', cost: money(25000, 30000, 35000) },
    'pool-residential-amenity': { id: 'pool-residential-amenity', name: 'Pool', division: '13', unit: 'ea', cost: money(300000, 400000, 500000) },
    'site-development-light': { id: 'site-development-light', name: 'Site development', division: '31', unit: 'acre', cost: money(200000, 300000, 400000) }
  },
  types: {
    apt: type('apt'),
    retail: type('retail', { primaryUnit: 'sf', sizing: { typicalSize: { low: 5000, mid: 10000, high: 30000 }, sfPerPrimaryUnit: null,
      primaryUnitsPerAcre: { low: 8000, mid: 10000, high: 12000 }, parkingPerPrimaryUnit: null },
      hardCost: { perPrimaryUnit: money(150, 200, 250), scope: { includesSitework: false } }, rangeCheck: { min: 150, max: 450 } }),
    park: type('park', { primaryUnit: 'pad', sizing: { typicalSize: { low: 5, mid: 10, high: 20 }, sfPerPrimaryUnit: null,
      primaryUnitsPerAcre: { low: 8, mid: 10, high: 12 }, parkingPerPrimaryUnit: null },
      hardCost: { perPrimaryUnit: money(50000, 100000, 150000), scope: { includesSitework: true } },
      lineItems: [
        { id: 'restroom', name: 'Restroom building', division: '13', unit: 'ea', qty: { per: 'project', value: 1 }, cost: money(150000, 200000, 250000), inBaseline: true, scales: false, optional: false },
        { id: 'pedestal', name: 'Utility pedestal', division: '26', unit: 'pad', qty: { per: 'primaryUnit', value: 1 }, cost: money(8000, 10000, 12000), inBaseline: true, scales: true, optional: false },
        { id: 'grease', name: 'Grease interceptor', division: '22', unit: 'ea', qty: { per: 'project', value: 1 }, cost: money(20000, 30000, 40000), inBaseline: false, scales: false, optional: false },
        { id: 'stage', name: 'Stage', division: '13', unit: 'ea', qty: { per: 'project', value: 1 }, cost: money(40000, 50000, 60000), inBaseline: false, scales: false, optional: true }
      ], rangeCheck: { min: 60000, max: 250000 } }),
    custom: type('custom', { primaryUnit: 'ls', hardCost: { perPrimaryUnit: null, scope: { includesSitework: true } },
      sizing: { typicalSize: { low: 1, mid: 1, high: 1 }, sfPerPrimaryUnit: null, primaryUnitsPerAcre: null, parkingPerPrimaryUnit: null },
      rangeCheck: null })
  },
  evidence: { 'test#e1': { id: 'test#e1', title: 'Fixture', url: 'https://example.com', publisher: 'test', raw: { value: 1, low: null, high: null, year: 2026 }, unit: 'USD/unit', confidence: 'high' } }
};
