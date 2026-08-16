# Investment Analysis — Build Plan

**Status: planned, not started.** This is the execution plan for building the
five-year before-tax investment-analysis module in one continuous build, after
the SQL preflight (below) has been run and its results reviewed.

It adapts four planning documents to the real repository:
`prompt.md` (controlling scope), `analyst-pro-reverse-engineering.md` (finance
authority), `investment-analysis-implementation-plan.md` (architecture),
`planning.md` (checklist), `pre-plan.md` (environment/SQL gate). Where this
plan and those documents disagree on repository facts, this plan is correct —
it was written against the live repo; their snapshot is stale.

## 1. What is being built

A new **Investment Analysis** area of the app:

- A nav tab labeled **Investment Analysis**, placed after **CSI Schedule**
  (before Pricing Library) in the header nav.
- Routes `#/analyses` (list) and `#/analysis/{analysisId}` (six-step
  editor + report), plus a **Create Investment Analysis** entry point on an
  open budget.
- A server-authoritative calculation engine (`api/shared/investment/`)
  reproducing the recovered Analyst Pro before-tax model: five-year operating
  projection (six computed years — a Year-N sale uses Year-N+1 NOI), one fully
  amortizing 30/360 first mortgage or all-cash, exit-cap disposition with
  $1,000-rounded gross sale price used downstream, LTV/DSCR/debt-yield,
  CoC/ROE/equity-multiple, property/financing/equity IRRs, leverage impact,
  optimal hold, and the five-scenario acquisition-price sensitivity.
- Separate versioned persistence (`InvestmentAnalyses` + versions + annual
  rows), linked to an immutable `BudgetVersions.Id` when created from a
  budget, with soft delete and `expectedVersionNumber` optimistic concurrency.
- An on-screen tabular report and a table-only Excel workbook (six sheets,
  numeric cells, no charts anywhere).

Out of scope (validator rejects, UI never shows): charts, after-tax, 10-year,
interest-only, assumed/second/refinance loans, waterfalls, MIRR/NPV,
disposition sensitivity, AI summaries, external integrations.

## 2. Repo-reality corrections to the planning documents

