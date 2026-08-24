# Projects, Guard Rails & Budget-Derived Underwriting — Build Plan

**Status: planned, not started.** Written against the live repository at
`6d82665`, not against a snapshot. Where this plan and an older document
disagree on repository facts, this plan is correct.

It covers eight pieces of feedback:

1. Correct square footage and purchase price pulled from the budget into an
   investment analysis.
2. Multifamily operating expenses must sit between 35% and 55%, with a flag
   when they do not — and guard rails generally, across the system.
3. Developer fee, marketing / brokerage and closing costs selectable as a
   percentage of total cost **or** a fixed dollar amount.
4. A **Projects** tab showing each project with the budgets and investment
   analyses linked to it. One project per ID.
5. **Favorites** (a star) replacing the Home pin, visible per project.
6. Project **statuses**, ending in **Converted to Project**.
7. Analytics showing total project amount and contract amount for work that
   became an actual project.
8. The investment analysis expense percentage **derived from the budget**
   rather than typed in.

---

## 0. Decisions taken before planning

| Question | Decision |
|---|---|
| Project ↔ budget cardinality | **Many budgets per project.** A project can carry a base budget plus alternates. |
| Guard-rail enforcement | **Flag and block save.** A breach refuses the save, client and server. |
| Investment expense % | **Derived by default, overridable** with an explicit, visible override. |
| Budget OPEX completeness | **Expand to a full OPEX schedule** as a new published multifamily template version. |

Three consequences of those choices are called out where they land, because
each one is a real trap: §2.3 (block-save cannot brick existing budgets),
§3.2 (percent-of-total-cost is circular and needs a stated convention), and
§4.1 (many-budgets-per-project does **not** require re-keying the database).

---

## 1. What is wrong today — verified, not assumed

### 1.1 Property size imports the land, not the building

`api/investment-analyses/index.js` prefills:

```js
const siteSF = nz(doc.siteSF), bldgSF = nz(doc.resSF) + nz(doc.amenSF);
…
size: { unit: 'squareFeet', value: siteSF > 0 ? siteSF : bldgSF },
```

`siteSF` is the **land area**. `app/index.html` says so itself, in the comment
above `siteMetrics()`: *"Site SF is land, so it prices nothing; it only feeds
these measures."* Preferring it means every price-per-SF figure in the
analysis and its exports is a price per square foot **of dirt**, and it only
looks right on budgets where Site SF was left at 0 — which is exactly why the
error survived: the fallback branch is correct, the primary branch is not.

**Fix:** property size is the building — `resSF + amenSF` — always. Site SF is
not discarded; it moves into `source.support.landSquareFeet` and drives Site
Area / FAR / Density as reference metrics, where the budget already puts it.

### 1.2 Purchase price is right once and then drifts

`acquisition.basis.value = round2(parts(doc).project)` is the correct number —
Total Project Cost, computed server-side from the immutable version document
by the same arithmetic the browser uses. The defect is not the formula, it is
that **it is a snapshot with no way to refresh**. Creation pins
`MAX(VersionNumber)`; every later budget save moves the budget and leaves the
analysis holding an old price with nothing on screen saying so.

**Fix:** a drift badge plus an explicit re-sync (§2 below). Never a silent
recalculation — `docs/DATA_CONTRACT.md` and `AGENTS.md` both require that a
saved analysis version is never quietly restated.

### 1.3 The budget's expense rows are ~9% of income

The shipped multifamily template carries six expense rows — water/sewer,
fiber, communications, valet trash, a dumpster, admin processing. Against the
template's own unit mix that is roughly **9.3%** of gross income. There are no
property taxes, no insurance, no management fee, no payroll, no R&M, no
turnover, no marketing, no reserves.

This is why the current code refuses to use them, and says so on screen:
*"The budget's service-expense rows below are a partial reference only — they
are not a full OPEX picture and are never applied automatically."*

So feedback items 2 and 8 are one change, not two. Deriving the analysis
expense ratio from today's rows would produce ~9% and overstate NOI by a
factor of roughly five. The 35–55% guard rail is precisely the check that
catches it. **The full OPEX schedule (§9) is a prerequisite for §8, and the
guard rail is what keeps it honest.**

---

## 2. Guard rails

### 2.1 One module, two runtimes

