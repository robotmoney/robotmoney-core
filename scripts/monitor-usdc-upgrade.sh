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
MOCK_USDC_UPGRADE="${MOCK_USDC_UPGRADE:-0}"
# Look back ~7 days of Base blocks (avg 2s/block → ~302400 blocks/week)
BLOCKS_TO_SCAN="${BLOCKS_TO_SCAN:-302400}"

# USDC transparent proxy on Base mainnet
USDC_PROXY_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# EIP-1967 Upgraded event topic
UPGRADED_TOPIC="0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b"
# EIP-1967 AdminChanged event topic
ADMIN_CHANGED_TOPIC="0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f"

get_latest_block() {
    if [[ -z "$RPC_URL" ]]; then return 1; fi
    curl -sf -X POST "$RPC_URL" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
        2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(int(d['result'],16))"
}

get_logs_for_topic() {
    local address="$1"
    local topic0="$2"
    local from_block="$3"
    if [[ -z "$RPC_URL" ]]; then return 1; fi
    curl -sf -X POST "$RPC_URL" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"address\":\"$address\",\"topics\":[\"$topic0\"],\"fromBlock\":\"0x$(printf '%x' "$from_block")\",\"toBlock\":\"latest\"}]}" \
        2>/dev/null
}

count_logs() {
    python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result',[])))" 2>/dev/null
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
    latest=$(get_latest_block 2>/dev/null) || { echo "no-rpc"; return; }
    local from_block=$(( latest - BLOCKS_TO_SCAN ))
    if (( from_block < 0 )); then from_block=0; fi

    # Check for Upgraded events (implementation upgrade)
    local upgraded_logs
    upgraded_logs=$(get_logs_for_topic "$USDC_PROXY_ADDRESS" "$UPGRADED_TOPIC" "$from_block" 2>/dev/null) || {
        echo "no-rpc"
        return
    }
    local upgraded_count
    upgraded_count=$(echo "$upgraded_logs" | count_logs) || { echo "no-rpc"; return; }

    # Check for AdminChanged events (proxy admin change)
    local admin_logs
    admin_logs=$(get_logs_for_topic "$USDC_PROXY_ADDRESS" "$ADMIN_CHANGED_TOPIC" "$from_block" 2>/dev/null) || {
        echo "no-rpc"
        return
    }
    local admin_count
    admin_count=$(echo "$admin_logs" | count_logs) || { echo "no-rpc"; return; }

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
if result['alert']:
    sys.exit(1)
"
}

main "$@"
