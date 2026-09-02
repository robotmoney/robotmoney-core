#!/usr/bin/env bash
# Canonical: docs/operations/base-sepolia-deployment.md — dry-run rehearsal
# Implements: issue #1303 test plan 1 — the full ceremony script sequence
#             against a fresh local fork, asserting order and postconditions,
#             runnable per-PR with NO network dependency and NO secrets.
#
# Boots a local anvil from the checked-in golden Base fork fixture
# (testing/fixtures/fork-state/CURRENT.anvil-state, ADR-0011) at the Base
# Sepolia chain id 84532, replays the canonical USDC proxy storage seed (the
# same steps boot-fork-state-anvil.sh performs for the opencode headless
# suite), funds the deployer with ETH + USDC, then runs the shared ceremony
# driver (rehearsal.sh) against it. Tears the anvil down on exit, even on
# failure.
#
# This is the rehearsal of the mechanics: the fork fixture is Base MAINNET
# state, so the adapters' protocol addresses resolve, and the deploy order,
# postconditions, size guards, and record format are what get exercised.
# It sends no transactions anywhere real.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/testing/fixtures/fork-state"
STATE_FILE="$FIXTURE_DIR/CURRENT.anvil-state"
USDC_SEED="$FIXTURE_DIR/usdc-storage-seed.json"

ANVIL_PORT="${BASE_SEPOLIA_REHEARSAL_ANVIL_PORT:-8645}"
RPC_URL="http://127.0.0.1:$ANVIL_PORT"
CHAIN_ID="${BASE_SEPOLIA_REHEARSAL_CHAIN_ID:-84532}"
# Canonical Base mainnet USDC — the fixture's seeded token (the dry-run forks
# mainnet state; the live base-sepolia run passes the Sepolia USDC explicitly).
FIXTURE_USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_BALANCE_SLOT_INDEX=9
SEED_FUND_USDC_UNITS=2000000000 # 2,000 USDC (6dp) — covers Deploy.s.sol's 1,000-USDC seed deposit

OUT_DIR="${BASE_SEPOLIA_REHEARSAL_OUT_DIR:-/tmp/base-sepolia-rehearsal}"
RECORD="$OUT_DIR/base-sepolia.json"
MISORDER_OUT="$OUT_DIR/misordered-router.json"

# Anvil dev account #0 — the deployer for the throwaway fork.
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"

for tool in anvil cast curl jq python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FAIL: required tool '$tool' not on PATH" >&2; exit 1; }
done
for f in "$STATE_FILE" "$USDC_SEED"; do
  [ -f "$f" ] || { echo "FAIL: fork-state fixture missing: $f" >&2; exit 1; }
done

echo "==> [dry-run] booting anvil --load-state $STATE_FILE --chain-id $CHAIN_ID on port $ANVIL_PORT"
anvil --port "$ANVIL_PORT" --load-state "$STATE_FILE" --chain-id "$CHAIN_ID" \
  >"$OUT_DIR"/anvil.log 2>&1 &
ANVIL_PID=$!

for _ in $(seq 1 30); do
  cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
  sleep 1
done
cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 \
  || { echo "FAIL: anvil did not become ready; log:" >&2; cat "$OUT_DIR"/anvil.log >&2; exit 1; }

LIVE_CID="$(cast chain-id --rpc-url "$RPC_URL")"
[ "$LIVE_CID" = "$CHAIN_ID" ] \
  || { echo "FAIL: live chain-id $LIVE_CID != $CHAIN_ID" >&2; exit 1; }

echo "==> [dry-run] applying USDC proxy storage seed (canonical boot-fork-state-anvil.sh pattern)"
while IFS=$'\t' read -r slot value; do
  cast rpc anvil_setStorageAt "$FIXTURE_USDC" "$slot" "$value" --rpc-url "$RPC_URL" >/dev/null
done < <(jq -r '.proxy.storage | to_entries[] | "\(.key)\t\(.value)"' "$USDC_SEED")
IMPL_ADDR="$(jq -r '.implementation.address' "$USDC_SEED")"
IMPL_CODE="$(jq -r '.implementation.code' "$USDC_SEED")"
cast rpc anvil_setCode "$IMPL_ADDR" "$IMPL_CODE" --rpc-url "$RPC_URL" >/dev/null