The repository already has a pattern for logic that must be identical in the
browser and in a Function: a UMD file duplicated byte-for-byte, with a test
that fails the build if the copies drift (`app/export-render.js` ↔
`api/shared/investment/export-render.js`, enforced by
`test/export-render.test.js`).

Guard rails use that pattern, **not** the port-and-parity pattern of
`api/shared/budget-calc.js` — a rail that disagrees between the button and the
endpoint is a support ticket, not a rounding difference.

New files:

- `app/guardrails.js` (loaded as a plain script, hangs off `window.FSGuardrails`)
- `api/shared/guardrails.js` (**byte-identical**, required as CommonJS)
- `test/guardrails.test.js` — byte-identity check plus rail arithmetic

API:

```js
FSGuardrails.evaluate(doc, { type, policy, acks })
// → [{ id, label, severity, actual, min, max, unit, message, path, acked }]
FSGuardrails.DEFAULT_POLICY   // offline fallback, same role as DEFAULT_PRICING
```

### 2.2 The rails

`opexRatio` is the one asked for; the rest are the "other guard rails
throughout the system" and are cheap once the framework exists. Severity
`error` blocks a save; `warn` flags only.

| id | Rail | Range | Severity |
|---|---|---|---|
| `opexRatio` | Operating expenses ÷ gross income | 35% – 55% | error |
| `feeSum` | Dev fee % + marketing % + closing % (see §3.2) | < 100% | error |
| `unitSF` | Σ unit SF ≤ residential SF | — | error |
| `devFee` | Developer fee ÷ total project cost | 2% – 5% | warn |
| `marketing` | Marketing / brokerage ÷ total project cost | 0.5% – 2% | warn |
| `closing` | Closing costs ÷ total project cost | 0.5% – 3% | warn |
| `landShare` | Land ÷ total project cost | 10% – 25% | warn |
| `profitMargin` | Profit ÷ hard cost | 8% – 20% | warn |
| `contingency` | Contingency ÷ hard cost | 2% – 10% | warn |
| `softCost` | Soft costs ÷ hard cost | 8% – 20% | warn |
| `hardCostPSF` | Hard cost ÷ building SF | $120 – $260 | warn |
| `rentPSF` | Blended rent ÷ rentable SF | $1.00 – $3.50 /mo | warn |
| `bldgEfficiency` | Rentable SF ÷ residential SF | 70% – 95% | warn |
| `siteEfficiency` | Building SF ÷ site SF (FAR) | 15% – 120% | warn |

`bldgEfficiency` absorbs the existing `#sfCheck` badge rather than duplicating
it; the badge keeps its wording and starts being fed by the rail.

**Evaluability rule — load-bearing.** A rail whose denominator is zero or
whose inputs are absent is **not evaluated** and is never a breach. A blank
budget, a budget mid-entry with no units yet, a budget with no expense rows —
none of these can be blocked. Without this rule, block-on-save makes it
impossible to create a budget at all.

**Where the thresholds live.** Not in a formula. They ship in the budget
template's published version document (`doc.guardrails`), so publishing a
template version publishes the policy, and a budget records the rails it was
judged against. `DEFAULT_POLICY` in `guardrails.js` is the offline fallback
only — the same relationship `DEFAULT_PRICING` has to the pricing library,
and it carries the same comment saying so. Per-budget-type policies key off
`doc.type` (`Multifamily`, `Blank`, …); a type with no policy gets no rails.

### 2.3 Enforcement, and the release-safety rule

Three gates:

1. **Browser.** `saveBudget()` evaluates before it serializes. Any unacked
   `error` refuses the save, opens the Guard Rails card, scrolls to the first
   breach and outlines the offending inputs.
2. **Server.** `PUT /api/budget/{id}` re-evaluates from the submitted document
   — never from a client-supplied verdict — and answers
   `422 { error: 'guardrail_breach', breaches: [...] }`. A client that skips
   the check still cannot write.
3. **Status-only PUTs do not evaluate.** `setEntityStatus()` writes status
   without touching the document; re-evaluating there would make an
   out-of-range budget impossible to re-status or cancel.

**The acknowledgement escape hatch (recommended, needs your sign-off).**
Without one, a legitimately out-of-range deal — a heavy-subsidy project, a
land-only budget, a partial scope — is permanently unsaveable, and the only
way out is an admin editing the database. Proposal:

