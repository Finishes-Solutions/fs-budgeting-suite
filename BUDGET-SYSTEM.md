# BUDGET-SYSTEM.md — how a budget is formulated, and how it changes

This is the specification of the budget math in the Finishes Solutions Budgeting
Suite: every number a budget shows, how it is computed, where that code lives,
and every way the number can move afterwards. It is written for three readers:
an estimator who wants to know why a total is what it is, an engineer about to
change a formula, and the **Budget Assistant** (Ask AI), which is given this
file as its reference manual.

**Code is the authority.** Where this file and the code disagree, the code is
what runs. Fix this file, and record the fix in the [change log](#change-log).

**Keeping it current is a rule, not a courtesy** (AGENTS.md, ground rule 7).
Any change to the budget arithmetic updates this file in the same commit, adds
a change-log entry, and copies it to `api/shared/budget-system.md`
(`cp BUDGET-SYSTEM.md api/shared/budget-system.md`). `test/budget-assistant.test.js`
fails if the two copies differ.

Code references name the **file and function** rather than line numbers, which
drift. Verified against `origin/staging` at `63ef1a4`, plus the Budget Assistant
change, on 2026-10-15.

---

## Contents

1. [Where the arithmetic lives](#1-where-the-arithmetic-lives)
2. [The budget document](#2-the-budget-document)
3. [Line items](#3-line-items)
4. [Amenity suppression](#4-amenity-suppression)
5. [From lines to total project cost — `parts()`](#5-from-lines-to-total-project-cost--parts)
6. [Impact & tap fees](#6-impact--tap-fees)
7. [Income and operating expenses](#7-income-and-operating-expenses)
8. [CSI schedule of values](#8-csi-schedule-of-values)
9. [Per-SF and per-unit metrics](#9-per-sf-and-per-unit-metrics)
10. [Guard rails](#10-guard-rails)
11. [Where rates come from](#11-where-rates-come-from)
12. [How a budget changes over its life](#12-how-a-budget-changes-over-its-life)
13. [What is stored, and rounding](#13-what-is-stored-and-rounding)
14. [Worked example](#14-worked-example)
15. [What an investment analysis takes from a budget](#15-what-an-investment-analysis-takes-from-a-budget)
16. [Known discrepancies](#16-known-discrepancies)
17. [Change log](#change-log)

---

## 1. Where the arithmetic lives

| Copy | What it decides | File / functions |
|---|---|---|
| Browser CALC block | Everything on screen and in every export | `app/index.html`: `totUnits`, `lineQty`, `scopeActive`, `scopeSum`, `FEE_FLOOR`, `feeMode/feeVal/feeRate/feeFixed`, `parts`, `siteMetrics`, `expenseMonthly`, `grossIncome` |
| Server mirror | The stored `ContractSum` / `ProjectCost`, the server guard-rail gate, the Budget Assistant's figures, investment-analysis import | `api/shared/budget-calc.js` — a line-for-line port of the browser block |
| Guard rails | Pass / warn / block on save | `app/guardrails.js` ≡ `api/shared/guardrails.js` (byte-identical; `test/guardrails.test.js` enforces it) |
| Impact & tap fees | The municipal fee total | `app/impact-fees.js` (browser only, by design — see §6) |
| CSI roll-up | The CSI tab and the CSI sections of the exports | `app/index.html`: `csiDivKey`, `csiSchedule` |
| SOV projection | Rows written to `dbo.SovLines` (the lender-package read surface) | `api/shared/sov.js`: `sovRows` — has its own quantity rule (see §16) |
| Budget → analysis | What an investment analysis imports | `api/shared/investment/from-budget.js` |

The browser and the server compute the same totals from the same document.
`test/budget-calc.test.js` pins the server module; suite-09 compares the two on
a live document in the browser.

**All arithmetic is at full floating-point precision.** Nothing is rounded until
it is displayed or stored (§13).

---

## 2. The budget document

A budget is one JSON document (`doc`), stored whole in `dbo.Budgets.Doc` and
snapshotted whole into `dbo.BudgetVersions.Doc` on every save that changes it.

| Field | Meaning | New Multifamily budget (`blankDoc`) |
|---|---|---|
| `projectId` | The **budget** id (`BDG-####-NN`; legacy `BD-`/`OP-`/`AS-`/`TST-`). Not the project's id. | — |
| `projectKey` | The parent project (`OP-####`) | set on creation |
| `name`, `address`, `type` | Identity; `type` also selects the guard-rail policy | type `Multifamily` |
| `resSF` | Residential buildable SF — the quantity behind every `sf` line | 51,365 |
| `amenSF` | Amenity / clubhouse SF — the quantity behind every `asf` line. **0 switches the amenity scope off** (§4) | 1,200 |
| `siteSF` | Land area. Prices nothing; feeds site metrics and per-acre fees | 0 |
| `units[]` | Unit mix `{label, bd, bth, sf, count, rent}`; `rent` is monthly per unit | 4 types, 58 units |
| `other[]` | Other income `{label, rate, count, auto}`; `rate` is monthly | default rows |
| `expenses[]` | Operating expenses `{label, per, rate, count, auto}`; `per` is `unit`, `fixed` or `pctIncome` | full OPEX schedule |
| `lines[]` | Schedule-of-values lines (§3) | every pricing-library line |
| `companies[]` | Profit `{name, pct}` — percent of hard cost | Finishes Solutions LLC, 12% |
| `contingency` | `{mode, val}`; mode `pct`, `psf` or `amt` (§5) | `psf`, $2.00 |
| `projectCosts` | `{land, dev, mkt, cls}`; land is dollars; each fee is `{mode:'amt'|'pct', val}` | land $1,200,000, dev $200,000, mkt $75,000, cls $0 |
| `impactFees` | Jurisdiction fee selections (§6) | empty, basis `high` |
| `opexSchemaVersion` | 1 = old service-only expense rows; 2 = full OPEX schedule (changes one guard rail, §10) | 2 |
| `guardrailAcks[]` | Overrides `{id, reason, byId, byName, at}` (§10) | `[]` |
| `pricingVersion` | The pricing-library version the rates came from | current library |
| `templateKey`, `templateVersionId` | The template it was created from | set on creation |
| `status` | Draft / In Review / Completed / Cancelled | Draft |

A "Blank" budget (`blankDoc('blank')`) starts with zero SF, no lines, no units,
no companies, contingency `pct` 0 and all project costs 0.

### `migrate()` — repairs on load

Every time a budget is opened (and when one is made from a template),
`migrate()` in `app/index.html` repairs older documents **in memory**:

- `resSF ← resSF ?? buildableSF ?? 0`; `amenSF`, `siteSF` default 0.
- Absent `other` / `expenses` arrays get the default rows (this changes income
  and expenses, not the contract).
- Absent `projectCosts` becomes all zeros. A bare number in `dev`/`mkt`/`cls` is
  a pre-migration save and means **dollars**: it is lifted once to
  `{mode:'amt', val}`.
- `opexSchemaVersion` defaults to 1.
- `impactFees` is normalised (basis must be low/avg/high, else `high`; an override
  survives only with a finite amount **and** a reason).
- `guardrailAcks` keeps only entries with a string `id` and `reason`.
- Every numeric field is coerced with `nz()` (absent or non-numeric → 0).
- Each line gets `scope` (default `res`), `grp` (default `div` or `General`),
  `baseUnit` (default = `unit`, so nothing is retroactively flagged as edited)
  and a `lineId` if it lacks one.

`migrate()` does not set the dirty flag, but the first save afterwards hashes
the repaired document, so that save records the repairs as a new version. The
server never runs `migrate()`; `budget-calc.js` guards every read with `nz()`
instead.

---

## 3. Line items

### Quantity — `lineQty`

```
if the line is not auto (auto is false or absent):  qty = line.qty            (a typed quantity)
else by basis:  'sf'   → qty = resSF                    "Per Res SF"
                'asf'  → qty = amenSF                   "Per Amen SF"
                'unit' → qty = total units = Σ units.count   "Per Unit"
                other ('ls') → qty = 1                  "Lump Sum"
```

### Total

```
line total = qty × unit
```

There is no per-line rounding.

### `unit` vs `baseUnit`

- `unit` is the rate in use. `baseUnit` is the library rate the line was born
  with, or last repriced to. They are deliberately separate fields.
- A line is **edited** (`isEdited`) when any of these is true: it was added by
  hand (`custom`), its quantity was overridden (`auto === false` on a non-lump-sum
  line), its rate differs from `baseUnit`, or its description or basis was
  changed (`edited`).
- A line is **derived** (`isDerived`) when `derived` is set — today only the
  impact-fee line (§6). The editor's tooltip calls it derived, not edited.
- Editing a rate changes `unit` only. Typing a quantity sets `qty` and turns
  `auto` off. Switching a line to Lump Sum keeps any typed quantity
  (`qty || 1`).
- Lines added from the CSI catalog start at `unit = baseUnit = 0`, `custom`, with
  basis `asf` (amenity scope) or `sf` (others).

---

## 4. Amenity suppression

```
scopeActive(scope) = scope ≠ 'amen'  OR  amenSF > 0
scopeSum(scope)    = scopeActive(scope) ? Σ (qty × unit) over lines in that scope : 0
```

When amenity SF is 0, the **whole amenity scope contributes $0**, including
lump-sum and typed-quantity amenity lines that would not otherwise follow the SF
to zero. Nothing is subtracted from residential: residential and amenity are
separate sums, and the inactive one is replaced by zero. The amenity lines stay
in the document, so restoring amenity SF brings them back unchanged.

`parts()`, the budget grid, `csiSchedule()` and the exports all honour this.
`api/shared/sov.js` does not — see §16.

---

## 5. From lines to total project cost — `parts()`

`parts()` (browser) and `parts(doc)` (`api/shared/budget-calc.js`) compute,
in order:

```
res      = scopeSum('res')
amen     = scopeSum('amen')                        (0 when amenSF ≤ 0)
soft     = scopeSum('soft')                        (includes the impact-fee line, §6)
hard     = res + amen                              construction hard cost

profit   = Σ over companies:  hard × pct / 100     profit is a share of HARD cost only
cont     = contingency.mode 'pct' → hard × val / 100
           contingency.mode 'psf' → (resSF + amenSF) × val
           any other mode         → val (dollars)

CONTRACT SUM = hard + profit + cont                → stored as ContractSum
```

Profit is not charged on contingency or soft costs. Land is always dollars.

### Fees, and the circular percentage

Developer fee (`dev`), marketing / brokerage (`mkt`) and closing costs (`cls`)
are each a dollar amount or a **percentage of the final total project cost**.
That percentage is circular: the fee is part of the total it is a share of.
`parts()` solves it in closed form instead of iterating:

```
base   = contract + soft + land
f      = Σ rate of the fees in % mode   (val / 100)
fixed  = Σ dollars of the fees in $ mode

TOTAL PROJECT COST = (base + fixed) / max(1 − f, FEE_FLOOR)     FEE_FLOOR = 0.05
                                                  → stored as ProjectCost
each fee = its fixed dollars + its rate × total project cost
fees     = dev + mkt + cls
```

So a 3% developer fee really is 3% of the number printed on the summary line,
and `total = contract + soft + land + fees` holds exactly. The floor keeps a
budget whose percentages sum to 95% or more finite (the `feeSum` guard rail
already refuses to save one); past the floor the identity no longer holds.

`fee.pctRate` is `f` when any fee is in % mode (even at 0%), otherwise `null`,
so the `feeSum` rail is not judged on an all-dollar budget.

Switching a fee between $ and % resets its value to 0. Switching contingency
mode resets it to 2 (%), 2 ($/SF) or $100,000.

---

## 6. Impact & tap fees

Water and sewer impact fees, meters, vaults and tap work are priced from a
**jurisdiction fee schedule**, published and versioned by a pricing admin (City
of Waller, TX ships first). The calculator is `FSImpactFees.evaluate(schedule,
doc.impactFees, ctx)` in `app/impact-fees.js`.

### Where the schedules live

- Tables `dbo.FeeSchedules` and `dbo.FeeScheduleVersions` (`sql/migrate_impact_fees.sql`);
  one current version per jurisdiction, enforced by a filtered unique index.
- Read with `GET /api/pricing?scope=fee-schedules` and
  `?scope=fee-schedule&key=…[&version=n]`. Publish with `PUT ?scope=fee-schedule`
  (pricing admin).
- Until the migration runs, the list is empty and every budget keeps the fee
  amount it was saved with.

### What the budget stores

`doc.impactFees = {scheduleKey, scheduleName, scheduleVersion, effective, basis,
meters[{rowId, qty, includeMeter, includeVault, includeTaps}], extras[{feeId, qty}],
manual[{rowId, label, amount}], override}`. These are **selections plus the
schedule version**, not a copy of the schedule.

### The calculation

```
pick(range, basis):  low → range.low;  high → range.high;  avg → (low + high) / 2;
                     a missing range ("NA") → 0
basis: 'low' | 'avg' | 'high', default 'high'

each selected meter row:
  water impact + sewer impact            single published amounts; basis does not move them
  + meter (if included)    pick(meter range, basis)
  + vault (if included)    pick(vault range, basis)       meters ≤ 3" have no vault
  + water tap + sewer tap  (if taps included) pick(…, basis)
  row total = qty × that sum

each selected generic fee:  qty × pick(amount, basis) × quantity basis
  quantity basis: flat → 1; unit → total units; acre → siteSF / 43,560;
                  resSF; amenSF; bldgSF → resSF + amenSF; pctHard → hard cost / 100
manual rows:      their typed amount

total = override amount (when present, with a required reason)
        otherwise meters + generic fees + manual rows
```

The schedule's **published per-row amounts are authoritative**; the per-EDU
rates are shown for reference only and are never multiplied out (Waller's true
water rate is about $3,689.9104, so `EDU × $3,689.91` drifts from what the city
bills).

### How it enters the budget

The total is **materialised onto one soft-cost line**: SC-20 "Water & Sewer
Impact & Tap Fees", which becomes `basis 'ls', qty 1, unit = total,
derived 'impactFees'`, with the provenance in its description, e.g.
"— City of Waller, TX (high side, v1)". `applyImpactFees()` does this on every
recalculation, once the budget's schedule has been loaded.

So `parts()`, `csiSchedule()`, the exports, the guard rails and the server see an
ordinary soft line. Impact fees raise **soft costs and total project cost, never
the contract sum**. The server cannot recompute the fee; it trusts the amount on
the line.

Three rules protect real money:

- A budget whose schedule has not been fetched **keeps its saved amount**
  (recomputing against nothing would wipe a six-figure line).
- Clearing the jurisdiction **restores** SC-20 to its library $/SF basis rather
  than deleting the line.
- Picking a jurisdiction with no meters yet sets SC-20 to $0 until meters are
  entered.

---

## 7. Income and operating expenses

`grossIncome()` (browser and `budget-calc.js`):

```
total units = Σ units.count
rent / mo   = Σ units.rent × units.count
other / mo  = Σ other.rate × (other.auto ? total units : other.count)
income / mo = rent + other

each expense row, per month (expenseMonthly):
  per 'pctIncome' → income / mo × rate / 100       (not circular: income doesn't depend on expenses)
  per 'fixed'     → rate × (count, or 1 if count is 0)
  per 'unit'      → rate × (auto ? total units : count)
expenses / mo = Σ rows

gross income / yr = 12 × (rent + other)
net income / yr   = 12 × (rent + other − expenses)        shown as "Net Income / Yr"
```

**The budget has no vacancy.** Net income is rent plus other income minus the
expense rows, with no vacancy or credit loss. Vacancy enters only in an
investment analysis (§15).

"Update Expense Schedule" adds any missing expense categories from the expense
schedule **at a rate of $0** and sets `opexSchemaVersion = 2`; it does not
change existing rows.

---

## 8. CSI schedule of values

`csiSchedule()` groups the construction contract by MasterFormat division:

- Only lines in an active scope (§4) are included.
- Soft-cost lines are reported separately (they are not in the contract sum).
- A line's division is the first two digits of its code when they are a known
  CSI division; otherwise it goes to "Uncoded / Custom Scope".
- Divisions are sorted by number; rows within a division by code.
- Markups follow: one "99 01 00 Profit — company" row per company with
  `pct > 0` (hard × pct / 100), and "99 03 00 Construction contingency" when
  contingency > 0.
- Percent columns: divisions and markups are **% of Contract Sum**; soft costs
  are **% of total soft costs**. A zero denominator shows "—".

Divisions + markups add up to the contract sum (exceptions in §16).

---

## 9. Per-SF and per-unit metrics

Building SF always means **residential + amenity SF**. Site SF is land and is
never in a per-SF cost.

| Metric | Formula |
|---|---|
| Contract $/SF | contract ÷ (resSF + amenSF) |
| Project $/SF | total project cost ÷ (resSF + amenSF) |
| Cost / Unit | total project cost ÷ total units |
| Margin | profit ÷ contract |
| Yield (net inc) | net income / yr ÷ total project cost |
| Average SF / unit, average rent | Σ sf × count ÷ units, Σ rent × count ÷ units |
| Blended rent $/SF/mo | Σ rent × count ÷ Σ sf × count |
| Building efficiency | Σ (unit SF × count) ÷ resSF |
| Site efficiency (FAR) | (resSF + amenSF) ÷ siteSF |
| Density | units ÷ (siteSF ÷ 43,560) units per acre |
| % Scope (budget grid) | line total ÷ its scope total |
| Excel "% of Project" | component ÷ total project cost |

A zero denominator shows "—". There is no per-key metric.

---

## 10. Guard rails

`FSGuardrails.evaluate({doc, parts, gross, fee})` judges the budget. It runs in
the browser as you edit and **again on the server on every save**, from the
submitted document. A blocking breach refuses the save with HTTP 422.

| Rail | Measures | Multifamily range | Blocks? |
|---|---|---|---|
| opexRatio | 12 × expenses / mo ÷ gross income / yr | 35%–55% | **Yes** (warns only when `opexSchemaVersion < 2`) |
| feeSum | dev % + marketing % + closing % | ≤ 95% | **Yes** |
| unitSF | leasable unit SF ÷ resSF | ≤ 100% | **Yes** |
| devFee | developer fee ÷ total project cost | 2%–5% | warn |
| marketing | marketing ÷ total project cost | 0.5%–2% | warn |
| closing | closing ÷ total project cost | 0.5%–3% | warn |
| landShare | land ÷ total project cost | 10%–25% | warn |
| profitMargin | profit ÷ hard cost | 8%–20% | warn |
| contingency | contingency ÷ hard cost | 2%–10% | warn |
| softCost | soft costs (incl. impact fees) ÷ hard cost | 8%–20% | warn |
| hardCostPSF | hard cost ÷ building SF | $120–$260 | warn |
| rentPSF | rent / mo ÷ leasable unit SF | $1.00–$3.50 | warn |
| bldgEfficiency | leasable unit SF ÷ resSF | 70%–95% | warn |
| siteEfficiency | building SF ÷ site SF | 15%–120% | warn |

A **Blank** budget is judged only on `feeSum` and `unitSF`.

Rules that must not be "simplified" away:

- **A rail with nothing to judge is skipped, not passed or failed.** Each rail
  returns no value when its denominator is zero, and devFee, marketing, closing,
  landShare and softCost also skip when their own amount is zero ("not entered
  yet"). Without this a blank budget could never be saved. opexRatio,
  profitMargin and contingency do judge a zero amount (see §16).
- Ranges are strict: below `min` or above `max` is a breach.
- An **override** (an acknowledgement with a non-blank reason) downgrades that
  rail's blocking breach to a warning. Stale overrides are pruned when their
  rail is back in range.
- The policy is `doc.guardrails[type]` if present, else the built-in defaults
  above. Nothing in the app writes `doc.guardrails` today, so the defaults are
  what apply.

---

## 11. Where rates come from

1. **Templates** (`dbo.BudgetTemplateVersions`) are the source of a new budget:
   lines, groups, quantities, expense schedule, defaults. New budgets clone the
   template's current version.
2. **The pricing library** (`dbo.PricingLibrary`, current version via
   `GET /api/pricing`) is applied at creation by `stampCurrentPricing()`:
   lines are matched on **scope + code + description**. A line still at its
   library rate (`unit = baseUnit`) takes the current rate; a line the template
   deliberately priced differently **keeps its rate**. `baseUnit` always moves
   to the current library rate, and `pricingVersion` is stamped.
3. **`DEFAULT_PRICING`** in `app/index.html` is an offline fallback, used only if
   the library cannot be loaded. The app shows a banner when that happens.

### Update Pricing

When a newer library is published, a budget shows a banner and offers **Update
to Current Pricing** (also in the row menu as Update Pricing). `repriceBudget()`:

- For every line whose scope + code + description matches the library, sets
  **both `unit` and `baseUnit`** to the library rate. **Manually edited rates on
  matched lines are replaced.** The toast reports how many.
- Leaves unmatched lines alone: hand-added lines, and the impact-fee line (its
  description carries the provenance suffix, so it does not match).
- Does not touch quantities, bases, descriptions or groups.
- Stamps `pricingVersion`. Nothing is saved until you save.

Creation preserves edited rates; Update Pricing does not. That asymmetry is
deliberate in the code but easy to miss.

---

## 12. How a budget changes over its life

### Creation

1. A **project** (`OP-####`) is created first:
   `PUT /api/budget/{OP-####}?scope=project` with `{create: true}`.
2. The New Budget dialog picks a template, then the project, and suggests a
   budget id `BDG-<project number>-<item>` (`nextChildBudgetId`).
3. The template is cloned, priced against the current library (§11) and
   `migrate()`d. **Nothing is written until the first save**, which is sent with
   `create: true` and is refused (409) if the id is taken.

### Editing and saving

- Every edit runs `touch()` → recalculation (including `applyImpactFees()`).
  There is **no autosave**. Saving is the Save button or Cmd/Ctrl+S.
- The browser checks the guard rails and building SF first, as a courtesy.
- `PUT /api/budget/{id}` with `{meta, doc}`. The server:
  1. Requires building SF (resSF + amenSF) > 0 (422 otherwise).
  2. Re-evaluates the guard rails from the submitted document (422 on a blocking
     breach).
  3. **Recomputes `ContractSum` and `ProjectCost` from the document** with
     `budget-calc.js`. Totals sent by the browser are ignored. Line rates and
     quantities in the document are taken as sent.
  4. Upserts `dbo.Budgets`, rewrites `dbo.SovLines`, and, if the content changed,
     inserts a new immutable `dbo.BudgetVersions` row (+ its SOV rows), all in one
     transaction.
  5. Logs `budget_save` / `budget_create` with which fields moved (name, status,
     contract sum, project cost, pricing version, SFs, unit count, line count).

### Versions

- "Changed" means the **SHA-256 of the canonical JSON** of the document differs
  from the latest version's (`api/shared/canonical.js`: keys sorted, the
  `updated` timestamp ignored at every level). An unchanged save creates no
  version.
- A version stores the full document, its SOV rows, contract sum, project cost,
  pricing version, template, author and time. Versions are never edited or
  deleted.
- Version history is **read only**: there is no restore. Going back means
  re-entering values and saving, which creates a new version.
- A status-only change (`PUT {status}`) updates the budget without a version.
- There is **no lost-update protection**: two people saving the same budget
  means the last save becomes current (both are kept as versions).

### What can move a budget's numbers

| Trigger | Automatic? | What happens |
|---|---|---|
| Someone edits and saves | On save | New version if content changed |
| Pricing library published | **No** | Banner offers Update Pricing (§11); saved on the next save |
| Template published | **No** | Affects only budgets created afterwards |
| Fee schedule published | **No** | The Impact Fees step offers "Update to vN"; saved on the next save. A budget keeps the version it was priced from |
| Older document opened | In memory | `migrate()` repairs; the next save versions the repairs |
| Project converted | Once | The primary budget's contract sum and project cost are **snapshotted** onto the project and never move again |
| Investment analysis re-sync | On request, in the analysis | Re-imports from the budget's latest version (§15); the budget is unchanged |
| Budget deleted | On request | Soft delete; versions are kept; saving the same budget id restores it |
| Project deleted | On request | Soft delete that cascades to its budgets and analyses; nothing is destroyed |

---

## 13. What is stored, and rounding

- `dbo.Budgets`: the document, plus `ContractSum` and `ProjectCost` rounded to
  cents (`DECIMAL(18,2)`), `PricingVersion`, template, project link, guard-rail
  status and breach count.
- `dbo.SovLines`: one row per line — scope, group, code, description, basis,
  quantity (2 dp), rate (4 dp), total (2 dp). There are no profit or contingency
  rows.
- `dbo.BudgetVersions` (+ `BudgetVersionSovLines`): the same per version.
- Rounding happens only at display (`usd()` whole dollars, `usd2()` cents) and
  storage. Unit rent computed from a $/SF is rounded to cents.

---

## 14. Worked example

Executed on 2026-10-15 against the real `api/shared/budget-calc.js`,
`app/impact-fees.js` and `app/guardrails.js`, and separately against the
browser's own `parts()`, `csiSchedule()` and `applyImpactFees()`. Browser and
server agree to the cent.

**Inputs.** resSF 50,000; amenSF 2,000; siteSF 200,000. Units: 40 × 1BR (700 SF,
$1,400/mo) + 20 × 2BR (1,000 SF, $1,900/mo) = 60 units. Lines: framing `sf`
$20.00; appliances `unit` $3,000; plumbing typed qty 48,000 × $9.00; storefront
`asf` $21.16; fitness `ls` $60,000 (amenity); architect `sf` $2.65 (soft); SC-20
impact fees. One company at 10%; contingency 5% (`pct`); land $1,500,000;
developer fee 3%, marketing $50,000, closing 1%. Impact fees: City of Waller v1,
high side, one 4" meter @ 250 gpm, all adders on.

| Step | Calculation | Result |
|---|---|---|
| Impact fee | 92,247.76 + 190,475.67 + 4,748.75 + 21,000 + 5,250 + 5,250 | **318,972.18** on SC-20 |
| Residential | 50,000 × 20 + 60 × 3,000 + 48,000 × 9 | 1,612,000.00 |
| Amenity | 2,000 × 21.16 + 1 × 60,000 | 102,320.00 |
| Hard cost | | 1,714,320.00 |
| Profit | 10% × hard | 171,432.00 |
| Contingency | 5% × hard | 85,716.00 |
| **Contract sum** | | **1,971,468.00** |
| Soft costs | 50,000 × 2.65 + 318,972.18 | 451,472.18 |
| Base | contract + soft + land | 3,922,940.18 |
| Total project cost | (3,922,940.18 + 50,000) ÷ (1 − 0.04) | **4,138,479.35** |
| Developer fee | 3% × total | 124,154.38 |
| Closing | 1% × total | 41,384.79 |
| Check | contract + soft + land + fees − total | 0 |
| Rent / other / expenses per month | | 94,000 / 4,875 / 34,220 |
| Net income / yr | 12 × (94,000 + 4,875 − 34,220) | 775,860 |
| Contract $/SF; Project $/SF; Cost/unit | ÷ 52,000 SF; ÷ 52,000 SF; ÷ 60 | 37.91; 79.59; 68,974.66 |
| CSI | Div 06 1,000,000; 08 42,320; 11 240,000; 22 432,000; markups 257,148 | Σ = contract |
| Guard rails | opexRatio 34.6% < 35% blocks; landShare, softCost, hardCostPSF, bldgEfficiency warn | status `breach` |

---

## 15. What an investment analysis takes from a budget

`api/shared/investment/from-budget.js` is used both when an analysis is created
from a budget and when it is re-synced, so the two cannot differ. It reads a
specific saved **version** of the budget:

- **Property size** = resSF + amenSF (the building, never site SF). Unit count =
  total units.
- **Purchase price** = total project cost, recomputed from that version's
  document.
- **Year-1 potential rental income** = 12 × rent / mo. Each other-income row
  becomes an annual amount (12 × rate × count).
- **Expense ratio** (percent of GOI) = 12 × expenses / mo ÷ (gross income / yr ×
  (1 − vacancy)), using the analysis's vacancy (default 10%). Null when there is
  no income or no expenses.

Everything after that (vacancy, NOI, debt, returns) is the investment engine,
documented in `docs/INVESTMENT_FORMULAS.md`. Budget changes never flow into an
analysis on their own; an analysis is re-synced deliberately.

---

## 16. Known discrepancies

Found in the 2026-10-15 audit and verified in code. Each is a real behaviour
today. Remove an entry here when its fix ships (and say so in the change log).

| # | Severity | What happens |
|---|---|---|
| D1 | High | **SovLines ignore amenity suppression.** With amenity SF 0, lump-sum or typed-quantity amenity lines are still written to `dbo.SovLines` (and `vw_SovScopeRollup`), while `ContractSum` excludes them. |
| D2 | High | **Exports print $0 for "% of Income" expense rows.** The print report, both PDFs and Excel compute every expense row as rate × count and label it "per unit"; a % of income row (count 0) prints $0. The totals are correct, so the rows don't add up to them. The screen is correct. |
| D3 | Medium | Exports flag the impact-fee line as **edited** (Excel "Edited = YES", library rate $7.50) instead of derived. |
| D4 | Medium | The impact-fee source row appears only on the print report, and only if the Impact Fees step was opened in that session. |
| D5 | Medium, latent | The fee recalculation checks the schedule key but not the version. Viewing a budget on schedule v2 and then opening another budget priced at v1 recomputes the second against v2 while it still says v1. Cannot happen until a jurisdiction has two versions. |
| D6 | Medium | opexRatio judges a budget with income but **no expense rows** as 0% and blocks the save (when `opexSchemaVersion ≥ 2`); the code comment says such a budget is skipped. |
| D7 | Medium | The guard-rail policy and budget type are read from the submitted document, so a hand-crafted save could relax the server gate. |
| D8 | Medium | The analysis import applies vacancy to other income; the investment engine does not. The derived expense ratio comes out slightly high (≈0.5% in the worked example). |
| D9 | Low | The CSI roll-up can fail to reconcile to the contract with a negative company percentage or a line whose scope is not res/amen/soft. |
| D10 | Low | `sov.js` decides "typed quantity" with `auto === false`, where `lineQty` uses "not auto"; a line with no `auto` field gets different quantities. Only old or hand-built documents have that. |
| D11 | Low | Browser `parts()` fails on a document with no `companies` or `contingency`; the server treats them as 0. |
| D12 | Low | Update Pricing replaces edited rates on matched lines (§11); its help text says "overrides are untouched", which reads as including rates. |
| D13 | Low | Changing the Budget ID field on a saved budget and saving overwrites whichever budget has that id. |

---

## Change log

Every change to the budget arithmetic, or to this specification, gets an entry:
newest first, dated, naming what changed and the code that changed it. A change
to a formula without an entry here is not finished.

### 2026-10-15 — First edition

- Written from a code audit of `origin/staging` at `63ef1a4` (impact & tap fees
  included). Worked example executed against the real modules.
- Records discrepancies D1–D13 as found; none fixed in this change.
- Added alongside the Budget Assistant, which reads this file as its reference
  manual (`api/shared/budget-system.md`).
