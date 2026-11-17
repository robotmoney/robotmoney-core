#!/usr/bin/env bash
# Canonical: docs/operations/contract-release-runbooks.md ("One-vault keeper");
#            docs/technical/one-vault-rebalancer-proposal.md §5.3 and §5.4
# Self-test for scripts/ops/onevault-keeper.sh (core issue 2033).
#
# Cases that need only anvil run first: the config exit codes, an unreadable queue (rpc_unreadable, exit 1), and the
# webhook receiving that alert. Then the test deploys KeeperAccount, the one-vault fund and queue
# (contracts/test/prototype/anvil/OneVaultDeliveryAnvil.s.sol), and a Rebalancer with one lending asset over a mock Aave
# pool (contracts/test/prototype/anvil/OneVaultKeeperAnvil.s.sol). It then runs the keeper against them:
#   - a due settle forwarded through KeeperAccount.execute, low_gas, settle_failed (an injected send failure), queue_paused,
#     keeper_unconfigured, and rpc_unreadable on the Rebalancer;
#   - a plan with a lending target, the mock venue closed: the simulated step() returns StepFailed, so the keeper alerts
#     step_failed, sends nothing, and exits 1;
#   - the venue open: the keeper sends step() through KeeperAccount.execute, and USDC moves into the lending asset.
# Real time passes on anvil (evm_increaseTime) for the glide path. No cheatcode skips a check.
# step_failed for a failed transaction (a send that reverts) is not separately exercised: the simulation catches the same
# failure first. delist_step_failed is not exercised: no asset is in sale.
# This test FAILS LOUDLY (exit 1) when anvil, forge, cast, python3 or curl is absent, or when a contract does not deploy.
# It never skips.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEEPER="$REPO_ROOT/scripts/ops/onevault-keeper.sh"
for bin in anvil forge cast python3 curl; do
    command -v "$bin" >/dev/null || { echo "FAIL: $bin is not installed"; exit 1; }
done

WORK="$(mktemp -d)"
PORT="${ANVIL_PORT:-18603}"
HOOK_PORT="${HOOK_PORT:-18604}"
RPC_URL="http://127.0.0.1:$PORT"
ANVIL_PID=""
HOOK_PID=""
cleanup() {
    [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
    [[ -n "$HOOK_PID" ]] && kill "$HOOK_PID" 2>/dev/null || true
    rm -f "$REPO_ROOT/out/prototype/onevault-keeper-anvil-$$.env" "$REPO_ROOT/out/prototype/onevault-keeper-rebalancer-anvil-$$.env"
    rm -rf "$WORK"
}
trap cleanup EXIT

PASS=0
FAIL=0
check() {
    if eval "$2"; then
        echo "PASS: $1"; PASS=$((PASS + 1))
    else
        echo "FAIL: $1"; FAIL=$((FAIL + 1))
        # Show the keeper's stderr for the failed case, so the cause is in the log.
        for f in "$WORK"/*.err; do [[ -f "$f" ]] && { echo "--- ${f##*/}"; tail -n 4 "$f" | cut -c1-300; }; done
    fi
}

# ─── Chain ───────────────────────────────────────────────────────────────────
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
cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 || { echo "FAIL: anvil did not start on port $PORT"; exit 1; }

mapfile -t ACCTS < <(cast rpc eth_accounts --rpc-url "$RPC_URL" | python3 -I -c 'import json,sys; print("\n".join(json.load(sys.stdin)))')
DEPLOYER="${ACCTS[0]}"
EMERGENCY="${ACCTS[1]}"
PLAIN="${ACCTS[2]}"

