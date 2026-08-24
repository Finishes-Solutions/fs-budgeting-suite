// Pure-logic tests for the impact & tap fee calculator. No browser, no database.
//
// The acceptance criterion is the City of Waller schedule itself: every row's
// low and high total must reproduce what the city publishes, because that
// workbook is the thing this feature exists to replace. If these pass, the
// number on the budget is the number on the city's table.
//
//   node --test test/impact-fees.test.js     (or ./test/run-all.sh, which includes it)
const test = require('node:test');
const assert = require('node:assert');

const IF = require('../app/impact-fees');
const SCHEDULE = require('./fee-schedules.json')['tx-waller'];

const one = (rowId, basis, sel) => IF.evaluate(SCHEDULE, {
  scheduleKey: 'tx-waller', basis,
  meters: [Object.assign({ rowId, qty: 1 }, sel || {})]
}).total;

// Money compares to the cent: these are dollars, not floats in the abstract.
const cents = n => Math.round(n * 100) / 100;

/* Every published low/high total from the workbook, verbatim. This is the whole
   point of the feature, so it is the whole first test rather than a spot check. */
const PUBLISHED = [
  ['m-58-34-10',      15472.94,      16588.94],
  ['m-34-15',         21156.41,      22279.66],
  ['m-1-25',          33095.85,      35851.73],
  ['m-1p5-50',        63931.18,      66427.81],
  ['m-2-80',          98458.00,     100354.63],
  ['m-2-100',        121075.87,     122972.50],
  ['m-3-160',        190198.00,     193386.75],
  ['m-3-240',        280669.50,     283858.25],
  ['m-4-250',        308822.43,     318972.18],
  ['m-4-420',        501074.37,     511224.12],
  ['m-6-500',        602910.87,     616276.87],
  ['m-6-920',       1077886.23,    1091252.23],
  ['m-8-800',        957796.99,     975867.49],
  ['m-8-1600',      1862511.98,    1880582.48],
  ['m-10-1150',     1372947.79,    1393927.79],
  ['m-10-2500',     2899654.33,    2920634.33],
  ['m-12-3300',     3824419.90,    3852287.55]
];

test('every meter row reproduces the published low and high totals', () => {
  assert.equal(PUBLISHED.length, SCHEDULE.meters.length, 'fixture row count');
  for (const [rowId, low, high] of PUBLISHED) {
    assert.equal(cents(one(rowId, 'low')), low, rowId + ' low');
    assert.equal(cents(one(rowId, 'high')), high, rowId + ' high');
  }
});

test('average sits exactly between low and high', () => {
  for (const [rowId, low, high] of PUBLISHED) {
    assert.equal(cents(one(rowId, 'avg')), cents((low + high) / 2), rowId + ' avg');
  }
});

test('impact fees are single-valued — only the adders move with basis', () => {
  // 4" @ 250 gpm: the spread is meter 3799/4748.75 + vault 14500/21000
  // + two taps 3900/5250. The two impact fees are the same at every basis.
  const r = IF.rowAmounts(SCHEDULE.meters.find(m => m.rowId === 'm-4-250'), { qty: 1 }, 'low');
  const h = IF.rowAmounts(SCHEDULE.meters.find(m => m.rowId === 'm-4-250'), { qty: 1 }, 'high');
  assert.equal(r.each.waterImpact, h.each.waterImpact);
  assert.equal(r.each.sewerImpact, h.each.sewerImpact);
  assert.equal(cents(h.each.total - r.each.total), cents(318972.18 - 308822.43));
});

test('the per-EDU rates the schedule publishes explain the impact fees', () => {
  // Derived, not stored: the schedule's own rates times each row's EDU should
  // land within a cent of the published amount. This is what proves the seeded
  // table is internally consistent — and why the stored amount stays
  // authoritative, since 330 EDU drifts by 12 cents.
  // The tolerance is not a fudge factor: the rates are published to the cent, so
  // the drift a rounded rate can produce is at most half a cent per EDU. Asserting
  // exactly that bound is the claim — the rows are consistent with the rates, and
  // the disagreement is rounding and nothing else.
  for (const m of SCHEDULE.meters) {
    const bound = m.edu * 0.005 + 1e-9;
    assert.ok(Math.abs(m.edu * SCHEDULE.eduRates.water - m.waterImpact) <= bound,
      m.rowId + ' water');
    assert.ok(Math.abs(m.edu * SCHEDULE.eduRates.sewer - m.sewerImpact) <= bound,
      m.rowId + ' sewer');
  }
  const big = SCHEDULE.meters.find(m => m.rowId === 'm-12-3300');
  assert.notEqual(cents(big.edu * SCHEDULE.eduRates.water), big.waterImpact,
    'the 330-EDU row is exactly the rounding case the stored amount protects');
});

