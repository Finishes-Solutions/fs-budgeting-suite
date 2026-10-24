# PROGRESS — budgeting-v2 upgrade

**Branch:** `upgrade/budgeting-v2` (from `staging`). **Last updated:** 2026-10-24.
Read this first in a new session, then `docs/DECISIONS.md`, then `CLAUDE.md`.

## Status by phase

| Phase | State |
|---|---|
| 0 Setup & safety net | Branch created; pro forma goldens committed (7 deals, `test/proforma-golden.test.js`); `feature` merged; CLAUDE.md hard rules added |
| 1 Audit | DONE — `docs/AUDIT.md` |
| 2 Research | DONE (first pass) — 94 types, 144 blocks, 1,017 evidence items; `docs/RESEARCH.md` still to write |
| 3 Engine design | DONE — `docs/BUDGET_ENGINE.md` |
| 4 Engine build | DONE — `app/budget-engine.js`, `test/budget-engine.test.js` (22 tests), pro forma handoff by scope |
| 5 UI | IN PROGRESS — workspace, detail, scenarios, sensitivity, exports working; browser suite, a11y review, screenshots to do |
| 6 Samples | not started |
| 7 Second research pass | not started |
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

1. `test/research-data.test.js` (bundle fresh, splits 100%, every type within its range check) — bank-branch and sports-complex currently land slightly above range.
2. Browser suite for v2 (`test/suite-23.js`), screenshots to `docs/screenshots/`, accessibility review.
3. Phase 6 samples (`tools/run-samples.js` → `docs/sample-output/`).
4. `docs/RESEARCH.md`, second research pass (Phase 7), README/user docs, CHANGELOG.
5. Phase 8 verification + reviews + merge.

## Known issues

- `test/suite-07.js` "every TOC link scrolls to its section" fails on the merged `feature` base before any upgrade change (pre-existing). Must be fixed before Phase 8.

## Things I need to do (owner)

- Decide whether `claude/budgeting-suite-expansion-lwuc2e` (entities/financials/contracts, 3 migrations) should go to staging — not merged by this upgrade (D4).
