#!/usr/bin/env bash
# Canonical: docs/operations/contract-release-runbooks.md (Recorder keeper).
# Mandatory real Base state test. All sends target a private local anvil fork.
set -euo pipefail
: "${BASE_FORK_RPC_URL:?FAIL: BASE_FORK_RPC_URL is required}"
for bin in anvil cast forge python3; do command -v "$bin" >/dev/null || { echo "FAIL: missing $bin"; exit 1; }; done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
export RPC_URL="http://127.0.0.1:${ANVIL_PORT:-18699}"
PIN="${BASE_FORK_BLOCK:-$(cast block-number --rpc-url "$BASE_FORK_RPC_URL") }"
PIN="${PIN// /}"
echo "Base fork pin=$PIN; upstream reads only, local transactions only"
anvil --fork-url "$BASE_FORK_RPC_URL" --fork-block-number "$PIN" --chain-id 918453 --port "${ANVIL_PORT:-18699}" --silent >"$WORK/anvil.log" 2>&1 &
PID=$!
for _ in $(seq 1 100); do cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep .2; done
[[ "$(cast chain-id --rpc-url "$RPC_URL")" == 918453 ]] || { echo 'FAIL: local fork unavailable'; exit 1; }
export RECORDER_ADDRESS=0x0aDc14e6521aF213F9DCe5585D530f237831E934
[[ "$(cast code "$RECORDER_ADDRESS" --rpc-url "$RPC_URL")" != 0x ]] || { echo 'FAIL: deployed recorder missing'; exit 1; }
printf '%s\n' keeper-fork-test >"$WORK/pw"
chmod 600 "$WORK/pw"
mkdir "$WORK/ks"
cast wallet new "$WORK/ks" keeper --unsafe-password keeper-fork-test >/dev/null 2>&1
export KEEPER_KEYSTORE="$WORK/ks/keeper" KEEPER_PASSWORD_FILE="$WORK/pw"
ADDR="$(cast wallet address --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE")"
cast rpc anvil_setBalance "$ADDR" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null
cat >"$WORK/sleep" <<'SLEEP'
#!/usr/bin/env bash
cast rpc evm_increaseTime "$1" --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
SLEEP
chmod +x "$WORK/sleep"
export SLEEP_CMD="$WORK/sleep" CATCHUP_INTERVAL_SECS=120
# Seed a historical recorder tick 1500 ticks behind the real live pool, preserving
# the deployed ring and all pool/vault state. This models an unobserved price move.
# Observation[65535] occupies slots 0..65534; State.lastTick is low int24 at 65535.
STATE="$(cast storage "$RECORDER_ADDRESS" 65535 --rpc-url "$RPC_URL")"
LIVE="$(cast call "$RECORDER_ADDRESS" 'slot0()(uint160,int24,uint16,uint16)' --rpc-url "$RPC_URL" | sed -n 2p | awk '{print $1}')"
SEEDED="$(python3 - "$STATE" "$LIVE" <<'PYSEED'
import sys
word=int(sys.argv[1],16)
tick=int(sys.argv[2])-1500
print('0x'+format((word & ~((1<<24)-1)) | (tick & ((1<<24)-1)), '064x'))
PYSEED
)"
cast rpc anvil_setStorageAt "$RECORDER_ADDRESS" "$(cast to-uint256 65535)" "$SEEDED" --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_increaseTime 172800 --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
[[ "$(cast call "$RECORDER_ADDRESS" 'isFresh()(bool)' --rpc-url "$RPC_URL")" == false ]]
set +e
bash "$ROOT/scripts/ops/recorder-keeper.sh" --once 2>"$WORK/keeper.log"
RC=$?
set -e
cat "$WORK/keeper.log"
[[ "$(grep -c 'deviation .* ticks after' "$WORK/keeper.log")" -ge 3 ]]
[[ $RC == 1 ]]
grep '"alert":"recorder_stale"' "$WORK/keeper.log"
if grep -E 'record_failed|recorder_unreadable|deviation_not_converged' "$WORK/keeper.log"; then exit 1; fi
[[ "$(cast call "$RECORDER_ADDRESS" 'isFresh()(bool)' --rpc-url "$RPC_URL")" == true ]]
cd "$ROOT"
KEEPER_FORK_RPC_URL="$RPC_URL" FOUNDRY_TEST=scripts/ops/integration forge test --match-contract RecorderKeeperDepositTest -vv | tee "$WORK/assertions.log"
grep -q '1 tests passed, 0 failed, 0 skipped (1 total tests)' "$WORK/assertions.log" || { echo 'FAIL: real guard/deposit assertion did not execute'; exit 1; }
