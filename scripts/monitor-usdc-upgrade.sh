#!/usr/bin/env bash
# Canonical: docs/technical/upstream-monitoring-runbook.md §3
#
# WHY THIS SCRIPT EXISTS
# docs/technical/security-model.md §8 mandates: "USDC is upgradeable by Circle.
# A monitoring process must alert on Circle upgrade proposals. The vault must have
# a documented pause-and-review procedure if USDC semantics change."
#
# CONTRACT ADDRESSES (Base mainnet)
#   USDC transparent proxy:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
#   USDC proxy admin:        resolved via EIP-1967 storage slot
#
# APPROACH
# The USDC contract on Base uses a transparent proxy pattern (EIP-1967).
# An upgrade emits an Upgraded(address indexed implementation) event from the proxy.
# We also check the AdminChanged(address previousAdmin, address newAdmin) event.
# This script queries eth_getLogs for these events over a configurable look-back window.
#
# EIP-1967 events:
#   Upgraded(address):      topic0 = keccak256("Upgraded(address)") = 0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b
#   AdminChanged(address,address): topic0 = keccak256("AdminChanged(address,address)") = 0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f
# Circle also emits OwnershipTransferred events and uses a MasterMinter model.
#
# USAGE
#   RPC_URL=<base-rpc-url> bash scripts/monitor-usdc-upgrade.sh
#   Exit 0 → no upgrade events; exit 1 → alert.
#
# MOCK MODE (tests)
#   Set MOCK_USDC_UPGRADE=1 to inject a synthetic upgradeTo event.
#   Set BLOCKS_TO_SCAN=N to override the look-back window.

set -euo pipefail

RPC_URL="${RPC_URL:-}"
RPC_FALLBACK_URLS="${RPC_FALLBACK_URLS:-}"
MOCK_USDC_UPGRADE="${MOCK_USDC_UPGRADE:-0}"
# Look back ~7 days of Base blocks (avg 2s/block → ~302400 blocks/week)
BLOCKS_TO_SCAN="${BLOCKS_TO_SCAN:-302400}"
LOG_CHUNK_SIZE="${LOG_CHUNK_SIZE:-45000}"
RPC_RETRY_DELAYS="${RPC_RETRY_DELAYS:-1 2 4}"

# USDC transparent proxy on Base mainnet
USDC_PROXY_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# EIP-1967 Upgraded event topic
UPGRADED_TOPIC="0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b"
# EIP-1967 AdminChanged event topic
ADMIN_CHANGED_TOPIC="0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f"

