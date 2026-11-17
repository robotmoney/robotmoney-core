#!/usr/bin/env bash
# Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E8 (anyone may deliver a deposit's shares to its owner after
#            the hold), RB-18 (frozen shares are not delivered);
#            docs/operations/contract-release-runbooks.md ("Share-delivery keeper")
# Self-test for scripts/ops/onevault-share-delivery-keeper.sh (core issue 2026).
#
# Deploys the one-vault prototype (fund, queue, mock feeds, a 6-decimal test USDC) on a local anvil chain with
# contracts/test/prototype/anvil/OneVaultDeliveryAnvil.s.sol, then runs the real keeper against the real queue. Chain time
# moves with evm_increaseTime. This test FAILS LOUDLY (exit 1) when anvil, forge, cast, python3 or curl is absent or the
# stack does not deploy. It never skips.
#
# Cases:
#   1. Delivery: `--once` delivers an unlocked deposit to its owner's wallet (exit 0). A second run delivers nothing. A
#      held deposit and a frozen deposit are untouched, and the held one is delivered after its hold, while the frozen
#      one is not.
#   2. Redemption: the keeper does not pay a redemption claim. The owner's USDC is unchanged.
#   3. Manual claim race, three orders: the owner claims before the keeper plans; the keeper delivers first and the
#      owner's second claim reverts; the owner claims between the keeper's plan and its send (injected at the cast
#      boundary). Each order leaves exactly one delivery of the owner's shares.
#   4. Alerts and exits: low_gas (exit 1, nothing sent), delivery_failed (exit 1, nothing delivered, then exit 0 once the
#      fault clears), rpc_unreadable (exit 1), invalid_config (exit 2 for an absent queue, an address with no contract, an
#      absent keystore), and the webhook receives the alert body.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEPER="$REPO_ROOT/scripts/ops/onevault-share-delivery-keeper.sh"
for bin in anvil forge cast python3 curl; do
    command -v "$bin" >/dev/null || { echo "FAIL: $bin is not installed"; exit 1; }
done

WORK="$(mktemp -d)"
PORT="${ANVIL_PORT:-18601}"
HOOK_PORT="${HOOK_PORT:-18602}"
RPC_URL="http://127.0.0.1:$PORT"
mkdir -p "$REPO_ROOT/out/prototype"
ENV_OUT="$REPO_ROOT/out/prototype/onevault-share-delivery-anvil-$$.env"
UINT_MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935
ANVIL_PID=""
HOOK_PID=""
cleanup() {
    [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
    [[ -n "$HOOK_PID" ]] && kill "$HOOK_PID" 2>/dev/null || true
    rm -f "$ENV_OUT"
    rm -rf "$WORK"
}
trap cleanup EXIT

PASS=0
FAIL=0
check() {
    if eval "$2"; then echo "PASS: $1"; PASS=$((PASS + 1)); else echo "FAIL: $1"; FAIL=$((FAIL + 1)); fi
}

# ─── Chain ───────────────────────────────────────────────────────────────────
# A chain already on the port would answer for the anvil this test failed to start, so refuse a busy port first.
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    echo "FAIL: port $PORT is busy; set ANVIL_PORT to a free port"
    exit 1
fi
anvil --port "$PORT" --silent >"$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 100); do
    cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break
    kill -0 "$ANVIL_PID" 2>/dev/null || break
    sleep 0.2
done
kill -0 "$ANVIL_PID" 2>/dev/null && cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 \
    || { echo "FAIL: anvil did not start on port $PORT"; exit 1; }

mapfile -t ACCTS < <(cast rpc eth_accounts --rpc-url "$RPC_URL" | python3 -I -c 'import json,sys; print("\n".join(json.load(sys.stdin)))')
DEPLOYER="${ACCTS[0]}"
KEEPER_ROLE="${ACCTS[1]}"
EMERGENCY="${ACCTS[2]}"
A="${ACCTS[3]}"
B="${ACCTS[4]}"
C="${ACCTS[5]}"
R1="${ACCTS[6]}"
R2="${ACCTS[7]}"
R3="${ACCTS[8]}"
R4="${ACCTS[9]}"

# ─── Deploy the one-vault prototype stack ────────────────────────────────────
(cd "$REPO_ROOT" && ONEVAULT_ANVIL_OUT="$ENV_OUT" KEEPER_ADDRESS="$KEEPER_ROLE" EMERGENCY_ADDRESS="$EMERGENCY" \
    forge script contracts/test/prototype/anvil/OneVaultDeliveryAnvil.s.sol --rpc-url "$RPC_URL" \
    --broadcast --unlocked --sender "$DEPLOYER" --slow >"$WORK/deploy.log" 2>&1) \
    || { echo "FAIL: the one-vault stack did not deploy on anvil"; tail -40 "$WORK/deploy.log"; exit 1; }
[[ -s "$ENV_OUT" ]] || { echo "FAIL: the deploy wrote no address file"; exit 1; }
# shellcheck disable=SC1090
source <(sed 's/^/export /' "$ENV_OUT")

# ─── Keeper key: a fresh low-privilege key, gas only ─────────────────────────
echo "keeper-test-password" >"$WORK/pw"
chmod 600 "$WORK/pw"
mkdir -p "$WORK/ks"
cast wallet new "$WORK/ks" keeper --unsafe-password "$(cat "$WORK/pw")" >/dev/null 2>&1
export KEEPER_KEYSTORE="$WORK/ks/keeper"
export KEEPER_PASSWORD_FILE="$WORK/pw"
KEEPER_ADDR="$(cast wallet address --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE")"
cast rpc anvil_setBalance "$KEEPER_ADDR" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null

