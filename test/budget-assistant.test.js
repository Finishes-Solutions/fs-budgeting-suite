// The Budget Assistant (api/shared/budget-assistant.js), without a database or
// an API key: a fake store stands in for SQL and a fake client for Claude, so
// what is pinned here is OUR side — the facts the model is given, the tool
// loop, the limits, and the refusals — not the model's prose.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../api/shared/budget-assistant');
const { parts, grossIncome } = require('../api/shared/budget-calc');

const doc = () => ({
  projectId: 'TST-0001', name: 'Assistant Test', type: 'Multifamily', pricingVersion: '2026.1',
  resSF: 100000, amenSF: 5000, siteSF: 200000,
  units: [ { label: '1BR', count: 40, sf: 700, rent: 1200 }, { label: '2BR', count: 10, sf: 1000, rent: 1600 } ],
  lines: [
    { lineId: 'a', scope: 'res', grp: 'Finishes', code: '09 29 00', desc: 'Drywall', basis: 'sf', auto: true, qty: 0, unit: 2.5, baseUnit: 2.5 },
    { lineId: 'b', scope: 'res', grp: 'Finishes', code: '10 28 00', desc: 'Accessories', basis: 'unit', auto: true, qty: 0, unit: 800, baseUnit: 750 },
    { lineId: 'c', scope: 'amen', grp: 'Amenity', code: '11 40 00', desc: 'Kitchen', basis: 'ls', auto: true, qty: 0, unit: 15000, baseUnit: 15000 },
    { lineId: 'd', scope: 'soft', grp: 'Eng', code: 'SC-01', desc: 'Civil', basis: 'ls', auto: true, qty: 0, unit: 25000, baseUnit: 25000 }
  ],
  companies: [ { name: 'GC', pct: 5 } ],
  contingency: { mode: 'pct', val: 2 },
  projectCosts: { land: 1200000, dev: { mode: 'pct', val: 3 }, mkt: { mode: 'amt', val: 75000 }, cls: 25000 },
  other: [ { label: 'Parking', rate: 25, auto: true, count: 0 } ],
  expenses: [ { label: 'Trash', per: 'unit', rate: 12, auto: true, count: 0 },
              { label: 'Mgmt', per: 'pctIncome', rate: 3 } ]
});

test('BUDGET-SYSTEM.md travels with the API byte-for-byte', () => {
  // The API is deployed without the repo root, so the manual the assistant is
  // given is a copy. A drifted copy would teach it stale formulas.
  const root = fs.readFileSync(path.join(__dirname, '..', 'BUDGET-SYSTEM.md'));
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'shared', 'budget-system.md'));
  assert.ok(root.equals(api), 'api/shared/budget-system.md must be an exact copy of BUDGET-SYSTEM.md — run: cp BUDGET-SYSTEM.md api/shared/budget-system.md');
  assert.ok(A.systemPrompt().includes(root.toString('utf8')), 'the manual must be in the system prompt');
});

test('the system prompt is byte-stable, so it caches', () => {
  assert.strictEqual(A.systemPrompt(), A.systemPrompt());
  assert.doesNotMatch(A.systemPrompt(), /\d{4}-\d{2}-\d{2}T/);
});

test('facts are the app\'s own arithmetic, not a fourth copy', () => {
  const d = doc(), p = parts(d), g = grossIncome(d);
  const f = A.budgetFacts(d, null);
  const r2 = n => Math.round(n * 100) / 100;
  assert.strictEqual(f.totals.contractSum, r2(p.contract));
  assert.strictEqual(f.totals.totalProjectCost, r2(p.project));
  assert.strictEqual(f.totals.hardCost, r2(p.hard));
  assert.strictEqual(f.totals.developerFee, r2(p.fee.dev));
  assert.strictEqual(f.income.netAnnual, r2(g.netYr));
  assert.strictEqual(f.inputs.totalUnits, 50);
  assert.strictEqual(f.inputs.buildingSF, 105000);
  assert.strictEqual(f.metrics.projectPerUnit, r2(p.project / 50));
  assert.strictEqual(f.metrics.contractPerSF, r2(p.contract / 105000));
  // Every line total adds back up to hard + soft.
  const sum = f.lines.reduce((s, l) => s + l.total, 0);
  assert.ok(Math.abs(sum - (p.hard + p.soft)) < 0.05);
  // Why a line is flagged is reported, the way the editor reports it.
  assert.deepStrictEqual(f.lines.find(l => l.lineId === 'b').edits, ['rate changed from library rate']);
  assert.strictEqual(f.lines.find(l => l.lineId === 'b').libraryRate, 750);
  assert.strictEqual(f.csiDivisionTotals['09'], 250000);
});

