# Audit — Budgeting Suite before the v2 upgrade

Audited on `upgrade/budgeting-v2` right after merging `feature` (staging @ 63ef1a4 +
the site-wide pass + the assistant/security branch), 2026-10-24. Blunt by request.

## 1. Stack

| Layer | What it is | Notes |
|---|---|---|
| Frontend | `app/index.html` — ~10,000 lines of HTML + inline CSS + one inline `<script>`; plus no-build IIFE modules (`investment-analysis.js`, `projects.js`, `home.js`, `dashboard.js`, `feedback.js`, `impact-fees.js`, `guardrails.js`, export renderers) | No bundler, no framework, global mutable state (`doc`, `pricing`, `currentPage`). A syntax error ships. |
| API | Azure Functions (Node 18) under `api/<name>/`, served by Azure Static Web Apps (Standard) | New function folders do not deploy reliably — features are added as query scopes on existing endpoints. |
| Data | One Azure SQL serverless database for every environment, including production | Every migration is live everywhere when run. |
| Auth | Entra ID custom provider + app roles | Two gates per privileged route (route rule + `hasRole`). |
| Exports | `fs-render` (fsdoc/1 → pdfmake PDF, ExcelJS XLSX, CSV) + a legacy local renderer; ExcelJS 4.4 and pdfmake vendored | Exports are built from the data model, never the DOM. Chart-free by decision. |
| Tests | 22 Playwright suites against `test/mock-api.js`, ~310 `node:test` logic tests | Good coverage of invariants; suite-07 has one pre-existing failure (help TOC scroll). |

## 2. Data model

A **budget** is one JSON document (`dbo.Budgets.Doc`, versioned immutably in
`dbo.BudgetVersions`, projected to `dbo.SovLines` for the lender package):

```
{ projectId, name, address, type:'Multifamily'|'Blank'|<template type>, status,
  resSF, amenSF, siteSF,                       // three areas, all residential-centric
  units:[{label,bd,bth,sf,count,rent}],        // unit mix + monthly rents
  other:[{label,rate,count,auto}],             // other income per unit / count
  expenses:[{label,per:'unit'|'fixed'|'pctIncome',rate,count,auto}],
  lines:[{lineId,scope:'res'|'amen'|'soft',grp,code,desc,basis:'sf'|'asf'|'unit'|'ls',
          qty,auto,unit,baseUnit,derived?}],   // the schedule of values
  companies:[{name,pct}],                      // contractor profit on hard cost
  contingency:{mode:'pct'|'psf'|'amt',val},
  projectCosts:{land, dev|mkt|cls:{mode:'amt'|'pct',val}},
  impactFees:{scheduleKey,…,meters,extras,manual},
  guardrailAcks, opexSchemaVersion, pricingVersion, … }
```

Arithmetic (`parts()` in the browser, mirrored in `api/shared/budget-calc.js`):
`hard = Σres + Σamen` → `profit = hard × Σpct` → `cont` → `contract = hard + profit + cont`
→ `project = (contract + soft + land + fixedFees) / (1 − Σpct fees)`.

A **project** (`dbo.Projects`, `OP-####`) groups budgets and analyses; it has no type.
An **investment analysis** is created from an exact saved budget version
(`api/shared/investment/from-budget.js`) and calculated server-side by the engine.

## 3. Screens and user flow

Home → Projects / Budgets / Investment Analysis / More (Pricing, Help, Dashboard, Admin, Version).

Budget workflow (four pills): **Inputs** (`#/inputs`: ID, name, address, project,
Residential Buildable SF, Amenity SF, site SF/acres, unit mix & rents, other income,
operating expenses, profit split, contingency, land & project costs) → **Impact Fees**
(jurisdiction fee schedule calculator) → **Budget** (the SOV grid by scope and group,
inline rate/qty edits, add lines from the pricing library, guard rails, summary) →
**CSI** (division schedule). New Budget dialog: pick Multifamily / Blank / custom
template → pick project and ID.

## 4. The budget engine — blunt assessment

**It is a multifamily schedule-of-values editor, not a budgeting engine.**

- **One project type.** Everything assumes apartments: inputs are residential SF,
  amenity SF and a unit mix with rents. "Blank" and custom templates exist, but a
  custom template is just a saved copy of a budget — there is no notion of a hotel
  key, an RV site, a slip, a kW, an acre of site work, or a pad.
- **Prices are per residential SF.** ~90 library lines are `$/Res SF`, plus a few
  per-unit and lump-sum lines. A 2,000-SF clubhouse, a parking garage, a data
  center and a marina cannot be expressed except by hand-entering lump sums.
- **No size, quality, construction-type, height or regional adjustment.** A rate is a
  rate. The library is effectively one Texas garden/townhome product at one quality
  in one market (line descriptions name the City of Waller, TxDOT, Ezee Fiber).
- **No escalation.** Costs are priced in today's dollars regardless of when the work
  happens; there are no phases and no construction midpoint.
- **No financing costs.** Construction-loan interest, loan fees and an interest
  reserve are absent from Total Project Cost — on a typical 24-month build that is
  commonly 4–8% of cost missing from every budget.
- **Contingency is thin and mis-modelled.** The default is **$2/SF** of building
  (≈1% of hard cost on a $200/SF building — industry norms are 5–10% at budget stage).
  There is one contingency; design and soft-cost contingencies are buried as `$/SF`
  soft lines ("Design Contingency (≈10%)" $0.83/SF, "Fees Contingency (≈10%)"
  $0.81/SF) that do not actually move with the thing they are a percentage of.
