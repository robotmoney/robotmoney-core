#!/usr/bin/env bash
# Self-test for .github/scripts/cargo_test_require_executed.sh (issue #1371).
#
# Puts a stub `cargo` first on PATH that replays a canned libtest transcript,
# then checks the guard's verdict for each shape. The point is that the guard
# is observed going RED on the false-green shapes it exists to catch, not only
# observed passing:
#
#   1. zero tests executed                               -> red
#   2. tests executed, no markers required               -> green (unchanged)
#   3. required markers all present                      -> green
#   4. hermetic tests pass but the devnet test skipped,
#      so its success-path marker is absent              -> red  (issue #1437)
#   5. only one of two required markers present          -> red
#   6. cargo itself fails                                -> red
#
# Runs in suite-14's hermetic `smoke-test-guards` job.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="${ROOT}/.github/scripts/cargo_test_require_executed.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

# The stub prints $STUB_OUTPUT and exits $STUB_STATUS.
cat > "$WORK/bin/cargo" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${STUB_OUTPUT}"
exit "${STUB_STATUS:-0}"
STUB
chmod +x "$WORK/bin/cargo"

M1='[full_stack_demo_tvl] assertion 1/2 PASSED'
M2='[full_stack_demo_tvl] assertion 2/2 PASSED'
MARKERS="
    ${M1}
    ${M2}
"

FULL_RUN="running 7 tests
test explorer_api_reports_four_vault_tvl_and_router_weights_after_boot ... smoke-test: booting
${M1}: GET /v1/vaults reports four Active vaults
${M2}: GET /v1/router/weights sums to 10000 bps
ok
test invariant_predicates::empty_router_weights_fail_the_invariant ... ok
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s"

SKIPPED_DEVNET="running 7 tests
test explorer_api_reports_four_vault_tvl_and_router_weights_after_boot ... [explorer_api_reports_four_vault_tvl_and_router_weights_after_boot] docker/forge/cast not on PATH; skipping.
ok
test invariant_predicates::empty_router_weights_fail_the_invariant ... ok
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"

ONE_MARKER="running 7 tests
test explorer_api_reports_four_vault_tvl_and_router_weights_after_boot ... smoke-test: booting
${M1}: GET /v1/vaults reports four Active vaults
ok
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s"

ZERO_RUN="running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 7 filtered out; finished in 0.00s"

FAILS=0

# expect <green|red> <label> <stub-output> <stub-status> <markers>
expect() {
  local want="$1" label="$2" out="$3" status="$4" markers="$5" got
  if STUB_OUTPUT="$out" STUB_STATUS="$status" REQUIRE_EXECUTED_MARKERS="$markers" \
    PATH="$WORK/bin:$PATH" bash "$GUARD" -p smoke-test >"$WORK/out.log" 2>&1; then
    got=green
  else
    got=red
  fi
  if [ "$got" = "$want" ]; then
    echo "ok   - ${label} (${got})"
  else
    echo "FAIL - ${label}: expected ${want}, got ${got}"
    sed 's/^/       | /' "$WORK/out.log"
    FAILS=$((FAILS + 1))
  fi
}

expect red   "zero tests executed"                        "$ZERO_RUN"       0 ""
expect green "tests executed, no markers required"        "$FULL_RUN"       0 ""
expect green "all required markers present"               "$FULL_RUN"       0 "$MARKERS"
expect red   "devnet test skipped, hermetic tests pad N"  "$SKIPPED_DEVNET" 0 "$MARKERS"
expect green "same skipped run WITHOUT markers (the #1437 hole)" "$SKIPPED_DEVNET" 0 ""
expect red   "one of two required markers present"        "$ONE_MARKER"     0 "$MARKERS"
expect red   "cargo test itself failed"                   "$FULL_RUN"       101 "$MARKERS"

if [ "$FAILS" -gt 0 ]; then
  echo "test_cargo_test_require_executed: ${FAILS} case(s) failed" >&2
  exit 1
fi
echo "test_cargo_test_require_executed: all cases passed"
