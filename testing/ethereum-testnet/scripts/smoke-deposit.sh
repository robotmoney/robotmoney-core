#!/usr/bin/env bash
# Happy-path deposit smoke check using `cast send` only — no Rust client.
#
# Confirms the stack end-to-end:
#   1. agent.approve(gateway, amount)
#   2. gateway.deposit(orderId, amount, deadline, idempotencyKey)
#   3. assert one AgentDeposit event was emitted.
#
# Reads the deployment JSON written by Deploy.s.sol.
#
# Usage:
#   testing/ethereum-testnet/scripts/smoke-deposit.sh [RPC_URL] [DEPLOYMENT_JSON]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RPC_URL="${1:-${RPC_URL:-http://127.0.0.1:8545}}"
DEPLOYMENT_JSON="${2:-${DEPLOYMENT_OUT:-${REPO_ROOT}/deployments/devnet.json}}"

if [[ ! -f "${DEPLOYMENT_JSON}" ]]; then
  echo "[smoke-deposit] missing ${DEPLOYMENT_JSON}; run deploy-gateway first" >&2
  exit 1
fi

GATEWAY="$(jq -r .gateway "${DEPLOYMENT_JSON}")"
USDC="$(jq -r .usdc "${DEPLOYMENT_JSON}")"
AGENT="$(jq -r .agent "${DEPLOYMENT_JSON}")"

# Account 2 in testing/ethereum-testnet/typescript-sdk/src/index.ts.
AGENT_PK="${AGENT_PRIVATE_KEY:-REDACTED_PRIVATE_KEY}"

AMOUNT="${SMOKE_AMOUNT:-1000000}"   # 1 USDC (6 decimals).
DEADLINE="$(($(date +%s) + 300))"
ORDER_ID="0x$(openssl rand -hex 32)"
IDEMP_KEY="0x$(openssl rand -hex 32)"

echo "[smoke-deposit] gateway=${GATEWAY} usdc=${USDC} agent=${AGENT}"
echo "[smoke-deposit] approving USDC -> gateway"
cast send --rpc-url "${RPC_URL}" --private-key "${AGENT_PK}" \
  "${USDC}" 'approve(address,uint256)' "${GATEWAY}" "${AMOUNT}" >/dev/null

echo "[smoke-deposit] gateway.deposit(${AMOUNT})"
TX_HASH="$(cast send --rpc-url "${RPC_URL}" --private-key "${AGENT_PK}" \
  --json "${GATEWAY}" \
  'deposit(bytes32,uint256,uint64,bytes32)' \
  "${ORDER_ID}" "${AMOUNT}" "${DEADLINE}" "${IDEMP_KEY}" \
  | jq -r .transactionHash)"

echo "[smoke-deposit] tx=${TX_HASH}"
RECEIPT="$(cast receipt --rpc-url "${RPC_URL}" --json "${TX_HASH}")"
STATUS="$(echo "${RECEIPT}" | jq -r .status)"

if [[ "${STATUS}" != "0x1" ]]; then
  echo "[smoke-deposit] FAIL: tx reverted (status=${STATUS})" >&2
  exit 1
fi

# AgentDeposit topic = keccak256("AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)")
DEPOSIT_TOPIC="$(cast keccak 'AgentDeposit(bytes32,bytes32,address,address,uint256,uint256,uint64)')"
LOG_COUNT="$(echo "${RECEIPT}" | jq --arg t "${DEPOSIT_TOPIC}" \
    '[.logs[] | select(.topics[0]==$t)] | length')"
if [[ "${LOG_COUNT}" -lt 1 ]]; then
  echo "[smoke-deposit] FAIL: no AgentDeposit event in receipt" >&2
  exit 1
fi

echo "[smoke-deposit] OK: 1 deposit confirmed end-to-end"
