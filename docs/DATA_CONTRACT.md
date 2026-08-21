# Data Contract — BD Budget → Master Lender Package

The lender package generator consumes this database; the budget tool is its write side.

## Read surface

**dbo.Budgets** — one row per project. `ContractSum` is the construction contract
number (hard cost + profit + contingency) → the lender package "Total Contract Sum".
`ProjectCost` adds soft costs, land, developer fee, marketing, closing. `Doc` holds
the full budget document (unit mix, income, expenses, markups) for narrative sections.

**dbo.SovLines** — one row per SOV line, rewritten on every save.

| Column | Lender package use |
|---|---|
| Code / Descr | SOV + AIA-style G703 continuation sheet line items (same rows, same order) |
| Scope | res/amen roll into the construction SOV; soft reported separately (not in contract sum) |
| Grp | Budget Category rollup table |
| Basis, Qty, Rate | Backup detail ("$/SF × SF") for lender due diligence |
| Total | Scheduled Value column |
| Provenance | `parametric-estimate` → `vendor-quote` → `contracted`. Package flags any allowance/estimate line above a threshold without backup docs |

## Rules the lender package relies on

1. **Baseline freeze at gate promotion.** When a BD deal promotes, the orchestrator
   copies the budget doc into a baseline (immutable v1). Quarterly packages diff
   current vs baseline to produce the Revision Summary table.
2. **Contingency is line 99.03**, explicit, never blended into other lines.
3. **Contract sum ≠ project cost.** The bank sees the contract sum; project cost is
   for internal underwriting and equity/sources-uses sections.
4. **Pricing version travels with the doc** (`Budgets.PricingVersion`) so any package
   can state which rate library produced it.
5. **`TST-####` is test data, not a project.** Preview environments share this database,
   so throwaway budgets land in these same tables. Every read must filter
   `WHERE ProjectId NOT LIKE 'TST-%'`. `sql/cleanup_test_budgets.sql` purges them.

---

# Versioning, templates and deletion (added 2026-08)

## Four different "versions" — do not conflate them

| Version | Lives in | Means | Changes existing budgets? |
|---|---|---|---|
| **Pricing-library version** | `dbo.PricingLibrary.Version` (e.g. `2026.08-v2`) | A published set of line-item rates | No. A budget carries the version it was priced from |
| **Budget-template version** | `dbo.BudgetTemplateVersions` | An immutable snapshot of the complete defaults a *new* budget starts from | **No — only budgets created after publication** |
| **Saved budget version** | `dbo.BudgetVersions` | An immutable snapshot of one budget at one save | No. History is read-only |
| **Lender-package baseline** | future | The frozen doc a quarterly package diffs against (rule 1 above) | No |

Consequences worth stating plainly:

- A template version affects only future budgets. Publishing a template **never**
  silently reprices existing work — it does not touch `dbo.Budgets`, `dbo.SovLines`,
  or any saved document.
- A saved budget owns an independent snapshot. Opening an existing budget must never
  fetch the current template and layer it over the saved document.
- A meaningful save creates immutable history. A save that changed nothing meaningful
  creates no version.
- `Reprice Budget` remains a deliberate user action and is never triggered by a
  template publication.

## Single source of truth for new-budget defaults

Three copies of "the defaults" exist. They are not peers:

| Copy | Role | Mutable? |
|---|---|---|
| `dbo.BudgetTemplateVersions.Doc` | **Authoritative.** The complete document a new budget is cloned from | Only by publishing a new version |
| `dbo.PricingLibrary.Doc` | Published **line rates only**. The template seeds its rates from here | By publishing pricing |
| `DEFAULT_PRICING` in `app/index.html` | **Offline fallback only** — used when `/api/pricing` cannot be reached, so the app still renders. Never the source for a saved budget's rates when the API is up | Frozen; update only to track the library |

`DEFAULT_PRICING` carries a comment saying exactly this. If you change rates, change
the pricing library and publish — do not hand-edit the constant and expect it to matter.

