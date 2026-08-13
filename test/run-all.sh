#!/usr/bin/env bash
# Runs every browser suite against a local mock of the SWA API.
#
#   ./test/run-all.sh            # all suites
#   ./test/run-all.sh 03 08      # just those suites
#
# Requires Playwright with a Chromium build. If Chromium is not where Playwright
# expects it, point CHROMIUM_PATH at the binary.
set -uo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "node not found"; exit 1; }
node -e "require('playwright')" 2>/dev/null || {
  echo "playwright not resolvable from $(pwd) — npm i -D playwright, or set NODE_PATH"; exit 1; }

# Suite 01 asserts the offline banner, so it needs the API dead. Everything else
# needs it alive. Two servers, two ports, matching what the suites request.
NO_API=1 PORT=8099 node test/mock-api.js >/tmp/fs-mock-offline.log 2>&1 &
OFFLINE=$!
PORT=8100 node test/mock-api.js >/tmp/fs-mock.log 2>&1 &
ONLINE=$!
trap 'kill $OFFLINE $ONLINE 2>/dev/null' EXIT
sleep 1

if [ $# -gt 0 ]; then SUITES=(); for n in "$@"; do SUITES+=("test/suite-$n.js"); done
else SUITES=(test/suite-*.js); fi

fails=0

# Pure-logic tests (canonical JSON, content hashing, SOV projection) need no
# browser, so they run under node:test. Skipped when specific suites are named,
# which keeps `run-all.sh 03 08` meaning exactly those suites.
if [ $# -eq 0 ]; then
  echo "=== test/*.test.js (node:test)"
  node --test test/*.test.js >/tmp/fs-node-test.log 2>&1 \
    && grep -E '^# (tests|pass|fail)' /tmp/fs-node-test.log \
    || { fails=$((fails+1)); cat /tmp/fs-node-test.log; }
fi
for s in "${SUITES[@]}"; do
  echo "=== $s"
  node "$s" || fails=$((fails+1))
  # Suites seed their own budgets and several assert on exact row counts, so the
  # online mock is restarted between suites to clear its in-memory store.
  kill $ONLINE 2>/dev/null; wait $ONLINE 2>/dev/null
  PORT=8100 node test/mock-api.js >/tmp/fs-mock.log 2>&1 &
  ONLINE=$!
  sleep 0.4
done

echo
[ $fails -eq 0 ] && echo "all suites completed" || echo "$fails suite(s) reported failures"
exit $fails
