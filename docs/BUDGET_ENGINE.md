# Budget Engine v2 — design

The engine turns a **project** (one or more typed components, shared elements, phases,
land and financing) into a detailed, research-backed total project budget. It is a
pure module — no DOM, no network, no clock — that runs identically in the browser and
in Node.

| File | Role |
|---|---|
| `app/budget-engine.js` | The engine (UMD → `window.FSBudgetEngine` / `require`). Pure. |
| `app/research-data.js` | The compiled research bundle (UMD → `window.FSResearchData`). Generated — never hand-edited. |
| `tools/build-research-data.js` | Validates `data/research/**`, normalizes every dollar to the base year and a national baseline, writes the bundle. |
| `app/budget-v2.js` / `.css` | The v2 inputs page, builders, detail view, scenarios, exports (no-build IIFE behind `window.FSBudgetV2`). |
| `api/shared/investment/from-budget.js` | The pro forma handoff; reads the engine summary materialized into the budget document for per-component / per-phase scopes. |

**Rule: no default lives in code.** Every number the engine uses by default is read
from the bundle, and every line it emits carries `source` — the research file and
evidence ids it came from, or `derived` with the method, or `user` when overridden.

## 1. Research bundle (what the engine reads)

`tools/build-research-data.js` compiles `data/research/**` into:

```
FSResearchData = {
  version, baseYear, builtAt,
  indices: { escalation:{series,forecast,method}, regional:{factors,labels,method} },
  common:  { softCosts, contingency, fees, financing, adjustments, landClosing },  // items by id
  blocks:  { <itemId>: {id,name,division,unit,cost:{low,mid,high},source} },
  types:   { <typeId>: { …catalog fields, sizing, hardCost, qualityTiers, systemSplit,
                         lineItems, ffe, softCosts, contingency, rangeCheck, source } },
  evidence:{ "<category>/<type>.json#e1": { title,url,publisher,quote,confidence,
                                            raw:{value,unit,region,year}, normalized } }
}
```

### Normalization (documented once, applied everywhere)

`normalized = value × E(dataYear → baseYear) ÷ R(region)`

- `E(a→b) = series[b] / series[a]` from `_indices/escalation.json`.
- `R(region)` from `_indices/regional.json`: metro key → state key → `US = 1.00`.
- Percentages and ratios are never normalized.
- Ranges keep `low ≤ mid ≤ high` after normalization.

## 2. Cost building blocks

`_blocks/*.json` — reusable priced items, each with its own unit: vertical building by
construction type, TI tiers, site work per acre, paving, parking (surface / structured
above / below grade / podium / tuck-under / carport), utilities and off-sites, amenities
(pool, clubhouse, playground, courts, dog park, bathhouse …), landscaping, fencing and
walls, stormwater, marine (docks, piles, bulkhead, dredging, ramps), specialty MEP (cold
storage, data center per kW, lab HVAC, kitchens, grease interceptors), energy (solar,
EV, batteries), demolition & remediation, FF&E, signage, building systems. A block is
used three ways: as a type template's line item, as a shared element, and as a Custom
builder row.

## 3. Project type templates

A type (`data/research/<category>/<type>.json`) is a preset:

- **primary unit** (`sf`, `unit`, `key`, `bed`, `pad`, `site`, `slip`, `space`, `kw`, `mw`,
  `mwh`, `acre`, …) and the researched **baseline price per primary unit** (low/mid/high,
  national, base-year, standard quality, typical size), with the scope of that price
  (`includesSitework`, `includesStructuredParking`, `includesFFE`);
- **sizing**: typical size, SF per primary unit, primary units per acre, parking ratio;
- **systemSplit**: CSI divisions summing to 100% of the baseline hard cost;
- **lineItems**: specialty and non-scaling items, each `inBaseline` (a carve-out shown
  inside its division) or added (on top), `scales` or fixed, `optional`;
- **FF&E per primary unit**, **soft cost %** and **contingencies** (design/hard/soft);
- **rangeCheck**: plausible all-in (hard + soft, excl. land) cost per primary unit.

## 4. The project document (`doc.engine`)

```
{
  schema: 1, dataVersion,                     // research bundle the numbers came from
  mode: 'quick' | 'mixed' | 'custom',
  location: { region: 'TX-Houston' },         // regional factor key ('US' = national)
  startMonth: '2027-03',
  settings: {                                  // every field optional — null = researched default
    escalationRate: null,                     // annual; null = forecast from the index file
    designContingencyPct, hardContingencyPct, softContingencyPct,
    developerFeePct, softCostPct,             // project-wide overrides
    impactFeesOverride: null                  // $ from the Impact Fees step, when a schedule is chosen
  },
  land: { mode: 'amount'|'perAcre'|'perUnit', value, acres, closingPct: null, dueDiligence: null },
  phases: [ { id, name, startMonth, months, drawCurve: 's'|'linear'|'front'|'back',
              financing: { ltc, rate, feePct, enabled } } ],
  components: [ {
      id, typeId, name, phaseId,
      size,                                   // in the type's primary unit
      sf, acres,                              // optional; default from sizing ratios
      quality: 'economy'|'standard'|'premium'|'luxury',
      baseline: { price: null|number, basis: 'national'|'local', year: null },
      constructionType, stories,              // optional; factors from _common/adjustments
      items: { <lineItemId>: { on: bool, qty: number } },     // template line-item switches
      blocks: [ { id, itemId, qty, unitCost: null, name } ], // extra blocks (Custom builder)
      softCostPct, contingency: { design, hard, soft },      // per-component overrides
      revenue: { mode: 'perUnitMonth'|'perUnitYear'|'perSFYear'|'annual', rate,
                 otherIncome, vacancy, expenseRatio }
  } ],
  shared: [ { id, name, itemId | typeId, qty, unitCost: null, phaseId,
              allocation: { method: 'sf'|'units'|'revenue'|'cost'|'equal'|'manual',
                            shares: { <componentId>: fraction } } } ],
  overrides: { <lineKey>: { amount } | { rate } | { qty } | { off: true } },
  scenarios: [ { id, name, patch } ]          // a patch is a partial doc.engine
}
```

