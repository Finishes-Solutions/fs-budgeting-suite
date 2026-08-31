// Budget finance — the derived allocation model. The browser and API copies
// must stay byte-identical (like the guardrails pair), and the arithmetic must
// reconcile: bank total = internal + uplift, allocations never lose a dollar of
// parts().profit, and consolidated external revenue = Σ entity revenue minus
// the intercompany eliminations.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const F = require('../api/shared/budget-finance');
const { parts } = require('../api/shared/budget-calc');

const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0.01 : eps);

test('the browser and API copies are byte-identical', () => {
  const a = fs.readFileSync(path.join(__dirname, '../app/budget-finance.js'));
  const b = fs.readFileSync(path.join(__dirname, '../api/shared/budget-finance.js'));
  assert.ok(a.equals(b),
    'app/budget-finance.js and api/shared/budget-finance.js have drifted — copy one over the other');
});

// A budget with real hard cost, soft cost, land and fees.
function sampleDoc(extra) {
  return Object.assign({
    type: 'Multifamily', resSF: 50000, amenSF: 0, siteSF: 0,
    units: [{ sf: 800, count: 50, rent: 1600 }],
    other: [], expenses: [],
    lines: [
      { scope: 'res', grp: 'Concrete', code: '03 30 00', basis: 'sf', unit: 40, qty: 0, auto: true },
      { scope: 'res', grp: 'Finishes', code: '09 90 00', basis: 'sf', unit: 20, qty: 0, auto: true },
      { scope: 'soft', grp: 'Soft Costs', code: '01 00 00', basis: 'ls', unit: 800000, qty: 1, auto: false }
    ],
    companies: [{ name: 'Finishes Solutions LLC', pct: 12, entityKey: 'finishes-solutions' }],
    contingency: { mode: 'pct', val: 5 },
    projectCosts: { land: 1200000, dev: { mode: 'amt', val: 200000 }, mkt: { mode: 'amt', val: 75000 }, cls: { mode: 'amt', val: 0 } }
  }, extra || {});
}

const ENTITIES = [
  { entityKey: 'finishes-solutions', displayName: 'Finishes Solutions', legalName: 'Finishes Solutions LLC' },
  { entityKey: 'finishes-construction', displayName: 'Finishes Construction', legalName: 'Finishes Construction LLC' },
  { entityKey: 'finishes-development', displayName: 'Finishes Development', legalName: 'Finishes Development LLC' },
  { entityKey: 'finishes-marketing', displayName: 'Finishes Marketing', legalName: 'Finishes Marketing LLC' },
  { entityKey: 'brokerage', displayName: 'Brokerage', legalName: 'Finishes Brokerage LLC' }
];

test('parts() categories partition the project cost exactly', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  const land = p.project - p.contract - p.soft - p.fees;
  assert.ok(near(p.hard + p.profit + p.cont + p.soft + land + p.fees, p.project),
    'hard + profit + contingency + soft + land + fees must equal project');
});

test('bank total = internal project cost + uplift, to the cent', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  const bank = F.deriveBank({ doc, parts: p, finance: { bank: { upliftPct: 10, allocation: [], remainder: 'contingency' } } });
  assert.ok(near(bank.internalTotal, p.project), 'internalTotal is project cost');
  assert.ok(near(bank.bankTotal, p.project * 1.10), 'bankTotal is 110% of project');
  assert.ok(near(bank.bankTotal, bank.internalTotal + bank.upliftUsd), 'bank = internal + uplift');
  const sumRows = bank.rows.reduce((s, r) => s + r.bank, 0);
  assert.ok(near(sumRows, bank.bankTotal), 'rows sum to bankTotal');
});

test('category uplift rules reconcile via the remainder', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  const finance = { bank: { upliftPct: 10, remainder: 'contingency', allocation: [
    { match: 'div', key: '03', pct: 15 }, { match: 'hard', pct: 8 }, { match: 'soft', pct: 5 }
  ] } };
  // csi-style division breakdown so 'div' rules have something to match.
  const csi = { divisions: [
    { key: '03', title: 'Concrete', total: 50000 * 40 },
    { key: '09', title: 'Finishes', total: 50000 * 20 }
  ] };
  const bank = F.deriveBank({ doc, parts: p, csi, finance });
  assert.ok(near(bank.bankTotal, p.project * 1.10), 'still 110% overall');
  const div03 = bank.rows.find(r => r.divKey === '03');
  assert.ok(near(div03.diffUsd, 50000 * 40 * 0.15), 'Division 03 carries its 15% uplift');
});

test('overshooting rules scale down to the pool', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  // 500% on hard would blow past a 10% pool; must scale so total stays 110%.
  const bank = F.deriveBank({ doc, parts: p, finance: { bank: { upliftPct: 10, remainder: 'contingency',
    allocation: [{ match: 'hard', pct: 500 }] } } });
  assert.ok(near(bank.bankTotal, p.project * 1.10), 'scaled to the pool');
});

test('default doc yields one Finishes Solutions split whose profit is parts().profit', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  const alloc = F.allocate({ doc, parts: p, entities: ENTITIES });
  assert.equal(alloc.rows.length, 1);
  assert.equal(alloc.rows[0].entityKey, 'finishes-solutions');
  assert.ok(near(alloc.rows[0].profit, p.profit), 'FS profit equals parts().profit');
  assert.ok(near(alloc.totalProfit, p.profit), 'total profit equals parts().profit');
});