## Budget version API

- `GET /api/budget/{id}/versions` → `{projectId, currentVersion, versions[]}`, newest
  first. Each entry: `versionNumber`, `isCurrent`, `createdAt`, `createdByName`,
  `changeSummary`, `status`, `contractSum`, `projectCost`, `pricingVersion`,
  `templateKey`, `templateName`, `templateVersion`.
- `GET /api/budget/{id}/versions/{n}` → the same metadata plus `doc` (the immutable
  budget document) and `sovLines[]` (the immutable versioned SOV rows, in `lineOrder`).
- Both are read-only and 404 for a soft-deleted budget. 400 on a malformed project ID
  or version number. There is no restore, rollback, compare or version deletion.

`PUT /api/budget/{id}` returns `{ok, versionNumber, versionCreated}`. Version identity
is decided by deterministic JSON canonicalization (sorted keys, `updated` excluded)
hashed with SHA-256; migration baselines fall back to normalized content comparison
because their hash was computed by the database over raw stored text.

## Stable line identity

Every budget line carries a `lineId` (UUID, minted on creation, backfilled by
`migrate()` for older saves). It persists as `SovLines.LineKey` and
`BudgetVersionSovLines.LineKey`, and is what selection, code editing, focus keys and
batch deletion key off. Array positions are **not** row identity. `LineOrder` carries
document order. Duplicate or missing IDs store `NULL` rather than failing a save.

## Deletion is recoverable

`DELETE /api/budget/{id}` sets `IsDeleted = 1` and `DeletedAt`. It does **not** delete
`SovLines`, `BudgetVersions` or `BudgetVersionSovLines` — history survives deletion.

- `GET /api/budgets` and `GET /api/budget/{id}` exclude soft-deleted budgets; the
  versions endpoints 404 for them.
- `PUT` on a soft-deleted project ID clears the flag: recreate means restore.
- The application has **no hard delete**. `sql/purge_deleted_budgets.sql` is the
  admin-run recycle-bin empty; it removes child rows first inside one transaction.
- `vw_DeletedBudgets` is the recycle bin. `vw_Budgets` and `vw_SovScopeRollup` exclude
  `TST-%`, and the rollup also excludes soft-deleted budgets.

## Division and group percentages — denominators

| Section | Denominator | Label |
|---|---|---|
| Budget page scope and group headers | that scope's sum | `% Scope` |
| CSI divisions and Division 99 — Markups | Contract Sum | `% Contract` |
| Soft-cost groups | **total soft costs**, not Contract Sum | `% Soft` |

Soft costs sit outside the contract sum (rule 3), so reusing Contract Sum there would
produce percentages that cannot sum to 100. Only leaf lines are summed — no subtotal is
ever counted into another subtotal. A zero denominator displays an em dash.

## Template API

- `GET /api/templates` → `{isAdmin, templates[]}`. Non-admins see active templates
  only; admins also see deactivated ones so they can be revived.
- `GET /api/templates/{key}` → metadata plus `doc` (the current published version's
  document) and `currentVersionId`. Resolves for deactivated templates too, so budgets
  referencing one keep opening.
- `GET /api/templates/{key}/versions` and `/versions/{n}` → history and one immutable
  version.
- `POST /api/templates` → create a template and its version 1. **admin**
- `PUT /api/templates/{key}` → publish a new immutable version. **admin**
- `PATCH /api/templates/{key}` → name, budget type, description, `isActive`. **admin**

Mutations are gated twice: a route rule in `staticwebapp.config.json` and
`hasRole(req,'pricing_admin')` inside the Function. Publishing allocates the next
version number under `UPDLOCK`/`HOLDLOCK`, demotes the previous current version and
inserts the new one in one transaction; the filtered unique index on `(TemplateKey)
WHERE IsCurrent = 1` is the database-level backstop. There is no DELETE — a template is
deactivated, never removed, so a budget's provenance never dangles.

