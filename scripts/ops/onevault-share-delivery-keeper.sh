#!/usr/bin/env bash
# Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E8 (anyone may trigger delivery of a deposit's shares to its
#            owner after the hold) and RB-18 (frozen shares are not delivered);
#            docs/operations/contract-release-runbooks.md ("Share-delivery keeper")
# Implements core issue 2026.
#
# WHY THIS SCRIPT EXISTS
# A deposit's shares wait in the one-vault queue until `settle time + minHold`. After that anyone may deliver them to
# the request's owner with `deposit(assets, owner)`, but nobody does it on its own, so the owner waits for a manual claim.
# This keeper delivers them on a cadence, to the owner's own wallet, with no second signature from the owner.
#
# WHAT IT DOES
# Every INTERVAL_SECS (default 300) it:
#   1. reads every claim (id 1 to claimCount) and keeps the open deposit claims whose unlockAt has passed and whose
#      settlement is not frozen (frozenUntil > now and unlockAt > freezeSetAt, as FlowClaimLib._deliverable),
#   2. groups the remaining USDC cost of those claims by owner,
#   3. checks the key holds MIN_GAS_WEI, and alerts low_gas and sends nothing when it does not,
#   4. calls deposit(assets, owner) once per owner. The queue delivers the owner's shares to the owner.
# A send that fails because the owner claimed first is not an alert: the queue refused a double delivery, and the next tick
# plans from the new state. Any other failed send alerts delivery_failed.
# The keeper has no role. deposit() is permissionless, and the queue never pays redemption USDC to anyone but the owner.
#
# ALERTS (one JSON object per alert on stderr, and a POST to ALERT_WEBHOOK when it is set)
#   invalid_config   a required setting is absent or malformed, or no contract is at QUEUE_ADDRESS. Exit 2.
#   rpc_unreadable   a read of the queue or the chain failed. Exit 1.
#   low_gas          the keeper key holds less than MIN_GAS_WEI while deliveries are due. Exit 1.
#   delivery_failed  a deposit(assets, owner) send failed and the owner still has deliverable shares. Exit 1.
#
# CONFIGURATION (environment)
#   RPC_URL                 required. JSON-RPC endpoint of the chain holding the queue.
#   QUEUE_ADDRESS           required. The one-vault FlowQueue proxy.
#   KEEPER_KEYSTORE         required. Encrypted keystore of a funded low-privilege key (gas only).
#   KEEPER_PASSWORD_FILE    required. 0600 file holding the keystore password.
#   ALERT_WEBHOOK           optional. URL that receives each alert as a JSON POST. Alerts always go to stderr.
#   INTERVAL_SECS           optional, default 300.
#   MIN_GAS_WEI             optional, default 1000000000000000 (0.001 ETH).
#   SLEEP_CMD               optional, default `sleep`. The self-test replaces it to move chain time.
#   CAST_BIN                optional, default `cast`. The self-test wraps it to inject a failed send.
#
# USAGE
#   scripts/ops/onevault-share-delivery-keeper.sh          run forever (a supervisor restarts it)
#   scripts/ops/onevault-share-delivery-keeper.sh --once   one tick then exit; exit 0 healthy, 1 an alert fired, 2 bad config

set -uo pipefail

RPC_URL="${RPC_URL:-}"
QUEUE_ADDRESS="${QUEUE_ADDRESS:-}"
KEEPER_KEYSTORE="${KEEPER_KEYSTORE:-}"
KEEPER_PASSWORD_FILE="${KEEPER_PASSWORD_FILE:-}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"
INTERVAL_SECS="${INTERVAL_SECS:-300}"
MIN_GAS_WEI="${MIN_GAS_WEI:-1000000000000000}"
SLEEP_CMD="${SLEEP_CMD:-sleep}"
CAST_BIN="${CAST_BIN:-cast}"

ALERTS=0
KEEPER_ADDR=""

alert() {
    local kind="$1" detail="$2" owner="${3:-}"
    local body
    detail="${detail//\"/\'}"
    detail="${detail//$'\n'/ }"
    body=$(printf '{"alert":"%s","queue":"%s","owner":"%s","detail":"%s","ts":%s}' \
        "$kind" "$QUEUE_ADDRESS" "$owner" "$detail" "$(date +%s)")
    echo "$body" >&2
    ALERTS=$((ALERTS + 1))
    if [[ -n "$ALERT_WEBHOOK" ]]; then
        curl -sS --max-time 10 -X POST -H 'Content-Type: application/json' -d "$body" "$ALERT_WEBHOOK" >/dev/null 2>&1 \
            || echo "onevault-share-delivery-keeper: webhook post failed" >&2
    fi
}

# Exits 2 after a config alert. Config errors are not operational alerts, so they do not count toward exit 1.
die() {
    alert invalid_config "$1"
    exit 2
}

