#!/usr/bin/env bash
# Run `forge test` and FAIL LOUDLY if fewer than FORGE_TEST_MIN_EXECUTED tests passed.
#
# WHY THIS EXISTS (issue 1643, the forge twin of cargo_test_require_executed.sh)
# `forge test --match-path <glob>` exits 0 and prints only "Warning: no tests match
# the provided pattern" when the glob matches nothing (verified on forge 1.8.3). A
# renamed file, a wrong directory (the old `test/invariant/**` while the Foundry test
# dir is `contracts/test`) or a bad brace pattern then reads as a green check. This
# wrapper sums the `Suite result: ok. N passed` lines and exits non-zero unless the
# sum reaches the floor (default 1).
#
# USAGE
#   forge_test_require_executed.sh <forge test args...>
#   FORGE_TEST_MIN_EXECUTED=3 forge_test_require_executed.sh --match-path "contracts/test/X.t.sol"
# Self-test: .github/scripts/tests/test_forge_test_require_executed.sh.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "ERROR: forge_test_require_executed.sh requires forge test arguments" >&2
  exit 2
fi

MIN_EXECUTED="${FORGE_TEST_MIN_EXECUTED:-1}"
case "$MIN_EXECUTED" in ''|*[!0-9]*) echo "ERROR: FORGE_TEST_MIN_EXECUTED must be a non-negative integer" >&2; exit 2 ;; esac
[ "$MIN_EXECUTED" -ge 1 ] || MIN_EXECUTED=1

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

set +e
forge test "$@" 2>&1 | tee "$LOG"
FORGE_STATUS="${PIPESTATUS[0]}"
set -e

if [ "$FORGE_STATUS" -ne 0 ]; then
  echo "ERROR: forge test exited ${FORGE_STATUS}, see output above." >&2
  exit "$FORGE_STATUS"
fi

PASSED_TOTAL="$(
  { grep -E '^Suite result:' "$LOG" || true; } \
    | sed -E 's/^Suite result: [a-zA-Z]+\. ([0-9]+) passed.*/\1/' \
    | awk '{ sum += $1 } END { print sum + 0 }'
)"

echo "executed-test-guard: ${PASSED_TOTAL} forge test(s) passed (floor ${MIN_EXECUTED})"

if [ "${PASSED_TOTAL}" -lt "${MIN_EXECUTED}" ]; then
  echo "ERROR: ${PASSED_TOTAL} forge test(s) passed, the floor is ${MIN_EXECUTED}." >&2
  echo "       The --match-path / --match-contract filter matched nothing, so this" >&2
  echo "       green run executed no tests. Failing loudly." >&2
  exit 1
fi
