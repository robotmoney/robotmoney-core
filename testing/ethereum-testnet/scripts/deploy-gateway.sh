#!/usr/bin/env bash
# Deploy the RobotMoney gateway stack to the Geth devnet container.
#
# Reads pre-funded test accounts from the docker-compose harness defaults
# (see testing/ethereum-testnet/typescript-sdk/src/index.ts:getTestAccounts).
# Uses pre-funded account 0 as the deployer + ADMIN, account 1 as PAUSER,
# account 2 as AGENT, account 3 as SHARE_RECEIVER. Distinct EOAs by
# construction — matches the role-separation invariant.
#
# Output: deployments/<chain_id>.json at the repo root, consumed by
# rmpd config + downstream tests (issues #14/#15/#16).
#
# Usage:
#   testing/ethereum-testnet/scripts/deploy-gateway.sh [RPC_URL]
#
# RPC_URL defaults to http://127.0.0.1:8545 (the docker-compose port).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RPC_URL="${1:-${RPC_URL:-http://127.0.0.1:8545}}"

# Pre-funded testnet accounts (genesis).
DEPLOYER_PK="${ETHEREUM_DEPLOYER_PRIVATE_KEY:-REDACTED_PRIVATE_KEY}"
DEPLOYER_ADDR="${ETHEREUM_DEPLOYER_ADDRESS:-0x8943545177806ED17B9F23F0a21ee5948eCaa776}"

export ADMIN_ADDRESS="${ADMIN_ADDRESS:-${DEPLOYER_ADDR}}"
export PAUSER_ADDRESS="${PAUSER_ADDRESS:-0x71bE63f3384f5fb98995898A86B02Fb2426c5788}"
export AGENT_ADDRESS="${AGENT_ADDRESS:-0xFABB0ac9d68B0B445fB7357272Ff202C5651694a}"
export SHARE_RECEIVER_ADDRESS="${SHARE_RECEIVER_ADDRESS:-0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec}"

mkdir -p "${REPO_ROOT}/deployments"
export DEPLOYMENT_OUT="${DEPLOYMENT_OUT:-${REPO_ROOT}/deployments/devnet.json}"

# Wait for RPC.
echo "[deploy-gateway] waiting for RPC at ${RPC_URL}"
for i in $(seq 1 60); do
  if curl -fsS -X POST -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
      "${RPC_URL}" >/dev/null 2>&1; then
    echo "[deploy-gateway] RPC up"
    break
  fi
  sleep 2
done

cd "${REPO_ROOT}"

echo "[deploy-gateway] running forge script"
forge script contracts/script/Deploy.s.sol:Deploy \
  --rpc-url "${RPC_URL}" \
  --private-key "${DEPLOYER_PK}" \
  --broadcast \
  --slow \
  -vvv

echo "[deploy-gateway] deployment JSON:"
cat "${DEPLOYMENT_OUT}"

# --- Smoke: read gateway view fns via cast call (no signed tx required) -----
GATEWAY_ADDR="$(jq -r .gateway "${DEPLOYMENT_OUT}")"
USDC_ADDR="$(jq -r .usdc "${DEPLOYMENT_OUT}")"
VAULT_ADDR="$(jq -r .vault "${DEPLOYMENT_OUT}")"

echo "[deploy-gateway] smoke: cast call gateway.usdc()"
SMOKE_USDC="$(cast call --rpc-url "${RPC_URL}" "${GATEWAY_ADDR}" 'usdc()(address)')"
echo "  -> ${SMOKE_USDC}"

echo "[deploy-gateway] smoke: cast call gateway.vault()"
SMOKE_VAULT="$(cast call --rpc-url "${RPC_URL}" "${GATEWAY_ADDR}" 'vault()(address)')"
echo "  -> ${SMOKE_VAULT}"

# Normalise to lowercase for compare.
norm() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
if [[ "$(norm "${SMOKE_USDC}")" != "$(norm "${USDC_ADDR}")" ]]; then
  echo "[deploy-gateway] FAIL: gateway.usdc() != deployed USDC" >&2
  exit 1
fi
if [[ "$(norm "${SMOKE_VAULT}")" != "$(norm "${VAULT_ADDR}")" ]]; then
  echo "[deploy-gateway] FAIL: gateway.vault() != deployed Vault" >&2
  exit 1
fi
echo "[deploy-gateway] OK"