- `doc.guardrailAcks = [{ id, reason, byId, byName, at }]`
- An ack downgrades that rail from `error` to `warn` for that budget only.
- Requires `director` or `super_admin`; a `reason` is mandatory.
- The ack rides into the budget summary, the PDF and the Excel workbook as
  **Guard Rail Override — \<reason\>**, so it is never invisible.
- Editing the value back into range clears the ack automatically.

**Release-safety rule — every existing budget is ~9% OPEX.** Turning
`opexRatio` on as a hard error on release day makes every budget in the
database unsaveable at once. So:

- `opexRatio` is an **error** only for documents carrying
  `opexSchemaVersion >= 2` (created from, or updated to, the full OPEX
  template of §9).
- For everything else it is a **warning** with a one-click **Update Expense
  Schedule From Template** action, and a banner naming the date it becomes
  blocking.
- The flip is a one-line policy change in the template's next published
  version — no code change, no deploy.

### 2.4 Surfaces

- **Guard Rails card** on the Budget page (`#sec-guardrails`): every evaluated
  rail, its actual value, its range, and a link to the input that drives it.
- **Header pill**: `Guard Rails ✓` / `2 Issues` / `1 Blocking`, beside the
  existing save-state pill.
- **Per-field marking**: a `data-gr="<railId>"` attribute on the driving
  inputs, mirroring the existing `data-k` convention, so marking survives
  re-render and never needs a DOM query by position.
- **Lists**: a small rail indicator on the Budgets list and the Projects tab.
- **Exports**: a Guard Rails block in the PDF and the Excel summary sheet,
  built from `parts()` + `evaluate()` — from the data model, never the DOM
  (`AGENTS.md` ground rule 5).

### 2.5 Database

Optional columns, probed through `api/shared/schema.js` (`budgetsGuardrail`),
so the deploy is safe before the migration runs:

- `dbo.Budgets`: `GuardrailStatus VARCHAR(10) NULL`, `GuardrailBreachCount INT NULL`
- `dbo.BudgetVersions`: the same two, so history records what the rails said
  at the moment of the save.

---

## 3. Percentage-or-fixed project costs

### 3.1 Document shape

`doc.projectCosts` moves from three bare numbers to the shape
`doc.contingency` already uses, so the UI idiom (`mini-seg` toggle) and the
arithmetic both have precedent in the file:

```js
// before
projectCosts: { land: 1200000, dev: 200000, mkt: 75000, cls: 0 }
// after
projectCosts: {
  land: 1200000,
  dev: { mode: 'amt', val: 200000 },   // mode: 'amt' | 'pct'
  mkt: { mode: 'pct', val: 1.5 },
  cls: { mode: 'amt', val: 0 }
}
```

`migrate()` lifts an old number to `{ mode: 'amt', val: n }`. Land stays a
dollar figure — it was not part of the request, and a percentage of total cost
for land is not a number anyone quotes.

### 3.2 Percent of *what* — the circularity, and the convention

"A percentage of the total cost" is circular: the developer fee is itself part
of total project cost. Two defensible readings, and the choice must be stated
once and documented, not left to whoever writes the formula:

- **Pre-fee base.** `contract + soft + land`. Simple, but a "3% developer fee"
  is then not 3% of the number printed on the summary line.
- **True total, solved in closed form.** With `base = contract + soft + land`
  and `f` the sum of the three percentage rates:

  ```
  project = base / (1 − f)
  fee_i   = f_i × project
  ```

  Exact, no iteration, and "3% of total project cost" means what it says.
  Undefined when `f ≥ 1`, which is what the `feeSum` rail (§2.2) blocks.

**Recommended: the true total.** Each percentage input shows its resolved
dollar amount immediately beneath it, so nothing is a surprise.

### 3.3 Where it changes

`parts()` changes identically in two places — `app/index.html` (CALC block)
and `api/shared/budget-calc.js` — which is exactly the drift
`test/budget-calc.test.js` and suite-09's browser-parity check exist to catch.
Also: `blankDoc()`, `migrate()`, the Land & Project Costs inputs, the summary
rows, the PDF, the Excel workbook, the CSV, and the help page.

---

## 4. Projects

### 4.1 Many budgets per project without re-keying anything