| Document claim | Reality (verified 2026-08-14) |
|---|---|
| `app/index.html` is 3,876 lines | 3,714 lines (report charts were built and then removed on request; see ROADMAP) |
| 29 unit tests, ~280 browser assertions | 29 `node:test` + **349** Playwright assertions across 10 suites, all green at `40d6222` |
| No `AGENTS.md` | `AGENTS.md` + `CLAUDE.md` exist — the build must follow them |
| Node 18 runtime | Confirmed: `app/staticwebapp.config.json` says `node:18`, `api/package.json` says `>=18`, **no `api/package-lock.json`** — the Node 22 checkpoint is required and this container runs Node 22.22.2, so the lockfile can be generated here |
| New suites named `suite-11-investment-create.js` etc. | Name them **`suite-11.js` … `suite-14.js`** — `run-all.sh` selects suites as `test/suite-$n.js`, and suffixed names would break `./test/run-all.sh 11` |
| "Disposable database" test unspecified | Docker 29 is available in the build container — run the migration twice against `mcr.microsoft.com/mssql/server:2022-latest` (fallback if the image can't be pulled through the proxy: static idempotency review against the proven guarded-DDL patterns of `migrate_budget_history_and_templates.sql`, flagged explicitly in the report) |
| `canonical.js` "generalize volatile keys" | Keep budget hashing byte-identical; add an options parameter or a thin investment wrapper — never change the default `VOLATILE_KEYS` behavior, or every existing budget would version on next save |

Main and staging are in sync at PR #4 (`edc8773`); the build starts from
current staging.

## 3. Preflight gate — user actions before the build starts

1. In Azure SQL Query Editor (connected to the app database, not `master`),
   run **Queries A–J from `pre-plan.md`** and provide the outputs. A–B confirm
   identity/DDL permission, C–F confirm current schema matches source control,
   G snapshots row counts (the "before" for the additive-migration proof),
   H–I confirm data health, J is the existing `sql/verify_migration.sql`.
2. Confirm staging sign-in and API work (open the staging site, open a
   budget).
3. Do **not** run any new DDL — the investment migration is executed only at
   the end, from committed files.

Stop conditions (build pauses if any preflight result shows): wrong database,
missing DDL permission, schema drift from `sql/schema.sql`, invalid JSON,
orphan/duplicate versions, or pre-existing `Investment*`/`Underwriting`
objects.

## 4. Branch and deployment model

- Build on **`feature/investment-analysis-staging`**, cut from current
  `origin/staging`. This is a deliberate exception to the session's
  staging-only push convention, per the controlling prompt: incomplete work
  must stay off the auto-deploying branch.
- **Exception:** the Node 22 runtime commit (checkpoint 1) is pushed to
  `staging` directly and immediately — it is isolated, and validating the
  platform change on the real staging environment early is the point.
  Everything else reaches `staging` only at the final merge gate.
- Never touch `.github/workflows/azure-static-web-apps-wonderful-rock-071c8e810.yml`;
  no deployment tokens; the Close-PR-job failure stays as is.

## 5. Build sequence (one go, with checkpoints)

Each checkpoint ends with the full existing suite green (`node:test` +
`./test/run-all.sh`) plus the checkpoint's new tests. Commits are per
checkpoint, so a failure is isolated.

**1 · Node 22 runtime** — `staticwebapp.config.json` → `node:22`;
`api/package.json` engines `>=22 <23`; generate and commit
`api/package-lock.json` under Node 22; full suite on Node 22; push this one
commit to `staging`; verify the staging deploy, sign-in, and a budget
open/save. No `mssql` upgrade unless Node 22 testing proves it necessary
(`mssql@^10` is expected to work).

**2 · Server-side budget calc** — `api/shared/budget-calc.js` ports
`totUnits`, `lineQty`, `scopeActive`, `scopeSum`, `parts`, `grossIncome`
(including amenity-suppression arithmetic and nz-coercion) from
`app/index.html`; parity tests assert server results equal the browser's for
the template budget and edge documents. `api/budget/index.js` derives stored
`ContractSum`/`ProjectCost` from the posted doc, ignoring client meta; request
and response shapes unchanged; mock-api mirrored.

**3 · Finance fixtures** — `test/fixtures/investment/*.json`: Wedgewood
(canonical annual fixture from the spec §8), Combo 15 AC (base + complete
sensitivity matrix §7), Barker Cypress, Frisco, Tomball (inputs §2, headline
outputs §8). Tolerances documented per value class: $1 on annual
dollars/balances, one cent on monthly payment, two display decimals on
rates/ratios exactly.

**4 · Calculation engine** — `api/shared/investment/` modules per the
implementation plan (constants, defaults, validation, normalize, dates,
finance, operating, debt, disposition, returns, sensitivity, calculate,
result-rows). Dependency-free CommonJS. `schemaVersion: 1`,
`calculationVersion: "before-tax-5y-1.0.0"`. Six operating years; rounded
sale price is a named boundary; IRR is a deterministic bracket/bisection
hybrid returning `null` + warning when invalid; no `NaN`/Infinity ever
serialized. `test/investment-calculations.test.js` runs all five fixtures,
the full Combo sensitivity matrix, and the edge cases (all-cash, zero-rate,
no sign change, very high IRR, negative cash flow, acres normalization,
purchase-month period labels, unsupported-branch rejection). **This
checkpoint is the non-negotiable milestone: nothing later starts until every
fixture reconciles.**

**5 · SQL artifacts** — `sql/migrate_investment_analyses.sql` (additive,
idempotent, `SET XACT_ABORT ON`, guarded DDL, `sp_executesql` for statements
referencing new columns, preflight + migration + verification sections),
`sql/verify_investment_analyses.sql` (single result set, PASS/FAIL/INFO),
`sql/purge_deleted_investment_analyses.sql` (admin-only, child-first);
`sql/schema.sql` parity including constraint names; `sql/views.sql` adds
`vw_InvestmentAnalyses` with `TST-%` exclusion. Tables per the implementation
plan §10: `InvestmentAnalyses` (GUID PK, `NO ACTION` FKs to `Budgets` and
`BudgetVersions`, JSON `ISJSON` checks, content hash, calculation version,
queryable summary columns, soft delete), `InvestmentAnalysisVersions`
(unique `(AnalysisId, VersionNumber)`), `InvestmentAnnualResults` /
`InvestmentVersionAnnualResults` (unique per year, `DECIMAL(19,4)` money,
`DECIMAL(19,10)` rates). Prove idempotency by running twice in a SQL Server
2022 Docker container (fallback per §2 table).

**6 · APIs** — `api/investment-analyses/` (GET list, POST create fromBudget/
standalone), `api/investment-analysis/` (GET/PUT/DELETE by GUID),
`api/investment-analysis-versions/` (list + detail), `api/
investment-calculations/` (stateless preview), plus
`api/shared/investment-persistence.js`. Reuse `db.js` (cold-start retry),
`auth.js`, canonical hashing via an investment wrapper (hash of
`{rawInput, sourceBudgetVersionId, calculationVersion}`), UPDLOCK/HOLDLOCK
version allocation, no-op save detection, soft delete/restore semantics,
`expectedVersionNumber` → 409. Server recalculates on every save and ignores
any client-supplied result. Structured validation JSON errors; never raw SQL
errors. Prefill for fromBudget uses `budget-calc.js` against the immutable
version doc: rent×12 potential income (never Net Income/Yr), project cost as
editable purchase-price suggestion, expenses as partial suggestions with a
warning, field-origin metadata stored.

**7 · Mock + API tests** — `test/mock-api.js` gains in-memory analysis routes
with identical validation, versioning, concurrency, and soft-delete behavior;
`test/investment-api.test.js` covers create-from-exact-version, standalone,
server recomputation (tampered result ignored), no-op saves, 409, soft
delete, cross-project version forgery rejection, annual-row reconciliation,
malformed GUID/payload 400s.

**8 · UI** — `app/investment-analysis.js` + `app/investment-analysis.css`
(IIFE, `window.FSInvestmentUI`, initialized from `index.html` with an adapter
exposing `api`, `toast`, `esc`, principal, routing, and export hooks).
`index.html` gains only: the nav button after `nav-csi`, two page containers,
`PAGE_SLUG`/`SLUG_PAGE`/router entries (GUID route segment must not be
uppercased by the existing `#/budget` id handling), and the budget-page entry
button. Six steps (Source & Property, Income, Vacancy & Expenses, Mortgage,
Disposition, Review & Report), source-origin badges, dirty/stale/
calculating/saving/conflict states, read-only version viewing, duplicate and
soft-delete actions. All rendered inputs carry `data-k` keys; all
interpolated text goes through `esc()`; labels are Title Case; mobile
read-only restriction applies (viewing allowed, editing hidden). Cmd/Ctrl+S
saves the active document type only.

**9 · Report + Excel** — the Review step renders every table from the
canonical server result only (acquisition/initial investment, mortgage,
five-year operations, hypothetical sales, LTV/DSCR/debt yield, CoC/ROE/
equity multiple, IRRs + leverage, optimal hold, sensitivity, assumptions +
provenance + warnings + versions). Then the table-only workbook via vendored
ExcelJS: six sheets (Summary, Five-Year Cash Flow, Debt & Sale, Returns,
Sensitivity, Assumptions & Provenance), numeric cells, brand styling from the
existing export helpers, no charts/images. The workbook is the one cuttable
phase if anything upstream slips.

**10 · Browser suites + docs** — `test/suite-11.js` (create from budget:
prefill values + origins), `suite-12.js` (six-step workflow, validation,
calculate/save/reload, keyboard save), `suite-13.js` (versions, duplicate,
soft delete, conflict), `suite-14.js` (workbook wiring + sheet/cell checks);
`run-all.sh` picks them up by glob. Full regression of suites 01–10.
Docs: README, `docs/DATA_CONTRACT.md` (investment tables are separate from
the lender-package SOV contract), `docs/HANDOFF.md` (engine-version and
source-budget invariants), `AGENTS.md` (new invariants), ROADMAP.

## 6. End-of-build gate — user actions, in order

The build stops after checkpoint 10 with everything committed to the feature
branch and all tests green. Then:

1. User runs, in Azure Query Editor, the **committed** files in this order:
   `sql/migrate_investment_analyses.sql` → updated `sql/views.sql` →
   `sql/verify_investment_analyses.sql` (all PASS) →
   `sql/verify_migration.sql` (still all PASS) → re-run pre-plan Query G and
   confirm pre-existing row counts unchanged.
2. Merge `feature/investment-analysis-staging` → `staging`; staging deploys.
3. Staging acceptance with `TST-####` projects: create-from-budget,
   standalone, save/version/conflict, report, workbook, plus existing budget
   regression and sign-in.
4. Only after acceptance and finance review of the five reference deals:
   PR `staging` → `main`.

Rollback: staging code rolls back by reverting the merge; the additive tables
stay in place unused. No down-migration.

## 7. Size and risk

This is the largest single wave attempted in this repo: ~20 new files, 4
tables, 8 endpoints, ~4 new browser suites, one runtime upgrade. The honest
risks, in order: (1) fixture reconciliation — if a recovered formula is
subtly wrong the spec's tolerances will catch it, but debugging IRR
mismatches is slow; (2) the Node 22 deploy is the only change that can break
the live staging site independent of this feature — hence first and isolated;
(3) Docker image pull may be blocked by the proxy (fallback documented);
(4) UI adapter discipline — the temptation to reach into `index.html`
internals instead of the adapter is the maintenance trap the external-module
decision exists to prevent.
