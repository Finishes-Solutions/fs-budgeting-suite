# PROGRESS — budgeting-v2 upgrade

**Branch:** `upgrade/budgeting-v2` (from `staging`), merged into `staging`.
**Last updated:** 2026-10-24. Read this first in a new session, then
`docs/DECISIONS.md`, then `CLAUDE.md` / `AGENTS.md`.

## Status by phase

| Phase | State |
|---|---|
| 0 Setup & safety net | DONE — branch, tracking docs, CLAUDE.md hard rules; pro forma goldens frozen before any change (7 deals, `test/proforma-golden.test.js`); `feature` merged (D3); `claude/budgeting-suite-expansion` deliberately not merged (D4) |
| 1 Audit | DONE — `docs/AUDIT.md` |
| 2 Research | DONE — 94 project types, 144 building blocks, shared norms, indices; 1,025 sourced evidence items (`data/research/`, `docs/RESEARCH.md`) |
| 3 Engine design | DONE — `docs/BUDGET_ENGINE.md` |
| 4 Engine | DONE — `app/budget-engine.js` (pure, integer cents); pro forma handoff by project / component / phase |
| 5 UI | DONE — estimate workspace (quick, mixed-use + shared + phases, custom builder), detail with per-line overrides and sources, draws, scenarios, sensitivity, Excel/PDF, project files, help + `docs/ESTIMATES_GUIDE.md`, `docs/screenshots/`; axe-core WCAG 2.1 AA clean |
| 6 Samples | DONE — 16 samples in `docs/sample-output/` |
| 7 Second research pass | DONE — see `docs/RESEARCH.md` → Second pass |
| 8 Verify & review | DONE — syntax check, node tests, all browser suites, code review (10 findings fixed), security review (no findings), simplify (four reviews applied) |

## How to run things

- Install: `npm ci` (root) and `cd api && npm ci`.
- Checks: `npm run check` (syntax of every script, research validation, bundle freshness).
- Logic tests: `npm test` (`node --test test/*.test.js`). Browser suites: `./test/run-all.sh` (or `./test/run-all.sh 23`).
- Research: `node tools/validate-research.js` → `node tools/build-research-data.js` → `node tools/research-coverage.js`.
- Samples: `node tools/run-samples.js`. Screenshots / accessibility: start `PORT=8111 node test/mock-api.js`, then
  `BASE=http://127.0.0.1:8111 node tools/take-screenshots.js` and `… node tools/a11y-audit.js`.

## Where things are

- Research data `data/research/**` (schema in its README) → bundle `app/research-data.js` (generated, loaded on demand).
- Engine `app/budget-engine.js`; UI `app/budget-v2.js` + `.css`, wired in `app/index.html` (`FSBudgetV2`, `paintEngineMode`, `.classic-only`).
- Pro forma handoff `api/shared/investment/from-budget.js` `engineProjection()`; scope in `input.source.scope`.
- Budget math spec `BUDGET-SYSTEM.md` §18 (copied to `api/shared/budget-system.md`).

## Things I need to do (owner)

1. **Migrations: none.** Everything rides in the budget JSON document; no SQL to run.
2. **Review the weakest research** before relying on those types — `docs/RESEARCH.md` → "Weakest areas". In short:
   all CSI splits but two are derived; multifamily and non-residential impact fees are national (Duncan 2019) and
   likely high — use the Impact Fees step for real jurisdictions; financing spreads/LTC are derived; hotel defaults
   hinge on one 0.91 factor; glamping, equestrian, vertical farm, co-living/student per bed, BTR attached, modular,
   manufactured-home community, cabins/containers, boat ramp, renovation, IOS, truck/boat-RV storage, food hall,
   driving range, FEC, auto dealership, brewery and winery are low-confidence types.
3. **Decide on `claude/budgeting-suite-expansion-lwuc2e`** (entities, financials, approval, contracts — three
   migrations). Not merged (D4).
4. **Optional app-wide fix:** the dark theme's `--ink-500` label colour is 4.4:1 on cards (below AA for small text)
   across the classic pages. v2 remaps it inside its own scope; the same one-line token change would fix the rest.
5. **Promote to production** when ready: a `staging` → `main` pull request (never pushed by this work).
6. The `design:accessibility-review` / `design:design-system` skills would not load in this environment; an
   axe-core audit was used instead (D21). Re-run those skills if they become available.

## Honest summary

**Solid**
- The engine: integer-cent arithmetic; component, phase and project totals add up exactly; every one of the 94 types
  prices inside its researched range at typical size and ties to the classic budget arithmetic to the cent; edge
  cases (zero/huge sizes, missing inputs, empty phases, unknown types/regions, stale overrides) are tested.
- The pro forma engine is untouched: its seven golden deals reproduce exactly. Estimates reach it only through
  `from-budget.js`, per project, component or phase.
- Estimates save, version, export and feed the lender SOV like any budget; classic Multifamily/Blank budgets are
  unchanged (all pre-existing browser suites pass).
- Provenance: every line says whether it is sourced, derived, computed or edited, and links to its evidence.
- Strongest research: garden/wrap/podium/high-rise multifamily, LIHTC, single-family, select/full-service and
  extended-stay hotels, office, office TI, retail pad/QSR, restaurants, warehouse, data center, solar, parking
  garage, RV park, fire station, construction durations (Census), escalation (Turner) and regional factors (DoD).

**Weak or derived** — see "Things I need to do" #2 and `docs/RESEARCH.md`. 36 of 94 baseline hard costs are
classed as sourced; the rest are reasoned from cited comparables and labelled "derived estimate — verify" in the app.
The research agents hit a shared web-search cap partway through; a further targeted pass on the low-confidence types
would raise coverage the most.

**Recommended next steps**
1. A targeted research pass on the low-confidence types and the derived CSI splits (public bid tabs and
   elemental estimates), and state-level impact-fee factors.
2. Add the commonly requested types listed in `docs/RESEARCH.md` (condo tower, police station, district schools,
   wind, food processing, …).
3. Researched revenue/operating norms per type, so the pro forma handoff can pre-fill income (today it is user input).
4. Owner review of `docs/sample-output/` against real recent bids.
