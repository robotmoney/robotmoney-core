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
#   7. marker text echoed mid-line by a compiler warning,
#      the test itself never printed it (line-start
#      anchor false-positive guard)                      -> red  (issue #1401)
#   8. suite 05's gas marker (QA plan T3, issue #1683):
#      the deposit line present                          -> green
#      the deposit assertion failed (cargo exit 101)     -> red
#      the gas test printed nothing, the slot's other
#      tests pad N                                       -> red
#      the deposit line glued to libtest's "test ... "
#      prefix, so it is not at line start                -> red
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

# The devnet test never reached its success-path eprintln (early return before
# it, same shape as SKIPPED_DEVNET) but rustc emits an unrelated warning that
# happens to quote the marker text mid-line. N stays > 0 from the hermetic
# tests. Before anchoring the marker match to line start, grep -F found this
# substring anywhere in the log and reported the marker "present" even though
# the assertion it names never ran (issue #1401).
WARNING_ECHOES_MARKER="running 7 tests
warning: unreachable statement: this branch is dead now that the \`${M1}\` \
eprintln was hoisted above an early return, so the assertion below it never \
executes
test invariant_predicates::empty_router_weights_fail_the_invariant ... ok
test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.01s"

# Case 8 (QA plan T3, issue #1683). The marker is read from the suite-05 workflow, not copied, so
# the string tested here is the string CI requires. It is a line prefix: the wrapper matches it at
# line start, and the gas test's line goes on with the measured gas and the budget.
SUITE05="${ROOT}/.github/workflows/suite-05-fork-integration.yml"
GAS_TEST="${ROOT}/testing/fork-e2e-rust/tests/gas_estimate_reality_check.rs"
GAS_MARKER="$(grep -oE '^[[:space:]]*\[gas_estimate_reality_check\] deposit gasUsed=$' "$SUITE05" \
  | sed -E 's/^[[:space:]]+//' | head -n 1 || true)"

GAS_RUN="running 1 test
test gas_estimate_reality_check ... [gas_estimate_reality_check] chain_id=918453 fork_block=1 rpc_label=fork address_set_hash=00

[gas_estimate_reality_check] approve gasUsed=55437 budget=80000

${GAS_MARKER}833900 budget=920000

[gas_estimate_reality_check] redeem gasUsed=702311 budget=1100000
ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s"

GAS_OVER_BUDGET="running 1 test
test gas_estimate_reality_check ... [gas_estimate_reality_check] chain_id=918453 fork_block=1 rpc_label=fork address_set_hash=00

[gas_estimate_reality_check] approve gasUsed=55437 budget=80000
thread 'gas_estimate_reality_check' panicked at tests/gas_estimate_reality_check.rs:62:5:
deposit gasUsed 1012345 exceeded budget 920000
FAILED
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s"

GAS_SILENT="running 4 tests
test devnet_adapter_round_trip ... ok
test gas_estimate_reality_check ... ok
test landing_price_strip_fork ... ok
test basket_vault_round_trip ... ok
test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s"

GAS_MID_LINE="running 1 test
test gas_estimate_reality_check ... ${GAS_MARKER}833900 budget=920000
ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 9.00s"

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
expect red   "compiler warning echoes marker mid-line, test never ran" "$WARNING_ECHOES_MARKER" 0 "$M1"

if [ "$GAS_MARKER" = '[gas_estimate_reality_check] deposit gasUsed=' ]; then
  echo "ok   - suite 05 anvil-devnet-adapters requires the gas test's deposit marker"
else
  echo "FAIL - suite 05 has no required_markers line '[gas_estimate_reality_check] deposit gasUsed='"
  FAILS=$((FAILS + 1))
fi
# The test prints the marker as \n<marker>{gasUsed} budget=...: the leading newline puts it at
# line start even right after libtest's "test ... " prefix (the GAS_MID_LINE shape below).
if grep -qF "\"\\n${GAS_MARKER}{} budget=" "$GAS_TEST"; then
  echo "ok   - gas_estimate_reality_check.rs prints the marker on a line of its own"
else
  echo "FAIL - gas_estimate_reality_check.rs does not print \\n${GAS_MARKER}{} budget="
  FAILS=$((FAILS + 1))
fi
expect green "gas test: deposit marker present"                      "$GAS_RUN"         0   "$GAS_MARKER"
expect red   "gas test: deposit over budget, cargo failed"           "$GAS_OVER_BUDGET" 101 "$GAS_MARKER"
expect red   "gas test: no deposit line, slot's other tests pad N"   "$GAS_SILENT"      0   "$GAS_MARKER"
expect red   "gas test: deposit line glued to libtest's test prefix" "$GAS_MID_LINE"    0   "$GAS_MARKER"

if [ "$FAILS" -gt 0 ]; then
  echo "test_cargo_test_require_executed: ${FAILS} case(s) failed" >&2
  exit 1
fi
echo "test_cargo_test_require_executed: all cases passed"
