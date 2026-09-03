#!/usr/bin/env bash
# Regression tests for scripts/devnet/check-fork-rpc-configured.sh (issue
# #1239): the fork jobs' public-RPC fallback must be reported by name, and
# the configured value must never be echoed into the log.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/devnet/check-fork-rpc-configured.sh"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; ((PASS++)) || true; }
fail() { echo "FAIL: $1"; ((FAIL++)) || true; }

test_empty_value_warns_by_name() {
  local out status
  out="$("$SCRIPT" "" 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 0 ]] && grep -q '::warning::RMPC_FORK_RPC_URL Actions variable is not set' <<<"$out"
}

test_missing_arg_also_warns() {
  local out status
  out="$("$SCRIPT" 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 0 ]] && grep -q '::warning::RMPC_FORK_RPC_URL' <<<"$out"
}

test_configured_value_does_not_warn_or_leak() {
  local secret="https://base-mainnet.g.alchemy.com/v2/super-secret-token"
  local out status
  out="$("$SCRIPT" "$secret" 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 0 ]] || return 1
  ! grep -q '::warning::' <<<"$out" || return 1
  ! grep -qF "$secret" <<<"$out"
}

run_test() { if "$2"; then pass "$1"; else fail "$1"; fi; }

run_test "empty value warns by name" test_empty_value_warns_by_name
run_test "missing argument also warns" test_missing_arg_also_warns
run_test "configured value neither warns nor leaks the URL" test_configured_value_does_not_warn_or_leak

echo
echo "Results: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