rpc_post() {
    local payload="$1"
    local -a urls=()
    local -a retry_delays=()
    local ifs_bak="$IFS"

    if [[ -n "$RPC_URL" ]]; then
        urls+=("$RPC_URL")
    fi
    if [[ -n "$RPC_FALLBACK_URLS" ]]; then
        local -a fb=()
        local u
        IFS=',' read -ra fb <<< "$RPC_FALLBACK_URLS"
        for u in "${fb[@]}"; do
            u="${u#"${u%%[![:space:]]*}"}"
            u="${u%"${u##*[![:space:]]}"}"
            if [[ -n "$u" ]]; then
                urls+=("$u")
            fi
        done
    fi
    IFS="$ifs_bak"

    if (( ${#urls[@]} == 0 )); then
        echo "ERROR: RPC_URL is not set" >&2
        return 1
    fi

    read -ra retry_delays <<< "$RPC_RETRY_DELAYS"

    local url
    for url in "${urls[@]}"; do
        local attempt=0
        local max_attempts=$(( ${#retry_delays[@]} + 1 ))
        while (( attempt < max_attempts )); do
            local resp http_code body curl_exit=0
            resp=$(curl -sS --connect-timeout 10 --max-time 30 \
                -w $'\n%{http_code}' \
                -X POST "$url" \
                -H "Content-Type: application/json" \
                -d "$payload" 2>&1) || curl_exit=$?

            if (( curl_exit != 0 )); then
                echo "WARN: RPC request to $url failed (curl exit $curl_exit, attempt $((attempt + 1))/$max_attempts): $resp" >&2
            else
                http_code="${resp##*$'\n'}"
                body="${resp%$'\n'*}"
                if [[ "$http_code" =~ ^2[0-9][0-9]$ ]]; then
                    if echo "$body" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if not isinstance(d, dict):
    sys.stderr.write('ERROR: JSON-RPC response is not an object\n')
    sys.exit(1)
if 'error' in d and d['error'] is not None:
    sys.stderr.write(f'ERROR: JSON-RPC error: {d[\"error\"]}\n')
    sys.exit(1)
if 'result' not in d:
    sys.stderr.write('ERROR: JSON-RPC response missing result\n')
    sys.exit(1)
"; then
                        printf '%s' "$body"
                        return 0
                    else
                        echo "ERROR: RPC $url returned invalid/error JSON-RPC response" >&2
                        break
                    fi
                elif [[ "$http_code" == "429" || "$http_code" =~ ^5[0-9][0-9]$ ]]; then
                    echo "WARN: RPC $url returned HTTP $http_code (attempt $((attempt + 1))/$max_attempts)" >&2
                else
                    echo "ERROR: RPC $url returned HTTP $http_code: $body" >&2
                    break
                fi
            fi

            if (( attempt < ${#retry_delays[@]} )); then
                sleep "${retry_delays[$attempt]}"
            fi
            (( attempt++ )) || true
        done
    done

    echo "ERROR: All RPC attempts failed" >&2
    return 1
}

get_latest_block() {
    local resp
    resp=$(rpc_post '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}') || return 1
    echo "$resp" | python3 -c "
import json, sys
d = json.load(sys.stdin)
res = d.get('result')
if not isinstance(res, str) or not res.startswith('0x'):
    sys.stderr.write(f'ERROR: eth_blockNumber invalid result: {res!r}\n')
    sys.exit(1)
print(int(res, 16))
"
}

get_logs_count() {
    local address="$1"
    local topic0="$2"
    local from_block="$3"
    local to_block="$4"
    local chunk_size="$LOG_CHUNK_SIZE"

    if (( chunk_size < 1 )); then
        echo "ERROR: LOG_CHUNK_SIZE must be >= 1 (got $chunk_size)" >&2
        return 1
    fi

    local total_count=0
    local chunk_start="$from_block"
    while (( chunk_start <= to_block )); do
        local chunk_end=$(( chunk_start + chunk_size - 1 ))
        if (( chunk_end > to_block )); then
            chunk_end="$to_block"
        fi
        local from_hex to_hex payload resp chunk_count
        from_hex=$(printf '0x%x' "$chunk_start")
        to_hex=$(printf '0x%x' "$chunk_end")
        payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"address\":\"$address\",\"topics\":[\"$topic0\"],\"fromBlock\":\"$from_hex\",\"toBlock\":\"$to_hex\"}]}"
        resp=$(rpc_post "$payload") || return 1
        chunk_count=$(echo "$resp" | python3 -c "
import json, sys
d = json.load(sys.stdin)
res = d.get('result')
if not isinstance(res, list):
    sys.stderr.write(f'ERROR: eth_getLogs result is not a list: {type(res).__name__}\n')
    sys.exit(1)
print(len(res))
") || return 1
        total_count=$(( total_count + chunk_count ))
        chunk_start=$(( chunk_end + 1 ))
    done
    echo "$total_count"
}

check_usdc_upgrade() {
    if [[ "$MOCK_USDC_UPGRADE" == "1" ]]; then
        echo "alert:upgradeTo"
        return
    fi
    if [[ -z "$RPC_URL" ]]; then
        echo "no-rpc"
        return
    fi

    local latest
    latest=$(get_latest_block) || { echo "rpc-error"; return 0; }
    local from_block=$(( latest - BLOCKS_TO_SCAN ))
    if (( from_block < 0 )); then from_block=0; fi

    # Check for Upgraded events (implementation upgrade)
    local upgraded_count
    upgraded_count=$(get_logs_count "$USDC_PROXY_ADDRESS" "$UPGRADED_TOPIC" "$from_block" "$latest") || {
        echo "rpc-error"
        return 0
    }

    # Check for AdminChanged events (proxy admin change)
    local admin_count
    admin_count=$(get_logs_count "$USDC_PROXY_ADDRESS" "$ADMIN_CHANGED_TOPIC" "$from_block" "$latest") || {
        echo "rpc-error"
        return 0
    }

    if (( upgraded_count > 0 && admin_count > 0 )); then
        echo "alert:upgraded+admin_changed"
    elif (( upgraded_count > 0 )); then
        echo "alert:upgraded"
    elif (( admin_count > 0 )); then
        echo "alert:admin_changed"
    else
        echo "clear"
    fi
}

main() {
    local usdc_status alert

    usdc_status=$(check_usdc_upgrade)

    alert="false"
    if [[ "$usdc_status" == alert:* ]]; then
        alert="true"
    fi

    # Extract event type for structured output
    local event_type="none"
    if [[ "$usdc_status" == alert:* ]]; then
        event_type="${usdc_status#alert:}"
    fi

    python3 -c "
import json, sys
result = {
    'alert': '$alert' == 'true',
    'usdc': {
        'proxy_address': '$USDC_PROXY_ADDRESS',
        'status': '$usdc_status',
        'alert': '$alert' == 'true',
        'event_type': '$event_type',
    },
    'blocks_scanned': $BLOCKS_TO_SCAN,
    'runbook': 'docs/technical/upstream-monitoring-runbook.md#usdc-upgrade',
}
print(json.dumps(result, indent=2))
if result['alert'] or '$usdc_status' == 'rpc-error':
    sys.exit(1)
"
}

main "$@"