test('an inactive amenity scope is reported as suppressed, at $0', () => {
  const d = doc(); d.amenSF = 0;
  const kitchen = A.budgetFacts(d).lines.find(l => l.lineId === 'c');
  assert.strictEqual(kitchen.total, 0);
  assert.match(kitchen.suppressed, /amenity/);
});

test('diffDocs reports what moved, by line identity, biggest first', () => {
  const a = doc(), b = doc();
  b.lines[0].unit = 3;                                         // 100,000 SF × +$0.50
  b.lines = b.lines.filter(l => l.lineId !== 'd');             // removed
  b.lines.push({ lineId: 'e', scope: 'res', grp: 'X', code: '12 21 00', desc: 'Blinds', basis: 'unit', auto: false, qty: 12, unit: 100, baseUnit: 100 });
  b.resSF = 100000; b.pricingVersion = '2026.2';
  const d = A.diffDocs(a, b);
  assert.strictEqual(d.lines.added.length, 1);
  assert.strictEqual(d.lines.removed[0].lineId, 'd');
  assert.strictEqual(d.lines.changed[0].code, '09 29 00');
  assert.strictEqual(d.lines.changed[0].delta, 50000);
  assert.deepStrictEqual(d.pricingVersion, { from: '2026.1', to: '2026.2' });
  assert.ok(d.totals.contractSum && d.totals.totalProjectCost);
});

test('history is cleaned to alternating user/assistant text', () => {
  const h = A.cleanHistory([
    { role: 'assistant', content: 'orphan' }, { role: 'user', content: 'q1' },
    { role: 'user', content: 'q1b' }, { role: 'assistant', content: 'a1' },
    { role: 'system', content: 'nope' }, { role: 'user', content: 'dangling' }]);
  assert.deepStrictEqual(h, [{ role: 'user', content: 'q1\n\nq1b' }, { role: 'assistant', content: 'a1' }]);
});

/* ---------------------------- orchestration ---------------------------- */

function fakeStore(over) {
  const saved = doc();
  const v1 = doc(); v1.lines[1].unit = 750;
  return Object.assign({
    async loadBudget(id) {
      return id === 'TST-0001' ? { row: { ProjectId: id, Name: 'Assistant Test', ContractSum: 1, ProjectCost: 2 }, doc: saved } : null;
    },
    async listVersions() { return [{ version: 2, savedBy: 'Pat' }, { version: 1, savedBy: 'Pat' }]; },
    async versionDoc(id, n) { return n === 1 ? v1 : n === 2 ? saved : null; },
    async searchBudgets() { return []; },
    async feeSchedule() { return null; }
  }, over || {});
}
const text = t => ({ stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: t }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 } });
function fakeClient(responses) {
  const calls = [];
  return { calls, beta: { messages: { async create(req, opts) {
    calls.push({ req: JSON.parse(JSON.stringify(req)), opts });
    const r = responses[calls.length - 1];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(req) : r;
  } } } };
}
const principal = { userId: 'u1', userDetails: 'pat@example.com', userRoles: ['authenticated'] };
const run = (o) => { A._resetThrottle(); return A.ask(Object.assign({ store: fakeStore(), principal, id: 'TST-0001', env: {} }, o)); };
const bodyOf = r => JSON.parse(r.body);

test('without a key it says so, and never builds a client', async () => {
  const r = await run({ body: { question: 'hi' } });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(bodyOf(r).error, 'ai_not_configured');
});

