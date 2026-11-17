#!/usr/bin/env bash
# Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.4 (who calls step()) and §8 (the keeper service);
#            docs/technical/one-vault-timed-flows-eng-plan.md E10 (who settles, and with what);
#            docs/operations/contract-release-runbooks.md ("One-vault keeper")
# Implements core issue 2033.
#
# WHY THIS SCRIPT EXISTS
# FlowQueue.settle() and Rebalancer.step() are restricted to KEEPER_ROLE. The role is held by a KeeperAccount, a
# multisig-owned contract whose bot keys may call `execute(target, calldata)`. Nobody calls these functions on a
# cadence, so epochs never settle and rebalance plans never advance. This keeper makes the calls. The keeper can only
# choose timing. It cannot choose amounts, assets, floors or recipients, and its key holds no role of its own.
#
# WHAT IT DOES
# Every INTERVAL_SECS (default 300) it:
#   1. reads the keeper key's gas balance and the queue's liveness(),
#   2. alerts keeper_unconfigured when the queue has no KEEPER_ROLE holder or the key is not a bot key of the account,
#   3. alerts queue_paused when the queue is paused, and skips settle() while it is,
#   4. reads checkSettle(). When it reads Ok, settle(MAX_REQUESTS, MAX_USDC) is due,
#   5. reads previewStep(). When it reads SkipReason.None, it simulates step() as KeeperAccount. A simulated None means
#      step() is due. A simulated StepFailed, or a revert, alerts step_failed and sends nothing,
#   6. reads fund().isAssetInSale(i) for every asset, and stepDelisted(i) is due for each asset in sale,
#   7. when anything is due and the key holds less than MIN_GAS_WEI, alerts low_gas and sends nothing,
#   8. sends each due call as KeeperAccount.execute(target, calldata). A revert alerts settle_failed, step_failed or
#      delist_step_failed. A failed call does not stop the other calls in the tick.
# A check that is not Ok but is not an alert (a sequencer, feed or window check) is logged on stderr and the tick goes on.
#
# ALERTS (one JSON object per alert on stderr, and a POST to ALERT_WEBHOOK when it is set)
#   keeper_unconfigured  the queue has no KEEPER_ROLE holder, or KEEPER_KEYSTORE's key is not a bot key of the account. Exit 1.
#   queue_paused         the queue reads paused now. Settle is skipped. Exit 1.
#   low_gas              the key holds less than MIN_GAS_WEI while a call is due. Nothing is sent. Exit 1.
#   settle_failed        the settle() send failed or reverted. Exit 1.
#   step_failed          the step() send failed or reverted. Exit 1.
#   delist_step_failed   the stepDelisted(i) send failed or reverted. Exit 1.
#   rpc_unreadable       a read of the chain or a contract failed. Nothing is sent for that tick. Exit 1.
# A missing or malformed setting exits 2 before any read.
#
# CONFIGURATION (environment)
#   RPC_URL                 required. JSON-RPC endpoint of the chain holding the one-vault contracts.
#   QUEUE_ADDRESS           required. The one-vault FlowQueue proxy.
#   REBALANCER_ADDRESS      required. The one-vault Rebalancer.
#   KEEPER_ACCOUNT_ADDRESS  required. The KeeperAccount that holds KEEPER_ROLE. Its execute() forwards each call.
#   KEEPER_KEYSTORE         required. Encrypted keystore of the bot key (gas only, a bot key of the account).
#   KEEPER_PASSWORD_FILE    required. 0600 file holding the keystore password.
#   ALERT_WEBHOOK           optional. URL that receives each alert as a JSON POST. Alerts always go to stderr.
#   INTERVAL_SECS           optional, default 300.
#   MIN_GAS_WEI             optional, default 1000000000000000 (0.001 ETH).
#   MAX_REQUESTS            optional, default 100. The settle() cap on requests looked at per call.
#   MAX_USDC                optional, default 2^256-1 (no USDC cap). The settle() cap on USDC per call.
#   SLEEP_CMD               optional, default `sleep`. Used between ticks of the loop only: --once never sleeps.
#
# USAGE
#   scripts/ops/onevault-keeper.sh          run forever (a supervisor restarts it)
#   scripts/ops/onevault-keeper.sh --once   one tick then exit; exit 0 healthy, 1 an alert fired, 2 bad config