test('markup and margin identities hold', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  const alloc = F.allocate({ doc, parts: p, entities: ENTITIES });
  alloc.rows.forEach(r => {
    if (r.costBasis > 0) assert.ok(near(r.profit, r.costBasis * r.markupPct), 'profit = costBasis × markup');
    if (r.contractValue > 0) assert.ok(near(r.profit, r.contractValue * r.marginPct), 'profit = contractValue × margin');
  });
});

test('markup is null (not NaN) on a zero cost basis', () => {
  const doc = sampleDoc({ companies: [
    { name: 'Finishes Development', pct: 0, entityKey: 'finishes-development' }
  ] });
  const p = parts(doc);
  const alloc = F.allocate({ doc, parts: p, entities: ENTITIES, finance: { bank: F.DEFAULT_FINANCE.bank,
    allocations: [{ entityKey: 'finishes-development', stream: 'devFee' }] } });
  const dev = alloc.rows.find(r => r.entityKey === 'finishes-development');
  assert.strictEqual(dev.markupPct, null);
});

test('consolidation: consolidated external = Σ entity total − eliminations (the $10M/$7M shape)', () => {
  // Two construction entities so Finishes Solutions subcontracts to another.
  const doc = sampleDoc({ companies: [
    { name: 'Finishes Solutions', pct: 8, entityKey: 'finishes-solutions' },
    { name: 'Finishes Construction', pct: 4, entityKey: 'finishes-construction' }
  ] });
  const p = parts(doc);
  const finance = { bank: F.DEFAULT_FINANCE.bank, allocations: [
    { entityKey: 'finishes-solutions', stream: 'companyMarkup', costShare: 0.3 },
    { entityKey: 'finishes-construction', stream: 'companyMarkup', costShare: 0.7 },
    { entityKey: 'finishes-development', stream: 'devFee' },
    { entityKey: 'finishes-marketing', stream: 'mktFee' }
  ] };
  const alloc = F.allocate({ doc, parts: p, entities: ENTITIES, finance });
  const plan = F.contractPlan(alloc, p);
  const con = F.consolidate(alloc, p, plan);
  const grossTotal = con.entityRevenue.reduce((s, e) => s + e.total, 0);
  assert.ok(near(grossTotal - con.intercompanyTotal, con.consolidatedExternalRevenue),
    'consolidated external = gross − intercompany');
  assert.ok(con.checks.identity, 'identity check passes');
  // The Project Entity pays FS the whole construction contract externally.
  const fs = con.entityRevenue.find(e => e.entityKey === 'finishes-solutions');
  assert.ok(near(fs.external, p.contract), 'FS external revenue is the construction contract');
});

test('contract plan primary equals the construction contract sum', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  const alloc = F.allocate({ doc, parts: p, entities: ENTITIES });
  const plan = F.contractPlan(alloc, p);
  assert.ok(near(plan.primaryAmount, p.contract), 'primary contract = parts().contract');
  const primary = plan.rows.find(r => r.stream === 'primary');
  assert.equal(primary.performingEntityKey, 'finishes-solutions');
});

test('reconciliation reports every status', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  const alloc = F.allocate({ doc, parts: p, entities: ENTITIES });
  const plan = F.contractPlan(alloc, p);

  // No contracts → Missing Contract.
  assert.equal(F.reconcile(plan, []).status, 'Missing Contract');

  // Exact contract for the primary → Reconciled (single-row plan here).
  const exact = plan.rows.map((r, i) => ({ contractId: i + 1, allocationKey: r.allocationKey,
    currentAmount: r.amount, performingEntityKey: r.performingEntityKey, status: 'Generated' }));
  assert.equal(F.reconcile(plan, exact).status, 'Reconciled');

  // Contract larger than allocation → Overallocated.
  const over = exact.map(c => ({ ...c, currentAmount: c.currentAmount + 5000 }));
  assert.equal(F.reconcile(plan, over).status, 'Overallocated');

  // A live contract for an allocation that no longer exists → Missing Allocation.
  const orphan = exact.concat([{ contractId: 99, allocationKey: 'ghost:companyMarkup',
    currentAmount: 1000, performingEntityKey: 'ghost', status: 'Generated' }]);
  assert.equal(F.reconcile(plan, orphan).status, 'Missing Allocation');
});

test('waterfall ends at the consolidated Finishes profit', () => {
  const doc = sampleDoc();
  const p = parts(doc);
  const alloc = F.allocate({ doc, parts: p, entities: ENTITIES });
  const con = F.consolidate(alloc, p);
  const wf = F.waterfall(alloc, con, p);
  assert.equal(wf.stages[0].kind, 'total');
  assert.ok(near(wf.stages[0].amount, p.project));
  const last = wf.stages[wf.stages.length - 1];
  assert.equal(last.kind, 'result');
  assert.ok(near(last.amount, alloc.totalProfit), 'ends at total Finishes profit');
});

test('slugify lifts a legacy free-text company onto its entity key', () => {
  assert.equal(F.slugify('Finishes Solutions LLC'), 'finishes-solutions');
  assert.equal(F.companyEntityKey({ name: 'Finishes Solutions LLC' }), 'finishes-solutions');
  assert.equal(F.companyEntityKey({ name: 'x', entityKey: 'brokerage' }), 'brokerage');
});
