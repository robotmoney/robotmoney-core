#!/usr/bin/env bash
# Canonical: docs/development/ci-suites.md §11 (opencode-headless)
#
# Boot a local Anvil from the checked-in warmed Base fork-state fixture
# (testing/fixtures/fork-state/CURRENT.anvil-state) so the three REAL
# Aave V3 / Compound V3 / Morpho adapters have live protocol storage to
# call. This replaces the historical bare `anvil &` boot that forced the
# now-deleted test-only no-yield deploy hatch (issue #912).
#
# This mirrors testing/fork-e2e-rust/src/lib.rs::ForkFixture (the canonical
# --load-state consumer) and scripts/devnet/snapshot-fork.sh:
#   1. anvil --load-state CURRENT.anvil-state --chain-id <devnet pin>
#   2. Replay the canonical Base USDC proxy storage seed + implementation
#      bytecode (usdc-storage-seed.json) so the forked FiatTokenProxy behaves
#      like the production token (issue #249).
#   3. Advance the next-block timestamp to wall-clock now so Aave's
#      getReserveNormalizedIncome math stays monotonic (issue #656).
#   4. Fund each requested address with USDC by writing the FiatToken
#      balances slot directly (slot 9) — no whale impersonation, hermetic.
#
# CHAIN ID: the devnet runs at the synthetic dev chain id 918453 — the same id
# the Geth+Lighthouse smoke-test devnet uses (testing/ethereum-testnet/config) —
# NOT the fixture's source chain id 8453. rmpc classifies chain id 8453 as
# `production_base` and HARD-REFUSES software-keystore writes there
# (ErrProductionSignerRequired, clients/rust-payment-client/src/network_env.rs +
# signer/mod.rs); the opencode-headless deposit job signs with a software
# keystore, so booting at 8453 makes every deposit refuse before broadcast.
# The forked Aave V3 / Compound V3 / Morpho contracts do not depend on
# block.chainid for deposits, so re-stamping the runtime chain id is safe and
# keeps the real protocol storage intact. The fixture's CURRENT.json.chain_id
# (8453) still records the SOURCE chain for fork-state alignment checks.
#
# Usage:
#   scripts/devnet/boot-fork-state-anvil.sh <rpc_url> <fund_addr> [<fund_addr> ...]
# e.g.
#   scripts/devnet/boot-fork-state-anvil.sh http://127.0.0.1:8545 0xAdmin 0xAgent
#
# Anvil must already be installed on PATH. This script starts anvil in the
# background, waits for it to be ready, applies the seed/funding, then prints
# the canonical USDC address on stdout (so the caller can export USDC_ADDRESS).
#
# Each funded address receives 2,000 USDC (6 decimals) — comfortably covers
# the Deploy.s.sol 1,000-USDC seed deposit plus a headless 1-USDC deposit.
set -euo pipefail

RPC_URL="${1:?usage: boot-fork-state-anvil.sh <rpc_url> <fund_addr>...}"
shift
FUND_ADDRS=("$@")

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/testing/fixtures/fork-state"
STATE_FILE="$FIXTURE_DIR/CURRENT.anvil-state"
META_FILE="$FIXTURE_DIR/CURRENT.json"
USDC_SEED="$FIXTURE_DIR/usdc-storage-seed.json"

# Canonical Base mainnet USDC (FiatTokenProxy).
USDC_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
# FiatTokenV2_x balances mapping lives at storage slot 9.
USDC_BALANCE_SLOT_INDEX=9
# Fund 2,000 USDC (6 decimals) per address.
FUND_USDC_UNITS=2000000000

for f in "$STATE_FILE" "$META_FILE" "$USDC_SEED"; do
  [ -f "$f" ] || { echo "FAIL: fork-state fixture missing: $f" >&2; exit 1; }
done
for tool in anvil cast jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: required tool '$tool' not on PATH" >&2; exit 1; }
done

# Port from the RPC URL (default 8545).
ANVIL_PORT="${RPC_URL##*:}"
ANVIL_PORT="${ANVIL_PORT%%/*}"
[[ "$ANVIL_PORT" =~ ^[0-9]+$ ]] || ANVIL_PORT=8545

