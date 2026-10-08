#!/usr/bin/env bash
# Issue 1656: every floor set on a wrapped step in suites 05, 07, 08, 11a and 11b is exercised
# against the REAL cargo_test_require_executed.sh with a stub cargo. For each floor F the wrapper
# is green at F executed tests and red at F-1 and at 0. The floors are read from the workflows,
# so a floor edited there is the floor tested here.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="${ROOT}/.github/scripts/cargo_test_require_executed.sh"
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

run_wrapper() { # floor passed
  PATH="$WORK/bin:$PATH" STUB_PASSED="$2" CARGO_TEST_MIN_EXECUTED="$1" bash "$GUARD" --test x >/dev/null 2>&1
}

floors="$(cd "$WF" && cat suite-05-fork-integration.yml suite-07-rmpc-integration.yml \
  suite-08-explorer-indexer.yml suite-11a-opencode-smoke.yml suite-11b-opencode-headless.yml \
  | grep -oE 'CARGO_TEST_MIN_EXECUTED=[0-9]+|min_executed: [0-9]+' | grep -oE '[0-9]+$')"
count="$(printf '%s\n' "$floors" | wc -l)"
[ "$count" -ge 27 ] || { echo "FAIL: found $count floors in the five suites, expected at least 27"; exit 1; }

for f in $(printf '%s\n' "$floors" | sort -un); do
  run_wrapper "$f" "$f" || { echo "FAIL: floor $f rejected $f executed"; exit 1; }
  run_wrapper "$f" "$((f + 3))" || { echo "FAIL: floor $f rejected $((f + 3)) executed"; exit 1; }
  if run_wrapper "$f" "$((f - 1))"; then echo "FAIL: floor $f accepted $((f - 1)) executed"; exit 1; fi
  if run_wrapper "$f" 0; then echo "FAIL: floor $f accepted 0 executed"; exit 1; fi
done
echo "ok: wrapped step floors ($count in the workflows, distinct: $(printf '%s\n' "$floors" | sort -un | tr '\n' ' '))"
