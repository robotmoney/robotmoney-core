#!/usr/bin/env bash
# Canonical: docs/operations/contract-release-runbooks.md ("Recorder keeper")
#            docs/adr/ADR-0001-vault-strategy.md
# Implements core issue 1779.
#
# WHY THIS SCRIPT EXISTS
# The rmAGENT vault reads its price from UniswapV4PriceRecorder. Nobody has to call the permissionless
# `record()`, so on Base mainnet nobody did. After 1800 s without a call every rmAGENT deposit and USDC
# redeem reverts StaleRecorder. After a long gap the recorded tick also lags the live pool tick, so the
# NAV deviation guard refuses deposits. One `record()` moves the recorded tick by at most 600 ticks (about
# 6.2 percent), and only when 60 s or more have passed since the last one. So a long gap needs repeated calls.
#
# WHAT IT DOES
# Every INTERVAL_SECS (default 240, under the 300 s promise) it:
#   1. reads isFresh() and alerts `recorder_stale` when it reads false,
#   2. calls record() and alerts `record_failed` when the call fails,
#   3. while the live tick is more than MAX_DEVIATION_TICKS from the recorded tick, waits
#      CATCHUP_INTERVAL_SECS (default 60) and calls record() again, up to MAX_CATCHUP_CALLS times,
#      then alerts `deviation_not_converged` when it gives up,
#   4. alerts `recorder_stale` again when isFresh() still reads false after the call.
# 100 ticks is about 1 percent of price (1.0001^100). The default 90 keeps a margin under a 1 percent guard.
#
# CONFIGURATION (environment)
#   RPC_URL                 required. Base JSON-RPC endpoint.
#   RECORDER_ADDRESS        required. The rmAGENT UniswapV4PriceRecorder.
#   KEEPER_KEYSTORE         required. Path to an encrypted keystore of a funded low-privilege key.
#   KEEPER_PASSWORD_FILE    required. 0600 file holding the keystore password.
#   ALERT_WEBHOOK           optional. URL that receives each alert as a JSON POST. Alerts always go to stderr.
#   INTERVAL_SECS           optional, default 240.
#   CATCHUP_INTERVAL_SECS   optional, default 60.
#   MAX_CATCHUP_CALLS       optional, default 30.
#   MAX_DEVIATION_TICKS     optional, default 90.
#   SLEEP_CMD               optional, default `sleep`. The self-test replaces it to move chain time.
#
# USAGE
#   scripts/ops/recorder-keeper.sh          run forever (a supervisor restarts it)
#   scripts/ops/recorder-keeper.sh --once   one tick then exit; exit 0 healthy, 1 an alert fired, 2 bad config
#
# The key needs gas only. `record()` is permissionless and the key holds no role, no USDC and no shares.

set -uo pipefail

RPC_URL="${RPC_URL:-}"
RECORDER_ADDRESS="${RECORDER_ADDRESS:-}"
KEEPER_KEYSTORE="${KEEPER_KEYSTORE:-}"
KEEPER_PASSWORD_FILE="${KEEPER_PASSWORD_FILE:-}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"
INTERVAL_SECS="${INTERVAL_SECS:-240}"
CATCHUP_INTERVAL_SECS="${CATCHUP_INTERVAL_SECS:-60}"
MAX_CATCHUP_CALLS="${MAX_CATCHUP_CALLS:-30}"
MAX_DEVIATION_TICKS="${MAX_DEVIATION_TICKS:-90}"
SLEEP_CMD="${SLEEP_CMD:-sleep}"

ALERTS=0

die() {
    echo "recorder-keeper: $1" >&2
    exit 2
}

