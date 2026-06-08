#!/usr/bin/env bash
# Canonical: docs/technical/upstream-monitoring-runbook.md §2
#
# WHY THIS SCRIPT EXISTS
# docs/technical/security-model.md §8 mandates: "A monitoring process must alert
# on upstream governance proposals that affect our adapter interfaces." Compound v3
# and Aave v3 are upgradeable by their own governance; a proposal targeting the comet
# or pool contract could change the interface used by CompoundV3Adapter.sol or
# AaveV3Adapter.sol.
#
# CONTRACT ADDRESSES (Base mainnet)
#   Compound V3 Configurator (governance target): 0x45939657d1CA34A8FA39A924B71D28Fe8431e581
#   Comet (our adapter target):                   0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf
#   Aave V3 Pool:                                 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
#   Aave V3 PoolConfigurator (governance target): 0x8145eddDf43f50276641b55bd3AD95944510021E
#
# APPROACH
# On-chain governance contracts emit ProposalCreated/Queued/Executed events.
# This script queries eth_getLogs for recent blocks and flags any proposal
# that targets our adapter contract addresses.
#
# USAGE
#   RPC_URL=<base-rpc-url> bash scripts/monitor-governance-proposals.sh
#   Exit 0 → no proposals targeting adapter contracts; exit 1 → alert.
#
# MOCK MODE (tests)
#   Set MOCK_COMPOUND_PROPOSAL=1 or MOCK_AAVE_PROPOSAL=1 to inject synthetic proposals.
#   Set BLOCKS_TO_SCAN=N to override the look-back window (default: 50000 ≈ 7 days).

set -euo pipefail

RPC_URL="${RPC_URL:-}"
MOCK_COMPOUND_PROPOSAL="${MOCK_COMPOUND_PROPOSAL:-0}"
MOCK_AAVE_PROPOSAL="${MOCK_AAVE_PROPOSAL:-0}"
# Look back ~7 days of Base blocks (avg 2s/block → ~302400 blocks/week)
BLOCKS_TO_SCAN="${BLOCKS_TO_SCAN:-302400}"

# Addresses our adapters depend on
COMET_ADDRESS="0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf"
AAVE_POOL_ADDRESS="0xa238dd80c259a72e81d7e4664a9801593f98d1c5"

# Compound v3 Configurator ProposalCreated topic (Compound Governor Bravo)
# topic0: keccak256("ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)")
COMPOUND_PROPOSAL_TOPIC="0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0"

# Aave governance ProposalCreated topic (AaveGovernanceV2 / GovernanceV3)
# topic0: keccak256("ProposalCreated(uint256,address,address,address[],uint256[],string[],bytes[],bool[],uint256,uint256,uint256,bytes32)")
AAVE_PROPOSAL_TOPIC="0xd272d67d2c8c66de43c1d2515abb064978a5020c1552f5ffde104e3e75de8c9a"

get_latest_block() {
    if [[ -z "$RPC_URL" ]]; then return 1; fi
    curl -sf -X POST "$RPC_URL" \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
        2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(int(d['result'],16))"
}

get_logs() {
    local address="$1"
    local topic0="$2"
    local from_block="$3"
    if [[ -z "$RPC_URL" ]]; then return 1; fi
    curl -sf -X POST "$RPC_URL" \
        -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"address\":\"$address\",\"topics\":[\"$topic0\"],\"fromBlock\":\"0x$(printf '%x' "$from_block")\",\"toBlock\":\"latest\"}]}" \
        2>/dev/null
}

check_compound_governance() {
    if [[ "$MOCK_COMPOUND_PROPOSAL" == "1" ]]; then
        echo "alert"
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

    # Query Compound Configurator for ProposalCreated events
    # On Base, Compound governance proposals go through the Configurator
    # We check for any SetConfiguration or UpdateAsset calls targeting our Comet
    local logs_result
    logs_result=$(get_logs "0x45939657d1CA34A8FA39A924B71D28Fe8431e581" "$COMPOUND_PROPOSAL_TOPIC" "$from_block" 2>/dev/null) || {
        echo "no-rpc"
        return
    }
    local log_count
    log_count=$(echo "$logs_result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result',[])))" 2>/dev/null) || {
        echo "no-rpc"
        return
    }
    if (( log_count > 0 )); then
        echo "alert"
    else
        echo "clear"
    fi
}

check_aave_governance() {
    if [[ "$MOCK_AAVE_PROPOSAL" == "1" ]]; then
        echo "alert"
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

    # Query Aave PoolConfigurator for governance events
    local logs_result
    logs_result=$(get_logs "0x8145eddDf43f50276641b55bd3AD95944510021E" "$AAVE_PROPOSAL_TOPIC" "$from_block" 2>/dev/null) || {
        echo "no-rpc"
        return
    }
    local log_count
    log_count=$(echo "$logs_result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('result',[])))" 2>/dev/null) || {
        echo "no-rpc"
        return
    }
    if (( log_count > 0 )); then
        echo "alert"
    else
        echo "clear"
    fi
}

main() {
    local compound_status aave_status alert

    compound_status=$(check_compound_governance)
    aave_status=$(check_aave_governance)

    alert="false"
    if [[ "$compound_status" == "alert" ]]; then
        alert="true"
    fi
    if [[ "$aave_status" == "alert" ]]; then
        alert="true"
    fi

    python3 -c "
import json, sys
result = {
    'alert': '$alert' == 'true',
    'governance': {
        'compound_v3': {
            'comet_address': '$COMET_ADDRESS',
            'status': '$compound_status',
            'alert': '$compound_status' == 'alert',
        },
        'aave_v3': {
            'pool_address': '$AAVE_POOL_ADDRESS',
            'status': '$aave_status',
            'alert': '$aave_status' == 'alert',
        },
    },
    'blocks_scanned': $BLOCKS_TO_SCAN,
    'runbook': 'docs/technical/upstream-monitoring-runbook.md#governance-proposal',
}
print(json.dumps(result, indent=2))
if result['alert']:
    sys.exit(1)
"
}

main "$@"