set -uo pipefail

RPC_URL="${RPC_URL:-}"
QUEUE_ADDRESS="${QUEUE_ADDRESS:-}"
REBALANCER_ADDRESS="${REBALANCER_ADDRESS:-}"
KEEPER_ACCOUNT_ADDRESS="${KEEPER_ACCOUNT_ADDRESS:-}"
KEEPER_KEYSTORE="${KEEPER_KEYSTORE:-}"
KEEPER_PASSWORD_FILE="${KEEPER_PASSWORD_FILE:-}"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"
INTERVAL_SECS="${INTERVAL_SECS:-300}"
MIN_GAS_WEI="${MIN_GAS_WEI:-1000000000000000}"
MAX_REQUESTS="${MAX_REQUESTS:-100}"
MAX_USDC="${MAX_USDC:-115792089237316195423570985008687907853269984665640564039457584007913129639935}"
SLEEP_CMD="${SLEEP_CMD:-sleep}"

ALERTS=0
KEEPER_ADDR=""
UINT_MAX=115792089237316195423570985008687907853269984665640564039457584007913129639935

die() {
    echo "onevault-keeper: $1" >&2
    exit 2
}

alert() {
    local kind="$1" detail="$2"
    local body
    detail="${detail//\"/\'}"
    detail="${detail//$'\n'/ }"
    body=$(printf '{"alert":"%s","queue":"%s","detail":"%s","ts":%s}' \
        "$kind" "$QUEUE_ADDRESS" "$detail" "$(date +%s)")
    echo "$body" >&2
    ALERTS=$((ALERTS + 1))
    if [[ -n "$ALERT_WEBHOOK" ]]; then
        curl -sS --max-time 10 -X POST -H 'Content-Type: application/json' -d "$body" "$ALERT_WEBHOOK" >/dev/null 2>&1 \
            || echo "onevault-keeper: webhook post failed" >&2
    fi
}

# Reads one call into READ_OUT, one value per line, each reduced to its first word. Alerts rpc_unreadable and returns 1
# when the read fails. It sets a global, not a subshell result, so an alert counts in this shell.
READ_OUT=""
read_call() {
    local raw
    if ! raw=$(cast call "$@" --rpc-url "$RPC_URL" 2>&1); then
        alert "rpc_unreadable" "cast call $1 $2 failed: ${raw:0:300}"
        return 1
    fi
    READ_OUT=$(printf '%s\n' "$raw" | awk '{print $1}')
}

# Reads the native balance of KEEPER_ADDR into READ_OUT (wei, decimal). Same contract as read_call.
read_balance() {
    local raw
    if ! raw=$(cast balance "$KEEPER_ADDR" --rpc-url "$RPC_URL" 2>&1); then
        alert "rpc_unreadable" "cast balance failed: ${raw:0:300}"
        return 1
    fi
    READ_OUT=$(printf '%s\n' "$raw" | awk '{print $1}')
}

# Sends KeeperAccount.execute(target, calldata) as the bot key. Returns 1 and alerts `kind` when the send fails.
forward() {
    local kind="$1" target="$2" sig="$3"
    shift 3
    local calldata out
    calldata=$(cast calldata "$sig" "$@") || { alert "$kind" "cast calldata $sig failed"; return 1; }
    out=$(cast send "$KEEPER_ACCOUNT_ADDRESS" "execute(address,bytes)" "$target" "$calldata" --rpc-url "$RPC_URL" \
        --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE" 2>&1) || {
        alert "$kind" "execute($sig) on $target failed: ${out:0:300}"
        return 1
    }
    echo "onevault-keeper: sent $sig to $target" >&2
    return 0
}