A template is edited by loading its document into the ordinary budget editor and
published back as a new version. Renaming or deactivating a template never changes what
any budget was created from.

## Cold starts

Azure SQL serverless auto-pauses. `api/shared/db.js` retries transient faults (40613
and related) with backoff for roughly a minute and shares a single connect attempt
across concurrent callers, so a resuming database is not stampeded. The frontend shows
a loading screen with escalating messages and always clears it, so a genuine outage
surfaces the offline banner instead of trapping the user behind an overlay.

## Migration execution order

Live database: `sql/migrate_budget_history_and_templates.sql`, then `sql/views.sql`.
Verify with `sql/verify_migration.sql` (read-only, one row per check).
Fresh install: `schema.sql` → `seed_pricing.sql` → the migration → `views.sql`.
`purge_deleted_budgets.sql` and `cleanup_test_budgets.sql` are admin-run and are never
part of a deployment.

---

# Investment analyses (added 2026-08)

## Separate aggregate — the lender-package contract is untouched

The investment-analysis module writes ONLY to its own four tables
(`InvestmentAnalyses`, `InvestmentAnalysisVersions`, `InvestmentAnnualResults`,
`InvestmentVersionAnnualResults`). It never writes to `SovLines` or any budget
table, and nothing above changes meaning: the lender-package read surface is
exactly what this document already says it is.

An analysis created from a budget stores `SourceBudgetVersionId` — a NO ACTION
foreign key to the exact immutable `BudgetVersions` row it imported from — plus
the same provenance inside its JSON documents. The budget changing later never
changes the analysis; a new import is an explicit user action that creates a
new analysis version.

## What "content changed" means for an analysis

The canonical hash covers `{rawInput, sourceBudgetVersionId, calculationVersion}`.
Two consequences: a no-op save creates no version, and upgrading the engine
(`calculationVersion`) versions on the next save instead of silently rewriting
history. Old versions are returned exactly as stored — never recalculated.

## Server authority

The browser posts assumptions and renders returned results.
`POST /api/investment-calculations` previews without persisting;
`PUT /api/investment-analysis/{id}` recalculates server-side, ignores any
client-supplied result object, and enforces `expectedVersionNumber` optimistic
concurrency (HTTP 409 on a stale save). Rates in the API are decimal fractions
(6.5% is 0.065); display conversion is the browser's job.

## Annual rows

Five current rows per calculated analysis and five immutable rows per version
carry the reporting columns (`DECIMAL(19,4)` money, `DECIMAL(19,10)` ratios).
`ResultDoc` remains the full-precision authority they must reconcile with —
`sql/verify_investment_analyses.sql` checks exactly that.

---

# Projects, guard rails and derived underwriting (added 2026-08)

## `dbo.Projects` is the parent, and one project per ID is a primary key

A budget belongs to exactly one project. `dbo.Projects.ProjectId` is the
primary key, and that constraint *is* the "one project per ID" guarantee —
nothing in application code has to defend it.

A project can carry more than one budget. That is reached with a **namespaced
budget id** rather than a surrogate key: `BD-0001` is the project's base
budget, `BD-0001-02` and `BD-0001-03` are alternates, and `ProjectKey` is the
id with the suffix stripped. Consequences worth knowing before changing it:

- `dbo.Budgets` keeps `ProjectId` as its primary key. `SovLines`,
  `BudgetVersions` and `InvestmentAnalyses` keep their existing foreign keys.
  No row was re-keyed and no route changed.
- `ID_RX` widened to `^(OP|BD|AS|TST)-\d{4}(-\d{2})?$` in the four files that
  change together (`app/index.html`, `api/budget/index.js`,
  `api/budget-versions/index.js`, `test/mock-api.js`).
- **A budget's identity encodes its project.** Moving a budget to a different
  project means giving it a new id, not editing a column. That is the one thing
  a surrogate key would have bought.