`dbo.Budgets.ProjectId` is the primary key today, and it is referenced by
`SovLines`, `BudgetVersions`, `InvestmentAnalyses`, the `budget/{id}` and
`budget/{id}/versions` routes, and `ID_RX` in four files. Giving budgets a
surrogate key means touching all of it, migrating three foreign keys, and
rewriting version history — a large, risky change to reach a modest outcome.

**A namespaced budget ID reaches the same outcome for a fraction of the
blast radius:**

- `dbo.Projects.ProjectId` is the new parent and the PK — that is what
  enforces *one project per ID*.
- A project's budgets are `BD-0001` (the base) and `BD-0001-02`, `BD-0001-03`
  … (alternates). `ID_RX` widens from `^(OP|BD|AS|TST)-\d{4}$` to
  `^(OP|BD|AS|TST)-\d{4}(-\d{2})?$`. `VARCHAR(16)` already fits.
- `dbo.Budgets.ProjectKey` is the suffix-stripped ID, backfilled for every
  existing row, FK to `dbo.Projects`.
- **Nothing is re-keyed.** The PK stands, all three foreign keys stand, both
  routes stand, every saved version stands.

Cost of the approach, stated plainly: a budget's identity encodes its project,
so *moving* a budget to a different project means giving it a new ID rather
than editing a column. Given that a budget is priced for a specific site, that
is a fair trade — but it is the one thing the surrogate-key design would have
bought, so flag it if moving budgets between projects is a real workflow.

Widening `ID_RX` touches the four files `AGENTS.md` names as changing
together: `app/index.html`, `api/budget/index.js`, `api/budget-versions/index.js`,
`test/mock-api.js`.

### 4.2 Schema

```sql
CREATE TABLE dbo.Projects (
    ProjectId       VARCHAR(16)   NOT NULL,        -- OP-#### / BD-#### / AS-#### / TST-####
    Name            NVARCHAR(200) NOT NULL CONSTRAINT DF_Projects_Name    DEFAULT (N''),
    Address         NVARCHAR(300) NOT NULL CONSTRAINT DF_Projects_Address DEFAULT (N''),
    Type            NVARCHAR(50)  NOT NULL CONSTRAINT DF_Projects_Type    DEFAULT (N'Multifamily'),
    Status          NVARCHAR(40)  NOT NULL CONSTRAINT DF_Projects_Status  DEFAULT (N'Lead'),
    PrimaryBudgetId VARCHAR(16)   NULL,            -- which budget is "the" budget
    ConvertedAt     DATETIME2     NULL,            -- stamped on → Converted to Project
    ContractAmount  DECIMAL(18,2) NULL,            -- snapshot at conversion
    ProjectAmount   DECIMAL(18,2) NULL,            -- snapshot at conversion
    CreatedById     NVARCHAR(128) NULL,
    CreatedByName   NVARCHAR(200) NULL,
    CreatedAt       DATETIME2     NOT NULL CONSTRAINT DF_Projects_CreatedAt DEFAULT (SYSUTCDATETIME()),
    UpdatedAt       DATETIME2     NOT NULL CONSTRAINT DF_Projects_UpdatedAt DEFAULT (SYSUTCDATETIME()),
    IsDeleted       BIT           NOT NULL CONSTRAINT DF_Projects_IsDeleted DEFAULT (0),
    DeletedAt       DATETIME2     NULL,
    CONSTRAINT PK_Projects PRIMARY KEY (ProjectId)
);

ALTER TABLE dbo.Budgets            ADD ProjectKey VARCHAR(16) NULL;
ALTER TABLE dbo.InvestmentAnalyses ADD ProjectKey VARCHAR(16) NULL;
```

- Backfill: one `dbo.Projects` row per distinct suffix-stripped
  `Budgets.ProjectId`, seeded with that budget's `Name`, doc `address`, `Type`
  and `Status` mapped through §6's table. `ProjectKey` set on both children.
- `InvestmentAnalyses.ProjectId` keeps its FK to `dbo.Budgets` (an analysis is
  built from a specific budget and that stays true); `ProjectKey` is the new
  roll-up path. Both are written; nothing is dropped in this release.
- The migration follows the house rules: idempotent T-SQL, `SET XACT_ABORT ON`,
  existence-guarded DDL, `sp_executesql` for anything naming a column the same
  batch adds, and preflight / migrate / verify sections.
  `sql/schema.sql` is updated in parity, constraint names included.