# A fresh bot key in an encrypted keystore, gas only. No key literal appears in this file.
echo "keeper-test-password" >"$WORK/pw"
chmod 600 "$WORK/pw"
mkdir -p "$WORK/ks"
cast wallet new "$WORK/ks" bot --unsafe-password "$(cat "$WORK/pw")" >/dev/null 2>&1
export KEEPER_KEYSTORE="$WORK/ks/bot"
export KEEPER_PASSWORD_FILE="$WORK/pw"
BOT_ADDR="$(cast wallet address --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE")"
cast rpc anvil_setBalance "$BOT_ADDR" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null

# run_keeper ERRFILE [VAR=VALUE ...]: one `--once` tick with those overrides. Prints the exit code.
run_keeper() {
    local err="$1"
    shift
    set +e
    env RPC_URL="$RPC_URL" QUEUE_ADDRESS="$PLAIN" REBALANCER_ADDRESS="$PLAIN" KEEPER_ACCOUNT_ADDRESS="$PLAIN" \
        "$@" bash "$KEEPER" --once 2>"$err"
    local rc=$?
    set -e
    echo "$rc"
}

# ─── Config errors (exit 2, nothing read) ────────────────────────────────────
set +e
env -u RPC_URL bash "$KEEPER" --once 2>/dev/null
RC=$?
env -u QUEUE_ADDRESS RPC_URL="$RPC_URL" REBALANCER_ADDRESS="$PLAIN" KEEPER_ACCOUNT_ADDRESS="$PLAIN" \
    bash "$KEEPER" --once 2>/dev/null
RC2=$?
set -e
check "missing RPC_URL exits 2" "[[ $RC -eq 2 ]]"
check "missing QUEUE_ADDRESS exits 2" "[[ $RC2 -eq 2 ]]"
RC=$(run_keeper "$WORK/bad-addr.err" QUEUE_ADDRESS=not-an-address)
check "a malformed QUEUE_ADDRESS exits 2" '[[ "$RC" == "2" ]]'
RC=$(run_keeper "$WORK/no-ks.err" KEEPER_KEYSTORE="$WORK/missing.json")
check "a missing keystore file exits 2" '[[ "$RC" == "2" ]]'

# ─── Unreadable queue (rpc_unreadable, exit 1, nothing sent) ─────────────────
RC=$(run_keeper "$WORK/unreadable.err" QUEUE_ADDRESS="$PLAIN")
check "an unreadable queue alerts rpc_unreadable and exits 1" 'grep -q "\"alert\":\"rpc_unreadable\"" "$WORK/unreadable.err" && [[ "$RC" == "1" ]]'

# ─── Webhook receives the alert ──────────────────────────────────────────────
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
RC=$(run_keeper "$WORK/hook.err" QUEUE_ADDRESS="$PLAIN" ALERT_WEBHOOK="http://127.0.0.1:$HOOK_PORT/")
check "the webhook receives the alert body and the exit is 1" 'grep -q "rpc_unreadable" "$WORK/hook.body" && [[ "$RC" == "1" ]]'

# ─── The one-vault stack: KeeperAccount holds KEEPER_ROLE on the queue and the Rebalancer ────
# KeeperAccount takes its owners and bot keys as constructor arrays. The deployer owns it and the bot key may call execute.
KEEPER_ACCOUNT="$( (cd "$REPO_ROOT" && forge create contracts/test/prototype/src/KeeperAccount.sol:KeeperAccount \
    --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" --broadcast --json \
    --constructor-args "[$DEPLOYER]" "[$BOT_ADDR]") 2>"$WORK/keeper-account.err" \
    | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["deployedTo"])' 2>/dev/null)" \
    || { echo "FAIL: KeeperAccount did not deploy on anvil"; tail -20 "$WORK/keeper-account.err"; exit 1; }
check "KeeperAccount deploys on anvil" '[[ "$KEEPER_ACCOUNT" =~ ^0x[0-9a-fA-F]{40}$ ]]'