A single-type project is one component in one phase. Absent fields mean "use the
researched default", so a saved project re-prices when the bundle improves *only* when
the user chooses to (the document pins `dataVersion`; the UI offers "update to current
research").

## 5. Calculation

All money is computed in **integer cents**; every total is a sum of rounded lines, so
component, phase and project totals add up exactly.

For each component *c* in phase *p*:

1. **Unit price** `P = P0 × R × S × Q × C × H × E`
   - `P0` — baseline price per primary unit (user's, else researched mid).
   - `R` — regional factor (skipped when the user's price basis is `local`).
   - `S` — size factor `clamp((size / typical)^(-k), Smin, Smax)` from `adjustments.sizeAdjustment`.
   - `Q` — quality multiplier (type tiers, else `adjustments.qualityTier-*`).
   - `C`, `H` — construction-type and stories factors relative to the template default
     (1.0 unless the user changes them).
   - `E` — escalation from the base year's mid-point (July of `baseYear`) to the phase's
     construction midpoint (`startMonth + months/2`), compounding the forecast annual rates
     (user override wins).
2. **Baseline hard cost** `= P × size`, split across CSI divisions by `systemSplit`.
   `inBaseline` line items are carved out of their division (the division line shows the
   remainder; the total is unchanged). Additive line items, blocks and FF&E are added at
   `cost × qty × R × E`.
3. **Shared elements** are priced like blocks (phase escalation) and allocated to
   components by the chosen method (largest-remainder in cents → shares sum exactly).
4. **Contingencies**: design `= d × hard`; hard (construction) `= h × (hard + design)`;
   soft `= s × soft`.
5. **Soft costs** per (component, phase) from the soft-cost norm items (A&E, survey/geo,
   permits, legal, insurance, builder's risk, taxes during construction, marketing/leasing,
   third-party reports, testing, owner's rep) scaled so their sum equals the type's
   soft-cost % of hard; impact & tap fees from `_common/fees.json` by land use (or the
   Impact Fees step's result); developer fee as % of cost before fee and financing.
6. **Land**: amount / per-acre / per-unit, plus closing % and due diligence, allocated to
   components by share of acreage (else SF) and attributed to phases with them.
7. **Financing** per phase: monthly draws (land at month 0; soft costs partly up-front;
   hard costs on the phase's draw curve), equity first, then the construction loan at
   `LTC`; interest accrues monthly and is capitalized (interest reserve); loan fee at
   close. Solved by fixed-point iteration on total cost (converges to < $1 in a few
   rounds). Financing lands in soft costs, attributed to components by cost share.

## 6. Output

```
{ totals: { hard, ffe, contingency, soft, financing, land, total },
  metrics: { perSF, perPrimaryUnit, perAcre, sf, acres, primaryUnits, unit },
  split:   { hard, soft, land } (shares),
  components: [ { id, name, typeId, totals, metrics, range: {min,max,status} } ],
  phases:     [ { id, name, totals, midpoint, escalation, draws:[{month, hard, soft, land, interest, equity, loan, balance}], loan } ],
  lines: [ { key, comp, phase, category, group, division, code, name,
             qty, uom, rate, amount, baseAmount, overridden, source } ],
  warnings: [ { level, code, message, comp? } ],
  proforma: { project, components:[…], phases:[…] }   // what from-budget needs
}
```

## 7. Into the budget document (materialization)

The engine result is **materialized** into the existing budget document, exactly like
the Impact Fees step's derived line, so `parts()`, `budget-calc.js`, `dbo.SovLines`,
the CSI schedule, guard rails and every existing export keep working untouched:

| Engine | Budget document |
|---|---|
| hard lines, FF&E | `doc.lines`, scope `res`, `derived:'engine'`, basis `ls` (qty × rate kept in `engine`) |
| soft lines, soft contingency, financing | `doc.lines`, scope `soft` |
| design + hard contingency | `doc.contingency = {mode:'amt'}` (line 99 03 00) |
| land price | `doc.projectCosts.land` |
| land closing + due diligence | `doc.projectCosts.cls` (amt) |
| developer fee | `doc.projectCosts.dev` (amt) |
| totals per component / phase, pro forma inputs | `doc.engineSummary` |

Invariant (tested): `parts(doc).project === result.totals.total` to the cent.

## 8. Pro forma handoff

`POST /api/investment-analyses {mode:'fromBudget', projectId, budgetVersionNumber,
scope: {kind:'project'|'component'|'phase', id}}`. For engine budgets
`projectFromBudget()` reads that scope from `doc.engineSummary.proforma`: purchase price
= the scope's total cost, size = its building SF (or units), unit count, Year-1 potential
income and other income from the component revenue inputs, vacancy and expense ratio.
The investment engine itself is untouched (goldens).

## 9. Edge cases

Size 0 → zero cost, no division by zero (metrics `null`). Huge sizes → size factor
clamps. Missing type → error-free empty component with a warning. Phase with no
components → zero totals and no draws. Unknown region → national with a warning.
Overrides pointing at lines that no longer exist are kept but ignored (reported).
