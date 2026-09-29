#!/usr/bin/env bash
# Regression tests for scripts/devnet/run-live-rpc-forge-fork.sh and
# scripts/devnet/fork-rpc-lib.sh (issue #1239).
#
# Offline: forge is a stub that replays forge's real output formats (the
# provider-failure text is verbatim forge 1.8.3 output against a 429 endpoint),
# so no network, RPC or compile is needed. Run inline by the fork-regressions
# job in suite-01-02-forge-tests.yml before the live-RPC steps rely on it.
#
# What must hold:
#   - a real assertion failure is reported as a test failure and never retried,
#     even when the same run also hit a rate limit or prints "429" in a trace;
#   - a run where every failing test failed on the provider is retried,
#     rotating across public endpoints, and ends as a provider failure;
#   - a provider flake that recovers passes with a warning naming it;
#   - a green run that executed zero tests is red;
#   - a configured endpoint is the only one used and its URL never reaches the log.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/devnet/run-live-rpc-forge-fork.sh"
LIB="$REPO_ROOT/scripts/devnet/fork-rpc-lib.sh"
PASS=0
FAIL=0
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

pass() { echo "PASS: $1"; ((PASS++)) || true; }
fail() { echo "FAIL: $1"; ((FAIL++)) || true; }
run_test() { if "$2"; then pass "$1"; else fail "$1"; fi; }

# --- canned forge outputs -----------------------------------------------------

cat >"$T/ok.txt" <<'EOF'
Ran 4 tests for contracts/test/UniswapV3AssetPositionAdapter.t.sol:UniV3AssetPositionAdapterForkTest
[PASS] test_navGuard() (gas: 123)
Suite result: ok. 4 passed; 0 failed; 0 skipped; finished in 14.83s (17.84s CPU time)

Ran 1 test suite in 15.00s (14.83s CPU time): 4 tests passed, 0 failed, 0 skipped (4 total tests)
EOF

cat >"$T/zero.txt" <<'EOF'
No tests match the provided pattern:
	match-contract: `NoSuchForkTest`

Ran 0 test suites in 1.00ms (0.00ns CPU time): 0 tests passed, 0 failed, 0 skipped (0 total tests)
EOF

cat >"$T/provider.txt" <<'EOF'
Ran 1 test for contracts/test/UniswapV4AssetPositionAdapter.t.sol:UniV4AssetPositionAdapterForkTest
[FAIL: vm.createSelectFork: could not instantiate forked environment with provider 127.0.0.1; failed to retrieve chain ID from fork endpoint; Max retries exceeded HTTP error 429 with body: error code: 1015

HTTP diagnostics:
server: BaseHTTP/0.6 Python/3.12.3] setUp() (gas: 0)
Suite result: FAILED. 0 passed; 1 failed; 0 skipped; finished in 13.00s (0.00ns CPU time)

Ran 1 test suite in 13.17s (13.00s CPU time): 0 tests passed, 1 failed, 0 skipped (1 total tests)
EOF