# Decides whether stepDelisted(index) should be sent. Returns 0 to send, 1 to skip. An alert is raised inside (and counted)
# only for a real failure. The simulation runs as KeeperAccount, which holds KEEPER_ROLE, so a send would run the same call.
#   - stepDelisted reverts in simulation: delist_step_failed, skip.
#   - it returns true: send.
#   - it returns false and the asset's backoff is still active: a backoff skip, logged, no alert.
#   - it returns false with no backoff: the fund's sale step is simulated as the Rebalancer. If that reverts, the sale
#     failed and the Rebalancer caught it, so delist_step_failed, skip. If it succeeds, the false comes from the
#     Rebalancer's interval or cap, so an interval skip, logged, no alert.
delist_gate() {
    local fund="$1" idx="$2" sim now
    if ! sim=$(cast call "$REBALANCER_ADDRESS" "stepDelisted(uint256)(bool)" "$idx" --from "$KEEPER_ACCOUNT_ADDRESS" \
        --rpc-url "$RPC_URL" 2>&1); then
        alert "delist_step_failed" "simulated stepDelisted($idx) reverted: ${sim:0:300}"
        return 1
    fi
    [[ "$(printf '%s\n' "$sim" | awk '{print $1}')" == "true" ]] && return 0
    read_call "$REBALANCER_ADDRESS" "assetBackoffUntil(uint256)(uint64)" "$idx" || return 1
    now=$(cast block latest --rpc-url "$RPC_URL" -f timestamp 2>/dev/null) \
        || { alert "rpc_unreadable" "cast block latest failed"; return 1; }
    if (( READ_OUT >= now )); then
        echo "onevault-keeper: stepDelisted($idx) in backoff until $READ_OUT, not sent" >&2
        return 1
    fi
    if sim=$(cast call "$fund" "executeDelistStep(uint256,uint256)(bool,uint256,uint256)" "$idx" "$UINT_MAX" \
        --from "$REBALANCER_ADDRESS" --rpc-url "$RPC_URL" 2>&1); then
        echo "onevault-keeper: stepDelisted($idx) skipped by the rebalancer interval or cap, not sent" >&2
    else
        alert "delist_step_failed" "the sale of asset $idx would revert, and the rebalancer catches it: ${sim:0:300}"
    fi
    return 1
}

