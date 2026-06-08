#!/usr/bin/env bash
# geth-devnet-smoke.sh — Geth devnet smoke-test script stub
#
# STUB — issue #702 dev-scout. This script registers the seam for a standalone
# Bash-level smoke test of the Geth+Lighthouse devnet that can be run without
# the full Rust smoke-test harness. The Rust harness (testing/smoke-test) is
# the authoritative smoke-test for CI; this script provides a lightweight
# operator-facing health check for the running devnet (e.g. to validate that
# the docker compose stack is healthy before running a demo or pairing with an
# external client).
#
# INTEGRATION POINTS DISCOVERED BY SCOUT (issue #702)
# - The Geth RPC port defaults to 8545 but is overridable via SMOKE_TEST_GETH_RPC_PORT
#   (testing/smoke-test/src/lib.rs ChainPorts::allocate). This script should read the
#   same env var so operators can use a non-default port.
# - The compose project is hardcoded to "ethereum-testnet" in Fixture::new()
#   (testing/smoke-test/src/lib.rs, ~line 582). There is no env override for the
#   compose project name. If this ever changes, update both files in sync.
# - eth_chainId returns "0x2105" (8453 = Base) on the devnet (set in genesis config).
#   eth_blockNumber should be > 0 once consensus is finalised.
# - The deployer address is 0x8943545177806ED17B9F23F0a21ee5948eCaa776 (DEPLOYER_ADDRESS_HEX
#   in testing/smoke-test/src/lib.rs). Its ETH balance should be non-zero after genesis.
# - cast is required; it is installed alongside forge by the Foundry toolchain.
#   docker and docker compose are required to check container state.
#
# IMPLEMENTATION TODO (downstream issue)
# - Replace echo stubs with real cast calls and exit-code assertions.
# - Add a --rpc-url flag defaulting to http://127.0.0.1:${SMOKE_TEST_GETH_RPC_PORT:-8545}.
# - Emit structured output (PASS/FAIL per check) matching the format used by
#   scripts/devnet/check-fork-manifest.sh.
# - Wire into the CI suite-18 security-gates workflow (or a dedicated suite-20) once
#   the implementation is complete.
#
# Usage:
#   bash scripts/devnet/geth-devnet-smoke.sh
#   SMOKE_TEST_GETH_RPC_PORT=9545 bash scripts/devnet/geth-devnet-smoke.sh
set -euo pipefail

RPC_PORT="${SMOKE_TEST_GETH_RPC_PORT:-8545}"
RPC_URL="http://127.0.0.1:${RPC_PORT}"

echo "[geth-devnet-smoke] STUB — implementation pending (issue #702 downstream)"
echo "[geth-devnet-smoke] RPC target: ${RPC_URL}"

# ── Check: docker compose containers are running ─────────────────────────────
echo "[geth-devnet-smoke] TODO check docker compose ps for ethereum-testnet"
# Implementation:
#   docker compose -f testing/ethereum-testnet/config/docker-compose.yaml ps \
#     --format json | jq -e '.[].State == "running"'

# ── Check: Geth RPC responds to eth_chainId ──────────────────────────────────
echo "[geth-devnet-smoke] TODO assert eth_chainId == 0x2105 (Base)"
# Implementation:
#   CHAIN_ID=$(cast chain-id --rpc-url "${RPC_URL}")
#   [ "${CHAIN_ID}" = "8453" ] || { echo "FAIL: unexpected chainId ${CHAIN_ID}"; exit 1; }

# ── Check: block production is active (blockNumber > 0) ──────────────────────
echo "[geth-devnet-smoke] TODO assert eth_blockNumber > 0"
# Implementation:
#   BLOCK_NUM=$(cast block-number --rpc-url "${RPC_URL}")
#   [ "${BLOCK_NUM}" -gt 0 ] || { echo "FAIL: blockNumber is ${BLOCK_NUM}"; exit 1; }

# ── Check: deployer EOA has ETH balance ──────────────────────────────────────
DEPLOYER="0x8943545177806ED17B9F23F0a21ee5948eCaa776"
echo "[geth-devnet-smoke] TODO assert deployer ${DEPLOYER} has non-zero ETH balance"
# Implementation:
#   BALANCE=$(cast balance "${DEPLOYER}" --rpc-url "${RPC_URL}")
#   [ "${BALANCE}" != "0" ] || { echo "FAIL: deployer has zero ETH balance"; exit 1; }

echo "[geth-devnet-smoke] stub completed — no real checks were run"
exit 0
