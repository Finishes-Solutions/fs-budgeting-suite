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
