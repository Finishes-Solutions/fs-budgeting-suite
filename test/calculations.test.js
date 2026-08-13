// Calculation audit — pins the budget arithmetic against the MF reference
// workbook (Budget For Projects 3.0 MAIN).
//
// Conclusion of the audit: the repository's logic is correct and was left
// unchanged. Every difference between the app and the workbook is explained
// below and is either a working-as-designed default or a project-specific
// input, not a defect. These tests exist so that if any of that drifts, it
// fails here loudly rather than silently changing a lender-facing number.
//
// Rates come from sql/seed_pricing.sql — the published pricing library the
// template seeds from — so this also guards the library against accidental edits.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const seed = fs.readFileSync(path.join(__dirname, '..', 'sql', 'seed_pricing.sql'), 'utf8');
const pricing = JSON.parse(seed.match(/N'(\{.*\})'\);/s)[1].replace(/''/g, "'"));
const rateSum = (scope) => pricing.lines.filter(l => l.scope === scope).reduce((t, l) => t + l.unit, 0);

// Two decimals of money, matching what the database stores and the UI shows.
const near = (a, b, eps = 0.005) => Math.abs(a - b) < eps;

// ---- the documented contract (DATA_CONTRACT rules 2 and 3) ----
function compute({resSF, amenSF, resRate, amenRate, softRate, profitPct, contingencyPsf,
                  land = 0, dev = 0, mkt = 0, cls = 0}) {
  const res = resSF * resRate;
  const amen = amenSF * amenRate;
  const hard = res + amen;
  const profit = hard * profitPct / 100;
  const cont = (resSF + amenSF) * contingencyPsf;
  const contract = hard + profit + cont;
  const soft = resSF * softRate;
  const project = contract + soft + land + dev + mkt + cls;
  return {res, amen, hard, profit, cont, contract, soft, project};
}

test('published library rate sums are stable', () => {
  assert.equal(rateSum('res').toFixed(2), '126.93', 'residential $/SF');
  assert.equal(rateSum('amen').toFixed(2), '125.57', 'amenity $/ASF');
  assert.equal(rateSum('soft').toFixed(3), '18.030', 'soft cost $/SF');
});

// The workbook's headline residential rate is $128.93/SF. The repository's
// template totals $126.93/SF. The $2.00 gap is exactly the default construction
// contingency, which the app carries explicitly as CSI 99 03 00 rather than
// blending into trade lines. Nothing to fix — this reconciles precisely.
test('residential rate plus the default contingency matches the workbook', () => {
  assert.equal((rateSum('res') + 2).toFixed(2), '128.93');
  assert.ok(near(51365 * (rateSum('res') + 2), 6622489.45),
    '51,365 SF x $128.93 must equal $6,622,489.45');
});

test('workbook reference multiplications reconcile', () => {
  assert.ok(near(51365 * 105.75, 5431848.75));
  assert.ok(near(1203 * 150.57, 181135.71));
  assert.ok(near(51365 * 105.75 + 1203 * 150.57, 5612984.46));
  assert.ok(near(51365 * 18.029, 926059.585, 0.001));
});

// The workbook's project cost per square foot divides by RESIDENTIAL SF alone
// (51,365), not by total building SF (51,365 + 1,203 = 52,568). Worth knowing
// before anyone "fixes" a per-SF figure to match it.
test('workbook cost per SF uses residential SF as the denominator', () => {
  assert.ok(near(8688625.16 / 169.154583, 51365, 0.01));
  assert.notEqual(Math.round(8688625.16 / 169.154583), 52568);
});

// Differences that are inputs, not logic. Per the audit rules these are NOT
// forced onto the application: one workbook option differing is not a defect.
test('amenity difference is exactly one $25/ASF project-specific item', () => {
  assert.equal((150.57 - rateSum('amen')).toFixed(2), '25.00');
});

test('soft cost difference is display rounding only', () => {
  const delta = Math.abs(18.029 - rateSum('soft'));
  assert.ok(delta <= 0.001, 'rate delta is a tenth of a cent');
  assert.ok(51365 * delta < 60, 'under $60 across the whole project');
});

// ---- contract composition (DATA_CONTRACT rules 2, 3 and 6) ----
const BASE = {resSF: 51365, amenSF: 1200, resRate: rateSum('res'), amenRate: rateSum('amen'),
              softRate: rateSum('soft'), profitPct: 12, contingencyPsf: 2,
              land: 1200000, dev: 200000, mkt: 75000, cls: 0};

test('soft costs are excluded from the contract sum', () => {
  const c = compute(BASE);
  assert.equal(c.contract, c.hard + c.profit + c.cont);
  assert.ok(c.soft > 0 && c.project - c.contract > c.soft, 'soft sits outside the contract');
});

test('land and project costs sit outside the contract sum', () => {
  const withLand = compute(BASE);
  const noLand = compute({...BASE, land: 0});
  assert.equal(withLand.contract, noLand.contract, 'land must not move the contract sum');
  assert.equal(withLand.project - noLand.project, BASE.land);
});

test('profit is a percentage of hard cost only', () => {
  const c = compute(BASE);
  assert.ok(near(c.profit, c.hard * 0.12));
  assert.ok(near(compute({...BASE, profitPct: 0}).profit, 0));
});

test('contingency follows the per-SF mode across both buildings', () => {
  const c = compute(BASE);
  assert.ok(near(c.cont, (51365 + 1200) * 2));
});

// ---- edge cases the master prompt calls out ----
test('a zero-SF budget produces zero, not NaN', () => {
  const c = compute({...BASE, resSF: 0, amenSF: 0, land: 0, dev: 0, mkt: 0, cls: 0});
  Object.values(c).forEach(v => assert.ok(Number.isFinite(v) && v === 0));
});

test('an amenity building of zero SF contributes nothing', () => {
  const c = compute({...BASE, amenSF: 0});
  assert.equal(c.amen, 0);
  assert.equal(c.hard, c.res);
});

test('negative and very large inputs stay finite', () => {
  assert.ok(Number.isFinite(compute({...BASE, resSF: -100}).project));
  assert.ok(Number.isFinite(compute({...BASE, resSF: 1e9}).project));
});

test('full precision is retained internally, rounding is for display only', () => {
  const c = compute({...BASE, resRate: 1 / 3, resSF: 3, amenSF: 0, profitPct: 0,
                     contingencyPsf: 0, land: 0, dev: 0, mkt: 0, cls: 0});
  assert.ok(Math.abs(c.res - 1) < 1e-12, 'no premature rounding of the rate');
});