alert() {
    local kind="$1" detail="$2"
    local body
    detail="${detail//\"/\'}"
    detail="${detail//$'\n'/ }"
    body=$(printf '{"alert":"%s","recorder":"%s","detail":"%s","ts":%s}' \
        "$kind" "$RECORDER_ADDRESS" "$detail" "$(date +%s)")
    echo "$body" >&2
    ALERTS=$((ALERTS + 1))
    if [[ -n "$ALERT_WEBHOOK" ]]; then
        curl -sS --max-time 10 -X POST -H 'Content-Type: application/json' -d "$body" "$ALERT_WEBHOOK" >/dev/null 2>&1 \
            || echo "recorder-keeper: webhook post failed" >&2
    fi
}

# Returns 0 fresh, 1 stale, 2 unreadable (already alerted).
is_fresh() {
    local out
    out=$(cast call "$RECORDER_ADDRESS" "isFresh()(bool)" --rpc-url "$RPC_URL" 2>&1) || {
        alert "recorder_unreadable" "isFresh() call failed: ${out:0:300}"
        return 2
    }
    [[ "$out" == "true" ]] && return 0
    return 1
}

# Prints |live tick - recorded tick|. Returns 1 when either read fails.
deviation_ticks() {
    local last live
    last=$(cast call "$RECORDER_ADDRESS" "latest()(int24,uint32,uint16,uint16,uint16)" --rpc-url "$RPC_URL" 2>/dev/null | sed -n 1p | awk '{print $1}')
    live=$(cast call "$RECORDER_ADDRESS" "slot0()(uint160,int24,uint16,uint16)" --rpc-url "$RPC_URL" 2>/dev/null | sed -n 2p | awk '{print $1}')
    [[ "$last" =~ ^-?[0-9]+$ && "$live" =~ ^-?[0-9]+$ ]] || return 1
    local d=$((live - last))
    echo "${d#-}"
}

record() {
    local out
    out=$(cast send "$RECORDER_ADDRESS" "record()" --rpc-url "$RPC_URL" \
        --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE" 2>&1) || {
        alert "record_failed" "record() send failed: ${out:0:300}"
        return 1
    }
    return 0
}

tick() {
    ALERTS=0
    local fresh=0
    is_fresh || fresh=$?
    if [[ $fresh -eq 1 ]]; then
        alert "recorder_stale" "isFresh() reads false before the call; catching up"
    elif [[ $fresh -eq 2 ]]; then
        return 1
    fi

    record || return 1

    local calls=1 dev
    while :; do
        dev=$(deviation_ticks) || {
            alert "recorder_unreadable" "latest() or slot0() read failed"
            return 1
        }
        echo "recorder-keeper: deviation ${dev} ticks after ${calls} call(s)" >&2
        if (( dev <= MAX_DEVIATION_TICKS )); then
            break
        fi
        if (( calls > MAX_CATCHUP_CALLS )); then
            alert "deviation_not_converged" "deviation ${dev} ticks still above ${MAX_DEVIATION_TICKS} after ${calls} calls"
            return 1
        fi
        $SLEEP_CMD "$CATCHUP_INTERVAL_SECS"
        record || return 1
        calls=$((calls + 1))
    done

    fresh=0
    is_fresh || fresh=$?
    if [[ $fresh -eq 1 ]]; then
        alert "recorder_stale" "isFresh() still reads false after record()"
    fi
    [[ $ALERTS -eq 0 ]]
}

for v in RPC_URL RECORDER_ADDRESS KEEPER_KEYSTORE KEEPER_PASSWORD_FILE; do
    [[ -n "${!v}" ]] || die "$v is not set"
done
[[ -f "$KEEPER_KEYSTORE" ]] || die "KEEPER_KEYSTORE is not a file"
[[ -f "$KEEPER_PASSWORD_FILE" ]] || die "KEEPER_PASSWORD_FILE is not a file"
command -v cast >/dev/null || die "cast (foundry) is not installed"

if [[ "${1:-}" == "--once" ]]; then
    tick && exit 0 || exit 1
fi

while :; do
    tick || true
    $SLEEP_CMD "$INTERVAL_SECS"
done
