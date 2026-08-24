// Guard rails: the browser and API copies must stay byte-identical, and the
// rail arithmetic must judge only what it can actually judge.
//
// The byte-identity check is the important one. A rail that disagreed between
// the Save button and the endpoint would let a breach through in one place and
// refuse a clean budget in the other.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const G = require('../api/shared/guardrails');
const { parts, grossIncome } = require('../api/shared/budget-calc');

test('the browser and API copies are byte-identical', () => {
  const a = fs.readFileSync(path.join(__dirname, '../app/guardrails.js'));
  const b = fs.readFileSync(path.join(__dirname, '../api/shared/guardrails.js'));
  assert.ok(a.equals(b),
    'app/guardrails.js and api/shared/guardrails.js have drifted — copy one over the other');
});

// A complete multifamily budget sitting inside every rail.
function healthyDoc() {
  return {
    type: 'Multifamily', opexSchemaVersion: 2,
    resSF: 50000, amenSF: 2000, siteSF: 120000,
    units: [{ label: '1BR', sf: 800, count: 50, rent: 1600 }],
    other: [{ label: 'Parking', rate: 40, count: 0, auto: true }],
    // 45% of income: 50×1600 + 50×40 = 82,000/mo income, 36,900/mo expenses
    expenses: [{ label: 'Operations', per: 'pctIncome', rate: 45 }],
    lines: [
      { scope: 'res', basis: 'sf', auto: true, unit: 160 },       // 8,000,000
      { scope: 'soft', basis: 'ls', auto: true, unit: 1000000 }   // 1,000,000
    ],
    companies: [{ name: 'FS', pct: 12 }],
    contingency: { mode: 'pct', val: 3 },
    projectCosts: { land: 2000000, dev: { mode: 'pct', val: 3 },
                    mkt: { mode: 'pct', val: 1 }, cls: { mode: 'pct', val: 1 } }
  };
}

function run(doc) {
  const p = parts(doc);
  return G.evaluate({ doc, parts: p, gross: grossIncome(doc), fee: p.fee });
}

test('a healthy multifamily budget clears every rail', () => {
  const r = run(healthyDoc());
  assert.equal(r.blocking, 0, r.breaches.map(b => b.message).join(' | '));
  assert.equal(r.status, 'ok', r.breaches.map(b => b.message).join(' | '));
});

test('the 35-55% expense rail blocks a full-schedule budget outside the range', () => {
  const low = healthyDoc();
  low.expenses = [{ label: 'Operations', per: 'pctIncome', rate: 20 }];
  const rl = run(low);
  const railLow = rl.breaches.find(b => b.id === 'opexRatio');
  assert.ok(railLow, 'a 20% expense ratio must breach');
  assert.equal(railLow.severity, 'error');
  assert.equal(rl.status, 'breach');

  const high = healthyDoc();
  high.expenses = [{ label: 'Operations', per: 'pctIncome', rate: 70 }];
  const railHigh = run(high).breaches.find(b => b.id === 'opexRatio');
  assert.ok(railHigh && railHigh.severity === 'error', 'a 70% expense ratio must breach');
});

test('a pre-schedule budget warns instead of blocking, so release day cannot brick it', () => {
  const old = healthyDoc();
  delete old.opexSchemaVersion;                       // what every existing budget looks like
  old.expenses = [{ label: 'Trash', per: 'unit', rate: 60, auto: true }];   // ~3.7% of income
  const r = run(old);
  const rail = r.breaches.find(b => b.id === 'opexRatio');
  assert.ok(rail, 'the ratio is still reported');
  assert.equal(rail.severity, 'warn');
  assert.equal(rail.staleSchedule, true);
  assert.equal(r.blocking, 0, 'an existing budget must remain saveable');
});

test('a rail with no denominator is not judged, so a blank budget cannot be blocked', () => {
  const r = run({ type: 'Multifamily', opexSchemaVersion: 2 });
  assert.equal(r.blocking, 0);
  assert.equal(r.status, 'ok');
  assert.equal(r.rails.length, 0, 'nothing is judgeable on an empty document');
});

test('an acknowledgement downgrades a blocking rail and carries its reason', () => {
  const doc = healthyDoc();
  doc.expenses = [{ label: 'Operations', per: 'pctIncome', rate: 20 }];
  assert.equal(run(doc).blocking, 1);

  doc.guardrailAcks = [{ id: 'opexRatio', reason: 'Ground lease covers taxes and insurance',
                         byId: 'u1', byName: 'M', at: '2026-08-21T00:00:00Z' }];
  const acked = run(doc);
  const rail = acked.breaches.find(b => b.id === 'opexRatio');
  assert.equal(acked.blocking, 0, 'an acknowledged rail no longer blocks');
  assert.equal(rail.severity, 'warn');
  assert.equal(rail.acked, true);
  assert.equal(rail.ackReason, 'Ground lease covers taxes and insurance');

  // An ack with no reason is not an acknowledgement.
  doc.guardrailAcks = [{ id: 'opexRatio', reason: '   ' }];
  assert.equal(run(doc).blocking, 1);
});

test('acks are pruned once the rail is back in range', () => {
  const doc = healthyDoc();
  doc.guardrailAcks = [{ id: 'opexRatio', reason: 'was out of range' },
                       { id: 'notARail', reason: 'nonsense' }];
  assert.deepEqual(G.pruneAcks(doc, run(doc)), []);
});

test('fee percentages summing past the ceiling block the save', () => {
  const doc = healthyDoc();
  doc.projectCosts.dev = { mode: 'pct', val: 60 };
  doc.projectCosts.mkt = { mode: 'pct', val: 40 };
  const r = run(doc);
  const rail = r.breaches.find(b => b.id === 'feeSum');
  assert.ok(rail && rail.severity === 'error', 'a 100% fee rate cannot be saved');
});

test('unit SF above residential SF blocks; a blank type carries only the hard rails', () => {
  const doc = healthyDoc();
  doc.units = [{ label: '1BR', sf: 1200, count: 50, rent: 1600 }];   // 60,000 > 50,000
  const rail = run(doc).breaches.find(b => b.id === 'unitSF');
  assert.ok(rail && rail.severity === 'error');

  const blank = healthyDoc();
  blank.type = 'Blank';
  blank.expenses = [];
  const ids = run(blank).rails.map(r => r.id);
  assert.ok(!ids.includes('opexRatio'), 'a blank budget is not judged by the multifamily rails');
});
