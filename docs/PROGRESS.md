# PROGRESS — budgeting-v2 upgrade

**Branch:** `upgrade/budgeting-v2` (from `staging`). **Last updated:** 2026-10-24.
Read this first in a new session, then `docs/DECISIONS.md`, then `CLAUDE.md`.

## Status by phase

| Phase | State |
|---|---|
| 0 Setup & safety net | Branch created; pro forma goldens committed (7 deals, `test/proforma-golden.test.js`); `feature` merged; CLAUDE.md hard rules added |
| 1 Audit | DONE — `docs/AUDIT.md` |
| 2 Research | DONE — 94 types, 144 blocks, 1,025 evidence items; `docs/RESEARCH.md` (generated coverage + summaries) |
| 3 Engine design | DONE — `docs/BUDGET_ENGINE.md` |
| 4 Engine build | DONE — `app/budget-engine.js`, `test/budget-engine.test.js` (22 tests), pro forma handoff by scope |
| 5 UI | DONE — workspace, detail, scenarios, sensitivity, exports, project files; `test/suite-23.js` (41 checks); axe WCAG 2.1 AA clean (22 states, light+dark); `docs/screenshots/` |
| 6 Samples | DONE — 16 samples in `docs/sample-output/` (`node tools/run-samples.js`) |
| 7 Second research pass | DONE — soft-cost definitions aligned (27 types), fee norms → NAHB 2024, glamping/equestrian evidence, range calibrations |
| 8 Verify & merge | not started |

## How to run things

- Node deps: `npm ci` (root) and `cd api && npm ci`.
- Logic tests: `node --test test/*.test.js`. Browser suites: `./test/run-all.sh` (all) or `./test/run-all.sh 07`.
- Research: `node tools/validate-research.js` then `node tools/build-research-data.js`.

## Where things are

- Research: `data/research/**` (schema in its README) → `node tools/build-research-data.js` → `app/research-data.js`.
- Engine: `app/budget-engine.js` (pure UMD). Tests on a synthetic bundle: `test/fixtures/engine-data.js`.
- UI: `app/budget-v2.js` + `.css`, wired in `app/index.html` (search `FSBudgetV2`, `paintEngineMode`, `classic-only`).
- Handoff: `api/shared/investment/from-budget.js` `engineProjection()`; scope rides in `input.source.scope`.
- Agent research notes (weak spots, missing types): copied into `docs/RESEARCH.md` when written.

## Next

1. Phase 8: syntax check, full node + browser test run, code-review (high), security-review, simplify; fix; re-run.
2. Retake screenshots after review fixes (`BASE=… node tools/take-screenshots.js`), re-run samples.
3. Merge `upgrade/budgeting-v2` → `staging` (normal merge) and push.

## Known issues / blocked

- FIXED: `test/suite-07.js` TOC scroll (smooth scroll on the now-longer help page took >750 ms; the test now waits for scrolling to settle). `test/suite-02.js` date fixture was time-zone dependent (now noon UTC).
- BLOCKED (worked around): the `design:accessibility-review` and `design:design-system` skills fail to load ("Unknown command"). Substitute: `tools/a11y-audit.js` (axe-core, WCAG 2.0/2.1 A+AA rules) — all estimate screens pass; design reviewed manually against the vendored Finishes Solutions tokens (the finishes-solutions-design skill did load).
- Pre-existing, outside v2 scope: the app-wide dark theme's `--ink-500` label colour is 4.4:1 on cards (below AA for small text). v2 remaps it inside its own scope; the owner may want the same fix app-wide.
- Research agents hit a shared 200-call web-search cap mid-run; many values are derived (see `docs/RESEARCH.md` → Weakest areas).

## Things I need to do (owner)

- Decide whether `claude/budgeting-suite-expansion-lwuc2e` (entities/financials/contracts, 3 migrations) should go to staging — not merged by this upgrade (D4).
