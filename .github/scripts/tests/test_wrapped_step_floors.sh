#!/usr/bin/env bash
# Issue 1656: every floor set on a wrapped step in suites 05, 07, 08, 11a and 11b is exercised
# against the REAL cargo_test_require_executed.sh with a stub cargo. For each floor F the wrapper
# is green at F executed tests and red at F-1 and at 0. The floors are read from the workflows,
# so a floor edited there is the floor tested here.
# QA plan v1 T5: the env form of a floor (`CARGO_TEST_MIN_EXECUTED: "8"`) is read too, and the
# suite 22 floors run the same way against the REAL forge_test_require_executed.sh with a stub
# forge. That each floor equals its step's test count is check_executed_floors.py's job.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="${ROOT}/.github/scripts/cargo_test_require_executed.sh"
FORGE_GUARD="${ROOT}/.github/scripts/forge_test_require_executed.sh"
WF="${ROOT}/.github/workflows"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cat > "$WORK/bin/cargo" <<'STUB'
#!/usr/bin/env bash
echo "running ${STUB_PASSED} tests"
echo "test result: ok. ${STUB_PASSED} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"
STUB
chmod +x "$WORK/bin/cargo"

cat > "$WORK/bin/forge" <<'STUB'
#!/usr/bin/env bash
echo "Ran ${STUB_PASSED} tests for contracts/test/X.t.sol:XTest"
echo "Suite result: ok. ${STUB_PASSED} passed; 0 failed; 0 skipped; finished in 1ms"
STUB
chmod +x "$WORK/bin/forge"

run_wrapper() { # floor passed
  PATH="$WORK/bin:$PATH" STUB_PASSED="$2" CARGO_TEST_MIN_EXECUTED="$1" bash "$GUARD" --test x >/dev/null 2>&1
}

run_forge_wrapper() { # floor passed
  PATH="$WORK/bin:$PATH" STUB_PASSED="$2" FORGE_TEST_MIN_EXECUTED="$1" bash "$FORGE_GUARD" --match-path x >/dev/null 2>&1
}

floors="$(cd "$WF" && cat suite-05-fork-integration.yml suite-07-rmpc-integration.yml \
  suite-08-explorer-indexer.yml suite-11a-opencode-smoke.yml suite-11b-opencode-headless.yml \
  | grep -oE 'CARGO_TEST_MIN_EXECUTED=[0-9]+|CARGO_TEST_MIN_EXECUTED: "?[0-9]+|min_executed: [0-9]+' \
  | grep -oE '[0-9]+$')"
count="$(printf '%s\n' "$floors" | wc -l)"
# 51 since QA plan v1 T5 named a floor on every wrapped step of suites 5 and 8.
[ "$count" -ge 51 ] || { echo "FAIL: found $count floors in the five suites, expected at least 51"; exit 1; }

forge_floors="$(grep -oE 'FORGE_TEST_MIN_EXECUTED=[0-9]+' "$WF/suite-22-formal-verification.yml" | grep -oE '[0-9]+$')"
forge_count="$(printf '%s\n' "$forge_floors" | grep -c . || true)"
[ "$forge_count" -ge 2 ] || { echo "FAIL: found $forge_count forge floors in suite 22, expected 2 (one per test step)"; exit 1; }

for f in $(printf '%s\n' "$floors" | sort -un); do
  run_wrapper "$f" "$f" || { echo "FAIL: floor $f rejected $f executed"; exit 1; }
  run_wrapper "$f" "$((f + 3))" || { echo "FAIL: floor $f rejected $((f + 3)) executed"; exit 1; }
  if run_wrapper "$f" "$((f - 1))"; then echo "FAIL: floor $f accepted $((f - 1)) executed"; exit 1; fi
  if run_wrapper "$f" 0; then echo "FAIL: floor $f accepted 0 executed"; exit 1; fi
done
for f in $(printf '%s\n' "$forge_floors" | sort -un); do
  run_forge_wrapper "$f" "$f" || { echo "FAIL: forge floor $f rejected $f passed"; exit 1; }
  run_forge_wrapper "$f" "$((f + 3))" || { echo "FAIL: forge floor $f rejected $((f + 3)) passed"; exit 1; }
  if run_forge_wrapper "$f" "$((f - 1))"; then echo "FAIL: forge floor $f accepted $((f - 1)) passed"; exit 1; fi
  if run_forge_wrapper "$f" 0; then echo "FAIL: forge floor $f accepted 0 passed"; exit 1; fi
done
echo "ok: wrapped step floors ($count in the workflows, distinct: $(printf '%s\n' "$floors" | sort -un | tr '\n' ' '))"
echo "ok: suite 22 forge floors ($(printf '%s\n' "$forge_floors" | tr '\n' ' '))"