# Discovery and grouping. Prints "PLAN <owner> <assets>" per owner with deliverable deposit USDC, or exits 3 with an
# "ERROR <detail>" line when a read fails. Claim and settlement fields follow FlowTypes.Claim and FlowTypes.Settlement.
# Arithmetic is exact (Python integers): usdc - ceil(usdc * claimed / shares) is the cost of the claim's undelivered shares.
discover_plan() {
    python3 -I - "$CAST_BIN" "$RPC_URL" "$QUEUE_ADDRESS" <<'PY'
import json, subprocess, sys

cast, rpc, queue = sys.argv[1], sys.argv[2], sys.argv[3]
CLAIM = "getClaim(uint256)((uint256,address,uint8,uint64,uint64,uint256,uint256,uint256,uint256))"
SETTLEMENT = "getSettlement(uint256)((uint64,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint64,uint64,uint64))"

def run(args):
    r = subprocess.run([cast] + args + ["--rpc-url", rpc], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[:300])
    return r.stdout

def read(sig, *args):
    return json.loads(run(["call", queue, sig, *[str(a) for a in args], "--json"]))[0]

try:
    now = int(run(["block", "latest", "-f", "timestamp"]).split()[0])
    count = int(read("claimCount()(uint256)")[0])
    frozen = {}
    owners = {}
    for cid in range(1, count + 1):
        (_req, owner, kind, sid, unlock_at, shares, usdc, claimed, _sc) = read(CLAIM, cid)
        kind, sid, unlock_at, shares, usdc, claimed = map(int, (kind, sid, unlock_at, shares, usdc, claimed))
        if kind != 0 or claimed >= shares or now < unlock_at:
            continue
        if sid not in frozen:
            s = read(SETTLEMENT, sid)
            frozen[sid] = (int(s[9]), int(s[10]))
        frozen_until, freeze_set_at = frozen[sid]
        if frozen_until > now and unlock_at > freeze_set_at:
            continue
        cost_before = -(-usdc * claimed // shares)
        owners[owner] = owners.get(owner, 0) + (usdc - cost_before)
    for owner in sorted(owners):
        if owners[owner] > 0:
            print("PLAN", owner, owners[owner])
except Exception as e:
    print("ERROR", str(e).replace("\n", " "))
    sys.exit(3)
PY
}

# Sends deposit(assets, owner). Returns 0 when delivered, or when the owner claimed first. Returns 1 after an alert.
deliver_one() {
    local owner="$1" assets="$2" out left
    out=$("$CAST_BIN" send "$QUEUE_ADDRESS" "deposit(uint256,address)(uint256)" "$assets" "$owner" \
        --rpc-url "$RPC_URL" --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE" 2>&1) && {
        echo "onevault-share-delivery-keeper: delivered $assets (usdc units) of deposit claims to $owner" >&2
        return 0
    }
    left=$("$CAST_BIN" call "$QUEUE_ADDRESS" "maxDeposit(address)(uint256)" "$owner" --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1}')
    if [[ "$left" =~ ^[0-9]+$ ]] && (( left < assets )); then
        echo "onevault-share-delivery-keeper: $owner claimed first; the queue refused a second delivery, next tick re-plans" >&2
        return 0
    fi
    alert delivery_failed "deposit() send failed: ${out:0:300}" "$owner"
    return 1
}

tick() {
    ALERTS=0
    local plan rc bal owner assets
    plan=$(discover_plan)
    rc=$?
    if [[ $rc -ne 0 ]]; then
        alert rpc_unreadable "claim discovery failed: ${plan:0:300}"
        return 1
    fi
    if [[ -z "$plan" ]]; then
        echo "onevault-share-delivery-keeper: no unlocked, unfrozen deposit claims to deliver" >&2
        return 0
    fi
    bal=$("$CAST_BIN" balance "$KEEPER_ADDR" --rpc-url "$RPC_URL" 2>&1) || {
        alert rpc_unreadable "keeper balance read failed: ${bal:0:300}"
        return 1
    }
    bal=$(echo "$bal" | awk '{print $1}')
    if ! python3 -I -c 'import sys; sys.exit(0 if int(sys.argv[1]) >= int(sys.argv[2]) else 1)' "$bal" "$MIN_GAS_WEI" 2>/dev/null; then
        alert low_gas "keeper $KEEPER_ADDR holds $bal wei, below MIN_GAS_WEI $MIN_GAS_WEI; no delivery sent" "$KEEPER_ADDR"
        return 1
    fi
    while read -r _ owner assets; do
        deliver_one "$owner" "$assets" || true
    done <<< "$plan"
    [[ $ALERTS -eq 0 ]]
}

[[ -n "$RPC_URL" ]] || die "RPC_URL is not set"
[[ -n "$QUEUE_ADDRESS" ]] || die "QUEUE_ADDRESS is not set"
[[ -n "$KEEPER_KEYSTORE" ]] || die "KEEPER_KEYSTORE is not set"
[[ -n "$KEEPER_PASSWORD_FILE" ]] || die "KEEPER_PASSWORD_FILE is not set"
[[ -f "$KEEPER_KEYSTORE" ]] || die "KEEPER_KEYSTORE is not a file"
[[ -f "$KEEPER_PASSWORD_FILE" ]] || die "KEEPER_PASSWORD_FILE is not a file"
[[ "$QUEUE_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "QUEUE_ADDRESS is not an address"
[[ "$INTERVAL_SECS" =~ ^[0-9]+$ ]] || die "INTERVAL_SECS is not a whole number of seconds"
[[ "$MIN_GAS_WEI" =~ ^[0-9]+$ ]] || die "MIN_GAS_WEI is not a whole number of wei"
command -v "$CAST_BIN" >/dev/null || die "cast (foundry) is not installed"
command -v python3 >/dev/null || die "python3 is not installed"
command -v curl >/dev/null || die "curl is not installed"

code=$("$CAST_BIN" code "$QUEUE_ADDRESS" --rpc-url "$RPC_URL" 2>&1) || {
    alert rpc_unreadable "eth_getCode failed: ${code:0:300}"
    exit 1
}
[[ "$code" != "0x" && -n "$code" ]] || die "no contract at QUEUE_ADDRESS $QUEUE_ADDRESS"
KEEPER_ADDR=$("$CAST_BIN" wallet address --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE" 2>&1) \
    || die "KEEPER_KEYSTORE cannot be unlocked with KEEPER_PASSWORD_FILE"

if [[ "${1:-}" == "--once" ]]; then
    tick && exit 0 || exit 1
fi

while :; do
    tick || true
    "$SLEEP_CMD" "$INTERVAL_SECS"
done