# Advance next-block timestamp to wall-clock now so Aave's
# getReserveNormalizedIncome math stays monotonic (issue #656).
NOW_TS="$(date +%s)"
cast rpc evm_setNextBlockTimestamp "$NOW_TS" --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null

echo "==> [dry-run] funding deployer $DEPLOYER_ADDRESS with ETH + USDC"
cast rpc anvil_setBalance "$DEPLOYER_ADDRESS" "0xde0b6b3a7640000" --rpc-url "$RPC_URL" >/dev/null  # 1 ETH
FUND_BAL_HEX="$(cast to-uint256 "$SEED_FUND_USDC_UNITS")"
SLOT="$(cast index address "$DEPLOYER_ADDRESS" "$USDC_BALANCE_SLOT_INDEX")"
cast rpc anvil_setStorageAt "$FIXTURE_USDC" "$SLOT" "$FUND_BAL_HEX" --rpc-url "$RPC_URL" >/dev/null
USDC_BAL="$(cast call "$FIXTURE_USDC" "balanceOf(address)(uint256)" "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL")"
echo "==> [dry-run] deployer USDC balance: $USDC_BAL"

echo "==> [dry-run] running the shared ceremony driver"
"$REPO_ROOT/scripts/base-sepolia-rehearsal/rehearsal.sh" \
  --rpc-url "$RPC_URL" \
  --chain-id "$CHAIN_ID" \
  --deployer-key "$DEPLOYER_KEY" \
  --admin "$DEPLOYER_ADDRESS" \
  --usdc "$FIXTURE_USDC" \
  --out-dir "$OUT_DIR" \
  --record "$RECORD"

echo "==> [dry-run] ceremony completed; record at $RECORD"
python3 "$REPO_ROOT/.github/scripts/check_base_sepolia_record.py" "$RECORD"

# Regression for the dependency order: DeployPortfolioRouter must not accept a
# registry that has not been deployed. Forge simulates the complete script
# before broadcast, so this expected failure cannot leave a partial router.
VAULT="$(jq -r '.vault' "$OUT_DIR/ceremony/deployment.json")"
UNDEPLOYED_REGISTRY="0x000000000000000000000000000000000000dEaD"
echo "==> [dry-run] asserting router-before-registry fails without broadcasting"
PRE_MISORDER_NONCE="$(cast nonce "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL")"
set +e
MISORDER_OUTPUT="$(env \
  ADMIN_ADDRESS="$DEPLOYER_ADDRESS" \
  REGISTRY_ADDRESS="$UNDEPLOYED_REGISTRY" \
  VAULT_ADDRESS="$VAULT" \
  USDC_ADDRESS="$FIXTURE_USDC" \
  DEPLOYMENT_OUT="$MISORDER_OUT" \
  forge script contracts/script/DeployPortfolioRouter.s.sol:DeployPortfolioRouter \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast --slow -vvv \
  --chain-id "$CHAIN_ID" 2>&1)"
MISORDER_STATUS=$?
set -e
if [[ $MISORDER_STATUS -eq 0 ]]; then
  echo "$MISORDER_OUTPUT" >&2
  echo "FAIL: [dry-run] router-before-registry unexpectedly succeeded" >&2
  exit 1
fi
if ! grep -Eqi 'NotRegistered|revert|decode|postcondition' <<<"$MISORDER_OUTPUT"; then
  echo "$MISORDER_OUTPUT" >&2
  echo "FAIL: [dry-run] router-before-registry failed without a recognizable registry postcondition error" >&2
  exit 1
fi
[[ ! -f "$MISORDER_OUT" ]] || {
  echo "FAIL: [dry-run] router-before-registry wrote $MISORDER_OUT despite failing" >&2
  exit 1
}
POST_MISORDER_NONCE="$(cast nonce "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL")"
[[ "$POST_MISORDER_NONCE" == "$PRE_MISORDER_NONCE" ]] || {
  echo "FAIL: [dry-run] router-before-registry broadcast transaction(s): nonce $PRE_MISORDER_NONCE -> $POST_MISORDER_NONCE" >&2
  exit 1
}
echo "OK: [dry-run] router-before-registry failed before a partial deployment"
echo "OK: [dry-run] rehearsed the full ceremony offline; every postcondition held"
