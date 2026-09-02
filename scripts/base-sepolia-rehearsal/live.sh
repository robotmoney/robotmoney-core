#!/usr/bin/env bash
# Canonical: docs/operations/base-sepolia-deployment.md — live rehearsal
# Implements: issue #1303 test plan 2 — the full ceremony against real Base
#             Sepolia with a funded test key, recording addresses and gas used.
#             Nightly / dispatch only; NEVER on pull_request.
#
# SECRET POLICY: when the required live inputs are absent this script FAILS
# LOUDLY — non-zero exit, a message naming every missing variable, and a
# diagnostics block (RPC reachability, chain id, deployer balance) an agent can
# use to debug. It never silently skips and never reports green without the
# live ceremony having run. This is the repo's loud-skip invariant applied to
# an ops script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="${BASE_SEPOLIA_REHEARSAL_OUT_DIR:-/tmp/base-sepolia-rehearsal-live}"
RECORD_PATH="${BASE_SEPOLIA_REHEARSAL_RECORD:-$REPO_ROOT/deployments/base-sepolia.json}"

required_vars=(
  BASE_SEPOLIA_RPC_URL
  BASE_SEPOLIA_DEPLOYER_KEY
  BASE_SEPOLIA_PAUSER_ADDRESS
  BASE_SEPOLIA_AGENT_ADDRESS
  BASE_SEPOLIA_SHARE_RECEIVER_ADDRESS
  BASE_SEPOLIA_EMERGENCY_ADDRESS
  BASE_SEPOLIA_SAFE_ADDRESS
  BASE_SEPOLIA_USDC_ADDRESS
  BASE_SEPOLIA_RECEIPT_ADMIN_ADDRESS
)

missing=()
for v in "${required_vars[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    missing+=("$v")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "FAIL: [live] base-sepolia rehearsal cannot run — required live inputs missing:" >&2
  for v in "${missing[@]}"; do
    echo "  - $v" >&2
  done
  echo "FAIL: [live] refusing to skip or fake the live rehearsal (loud-skip invariant)." >&2
  echo "  Provision these as GitHub Actions secrets/environment vars and re-dispatch." >&2
  exit 1
fi

RPC_URL="$BASE_SEPOLIA_RPC_URL"
DEPLOYER_KEY="$BASE_SEPOLIA_DEPLOYER_KEY"
CHAIN_ID=84532

export TIMELOCK_MIN_DELAY="${BASE_SEPOLIA_TIMELOCK_MIN_DELAY:-172800}"
export VOTING_PERIOD="${BASE_SEPOLIA_VOTING_PERIOD:-3600}"
export EXECUTION_DELAY="${BASE_SEPOLIA_EXECUTION_DELAY:-3600}"
export QUORUM_THRESHOLD="${BASE_SEPOLIA_QUORUM_THRESHOLD:-2}"

echo "==> [live] diagnostics begin (an agent can debug from this output)"
DEPLOYER_ADDRESS="$(cast wallet address "$DEPLOYER_KEY")" \
  || { echo "FAIL: [live] cannot derive deployer address from BASE_SEPOLIA_DEPLOYER_KEY" >&2; exit 1; }
echo "==> [live] deployer: $DEPLOYER_ADDRESS"

if [[ -z "${BASE_SEPOLIA_ADMIN_ADDRESS:-}" ]]; then
  ADMIN_ADDRESS="$DEPLOYER_ADDRESS"
  echo "==> [live] BASE_SEPOLIA_ADMIN_ADDRESS unset; using deployer ($ADMIN_ADDRESS) as admin (the ceremony broadcasts as the deployer)"
else
  ADMIN_ADDRESS="$BASE_SEPOLIA_ADMIN_ADDRESS"
fi

RPC_CID="$(cast chain-id --rpc-url "$RPC_URL")" \
  || { echo "FAIL: [live] RPC unreachable or did not answer chain-id: $RPC_URL" >&2; exit 1; }
if [[ "$RPC_CID" != "$CHAIN_ID" ]]; then
  echo "FAIL: [live] RPC reports chain id $RPC_CID, expected Base Sepolia ($CHAIN_ID) — refusing to broadcast" >&2
  exit 1
fi
echo "==> [live] RPC chain id: $RPC_CID ✓"

ETH_BAL="$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL")"
echo "==> [live] deployer ETH balance (wei): $ETH_BAL"
if (( ETH_BAL == 0 )); then
  echo "FAIL: [live] deployer has no ETH on Base Sepolia — fund it from the faucet before the rehearsal" >&2
  exit 1
fi
USDC_BAL="$(cast call "$BASE_SEPOLIA_USDC_ADDRESS" "balanceOf(address)(uint256)" "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL")"
echo "==> [live] deployer USDC balance (6dp): $USDC_BAL"
if (( USDC_BAL < 1000000000 )); then
  echo "FAIL: [live] deployer holds < 1,000 USDC; Deploy.s.sol's mandatory 1,000-USDC seed deposit will fail" >&2
  exit 1
fi
echo "==> [live] diagnostics end"

mkdir -p "$OUT_DIR"
"$REPO_ROOT/scripts/base-sepolia-rehearsal/rehearsal.sh" \
  --rpc-url "$RPC_URL" \
  --chain-id "$CHAIN_ID" \
  --deployer-key "$DEPLOYER_KEY" \
  --admin "$ADMIN_ADDRESS" \
  --pauser "$BASE_SEPOLIA_PAUSER_ADDRESS" \
  --agent "$BASE_SEPOLIA_AGENT_ADDRESS" \
  --share-receiver "$BASE_SEPOLIA_SHARE_RECEIVER_ADDRESS" \
  --emergency "$BASE_SEPOLIA_EMERGENCY_ADDRESS" \
  --safe "$BASE_SEPOLIA_SAFE_ADDRESS" \
  --usdc "$BASE_SEPOLIA_USDC_ADDRESS" \
  --receipt-admin "$BASE_SEPOLIA_RECEIPT_ADMIN_ADDRESS" \
  --out-dir "$OUT_DIR" \
  --record "$RECORD_PATH" \
  --live

echo "OK: [live] Base Sepolia rehearsal completed; record at $RECORD_PATH"