cat >"$T/archive.txt" <<'EOF'
Ran 4 tests for contracts/test/AerodromeAssetPositionAdapter.t.sol:AerodromeAssetPositionAdapterForkTest
[FAIL: backend: failed while inspecting; failed to get storage for 0xd0b53D9277642d899DF5C87A3966A349A798F224 at 7: HTTP error 403 with body: {"jsonrpc":"2.0","error":{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":0}] test_twapPricedTotalAssets() (gas: 0)
[FAIL: backend: failed while inspecting; failed to get account for 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913: FatalExternalError] test_slippageFloorReverts() (gas: 0)
Suite result: FAILED. 2 passed; 2 failed; 0 skipped; finished in 40.00s (0.00ns CPU time)
EOF

# A real regression whose trace happens to contain 429 in an amount.
cat >"$T/assert.txt" <<'EOF'
Ran 4 tests for contracts/test/UniswapV3AssetPositionAdapter.t.sol:UniV3AssetPositionAdapterForkTest
[FAIL: NAV deviation 1429 bps below guard 1500: 1429 < 1500] test_navGuardRevertsOnManipulatedSpot() (gas: 4290000)
Traces:
  [4290000] UniV3AssetPositionAdapterForkTest::test_navGuardRevertsOnManipulatedSpot()
    ├─ [429] USDC::balanceOf(0x0000000000000000000000000000000000000001) [staticcall]
    │   └─ ← [Return] 429000000
Suite result: FAILED. 3 passed; 1 failed; 0 skipped; finished in 18.00s (20.00s CPU time)
EOF

# Same run: one test died on the provider, one failed a real assertion.
cat >"$T/mixed.txt" <<'EOF'
Ran 4 tests for contracts/test/UniswapV3AssetPositionAdapter.t.sol:UniV3AssetPositionAdapterForkTest
[FAIL: backend: failed while inspecting; failed to get storage for 0xd0b53D9277642d899DF5C87A3966A349A798F224 at 0: HTTP error 429 with body: error code: 1015] test_twapPricedTotalAssets() (gas: 0)
[FAIL: slippage floor did not revert] test_slippageFloorReverts() (gas: 812345)
Suite result: FAILED. 2 passed; 2 failed; 0 skipped; finished in 18.00s (20.00s CPU time)
EOF

cat >"$T/compile.txt" <<'EOF'
Compiler run failed:
Error (7576): Undeclared identifier.
EOF

# Real shape from PR #1411's own CI run (job 109076796558): a sharedbackend
# RPC failure deep in a call trace bubbles up as a bare "EvmError: Revert"
# with no reason text forge can attach to the [FAIL: ...] bracket. The
# transport diagnostic that actually explains it prints separately, above
# the trace/Suite-result block.
cat >"$T/bare_revert_provider.txt" <<'EOF'
Ran 4 tests for contracts/test/AerodromeAssetPositionAdapter.t.sol:AerodromeAssetPositionAdapterForkTest
ERROR sharedbackend: Failed to send/recv `basic` err=failed to get account for 0x0AD08370c76Ff426F534bb2AFFD9b5555338ee68: Max retries exceeded HTTP error 429 with body: {"jsonrpc":"2.0","error":{"code":-32016,"message":"over rate limit"},"id":109}
[FAIL: EvmError: Revert] test_fork_deploySwapsUsdcToWethAndPricesViaTwap() (block: 51915757) (gas: 7370)
[FAIL: EvmError: Revert] test_fork_navDeviationGuardRevertsOnManipulatedSpot() (block: 51915757) (gas: 546203)
[FAIL: EvmError: Revert] test_fork_roundTripWithdrawAllReturnsUsdc() (block: 51915757) (gas: 7454)
[FAIL: EvmError: Revert] test_fork_withdrawRevertsBelowSlippageFloor() (block: 51915757) (gas: 7520)
Suite result: FAILED. 0 passed; 4 failed; 0 skipped; finished in 8.35s (29.17s CPU time)
EOF

# Same bare "EvmError: Revert" bracket shape, but with no transport
# diagnostic anywhere in the log: a genuine no-message revert() bug. Must
# stay a test failure, never retried -- proves the bare-revert heuristic
# does not just wave every unexplained revert through as "provider".
cat >"$T/bare_revert_real_bug.txt" <<'EOF'
Ran 1 test for contracts/test/AerodromeAssetPositionAdapter.t.sol:AerodromeAssetPositionAdapterForkTest
[FAIL: EvmError: Revert] test_fork_withdrawRevertsBelowSlippageFloor() (block: 51915757) (gas: 7520)
Suite result: FAILED. 0 passed; 1 failed; 0 skipped; finished in 8.35s (29.17s CPU time)
EOF

# Stub forge: appends the FORK_RPC_URL it was given to $T/calls, then replays
# the file named by the next line of $STUB_SCRIPT (the last line repeats).
cat >"$T/forge" <<EOF
#!/usr/bin/env bash
echo "\$FORK_RPC_URL" >>"$T/calls"
n=\$(wc -l <"$T/calls")
mapfile -t plan <"\$STUB_SCRIPT"
idx=\$(( n - 1 ))
[ "\$idx" -lt "\${#plan[@]}" ] || idx=\$(( \${#plan[@]} - 1 ))
set -- \${plan[\$idx]}
cat "$T/\$1.txt"
[ -n "\${ECHO_URL:-}" ] && echo "MPP HTTP request to \$FORK_RPC_URL failed: HTTP request failed"
exit "\$2"
EOF
chmod +x "$T/forge"

# run <plan lines...>: runs the script with a fresh stub plan; leaves output in
# $T/out, exit status in $T/status and GITHUB_OUTPUT in $T/gh_output.
run() {
  : >"$T/calls"
  : >"$T/gh_output"
  printf '%s\n' "$@" >"$T/plan"
  local status
  STUB_SCRIPT="$T/plan" FORGE_BIN="$T/forge" FORK_RPC_RETRY_DELAY_SECONDS=0 \
    FORK_RPC_PUBLIC_ENDPOINTS="${PUBLIC:-https://pub-a.invalid https://pub-b.invalid}" \
    GITHUB_OUTPUT="$T/gh_output" GITHUB_ACTIONS=false \
    "$SCRIPT" "UniV3 fork" --match-contract UniV3AssetPositionAdapterForkTest -vvv \
    >"$T/out" 2>&1 && status=0 || status=$?
  echo "$status" >"$T/status"
}
status() { cat "$T/status"; }
calls() { wc -l <"$T/calls" | tr -d ' '; }
classification() { grep -x "classification=$1" "$T/gh_output" >/dev/null; }

# --- runner -------------------------------------------------------------------

test_green_run_passes() {
  RMPC_FORK_RPC_URL_RAW="" run "ok 0"
  [ "$(status)" = 0 ] && classification passed && [ "$(calls)" = 1 ] \
    && ! grep -q '::warning' "$T/out"
}

test_zero_executed_is_red() {
  RMPC_FORK_RPC_URL_RAW="" run "zero 0"
  [ "$(status)" = 30 ] && classification harness && grep -q 'executed zero tests' "$T/out"
}

test_assertion_failure_is_test_not_retried() {
  RMPC_FORK_RPC_URL_RAW="" run "assert 1" "ok 0"
  [ "$(status)" = 10 ] && classification test && [ "$(calls)" = 1 ] \
    && grep -q '::error title=Fork test failure, not an RPC failure' "$T/out"
}

test_mixed_failure_is_test_not_retried() {
  RMPC_FORK_RPC_URL_RAW="" run "mixed 1" "ok 0"
  [ "$(status)" = 10 ] && classification test && [ "$(calls)" = 1 ]
}

test_provider_failure_retries_rotates_then_red() {
  RMPC_FORK_RPC_URL_RAW="" FORK_RPC_ATTEMPTS=3 run "provider 1"
  [ "$(status)" = 20 ] && classification provider && [ "$(calls)" = 3 ] \
    && [ "$(sed -n 1p "$T/calls")" = "https://pub-a.invalid" ] \
    && [ "$(sed -n 2p "$T/calls")" = "https://pub-b.invalid" ] \
    && [ "$(sed -n 3p "$T/calls")" = "https://pub-a.invalid" ] \
    && grep -q '::error title=Fork RPC provider failure, not a test regression' "$T/out"
}

test_archive_and_fatal_external_are_provider() {
  RMPC_FORK_RPC_URL_RAW="" FORK_RPC_ATTEMPTS=2 run "archive 1"
  [ "$(status)" = 20 ] && classification provider && [ "$(calls)" = 2 ]
}

test_recovered_flake_passes_with_warning() {
  RMPC_FORK_RPC_URL_RAW="" run "provider 1" "ok 0"
  [ "$(status)" = 0 ] && classification passed && [ "$(calls)" = 2 ] \
    && grep -q '::warning title=Fork RPC flake recovered' "$T/out"
}

test_compile_failure_is_harness() {
  RMPC_FORK_RPC_URL_RAW="" run "compile 1" "ok 0"
  [ "$(status)" = 30 ] && classification harness && [ "$(calls)" = 1 ]
}

test_bare_revert_with_transport_diagnostic_is_provider() {
  RMPC_FORK_RPC_URL_RAW="" FORK_RPC_ATTEMPTS=2 run "bare_revert_provider 1" "ok 0"
  [ "$(status)" = 0 ] && classification passed && [ "$(calls)" = 2 ] \
    && grep -q '::warning title=Fork RPC flake recovered' "$T/out"
}

test_bare_revert_without_transport_diagnostic_is_test_not_retried() {
  RMPC_FORK_RPC_URL_RAW="" run "bare_revert_real_bug 1" "ok 0"
  [ "$(status)" = 10 ] && classification test && [ "$(calls)" = 1 ] \
    && grep -q '::error title=Fork test failure, not an RPC failure' "$T/out"
}

test_configured_endpoint_only_and_never_printed() {
  local secret="https://base-mainnet.g.alchemy.invalid/v2/super-secret-token"
  RMPC_FORK_RPC_URL_RAW="$secret" ECHO_URL=1 FORK_RPC_ATTEMPTS=2 run "provider 1"
  [ "$(status)" = 20 ] || return 1
  # Both attempts went to the configured endpoint, none to a public fallback.
  [ "$(sort -u "$T/calls")" = "$secret" ] || return 1
  ! grep -q 'super-secret-token' "$T/out" || return 1
  grep -q '<redacted:https://base-mainnet.g.alchemy.invalid>' "$T/out" || return 1
  grep -q 'against the configured RMPC_FORK_RPC_URL' "$T/out"
}

test_unset_variable_uses_first_public_default() {
  # No override: the committed default list is what CI uses when the Actions
  # variable is unset, and its first entry must be the archive-capable one.
  : >"$T/calls"; printf '%s\n' "ok 0" >"$T/plan"
  local status
  STUB_SCRIPT="$T/plan" FORGE_BIN="$T/forge" RMPC_FORK_RPC_URL_RAW="" GITHUB_ACTIONS=false \
    "$SCRIPT" "UniV3 fork" --match-contract X >"$T/out" 2>&1 && status=0 || status=$?
  [ "$status" = 0 ] && [ "$(cat "$T/calls")" = "https://mainnet.base.org" ]
}

# --- library ------------------------------------------------------------------

test_origin_drops_credentials_path_and_query() {
  # shellcheck source=scripts/devnet/fork-rpc-lib.sh
  ( . "$LIB"
    [ "$(fork_rpc_origin 'https://user:pw@rpc.example.invalid:8443/v2/KEY?x=1#f')" = "https://rpc.example.invalid:8443" ] \
      && [ "$(fork_rpc_origin 'https://mainnet.base.org')" = "https://mainnet.base.org" ] \
      && [ "$(fork_rpc_origin 'not a url KEY')" = "<unparseable RPC URL>" ] )
}

test_redact_full_url_and_key_path() {
  # shellcheck source=scripts/devnet/fork-rpc-lib.sh
  ( . "$LIB"
    local url="https://rpc.example.invalid/v2/KEY123" out
    out="$(printf 'a %s b\nnormalised https://RPC.example.invalid/v2/KEY123/ c\n' "$url" | fork_rpc_redact "$url")"
    ! grep -q 'KEY123' <<<"$out" && grep -q '<redacted:https://rpc.example.invalid>' <<<"$out" )
}

test_redact_empty_url_is_passthrough() {
  # shellcheck source=scripts/devnet/fork-rpc-lib.sh
  ( . "$LIB"
    [ "$(printf 'unchanged\n' | fork_rpc_redact "")" = "unchanged" ] )
}

run_test "green run passes and is not retried" test_green_run_passes
run_test "green run with zero executed tests is red" test_zero_executed_is_red
run_test "assertion failure is a test failure and is not retried" test_assertion_failure_is_test_not_retried
run_test "provider + assertion failure in one run is a test failure" test_mixed_failure_is_test_not_retried
run_test "provider failure retries across public endpoints, then red" test_provider_failure_retries_rotates_then_red
run_test "archive-token and FatalExternalError are provider failures" test_archive_and_fatal_external_are_provider
run_test "recovered provider flake passes with a named warning" test_recovered_flake_passes_with_warning
run_test "compile failure is a harness failure, not retried" test_compile_failure_is_harness
run_test "bare EvmError revert with a transport diagnostic is retried as provider" test_bare_revert_with_transport_diagnostic_is_provider
run_test "bare EvmError revert with no transport diagnostic stays a test failure" test_bare_revert_without_transport_diagnostic_is_test_not_retried
run_test "configured endpoint is used alone and never printed" test_configured_endpoint_only_and_never_printed
run_test "unset variable falls back to the archive-capable public default" test_unset_variable_uses_first_public_default
run_test "origin drops credentials, path and query" test_origin_drops_credentials_path_and_query
run_test "redaction removes the full URL and its key path" test_redact_full_url_and_key_path
run_test "redaction with no URL passes output through" test_redact_empty_url_is_passthrough

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