# Source chain id recorded in the fixture (8453). Used only to sanity-check
# the fixture metadata is well-formed; the devnet does NOT run at this id.
SOURCE_CHAIN_ID="$(jq -r '.chain_id' "$META_FILE")"
[[ "$SOURCE_CHAIN_ID" =~ ^[0-9]+$ ]] || { echo "FAIL: CURRENT.json has no numeric chain_id" >&2; exit 1; }

# Synthetic dev chain id the devnet actually runs at (non-production, so rmpc
# permits software-keystore writes). Matches the Geth smoke-test devnet.
DEVNET_CHAIN_ID=918453

echo "[fork-anvil] booting anvil --load-state $STATE_FILE --chain-id $DEVNET_CHAIN_ID (source $SOURCE_CHAIN_ID) on port $ANVIL_PORT" >&2
anvil --port "$ANVIL_PORT" --load-state "$STATE_FILE" --chain-id "$DEVNET_CHAIN_ID" \
  >/tmp/fork-anvil.log 2>&1 &

# Wait for the RPC to come up.
for _ in $(seq 1 30); do
  cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
  sleep 1
done
cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 \
  || { echo "FAIL: anvil did not become ready; log:" >&2; cat /tmp/fork-anvil.log >&2; exit 1; }

# Confirm anvil stamped the requested dev chain id (a mismatch would silently
# re-classify the network and either re-trigger the production write refusal or
# desync the rmpc config's pinned chain_id).
LIVE_CID="$(cast chain-id --rpc-url "$RPC_URL")"
[ "$LIVE_CID" = "$DEVNET_CHAIN_ID" ] \
  || { echo "FAIL: live chain-id $LIVE_CID != devnet chain id $DEVNET_CHAIN_ID" >&2; exit 1; }

# --- 1. Replay the canonical Base USDC proxy storage seed + impl bytecode ---
# The --load-state fixture captures the proxy runtime bytecode but not its
# admin/impl/config storage; without this seed every non-admin selector
# reverts with the proxy-admin collision (issue #249).
echo "[fork-anvil] applying USDC proxy storage seed" >&2
while IFS=$'\t' read -r slot value; do
  cast rpc anvil_setStorageAt "$USDC_ADDRESS" "$slot" "$value" --rpc-url "$RPC_URL" >/dev/null
done < <(jq -r '.proxy.storage | to_entries[] | "\(.key)\t\(.value)"' "$USDC_SEED")

IMPL_ADDR="$(jq -r '.implementation.address' "$USDC_SEED")"
IMPL_CODE="$(jq -r '.implementation.code' "$USDC_SEED")"
cast rpc anvil_setCode "$IMPL_ADDR" "$IMPL_CODE" --rpc-url "$RPC_URL" >/dev/null

# Regression guard: proxy admin slot (keccak256("org.zeppelinos.proxy.admin"),
# see testing/fork-e2e-rust USDC_PROXY_ADMIN_SLOT) must now be set.
ADMIN_SLOT="0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b"
ADMIN_AFTER="$(cast storage "$USDC_ADDRESS" "$ADMIN_SLOT" --rpc-url "$RPC_URL")"
if [ "$ADMIN_AFTER" = "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
  echo "FAIL: USDC proxy admin slot still zero after seed (issue #249)" >&2
  exit 1
fi

# --- 2. Advance next-block timestamp to wall-clock now (Aave index math) ---
NOW_TS="$(date +%s)"
echo "[fork-anvil] advancing next-block timestamp to $NOW_TS" >&2
cast rpc evm_setNextBlockTimestamp "$NOW_TS" --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null

# --- 3. Fund requested addresses with USDC via the balances slot ---
FUND_BAL_HEX="$(cast to-uint256 "$FUND_USDC_UNITS")"
for addr in "${FUND_ADDRS[@]}"; do
  [ -n "$addr" ] || continue
  SLOT="$(cast index address "$addr" "$USDC_BALANCE_SLOT_INDEX")"
  cast rpc anvil_setStorageAt "$USDC_ADDRESS" "$SLOT" "$FUND_BAL_HEX" --rpc-url "$RPC_URL" >/dev/null
  echo "[fork-anvil] funded $addr with $FUND_USDC_UNITS USDC" >&2
done

# Print the canonical USDC address on stdout for the caller to capture.
echo "$USDC_ADDRESS"