mkdir -p "$REPO_ROOT/out/prototype"
ENV_OUT="$REPO_ROOT/out/prototype/onevault-keeper-anvil-$$.env"
REB_OUT="$REPO_ROOT/out/prototype/onevault-keeper-rebalancer-anvil-$$.env"
(cd "$REPO_ROOT" && ONEVAULT_ANVIL_OUT="$ENV_OUT" KEEPER_ADDRESS="$KEEPER_ACCOUNT" EMERGENCY_ADDRESS="$EMERGENCY" \
    forge script contracts/test/prototype/anvil/OneVaultDeliveryAnvil.s.sol --rpc-url "$RPC_URL" \
    --broadcast --unlocked --sender "$DEPLOYER" --slow >"$WORK/deploy.log" 2>&1) \
    || { echo "FAIL: the one-vault stack did not deploy on anvil"; tail -40 "$WORK/deploy.log"; exit 1; }
[[ -s "$ENV_OUT" ]] || { echo "FAIL: the deploy wrote no address file"; exit 1; }
# shellcheck disable=SC1090
source <(sed 's/^/export /' "$ENV_OUT")
check "the one-vault queue and fund deploy on anvil" '[[ -n "${QUEUE:-}" && -n "${FUND:-}" && -n "${TIMELOCK:-}" ]]'

(cd "$REPO_ROOT" && FUND_ADDRESS="$FUND" TIMELOCK_ADDRESS="$TIMELOCK" KEEPER_ADDRESS="$KEEPER_ACCOUNT" USDC_ADDRESS="$USDC" \
    REBALANCER_ANVIL_OUT="$REB_OUT" \
    forge script contracts/test/prototype/anvil/OneVaultKeeperAnvil.s.sol:OneVaultKeeperAnvil --rpc-url "$RPC_URL" \
    --broadcast --unlocked --sender "$DEPLOYER" --slow >"$WORK/rebalancer.log" 2>&1) \
    || { echo "FAIL: the Rebalancer did not deploy on anvil"; tail -40 "$WORK/rebalancer.log"; exit 1; }
[[ -s "$REB_OUT" ]] || { echo "FAIL: the Rebalancer deploy wrote no address file"; exit 1; }
# shellcheck disable=SC1090
source <(sed 's/^/export /' "$REB_OUT")
check "the Rebalancer and its lending asset deploy on anvil" '[[ "$REBALANCER" =~ ^0x[0-9a-fA-F]{40}$ && "$LENDING_ADAPTER" =~ ^0x[0-9a-fA-F]{40}$ ]]'

# A second bot-less key, for the keeper_unconfigured case.
mkdir -p "$WORK/ks2"
cast wallet new "$WORK/ks2" stranger --unsafe-password "$(cat "$WORK/pw")" >/dev/null 2>&1
STRANGER_KEYSTORE="$WORK/ks2/stranger"
cast rpc anvil_setBalance "$(cast wallet address --keystore "$STRANGER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE")" \
    0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null

# A cast shim on PATH that fails a send only while the flag file exists. Every other call passes through.
REAL_CAST="$(command -v cast)"
FLAGS="$WORK/flags"
mkdir -p "$FLAGS" "$WORK/shim"
cat >"$WORK/shim/cast" <<EOS
#!/usr/bin/env bash
if [[ "\$1" == "send" && -f "$FLAGS/fail-send" ]]; then
    echo "injected send failure for the self-test" >&2
    exit 1
fi
exec "$REAL_CAST" "\$@"
EOS
chmod +x "$WORK/shim/cast"

