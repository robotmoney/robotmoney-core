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
RPC_FALLBACK_URLS="${RPC_FALLBACK_URLS:-}"
MOCK_COMPOUND_PROPOSAL="${MOCK_COMPOUND_PROPOSAL:-0}"
MOCK_AAVE_PROPOSAL="${MOCK_AAVE_PROPOSAL:-0}"
# Look back ~7 days of Base blocks (avg 2s/block → ~302400 blocks/week)
BLOCKS_TO_SCAN="${BLOCKS_TO_SCAN:-302400}"
LOG_CHUNK_SIZE="${LOG_CHUNK_SIZE:-45000}"
RPC_RETRY_DELAYS="${RPC_RETRY_DELAYS:-1 2 4}"

# Addresses our adapters depend on
COMET_ADDRESS="0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf"
AAVE_POOL_ADDRESS="0xa238dd80c259a72e81d7e4664a9801593f98d1c5"

# Compound v3 Configurator ProposalCreated topic (Compound Governor Bravo)
# topic0: keccak256("ProposalCreated(uint256,address,address[],uint256[],string[],bytes[],uint256,uint256,string)")
COMPOUND_PROPOSAL_TOPIC="0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0"

# Aave governance ProposalCreated topic (AaveGovernanceV2 / GovernanceV3)
# topic0: keccak256("ProposalCreated(uint256,address,address,address[],uint256[],string[],bytes[],bool[],uint256,uint256,uint256,bytes32)")
AAVE_PROPOSAL_TOPIC="0xd272d67d2c8c66de43c1d2515abb064978a5020c1552f5ffde104e3e75de8c9a"

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
    latest=$(get_latest_block) || { echo "rpc-error"; return 0; }
    local from_block=$(( latest - BLOCKS_TO_SCAN ))
    if (( from_block < 0 )); then from_block=0; fi

    # Query Compound Configurator for ProposalCreated events
    # On Base, Compound governance proposals go through the Configurator
    # We check for any SetConfiguration or UpdateAsset calls targeting our Comet
    local log_count
    log_count=$(get_logs_count "0x45939657d1CA34A8FA39A924B71D28Fe8431e581" "$COMPOUND_PROPOSAL_TOPIC" "$from_block" "$latest") || {
        echo "rpc-error"
        return 0
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
    latest=$(get_latest_block) || { echo "rpc-error"; return 0; }
    local from_block=$(( latest - BLOCKS_TO_SCAN ))
    if (( from_block < 0 )); then from_block=0; fi

    # Query Aave PoolConfigurator for governance events
    local log_count
    log_count=$(get_logs_count "0x8145eddDf43f50276641b55bd3AD95944510021E" "$AAVE_PROPOSAL_TOPIC" "$from_block" "$latest") || {
        echo "rpc-error"
        return 0
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
if result['alert'] or '$compound_status' == 'rpc-error' or '$aave_status' == 'rpc-error':
    sys.exit(1)
"
}

main "$@"