- New probe keys in `api/shared/schema.js`: `projectsTable`,
  `budgetsProjectKey`, `analysesProjectKey`. Every read path falls back to
  today's behaviour when they are absent, and `test/schema-probe.test.js`
  covers the not-yet-migrated shape.

### 4.3 API — extend, do not add a folder

`AGENTS.md` is explicit that a new `api/<name>/` folder is not reliably picked
up by the deployed host, and that role management and the activity log live
behind query scopes for exactly that reason. Projects follow suit:

| Call | Purpose |
|---|---|
| `GET /api/budgets?scope=projects` | Project list with budget/analysis counts and rolled-up money |
| `GET /api/budgets?scope=project&id=BD-0001` | One project, its budgets, its analyses |
| `PUT /api/budget/{id}?scope=project` | Project metadata and status |

A route rule matches paths, not query strings, so the in-function role check
is the **only** gate on these scopes and must be written as the real gate, not
as defence in depth — the same warning `AGENTS.md` attaches to
`/api/user-settings?scope=roles`.

`test/mock-api.js` gains the identical behaviour in the same commit; an API
change without its mock change passes locally and lies.

### 4.4 Frontend

- New module `app/projects.js` — IIFE exposing `window.FSProjects`,
  initialised from `index.html` with an adapter, following `home.js` and
  `dashboard.js` exactly. No build step; `node --check` before commit.
- Nav: a **Projects** button ahead of **Budgets**.
- Routing: `PAGE_SLUG` / `SLUG_PAGE` / `PAGE_LABEL` gain `projects` and
  `project`; `NAV_PARENT` maps `project → projects`. Routes `#/projects` and
  `#/project/BD-0001`. The project route resolves through `ID_RX` like the
  budget routes and must stay clear of the GUID analysis route, which is
  matched first.
- **Project detail page**, top to bottom: identity header (ID, name, address,
  status chip, converted stamp) → KPI row (contract amount, project amount,
  budget count, analysis count) → **Favorites** strip for this project →
  Budgets (base first, alternates after, each with guard-rail state and a
  star) → Investment Analyses (each with its source budget version and a star).
- **+ Add Alternate Budget** duplicates the current budget into the next free
  suffix under the same project.

---

## 5. Favorites

The pin becomes a star, and the concept is renamed everywhere it is read.

- `api/shared/user-settings-contract.js`: `pinned` → `favorites`.
  `sanitizeSettings()` reads a legacy `pinned` document and lifts it — the
  same legacy-mapping technique the file already uses for
  `homeView` / `tableDensity` → `budgetView`. No migration, nothing lost.
  The `PIN_MAX` / `PIN_ID_MAX` caps keep their behaviour under new names.
- `app/home.js`: `isPinned` / `togglePin` / `unpin` → `isFavorite` /
  `toggleFavorite` / `unfavorite`; `PIN_SVG` → `STAR_SVG` (filled and
  outline); the *Pinned* section becomes **Favorites**; the toast becomes
  "Removed from Favorites."
- The star is a **toggle everywhere**, not the unpin-only affordance the pin
  is today: Budgets list, Analyses list, project detail, and the budget and
  analysis editor headers. That is what makes "on a project tab I can see the
  budget and investment analysis I have favorited" work at all.
- CSS: `.hm-pin` → `.hm-star`, plus `.is-fav`. The card/star sibling structure
  stays as-is — the comment in `home.js` explains why the star cannot live
  inside the card, and that reasoning is unchanged.
- Suites assert visible text on purpose: **suite-18** (Home pinning) and
  **suite-17** (navigation) update in the same commit.

---

## 6. Project statuses

Projects get their own vocabulary. Budget and analysis statuses
(`Draft · In Review · Completed · Cancelled`) are **unchanged** — they answer
"is this document finished", which is a different question from "where is this
deal".

```
Lead → Qualified → Budgeting → Proposal Sent → Awarded → Converted to Project
                                   plus  On Hold  ·  Lost
```

- `statusChip()` / `openStatusMenu()` / `setEntityStatus()` are already keyed
  by `kind`; they gain a `project` kind and a per-kind status list. `STATUS_LIST`
  becomes `STATUS_LISTS = { budget: [...], analysis: [...], project: [...] }`
  with `STATUS_CLS` extended for the new names.