# run_keeper_once ERRFILE [VAR=VALUE ...]: one `--once` tick against the deployed stack. Prints the exit code.
run_keeper_once() {
    local err="$1"
    shift
    set +e
    env RPC_URL="$RPC_URL" QUEUE_ADDRESS="$QUEUE" REBALANCER_ADDRESS="$REBALANCER" KEEPER_ACCOUNT_ADDRESS="$KEEPER_ACCOUNT" \
        MIN_GAS_WEI=1000000000000000 "$@" bash "$KEEPER" --once 2>"$err"
    local rc=$?
    set -e
    echo "$rc"
}
call_q() { cast call "$QUEUE" "$@" --rpc-url "$RPC_URL" | awk '{print $1}'; }
send_from() { local from="$1"; shift; cast send "$@" --rpc-url "$RPC_URL" --unlocked --from "$from" >/dev/null; }
warp() {
    cast rpc evm_increaseTime "$1" --rpc-url "$RPC_URL" >/dev/null
    cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
}
# Sets both feeds to the current chain time, so checkSettle does not read them as stale.
refresh_feeds() {
    local t
    t=$(cast block latest --rpc-url "$RPC_URL" -f timestamp | awk '{print $1}')
    send_from "$DEPLOYER" "$USDC_FEED" "setRound(uint8,int256,uint256,uint256)" 8 100000000 "$t" "$t"
    send_from "$DEPLOYER" "$SEQUENCER_FEED" "setRound(uint8,int256,uint256,uint256)" 0 0 "$((t - 86400))" "$t"
}
# A deposit request that the keeper can settle once its window has ended.
request_deposit() {
    send_from "$DEPLOYER" "$USDC" "mint(address,uint256)" "$DEPLOYER" 1000000000
    send_from "$DEPLOYER" "$USDC" "approve(address,uint256)" "$QUEUE" 1000000000
    send_from "$DEPLOYER" "$QUEUE" "requestDeposit(uint256,address)" 1000000000 "$DEPLOYER"
}

# ─── Case 1: nothing due, exit 0, no settle ─────────────────────────────────
RC=$(run_keeper_once "$WORK/idle.err")
check "an idle queue exits 0 with nothing sent" '[[ "$RC" == "0" ]] && grep -q "nothing due" "$WORK/idle.err"'

# ─── Case 2: a request, then settle forwarded through KeeperAccount.execute ──
request_deposit
warp 28800  # 8 h: one 6 h epoch plus the 1 h settle window. Longer spans exceed maxRoll and expire the request.
refresh_feeds
# shellcheck disable=SC2034 # read by the check strings
SETTLED_BEFORE="$(call_q "settlementCount()(uint256)")"
RC=$(run_keeper_once "$WORK/settle.err")
# shellcheck disable=SC2034 # read by the check strings
SETTLED_AFTER="$(call_q "settlementCount()(uint256)")"
check "a due settle is forwarded and exits 0" '[[ "$RC" == "0" && "$SETTLED_AFTER" -gt "$SETTLED_BEFORE" ]]'
check "the settle send names the queue through KeeperAccount" 'grep -q "sent settle(uint256,uint256) to" "$WORK/settle.err"'

# ─── Case 3: a request, then low gas: alert, nothing sent ───────────────────
request_deposit
warp 28800  # 8 h: one 6 h epoch plus the 1 h settle window. Longer spans exceed maxRoll and expire the request.
refresh_feeds
# shellcheck disable=SC2034 # read by the check strings
SETTLED_BEFORE="$(call_q "settlementCount()(uint256)")"
RC=$(run_keeper_once "$WORK/lowgas.err" MIN_GAS_WEI=100000000000000000000000)
# shellcheck disable=SC2034 # read by the check strings
SETTLED_AFTER="$(call_q "settlementCount()(uint256)")"
check "low gas (above the 100 ETH balance) alerts low_gas, exits 1, and sends nothing" 'grep -q "\"alert\":\"low_gas\"" "$WORK/lowgas.err" && [[ "$RC" == "1" && "$SETTLED_AFTER" == "$SETTLED_BEFORE" ]]'

