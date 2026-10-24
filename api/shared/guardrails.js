/* Budget guard rails — the shared, authoritative rail evaluator.

   One file, two runtimes: the browser loads it as a plain script (it hangs
   off window.FSGuardrails) and the API requires it as CommonJS. A copy lives
   at api/shared/guardrails.js and MUST stay byte-identical —
   test/guardrails.test.js fails the build if the two ever drift. A rail that
   disagreed between the Save button and the endpoint would be a support
   ticket, not a rounding difference.

   evaluate() is PURE and takes already-computed arithmetic. It never
   recomputes parts()/grossIncome() itself, because there are exactly two
   implementations of those (the browser CALC block and
   api/shared/budget-calc.js) and a third copy here would be a third thing to
   keep in parity. Callers hand in the numbers they already have.

   Rates are decimal fractions throughout (35% is 0.35), matching
   api/shared/investment/defaults.js. Money rails are dollars.

   WHERE THE POLICY COMES FROM. The design was for the live policy to ship
   inside the budget template's published version document
   (doc.guardrails); nothing writes doc.guardrails today, so DEFAULT_POLICY
   is what applies. The SERVER never reads doc.guardrails or doc.type for its
   gate: both arrive in the very request being judged, so a hand-crafted save
   could choose its own rails (BUDGET-SYSTEM.md D7). api/budget/index.js
   passes an explicit `policy` instead — one type's rail table, chosen from
   DEFAULT_POLICY by a type it trusts (see policyForType below). If templates
   ever do carry a policy, it has to reach the server from the TEMPLATE, not
   from the budget document. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FSGuardrails = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var nz = function (v) { return Number.isFinite(+v) ? +v : 0; };

  /* The document schema version at which the full OPEX schedule (property
     taxes, insurance, management, payroll, R&M, reserves) exists. Below it a
     budget carries only the old service-expense rows, which total ~9% of
     income — so the 35-55% rail warns instead of blocking, or release day
     would make every budget in the database unsaveable at once. */
  var OPEX_SCHEMA_FULL = 2;

  var DEFAULT_POLICY = {
    Multifamily: {
      opexRatio:      { min: 0.35,  max: 0.55, severity: 'error' },
      feeSum:         {             max: 0.95, severity: 'error' },
      unitSF:         {             max: 1,    severity: 'error' },
      devFee:         { min: 0.02,  max: 0.05 },
      marketing:      { min: 0.005, max: 0.02 },
      closing:        { min: 0.005, max: 0.03 },
      landShare:      { min: 0.10,  max: 0.25 },
      profitMargin:   { min: 0.08,  max: 0.20 },
      contingency:    { min: 0.02,  max: 0.10 },
      softCost:       { min: 0.08,  max: 0.20 },
      hardCostPSF:    { min: 120,   max: 260 },
      rentPSF:        { min: 1.00,  max: 3.50 },
      bldgEfficiency: { min: 0.70,  max: 0.95 },
      siteEfficiency: { min: 0.15,  max: 1.20 }
    },
    // A blank budget describes something the multifamily model does not, so
    // only the arithmetic impossibilities apply.
    Blank: {
      feeSum: { max: 0.95, severity: 'error' },
      unitSF: { max: 1,    severity: 'error' }
    }
  };

  /* opexRatio: a budget with income but NO expense rows has not reached the
     expenses yet — "not entered", like a zero developer fee — so it is not
     judged. It used to read as 0% and block the save (BUDGET-SYSTEM.md D6).
     Rows that are present but total zero ARE judged: that is a schedule
     somebody filled in, and 0% operating cost is not a real building. */
  function hasExpenseRows(doc) {
    return !!(doc && Array.isArray(doc.expenses) && doc.expenses.length);
  }

  /* Every rail: what it measures, how to read it, and which input to point
     at. `path` is the data-gr key the budget page outlines; `value` returns
     null when the rail cannot be judged yet. A rail that returns null is NOT
     a breach — a blank budget, one with no units entered, one with no expense
     rows. Without that rule, block-on-save makes it impossible to create a
     budget at all. */
  var RAILS = [
    { id: 'opexRatio', label: 'Operating Expenses', unit: 'pct', path: 'expenses',
      measures: 'operating expenses ÷ gross income',
      value: function (c) {
        return c.gross.grossYr > 0 && hasExpenseRows(c.doc) ? (12 * c.gross.expMo) / c.gross.grossYr : null; } },

    { id: 'feeSum', label: 'Fee Percentages', unit: 'pct', path: 'projectCosts',
      measures: 'developer fee % + marketing % + closing %',
      value: function (c) { return c.pctFeeRate === null ? null : c.pctFeeRate; } },

    { id: 'unitSF', label: 'Unit SF vs Residential SF', unit: 'pct', path: 'units',
      measures: 'leasable unit SF ÷ residential SF',
      value: function (c) { return c.resSF > 0 && c.rentableSF > 0 ? c.rentableSF / c.resSF : null; } },

    /* A fee left at zero has not been ENTERED; it is not "too low". Judging it
       would put a warning on every new budget for a field nobody has reached
       yet, which is how a rail stops being read at all. */
    { id: 'devFee', label: 'Developer Fee', unit: 'pct', path: 'pcDev',
      measures: 'developer fee ÷ total project cost',
      value: function (c) { return c.parts.project > 0 && c.fee.dev > 0 ? c.fee.dev / c.parts.project : null; } },

    { id: 'marketing', label: 'Marketing / Brokerage', unit: 'pct', path: 'pcMkt',
      measures: 'marketing ÷ total project cost',
      value: function (c) { return c.parts.project > 0 && c.fee.mkt > 0 ? c.fee.mkt / c.parts.project : null; } },

    { id: 'closing', label: 'Closing Costs', unit: 'pct', path: 'pcCls',
      measures: 'closing costs ÷ total project cost',
      value: function (c) { return c.parts.project > 0 && c.fee.cls > 0 ? c.fee.cls / c.parts.project : null; } },

    { id: 'landShare', label: 'Land Share', unit: 'pct', path: 'pcLand',
      measures: 'land ÷ total project cost',
      value: function (c) {
        return c.parts.project > 0 && nz(c.doc.projectCosts && c.doc.projectCosts.land) > 0
          ? nz(c.doc.projectCosts.land) / c.parts.project : null; } },

    { id: 'profitMargin', label: 'Profit', unit: 'pct', path: 'companies',
      measures: 'profit ÷ construction hard cost',
      value: function (c) { return c.parts.hard > 0 ? c.parts.profit / c.parts.hard : null; } },

    { id: 'contingency', label: 'Contingency', unit: 'pct', path: 'contingency',
      measures: 'contingency ÷ construction hard cost',
      value: function (c) { return c.parts.hard > 0 ? c.parts.cont / c.parts.hard : null; } },

    { id: 'softCost', label: 'Soft Costs', unit: 'pct', path: 'soft',
      measures: 'soft costs ÷ construction hard cost',
      value: function (c) { return c.parts.hard > 0 && c.parts.soft > 0 ? c.parts.soft / c.parts.hard : null; } },

    { id: 'hardCostPSF', label: 'Hard Cost / SF', unit: 'usd', path: 'resSF',
      measures: 'construction hard cost ÷ building SF',
      value: function (c) { return c.bldgSF > 0 && c.parts.hard > 0 ? c.parts.hard / c.bldgSF : null; } },

    { id: 'rentPSF', label: 'Rent / SF / Month', unit: 'usd', path: 'units',
      measures: 'blended monthly rent ÷ leasable unit SF',
      value: function (c) { return c.rentableSF > 0 ? c.gross.rentMo / c.rentableSF : null; } },

    { id: 'bldgEfficiency', label: 'Building Efficiency', unit: 'pct', path: 'resSF',
      measures: 'leasable unit SF ÷ residential SF',
      value: function (c) { return c.resSF > 0 && c.rentableSF > 0 ? c.rentableSF / c.resSF : null; } },

    { id: 'siteEfficiency', label: 'Site Efficiency (FAR)', unit: 'pct', path: 'siteSF',
      measures: 'building SF ÷ site SF',
      value: function (c) { return c.siteSF > 0 && c.bldgSF > 0 ? c.bldgSF / c.siteSF : null; } }
  ];

  var RAIL_BY_ID = {};
  RAILS.forEach(function (r) { RAIL_BY_ID[r.id] = r; });

  function fmt(v, unit) {
    if (v === null || v === undefined) return '—';
    if (unit === 'usd') return '$' + (Math.round(v * 100) / 100).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (Math.round(v * 1000) / 10).toFixed(1) + '%';
  }

  /* The fee block resolved to dollars, and the summed percentage rate the
     closed-form total-cost solve divides by. Mirrors feeParts() in
     api/shared/budget-calc.js and the browser CALC block; kept here only as
     a READ of an already-resolved fee object the caller passes in. */
  function feeContext(input) {
    var f = input.fee || {};
    return {
      dev: nz(f.dev), mkt: nz(f.mkt), cls: nz(f.cls),
      rate: (typeof f.pctRate === 'number' && Number.isFinite(f.pctRate)) ? f.pctRate : null
    };
  }

  function ackFor(doc, id) {
    var acks = (doc && doc.guardrailAcks) || [];
    for (var i = 0; i < acks.length; i++) {
      if (acks[i] && acks[i].id === id && typeof acks[i].reason === 'string' && acks[i].reason.trim()) return acks[i];
    }
    return null;
  }

  /* opexRatio blocks only once the budget carries the full OPEX schedule.
     Everything else takes its severity from the policy, defaulting to warn. */
  function severityOf(id, cfg, doc) {
    var declared = (cfg && cfg.severity) === 'error' ? 'error' : 'warn';
    if (id === 'opexRatio' && nz(doc && doc.opexSchemaVersion) < OPEX_SCHEMA_FULL) return 'warn';
    return declared;
  }

  /* An explicit policy — ONE type's rail table, e.g. DEFAULT_POLICY.Blank —
     wins outright and the document is not consulted at all. Without one,
     the document's own type (and doc.guardrails, if it ever carries one)
     decides, which is fine for the browser's courtesy check and never good
     enough for the server's gate. */
  function policyFor(doc, explicit) {
    if (explicit && typeof explicit === 'object') return explicit;
    var pol = (doc && doc.guardrails) || DEFAULT_POLICY;
    var type = (doc && doc.type) || 'Multifamily';
    return pol[type] || pol.Multifamily || {};
  }

  /* The built-in rail table for a budget type. A type with no table of its
     own (a template-defined "Commercial", say) is judged as Multifamily: only
     a budget that IS Blank gets the Blank table's two rails. */
  function policyForType(type) {
    return (typeof type === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_POLICY, type))
      ? DEFAULT_POLICY[type] : DEFAULT_POLICY.Multifamily;
  }

  /* evaluate({ doc, parts, gross, fee, policy })
       doc    the budget document
       parts  the caller's parts()      — res/amen/soft/hard/profit/cont/contract/project
       gross  the caller's grossIncome()— rentMo/otherMo/expMo/grossYr
       fee    resolved fees { dev, mkt, cls, pctRate }
       policy optional — one type's rail table (policyForType(type)). When
              given, doc.type and doc.guardrails are ignored.
     Returns { rails, breaches, blocking, warnings, status }. `rails` holds
     only rails that could be judged; `breaches` only those outside range. */
  function evaluate(input) {
    input = input || {};
    var doc = input.doc || {};
    var cfgAll = policyFor(doc, input.policy);
    var fee = feeContext(input);
    var units = (doc.units || []);
    var ctx = {
      doc: doc,
      parts: input.parts || { res: 0, amen: 0, soft: 0, hard: 0, profit: 0, cont: 0, contract: 0, project: 0 },
      gross: input.gross || { rentMo: 0, otherMo: 0, expMo: 0, grossYr: 0 },
      fee: fee,
      pctFeeRate: fee.rate,
      resSF: nz(doc.resSF),
      bldgSF: nz(doc.resSF) + nz(doc.amenSF),
      siteSF: nz(doc.siteSF),
      rentableSF: units.reduce(function (s, u) { return s + nz(u.sf) * nz(u.count); }, 0)
    };

    var rails = [], breaches = [], blocking = 0, warnings = 0;

    RAILS.forEach(function (rail) {
      var cfg = cfgAll[rail.id];
      if (!cfg) return;                       // this budget type does not carry the rail
      var actual = rail.value(ctx);
      if (actual === null || !Number.isFinite(actual)) return;   // not judgeable yet

      var min = Number.isFinite(cfg.min) ? cfg.min : null;
      var max = Number.isFinite(cfg.max) ? cfg.max : null;
      var low = min !== null && actual < min;
      var high = max !== null && actual > max;
      var severity = severityOf(rail.id, cfg, doc);
      var ack = (low || high) && severity === 'error' ? ackFor(doc, rail.id) : null;
      if (ack) severity = 'warn';

      var row = {
        id: rail.id, label: rail.label, measures: rail.measures, unit: rail.unit,
        path: rail.path, actual: actual, min: min, max: max,
        ok: !low && !high, severity: severity, acked: !!ack,
        ackReason: ack ? ack.reason : null,
        display: fmt(actual, rail.unit),
        range: min !== null && max !== null ? fmt(min, rail.unit) + ' – ' + fmt(max, rail.unit)
             : max !== null ? 'at most ' + fmt(max, rail.unit)
             : min !== null ? 'at least ' + fmt(min, rail.unit) : '—',
        message: ''
      };
      if (low || high) {
        row.message = rail.label + ' is ' + row.display + ' (' + rail.measures + '), '
          + (low ? 'below' : 'above') + ' the ' + row.range + ' guard rail.';
        if (rail.id === 'opexRatio' && nz(doc.opexSchemaVersion) < OPEX_SCHEMA_FULL) {
          row.message += ' This budget predates the full expense schedule —'
            + ' update it from the template so the ratio reflects real operating costs.';
          row.staleSchedule = true;
        }
      }
      rails.push(row);
      if (!row.ok) {
        breaches.push(row);
        if (row.severity === 'error') blocking++; else warnings++;
      }
    });

    return {
      rails: rails, breaches: breaches,
      blocking: blocking, warnings: warnings,
      status: blocking ? 'breach' : (warnings ? 'warn' : 'ok')
    };
  }

  /* Acks are pruned rather than left to rot: an acknowledgement whose rail is
     back in range, or which no longer names a real rail, is dropped. Returns
     the surviving list so a caller can compare and mark the doc dirty. */
  function pruneAcks(doc, result) {
    var breached = {};
    (result && result.breaches || []).forEach(function (b) { breached[b.id] = 1; });
    return ((doc && doc.guardrailAcks) || []).filter(function (a) {
      return a && RAIL_BY_ID[a.id] && breached[a.id];
    });
  }

  return {
    evaluate: evaluate, pruneAcks: pruneAcks, fmt: fmt, policyForType: policyForType,
    RAILS: RAILS, DEFAULT_POLICY: DEFAULT_POLICY, OPEX_SCHEMA_FULL: OPEX_SCHEMA_FULL
  };
});
