# Finishes Solutions Budgeting Suite — Handoff

Written for whoever (or whatever) picks this repository up next. It records the things
that are not obvious from reading the code: why the deployment is shaped the way it is,
which invariants will bite you, and what is still outstanding.

Read `README.md` and `docs/BUILD_GUIDE.md` for provisioning. This document assumes the
app is already live and covers *working on it*.

---

## 1 · What the app is

An internal Finishes Solutions tool for building multifamily project budgets. A budget
is priced from a versioned pricing library, adds unit-mix revenue, other income and
operating expenses, and rolls up to a construction contract sum and a total project
cost. It emits a normalized SOV (schedule of values) that the Master Lender Package
pipeline consumes — that downstream contract is why the data model matters more than
the UI does.

**Stack:** Azure Static Web Apps (Standard) · Entra ID auth via a *custom* provider ·
SWA-managed Azure Functions (Node 18) · Azure SQL.

Everyone in the tenant can build budgets. Publishing pricing requires the
`pricing_admin` custom role.

---

## 2 · Repository layout

| Path | What it is |
|---|---|
| `app/index.html` | **The entire frontend** — ~2,700 lines, HTML + inline CSS + inline JS, no build step |
| `app/staticwebapp.config.json` | Routes, Entra provider registration, role enforcement |
| `app/assets/` | Logos. `finishes-logo-white.svg` is the header lockup |
| `app/vendor/exceljs.min.js` | ExcelJS 4.4.0, MIT, vendored (licence file alongside) |
| `api/budget/`, `api/budgets/`, `api/pricing/`, `api/budget-versions/`, `api/templates/` | The five Functions |
| `api/shared/canonical.js`, `api/shared/sov.js`, `api/shared/versioning.js` | Save-versioning primitives; `sov.js` is dependency-free so it tests without `mssql` |
| `api/shared/auth.js`, `api/shared/db.js` | Principal parsing and the `mssql` pool |
| `sql/schema.sql`, `sql/seed_pricing.sql`, `sql/views.sql` | Database |
| `sql/migrate_budget_history_and_templates.sql` | Version history, templates, soft delete — run once, then `views.sql` |
| `sql/verify_migration.sql` | Read-only post-migration check, one row per assertion |
| `sql/purge_deleted_budgets.sql` | Admin-run hard purge of soft-deleted budgets. Never deployed |
| `sql/cleanup_test_budgets.sql` | Purge `TST-%` rows (SovLines first — FK) |
| `sql/migrate_op_ids.sql` | One-time `OP-###` → `OP-####` rename |
| `test/` | Browser test harness (see §7) |
| `docs/` | Build guide, data contract, roadmap, naming, this file |

There is **no build step**. Budget UI changes happen in `app/index.html`; the
Investment Analysis workflow lives in `app/investment-analysis.js` (external
no-build IIFE, adapter-wired — see §6). Everything is served
verbatim — nothing compiles, bundles or minifies it, so a syntax error ships.

---

## 3 · Branches and deployment — read this before touching CI

### The model

```
push to feature[/**]  →  the "feature" named environment (work in progress, signs in)
push to staging     →  the "staging" named environment (stable URL, test here)
PR to main          →  a throwaway per-PR preview environment
push to main        →  production
```

Production is served from the custom domain **`https://budgets.finishessolutions.ai`**
(the SWA default hostname still resolves; the custom domain is the one people use, and
it has its own `/.auth/login/aad/callback` redirect URI registered in Entra).

Staging URL:
`https://wonderful-rock-071c8e810-staging.centralus.7.azurestaticapps.net`

Its `/.auth/login/aad/callback` is **already registered** as a redirect URI in the
Entra app registration. It is stable, so it never needs registering again. Per-PR
preview environments put the PR number in the hostname and therefore *cannot* sign in
— that is expected; ignore them and test on staging.

Feature URL:
`https://wonderful-rock-071c8e810-feature.centralus.7.azurestaticapps.net`

Both `feature` and `feature/anything` publish here, so work in progress has somewhere to
live that is neither staging nor production. It is a NAMED environment, which is
the whole reason it works where per-PR previews do not: the hostname is stable,
so its `/.auth/login/aad/callback` can be registered once and people can actually
sign in. **That registration is a one-time human step** — until it is done the
page loads blank (see the redirect-URI note further down; it is the usual cause).

Two consequences worth stating before anyone uses it:

- **All feature branches share the one environment.** Last push wins. Coordinate,
  or push one at a time. One hostname is one redirect URI to register, which is
  the trade being made.
- **The database is NOT isolated.** One Azure SQL database serves every
  environment, production included, so this isolates code and not data. Use
  `TST-####` budget ids there — `sql/views.sql` excludes `TST-%` from every
  reporting view and `sql/cleanup_test_budgets.sql` purges them. A `BD-` id typed
  into the feature environment is a real budget in production's database. For the
  same reason, a migration run from a feature branch is live everywhere the moment
  it runs: only additive, backward-compatible SQL belongs there.

