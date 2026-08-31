/* Budget finance — the derived allocation model.

   One file, two runtimes: the browser loads it as a plain script (it hangs off
   window.FSBudgetFinance) and the API requires it as CommonJS. A copy lives at
   api/shared/budget-finance.js and MUST stay byte-identical —
   test/budget-finance.test.js fails the build if the two ever drift, exactly
   as the guardrails pair does.

   This is the SINGLE source the bank budget, profit splits, waterfall,
   intercompany reconciliation, contract generation and budget↔contract
   reconciliation all read from. It is PURE: every function takes the numbers
   the caller already computed — parts() from budget-calc, and (for the bank
   view only) the csiSchedule() division breakdown — and never recomputes them.
   A second implementation of parts() here would be a third thing to keep in
   parity; there are already exactly two (the browser CALC block and
   api/shared/budget-calc.js).

   The doc keeps ONE authoritative profit number: doc.companies drives
   parts().profit and the contract sum, unchanged. This module only MAPS the
   money parts() already produced onto Entity Master entities. A budget with no
   doc.finance and the default single-company doc yields exactly one Finishes
   Solutions split whose profit equals parts().profit — the backward-compat
   identity pinned by the tests.

   Percentages on finance rules are whole numbers (10 means 10%). Money is
   dollars. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSBudgetFinance = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var nz = function (v) { return Number.isFinite(+v) ? +v : 0; };
  var round2 = function (v) { return Math.round((nz(v) + Number.EPSILON) * 100) / 100; };

  /* The offline-only fallback, exactly as DEFAULT_POLICY is for guard rails:
     the live rules ship inside the budget template's published document
     (doc.finance). A budget with no finance rules is a lender budget at a flat
     10% uplift landing on contingency, and one Finishes Solutions split — which
     is today's behaviour before any rules are authored. */
  var DEFAULT_FINANCE = {
    bank: { upliftPct: 10, allocation: [], remainder: 'contingency' },
    allocations: []
  };

  function financeFor(doc, override) {
    var f = override || (doc && doc.finance) || DEFAULT_FINANCE;
    return {
      bank: f.bank || DEFAULT_FINANCE.bank,
      allocations: Array.isArray(f.allocations) ? f.allocations : []
    };
  }

  /* ---- entity name matching ------------------------------------------------
     A doc.companies row names its entity either explicitly (entityKey) or by
     name. slugify turns "Finishes Solutions LLC" into "finishes-solutions" so a
     legacy free-text company lifts onto the seeded entity without a data
     migration. */
  function slugify(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/\bllc\b|\binc\b|\bltd\b|\bl\.l\.c\.?/g, ' ')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  function companyEntityKey(c) {
    if (c && typeof c.entityKey === 'string' && c.entityKey) return c.entityKey;
    return slugify(c && c.name);
  }
  function entityBy(entities, key) {
    var list = entities || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].entityKey === key) return list[i];
    }
    return null;
  }
  function displayFor(entities, key, fallbackName) {
    var e = entityBy(entities, key);
    return {
      displayName: e ? (e.displayName || e.legalName || key) : (fallbackName || key),
      legalName: e ? (e.legalName || e.displayName || key) : (fallbackName || key)
    };
  }

  /* ---- BANK BUDGET ---------------------------------------------------------
     A derived lender view: bankTotal = internal project cost × (1 + upliftPct).
     The uplift pool is distributed across categories by the template's rules,
     and whatever the rules do not place lands on the remainder target — so the
     total is always internal + pool to the cent, and every bank line traces to
     its internal line. The categories partition parts().project exactly:
       project = hard + profit + contingency + soft + land + fees. */
  function bankCategories(parts, csi) {
    var cats = [];
    if (csi && csi.divisions && csi.divisions.length) {
      csi.divisions.forEach(function (d) {
        cats.push({ key: 'div:' + d.key, label: d.title || ('Division ' + d.key),
          kind: 'div', divKey: d.key, internal: nz(d.total) });
      });
    } else {
      cats.push({ key: 'hard', label: 'Construction Hard Cost', kind: 'hard', internal: nz(parts.hard) });
    }
    cats.push({ key: 'profit', label: 'Profit', kind: 'profit', internal: nz(parts.profit) });
    cats.push({ key: 'contingency', label: 'Contingency', kind: 'cont', internal: nz(parts.cont) });
    cats.push({ key: 'soft', label: 'Soft Costs', kind: 'soft', internal: nz(parts.soft) });
    cats.push({ key: 'land', label: 'Land', kind: 'land', internal: nz((parts.landAmt != null) ? parts.landAmt : (parts.project - parts.contract - parts.soft - parts.fees)) });
    cats.push({ key: 'fees', label: 'Developer / Marketing / Closing Fees', kind: 'fees', internal: nz(parts.fees) });
    return cats;
  }

  // Does a rule match a category? 'div' matches one division by key; 'hard'
  // matches every division (or the single hard row); the rest match by kind.
  function ruleMatches(rule, cat) {
    if (!rule) return false;
    if (rule.match === 'div') return cat.kind === 'div' && String(cat.divKey) === String(rule.key);
    if (rule.match === 'hard') return cat.kind === 'div' || cat.kind === 'hard';
    return rule.match === cat.kind;
  }

  function deriveBank(args) {
    args = args || {};
    var parts = args.parts || {};
    var finance = args.finance || financeFor(args.doc);
    var bank = finance.bank || DEFAULT_FINANCE.bank;
    var cats = bankCategories(parts, args.csi);
    var internalTotal = cats.reduce(function (s, c) { return s + c.internal; }, 0);
    var upliftPct = nz(bank.upliftPct);
    var pool = internalTotal * upliftPct / 100;

    // First pass: each rule's uplift on the categories it matches. A division
    // named explicitly by a 'div' rule is claimed, so a following 'hard' rule
    // does not also uplift it.
    var claimed = {};
    var rules = Array.isArray(bank.allocation) ? bank.allocation : [];
    var uplift = {};
    cats.forEach(function (c) { uplift[c.key] = 0; });
    rules.forEach(function (rule) {
      cats.forEach(function (c) {
        if (rule.match === 'hard' && claimed[c.key]) return;
        if (ruleMatches(rule, c)) {
          uplift[c.key] += c.internal * nz(rule.pct) / 100;
          if (rule.match === 'div') claimed[c.key] = true;
        }
      });
    });
    var placed = cats.reduce(function (s, c) { return s + uplift[c.key]; }, 0);

    // Overshoot: rules asked for more than the pool. Scale them down so the
    // total still lands exactly on internal + pool.
    if (placed > pool && placed > 0) {
      var scale = pool / placed;
      cats.forEach(function (c) { uplift[c.key] *= scale; });
      placed = pool;
    }
    var remainder = pool - placed;

    // Place the remainder. 'lenderAllowance' synthesizes its own line so the
    // uplift is visible rather than hidden inside contingency.
    var rows = cats.map(function (c) {
      return { key: c.key, label: c.label, kind: c.kind, divKey: c.divKey || null,
        internal: c.internal, bank: c.internal + uplift[c.key], _uplift: uplift[c.key] };
    });
    var remainderTarget = bank.remainder || 'contingency';
    if (Math.abs(remainder) > 0.005) {
      if (remainderTarget === 'prorata' && internalTotal > 0) {
        rows.forEach(function (r) { r.bank += remainder * (r.internal / internalTotal); });
      } else if (remainderTarget === 'lenderAllowance') {
        rows.push({ key: 'lenderAllowance', label: 'Lender Allowance', kind: 'lenderAllowance',
          divKey: null, internal: 0, bank: remainder, _uplift: remainder });
      } else {
        var contRow = null;
        for (var i = 0; i < rows.length; i++) { if (rows[i].kind === 'cont') { contRow = rows[i]; break; } }
        if (!contRow) { contRow = rows[0]; }
        contRow.bank += remainder;
      }
    }

    var bankTotal = 0;
    rows.forEach(function (r) {
      r.internal = round2(r.internal);
      r.bank = round2(r.bank);
      r.diffUsd = round2(r.bank - r.internal);
      r.diffPct = r.internal > 0 ? r.diffUsd / r.internal : null;
      delete r._uplift;
      bankTotal += r.bank;
    });
    // Absorb any penny of rounding onto the remainder row so the footer is exact.
    var target = round2(internalTotal + pool);
    var drift = round2(target - bankTotal);
    if (Math.abs(drift) >= 0.01 && rows.length) {
      var absorb = null;
      for (var j = 0; j < rows.length; j++) { if (rows[j].kind === 'cont') { absorb = rows[j]; break; } }
      if (!absorb) absorb = rows[rows.length - 1];
      absorb.bank = round2(absorb.bank + drift);
      absorb.diffUsd = round2(absorb.bank - absorb.internal);
      absorb.diffPct = absorb.internal > 0 ? absorb.diffUsd / absorb.internal : null;
      bankTotal = round2(bankTotal + drift);
    }

    return {
      rows: rows,
      internalTotal: round2(internalTotal),
      bankTotal: round2(bankTotal),
      upliftPct: upliftPct,
      upliftUsd: round2(pool),
      remainderUsd: round2(remainder),
      remainderTarget: remainderTarget
    };
  }

  /* ---- PROFIT ALLOCATION ---------------------------------------------------
     Maps the money parts() produced onto entities. Streams:
       companyMarkup — construction profit; profit follows the matching
                       doc.companies row, cost basis is costShare × hard cost.
       devFee/mktFee/clsFee — the project-cost fees, optionally split by share.
     A budget with no allocation rules falls back to one split per company:
     the first company carries the whole hard cost as its basis, each company
     keeps its own markup as profit. So the default single-company doc gives
     one Finishes Solutions row whose profit is exactly parts().profit. */
  function feeAmountFor(parts, stream) {
    var fee = parts.fee || {};
    if (stream === 'devFee') return nz(fee.dev);
    if (stream === 'mktFee') return nz(fee.mkt);
    if (stream === 'clsFee') return nz(fee.cls);
    return 0;
  }

  function allocate(args) {
    args = args || {};
    var doc = args.doc || {};
    var parts = args.parts || {};
    var entities = args.entities || [];
    var finance = args.finance || financeFor(doc);
    var companies = doc.companies || [];
    var hard = nz(parts.hard);
    var project = nz(parts.project);
    var rules = finance.allocations;

    // Profit available per entity, from the authoritative doc.companies markups.
    var profitByEntity = {};
    companies.forEach(function (c) {
      var key = companyEntityKey(c);
      profitByEntity[key] = (profitByEntity[key] || 0) + hard * nz(c.pct) / 100;
    });

    var rowsByKey = {};
    var order = [];
    function ensure(key, stream, basisLabel) {
      if (!rowsByKey[key]) {
        var d = displayFor(entities, key, key);
        rowsByKey[key] = { entityKey: key, displayName: d.displayName, legalName: d.legalName,
          stream: stream, basisLabel: basisLabel, costBasis: 0, profit: 0 };
        order.push(key);
      }
      return rowsByKey[key];
    }

    if (rules.length) {
      rules.forEach(function (rule) {
        if (!rule || !rule.entityKey || rule.stream === 'none') return;
        if (rule.stream === 'companyMarkup') {
          var row = ensure(rule.entityKey, 'companyMarkup', rule.basis || 'markup');
          row.costBasis += hard * nz(rule.costShare);
          if (profitByEntity[rule.entityKey]) row.profit += profitByEntity[rule.entityKey];
        } else if (rule.stream === 'devFee' || rule.stream === 'mktFee' || rule.stream === 'clsFee') {
          var feeRow = ensure(rule.entityKey, rule.stream, rule.basis || 'fee');
          var share = (rule.share == null) ? 1 : nz(rule.share);
          feeRow.profit += feeAmountFor(parts, rule.stream) * share;
        }
      });
      // Any construction profit whose entity was not named by a rule stays with
      // the first companyMarkup entity, so the split never loses a dollar of
      // parts().profit.
      var firstMarkup = null;
      order.forEach(function (k) { if (!firstMarkup && rowsByKey[k].stream === 'companyMarkup') firstMarkup = k; });
      Object.keys(profitByEntity).forEach(function (k) {
        if (!rowsByKey[k] && profitByEntity[k] && firstMarkup) rowsByKey[firstMarkup].profit += profitByEntity[k];
      });
    } else {
      // Fallback: one split per company, first carries the whole hard cost.
      companies.forEach(function (c, i) {
        var key = companyEntityKey(c);
        var row = ensure(key, 'companyMarkup', 'markup');
        if (i === 0) row.costBasis += hard;
        row.profit += hard * nz(c.pct) / 100;
      });
    }

    var rows = order.map(function (key) {
      var r = rowsByKey[key];
      var costBasis = round2(r.costBasis);
      var profit = round2(r.profit);
      var contractValue = round2(costBasis + profit);
      return {
        entityKey: r.entityKey, displayName: r.displayName, legalName: r.legalName,
        stream: r.stream, basisLabel: r.basisLabel,
        costBasis: costBasis, contractValue: contractValue, profit: profit,
        markupPct: costBasis > 0 ? profit / costBasis : null,
        marginPct: contractValue > 0 ? profit / contractValue : null,
        pctOfProject: project > 0 ? contractValue / project : null
      };
    });

    return {
      rows: rows,
      totalCostBasis: round2(rows.reduce(function (s, r) { return s + r.costBasis; }, 0)),
      totalContractValue: round2(rows.reduce(function (s, r) { return s + r.contractValue; }, 0)),
      totalProfit: round2(rows.reduce(function (s, r) { return s + r.profit; }, 0)),
      project: round2(project)
    };
  }

  /* ---- CONTRACT PLAN -------------------------------------------------------
     The expected contract set for a document — the one output that drives
     generation, reconciliation and the requires-review check. The Project
     Entity pays Finishes Solutions the full construction contract sum, and the
     fee entities their fees; Finishes Solutions pays each participating
     construction subcontractor its cost basis plus profit. */
  var FS_KEY = 'finishes-solutions';

  function contractPlan(alloc, parts) {
    var rows = [];
    var contract = round2(nz(parts.contract));
    // Primary: Project Entity → Finishes Solutions.
    rows.push({ allocationKey: FS_KEY + ':primary', contractingEntityKey: '__project_entity__',
      performingEntityKey: FS_KEY, stream: 'primary', amount: contract,
      profit: round2((alloc.rows.filter(function (r) { return r.entityKey === FS_KEY; })[0] || {}).profit || 0) });
    (alloc.rows || []).forEach(function (r) {
      if (r.stream === 'companyMarkup') {
        if (r.entityKey === FS_KEY) return;                 // FS is the primary, not a subcontract
        rows.push({ allocationKey: r.entityKey + ':companyMarkup', contractingEntityKey: FS_KEY,
          performingEntityKey: r.entityKey, stream: 'companyMarkup', amount: r.contractValue, profit: r.profit });
      } else {                                              // fee streams: paid by the project entity
        rows.push({ allocationKey: r.entityKey + ':' + r.stream, contractingEntityKey: '__project_entity__',
          performingEntityKey: r.entityKey, stream: r.stream, amount: r.contractValue, profit: r.profit });
      }
    });
    return { rows: rows, primaryAmount: contract,
      total: round2(rows.reduce(function (s, r) { return s + r.amount; }, 0)) };
  }

  /* ---- INTERCOMPANY CONSOLIDATION -----------------------------------------
     External revenue is what the Project Entity pays out of the group;
     intercompany revenue is what one Finishes company pays another. Summing
     entity gross double-counts the intercompany transfers, so the eliminations
     remove them: consolidated external = Σ entity total − Σ eliminations. */
  function consolidate(alloc, parts, plan) {
    plan = plan || contractPlan(alloc, parts);
    var ext = {}, inter = {}, order = [], nameByKey = {};
    (alloc.rows || []).forEach(function (r) { nameByKey[r.entityKey] = r.displayName; });
    function bump(map, key) { if (!(key in map)) { map[key] = 0; if (order.indexOf(key) < 0) order.push(key); } }
    var eliminations = [];
    plan.rows.forEach(function (p) {
      if (p.contractingEntityKey === '__project_entity__') {
        bump(ext, p.performingEntityKey); bump(inter, p.performingEntityKey);
        ext[p.performingEntityKey] += p.amount;
      } else {
        bump(ext, p.performingEntityKey); bump(inter, p.performingEntityKey);
        inter[p.performingEntityKey] += p.amount;
        eliminations.push({ from: p.contractingEntityKey, to: p.performingEntityKey, amount: p.amount });
      }
    });
    var entityRevenue = order.map(function (k) {
      return { entityKey: k, displayName: nameByKey[k] || k,
        external: round2(ext[k] || 0), intercompany: round2(inter[k] || 0),
        total: round2((ext[k] || 0) + (inter[k] || 0)) };
    });
    var consolidatedExternalRevenue = round2(entityRevenue.reduce(function (s, e) { return s + e.external; }, 0));
    var intercompanyTotal = round2(eliminations.reduce(function (s, e) { return s + e.amount; }, 0));
    var grossTotal = round2(entityRevenue.reduce(function (s, e) { return s + e.total; }, 0));
    return {
      entityRevenue: entityRevenue,
      eliminations: eliminations,
      consolidatedExternalRevenue: consolidatedExternalRevenue,
      intercompanyTotal: intercompanyTotal,
      consolidatedFinishesProfit: round2(alloc.totalProfit),
      checks: { identity: Math.abs(grossTotal - intercompanyTotal - consolidatedExternalRevenue) < 0.02 }
    };
  }

  /* ---- PROFIT WATERFALL ----------------------------------------------------
     Total Project Value → External Project Costs → each Finishes company's
     profit → Consolidated Finishes Profit. Percentages are of project value. */
  function waterfall(alloc, consolidation, parts) {
    var project = round2(nz(parts.project));
    var finishesProfit = round2(alloc.totalProfit);
    var externalCost = round2(project - finishesProfit);
    var stages = [];
    stages.push({ key: 'projectValue', label: 'Total Project Value', kind: 'total', amount: project });
    stages.push({ key: 'externalCost', label: 'External Project Costs', kind: 'cost', amount: -externalCost });
    (alloc.rows || []).forEach(function (r) {
      stages.push({ key: 'profit:' + r.entityKey, label: r.displayName, kind: 'profit', amount: round2(r.profit) });
    });
    stages.push({ key: 'finishesProfit', label: 'Consolidated Finishes Profit', kind: 'result', amount: finishesProfit });
    var running = 0;
    stages.forEach(function (s) {
      if (s.kind === 'total' || s.kind === 'result') { running = (s.kind === 'total') ? s.amount : running; s.running = s.kind === 'total' ? s.amount : finishesProfit; }
      else { running += s.amount; s.running = round2(running); }
      s.pct = project > 0 ? s.amount / project : null;
    });
    return { stages: stages, project: project, externalCost: externalCost, finishesProfit: finishesProfit };
  }

  /* ---- RECONCILIATION ------------------------------------------------------
     Matches the expected contract plan against the live contract rows. Every
     planned allocation should have one contract within a dollar; every contract
     should still point at a planned allocation. */
  function reconcile(plan, contracts) {
    var live = (contracts || []).filter(function (c) { return c && c.status !== 'Void' && c.status !== 'Superseded'; });
    var byKey = {};
    live.forEach(function (c) { byKey[c.allocationKey] = c; });
    var planByKey = {};
    (plan.rows || []).forEach(function (p) { planByKey[p.allocationKey] = p; });

    var rows = [];
    var overall = 'Reconciled';
    function worse(s) {
      var rank = { 'Reconciled': 0, 'Contract–Budget Variance': 1, 'Overallocated': 2, 'Underallocated': 2,
        'Missing Contract': 3, 'Missing Allocation': 3 };
      if ((rank[s] || 0) > (rank[overall] || 0)) overall = s;
    }
    (plan.rows || []).forEach(function (p) {
      var c = byKey[p.allocationKey];
      if (!c) {
        rows.push({ allocationKey: p.allocationKey, entityKey: p.performingEntityKey, stream: p.stream,
          allocationAmount: round2(p.amount), contractId: null, contractAmount: null,
          varianceUsd: round2(p.amount), status: 'Missing Contract' });
        worse('Missing Contract');
      } else {
        var v = round2(nz(c.currentAmount) - p.amount);
        var status = Math.abs(v) < 1 ? 'Reconciled'
          : (v > 0 ? 'Overallocated' : 'Underallocated');
        if (status !== 'Reconciled' && c.status === 'Requires Review') status = 'Contract–Budget Variance';
        rows.push({ allocationKey: p.allocationKey, entityKey: p.performingEntityKey, stream: p.stream,
          allocationAmount: round2(p.amount), contractId: c.contractId, contractAmount: round2(nz(c.currentAmount)),
          varianceUsd: v, status: status });
        if (status !== 'Reconciled') worse(status);
      }
    });
    live.forEach(function (c) {
      if (!planByKey[c.allocationKey]) {
        rows.push({ allocationKey: c.allocationKey, entityKey: c.performingEntityKey || null, stream: null,
          allocationAmount: null, contractId: c.contractId, contractAmount: round2(nz(c.currentAmount)),
          varianceUsd: null, status: 'Missing Allocation' });
        worse('Missing Allocation');
      }
    });
    if (!rows.length) overall = 'Reconciled';
    return { status: overall, rows: rows,
      plannedTotal: round2((plan.rows || []).reduce(function (s, p) { return s + p.amount; }, 0)),
      contractedTotal: round2(live.reduce(function (s, c) { return s + nz(c.currentAmount); }, 0)) };
  }

  return {
    nz: nz, round2: round2, slugify: slugify, companyEntityKey: companyEntityKey,
    DEFAULT_FINANCE: DEFAULT_FINANCE, financeFor: financeFor, FS_KEY: FS_KEY,
    deriveBank: deriveBank, allocate: allocate, contractPlan: contractPlan,
    consolidate: consolidate, waterfall: waterfall, reconcile: reconcile
  };
});
