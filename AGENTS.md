# AGENTS.md — agent context for this repository

This file is the ground truth for AI agents (and new humans) working in this repo.
It distills the rules that are easy to break and expensive to learn the hard way.
For depth, follow the pointers in [Read next](#read-next) — this file does not
replace those docs, it tells you which rules you must not violate while using them.

## What this is

The **Budgeting Suite** (formally the **Finishes Solutions Budgeting Suite**) is an
internal tool for building multifamily construction budgets: a schedule-of-values
editor with a pricing library, budget templates, version history, CSI division
roll-ups, and PDF/Excel exports. It runs as an Azure Static Web App (Standard tier)
with SWA-managed Azure Functions (Node 18) over a single Azure SQL serverless
database, authenticated through Microsoft Entra ID.

Naming: the product is "Budgeting Suite" or "Finishes Solutions Budgeting Suite" —
never "FS Budgeting Suite". Some Azure resource names predate the current product
name and must not be renamed; `docs/NAMING.md` maps them. The production custom
domain is `budgets.finishessolutions.ai`; staging is tested on the SWA staging URL.

## Ground rules — read before touching anything

1. **No build step, ever.** The budget frontend is `app/index.html` (HTML +
   inline CSS + inline JS); the investment workflow is the plain-JS IIFE
   `app/investment-analysis.js`. There is no bundler, no transpiler, no
   minifier — a syntax error ships as a broken page. Before committing, verify
   the scripts parse (`node --check` on the module and on the extracted inline
   script, or run a test suite, which loads the page and fails loudly).
2. **Push to `origin/staging` only.** Never commit to or push `main`. Release to
   production is a staging→main pull request — a deliberate human decision, not a
   side effect of finishing work.
3. **The workflow filename is its identity.** Never rename
   `.github/workflows/azure-static-web-apps-wonderful-rock-071c8e810.yml` and never
   add a second workflow that calls the SWA deploy action. Deployment auth is OIDC
   (federated credentials tied to that filename). Never introduce deployment
   tokens — the old `AZURE_SWA_DEPLOYMENT_TOKEN` secret was rotated out on purpose.
4. **One database serves every environment, including production.** There is no
   staging database. A migration is live everywhere the moment it runs, so schema
   changes must be backward-compatible with the code currently deployed, and
   migrations are paired with prompt releases.
5. **Guard rails block the save, in two places, from one file.**
   `app/guardrails.js` and `api/shared/guardrails.js` are **byte-identical**;
   `test/guardrails.test.js` fails the build if they drift. `evaluate()` is pure
   and takes already-computed `parts()`/`grossIncome()` — it never recomputes
   them, because a third copy of that arithmetic is a third thing to keep in
   parity. Two rules are load-bearing and must not be "simplified" away: a rail
   whose denominator is zero is **not evaluated** (or a blank budget could never
   be saved), and `opexRatio` blocks only when `doc.opexSchemaVersion >= 2` (or
   release day would make every existing budget unsaveable at once).
6. **Exports build from the data model, never the DOM.** The PDF report and Excel
   workbook are composed from `parts()`, `csiSchedule()`, `grossIncome()`, and the
   document itself. Screen state (collapsed groups, filters, scroll) must never
   change what an export contains.

## Architecture map

| Path | What it is |
|---|---|
| `app/index.html` | The budget frontend — HTML + inline CSS + inline JS, no build step |
| `app/investment-analysis.js` / `.css` | The Investment Analysis workflow — external no-build IIFE behind `window.FSInvestmentUI`, wired through an adapter |
| `app/theme-ramp.css` | The Editorial theme pack — presentation only, every rule scoped to `html[data-skin=ramp]`, loaded after the inline sheet |
| `app/guardrails.js` / `api/shared/guardrails.js` | Budget guard rails — **byte-identical** UMD pair, enforced by `test/guardrails.test.js` |
| `app/projects.js` | The Projects tab — one project per ID, with its budgets and analyses |
| `app/staticwebapp.config.json` | Routes, Entra provider registration, role enforcement (first auth gate) |
| `app/vendor/exceljs.min.js` | ExcelJS 4.4.0, vendored — see [Single sources of truth](#single-sources-of-truth) |
| `app/assets/` | Logos + favicon set; regenerate with `tools/make-favicons.py`, don't hand-edit |
| `api/budget/` | GET / PUT / DELETE one budget; PUT writes the version snapshot |
| `api/budgets/` | Budget list (excludes soft-deleted) |
| `api/budget-versions/` | Read-only version history |
| `api/pricing/` | Pricing library read + publish |
| `api/templates/` | Budget templates: list, read, versions, create, publish, activate |
| `api/investment-*/` | Investment analyses: list/create, CRUD + 409 concurrency, versions, stateless preview |
| `api/shared/investment/` | The server-only before-tax calculation engine (fixture-proven; see Testing) |
| `api/shared/` | `auth.js` (principal + roles), `db.js` (pool + cold-start retry), `canonical.js` (canonical JSON + hashing), `sov.js` (SOV projection), `versioning.js` (version writes), `projects.js` (the Projects aggregate), `guardrails.js` (rail evaluator) |
| `api/shared/investment/from-budget.js` | The budget→analysis projection, shared by creation AND re-sync so the two cannot derive differently |
| `sql/` | Idempotent schema + migration + views, seeds, and admin-run scripts |
| `test/` | Ten Playwright suites, `node:test` logic tests, and `mock-api.js` (a local stand-in for the SWA API) |
| `docs/` | Build guide, data contract, handoff, roadmap, naming |

Stack: Azure Static Web Apps (Standard) → SWA-managed Azure Functions (Node 18,
`mssql`) → Azure SQL serverless (auto-pauses; see cold start below) → Entra ID
custom provider for sign-in.

## Deployment & CI

- **Branch model:** work lands on `staging`; every push deploys the staging
  environment. Production deploys only when a staging→main PR merges.
- **Cold start:** the serverless database auto-pauses. `api/shared/db.js` retries
  transient errors (40613 etc.) with backoff for ~60s, and the frontend shows a
  boot screen while the first request wakes the database. Don't "fix" slow first
  loads by removing either.
- **Per-PR preview environments** are created by the workflow but cannot sign in
  (the Entra redirect URIs don't cover them). That is expected; test on staging.
- **The "Close Pull Request Job" fails on every PR close.** The SWA action's close
  step does not accept OIDC and asks for a deployment token. This is a known,
  accepted failure — do **not** "fix" it by adding a deployment token (see ground
  rule 3). Consequence: per-PR preview environments linger and are cleaned up
  manually in Azure. Details in `docs/HANDOFF.md`.
- **A NEW `api/<name>/` folder is not reliably picked up by the deployed host.**
  `api/admin-roles/` answered 404 on staging across two deploys — through a
  parameterised route and then a flat one — while every established endpoint kept
  working, its files were present in the deployed tree, no route collided, and the
  deploy logs showed the API building cleanly. The cause was never reproducible
  from this repo. So: **prefer extending an endpoint that already deploys over
  adding a function folder.** Role management is `GET/PUT
  /api/user-settings?scope=roles` and the activity log is
  `GET /api/analytics?scope=activity` for exactly this reason. If a new folder is
  genuinely warranted, deploy it on its own first and confirm it answers before
  building a feature on top of it. Note the security consequence: a
  `staticwebapp.config.json` route rule matches paths, not query strings, so a
  query-parameter scope is gated **only** by the in-function role check — that
  check becomes the real gate and must not be treated as defence in depth.

## Database rules

- **Migrations are idempotent T-SQL** meant for the Azure portal Query Editor run
  by a database admin: `SET XACT_ABORT ON`, existence-guarded DDL, and
  `sp_executesql` for any statement referencing a column the same batch adds
  (batch-compile binding). Each migration has a preflight, the migration, and a
  verification section; `sql/verify_migration.sql` returns a single result set
  because the portal exports only one.
- **Admin scripts are never deployed or called by the app**:
  `sql/purge_deleted_budgets.sql` (child-first hard purge of soft-deleted budgets)
  and `sql/cleanup_test_budgets.sql` (removes `TST-%` data). They are run by a
  human, on purpose.
- **Soft delete only.** The app never hard-deletes a budget: DELETE sets
  `IsDeleted = 1` + `DeletedAt`; GET/list exclude deleted; PUT to a deleted id
  restores it. Do not rely on `ON DELETE CASCADE` from `dbo.Budgets` —
  `BudgetVersions` FKs are NO ACTION by design; the purge script deletes
  children first.
- **Versions and template versions are immutable.** A budget save that changes
  content inserts a new `BudgetVersions` row (canonical-JSON SHA-256 compare
  makes unchanged saves a no-op); nothing updates or deletes an existing version.
  Publishing a template demotes the current version and inserts a new one —
  `IsCurrent` is enforced by a filtered unique index.
- **Keep `sql/schema.sql` in parity with the migrations**, including constraint
  names. `schema.sql` is what a from-scratch provision runs; the migration is what
  the live database ran. They must describe the same end state.
- **A deploy lands before its migration, so never name a new column
  unconditionally.** A migration is run by a human in the portal, minutes or days
  after the code that needs it ships. SQL referencing a column that is not there
  yet fails the whole request — that is how a pending migration turns into a blank
  Home page and a red banner instead of a feature that is merely not on yet.
  Columns added by a migration are optional until it runs: ask
  `api/shared/schema.js` what exists and build SQL that names only real columns,
  falling back to the pre-migration behaviour. Guard the *behaviour* too — a role
  column that is absent makes every account read as the default role, so applying
  a role filter then would hide records that used to be visible. Cover the
  not-yet-migrated shape in tests (`test/schema-probe.test.js`).

## Frontend invariants (the ones that bite)

- **`lineId` is row identity.** Every SOV line has a stable `lineId`
  (`crypto.randomUUID()` with a fallback). All mutation goes through the
  `lineById` helpers — never index into `doc.lines` by position to mutate.
- **`data-k` focus keys.** Every rendered input carries a
  `data-k="line.<lineId>.<field>"` (or equivalent) key so focus and caret survive
  re-render. A new input without a `data-k` loses the user's cursor on every
  keystroke.
- **`baseUnit` vs `unit`.** `baseUnit` is the pricing-library rate; `unit` is the
  possibly-edited rate. The edited flag, library-rate export column, and rate
  math all depend on the distinction — never collapse the two.
- **Amenity suppression is arithmetic, not hiding.** Amenity-allocated cost is
  subtracted from residential math; suppressed lines still exist in the document.
  Don't reimplement it as filtering.
- **New lines insert in place:** use `insertLine()` / `revealLine()`; never
  append to the end of `doc.lines` and re-sort.
- **The router claims only `#/` routes.** Anything else (`#top`, plain anchors)
  must fall through untouched.
- **`esc()` every user-supplied string** interpolated into HTML — including
  strings added by new features (group names, template names, notes). This is the
  XSS boundary; there is no framework doing it for you.
- **`nz()` every numeric read** that could be absent on old documents. Blank
  inputs coerce to 0, but *absent properties* are `undefined` and print `$NaN`.
  `migrate()` repairs old documents on load; formatters and arithmetic still
  guard with `nz()`.
- **`touch()` / `markDirty()` / `recalc()`** are the change pipeline — call
  `touch()` after mutating the document; don't invent parallel dirty tracking.
- **`data-gr` is the guard-rail equivalent of `data-k`.** A rail marks its
  driving input by `data-gr="<railId path>"`, which survives re-render; never
  mark a field by DOM position.
- **Fees are `{mode:'amt'|'pct', val}`, like `doc.contingency`.** A percentage is
  a share of the FINAL total project cost, which is circular, so `parts()` solves
  it in closed form: `project = (contract + soft + land + fixedFees) / (1 − f)`.
  The divisor floors at `FEE_FLOOR` so a budget the `feeSum` rail is already
  refusing still renders a finite number instead of `$Infinity`. A bare number is
  a pre-migration document and means dollars; `migrate()` lifts it once.
- **Expenses have a third basis, `pctIncome`** — a share of rent + other income.
  Not circular: income does not depend on expenses.
- **Theme packs are paint only.** A pack (Settings → Theme Pack, super_admin)
  is an alternate appearance of the same product: it may remap tokens and
  restyle primitives, never move a route, label, control, calculation or
  permission. Every rule lives in its own file, scoped to `html[data-skin=…]`,
  so the default appearance cannot regress; the role decides whether a stored
  pack is applied, and `beforeprint` strips the attribute so exports never
  inherit one. Details in `docs/HANDOFF.md`.
- **CSS scoping:** the page is one stylesheet; qualify selectors
  (e.g. `.tbl input.codein`) because broad rules like `.tbl input` win on
  specificity and have caused real clipping bugs.
- **Mobile is fully capable.** There is no read-only mode: small screens get
  every page, editor, and action. The `@media(max-width:760px)` blocks (in
  `index.html` and `investment-analysis.css`) only reflow the layout — wide
  tables keep their column widths and pan inside their card (`.card-bd`
  gains `overflow-x:auto` plus per-table `min-width`s), dense grids collapse
  to one column, and the tab bar scrolls horizontally. Never reintroduce a
  width-based feature gate; suite-06 pins the fully-capable behavior.

## Projects

- **`dbo.Projects` is the parent, and its primary key is the "one project per
  ID" guarantee.** Budgets and analyses link to it by `ProjectKey` — the budget
  id with any `-NN` alternate suffix stripped.
- **The project surface is query scopes on endpoints that already deploy**
  (`GET /api/budgets?scope=projects`, `?scope=project&id=…`,
  `PUT /api/budget/{id}?scope=project`), for the same reason role management is:
  a new `api/<name>/` folder is not reliably picked up by the deployed host.
  A route rule matches paths, not query strings, so the in-function check on
  these scopes is the **only** gate and must be written as the real gate.
- **Project statuses are their own vocabulary** — Lead → Qualified → Budgeting
  → Proposal Sent → Awarded → **Converted to Project**, plus On Hold and Lost.
  Budget and analysis statuses (Draft / In Review / Completed / Cancelled) are
  unchanged: they answer "is this document finished", which is a different
  question from "where is this deal".
- **Converting SNAPSHOTS the money.** `ContractAmount` / `ProjectAmount` are
  captured from the primary budget at the moment of conversion and never move
  again. A budget edited afterwards must not restate reported backlog, which is
  why the analytics totals read those columns and not a live join.

## Auth & security

- **Two gates on every privileged route:** an SWA route rule in
  `staticwebapp.config.json` *and* an in-Function `hasRole(req, 'pricing_admin')`
  check. Adding an endpoint means adding both; the config alone is not enough
  (Functions are reachable through rewrites) and the Function alone leaves the
  route listed as public.
- **Roles, not email allow-lists.** Authorization is Entra app roles. Never gate
  by email address or domain in code.
- **`ID_RX` lives in four files that change together:**
  `app/index.html`, `api/budget/index.js`, `api/budget-versions/index.js`, and
  `test/mock-api.js` — all must accept exactly
  `OP-####`, `BD-####`, `AS-####`, `TST-####`, **plus an optional `-NN` suffix**
  (`BD-0001-02`). The plain form is a project's base budget; the suffix is an
  ALTERNATE budget under the same project. Stripping the suffix gives the
  project id, which is what `dbo.Projects` is keyed by — that is what makes
  "one project per ID" true, and it is why many-budgets-per-project needed no
  re-keying of `dbo.Budgets`, its three foreign keys, or any route. `TST-` ids are test data:
  excluded from views (`sql/views.sql`) and purgeable by the cleanup script.
- **From the client principal, store only `userId` and `userDetails`.** Don't
  persist claims or tokens.

## Single sources of truth

- **Templates → pricing library → `DEFAULT_PRICING`.** New budgets come from the
  template system; the pricing library backs rates; the `DEFAULT_PRICING` constant
  in `app/index.html` is an *offline-only* fallback (commented as such). Never
  make it a source of defaults for a connected session.
- **Vendored ExcelJS 4.4.0 cannot author native Excel charts** (it does support
  images, data bars, and conditional formatting). The exports are deliberately
  chart-free — don't add a charting library; the decision and history are
  recorded in `docs/ROADMAP.md`.
- **Canonical JSON + SHA-256** (`api/shared/canonical.js`) defines "content
  changed": sorted keys, volatile keys (`updated`) excluded. Anything comparing
  documents must go through it, or unchanged saves will spawn versions. Never
  change its defaults — budget hashing depends on them byte-for-byte; the
  investment module wraps it rather than modifying it.
- **The budget→analysis projection lives in one module.**
  `api/shared/investment/from-budget.js` is used by creation AND by
  `PUT /api/investment-analysis/{id}?scope=resync`; if they derived separately,
  re-syncing would quietly change numbers that were never wrong. Three rules in
  it were each got wrong once: property size is the **building**
  (`resSF + amenSF`), never `siteSF` (which is land and prices nothing); purchase
  price is Total Project Cost recomputed from the version document; and the
  expense ratio is derived against **Gross Operating Income** — after vacancy —
  because that is what the engine's `percentOfGOI` mode multiplies.
  Deriving the ratio does **not** move `CALCULATION_VERSION`: the arithmetic is
  unchanged, only where the input came from is new.
- **The investment engine is server-only and version-stamped**
  (`api/shared/investment/`, `before-tax-1.1.0`). The browser posts
  assumptions and renders returned results; saves recalculate server-side and
  ignore client results; old analysis versions are never recalculated. Formula
  changes require a new version string and must keep
  `test/investment-calculations.test.js` reconciling all five reference deals.
  Budget summary money (`ContractSum`/`ProjectCost`) likewise derives
  server-side via `api/shared/budget-calc.js` — mirror any browser CALC change
  there or suite-09's parity check fails.
- **Analysis routes carry GUIDs** (`#/analysis/{guid}`): handled before the
  uppercase/ID_RX budget path in `routeFromHash`, never fed to `openBudget`.
  `app/investment-analysis.js` talks to `index.html` only through the adapter
  passed to `FSInvestmentUI.init()`.

## Testing

- Run everything: `./test/run-all.sh` (or `./test/run-all.sh 03 08` for specific
  suites). It starts two `mock-api.js` servers (one deliberately dead for the
  offline suite), runs the `node:test` files first, and restarts the mock between
  suites because suites assert exact row counts.
- Playwright needs Chromium; point `CHROMIUM_PATH` at the binary if it's not
  where Playwright expects.
- **Suites assert visible button text on purpose** (`button:has-text("Export…")`).
  Changing UI copy is expected to break selectors — update the suites in the same
  commit, don't switch the app to test-ids.
- **`test/mock-api.js` must stay behavior-parallel with `api/`**: same validation
  (including `ID_RX`), same soft-delete semantics, same response shapes. An API
  change without its mock change will pass locally and lie.
- Pure logic (canonical JSON, hashing, SOV projection, calculations) goes in
  `test/*.test.js` under `node:test` — no browser required.
- New features come with tests in the same commit. Twenty-one suites exist
  (`suite-01` … `suite-21`; 11–14 are the investment-analysis suites, 20 is guard
  rails, 21 is Projects); extend the closest one rather than starting a
  twenty-second for a small feature.
- **Playwright's bundled browser build can outrun the one installed.** If a
  suite aborts with "Executable doesn't exist at …chromium_headless_shell-<n>",
  point `CHROMIUM_PATH` at the chrome binary that IS installed rather than
  downloading another.

## Style

- UI labels are **Title Case** ("Show Edited Line Flags"); sentences and helper
  text are sentence case. Don't rename identifiers (functions, ids, data
  attributes) during copy changes.
- Match the surrounding idiom: terse, no-framework vanilla JS, comments that
  explain *why* (a constraint, a trap) rather than *what*.
- Money formats through the shared formatters (`money()`, `nz()`); don't inline
  `toFixed` calls.

## Read next

| Doc | When |
|---|---|
| `docs/HANDOFF.md` | First — invariants that bite, open items, known failures |
| `docs/DATA_CONTRACT.md` | Touching the SOV document, versioning, templates, or deletion |
| `docs/BUILD_GUIDE.md` | Provisioning the Azure stack from scratch |
| `docs/NAMING.md` | Anything that names or renames an Azure resource |
| `docs/ROADMAP.md` | Before building something "missing" — it may be deliberately deferred or removed (email export, undo, mobile phase 2, export charts) |
| `docs/INVESTMENT_FORMULAS.md` | Every investment-engine formula, per data point, keyed to its source module |