`InvestmentAnalyses` keeps `ProjectId` (the exact budget it was built from —
still true, still useful) and gains `ProjectKey` (the project it rolls up to).
Both are written; neither replaces the other.

## Converting a project captures money; it does not track it

`Status = 'Converted to Project'` stamps `ConvertedAt` and copies the primary
budget's `ContractSum` / `ProjectCost` into `ContractAmount` / `ProjectAmount`.
Those columns are a **snapshot** and never move again.

This is deliberate and the analytics dashboard depends on it: reported backlog
must not change because somebody edited a budget after the deal was booked.
Anything reporting converted totals reads those two columns — never a live join
to `dbo.Budgets`.

## Guard rails are a document property, not a screen state

`app/guardrails.js` and `api/shared/guardrails.js` are byte-identical, and
`evaluate()` is pure over already-computed `parts()` / `grossIncome()`.

- **Thresholds ship in the budget template's published version document**
  (`doc.guardrails`), so publishing a template publishes the policy. The
  `DEFAULT_POLICY` constant is the offline fallback only — the same
  relationship `DEFAULT_PRICING` has to the pricing library.
- **A rail whose denominator is zero is not evaluated.** It is not a pass and
  not a breach; it is absent. Without this, block-on-save would make it
  impossible to create a budget.
- **`opexRatio` blocks only at `doc.opexSchemaVersion >= 2`** — a budget on the
  old service-expense rows is warned, not blocked, because every budget that
  predates this release sits at roughly 9% of income. Flipping it is a change
  to the template's policy, not a code change.
- **An override is a record, not a mute.** `doc.guardrailAcks` entries carry a
  mandatory reason plus who and when, downgrade that rail to a warning, print on
  the PDF and the Excel workbook, and are pruned automatically once the value is
  back in range.
- `Budgets.GuardrailStatus` / `GuardrailBreachCount` (and the same pair on
  `BudgetVersions`) are a queryable summary of the last save. `ResultDoc`-style
  authority stays with the rails themselves; the columns are for lists.

## Project costs: percentage or fixed

`doc.projectCosts.dev` / `.mkt` / `.cls` are `{mode:'amt'|'pct', val}`, the
shape `doc.contingency` already used. A bare number is a pre-migration document
and means dollars; `migrate()` lifts it once on load.

A percentage is a share of the **final total project cost** — the number on the
summary line, fees included. That is circular by definition, so `parts()`
solves it rather than approximating:

```
base    = contract + soft costs + land
f       = the summed percentage rates
project = (base + fixedFees) / (1 − f)
fee_i   = fixed_i + f_i × project
```

So a 3% developer fee really is 3% of the printed total. The divisor floors at
`FEE_FLOOR` (0.05) so a budget the `feeSum` rail is already refusing still
renders a finite number instead of `$Infinity`.

## The analysis expense ratio is derived, and says so

`api/shared/investment/from-budget.js` is the single projection from a budget
version into an analysis input, used by creation **and** by
`PUT /api/investment-analysis/{id}?scope=resync`. Three rules in it:

1. **Property size is the building** (`resSF + amenSF`), never `doc.siteSF`.
   Site SF is land; it prices nothing and it is carried separately as
   `source.support.landSquareFeet`.
2. **Purchase price is Total Project Cost**, recomputed from the version
   document rather than trusted from a stored column.
3. **The expense ratio is derived against Gross Operating Income** — after
   vacancy, other income included — because that is what the engine's
   `percentOfGOI` mode multiplies:
   `derived = annualBudgetOpex / (budgetGrossIncomeYr × (1 − vacancy))`.

`expenses.derivedFrom` records the project, the budget version, and the two
figures the ratio came from. `expenses.override` is the user turning it off,
and it is visible on the editor, in the list, and in every export.

**Deriving the ratio does not move `CALCULATION_VERSION`.** The arithmetic is
byte-identical; only the provenance of one input is new. A saved analysis is
still never silently recalculated: the budget's current version number is
reported so the client can *offer* a re-sync, and the user chooses.