# The cast boundary: a wrapper that passes every call through and injects one fault when its flag file is armed.
FLAGS="$WORK/flags"
mkdir -p "$FLAGS"
REAL_CAST="$(command -v cast)"
cat >"$WORK/cast-wrap.sh" <<'EOS'
#!/usr/bin/env bash
if [[ "$1" == "send" && -f "$FLAGS/fail-send" ]]; then
    echo "injected send failure for the self-test" >&2
    exit 1
fi
if [[ "$1" == "send" && -f "$FLAGS/race" ]]; then
    # The owner claims between the keeper's plan and its send: `$5` is the owner of the keeper's deposit(assets, owner).
    rm -f "$FLAGS/race"
    owner="$5"
    assets=$("$REAL_CAST" call "$QUEUE" "maxDeposit(address)(uint256)" "$owner" --rpc-url "$RPC_URL" | awk '{print $1}')
    "$REAL_CAST" send "$QUEUE" "deposit(uint256,address)(uint256)" "$assets" "$owner" \
        --rpc-url "$RPC_URL" --unlocked --from "$owner" >/dev/null 2>&1 || true
fi
exec "$REAL_CAST" "$@"
EOS
chmod +x "$WORK/cast-wrap.sh"
export FLAGS REAL_CAST RPC_URL QUEUE
export RPC_URL QUEUE_ADDRESS="$QUEUE" CAST_BIN="$WORK/cast-wrap.sh"