- **Soft costs scale with residential SF**, not with hard cost or project scope:
  A/E, permits and impact fees are all `$/SF` lines.
- **No FF&E, no OS&E, no pre-opening, no off-sites, no parking, no land closing costs**
  (beyond a generic "closing" fee), **no land carry or taxes during construction.**
- **No components, no shared elements, no phases.** Mixed-use is impossible except
  as a single blended budget.
- **No provenance.** No line says where its number came from. The library has a
  version but no sources.

### Hardcoded numbers (all in `app/index.html` unless noted)

| Where | Value | Problem |
|---|---|---|
| `DEFAULT_PRICING` | ~90 `$/SF` rates, version `2026.08-v2` | Offline fallback only (the published library wins), but it is the only cost data in the repo and it is one product in one market. |
| `blankDoc()` | resSF 51,365; amenSF 1,200; four unit types with rents ($1,160–$1,520); land $1,200,000; developer fee $200,000; marketing $75,000; profit 12% "Finishes Solutions LLC"; contingency $2/SF | A new budget is born as a specific Texas project. |
| `DEFAULT_OTHER` | utilities billback $77, tech $75, parking $25, pet $25 … | Market-specific placeholders. |
| `DEFAULT_EXPENSES` | "City of Waller water & sewer", "Ezee Fiber", dumpster $383/mo, taxes 12% of income … | Named after one city and its vendors. |
| `SC-20` | Water & sewer impact & tap fees $7.50/SF | One jurisdiction's number applied to every project (the Impact Fees step can override it). |
| `SC-08` | TxDOT driveway permitting | State-specific line in every budget. |
| `app/guardrails.js` | Multifamily rails (hard cost $120–260/SF, soft 8–20%, land 10–25%, …) | Unknown types fall back to the Multifamily table; a hotel or data center would be judged by apartment rails. |
| `api/shared/investment/defaults.js` | vacancy 10%, LTV 65%, 25-yr amortization, 3% growth | Reasonable organisation defaults; part of the pro forma, left alone. |

### Missing project types

Every type in the v2 list except garden multifamily (and arguably townhome) is
missing: all of specialty residential, hospitality, commercial, entertainment,
industrial, agriculture/energy, civic, marine, parking, adaptive reuse, TI, and custom.

### Missing cost categories

Escalation; regional index; financing interest & fees; design and soft contingency
as percentages; FF&E / OS&E; parking by type (surface / structured / podium /
tuck-under); off-site utilities and road improvements; site work per acre;
pads/sites with hookups; marine work; specialty MEP (cold storage, data center,
lab); energy systems; demolition & remediation; land closing and due diligence;
taxes during construction; builder's risk as a % of hard cost; franchise/brand fees;
pre-opening; developer fee as a researched norm by type.

### Math issues

1. Contingency default ($2/SF) is an order of magnitude below the norm at budget stage.
2. Percent-style contingencies stored as `$/SF` lines don't scale with what they are a percentage of.
3. Impact/tap fees per building SF ignore unit count/EDUs (the Impact Fees step fixes this per jurisdiction, but the default line does not).
4. Total Project Cost omits construction interest entirely.
5. The investment projection uses Total Project Cost as a *purchase price* and starts Year-1 NOI immediately — a stabilized-acquisition view of a development deal (no lease-up, no construction period). This is the pro forma engine's design and is preserved by rule; the budget side now supplies per-component/phase costs and income so the comparison is at least apples to apples.
6. The `hardCostPSF` rail divides by residential + amenity SF; fine for apartments, meaningless for anything else.

## 5. The pro forma engine

`api/shared/investment/` — `calculateInvestmentAnalysis(input)`: validated,
normalized, deterministic, version-stamped (`before-tax-1.1.0`), fixture-proven against
five recovered deals. Five- or ten-year before-tax: operating projection (aggregate
Year-1 income, other income, constant growth, vacancy, expenses as % of GOI or dollars),
one fully amortizing 30/360 loan or all-cash, exit cap sale, CoC/ROE/equity multiple,
property & equity IRRs, optimal hold, acquisition sensitivity. **It is good and stays
exactly as it is** (frozen by `test/proforma-golden.test.js`).

Inputs arrive one way: `from-budget.js` projects a saved budget version into
`property.size` (residential + amenity SF), `unitCount`, purchase price (= Total Project
Cost recomputed from the version document), gross scheduled rent × 12, other income
rows × 12, and an expense ratio derived against GOI. **There is no per-component or
per-phase handoff** — a mixed-use project could only ever be one property.

## 6. Exports

Budget PDF (fs-render or legacy renderer) and an ExcelJS workbook built from
`parts()`, `csiSchedule()`, `grossIncome()` and the document; investment workbook and
PDF from the engine result. Good discipline (data model, never DOM). Missing for v2:
component, phase, draw-schedule and sources/assumptions pages.

## 7. How budget data feeds the pro forma

`POST /api/investment-analyses {mode:'fromBudget', projectId, budgetVersionNumber}` →
server loads that immutable version → `projectFromBudget(doc)` → analysis input with
`fieldOrigins` locking the imported fields; re-sync re-runs the same projection. One
budget → one property. Nothing about components, phases, timing or financing crosses.

## 8. What the upgrade must preserve

The no-build rule; byte-identical twin files; exports from the data model; the
materialized-derived-line pattern (`impactFees`); soft delete and immutable versions;
`parts()` ↔ `budget-calc.js` parity; additive, backward-compatible documents (every
existing budget must open and total exactly as before); the pro forma goldens.