- **Converted to Project** stamps `ConvertedAt` and **snapshots**
  `ContractAmount` / `ProjectAmount` from the primary budget's current
  version. A snapshot, not a live join: a budget edited after conversion must
  not retroactively restate reported backlog. Re-converting re-snapshots and
  records the change in the activity log.
- Backfill maps existing budget statuses: `Draft → Lead`,
  `In Review → Proposal Sent`, `Completed → Awarded`, `Cancelled → Lost`.
  Conservative on purpose — nothing is auto-declared converted.

---

## 7. Analytics

`api/analytics/index.js` gains a `projects` block, guarded by
`features(pool).projectsTable` so the dashboard cannot 500 before the
migration runs:

- counts by project status;
- `convertedCount`;
- `SUM(ContractAmount)` and `SUM(ProjectAmount)` where
  `Status = 'Converted to Project'`;
- conversion rate (converted ÷ non-lost projects);
- a converted-per-month series for the chart row.

`app/dashboard.js` gains two KPI tiles — **Converted Contract Amount** and
**Converted Project Amount** — and a pipeline funnel beside the existing
status chart. `STATUS_COLORS` gains the project vocabulary (it already carries
stale names such as `In Progress` and `Approved`; those get cleaned up in the
same pass). ExcelJS charting is not involved — the dashboard's charts are
hand-built SVG, and `docs/ROADMAP.md` records why exports stay chart-free.

Suite-16 (Analytics parity) extends with the new tiles.

---

## 8. Budget-derived expense percentage

Prefill changes from "deliberately blank" to "derived and labelled":

```js
expenses: {
  mode: 'percentOfGOI',
  value: derived,
  derivedFrom: { projectId, budgetVersionNumber, annualOpex, grossIncome, at },
  override: false
}
```

**The formula, stated exactly** (and added to `docs/INVESTMENT_FORMULAS.md`):
the engine's `percentOfGOI` multiplies **Gross Operating Income** — after
vacancy, including other income. The budget has no vacancy concept, so the
derivation applies the analysis's own vacancy assumption:

```
derived = annualBudgetOpex / (budgetGrossIncomeYr × (1 − vacancy))
```

and re-derives whenever vacancy changes. Deriving against gross income instead
would silently understate the ratio by the vacancy factor.

- **UI**: the field is read-only, badged **From Budget v7**, with the resolved
  annual dollar figure beneath it. An **Override** checkbox unlocks it and
  sets `override: true`, which paints a warning badge on the editor, the list
  row, and every export: *"Expense ratio overridden — does not match budget
  BD-0001 v7."*
- **Standalone analyses** keep the manual field exactly as it is today.
- **Guard-rail tie-in**: when the source budget breaches `opexRatio`, the
  analysis says so at the point of use — *"Budget OPEX is 9.3% of income,
  outside the 35–55% guard rail; this analysis will overstate NOI."*
- `api/shared/investment/validation.js` keeps accepting a manual value;
  `normalize.js` carries `derivedFrom` and `override` through so the result
  document records provenance.
- **`CALCULATION_VERSION` does not change.** The arithmetic is identical —
  only where the input came from is new. `AGENTS.md` requires a new version
  string for a *formula* change; this is not one, and bumping it would
  needlessly orphan every saved analysis from its engine.

### 8.1 Re-sync from budget (also fixes §1.2)

`PUT /api/investment-analysis/{id}?scope=resync` re-reads the project's
current budget version and refreshes the imported fields — property size,
purchase price, potential income, other income, derived expense ratio —
leaving everything the user typed untouched. Extending a route that already
deploys, per §4.3.

- A **drift badge** appears wherever the analysis is listed or opened when the
  source budget has moved past `source.budgetVersionNumber`: *"Budget updated
  to v7 — Re-sync."* The user chooses; nothing recalculates on its own.
- `source.originalValues` is untouched, so the existing **From Budget** badges
  keep comparing against the original import.
- Existing analyses are **not** auto-repaired for the site-SF bug. Silently
  changing a saved number is exactly what the data contract forbids. They get
  a one-line notice — *"Property Size was imported from Site SF (land);
  re-sync to correct"* — and the user decides.

---

## 9. Full OPEX schedule

