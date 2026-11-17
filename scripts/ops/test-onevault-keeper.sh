#!/usr/bin/env bash
# Canonical: docs/operations/contract-release-runbooks.md ("One-vault keeper");
#            docs/technical/one-vault-rebalancer-proposal.md §5.4 and §8
# Self-test for scripts/ops/onevault-keeper.sh (core issue 2033).
#
# Cases that need only anvil run first: the config exit codes, an unreadable queue (rpc_unreadable, exit 1), and the
# webhook receiving that alert. Then the test deploys KeeperAccount and the one-vault stack on a local anvil chain. The
# happy-path cases (settle() and step() forwarded through KeeperAccount.execute, low_gas, queue_paused, settle_failed,
# step_failed, keeper_unconfigured) need a Rebalancer on that chain as well. This test FAILS LOUDLY (exit 1) when anvil,
# forge, cast, python3 or curl is absent, or when a contract does not deploy. It never skips.

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
    rm -rf "$WORK"
}
trap cleanup EXIT

PASS=0
FAIL=0
check() {
    if eval "$2"; then echo "PASS: $1"; PASS=$((PASS + 1)); else echo "FAIL: $1"; FAIL=$((FAIL + 1)); fi
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

# ─── The one-vault stack (KeeperAccount holds KEEPER_ROLE) ───────────────────
# KeeperAccount takes its owners and bot keys as constructor arrays. The deployer owns it and the bot key may call execute.
KEEPER_ACCOUNT="$( (cd "$REPO_ROOT" && forge create contracts/test/prototype/src/KeeperAccount.sol:KeeperAccount \
    --rpc-url "$RPC_URL" --unlocked --from "$DEPLOYER" --broadcast --json \
    --constructor-args "[$DEPLOYER]" "[$BOT_ADDR]") 2>"$WORK/keeper-account.err" \
    | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["deployedTo"])' 2>/dev/null)" \
    || { echo "FAIL: KeeperAccount did not deploy on anvil"; tail -20 "$WORK/keeper-account.err"; exit 1; }
check "KeeperAccount deploys on anvil" '[[ "$KEEPER_ACCOUNT" =~ ^0x[0-9a-fA-F]{40}$ ]]'

ENV_OUT="$WORK/onevault.env"
(cd "$REPO_ROOT" && ONEVAULT_ANVIL_OUT="$ENV_OUT" KEEPER_ADDRESS="$KEEPER_ACCOUNT" EMERGENCY_ADDRESS="$EMERGENCY" \
    forge script contracts/test/prototype/anvil/OneVaultDeliveryAnvil.s.sol --rpc-url "$RPC_URL" \
    --broadcast --unlocked --sender "$DEPLOYER" --slow >"$WORK/deploy.log" 2>&1) \
    || { echo "FAIL: the one-vault stack did not deploy on anvil"; tail -40 "$WORK/deploy.log"; exit 1; }
[[ -s "$ENV_OUT" ]] || { echo "FAIL: the deploy wrote no address file"; exit 1; }
# shellcheck disable=SC1090
source <(sed 's/^/export /' "$ENV_OUT")
check "the one-vault queue and fund deploy on anvil" '[[ -n "${QUEUE:-}" && -n "${FUND:-}" ]]'

# The happy-path cases need a Rebalancer on this chain. The one-vault anvil stack deploys the fund and the queue only,
# and no anvil script in this repository deploys the Rebalancer proxy yet. Fail here rather than pass without them.
echo "FAIL: no anvil deploy of the Rebalancer exists; the settle, step and low_gas happy-path cases cannot run"
echo "passed=$PASS failed=$((FAIL + 1))"
exit 1