test('meters 3 inch and under have no vault, and it contributes nothing', () => {
  const noVault = SCHEDULE.meters.filter(m => !m.vault);
  assert.equal(noVault.length, 8, 'eight rows are 3 inch or smaller');
  assert.equal(SCHEDULE.meters.filter(m => m.vault).length, 9);
  for (const m of noVault) {
    const r = IF.rowAmounts(m, { qty: 1 }, 'high');
    assert.equal(r.each.vault, 0, m.rowId);
    assert.equal(r.hasVault, false);
  }
});

test('an absent range and an explicit null price identically', () => {
  const base = SCHEDULE.meters.find(m => m.rowId === 'm-58-34-10');
  const withNull = Object.assign({}, base, { vault: null });
  assert.equal(IF.rowAmounts(base, { qty: 1 }, 'high').total,
               IF.rowAmounts(withNull, { qty: 1 }, 'high').total);
});

test('quantity multiplies, and zero contributes nothing', () => {
  assert.equal(cents(one('m-4-250', 'high', { qty: 2 })), cents(2 * 318972.18));
  assert.equal(one('m-4-250', 'high', { qty: 0 }), 0);
});

test('a mixed meter mix sums its rows exactly', () => {
  const r = IF.evaluate(SCHEDULE, {
    scheduleKey: 'tx-waller', basis: 'high',
    meters: [{ rowId: 'm-2-100', qty: 2 }, { rowId: 'm-6-500', qty: 1 }]
  });
  assert.equal(cents(r.total), cents(2 * 122972.50 + 616276.87));
  assert.equal(r.rows.length, 2);
});

test('include toggles drop only what they name', () => {
  const full = one('m-4-250', 'high');
  const noMeter = one('m-4-250', 'high', { includeMeter: false });
  const noTaps = one('m-4-250', 'high', { includeTaps: false });
  const noVault = one('m-4-250', 'high', { includeVault: false });
  assert.equal(cents(full - noMeter), 4748.75);
  assert.equal(cents(full - noTaps), cents(5250 + 5250));
  assert.equal(cents(full - noVault), 21000);
  // Impact fees survive every toggle — they are what the city charges for
  // capacity, not for hardware.
  assert.equal(cents(one('m-4-250', 'high',
    { includeMeter: false, includeVault: false, includeTaps: false })),
    cents(92247.76 + 190475.67));
});

test('no schedule, no selection, and junk input all total zero rather than NaN', () => {
  for (const [sch, f] of [[null, null], [SCHEDULE, null], [null, { basis: 'high' }],
                          [SCHEDULE, { meters: [{ rowId: 'nope', qty: 3 }] }],
                          [SCHEDULE, { meters: [{ rowId: 'm-2-100', qty: 'abc' }] }]]) {
    const r = IF.evaluate(sch, f, {});
    assert.equal(r.total, 0);
    assert.ok(Number.isFinite(r.total));
  }
});

test('an unknown basis falls back to high, which is the conservative side', () => {
  assert.equal(one('m-4-250', 'sideways'), one('m-4-250', 'high'));
  assert.equal(one('m-4-250', undefined), one('m-4-250', 'high'));
  assert.equal(IF.DEFAULT_BASIS, 'high');
});

test('generic fees price against the budget they are attached to', () => {
  const sch = Object.assign({}, SCHEDULE, { fees: [
    { feeId: 'road', label: 'Roadway Impact Fee', basis: 'unit', amount: { low: 800, high: 1200 } },
    { feeId: 'park', label: 'Park Fee', basis: 'flat', amount: { low: 25000, high: 25000 } },
    { feeId: 'drain', label: 'Drainage', basis: 'acre', amount: { low: 500, high: 900 } },
    { feeId: 'plan', label: 'Plan Review', basis: 'pctHard', amount: { low: 0.5, high: 0.75 } }
  ] });
  const ctx = { units: 58, acres: 7.6, resSF: 51365, amenSF: 1200, hard: 10000000 };
  const r = IF.evaluate(sch, { scheduleKey: 'tx-waller', basis: 'high', meters: [],
    extras: [{ feeId: 'road' }, { feeId: 'park' }, { feeId: 'drain' }, { feeId: 'plan' }] }, ctx);
  assert.equal(cents(r.extrasTotal),
    cents(1200 * 58 + 25000 + 900 * 7.6 + 10000000 * 0.75 / 100));
  assert.equal(r.extras.length, 4);
});

