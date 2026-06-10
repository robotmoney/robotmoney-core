#!/usr/bin/env bash
# Unit tests for scripts/assert-basescan-verified.sh
#
# Uses MOCK_BASESCAN_VERIFIED / MOCK_BASESCAN_UNVERIFIED environment variables
# to drive all code paths without making real HTTP calls.
#
# Canonical: docs/technical/security-model.md §8 / §13
# Issue: #662

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/assert-basescan-verified.sh"

PASS=0
FAIL=0

pass() { echo "PASS: $1"; (( PASS++ )) || true; }
fail() { echo "FAIL: $1"; (( FAIL++ )) || true; }

run_test() {
  local name="$1"
  shift
  if "$@"; then
    pass "${name}"
  else
    fail "${name}"
  fi
}

# ---------------------------------------------------------------------------
# Test: exit 2 when no addresses supplied
# ---------------------------------------------------------------------------
test_no_addresses_exits_2() {
  local exit_code
  bash "${SCRIPT}" 2>/dev/null && exit_code=$? || exit_code=$?
  [[ ${exit_code} -eq 2 ]]
}

# ---------------------------------------------------------------------------
# Test: isVerified=true → exits 0
# All three addresses are in MOCK_BASESCAN_VERIFIED; none are in UNVERIFIED.
# ---------------------------------------------------------------------------
test_all_verified_exits_0() {
  local addr1="0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  local addr2="0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
  local addr3="0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
  local exit_code
  MOCK_BASESCAN_VERIFIED="${addr1},${addr2},${addr3}" \
    TIMEOUT_SECONDS=5 \
    POLL_INTERVAL_SECONDS=1 \
    bash "${SCRIPT}" "${addr1}" "${addr2}" "${addr3}" 2>/dev/null \
    && exit_code=$? || exit_code=$?
  [[ ${exit_code} -eq 0 ]]
}

# ---------------------------------------------------------------------------
# Test: single address verified → exits 0
# ---------------------------------------------------------------------------
test_single_verified_exits_0() {
  local addr="0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  local exit_code
  MOCK_BASESCAN_VERIFIED="${addr}" \
    TIMEOUT_SECONDS=5 \
    POLL_INTERVAL_SECONDS=1 \
    bash "${SCRIPT}" "${addr}" 2>/dev/null \
    && exit_code=$? || exit_code=$?
  [[ ${exit_code} -eq 0 ]]
}

# ---------------------------------------------------------------------------
# Test: isVerified=false with short timeout → exits 1
# Address is in MOCK_BASESCAN_UNVERIFIED and never flips to verified.
# ---------------------------------------------------------------------------
test_unverified_timeout_exits_1() {
  local addr="0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
  local exit_code
  MOCK_BASESCAN_UNVERIFIED="${addr}" \
    TIMEOUT_SECONDS=2 \
    POLL_INTERVAL_SECONDS=1 \
    bash "${SCRIPT}" "${addr}" 2>/dev/null \
    && exit_code=$? || exit_code=$?
  [[ ${exit_code} -eq 1 ]]
}

# ---------------------------------------------------------------------------
# Test: mixed — one verified, one unverified — timeout → exits 1
# ---------------------------------------------------------------------------
test_mixed_timeout_exits_1() {
  local addr_ok="0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  local addr_bad="0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
  local exit_code
  MOCK_BASESCAN_VERIFIED="${addr_ok}" \
    MOCK_BASESCAN_UNVERIFIED="${addr_bad}" \
    TIMEOUT_SECONDS=2 \
    POLL_INTERVAL_SECONDS=1 \
    bash "${SCRIPT}" "${addr_ok}" "${addr_bad}" 2>/dev/null \
    && exit_code=$? || exit_code=$?
  [[ ${exit_code} -eq 1 ]]
}

# ---------------------------------------------------------------------------
# Test: logs unverified address on timeout
# ---------------------------------------------------------------------------
test_unverified_timeout_logs_address() {
  local addr="0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"
  local output
  output=$(MOCK_BASESCAN_UNVERIFIED="${addr}" \
    TIMEOUT_SECONDS=2 \
    POLL_INTERVAL_SECONDS=1 \
    bash "${SCRIPT}" "${addr}" 2>&1) || true
  echo "${output}" | grep -q "UNVERIFIED.*${addr}"
}

# ---------------------------------------------------------------------------
# Test: invalid NETWORK → exits 1 (fail / usage error)
# ---------------------------------------------------------------------------
test_invalid_network_exits_nonzero() {
  local addr="0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  local exit_code
  MOCK_BASESCAN_VERIFIED="${addr}" \
    NETWORK=unknown-chain \
    bash "${SCRIPT}" "${addr}" 2>/dev/null \
    && exit_code=$? || exit_code=$?
  [[ ${exit_code} -ne 0 ]]
}

# ---------------------------------------------------------------------------
# Test: base-sepolia network accepted (exits 0 when mock-verified)
# ---------------------------------------------------------------------------
test_base_sepolia_network_ok() {
  local addr="0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  local exit_code
  MOCK_BASESCAN_VERIFIED="${addr}" \
    NETWORK=base-sepolia \
    TIMEOUT_SECONDS=5 \
    POLL_INTERVAL_SECONDS=1 \
    bash "${SCRIPT}" "${addr}" 2>/dev/null \
    && exit_code=$? || exit_code=$?
  [[ ${exit_code} -eq 0 ]]
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
run_test "no_addresses_exits_2"                test_no_addresses_exits_2
run_test "all_verified_exits_0"                test_all_verified_exits_0
run_test "single_verified_exits_0"             test_single_verified_exits_0
run_test "unverified_timeout_exits_1"          test_unverified_timeout_exits_1
run_test "mixed_timeout_exits_1"               test_mixed_timeout_exits_1
run_test "unverified_timeout_logs_address"     test_unverified_timeout_logs_address
run_test "invalid_network_exits_nonzero"       test_invalid_network_exits_nonzero
run_test "base_sepolia_network_ok"             test_base_sepolia_network_ok

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [[ ${FAIL} -gt 0 ]]; then
  exit 1
fi