tick() {
    ALERTS=0
    local -a L
    local settle_due=0 step_due=0 configured=1 fund assets i in_sale idx
    local -a delisted=()

    read_balance || return 1
    local gas="$READ_OUT"
    read_call "$QUEUE_ADDRESS" "liveness()(bool,bool,uint64,bool,bool,uint32,uint32)" || return 1
    mapfile -t L <<<"$READ_OUT"
    [[ ${#L[@]} -eq 7 ]] || { alert "rpc_unreadable" "liveness() returned ${#L[@]} values"; return 1; }
    if [[ "${L[0]}" != "true" ]]; then
        alert "keeper_unconfigured" "queue $QUEUE_ADDRESS has no KEEPER_ROLE holder"
        configured=0
    fi
    read_call "$KEEPER_ACCOUNT_ADDRESS" "isBotKey(address)(bool)" "$KEEPER_ADDR" || return 1
    if [[ "$READ_OUT" != "true" ]]; then
        alert "keeper_unconfigured" "key $KEEPER_ADDR is not a bot key of $KEEPER_ACCOUNT_ADDRESS"
        configured=0
    fi
    (( configured )) || return 1

    if [[ "${L[1]}" == "true" ]]; then
        alert "queue_paused" "queue $QUEUE_ADDRESS is paused; settle() skipped"
    else
        # checkSettle reads msg.sender (check 1 is the keeper caller). The settle call runs as KeeperAccount, so read as it.
        read_call "$QUEUE_ADDRESS" "checkSettle()(uint8,uint256)" --from "$KEEPER_ACCOUNT_ADDRESS" || return 1
        mapfile -t L <<<"$READ_OUT"
        [[ ${#L[@]} -eq 2 ]] || { alert "rpc_unreadable" "checkSettle() returned ${#L[@]} values"; return 1; }
        if [[ "${L[0]}" == "0" ]]; then
            settle_due=1
        else
            echo "onevault-keeper: settle not due, checkSettle code ${L[0]} index ${L[1]}" >&2
        fi
    fi

    read_call "$REBALANCER_ADDRESS" "previewStep()(uint8,uint256,uint256,uint256)" || return 1
    mapfile -t L <<<"$READ_OUT"
    [[ ${#L[@]} -eq 4 ]] || { alert "rpc_unreadable" "previewStep() returned ${#L[@]} values"; return 1; }
    if [[ "${L[0]}" == "0" ]]; then
        # previewStep does not run the fund's step, so a step that would fail (the fund reverts, and step() returns
        # StepFailed) still reads None. Simulate step() as the KeeperAccount, the caller it needs, before any send.
        local sim
        if sim=$(cast call "$REBALANCER_ADDRESS" "step()(bool,uint8)" --from "$KEEPER_ACCOUNT_ADDRESS" --rpc-url "$RPC_URL" 2>&1); then
            local sim_reason
            sim_reason=$(printf '%s\n' "$sim" | sed -n 2p | awk '{print $1}')
            if [[ "$sim_reason" == "0" ]]; then
                step_due=1
            elif [[ "$sim_reason" == "6" ]]; then
                alert "step_failed" "simulated step() returned StepFailed; nothing sent"
            else
                echo "onevault-keeper: step simulated to skip, SkipReason $sim_reason" >&2
            fi
        else
            alert "step_failed" "simulated step() reverted: ${sim:0:300}"
        fi
    else
        echo "onevault-keeper: step not due, SkipReason ${L[0]}" >&2
    fi

    read_call "$REBALANCER_ADDRESS" "fund()(address)" || return 1
    fund="$READ_OUT"
    read_call "$fund" "assetCount()(uint256)" || return 1
    assets="$READ_OUT"
    for ((i = 0; i < assets; i++)); do
        read_call "$fund" "isAssetInSale(uint256)(bool)" "$i" || return 1
        in_sale="$READ_OUT"
        [[ "$in_sale" == "true" ]] && delisted+=("$i")
    done

    local -a delist_send=()
    local i
    for i in "${delisted[@]}"; do
        if delist_gate "$fund" "$i"; then delist_send+=("$i"); fi
    done

    local due=$((settle_due + step_due + ${#delist_send[@]}))
    if (( due == 0 )); then
        echo "onevault-keeper: nothing due" >&2
        [[ $ALERTS -eq 0 ]]
        return
    fi
    # Bash integers overflow past 2^63 (about 9.2 ETH in wei), so the gas comparison runs in python.
    if [[ "$(python3 -I -c 'import sys; print(int(sys.argv[1]) < int(sys.argv[2]))' "$gas" "$MIN_GAS_WEI")" == "True" ]]; then
        alert "low_gas" "key $KEEPER_ADDR holds $gas wei, below MIN_GAS_WEI $MIN_GAS_WEI; nothing sent"
        return 1
    fi

    if (( settle_due )); then
        forward settle_failed "$QUEUE_ADDRESS" "settle(uint256,uint256)" "$MAX_REQUESTS" "$MAX_USDC" || true
    fi
    if (( step_due )); then
        forward step_failed "$REBALANCER_ADDRESS" "step()" || true
    fi
    local idx
    for idx in "${delist_send[@]}"; do
        forward delist_step_failed "$REBALANCER_ADDRESS" "stepDelisted(uint256)" "$idx" || true
    done

    [[ $ALERTS -eq 0 ]]
}

for v in RPC_URL QUEUE_ADDRESS REBALANCER_ADDRESS KEEPER_ACCOUNT_ADDRESS KEEPER_KEYSTORE KEEPER_PASSWORD_FILE; do
    [[ -n "${!v}" ]] || die "$v is not set"
done
for v in QUEUE_ADDRESS REBALANCER_ADDRESS KEEPER_ACCOUNT_ADDRESS; do
    [[ "${!v}" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "$v is not an address"
done
[[ -f "$KEEPER_KEYSTORE" ]] || die "KEEPER_KEYSTORE is not a file"
[[ -f "$KEEPER_PASSWORD_FILE" ]] || die "KEEPER_PASSWORD_FILE is not a file"
command -v cast >/dev/null || die "cast (foundry) is not installed"
command -v curl >/dev/null || die "curl is not installed"
command -v python3 >/dev/null || die "python3 is not installed"

KEEPER_ADDR="$(cast wallet address --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE")" \
    || die "KEEPER_KEYSTORE could not be opened with KEEPER_PASSWORD_FILE"

if [[ "${1:-}" == "--once" ]]; then
    tick && exit 0 || exit 1
fi

while :; do
    tick || true
    $SLEEP_CMD "$INTERVAL_SECS"
done
