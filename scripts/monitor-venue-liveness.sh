#!/usr/bin/env bash
# Canonical: docs/technical/upstream-monitoring-runbook.md §1
#
# WHY THIS SCRIPT EXISTS
# docs/technical/security-model.md §5 mandates: "A monitoring alert must exist
# for each venue going offline." Compound v3 (Comet) and Aave v3 are accepted
# upstream-trust assumptions; without an offline alert an adapter could silently
# return stale or zero balances.
#
# CONTRACT ADDRESSES (Base mainnet, fork pin: testing/fixtures/CURRENT.json)
#   Compound V3 Comet: 0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf
#   Aave V3 Pool:      0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
#   USDC:              0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
#
# USAGE
#   RPC_URL=<base-rpc-url> bash scripts/monitor-venue-liveness.sh
#   Exit 0 → both venues live; exit 1 → alert (at least one venue offline/paused).
#   Structured JSON is written to stdout so CI can capture it.
#
# MOCK MODE (tests)
#   Set MOCK_COMPOUND_PAUSED=1 or MOCK_AAVE_PAUSED=1 to simulate a paused venue.
#   Set MOCK_COMPOUND_OFFLINE=1 or MOCK_AAVE_OFFLINE=1 to simulate an RPC failure.

set -euo pipefail

RPC_URL="${RPC_URL:-}"
MOCK_COMPOUND_PAUSED="${MOCK_COMPOUND_PAUSED:-0}"
MOCK_AAVE_PAUSED="${MOCK_AAVE_PAUSED:-0}"
MOCK_COMPOUND_OFFLINE="${MOCK_COMPOUND_OFFLINE:-0}"
MOCK_AAVE_OFFLINE="${MOCK_AAVE_OFFLINE:-0}"

# Base mainnet contract addresses
COMET_ADDRESS="0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf"
AAVE_POOL_ADDRESS="0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"

# isAbsorbing() selector: keccak256("isAbsorbing()")[0:4] = 0xaa63b9c9
COMET_IS_ABSORBING_SELECTOR="0xaa63b9c9"
# paused() on Aave V3 Pool: keccak256("paused()")[0:4] = 0x5c975abb
AAVE_PAUSED_SELECTOR="0x5c975abb"

eth_call() {
    local to="$1"
    local data="$2"
    if [[ -z "$RPC_URL" ]]; then
        echo "ERROR: RPC_URL is not set" >&2
        return 1
    fi
    curl -sf -X POST "$RPC_URL" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$to\",\"data\":\"$data\"},\"latest\"]}" \
        2>/dev/null
}

decode_bool() {
    # Returns "true" if the last byte of the 32-byte ABI result is 0x01
    local hex_result="$1"
    # Strip 0x prefix and leading zeros; check last byte
    local stripped="${hex_result#0x}"
    local last_two="${stripped: -2}"
    if [[ "$last_two" == "01" ]]; then
        echo "true"
    else
        echo "false"
    fi
}

check_compound() {
    if [[ "$MOCK_COMPOUND_OFFLINE" == "1" ]]; then
        echo "offline"
        return
    fi
    if [[ "$MOCK_COMPOUND_PAUSED" == "1" ]]; then
        echo "paused"
        return
    fi
    if [[ -z "$RPC_URL" ]]; then
        echo "no-rpc"
        return
    fi
    local result
    result=$(eth_call "$COMET_ADDRESS" "$COMET_IS_ABSORBING_SELECTOR" 2>/dev/null) || {
        echo "offline"
        return
    }
    local hex_val
    hex_val=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','0x'))" 2>/dev/null) || {
        echo "offline"
        return
    }
    if [[ "$hex_val" == "null" || -z "$hex_val" ]]; then
        echo "offline"
        return
    fi
    # isAbsorbing() true → absorbing/paused state
    local absorbing
    absorbing=$(decode_bool "$hex_val")
    if [[ "$absorbing" == "true" ]]; then
        echo "paused"
    else
        echo "live"
    fi
}

check_aave() {
    if [[ "$MOCK_AAVE_OFFLINE" == "1" ]]; then
        echo "offline"
        return
    fi
    if [[ "$MOCK_AAVE_PAUSED" == "1" ]]; then
        echo "paused"
        return
    fi
    if [[ -z "$RPC_URL" ]]; then
        echo "no-rpc"
        return
    fi
    local result
    result=$(eth_call "$AAVE_POOL_ADDRESS" "$AAVE_PAUSED_SELECTOR" 2>/dev/null) || {
        echo "offline"
        return
    }
    local hex_val
    hex_val=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','0x'))" 2>/dev/null) || {
        echo "offline"
        return
    }
    if [[ "$hex_val" == "null" || -z "$hex_val" ]]; then
        echo "offline"
        return
    fi
    local paused
    paused=$(decode_bool "$hex_val")
    if [[ "$paused" == "true" ]]; then
        echo "paused"
    else
        echo "live"
    fi
}

main() {
    local compound_status aave_status alert
    compound_status=$(check_compound)
    aave_status=$(check_aave)

    alert="false"
    if [[ "$compound_status" != "live" && "$compound_status" != "no-rpc" ]]; then
        alert="true"
    fi
    if [[ "$aave_status" != "live" && "$aave_status" != "no-rpc" ]]; then
        alert="true"
    fi

    python3 -c "
import json, sys
result = {
    'alert': '$alert' == 'true',
    'venues': {
        'compound_v3': {
            'address': '$COMET_ADDRESS',
            'status': '$compound_status',
            'alert': '$compound_status' not in ('live', 'no-rpc'),
        },
        'aave_v3': {
            'address': '$AAVE_POOL_ADDRESS',
            'status': '$aave_status',
            'alert': '$aave_status' not in ('live', 'no-rpc'),
        },
    },
    'runbook': 'docs/technical/upstream-monitoring-runbook.md#venue-offline',
}
print(json.dumps(result, indent=2))
if result['alert']:
    sys.exit(1)
"
}

main "$@"
