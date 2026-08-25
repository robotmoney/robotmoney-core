#!/usr/bin/env bash
# Regression tests for provider/drift classification in the nightly fork alarm.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/devnet/run-live-base-fork-drift.sh"
PASS=0
FAIL=0
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

pass() { echo "PASS: $1"; ((PASS++)) || true; }
fail() { echo "FAIL: $1"; ((FAIL++)) || true; }
run_test() { if "$2"; then pass "$1"; else fail "$1"; fi; }

make_bin() {
  local name="$1"
  shift
  local path="$TMPDIR_TEST/$name"
  printf '%s\n' '#!/usr/bin/env bash' "$@" >"$path"
  chmod +x "$path"
  echo "$path"
}

curl_ok="$(make_bin curl-ok 'printf "%s\\n" "{\"jsonrpc\":\"2.0\",\"result\":\"0x1\",\"id\":1}"')"
forge_ok="$(make_bin forge-ok 'printf "%s\\n" "{\"status\":\"Success\"}"')"
forge_drift="$(make_bin forge-drift 'echo "assertion failed" >&2' 'exit 1')"
forge_zero="$(make_bin forge-zero 'printf "%s\\n" "[]"')"
forge_compile_failure="$(make_bin forge-compile-failure 'echo "Compiler run failed" >&2' 'exit 1')"

test_success_requires_executed_tests() {
  local output_file="$TMPDIR_TEST/output-success" status
  FORK_RPC_URL=http://rpc.invalid CURL_BIN="$curl_ok" FORGE_BIN="$forge_ok" \
    FORK_DRIFT_RETRY_DELAY_SECONDS=0 GITHUB_OUTPUT="$output_file" "$SCRIPT" >/dev/null 2>&1 && status=0 || status=$?
  [[ "$status" -eq 0 ]] && grep -qx 'classification=passed' "$output_file"
}

test_assertion_failure_is_drift() {
  local output_file="$TMPDIR_TEST/output-drift" status
  FORK_RPC_URL=http://rpc.invalid CURL_BIN="$curl_ok" FORGE_BIN="$forge_drift" \
    FORK_DRIFT_RETRY_DELAY_SECONDS=0 GITHUB_OUTPUT="$output_file" "$SCRIPT" >/dev/null 2>&1 && status=0 || status=$?
  [[ "$status" -eq 10 ]] && grep -qx 'classification=drift' "$output_file"
}

test_provider_failure_retries_then_stays_provider() {
  local attempts="$TMPDIR_TEST/provider-attempts" output_file="$TMPDIR_TEST/output-provider" forge status
  forge="$TMPDIR_TEST/forge-provider"
  printf '%s\n' '#!/usr/bin/env bash' "echo x >> \"$attempts\"" \
    'echo "HTTP 429 Too Many Requests" >&2' 'exit 1' >"$forge"
  chmod +x "$forge"
  FORK_RPC_URL=http://rpc.invalid CURL_BIN="$curl_ok" FORGE_BIN="$forge" FORK_DRIFT_RETRIES=2 \
    FORK_DRIFT_RETRY_DELAY_SECONDS=0 GITHUB_OUTPUT="$output_file" "$SCRIPT" >/dev/null 2>&1 && status=0 || status=$?
  [[ "$status" -eq 20 ]] && [[ "$(wc -l <"$attempts")" -eq 2 ]] && grep -qx 'classification=provider' "$output_file"
}

test_zero_tests_is_harness_failure_not_drift() {
  local output_file="$TMPDIR_TEST/output-zero" status
  FORK_RPC_URL=http://rpc.invalid CURL_BIN="$curl_ok" FORGE_BIN="$forge_zero" \
    FORK_DRIFT_RETRY_DELAY_SECONDS=0 GITHUB_OUTPUT="$output_file" "$SCRIPT" >/dev/null 2>&1 && status=0 || status=$?
  [[ "$status" -eq 30 ]] && grep -qx 'classification=harness' "$output_file"
}

test_compile_failure_is_harness_failure_not_drift() {
  local output_file="$TMPDIR_TEST/output-compile" status
  FORK_RPC_URL=http://rpc.invalid CURL_BIN="$curl_ok" FORGE_BIN="$forge_compile_failure" \
    FORK_DRIFT_RETRY_DELAY_SECONDS=0 GITHUB_OUTPUT="$output_file" "$SCRIPT" >/dev/null 2>&1 && status=0 || status=$?
  [[ "$status" -eq 30 ]] && grep -qx 'classification=harness' "$output_file"
}

run_test 'success_requires_executed_tests' test_success_requires_executed_tests
run_test 'assertion_failure_is_drift' test_assertion_failure_is_drift
run_test 'provider_failure_retries_then_stays_provider' test_provider_failure_retries_then_stays_provider
run_test 'zero_tests_is_harness_failure_not_drift' test_zero_tests_is_harness_failure_not_drift
run_test 'compile_failure_is_harness_failure_not_drift' test_compile_failure_is_harness_failure_not_drift

echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