test('manual one-off fees add on top and need no schedule entry', () => {
  const r = IF.evaluate(SCHEDULE, { scheduleKey: 'tx-waller', basis: 'high',
    meters: [{ rowId: 'm-2-100', qty: 1 }],
    manual: [{ rowId: 'man-1', label: 'Fire line tap', amount: 12500 }] });
  assert.equal(cents(r.total), cents(122972.50 + 12500));
  assert.equal(cents(r.manualTotal), 12500);
});

test('an override replaces the total but keeps the derivation visible', () => {
  const r = IF.evaluate(SCHEDULE, { scheduleKey: 'tx-waller', basis: 'high',
    meters: [{ rowId: 'm-4-250', qty: 1 }],
    override: { amount: 250000, reason: 'City agreed a reduced rate', by: 'Someone', at: '2026-08-24' } });
  assert.equal(r.total, 250000);
  assert.equal(cents(r.derivedTotal), 318972.18);
  assert.equal(r.rows.length, 1, 'the rows still render next to the override');
  // A malformed override is ignored rather than zeroing the line.
  const bad = IF.evaluate(SCHEDULE, { scheduleKey: 'tx-waller', basis: 'high',
    meters: [{ rowId: 'm-4-250', qty: 1 }], override: { reason: 'no amount' } });
  assert.equal(cents(bad.total), 318972.18);
});

test('provenance names the jurisdiction, the basis and the version', () => {
  const r = IF.evaluate(SCHEDULE, { scheduleKey: 'tx-waller', scheduleName: 'City of Waller, TX',
    scheduleVersion: 1, basis: 'high', meters: [{ rowId: 'm-4-250', qty: 1 }] });
  assert.equal(IF.provenance(r), 'City of Waller, TX (high side, v1)');
  assert.equal(IF.provenance(IF.evaluate(null, null, {})), '');
});

test('the same meter size can be carried twice and does not collapse', () => {
  // A project served by a domestic meter AND an irrigation meter of the same
  // size is ordinary. Selections are a list keyed by their own id, so this must
  // price as two meters — keying by size would silently halve the fee.
  const r = IF.evaluate(SCHEDULE, { scheduleKey: 'tx-waller', basis: 'high', meters: [
    { id: 'a', rowId: 'm-2-100', label: 'Domestic',   qty: 1 },
    { id: 'b', rowId: 'm-2-100', label: 'Irrigation', qty: 1 }
  ] });
  assert.equal(r.rows.length, 2);
  assert.equal(cents(r.total), cents(2 * 122972.50));
  assert.deepEqual(r.rows.map(x => x.label), ['Domestic', 'Irrigation']);
  assert.deepEqual(r.rows.map(x => x.id), ['a', 'b']);
});

test('a mixed set of meters prices as the sum of its rows', () => {
  // Domestic + irrigation + fire line, three different sizes.
  const r = IF.evaluate(SCHEDULE, { scheduleKey: 'tx-waller', basis: 'high', meters: [
    { id: 'a', rowId: 'm-2-100', label: 'Domestic',  qty: 1 },
    { id: 'b', rowId: 'm-1-25',  label: 'Irrigation', qty: 1 },
    { id: 'c', rowId: 'm-6-500', label: 'Fire line',  qty: 1 }
  ] });
  assert.equal(cents(r.total), cents(122972.50 + 35851.73 + 616276.87));
});

test('a meter name always carries the rate, because size is ambiguous', () => {
  const two = SCHEDULE.meters.filter(m => m.size === '2');
  assert.equal(two.length, 2, 'the schedule really does have two 2-inch rows');
  assert.deepEqual(two.map(IF.meterName),
    ['2" \u00b7 80 gpm \u00b7 8 EDU', '2" \u00b7 100 gpm \u00b7 10 EDU']);
  // And they are genuinely different money — this is why size alone cannot key
  // a selection or label a dropdown option.
  assert.notEqual(cents(one('m-2-80', 'high')), cents(one('m-2-100', 'high')));
});

test('a selection naming a meter the schedule does not have is dropped, not counted', () => {
  const r = IF.evaluate(SCHEDULE, { scheduleKey: 'tx-waller', basis: 'high', meters: [
    { id: 'a', rowId: 'm-2-100', qty: 1 },
    { id: 'b', rowId: 'm-nonexistent', qty: 5 }
  ] });
  assert.equal(r.rows.length, 1);
  assert.equal(cents(r.total), 122972.50);
});