test('refuses the empty, the oversized, the unknown and the mismatched', async () => {
  const c = fakeClient([]);
  assert.strictEqual((await run({ client: c, body: { question: '  ' } })).status, 400);
  assert.strictEqual((await run({ client: c, body: { question: 'x'.repeat(2001) } })).status, 400);
  assert.strictEqual((await run({ client: c, id: 'TST-0002', body: { question: 'hi' } })).status, 404);
  const d = doc(); d.projectId = 'TST-0009';
  assert.strictEqual((await run({ client: c, body: { question: 'hi', draft: d } })).status, 400);
  assert.strictEqual((await run({ client: c, principal: null, body: { question: 'hi' } })).status, 401);
  assert.strictEqual(c.calls.length, 0);
});

test('one question, one call: context preloaded, prompt cached, Haiku at medium by default', async () => {
  const c = fakeClient([text('The contract sum is $X.')]);
  const r = await run({ client: c, body: { question: 'What is the contract sum?' } });
  assert.strictEqual(r.status, 200);
  const b = bodyOf(r);
  assert.strictEqual(b.answer, 'The contract sum is $X.');
  assert.strictEqual(b.basedOn, 'saved');
  assert.strictEqual(r.activity.question, 'What is the contract sum?');
  assert.strictEqual(r.activity.inputTokens, 100);
  assert.strictEqual(b.activity, undefined, 'the activity record is not sent to the browser');
  const req = c.calls[0].req;
  assert.strictEqual(req.model, 'claude-haiku-5-5');
  assert.deepStrictEqual(req.output_config, { effort: 'medium' });
  assert.deepStrictEqual(req.system[0].cache_control, { type: 'ephemeral' });
  // Haiku 5.5 has no server-side refusal fallback; sending one is a 400.
  assert.strictEqual(req.fallbacks, undefined);
  assert.strictEqual(req.betas, undefined);
  assert.deepStrictEqual(req.tool_choice, { type: 'auto' });
  assert.strictEqual(req.messages.length, 1);
  const ctx = req.messages[0].content;
  assert.match(ctx, /<budget_context basis="saved">/);
  assert.ok(ctx.includes('"contractSum":' + A.budgetFacts(doc()).totals.contractSum));
  assert.match(ctx, /What is the contract sum\?$/);
  assert.ok(c.calls[0].opts.timeout > 0 && c.calls[0].opts.timeout < 45000, 'bounded by the request window');
});

test('a model that supports fallbacks gets them; a dotted model id is accepted', async () => {
  const c = fakeClient([text('ok'), text('ok')]);
  await run({ client: c, env: { ANTHROPIC_MODEL: 'claude-opus-5.5', ANTHROPIC_EFFORT: 'High' }, body: { question: 'q' } });
  let req = c.calls[0].req;
  assert.strictEqual(req.model, 'claude-opus-5-5');
  assert.deepStrictEqual(req.output_config, { effort: 'high' });
  assert.strictEqual(req.fallbacks, 'default');
  assert.deepStrictEqual(req.betas, ['server-side-fallback-2026-07-01']);
  await run({ client: c, env: { ANTHROPIC_MODEL: 'claude-haiku-5.5', ANTHROPIC_FALLBACKS: 'on' }, body: { question: 'q' } });
  req = c.calls[1].req;
  assert.strictEqual(req.model, 'claude-haiku-5-5');
  assert.strictEqual(req.fallbacks, undefined, 'never sent to Haiku, even when asked');
});

test('ANTHROPIC_FALLBACKS=off and a configured model/effort are honoured', async () => {
  const c = fakeClient([text('ok')]);
  await run({ client: c, env: { ANTHROPIC_FALLBACKS: 'off', ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_EFFORT: 'low' },
              body: { question: 'q' } });
  const req = c.calls[0].req;
  assert.strictEqual(req.fallbacks, undefined);
  assert.strictEqual(req.betas, undefined);
  assert.strictEqual(req.model, 'claude-sonnet-5-5');
  assert.deepStrictEqual(req.output_config, { effort: 'low' });
});