### The one rule that cost six failed deploys

**Azure resolves which Static Web App a workflow may deploy to from the workflow
file's *filename*.** Under OIDC there is no token to identify the app, so the filename
is the identity. The file must stay named:

```
.github/workflows/azure-static-web-apps-wonderful-rock-071c8e810.yml
```

Consequences, all learned the hard way:

- **Do not add a second workflow file** for staging, previews or anything else that
  calls `Azure/static-web-apps-deploy`. It will fail with *"Could not determine the
  Static Web App from the GitHub OIDC workflow reference."* All four jobs live in the
  one file, guarded by `if:` on `github.ref_name`.
- **Another deploy JOB in that file is fine** — a second FILE is what cannot work.
  That is how the staging job was added, and how the `feature/**` job was added
  after it. Adding one means adding its branch to `on.push.branches` too.
- **Do not rename the file.** Not for tidiness, not ever.
- Authentication is **OIDC**, not deployment tokens. Every job needs
  `permissions: id-token: write` plus the two token-fetch steps. The `close_pull_request`
  job as generated by Azure had neither and failed on every PR close; it has them now.
  Even with them, the v1 action's *close* path drops `github_id_token` ("Unexpected
  input") and demands a deployment token, so the job stayed red on every PR close;
  `skip_deploy_on_missing_secrets: true` now makes it exit green instead. Net behavior
  is unchanged — the per-PR preview environment is not torn down either way; delete
  stale previews in the portal's Environments blade. Do not "fix" this with a
  deployment token.
- The production, staging and feature jobs are mutually exclusive on
  `github.ref_name`, so a push to `staging` reports production as `skipped`, and a
  push to `feature/**` reports both of them as skipped. Verified — neither can
  reach the live site. Check this on the Actions run the first time, rather than
  trusting it.

### Working rhythm