Published as a **new multifamily template version** through `api/templates/`,
not by hand-editing `DEFAULT_PRICING` / `DEFAULT_EXPENSES` — those are the
offline fallback, and `docs/DATA_CONTRACT.md` is explicit that the template
system is the only source of new-budget defaults.

New categories, on top of the six that exist: Property Taxes, Insurance,
Property Management Fee, On-Site Payroll, Repairs & Maintenance,
Turnover / Make-Ready, Marketing & Leasing, G&A / Office, Landscaping &
Amenity, Replacement Reserves.

A third basis joins `unit` and `fixed`:

- `per: 'pctIncome'` — a percentage of gross income, which is how management
  fees and often taxes are actually quoted. Not circular: income does not
  depend on expenses, so it is a straight computation.

`grossIncome()` gains the basis in **both** `app/index.html` and
`api/shared/budget-calc.js`; `test/budget-calc.test.js` and suite-09's parity
check guard the pair. The document gains `opexSchemaVersion: 2`, which is what
§2.3 keys the blocking rail off.

Existing budgets keep their rows and gain **Update Expense Schedule From
Template** on the Operating Expenses card, which appends the missing
categories at $0 for the user to fill.

---

## 10. Sequencing

Four releases. Each ships code that tolerates the pre-migration shape first,
because a deploy lands before its migration — the rule that turns a pending
migration into a blank Home page if it is broken.

### Release 1 — fixes, no schema change

1. Property size from building SF; land/rentable SF into the support block.
2. Percentage-or-fixed developer fee, marketing, closing (§3).
3. Star / Favorites rename with the legacy `pinned` lift (§5).

*Tests:* suite-11 (prefill), suite-01 / 03 (inputs and summary), suite-09
(browser ↔ server parity), suite-17 / 18 (nav and Home),
`test/budget-calc.test.js`, `test/user-settings-api.test.js`.

### Release 2 — guard rails

4. `guardrails.js` UMD pair, Guard Rails card, header pill, per-field marking.
5. Browser block, server 422, acknowledgement flow.
6. Full OPEX template version published (§9); `opexSchemaVersion: 2`.
7. **Migration A** — `GuardrailStatus` / `GuardrailBreachCount` on `Budgets`
   and `BudgetVersions`; probe key `budgetsGuardrail`.

*Tests:* new **suite-20** (guard rails end to end),
`test/guardrails.test.js` (byte identity + arithmetic),
`test/schema-probe.test.js` (pre-migration shape).

### Release 3 — projects

8. **Migration B** — `dbo.Projects`, `ProjectKey` on `Budgets` and
   `InvestmentAnalyses`, backfill, views, `sql/schema.sql` parity.
9. `ID_RX` widening across the four files; **+ Add Alternate Budget**.
10. Projects tab, project detail, project statuses (§6), favorites strip.
11. Analytics converted-project KPIs (§7).

*Tests:* new **suite-21** (projects), suite-16 (analytics), suite-17 (nav),
`test/mock-api.js` parity throughout.

### Release 4 — derived underwriting

12. Derived-with-override expense ratio (§8).
13. Re-sync scope and the drift badge (§8.1).

*Tests:* suite-11 (prefill), suite-12 (workflow and report fidelity),
suite-13 (versions and conflicts), `test/investment-api.test.js`.

---

## 11. Open items needing your decision

1. **Guard-rail acknowledgement** (§2.3). Recommended, and without it an
   out-of-range deal cannot be saved by anyone. Confirm the escape hatch and
   whether `director` + `super_admin` is the right gate.
2. **Percent-of-total-cost convention** (§3.2). Recommended: the true total,
   `project = base / (1 − f)`. Confirm before the formula is written — it is
   the difference between a 3% fee meaning 3% of the printed total and 3% of
   something slightly smaller.
3. **Budget IDs encode their project** (§4.1). `BD-0001-02` is an alternate of
   `BD-0001`. Confirm that moving a budget between projects is not a workflow
   you need; if it is, the surrogate-key design comes back with its larger
   footprint.
4. **Threshold values** (§2.2). 35–55% is yours. The other twelve ranges are
   the plan's proposals and should be reviewed by whoever owns the underwriting
   standard before they start flagging real budgets.
5. **Conversion snapshot** (§6). Contract and project amounts are frozen at
   conversion. If you would rather the dashboard track the live budget, that is
   a one-line change — but the reported backlog then moves whenever anyone
   edits a budget.