test('the effort picked in the chat panel applies to that question only', async () => {
  const c = fakeClient([text('ok'), text('ok')]);
  const r = await run({ client: c, env: { ANTHROPIC_EFFORT: 'low' }, body: { question: 'q', effort: 'High' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(c.calls[0].req.output_config, { effort: 'high' });
  assert.strictEqual(bodyOf(r).effort, 'high', 'the answer says which effort it was given');
  assert.strictEqual(r.activity.effort, 'high');
  const r2 = await run({ client: c, env: { ANTHROPIC_EFFORT: 'low' }, body: { question: 'q' } });
  assert.deepStrictEqual(c.calls[1].req.output_config, { effort: 'low' }, 'absent: the configured default');
  assert.strictEqual(bodyOf(r2).effort, 'low');
});

test('an effort the panel does not offer is refused, not replaced', async () => {
  const c = fakeClient([]);
  for (const effort of ['max', 'xhigh', 'turbo', 3]) {
    const r = await run({ client: c, body: { question: 'q', effort } });
    assert.strictEqual(r.status, 400, String(effort));
    assert.match(bodyOf(r).message, /low, medium or high/);
  }
  assert.strictEqual(c.calls.length, 0);
});

test('the tool loop runs our read-only tools and feeds results back', async () => {
  const c = fakeClient([
    { stop_reason: 'tool_use', content: [
      { type: 'tool_use', id: 't1', name: 'compare_versions', input: { budget_id: 'tst-0001', from_version: '1', to_version: 'current' } },
      { type: 'tool_use', id: 't2', name: 'get_budget', input: { budget_id: 'TST-0404' } }],
      usage: { input_tokens: 10, output_tokens: 5 } },
    text('Accessories went from $750 to $800 a unit.')
  ]);
  const r = await run({ client: c, body: { question: 'Why did it go up since v1?' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(bodyOf(r).toolsUsed, ['compare_versions', 'get_budget']);
  const second = c.calls[1].req.messages;
  const results = second[second.length - 1].content;
  assert.strictEqual(results.length, 2, 'all tool results return in ONE user message');
  const diff = JSON.parse(results[0].content).diff;
  assert.strictEqual(diff.lines.changed[0].code, '10 28 00');
  assert.strictEqual(diff.lines.changed[0].delta, 2500);      // 50 units × $50
  assert.strictEqual(results[1].is_error, true, 'an invisible budget is an error result, not a leak');
  assert.strictEqual(bodyOf(r).usage.input, 110);
});

test('near the deadline the model is told to answer, not to call more tools', async () => {
  let t = 0;
  const c = fakeClient([
    () => { t += 30000; return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'list_versions', input: { budget_id: 'TST-0001' } }], usage: {} }; },
    text('Answer from what I have.')
  ]);
  const r = await run({ client: c, now: () => t, body: { question: 'q' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(c.calls[1].req.tool_choice, { type: 'none' });
});

test('an unsaved draft is what gets explained, labelled as such', async () => {
  const d = doc(); d.resSF = 120000;
  const c = fakeClient([text('ok')]);
  const r = await run({ client: c, body: { question: 'q', draft: d } });
  assert.strictEqual(bodyOf(r).basedOn, 'unsaved-draft');
  assert.match(c.calls[0].req.messages[0].content, /basis="unsaved-draft"/);
  assert.match(c.calls[0].req.messages[0].content, /"residentialSF":120000/);
});

test('history goes first as asked; the on-screen context rides on the latest question', async () => {
  const c = fakeClient([text('ok')]);
  await run({ client: c, body: { question: 'and per unit?',
    history: [{ role: 'user', content: '[Asked while viewing investment analysis "Deal"] what is the IRR?' },
              { role: 'assistant', content: '8.1%' }] } });
  const m = c.calls[0].req.messages;
  assert.deepStrictEqual(m.map(x => x.role), ['user', 'assistant', 'user']);
  assert.strictEqual(m[0].content, '[Asked while viewing investment analysis "Deal"] what is the IRR?');
  assert.match(m[2].content, /^<budget_context[\s\S]*and per unit\?$/);
  assert.match(c.calls[0].req.system[0].text, /One conversation can span screens/);
});

test('a refusal and an upstream failure are clean errors', async () => {
  let r = await run({ client: fakeClient([{ stop_reason: 'refusal', content: [], usage: {} }]), body: { question: 'q' } });
  assert.strictEqual(r.status, 422);
  r = await run({ client: fakeClient([new Error('socket hang up')]), body: { question: 'q' } });
  assert.strictEqual(r.status, 502);
});

test('the throttle stops a runaway client', async () => {
  A._resetThrottle();
  const c = fakeClient(Array.from({ length: 40 }, () => text('ok')));
  let last;
  for (let i = 0; i < 31; i++)
    last = await A.ask({ store: fakeStore(), principal, id: 'TST-0001', env: {}, client: c, body: { question: 'q' } });
  assert.strictEqual(last.status, 429);
});

/* ------------------- pro forma insight (investment engine) ------------------- */

const insight = require('../api/shared/investment/insight');
const { calculateInvestmentAnalysis } = require('../api/shared/investment/calculate');
const FX = fs.readdirSync(path.join(__dirname, 'fixtures', 'investment'))
  .map(f => require(path.join(__dirname, 'fixtures', 'investment', f)));

test('the engine reproduces itself from normalizedInput — what every scenario starts from', () => {
  for (const fx of FX) {
    const r = calculateInvestmentAnalysis(fx.input);
    const again = calculateInvestmentAnalysis(JSON.parse(JSON.stringify(r.normalizedInput)));
    assert.deepStrictEqual(again.summary, r.summary, fx.name);
  }
});

test('drivers are real engine re-runs, ranked by how far they move the IRR', () => {
  const f = insight.analysisFacts(FX[0].input, { name: 'x' });
  assert.ok(f.drivers.length >= 5);
  for (let i = 1; i < f.drivers.length; i++)
    assert.ok(Math.abs(f.drivers[i - 1].irrChange) >= Math.abs(f.drivers[i].irrChange));
  const rent = f.drivers.find(d => d.id === 'rent');
  const norm = calculateInvestmentAnalysis(FX[0].input).normalizedInput;
  const direct = insight.runScenario(norm, { rentChangePct: 0.05 });
  assert.strictEqual(rent.irrChange, direct.change.finalYearEquityIRR);
});

test('a scenario adds income through the engine, exactly', () => {
  const norm = calculateInvestmentAnalysis(FX[0].input).normalizedInput;   // 25% of GOI expenses
  const s = insight.runScenario(norm, { addOtherIncome: [{ label: 'RUBS', annualAmount: 60000 }] });
  assert.ok(!s.error, s.error);
  assert.strictEqual(s.change.year1NOI, 60000 * (1 - norm.expenses.value));
  assert.ok(s.change.finalYearEquityIRR > 0);
  assert.match(insight.runScenario(norm, { bogus: 1 }).error, /Unknown change/);
  assert.match(insight.runScenario(norm, { vacancy: 2 }).error, /between/);
});

test('diagnostics name the classic problems, labelled as rules of thumb', () => {
  const f = insight.analysisFacts(FX[0].input, {});   // Barker: exit cap below entry, thin cash-on-cash
  const ids = f.diagnostics.map(d => d.id);
  assert.ok(ids.includes('exitBelowEntry'));
  assert.ok(ids.includes('negativeLeverage'));
  assert.ok(f.diagnostics.find(d => d.id === 'cashOnCash').finding.includes('rule of thumb'));
  const incomplete = insight.analysisFacts({ analysisName: 'x' }, {});
  assert.match(incomplete.error, /Not calculable/);
});

/* ------------------------------ budget review ------------------------------ */

const { reviewBudget } = require('../api/shared/budget-review');
const LIB = require('./pricing.json');
function libDoc(mul) {
  return { type: 'Multifamily', resSF: 50000, amenSF: 1200, pricingVersion: LIB.version,
    units: [{ label: '1BR', count: 60, sf: 750, rent: 1500 }],
    lines: LIB.lines.map((l, i) => Object.assign({}, l, { lineId: 'l' + i, auto: l.basis !== 'ls', qty: 0,
      baseUnit: l.unit, unit: l.unit * (mul || 1) })),
    companies: [{ name: 'GC', pct: 10 }], contingency: { mode: 'pct', val: 5 },
    projectCosts: { land: 1e6, dev: { mode: 'amt', val: 1 }, mkt: { mode: 'amt', val: 1 }, cls: { mode: 'amt', val: 1 } },
    other: [], expenses: [] };
}

test('review: facts, missing library scope with its cost, and the impact-fee placeholder', () => {
  const d = libDoc();
  d.lines = d.lines.filter(l => l.code !== 'SC-01');          // architect removed
  d.lines[0].unit = 0;                                          // a $0 line
  const r = reviewBudget(d, { library: LIB });
  const kinds = r.findings.map(f => f.kind + ':' + f.area);
  assert.ok(kinds.includes('fact:lines'));
  assert.ok(kinds.includes('fact:impactFees'), 'SC-20 still on $/SF');
  const miss = r.findings.find(f => f.area === 'scope');
  assert.strictEqual(miss.lines[0].code, 'SC-01');
  assert.strictEqual(miss.lines[0].estimatedCostAtLibraryRate, 50000 * 2.65);
  assert.ok(r.findings.some(f => f.kind === 'heuristic' && /Construction loan interest/.test(f.finding)));
});

test('review: portfolio outliers need at least three peers', () => {
  const peers = [libDoc(1), libDoc(1.02), libDoc(0.98)].map(doc => ({ doc }));
  const r2 = reviewBudget(libDoc(1.5), { library: LIB, benchmarks: peers });
  assert.ok(r2.benchmarks.hardPerSF.portfolioMedian > 0);
  assert.ok(r2.findings.some(f => f.kind === 'portfolio' && /hardPerSF/.test(f.finding)));
  assert.strictEqual(reviewBudget(libDoc(1.5), { library: LIB, benchmarks: peers.slice(0, 2) }).benchmarks, null);
});

/* --------------------- both focuses, through ask() --------------------- */

const GUID = '0f1e2d3c-4b5a-4968-8776-655443322110';
function richStore(over) {
  return fakeStore(Object.assign({
    async listAnalyses() { return [{ id: GUID, budgetId: 'TST-0001', projectKey: 'OP-0001', name: 'Base Case',
      status: 'Draft', input: FX[0].input, sourceBudgetVersion: 1, budgetCurrentVersion: 2 }]; },
    async loadAnalysis(id) { return id === GUID ? (await this.listAnalyses())[0] : null; },
    async pricingLibrary() { return LIB; },
    async benchmarkBudgets() { return []; }
  }, over || {}));
}

test('on a budget, the review and its pro formas are in context, and run_scenario defaults to them', async () => {
  const c = fakeClient([
    { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'run_scenario',
      input: { changes: { addOtherIncome: [{ label: 'Storage', annualAmount: 24000 }] } } }] },
    text('ok')]);
  const r = await run({ client: c, store: richStore(), body: { question: 'How can it make more money?' } });
  assert.strictEqual(r.status, 200);
  const ctx = c.calls[0].req.messages[0].content;
  assert.match(ctx, /<budget_review>/);
  assert.match(ctx, /<pro_formas count="1">/);
  assert.match(ctx, /"budgetChangedSinceImport":true/);
  const tr = JSON.parse(c.calls[1].req.messages.at(-1).content[0].content);
  assert.ok(tr.change.year1NOI > 0, JSON.stringify(tr));
});

test('on a pro forma, the analysis, its drivers and its source budget are in context', async () => {
  const c = fakeClient([text('ok')]);
  const r = await run({ client: c, store: richStore(), focus: 'analysis', id: GUID,
    body: { question: 'Why are the returns weak?' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(bodyOf(r).focus, 'analysis');
  const ctx = c.calls[0].req.messages[0].content;
  assert.match(ctx, /<analysis_context basis="saved">/);
  assert.match(ctx, /"drivers":\[/);
  assert.match(ctx, /<source_budget>\nThe budget this analysis was built from/);
  const summary = ctx.split('<source_budget>')[1].split('<budget_review>')[0];
  assert.doesNotMatch(summary, /"lines":\[/, 'line items are left out of the source budget');
  assert.match(summary, /"totalProjectCost":/);
  assert.strictEqual(r.activity.entityType, 'analysis');
  assert.strictEqual(r.activity.entityId, GUID);
});

test('on a pro forma: unsaved assumptions are what gets read; bad and invisible ids are refused', async () => {
  const c = fakeClient([text('ok'), text('ok')]);
  const draft = JSON.parse(JSON.stringify(FX[0].input)); draft.vacancy.value = 0.2;
  const r = await run({ client: c, store: richStore(), focus: 'analysis', id: GUID, body: { question: 'q', draftInput: draft } });
  assert.strictEqual(bodyOf(r).basedOn, 'unsaved-draft');
  assert.match(c.calls[0].req.messages[0].content, /"vacancy":0\.2/);
  assert.strictEqual((await run({ client: c, store: richStore(), focus: 'analysis', id: 'nope', body: { question: 'q' } })).status, 400);
  assert.strictEqual((await run({ client: c, store: richStore({ async loadAnalysis() { return null; } }), focus: 'analysis',
    id: GUID, body: { question: 'q' } })).status, 404);
});

test('review: impact fees set to None are a decision to confirm, not a $0 mistake', () => {
  const d = libDoc();
  const sc20 = d.lines.find(l => l.code === 'SC-20');
  Object.assign(sc20, { derived: 'impactFees', basis: 'ls', auto: false, qty: 1, unit: 0 });
  d.impactFees = { excluded: true, scheduleKey: null, meters: [], extras: [], manual: [] };
  const r = reviewBudget(d, { library: LIB });
  assert.ok(!r.findings.some(f => f.area === 'lines' && /SC-20/.test(f.finding)), 'not reported as priced at $0');
  assert.ok(r.findings.some(f => f.area === 'impactFees' && /None/.test(f.finding)));
  assert.strictEqual(A.budgetFacts(d).impactFees.state, 'none — this project pays no impact fees');
});

/* ------------------- the clock: streaming, partial answers, diagnostics ------------------- */

// A streaming client whose call never finishes on its own; it emits `text`
// (if any) and then waits for the deadline to abort it.
function stallingStreamClient(textSoFar) {
  const calls = [];
  return { calls, beta: { messages: {
    create() { throw new Error('should stream'); },
    stream(req) {
      calls.push(req);
      let onText = null, reject = null;
      const p = new Promise((_, rj) => { reject = rj; });
      return {
        on(ev, fn) { if (ev === 'text') { onText = fn; if (textSoFar) setTimeout(() => onText(textSoFar), 5); } return this; },
        finalMessage() { return p; },
        abort() { reject(Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })); }
      };
    } } } };
}
// Starts the clock 34 s into the 38 s window, so the deadline is ~2.5 s away.
const lateClock = () => { let first = true; return () => (first ? (first = false, 0) : 34000); };

test('a call cut off by the deadline keeps the answer written so far', async () => {
  const r = await run({ client: stallingStreamClient('Total project cost is built from'), now: lateClock(),
    body: { question: 'q' } });
  assert.strictEqual(r.status, 200);
  const b = bodyOf(r);
  assert.strictEqual(b.answer, 'Total project cost is built from');
  assert.strictEqual(b.cutShortForTime, true);
  assert.strictEqual(b.truncated, true);
});

test('a call with no text by the deadline says where the time went', async () => {
  const r = await run({ client: stallingStreamClient(''), now: lateClock(), body: { question: 'q' } });
  assert.strictEqual(r.status, 504);
  const b = bodyOf(r);
  assert.strictEqual(b.error, 'ai_timeout');
  assert.match(b.detail, /gathering context .*s; call 1: .*deadline/);
});

test('a turn that spent its tokens thinking is asked once for the answer', async () => {
  const c = fakeClient([
    { stop_reason: 'max_tokens', usage: { output_tokens: 16000 }, content: [{ type: 'thinking', thinking: '', signature: 's' }] },
    text('The short answer.')]);
  const r = await run({ client: c, body: { question: 'q' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(bodyOf(r).answer, 'The short answer.');
  const m = c.calls[1].req.messages;
  assert.strictEqual(m.at(-2).role, 'assistant', 'the thinking turn is kept, append-only');
  assert.match(m.at(-1).content, /answer now/);
});

test('the forced final answer runs at low effort', async () => {
  let t = 0;
  const c = fakeClient([
    () => { t += 30000; return { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'list_versions', input: { budget_id: 'TST-0001' } }] }; },
    text('ok')]);
  await run({ client: c, now: () => t, body: { question: 'q' } });
  assert.deepStrictEqual(c.calls[0].req.output_config, { effort: 'medium' });
  assert.deepStrictEqual(c.calls[1].req.output_config, { effort: 'low' });
});