# ─── Case 4: an injected send failure: settle_failed, exit 1, nothing settled ─
: >"$FLAGS/fail-send"
RC=$(run_keeper_once "$WORK/sendfail.err" PATH="$WORK/shim:$PATH")
rm -f "$FLAGS/fail-send"
# shellcheck disable=SC2034 # read by the check strings
SETTLED_AFTER2="$(call_q "settlementCount()(uint256)")"
check "a failed settle alerts settle_failed and exits 1" 'grep -q "\"alert\":\"settle_failed\"" "$WORK/sendfail.err" && [[ "$RC" == "1" ]]'
check "the failed settle settled nothing" '[[ "$SETTLED_AFTER2" == "$SETTLED_AFTER" ]]'

# ─── Case 5: a paused queue: queue_paused, exit 1, settle skipped ───────────
send_from "$EMERGENCY" "$QUEUE" "pauseQueue()"
RC=$(run_keeper_once "$WORK/paused.err")
send_from "$DEPLOYER" "$QUEUE" "unpauseQueue()"
check "a paused queue alerts queue_paused and exits 1" 'grep -q "\"alert\":\"queue_paused\"" "$WORK/paused.err" && [[ "$RC" == "1" ]]'

# ─── Case 6: a key that is not a bot key: keeper_unconfigured, exit 1 ───────
RC=$(run_keeper_once "$WORK/unconf.err" KEEPER_KEYSTORE="$STRANGER_KEYSTORE")
check "a non-bot key alerts keeper_unconfigured and exits 1" 'grep -q "\"alert\":\"keeper_unconfigured\"" "$WORK/unconf.err" && [[ "$RC" == "1" ]]'

# ─── Case 7: an unreadable Rebalancer: rpc_unreadable, exit 1 ───────────────
RC=$(run_keeper_once "$WORK/rebunread.err" REBALANCER_ADDRESS="$PLAIN")
check "an unreadable Rebalancer alerts rpc_unreadable and exits 1" 'grep -q "\"alert\":\"rpc_unreadable\"" "$WORK/rebunread.err" && [[ "$RC" == "1" ]]'

# step() is not due here: the fund has no open plan, so previewStep reports a skip and the keeper sends no step.
check "with no open plan the keeper does not send step()" 'grep -q "step not due" "$WORK/idle.err" && ! grep -q "step_failed" "$WORK/settle.err"'

# ─── Step: a plan with a lending target, the venue closed, then open ─────────
# The glide path starts at the current weights, so the target only moves once time passes. The venue is closed first,
# so the simulated step() returns StepFailed and the keeper must alert without sending. Then the venue opens and the
# same tick sends step(), which must move USDC into the lending asset.
lending_balance() { cast call "$A_TOKEN" "balanceOf(address)(uint256)" "$LENDING_ADAPTER" --rpc-url "$RPC_URL" | awk '{print $1}'; }
send_from "$DEPLOYER" "$LENDING_POOL" "setPaused(bool)" true
refresh_feeds
send_from "$DEPLOYER" "$FUND" "setTargetAndOpenPlan(address[],uint256[],(uint64,uint16),bytes32)" \
    "[$LENDING_ADAPTER]" "[10000]" "(86400,30)" "0x0000000000000000000000000000000000000000000000000000000000000000"
warp 43200  # half the glide path, so the lending target now differs from the current weight
refresh_feeds
RC=$(run_keeper_once "$WORK/stepfail.err")
check "a step that fails in simulation alerts step_failed, sends nothing, and exits 1" \
    'grep -q "\"alert\":\"step_failed\".*simulated step() returned StepFailed" "$WORK/stepfail.err" && [[ "$RC" == "1" && "$(lending_balance)" == "0" ]]'

send_from "$DEPLOYER" "$LENDING_POOL" "setPaused(bool)" false
RC=$(run_keeper_once "$WORK/stepok.err")
check "a due step is sent through KeeperAccount.execute and moves USDC into the lending asset" \
    '[[ "$RC" == "0" ]] && grep -q "sent step()" "$WORK/stepok.err" && [[ "$(lending_balance)" != "0" ]]'

echo "passed=$PASS failed=$FAIL"
[[ $PASS -gt 0 && $FAIL -eq 0 ]]
