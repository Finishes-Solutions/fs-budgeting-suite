# PROGRESS — budgeting-v2 upgrade

**Branch:** `upgrade/budgeting-v2` (from `staging`). **Last updated:** 2026-10-24.
Read this first in a new session, then `docs/DECISIONS.md`, then `CLAUDE.md`.

## Status by phase

| Phase | State |
|---|---|
| 0 Setup & safety net | Branch created; pro forma goldens committed (7 deals, `test/proforma-golden.test.js`); `feature` merged; CLAUDE.md hard rules added |
| 1 Audit | in progress |
| 2 Research | 15 sub-agents writing `data/research/**` |
| 3 Engine design | not started |
| 4 Engine build | not started |
| 5 UI | not started |
| 6 Samples | not started |
| 7 Second research pass | not started |
| 8 Verify & merge | not started |

## How to run things

- Node deps: `npm ci` (root) and `cd api && npm ci`.
- Logic tests: `node --test test/*.test.js`. Browser suites: `./test/run-all.sh` (all) or `./test/run-all.sh 07`.
- Research: `node tools/validate-research.js` then `node tools/build-research-data.js`.

## Known issues

- `test/suite-07.js` "every TOC link scrolls to its section" fails on the merged `feature` base before any upgrade change (pre-existing). Must be fixed before Phase 8.

## Things I need to do (owner)

- Decide whether `claude/budgeting-suite-expansion-lwuc2e` (entities/financials/contracts, 3 migrations) should go to staging — not merged by this upgrade (D4).