Push work to `staging`, click through it on the staging URL, then open a PR
`staging → main` and merge to release. That release ran on 2026-08-13 (PR #1),
so `main` and `staging` are level; `main` was then merged back into `staging`,
which is why the history has merge commits on both sides.

---

## 4 · Auth specifics

- Custom Entra provider configured in `staticwebapp.config.json`, reading
  `AAD_CLIENT_ID` / `AAD_CLIENT_SECRET` from SWA application settings.
- **Signing out federates; switching accounts does not.** `/.auth/logout` clears
  the SWA cookie *and* sends the browser to Entra's end-session endpoint, which
  is why a browser holding several Microsoft sessions is asked which account is
  signing out. There is no supported way to skip that from the app: the
  `logout_hint` parameter that suppresses it belongs to Entra and SWA composes
  the end-session request itself. **Switch Account** in the account menu sidesteps
  the question entirely by not signing out — it navigates to
  `/.auth/login/aad`, `prompt=select_account` opens the picker, and the account
  chosen replaces the session. Use it for changing account; Sign Out is still
  the only thing that ends one.
- **`app/login.html` is the sign-in screen** and the only route that allows the
  `anonymous` role (`/favicon.ico`, which it links, is the one other). An
  unauthenticated request no longer bounces straight to Microsoft: the `401`
  override redirects to `/login.html`, whose single button is
  `/.auth/login/aad?post_login_redirect_uri=…`. Three things keep it working:
  the anonymous route must sit **above** the `/*` rule (below it the page would
  itself 401 and the override would send the visitor back — a loop), the page
  must load **nothing** from the app (any `src`/`href` into the app is a 401 for
  a visitor with no session), and the post-login target is built only from this
  app's own `#/…` hash. `test/auth-routes.test.js` asserts all three.
- The page is standalone by necessity — it cannot read the account's theme or
  accent, because those live behind the sign-in it is asking for, so it follows
  the OS `prefers-color-scheme` and nothing else.
- **Sign-out already lands there**: `/.auth/logout?post_logout_redirect_uri=/`
  returns to `/`, which 401s, which redirects to the login screen.
- A deep link is a hash (`#/budget/OP-1234`), which the server never sees. The
  browser carries a fragment across the 302 to a target that has none, so the
  login page reads whatever survived and hands it back as the post-login target.
  Best-effort by design: worst case the user lands on Home.
- **Application settings are per-environment.** Production and staging each need the
  pair set. The same client ID/secret works for both — the difference is the redirect
  URI, which is per-hostname.
- A blank white page on a new environment almost always means the redirect URI is not
  registered (or has not propagated — allow ~3 minutes), not a broken build.
- The `pricing_admin` role is granted by SWA invitation, and invitations are bound to a
  hostname. If the role is missing on staging, generate a second invite selecting the
  staging hostname.
- Diagnose with `curl -sSI https://<host>/` — a 302 to `/.auth/login/aad` means the app
  is up and the guard is working. Follow the chain; if it reaches
  `login.microsoftonline.com`, the provider config is fine.

---

## 5 · Frontend architecture

### The render model

State lives in a single `doc` object. Every mutation calls a helper that re-renders the
affected tables by assigning `innerHTML`. That destroys and rebuilds the DOM, which is
the root of most of the subtle bugs here.

Three entry points, and picking the wrong one is the most common mistake:

| Call | Use when |
|---|---|
| `touch()` | A mutation changed numbers — sets dirty, re-renders, recalculates |
| `markDirty()` | An edit needs no recalculation (e.g. status change) |
| `recalc()` | Navigation-triggered redraw only — does **not** mark dirty |

### Focus preservation (`withFocus`)

Because re-render destroys the element that fired the event, tabbing across a row used
to dump focus at the top of the document. Every generated input carries a stable
`data-k` key (`units.3.sf`, `lines.41.unit`). `withFocus(fn)` records the active key,
the caret offsets and the Tab direction, runs the render, then re-finds the element by
key and restores focus — advancing one position if Tab was in flight.

**If you add an input to a rendered table, give it a `data-k`.** Without one it loses
focus on every keystroke that triggers a recalculation.

### Routing

Hash routes are `#/budgets`, `#/inputs/BD-0001`, `#/budget/BD-0001`, `#/csi`,
`#/pricing`, `#/help`. The router claims **only** hashes beginning `#/`:

```js
if(h && h.slice(0,2) !== '#/') return;
```

Plain fragments like `#help-exports` belong to the page — this is what makes the Help
page's table of contents work. Removing that guard sends every TOC link to Budgets.

### CSS scoping traps

Both of these bit once and will again:

```css
body>header { … }            /* app chrome only — a bare `header` also hits the PDF report */
@media print { body.printing > header, body.printing > main { display:none !important } }
```

The printed report builds its own `<header>` inside `#printDoc`. Unscoped selectors
either hide it or paint it dark, making the black logo invisible on white.

### Dots and alignment

The green auto-calculated dot and the blue manually-edited dot both render as a
fixed-width element that is transparent when off, so rows never shift. Do not
conditionally omit the element.

### Other conventions

- `esc()` escapes `& < > " '`. Everything interpolated into markup goes through it.
- The `collapsed` Set is keyed `"scope|grp"` and re-applied on every render, so
  collapse state survives recalculation.
- Cmd/Ctrl+S saves. It blurs the active element first so a pending edit commits.

---

## 6 · Data model and invariants

A budget document (`doc`) carries: `projectId`, `name`, `status`, `resSF`, `amenSF`,
`siteSF`, `units[]`, `other[]`, `expenses[]`, `lines[]`, `companies[]`, `contingency`,
`projectCosts`, `pricingVersion`.

Each budget line has `code` (CSI), `grp`, `scope` (`res` | `amen` | `soft`), `desc`,
`basis` (`sf` | `asf` | `unit` | `ls`), `unit`, `baseUnit`, and the flags `auto`,
`custom`, `edited`.

### Invariants that will bite you

1. **`baseUnit` is the pricing-library rate; `unit` is what the user has.** Edit
   detection compares the two — overwrite `baseUnit` on an edit and the blue dot
   silently stops working.

2. **Amenity suppression must affect the arithmetic, not just the display.** When
   `amenSF` is 0 there is no amenity building, so `scopeActive('amen')` is false and
   `scopeSum` returns **0** for it. Hiding the rows while still summing them was the
   original bug: lump-sum and manual-quantity amenity lines do not follow `amenSF` to
   zero, so a $250k lump sum stayed in the contract sum invisibly.

3. **Insert new lines next to their group; never append.** `renderBudget` starts a new
   heading whenever `grp` changes, so an appended line produces a *duplicate* group
   heading further down the table. Use `insertLine()`.

4. **A line added into a collapsed group is invisible.** Call `revealLine(scope, grp)`
   after inserting, or the user sees the button do nothing.

5. **Exports are built from the data model, never from the screen.** `buildReport()`
   and `exportExcel()` walk `doc.lines`. The earlier PDF printed the DOM, so a
   collapsed grid truncated the report to three rows out of 208.

6. **Contract sum ≠ total project cost.** Land and project costs sit outside the
   contract sum (DATA_CONTRACT rule 3). Contingency is carried explicitly as CSI
   `99 03 00` in the markups division (rule 2).

7. **Project IDs are `OP-####` / `BD-####` / `AS-####` / `TST-####`,** validated in
   *four* places that must change together: `app/index.html` (`ID_RX`),
   `api/budget/index.js`, `api/budget-versions/index.js`, and `test/mock-api.js`.

8. **`TST-` budgets share the production database.** They render an amber TEST badge
   and banner. `sql/views.sql` now excludes them from the reporting views.

9. **Array positions are not row identity.** Every budget line carries a stable
   `lineId`, persisted as `SovLines.LineKey`. Selection, `data-k` focus keys, code
   editing and batch deletion all key off it — a code edit moves a line between
   groups and a batch delete shifts every index below it.

10. **Deletion is a soft flag.** `DELETE` sets `IsDeleted`; history survives and a
    `PUT` on the same project ID restores. The app has no hard delete —
    `sql/purge_deleted_budgets.sql` is the admin recycle-bin empty.

---

### Investment-analysis invariants (added 2026-08)

- **The engine lives on the server only** (`api/shared/investment/`), version-stamped
  `before-tax-1.1.0` (five- or ten-year horizon). The browser posts assumptions and renders results; a save
  recalculates server-side and ignores any client-supplied result. Never port the
  formulas into the frontend — that recreates the drift problem the design avoids.
- **Old analysis versions are never recalculated.** Each records its calculation
  version; changing formulas means a new version string, and history stays as saved.
- **The analysis hash covers `{rawInput, sourceBudgetVersionId, calculationVersion}`**
  via the shared canonical JSON. Do not change `api/shared/canonical.js` defaults —
  budget hashing depends on them byte-for-byte.
- **Analysis routes carry GUIDs.** `routeFromHash` handles `#/analysis/{guid}` before
  the uppercase/ID_RX budget path — a GUID must never be uppercased or fed to
  `openBudget`.
- **`FSInvestmentUI` talks to `index.html` only through the adapter** passed to
  `init()`. Reaching into inline-script internals from the module (or vice versa)
  is the coupling the external-module decision exists to prevent.
- **The leverage line displays the difference of the two displayed two-decimal
  IRRs** (13.67 − 9.80 = 3.87), matching the recovered reports; the engine keeps
  full precision internally. `test/investment-calculations.test.js` pins both.
- **The prefill invents no market assumptions.** Purchase month, expense ratio,
  and exit cap arrive empty on purpose; imported service expenses are supporting
  reference only. Warnings in the UI say so — keep them.

## 7 · Running the tests

**Export rendering (fs-courier cutover).** Rendering now belongs to **fs-render**,
fs-courier's engine, consumed two ways: the browser vendors the esbuild bundle
`app/vendor/fs-render.browser.js` (global `fsRender`) and the API requires the
VENDORED SOURCE at `api/shared/fs-render/` (source of truth:
Finishes-Solutions/fs-courier — update by re-copying `engine/src` + rebuilding the
bundle; the copy's package.json records the pinned commit). The root package.json
maps the `fs-render` name to that vendored copy so tests need no sibling checkout.
The suite keeps the PRODUCER side: `export-render.js` (buildExportDoc — content —
plus `appendApprovalPage`, the Signature Needed page fsdoc/1 deliberately omits,
appended onto the finished docDefinition) and `to-fsdoc.js` (adapts the doc to the
fsdoc/1 contract). Both producer files exist twice (app/ and
api/shared/investment/) and MUST stay byte-identical — `test/export-render.test.js`
fails on drift. The budget is the second producer: `buildBudgetFsdoc()` in
app/index.html emits fsdoc/1 directly (columnar `table` blocks; group heads carry
scope/group subtotals). Orientation policy: PDFs are portrait letter EXCEPT
ten-year projections, whose 11 matrix columns need the `landscape` preset (the
engine's stated rule). Content changes belong in the producers; the engine only
formats; nothing recalculates.

**Renderer fallback (`FS_EXPORT_RENDERER`).** The pre-cutover renderers survive,
frozen, in `legacy-render.js` (dual-copied and parity-tested like the producers;
the budget's legacy producer is `legacyBudgetPdfDoc()` in app/index.html). The
SWA application setting `FS_EXPORT_RENDERER` — `engine` (default) or `local` —
flips EVERY export to them; `GET /api/export-config` serves the value to the
browser at boot. Overrides: `localStorage.setItem('fsExportRenderer','local')`
flips one browser (remove the key to restore), and `&renderer=local|engine` on
the export endpoint flips one request. Repair playbook: set the app setting to
`local`, fix fs-render, flip back. Do not evolve the legacy files — new export
work happens in the producers and fs-render. The Download Guide button also renders
through the engine (`guideFsdoc()` adapts the live help DOM to fsdoc/1); its
pre-engine print pipeline (`printGuide()`) is the guide's `local` fallback.

**App-shell conveniences.** Every displayed timestamp is the viewer's LOCAL time as
`MM-DD-YYYY h:mm AM/PM` (`fmtWhen`; 24-hour when the account says so) or
`MM-DD-YYYY` (`fmtDay`) — helpers exist in app/index.html, the investment module,
and the producers (`fmtStamp` inside export-render.js / to-fsdoc.js;
meta.generatedAt stays raw ISO). Cmd/Ctrl+K opens the global search palette
(budgets + analyses, fetched fresh per open). The analyses lists carry the same
search/status/grouping controls and styling as the budget list. The two Home
tables share a column system (`--lt-status`/`--lt-updated`/`--lt-actions` tokens,
`table-layout:fixed`, identity columns totalling 42% in both) so Status, Updated,
and the action column align vertically across the cards; budget columns run
`ID | Name | Status | Contract Sum | Total Project Cost | Updated | ⋮`, analyses
`Analysis | Project / Budget | Status | metrics… | Analysis Ver. | Updated | ⋮`
(the linked budget version renders subdued as "Budget vN", distinct from the
analysis's own version count). Creation is one button per section: `+ New
Budget` opens the template modal (Multifamily and Blank live, Industrial/Retail/
Mixed-Use visible-but-disabled, custom templates from the template system), and
`+ New Investment Analysis` — on Home AND the analyses tab — opens one shared
modal (From Existing Budget picker + Standalone with optional name). The budget
editor no longer carries a Create Investment Analysis button. The stale-pricing
banner is dismissible per budget (in-memory ×); the persistent reprice path is
the Home row menu's Update Pricing, which confirms when already current.

**Per-account settings (`dbo.Users` / `dbo.UserActivity` — sql/migrate_users.sql).**
Settings belong to the ACCOUNT, not the browser: `GET /api/user-settings?boot=1`
bootstraps at app start (upserts the row, refreshes LastSeenAt, counts a login
after a 30-minute quiet gap) and `PUT` saves profile fields (display name — shown
in the header and menus over the platform name, defaulting from the sign-in
identity — and phone; EMAIL IS LOCKED to the signed-in account and maintained
server-side by ensureUser, never client-set) plus one validated JSON settings
document: theme (light/dark), timeFormat (12h/24h), accentColor (named
green/blue/violet/graphite/red/orange via `html[data-accent]` with dark+accent
combo blocks, OR a #rrggbb custom accent whose light/dark scales the client
derives in accentScale() and applies as inline tokens), avatarColor (preset
swatches or any custom hex → the header icon's `--avatar-bg`), tableDensity
(comfortable/compact via `html[data-density]` — compact meaningfully compresses
rows, badges and row menus), budgetView + analysisView (each
'comfortable' | 'compact' | 'cards' — per-SECTION views; the density attribute
sits on each section's card, cards use `.home-cards`/`.hcard`; legacy
homeView/tableDensity documents map forward in the contract), rememberExport
(a switch) + exportOptions (per-product export-modal defaults), and themePack
(see below). Each list's toolbar carries the same three-way `.mini-seg` toggle,
sharing the Settings buttons' data attributes so one paint marks both.

**Theme packs (`themePack`, super_admin only).** A pack is an alternate visual
PRESENTATION of the same product — paint and nothing else. `default` is the
Finishes Solutions appearance; `ramp` is the Editorial pack in
`app/theme-ramp.css`, whose every rule is scoped to `html[data-skin=ramp]`, so
with no pack selected the file cannot affect a single pixel. The stylesheet is
linked AFTER the inline `<style>` block on purpose: it is meant to win an
equal-specificity tie on order, which is what keeps its selectors flat instead
of inflated. The pack works by remapping the EXISTING tokens (`--ink-*`,
`--green-*`, `--r`, `--sh`, `--focus`, `--fb`) plus targeted primitive
overrides, so every stylesheet in `app/` follows it without a page-level color.
The ROLE decides whether a stored pack is painted (`themePackAllowed()`), not
the stored value — an account that loses super_admin stops seeing the pack
without its setting being rewritten. A pack owns its whole palette, so
`applyAccent()` stands down while one is active and repaints the account's
accent the moment it is switched off. `beforeprint` strips `data-skin` next to
`data-theme`, so an export never inherits a preview appearance. Adding a pack
is: a value in the contract's `THEME_PACKS`, a scoped stylesheet, and a button
in Settings — never a schema migration.

The Editorial pack's Home field is two pseudo-elements on `#page-home` (not on
the hero): a fine 18px lattice and a coarser 31px one, drifting in opposite
directions by exactly one of their own tiles so each loop is seamless, plus
soft clearings painted in the canvas colour that thin the field out in places
so it does not read as wallpaper. Movement is a composited transform — never
an animated `background-position` — so nothing repaints per frame. The drift
is vertical ONLY: a horizontal drift would need the layer to overhang
sideways, and a full-bleed decoration that overhangs is a horizontal
scrollbar. Both layers are `pointer-events:none`, sit at a negative z-index
under `isolation:isolate`, and go static under `prefers-reduced-motion` and on
phones.

**Statuses.** One shared model for budgets AND analyses: Draft · In Review ·
Completed · Cancelled (STATUS_LIST/normStatus/statusChip in app/index.html;
legacy 'Finalized' displays as Completed and rewrites on next edit). The chip
is editable everywhere — list rows, cards, the budget editor's Status select,
the analysis editor's chip — via a status-only PUT on both endpoints
(`{status}` with no doc/input) that updates the row WITHOUT recording a
version; full saves version exactly as before. The validation contract lives
dependency-free in api/shared/user-settings-contract.js and is required by BOTH
api/shared/users.js and test/mock-api.js, so it cannot drift. localStorage keeps
pre-paint caches (fsTheme/fsAccent/fsDensity/fsAvatar/fsTimeFormat) that the
server copy overwrites at boot. Activity is append-only and best-effort
(recordActivity never throws): logins and settings changes from the settings
endpoints, budget_save/analysis_save from the save endpoints, export_* posted by
the client through `POST /api/user-activity` (whitelisted events only);
`GET /api/user-activity` returns the account's recent timeline. A
beforeprint/afterprint hook still forces the light palette for printing;
`--chrome`/`--solid` remain the surfaces that stay dark in every theme and accent.

Fifteen Playwright suites, 617 assertions, plus 80 `node:test` assertions for the
pure logic that needs no browser — all passing as of this commit. The browser suites drive
the real frontend against a mock of the SWA API (`test/mock-api.js` — serves the static
app, `/.auth/me`, the budget/versions/pricing routes from an in-memory store plus
`test/pricing.json`, and mirrors soft-delete and no-op-save semantics).

`node --test test/*.test.js` covers canonical JSON and content hashing, the SOV
projection, and the calculation audit against the MF workbook. `run-all.sh` runs it
first when invoked with no arguments.

```bash
./test/run-all.sh          # everything
./test/run-all.sh 03 08    # only suites 03 and 08
```

Environment overrides, all optional:

| Variable | Purpose |
|---|---|
| `CHROMIUM_PATH` | Chromium binary, if Playwright's own copy is not present |
| `APP_DIR` | Frontend directory to serve (defaults to `app/`) |
| `OUT_DIR` | Where screenshots land (defaults to the system temp dir) |
| `NO_API=1` | Kill every API route — how the offline banner is exercised |

The runner starts two mocks: port **8099** with `NO_API=1` (suite 01 asserts the
offline banner and the built-in pricing fallback) and port **8100** live. It restarts
the live mock between suites, because several suites seed budgets and assert exact row
counts — state carried between suites produces false failures.

| Suite | Covers |
|---|---|
| 01 | Offline banner, routing, focus retention, collapse, ID validation |
| 02 | Save/load round-trip, home list sort + filter, status, reprice, export wiring |
| 03 | PDF report composed from the data model (collapse cannot truncate it) |
| 04 | Passcode is hashed — no plaintext in the served source |
| 05 | Blank budget type |
| 06 | Header logo and single-line header at several widths |
| 07 | Help TOC scrolls within the guide, never navigates away |
| 08 | Amenity suppression arithmetic |
| 09 | Cmd/Ctrl+S, including with no budget open |
| 10 | Group selector, editable CSI codes and group movement, batch selection and deletion |

Suite 02 also covers the three-dot actions menu and read-only version history; suite 08
covers division header totals, percentage denominators and the zero-contract em dash.

The suites assert against **visible button text**, so a Title Case pass or a moved
field breaks selectors. That is intentional — it catches copy drift — but expect to
update selectors alongside label changes.

---

### Guard rails, projects and derived underwriting (added 2026-08)

- **`app/guardrails.js` and `api/shared/guardrails.js` are byte-identical.**
  `test/guardrails.test.js` fails the build if they drift. Copy one over the
  other; never "fix" one side.
- **`evaluate()` never recomputes `parts()` or `grossIncome()`.** It takes them
  as arguments. There are already exactly two implementations of that
  arithmetic (the browser CALC block and `api/shared/budget-calc.js`); a third
  would be a third thing to keep in parity.
- **Two rules keep block-on-save survivable, and both look removable.**
  A rail whose denominator is zero is *not evaluated* — a blank budget cannot be
  blocked. And `opexRatio` blocks only when `doc.opexSchemaVersion >= 2`, because
  every budget that predates this release sits at ~9% of income and would
  otherwise become unsaveable the moment the code shipped.
- **An override is a record.** `doc.guardrailAcks` carries a mandatory reason,
  who, and when; it downgrades the rail to a warning, prints on the PDF and the
  Excel workbook, and is pruned automatically once the value is back in range.
  Gated to `director` / `super_admin` — a rail anyone can wave through is not
  a rail.
- **`feeOf(k)` is `nz()` for the fee object.** `doc.projectCosts.dev` can be
  absent on an old document, and `undefined.mode` is a TypeError exactly as
  absent arithmetic is `$NaN`. Every read goes through `feeOf()`, which repairs
  in place. Suite-08 (the strip-every-numeric suite) is what catches this.
- **A percentage fee is a share of the FINAL total**, solved in closed form
  (`project = (base + fixedFees) / (1 − f)`), not of a smaller pre-fee base.
  Changing that convention changes what "3% developer fee" means on every
  export, so it is documented in `docs/DATA_CONTRACT.md` rather than left to
  whoever next opens `parts()`.
- **A project id is `OP-####`; a NEW budget is minted `BDG-####-##`** with the
  project's own digits (`BDG-2108-01`, then `-02`). Two namespaces, and keeping
  them apart is the point. Project identity used to be *borrowed* from a
  budget — the project row for `BD-0002` was literally keyed `'BD-0002'` and
  alternates were attributed by stripping the suffix — which is why the Projects
  list showed `BD-…` in its PROJECT ID column.
  `sql/migrate_project_op_ids.sql` re-keyed the existing rows and
  `sql/widen_project_op_ids.sql` widened them to four digits;
  `dbo.ProjectIdMap` is the permanent record of what moved, and the input to
  `sql/rollback_project_op_ids.sql`. Legacy `BD-`/`OP-`/`AS-` budgets are never
  renamed and keep numbering their alternates the old way.
- **A `BDG` id's `-01` is its ITEM number, not an alternate marker** — the
  first budget of project 2108 is `BDG-2108-01`. Only a suffix **other than**
  `-01` marks an alternate (`isSiblingItem` / `isAlternate`); on legacy
  `BD-####` any suffix still does. Even so, the digits in a budget id prove
  nothing: which project a budget belongs to is `dbo.Budgets.ProjectKey`, an
  explicit link stated when the budget is created. Moving a budget between
  projects is an edited column, not a new id.
- **A project is created deliberately.** Saving a budget no longer conjures its
  parent, because a budget id cannot name one. `+ Create Project` on the
  Projects page is the only way in, and it asks for ID, Name and Address — all
  three required, uniqueness decided by `PK_Projects`, not by a pre-read.
- **A project has no type.** One property can carry a Multifamily budget and a
  Commercial budget at once, so type lives on each budget and the project
  reports the distinct types its budgets are.
- **Exactly one primary budget, and the project's money is its alone.**
  `PrimaryBudgetId` is one scalar column, so Make Primary promotes and demotes
  in a single write. The project's live money is a `TOP 1` on that budget,
  never a `SUM` across alternates.
- **Converting a project snapshots its money.** `ContractAmount` /
  `ProjectAmount` are frozen at conversion so reported backlog does not move
  when someone edits a budget afterwards. Anything reporting converted totals
  reads those columns, never a live join.
- **The project surface is query scopes on endpoints that already deploy.** A
  route rule matches paths, not query strings, so the in-function check on
  `?scope=projects` / `?scope=project` / `?scope=next-project-id` /
  `?scope=next-budget-id` is the *only* gate — same warning that
  applies to `/api/user-settings?scope=roles`.
- **`api/shared/investment/from-budget.js` is used by creation AND re-sync.**
  If they derived separately, re-syncing would quietly change numbers that were
  never wrong.

## 8 · Outstanding

**Security, do first**

- **Rotate the SWA deployment token.** It was pasted into a chat transcript. The
  workflow authenticates over OIDC and does not need it — after rotating, delete the
  `AZURE_SWA_DEPLOYMENT_TOKEN` secret from the repository entirely.

**Correctness**

- ~~Blank numeric inputs render `$NaN`.~~ Fixed. The diagnosis in this list was wrong:
  clearing a numeric field yields `0`, not `NaN`. The real trigger is an *absent*
  property, which is what an older saved document looks like. `nz()` coerces at the
  formatters and at every arithmetic source, and `migrate()` repairs numerics on load.
- **Production runs the pre-versioning API against the migrated database.** Its
  delete button fails until `staging` is released, because the old hard delete is
  blocked by the new `BudgetVersions` foreign key. Nothing is lost; it fails cleanly.
- Publishing a template is the only way to change new-budget defaults. Do not hand-edit
  `DEFAULT_PRICING` in `app/index.html` and expect it to matter — it is the offline
  fallback only (docs/DATA_CONTRACT.md, "Single source of truth").

**Database state — every script below has run (latest: 2026-08-24)**

- `sql/migrate_projects_and_guardrails.sql` — all eight verification rows PASS.
  Five projects backfilled from the existing budgets, zero unlinked budgets,
  zero unlinked analyses, zero orphans, both foreign keys in place.
- `sql/publish_multifamily_opex_template.sql` — all four PASS. The multifamily
  template is now **v3**, carrying `opexSchemaVersion: 2` and all sixteen
  expense rows; v2 is retained, because publishing is append-only.

  Consequence worth knowing: budgets created from **v3 onward** are judged by
  the 35–55% expense rail and **blocked** when they fall outside it. Every
  budget that predates v3 sits at `opexSchemaVersion: 1` and is **warned**, not
  blocked, until someone runs *Update Expense Schedule* on it from the Guard
  Rails card.

  The rates in v3 are the ones this release proposed, not a reviewed house
  standard. They land the template at 46.2% of income against its own unit mix.
  Whoever owns the underwriting standard should review them and republish —
  editing the script and re-running it publishes v4; nothing is overwritten.

- `sql/migrate_project_op_ids.sql` then `sql/widen_project_op_ids.sql` — the
  seven existing projects were re-keyed from borrowed budget ids to
  `OP-0001` … `OP-0007`. `dbo.ProjectIdMap` records every one of them, and is
  what `sql/rollback_project_op_ids.sql` reverses from. The same batch backfilled
  `PrimaryBudgetId`, rewrote the project ids held inside `Users.SettingsDoc`
  favourites and `UserActivity`, and added `UX_PricingLibrary_Current` so "the
  current pricing library" is a database-enforced singleton.

  Run order for a fresh database: `schema.sql` already describes the OP-####
  end state, so only an EXISTING database needs the two migrations, in that
  order.

  **Applied 2026-08-22.** The seven projects are now `OP-0001` … `OP-0007`,
  each keeping its primary budget and its children:

  | Project | Was keyed as | Name | Status | Primary budget |
  | --- | --- | --- | --- | --- |
  | OP-0001 | BD-0001 | — | Lead | BD-0001 |
  | OP-0002 | BD-0002 | — | Budgeting | BD-0002 |
  | OP-0003 | BD-2519 | Greenville Townhomes | Awarded | BD-2519 |
  | OP-0004 | TST-9999 | Greenville Townhomes | Awarded | TST-9999 |
  | OP-0005 | BD-4821 | Jones Rd Apartments | Proposal Sent | BD-4821 |
  | OP-0006 | BD-9999 | Test Project 3 | Lead | BD-9999 |
  | OP-0007 | BD-2108 | BD-2108 | Lead | BD-2108 |

  Note the budget ids: they were NOT renamed, and several keep prefixes that
  are no longer minted (`TST-`, and `BD-` numbers unrelated to their project's
  `OP-` number). That is deliberate — renaming a budget would cascade into
  SovLines, BudgetVersions and every analysis's provenance for no gain.

- `sql/align_project_numbers.sql` then `sql/adopt_project_numbers.sql` — the
  identifier-model pair (PROJECT_NUMBERS_GUIDE.md): projects renumbered to
  match their budgets, then `ProjectNumber` surfaced as a persisted, unique,
  indexed column with per-project `ItemNumber` on analyses. The app probes for
  these columns (`projectsNumber`, `analysesItemNumber`) and behaves as before
  until both the columns and the release are present, so deploy order is safe
  either way.

  **Applied 2026-08-24**, all verification rows PASS. Three projects moved —
  `OP-0003` → `OP-2519`, `OP-0005` → `OP-4821`, `OP-0007` → `OP-2108` — and
  two mismatches stand deliberately: `OP-0004` keeps test budget `TST-9999`,
  and `OP-0006` (primary `BD-9999`) could not take 9999 because a live test
  project already holds `OP-9999` — the script skips rather than collides.
  Deleting that test project and re-running the align script would move it;
  nothing depends on it either way. `dbo.ProjectIdMap` tracks the re-keys, so
  rollback still works from the *current* ids.

**Housekeeping**

- **The `Close Pull Request Job` fails on every PR close, and per-PR preview
  environments are therefore NOT torn down.** They accumulate and need deleting by
  hand in Azure Portal → SWA → Environments. The earlier note here said the job was
  fixed; it was not, and the real cause is now known. From the failing run's log:

  ```
  Unexpected input(s) 'github_id_token', valid inputs are [... 'azure_static_web_apps_api_token' ...]
  deployment_token was not provided.
  ```

  `Azure/static-web-apps-deploy@v1` does not accept `github_id_token` on the
  **close** action, so it falls back to wanting a deployment token — which this
  repository deliberately does not have (auth is OIDC; the old token was rotated out
  and must not come back). The deploy jobs are unaffected and succeed under OIDC.

  There is no clean fix without reintroducing a deployment token. Adding
  `skip_deploy_on_missing_secrets: true`, which the action's own error suggests,
  only turns the run green — the preview is still not deleted, so it trades a
  visible problem for a silent one. Left failing on purpose. Do not "fix" it by
  adding a token.

**Deferred UI work**

- Icon buttons other than the Budgets-list actions menu still lack `aria-label`; the
  three-dot menu and the budget line remove buttons now have them.
- Tablet and mobile are fully capable: the read-only mode was removed, and the
  `@media(max-width:760px)` blocks reflow the layout (panning tables, one-column
  grids, scrolling tab bar). Suite-06 pins overflow-free rendering at 390px.
- The Excel workbook specifies **Montserrat**. Machines without it substitute silently.
  Switching to a guaranteed font is a one-line change in `BRAND` if that becomes a
  problem.

---

## 9 · House style for changes here

- **Update `CHANGELOG.md`.** Every change that reaches `staging` gets an entry,
  written for a person: what they will notice, what breaks, and which SQL has to
  run. It is the first file to read when something behaves differently from
  yesterday, and the only one that answers "do I need to run anything".
- **Title Case** for interface labels, buttons, tab names and headings: capitalize
  important words; keep *a, an, the, and, but, or, for, nor, at, by, in, of, on, per,
  to, up, via* lowercase unless first or last. Preserve brand names, product names and
  acronyms. Do **not** Title Case sentence-style descriptions, paragraphs, toasts or
  error messages — those stay sentence case.
- Never rename variables, functions, database fields, API properties, routes or files
  in the course of a copy change.
- Match the surrounding code: no build step, no framework, inline handlers, terse
  helpers. Comments explain *why*, not what.
- Test on the staging URL before opening the release PR.
