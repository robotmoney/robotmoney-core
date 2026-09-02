#!/usr/bin/env bash
# Run the nightly live-Base drift alarm without mistaking RPC outages for drift.
#
# Exit codes: 0 = all selected tests executed and passed; 10 = Base drift;
# 20 = provider/RPC unavailable after retries; 30 = harness/no-test failure.
set -euo pipefail

RPC_URL="${FORK_RPC_URL:-${RMPC_FORK_RPC_URL:-}}"
RETRIES="${FORK_DRIFT_RETRIES:-3}"
RETRY_DELAY_SECONDS="${FORK_DRIFT_RETRY_DELAY_SECONDS:-5}"
CURL_BIN="${CURL_BIN:-curl}"
FORGE_BIN="${FORGE_BIN:-forge}"

[[ -n "$RPC_URL" ]] || { echo "ERROR: FORK_RPC_URL must be set for live drift detection" >&2; exit 20; }
[[ "$RETRIES" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: FORK_DRIFT_RETRIES must be a positive integer" >&2; exit 30; }

record_classification() {
  local classification="$1"
  echo "live-fork-classification=${classification}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "classification=${classification}" >>"$GITHUB_OUTPUT"
  fi
}

is_provider_failure() {
  # These are transport/provider diagnostics, not EVM assertion failures. Keep
  # this intentionally limited: an unrecognised test failure is safer treated
  # as drift than silently discarded.
  grep -Eiq \
    '429|rate limit|too many requests|5(02|03|04)|bad gateway|service unavailable|gateway timeout|connection (refused|reset|timed out)|could not connect|failed to connect|error (sending|trying to send) request|request error|dns|name or service not known|network is unreachable|rpc.*(timeout|unavailable|transport)|timeout|timed out' \
    "$1"
}

is_harness_failure() {
  # A local compile/configuration failure also cannot establish Base drift. It
  # remains red in the nightly job, but must not create an upstream-drift issue.
  grep -Eiq \
    'compiler run failed|compilation (failed|error)|no tests (found|matched)|failed to parse|unknown (argument|option)|invalid (argument|value)' \
    "$1"
}

retry_pause() {
  [[ "$RETRY_DELAY_SECONDS" = "0" ]] || sleep "$RETRY_DELAY_SECONDS"
}

preflight_rpc() {
  local attempt log status
  for attempt in $(seq 1 "$RETRIES"); do
    log="$(mktemp)"
    set +e
    "$CURL_BIN" --fail --silent --show-error --max-time 20 \
      -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
      "$RPC_URL" >"$log" 2>&1
    status=$?
    set -e
    if [[ "$status" -eq 0 ]] && grep -Eq '"result"[[:space:]]*:' "$log"; then
      rm -f "$log"
      return 0
    fi
    echo "[live-fork-drift] RPC preflight attempt ${attempt}/${RETRIES} failed" >&2
    cat "$log" >&2
    rm -f "$log"
    [[ "$attempt" -lt "$RETRIES" ]] && retry_pause
  done
  return 1
}

run_suite() {
  local description="$1"
  shift
  local attempt log status count
  for attempt in $(seq 1 "$RETRIES"); do
    log="$(mktemp)"
    set +e
    "$FORGE_BIN" test --json "$@" >"$log" 2>&1
    status=$?
    set -e
    if [[ "$status" -eq 0 ]]; then
      count="$(jq '[.. | objects | select(has("status"))] | length' "$log")"
      if [[ "$count" -gt 0 ]]; then
        echo "[live-fork-drift] ${description}: executed ${count} test(s)"
        rm -f "$log"
        return 0
      fi
      echo "ERROR: ${description}: forge succeeded but executed zero tests" >&2
      cat "$log" >&2
      rm -f "$log"
      return 30
    fi
    if is_provider_failure "$log"; then
      echo "[live-fork-drift] ${description}: provider failure on attempt ${attempt}/${RETRIES}" >&2
      cat "$log" >&2
      rm -f "$log"
      [[ "$attempt" -lt "$RETRIES" ]] && retry_pause && continue
      return 20
    fi
    if is_harness_failure "$log"; then
      echo "[live-fork-drift] ${description}: local harness failure" >&2
      cat "$log" >&2
      rm -f "$log"
      return 30
    fi
    echo "[live-fork-drift] ${description}: test failure (Base drift candidate)" >&2
    cat "$log" >&2
    rm -f "$log"
    return 10
  done
}

if ! preflight_rpc; then
  record_classification provider
  exit 20
fi

run_suite 'VaultForkRegressions' --match-path 'contracts/test/VaultForkRegressions.t.sol' || status=$?
if [[ "${status:-0}" -eq 0 ]]; then
  run_suite 'DeploySeedDeposit' --match-contract 'DeploySeedDeposit' || status=$?
fi
if [[ "${status:-0}" -eq 0 ]]; then
  run_suite 'SafeIntegration' --match-path 'contracts/test/SafeIntegration.t.sol' || status=$?
fi

case "${status:-0}" in
  0) record_classification passed; exit 0 ;;
  10) record_classification drift; exit 10 ;;
  20) record_classification provider; exit 20 ;;
  *) record_classification harness; exit 30 ;;
esac