# ─── Helpers ─────────────────────────────────────────────────────────────────
send_from() {
    local from="$1"
    shift
    cast send "$@" --rpc-url "$RPC_URL" --unlocked --from "$from" >/dev/null
}
call_q() { cast call "$QUEUE" "$@" --rpc-url "$RPC_URL"; }
chain_now() { cast block latest --rpc-url "$RPC_URL" -f timestamp; }
warp() {
    cast rpc evm_increaseTime "$1" --rpc-url "$RPC_URL" >/dev/null
    cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
}
# Reads element IDX of the first (only) return value of a `cast call --json` on stdin.
json_field() { python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0][int(sys.argv[1])])' "$1"; }
claim_count() { call_q "claimCount()(uint256)" | awk '{print $1}'; }
claim_field() {
    cast call "$QUEUE" "getClaim(uint256)((uint256,address,uint8,uint64,uint64,uint256,uint256,uint256,uint256))" "$1" \
        --rpc-url "$RPC_URL" --json | json_field "$2"
}
request_field() {
    cast call "$QUEUE" "getRequest(uint256)((address,uint8,uint64,uint256,uint256,bool,uint16,uint32,uint16,uint64,uint64,uint64,uint64,uint64,bool,uint256,uint256,uint256,uint256,uint256))" "$1" \
        --rpc-url "$RPC_URL" --json | json_field "$2"
}
max_deposit() { call_q "maxDeposit(address)(uint256)" "$1" | awk '{print $1}'; }
shares_of() { cast call "$FUND" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC_URL" | awk '{print $1}'; }
usdc_of() { cast call "$USDC" "balanceOf(address)(uint256)" "$1" --rpc-url "$RPC_URL" | awk '{print $1}'; }

refresh_feeds() {
    local t
    t=$(chain_now)
    send_from "$DEPLOYER" "$USDC_FEED" "setRound(uint8,int256,uint256,uint256)" 8 100000000 "$t" "$t"
    send_from "$DEPLOYER" "$SEQUENCER_FEED" "setRound(uint8,int256,uint256,uint256)" 0 0 "$((t - 86400))" "$t"
}
settle_now() {
    refresh_feeds
    send_from "$KEEPER_ROLE" "$QUEUE" "settle(uint256,uint256)" 10 "$UINT_MAX"
}
# Warps chain time to the end of request ID's window.
wait_settleable() {
    local epoch target now
    epoch=$(request_field "$1" 2)
    target=$(call_q "settleableAt(uint64)(uint64)" "$epoch" | awk '{print $1}')
    now=$(chain_now)
    if (( target > now )); then warp $((target - now + 2)); fi
}
# request_deposit OWNER USDC: places a deposit request and prints its id.
request_deposit() {
    local owner="$1" amount="$2"
    send_from "$DEPLOYER" "$USDC" "mint(address,uint256)" "$owner" "$amount"
    send_from "$owner" "$USDC" "approve(address,uint256)" "$QUEUE" "$amount"
    send_from "$owner" "$QUEUE" "requestDeposit(uint256,address)" "$amount" "$owner"
    call_q "requestCount()(uint256)" | awk '{print $1}'
}
# open_deposit OWNER USDC: a deposit settled by the keeper. Prints the id of its claim.
open_deposit() {
    local id
    id=$(request_deposit "$1" "$2")
    wait_settleable "$id"
    settle_now
    [[ "$(request_field "$id" 5)" == "True" || "$(request_field "$id" 5)" == "true" ]] \
        || { echo "FAIL: request $id did not settle" >&2; exit 1; }
    claim_count
}
# request_redeem OWNER SHARES: a redemption request. Prints its id.
request_redeem() {
    send_from "$1" "$FUND" "approve(address,uint256)" "$QUEUE" "$2"
    send_from "$1" "$QUEUE" "requestRedeem(uint256,address)" "$2" "$1"
    call_q "requestCount()(uint256)" | awk '{print $1}'
}
# run_keeper ERRFILE [VAR=VALUE ...]: one `--once` tick with those overrides. Prints the exit code.
run_keeper() {
    local err="$1"
    shift
    set +e
    env "$@" bash "$KEEPER" --once 2>"$err"
    local rc=$?
    set -e
    echo "$rc"
}

# ─── Case 1 and 2: delivery, hold, freeze, redemption ────────────────────────
cA=$(open_deposit "$A" 500000000)
cC=$(open_deposit "$C" 200000000)
send_from "$EMERGENCY" "$QUEUE" "freezeSettlement(uint256)" "$(claim_field "$cC" 3)"
cB=$(open_deposit "$B" 300000000)

check "A's deposit is unlocked and deliverable" '[[ "$(max_deposit "$A")" -gt 0 ]]'
check "B's deposit is still in its hold" '[[ "$(max_deposit "$B")" == "0" ]]'
check "C's deposit is frozen" '[[ "$(max_deposit "$C")" == "0" ]]'

A_USDC0="$(usdc_of "$A")"
rc=$(run_keeper "$WORK/k1.err")
check "keeper --once exits 0 after delivering unlocked shares" '[[ "$rc" == "0" ]]'
check "A's wallet receives exactly its claim's shares" \
    '[[ "$(shares_of "$A")" == "$(claim_field "$cA" 5)" && "$(claim_field "$cA" 7)" == "$(claim_field "$cA" 5)" ]]'
check "the keeper never moves USDC to A" '[[ "$(usdc_of "$A")" == "$A_USDC0" ]]'
check "B's held claim is untouched" '[[ "$(claim_field "$cB" 7)" == "0" && "$(shares_of "$B")" == "0" ]]'
check "C's frozen claim is untouched" '[[ "$(claim_field "$cC" 7)" == "0" && "$(shares_of "$C")" == "0" ]]'

A_SHARES="$(shares_of "$A")"
rc=$(run_keeper "$WORK/k2.err")
check "a second keeper run delivers nothing and exits 0" '[[ "$rc" == "0" && "$(shares_of "$A")" == "$A_SHARES" ]]'
check "a healthy run emits no alert" '! grep -q "\"alert\"" "$WORK/k2.err"'

warp 3700
rc=$(run_keeper "$WORK/k3.err")
check "after the hold, B's shares are delivered and exit 0" \
    '[[ "$rc" == "0" && "$(shares_of "$B")" == "$(claim_field "$cB" 5)" ]]'
check "C stays frozen after its hold ends" '[[ "$(claim_field "$cC" 7)" == "0" && "$(shares_of "$C")" == "0" ]]'

# Redemption: A's shares are held as escrow for a redemption. The keeper never pays it.
half=$(python3 -I -c 'import sys; print(int(sys.argv[1]) // 2)' "$A_SHARES")  # share counts exceed bash integers
rid=$(request_redeem "$A" "$half")
wait_settleable "$rid"
settle_now
cR=$(claim_count)
A_USDC1="$(usdc_of "$A")"
rc=$(run_keeper "$WORK/k4.err")
check "the keeper leaves redemption claims alone and exits 0" '[[ "$rc" == "0" ]]'
check "the redemption claim is unpaid and A's USDC is unchanged" \
    '[[ "$(claim_field "$cR" 2)" == "1" && "$(claim_field "$cR" 8)" == "0" && "$(usdc_of "$A")" == "$A_USDC1" ]]'

# ─── Case 3: the manual claim race, three orders ────────────────────────────
# Order i: the owner claims first, then the keeper runs.
c1=$(open_deposit "$R1" 100000000)
warp 3700
send_from "$R1" "$QUEUE" "deposit(uint256,address)(uint256)" "$(max_deposit "$R1")" "$R1"
rc=$(run_keeper "$WORK/r1.err")
check "race order i: the keeper plans nothing after the owner's claim" '[[ "$rc" == "0" ]]'
check "race order i: one delivery of the owner's shares" \
    '[[ "$(shares_of "$R1")" == "$(claim_field "$c1" 5)" && "$(claim_field "$c1" 7)" == "$(claim_field "$c1" 5)" ]]'

# Order ii: the keeper delivers first, then the owner's own claim is refused.
c2=$(open_deposit "$R2" 100000000)
warp 3700
rc=$(run_keeper "$WORK/r2.err")
check "race order ii: the keeper delivers to the owner" \
    '[[ "$rc" == "0" && "$(shares_of "$R2")" == "$(claim_field "$c2" 5)" ]]'
if send_from "$R2" "$QUEUE" "deposit(uint256,address)(uint256)" 100000000 "$R2" 2>/dev/null; then
    check "race order ii: the owner's second claim is refused" 'false'
else
    check "race order ii: the owner's second claim is refused" 'true'
fi
check "race order ii: one delivery of the owner's shares" \
    '[[ "$(shares_of "$R2")" == "$(claim_field "$c2" 5)" && "$(claim_field "$c2" 7)" == "$(claim_field "$c2" 5)" ]]'

# Order iii: the owner claims between the keeper's plan and its send.
c3=$(open_deposit "$R3" 100000000)
warp 3700
touch "$FLAGS/race"
rc=$(run_keeper "$WORK/r3.err")
check "race order iii: the keeper's stale send is refused and exits 0" \
    '[[ "$rc" == "0" ]] && grep -q "claimed first" "$WORK/r3.err" && ! grep -q "delivery_failed" "$WORK/r3.err"'
check "race order iii: one delivery of the owner's shares" \
    '[[ "$(shares_of "$R3")" == "$(claim_field "$c3" 5)" && "$(claim_field "$c3" 7)" == "$(claim_field "$c3" 5)" ]]'

# ─── Case 4: alerts and exit codes ──────────────────────────────────────────
c4=$(open_deposit "$R4" 100000000)
warp 3700

rc=$(run_keeper "$WORK/low.err" MIN_GAS_WEI=1000000000000000000000000)
check "low gas exits 1 and emits a low_gas alert" '[[ "$rc" == "1" ]] && grep -q "\"alert\":\"low_gas\"" "$WORK/low.err"'
check "low gas sends nothing" '[[ "$(claim_field "$c4" 7)" == "0" ]]'

touch "$FLAGS/fail-send"
rc=$(run_keeper "$WORK/df.err")
rm -f "$FLAGS/fail-send"
check "a failed send exits 1 and emits a delivery_failed alert" \
    '[[ "$rc" == "1" ]] && grep -q "\"alert\":\"delivery_failed\"" "$WORK/df.err"'
check "a failed send delivers nothing" '[[ "$(claim_field "$c4" 7)" == "0" ]]'

rc=$(run_keeper "$WORK/df2.err")
check "after the fault clears the keeper delivers and exits 0" \
    '[[ "$rc" == "0" && "$(shares_of "$R4")" == "$(claim_field "$c4" 5)" ]]'

rc=$(run_keeper "$WORK/rpc.err" RPC_URL=http://127.0.0.1:1)
check "an unreadable RPC exits 1 and emits an rpc_unreadable alert" \
    '[[ "$rc" == "1" ]] && grep -q "\"alert\":\"rpc_unreadable\"" "$WORK/rpc.err"'

rc=$(run_keeper "$WORK/cfg1.err" QUEUE_ADDRESS=)
check "an absent queue address exits 2 with invalid_config" \
    '[[ "$rc" == "2" ]] && grep -q "\"alert\":\"invalid_config\"" "$WORK/cfg1.err"'
rc=$(run_keeper "$WORK/cfg2.err" QUEUE_ADDRESS="$R1")
check "an address with no contract exits 2 with invalid_config" \
    '[[ "$rc" == "2" ]] && grep -q "\"alert\":\"invalid_config\"" "$WORK/cfg2.err"'
rc=$(run_keeper "$WORK/cfg3.err" KEEPER_KEYSTORE="$WORK/absent")
check "an absent keystore exits 2 with invalid_config" '[[ "$rc" == "2" ]]'
rc=$(run_keeper "$WORK/cfg4.err" RPC_URL=)
check "an absent RPC_URL exits 2" '[[ "$rc" == "2" ]]'

python3 -I - "$HOOK_PORT" "$WORK/hook.body" <<'PY' &
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
open_deposit "$R4" 100000000 >/dev/null
warp 3700
rc=$(run_keeper "$WORK/hook.err" MIN_GAS_WEI=1000000000000000000000000 ALERT_WEBHOOK="http://127.0.0.1:$HOOK_PORT/")
check "the webhook receives the low_gas alert body" '[[ "$rc" == "1" ]] && grep -q "low_gas" "$WORK/hook.body"'

echo "passed=$PASS failed=$FAIL"
[[ $PASS -gt 0 && $FAIL -eq 0 ]]
