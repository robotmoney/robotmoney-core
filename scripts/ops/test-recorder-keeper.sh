#!/usr/bin/env bash
# Canonical: docs/operations/contract-release-runbooks.md ("Recorder keeper")
# Self-test for scripts/ops/recorder-keeper.sh (core issue 1779).
#
# Runs the real keeper against a real UniswapV4PriceRecorder on a local anvil chain. The pool is the repo's
# MockV4PoolManager, which stores the pool state where the real PoolManager does, so the recorder reads it the
# same way. Chain time moves with evm_increaseTime. This test FAILS LOUDLY when anvil, forge or cast is absent.
#
# Cases:
#   1. 2-day gap and a live price 1500 ticks away: the keeper alerts recorder_stale, calls record() until the
#      deviation is inside the limit, and the recorder is fresh.
#   2. A fresh recorder close to the live price: one call, no alert, exit 0.
#   3. A recorder that cannot be read: the keeper alerts and exits 1.
#   4. A webhook receives the alert body.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEPER="$REPO_ROOT/scripts/ops/recorder-keeper.sh"
for bin in anvil forge cast python3 curl; do
    command -v "$bin" >/dev/null || { echo "FAIL: $bin is not installed"; exit 1; }
done

WORK="$(mktemp -d)"
PORT="${ANVIL_PORT:-18599}"
HOOK_PORT="${HOOK_PORT:-18598}"
export RPC_URL="http://127.0.0.1:$PORT"
ANVIL_PID=""
HOOK_PID=""
cleanup() {
    [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
    [[ -n "$HOOK_PID" ]] && kill "$HOOK_PID" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

PASS=0
FAIL=0
check() {
    if eval "$2"; then echo "PASS: $1"; PASS=$((PASS + 1)); else echo "FAIL: $1"; FAIL=$((FAIL + 1)); fi
}

anvil --port "$PORT" --silent >"$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 50); do
    cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
    sleep 0.2
done
cast chain-id --rpc-url "$RPC_URL" >/dev/null || { echo "FAIL: anvil did not start"; exit 1; }

DEPLOYER="$(cast rpc eth_accounts --rpc-url "$RPC_URL" | tr -d '[]" ' | cut -d, -f1)"
LIBS=()
# usage: create <path:Name> [constructor args...]. --constructor-args goes last because it takes every value after it.
create() {
    local target="$1"; shift
    local ctor=()
    [[ $# -gt 0 ]] && ctor=(--constructor-args "$@")
    (cd "$REPO_ROOT" && forge create "$target" "${LIBS[@]}" --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" --broadcast --json "${ctor[@]}") \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["deployedTo"])'
}

TICKLIB="$(create contracts/lib/TickMath.sol:TickMath)"
LIBS=(--libraries "contracts/lib/TickMath.sol:TickMath:$TICKLIB")
LIB="$(create contracts/lib/TwapTickMath.sol:TwapTickMath)"
LIBS+=(--libraries "contracts/lib/TwapTickMath.sol:TwapTickMath:$LIB")
PM="$(create contracts/test/helpers/MockV4PoolManager.sol:MockV4PoolManager)"
T0="$(create contracts/test/helpers/TestERC20.sol:TestERC20)"
T1="$(create contracts/test/helpers/TestERC20.sol:TestERC20)"
if [[ "${T0,,}" > "${T1,,}" ]]; then C0="$T1"; C1="$T0"; else C0="$T0"; C1="$T1"; fi
FEE=29100
SPACING=582
START_TICK=-403009
POOL_ID="$(cast keccak "$(cast abi-encode 'f((address,address,uint24,int24,address))' "($C0,$C1,$FEE,$SPACING,0x0000000000000000000000000000000000000000)")")"
cast send "$PM" "setTick(bytes32,int24)" "$POOL_ID" "$START_TICK" --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" >/dev/null 2>&1 || true
cast send "$PM" "initializePool((address,address,uint24,int24,address),int24,uint128)" \
    "($C0,$C1,$FEE,$SPACING,0x0000000000000000000000000000000000000000)" "$START_TICK" 1000000000000000000 \
    --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" >/dev/null
REC="$(create contracts/adapters/UniswapV4PriceRecorder.sol:UniswapV4PriceRecorder \
    "$PM" "$C0" "$C1" "$FEE" "$SPACING" 0x0000000000000000000000000000000000000000)"
export RECORDER_ADDRESS="$REC"
# Match the production ring so a full NAV window survives catch-up records.
cast send "$REC" "grow(uint16)" 901 --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" >/dev/null

# A fresh low-privilege keeper key in an encrypted keystore. No key literal appears in this file.
echo "keeper-test-password" >"$WORK/pw"
chmod 600 "$WORK/pw"
mkdir -p "$WORK/ks"
cast wallet new "$WORK/ks" keeper --unsafe-password "$(cat "$WORK/pw")" >/dev/null 2>&1
KEEPER_FILE="$WORK/ks/keeper"
KEEPER_ADDR="$(cast wallet address --keystore "$KEEPER_FILE" --password-file "$WORK/pw")"
cast rpc anvil_setBalance "$KEEPER_ADDR" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null
export KEEPER_KEYSTORE="$KEEPER_FILE"
export KEEPER_PASSWORD_FILE="$WORK/pw"

# SLEEP_CMD moves chain time instead of waiting.
cat >"$WORK/fast-sleep.sh" <<EOS
#!/usr/bin/env bash
cast rpc evm_increaseTime "\${1:-60}" --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
EOS
chmod +x "$WORK/fast-sleep.sh"
export SLEEP_CMD="$WORK/fast-sleep.sh"
export CATCHUP_INTERVAL_SECS=120

recorded_tick() { cast call "$REC" "latest()(int24,uint32,uint16,uint16,uint16)" --rpc-url "$RPC_URL" | sed -n 1p | awk '{print $1}'; }
fresh() { cast call "$REC" "isFresh()(bool)" --rpc-url "$RPC_URL"; }

# ─── Case 1: a 2-day gap, live price 1500 ticks (about 16 percent) away ──────
cast rpc evm_increaseTime 172800 --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
LIVE=$((START_TICK + 1500))
cast send "$PM" "setTick(bytes32,int24)" "$POOL_ID" "$LIVE" --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" >/dev/null
check "recorder is stale after the 2-day gap" '[[ "$(fresh)" == "false" ]]'

set +e
MAX_DEVIATION_TICKS=100 bash "$KEEPER" --once 2>"$WORK/case1.err"
RC=$?
set -e
check "keeper alerts recorder_stale when isFresh() reads false" 'grep -q "\"alert\":\"recorder_stale\"" "$WORK/case1.err"'
check "keeper exits 1 when it had to alert" '[[ $RC -eq 1 ]]'
DEV=$(( LIVE - $(recorded_tick) )); DEV=${DEV#-}
check "recorded tick is within the limit of the live tick (deviation $DEV ticks)" '[[ $DEV -le 100 ]]'
check "recorder is fresh after the keeper ran" '[[ "$(fresh)" == "true" ]]'
check "keeper needed repeated calls (clamp is 600 ticks per call)" '[[ "$(grep -c "deviation .* ticks after" "$WORK/case1.err")" -ge 3 ]]'

# ─── Case 2: healthy recorder, one call, no alert ────────────────────────────
"$WORK/fast-sleep.sh" 120
set +e
MAX_DEVIATION_TICKS=100 bash "$KEEPER" --once 2>"$WORK/case2.err"
RC=$?
set -e
check "healthy keeper tick exits 0" '[[ $RC -eq 0 ]]'
check "healthy keeper tick emits no alert" '! grep -q "\"alert\"" "$WORK/case2.err"'

# ─── Case 3: unreadable recorder (the pool manager has no isFresh) ───────────
set +e
RECORDER_ADDRESS="$PM" bash "$KEEPER" --once 2>"$WORK/case3.err"
RC=$?
set -e
check "unreadable recorder alerts recorder_unreadable and exits 1" 'grep -q "recorder_unreadable" "$WORK/case3.err" && [[ $RC -eq 1 ]]'

# ─── Case 4: the webhook receives the alert ──────────────────────────────────
python3 - "$HOOK_PORT" "$WORK/hook.body" <<'PY' &
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
out = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        open(out, "ab").write(self.rfile.read(n) + b"\n")
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
HOOK_PID=$!
sleep 1
set +e
ALERT_WEBHOOK="http://127.0.0.1:$HOOK_PORT/" RECORDER_ADDRESS="$PM" bash "$KEEPER" --once 2>/dev/null
set -e
check "webhook receives the alert JSON" 'grep -q "recorder_unreadable" "$WORK/hook.body"'

# ─── Config errors ───────────────────────────────────────────────────────────
set +e
env -u RPC_URL bash "$KEEPER" --once 2>/dev/null
RC=$?
set -e
check "missing RPC_URL exits 2" '[[ $RC -eq 2 ]]'

echo "passed=$PASS failed=$FAIL"
[[ $PASS -gt 0 && $FAIL -eq 0 ]]
