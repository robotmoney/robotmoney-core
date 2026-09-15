#!/usr/bin/env bash
# Repo-owned Fusion ACCEPTANCE ceremony for the stage devnet (chain 918453).
#
# Canonical: project-fusion.md §12.0 (ephemeral governance keys), AC-CORE-05,
# AC-CORE-10, AC-ID-06, AC-ID-07. Replaces the hand-edited, gitignored
# deploy-timelock.sh / devnet-deploy-flow.sh / run-deploys.sh helpers.
#
# Runs AFTER `deploy-core-stack.sh smoke` has booted a fresh devnet with
# --no-receipt-fixtures. Every input address is read from that run's endpoint
# summary (address-shaped lines only); nothing is hardcoded.
#
# Usage (repo root, on the stage host):
#   fusion-ceremony.sh run     [--summary FILE] [--out-dir DIR] [--rpc-url URL] [--min-delay SECS]
#   fusion-ceremony.sh verify  --record FILE [--rpc-url URL]
#   fusion-ceremony.sh release --record FILE --receipt-id 0x.. [--rpc-url URL]
#   fusion-ceremony.sh discard --record FILE
#
# run      provisions fresh submitter / approver / two voters / emergency keys
#          (host-local keystores, 0600, never printed), registers the submitter
#          as the one committee agent, gives the two voters power, deploys a
#          RehearsalSafe owned by the approver and the TimelockController
#          handover, then runs `verify` and writes a GENERATED record to
#          $OUT_DIR/fusion-stage-record-<run>.json (+ fusion-stage-record.json).
# verify   asserts the acceptance topology on chain; exit 1 on any failure.
# release  releases a receipt the way a timelocked stage must: the approver
#          drives Safe -> TimelockController.schedule, waits the delay, then
#          execute. Idempotent on an already-released receipt.
# discard  shreds the run's keystores (AC-ID-06: discarded after the run).
#
# The genesis deployer key is the public repo test constant
# `DEPLOYER_PRIVATE_KEY_HEX` (testing/smoke-test/src/lib.rs); after `run` that
# key holds no privileged role anywhere, which `verify` asserts.
#
# Exit codes: 0 ok; 1 verification failed; 64 usage; 65 bad input; 66 chain action failed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CAST="${CAST:-cast}"
FORGE="${FORGE:-forge}"

ACTION="${1:-}"
[[ $# -gt 0 ]] && shift
SUMMARY="/opt/fusion-stage/core-smoke.log"
OUT_DIR="/opt/fusion-stage"
RPC_URL="http://127.0.0.1:18545"
MIN_DELAY=120
RECORD=""
RECEIPT_ID=""

usage() { sed -n '2,33p' "$0" >&2; exit 64; }
die() { echo "FAIL: [fusion-ceremony] $1" >&2; exit "${2:-66}"; }
info() { echo "==> [fusion-ceremony] $*" >&2; }

while (( $# )); do
  case "$1" in
    --summary) SUMMARY="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --rpc-url) RPC_URL="$2"; shift 2 ;;
    --min-delay) MIN_DELAY="$2"; shift 2 ;;
    --record) RECORD="$2"; shift 2 ;;
    --receipt-id) RECEIPT_ID="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

ADMIN_ROLE="$("$CAST" keccak "ADMIN_ROLE" 2>/dev/null || true)"
DEFAULT_ADMIN_ROLE="0x0000000000000000000000000000000000000000000000000000000000000000"
AGENT_ROLE="$("$CAST" keccak "AGENT_ROLE" 2>/dev/null || true)"
COMMITTEE_AGENT_ROLE="$("$CAST" keccak "COMMITTEE_AGENT_ROLE" 2>/dev/null || true)"
PROPOSER_ROLE="$("$CAST" keccak "PROPOSER_ROLE" 2>/dev/null || true)"
ROLE_GRANTED_TOPIC="$("$CAST" keccak "RoleGranted(bytes32,address,address)" 2>/dev/null || true)"
EXECUTOR_ROLE="$("$CAST" keccak "EXECUTOR_ROLE" 2>/dev/null || true)"

is_address() { [[ "$1" =~ ^0x[0-9a-fA-F]{40}$ ]]; }
lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }

# Last `key=0x<40 hex>` line of the summary; refuses anything not address-shaped.
summary_address() {
  local value
  value="$(awk -F= -v k="$1" '$1 == k { v = $2 } END { print v }' "$SUMMARY")"
  is_address "$value" || die "summary has no address for '$1' in $SUMMARY" 65
  printf '%s' "$value"
}

rec() { jq -r "$1" "$RECORD"; }

# ─── verify ──────────────────────────────────────────────────────────────────
FAILURES=0
check() {
  local label="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "1" ]]; then
    echo "PASS  $label${detail:+ ($detail)}"
  else
    echo "FAIL  $label${detail:+ ($detail)}"
    FAILURES=$((FAILURES + 1))
  fi
}

call() { "$CAST" call --rpc-url "$RPC_URL" "$@" 2>/dev/null | awk '{print $1; exit}'; }
has_role() { [[ "$(call "$1" 'hasRole(bytes32,address)(bool)' "$2" "$3")" == "true" ]] && echo 1 || echo 0; }
not_role() { [[ "$(call "$1" 'hasRole(bytes32,address)(bool)' "$2" "$3")" == "false" ]] && echo 1 || echo 0; }

# Accounts named in topic 2 of every `event` log at `address` matching topic 1.
log_accounts() {
  local address="$1" sig="$2" topic1="${3:-}"
  local args=(logs --rpc-url "$RPC_URL" --from-block 0 --address "$address" --json "$sig")
  [[ -n "$topic1" ]] && args+=("$topic1")
  "$CAST" "${args[@]}" | jq -r '.[] | .topics[if (.topics|length) > 2 then 2 else 1 end] | "0x" + .[26:]' | sort -u
}

verify_record() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  local gateway router governance receipt ic_policy timelock safe deployer submitter approver voter_a voter_b emergency
  gateway="$(rec .addresses.gateway)"; router="$(rec .addresses.router)"
  governance="$(rec .addresses.governance)"; receipt="$(rec .addresses.consensus_receipt)"
  ic_policy="$(rec .addresses.ic_policy)"; timelock="$(rec .addresses.timelock)"
  safe="$(rec .addresses.safe)"; deployer="$(rec .deployer)"
  submitter="$(rec .ephemeral.submitter)"; approver="$(rec .ephemeral.approver)"
  voter_a="$(rec '.ephemeral.voters[0]')"; voter_b="$(rec '.ephemeral.voters[1]')"
  emergency="$(rec .ephemeral.emergency)"
  for a in "$gateway" "$router" "$governance" "$receipt" "$ic_policy" "$timelock" "$safe" "$deployer" \
           "$submitter" "$approver" "$voter_a" "$voter_b" "$emergency"; do
    is_address "$a" || die "record carries a non-address value: $a" 65
  done

  local chain
  chain="$("$CAST" chain-id --rpc-url "$RPC_URL" 2>/dev/null || true)"
  check "chain id is the record's" "$([[ "$chain" == "$(rec .chain_id)" ]] && echo 1 || echo 0)" "$chain"

  local name hash live
  while IFS=$'\t' read -r name hash; do
    live="$("$CAST" codehash --rpc-url "$RPC_URL" "$(rec ".addresses.$name")" 2>/dev/null || true)"
    check "code hash of $name matches the record" "$([[ -n "$hash" && "$(lower "$live")" == "$(lower "$hash")" ]] && echo 1 || echo 0)"
  done < <(jq -r '.code_hashes | to_entries[] | select(.value != "0x0000000000000000000000000000000000000000000000000000000000000000") | [.key, .value] | @tsv' "$RECORD")

  local quorum total
  quorum="$(call "$governance" 'quorumThreshold()(uint256)')"
  total="$(call "$governance" 'totalVotingPower()(uint256)')"
  check "AC-GOV-03 quorumThreshold >= 2" "$([[ "$quorum" =~ ^[0-9]+$ ]] && (( quorum >= 2 )) && echo 1 || echo 0)" "quorum=$quorum"
  check "totalVotingPower can reach quorum" "$([[ "$total" =~ ^[0-9]+$ && "$quorum" =~ ^[0-9]+$ ]] && (( total >= quorum )) && echo 1 || echo 0)" "total=$total"

  local distinct
  distinct="$(printf '%s\n' "$deployer" "$submitter" "$approver" "$voter_a" "$voter_b" "$emergency" | tr '[:upper:]' '[:lower:]' | sort -u | wc -l)"
  check "AC-ID-06 deployer/submitter/approver/voters/emergency are distinct" "$([[ "$distinct" == "6" ]] && echo 1 || echo 0)"

  check "submitter holds gateway AGENT_ROLE" "$(has_role "$gateway" "$AGENT_ROLE" "$submitter")"
  check "submitter holds COMMITTEE_AGENT_ROLE" "$(has_role "$ic_policy" "$COMMITTEE_AGENT_ROLE" "$submitter")"
  local acct bal
  for acct in "$submitter" "$approver"; do
    bal="$("$CAST" balance --rpc-url "$RPC_URL" "$acct" 2>/dev/null || echo 0)"
    check "AC-ID-06 $acct is funded" "$([[ "$bal" =~ ^[0-9]+$ && "$bal" != "0" ]] && echo 1 || echo 0)"
  done

  # AC-GOV-03 disjointness, enumerated both ways from chain history rather than
  # from the record: every account that was ever granted an agent role and still
  # holds it, against every account that ever had voting power and still does.
  local agents voters overlap
  agents="$( { log_accounts "$ic_policy" 'RoleGranted(bytes32,address,address)' "$COMMITTEE_AGENT_ROLE"
               log_accounts "$gateway" 'RoleGranted(bytes32,address,address)' "$AGENT_ROLE"; } \
             | while read -r acct; do
                 if [[ "$(has_role "$ic_policy" "$COMMITTEE_AGENT_ROLE" "$acct")" == 1 || "$(has_role "$gateway" "$AGENT_ROLE" "$acct")" == 1 ]]; then lower "$acct"; fi
               done | sed '/^$/d' | sort -u)"
  voters="$(log_accounts "$governance" 'VotingPowerSet(address,uint256,uint256)' \
             | while read -r acct; do
                 p="$(call "$governance" 'votingPower(address)(uint256)' "$acct")"
                 if [[ "$p" =~ ^[0-9]+$ ]] && (( p > 0 )); then lower "$acct"; fi
               done | sed '/^$/d' | sort -u)"
  check "at least one committee agent is enumerable" "$([[ -n "$agents" ]] && echo 1 || echo 0)" "$(wc -w <<<"$agents") agents"
  check "at least two voters are enumerable" "$([[ "$(wc -w <<<"$voters")" -ge 2 ]] && echo 1 || echo 0)" "$(wc -w <<<"$voters") voters"
  overlap="$(comm -12 <(printf '%s\n' "$agents") <(printf '%s\n' "$voters") | sed '/^$/d')"
  check "AC-GOV-03 committee agents and non-zero voters are disjoint" "$([[ -z "$overlap" ]] && echo 1 || echo 0)" "${overlap:-none}"

  check "AC-CORE-05 RouterGovernance holds router ADMIN_ROLE" "$(has_role "$router" "$ADMIN_ROLE" "$governance")"
  check "AC-CORE-05 timelock holds router ADMIN_ROLE" "$(has_role "$router" "$ADMIN_ROLE" "$timelock")"
  local vault_a
  vault_a="$(rec '.vault_addresses.rmUSDC')"
  if "$CAST" call --rpc-url "$RPC_URL" --from "$deployer" "$router" 'setWeights(address[],uint256[])' "[$vault_a]" "[10000]" >/dev/null 2>&1; then
    check "AC-CORE-05 deployer EOA cannot call router.setWeights" 0 "eth_call from the deployer succeeded"
  else
    check "AC-CORE-05 deployer EOA cannot call router.setWeights" 1 "eth_call reverts"
  fi

  local contract
  for contract in gateway router governance registry vault consensus_receipt ic_policy; do
    check "AC-CORE-05 timelock holds ADMIN_ROLE on $contract" "$(has_role "$(rec ".addresses.$contract")" "$ADMIN_ROLE" "$timelock")"
    check "AC-CORE-05 deployer holds no ADMIN_ROLE on $contract" "$(not_role "$(rec ".addresses.$contract")" "$ADMIN_ROLE" "$deployer")"
  done
  check "AC-CORE-05 deployer holds no gateway DEFAULT_ADMIN_ROLE" "$(not_role "$gateway" "$DEFAULT_ADMIN_ROLE" "$deployer")"

  # Every role ever granted to the deployer, on ANY contract, must be gone: the
  # deployer key is a public repo constant, so any role it keeps is a bypass.
  local deployer_topic granted held="" c r
  deployer_topic="0x000000000000000000000000$(lower "${deployer#0x}")"
  granted="$("$CAST" rpc --rpc-url "$RPC_URL" eth_getLogs \
    "{\"fromBlock\":\"0x0\",\"toBlock\":\"latest\",\"topics\":[\"$ROLE_GRANTED_TOPIC\",null,\"$deployer_topic\"]}" \
    | jq -r '.[] | .address + " " + .topics[1]' | sort -u)" || granted="__rpc_failed__"
  if [[ "$granted" == "__rpc_failed__" ]]; then
    check "AC-CORE-05 deployer EOA holds no role on any contract" 0 "eth_getLogs failed"
  else
    while read -r c r; do
      [[ -n "$c" ]] || continue
      [[ "$(has_role "$c" "$r" "$deployer")" == 1 ]] && held+="$c:${r:0:10} "
    done <<<"$granted"
    check "AC-CORE-05 deployer EOA holds no role on any contract" "$([[ -z "$held" ]] && echo 1 || echo 0)" "${held:-none}"
  fi
  check "AC-CORE-05 approver holds no receipt ADMIN_ROLE directly" "$(not_role "$receipt" "$ADMIN_ROLE" "$approver")"
  check "AC-CORE-05 safe is the timelock proposer" "$(has_role "$timelock" "$PROPOSER_ROLE" "$safe")"
  check "AC-CORE-05 safe is the timelock executor" "$(has_role "$timelock" "$EXECUTOR_ROLE" "$safe")"
  local owner delay
  owner="$(call "$safe" 'owner()(address)')"
  check "AC-ID-06 the approver is the only key that drives the safe" "$([[ "$(lower "$owner")" == "$(lower "$approver")" ]] && echo 1 || echo 0)"
  delay="$(call "$timelock" 'getMinDelay()(uint256)')"
  check "timelock min delay matches the record" "$([[ "$delay" == "$(rec .min_delay)" ]] && echo 1 || echo 0)" "delay=$delay"

  if (( FAILURES > 0 )); then
    echo "verify: $FAILURES assertion(s) failed against $RECORD" >&2
    return 1
  fi
  echo "verify: every assertion passed against $RECORD" >&2
}

# ─── run ─────────────────────────────────────────────────────────────────────
send() {
  # send <key-args...> -- <cast send args...>; refuses a mined-but-reverted tx (C-17).
  local out status
  out="$("$CAST" send --rpc-url "$RPC_URL" --json "$@")" || die "cast send failed: ${*: -3}"
  status="$(jq -r '.status // empty' <<<"$out")"
  [[ "$status" == "0x1" ]] || die "transaction reverted or unconfirmed (status=$status): ${*: -3}"
  jq -r '.transactionHash' <<<"$out"
}

run_ceremony() {
  command -v jq >/dev/null || die "jq is required" 65
  [[ -f "$SUMMARY" ]] || die "summary not found: $SUMMARY" 65
  grep -q -- '--- end endpoint summary ---' "$SUMMARY" || die "summary is incomplete (no end marker): $SUMMARY" 65
  if ! [[ "$MIN_DELAY" =~ ^[1-9][0-9]*$ ]]; then die "--min-delay must be a positive integer" 64; fi

  local gateway vault registry router governance ic_policy receipt admin vault_json chain_id
  gateway="$(summary_address gateway_addr)"; vault="$(summary_address vault_addr)"
  registry="$(summary_address registry_addr)"; router="$(summary_address router_addr)"
  governance="$(summary_address governance_addr)"; ic_policy="$(summary_address ic_policy_addr)"
  receipt="$(summary_address consensus_receipt_addr)"; admin="$(summary_address admin_addr)"
  vault_json="$(awk -F= '$1 == "vault_addresses_json" { sub(/^[^=]*=/, ""); v = $0 } END { print v }' "$SUMMARY")"
  jq -e '.rmUSDC and .rmPROTO and .rmAGENT and .rmRWA' <<<"$vault_json" >/dev/null 2>&1 \
    || die "summary has no complete vault_addresses_json" 65
  chain_id="$("$CAST" chain-id --rpc-url "$RPC_URL")" || die "rpc unreachable: $RPC_URL"
  [[ "$chain_id" == "918453" ]] || die "chain id $chain_id is not the stage devnet 918453 (D-A6)" 65

  if [[ "$(call "$receipt" 'receiptCount()(uint256)')" != "0" ]]; then
    die "receipt contract already holds receipts: boot the smoke with --no-receipt-fixtures" 65
  fi

  local deployer_key
  deployer_key="$(sed -n '/pub const DEPLOYER_PRIVATE_KEY_HEX/{n;p}' "$REPO_ROOT/testing/smoke-test/src/lib.rs" | tr -d ' ";')"
  [[ "$(lower "$("$CAST" wallet address --private-key "$deployer_key")")" == "$(lower "$admin")" ]] \
    || die "repo deployer constant does not derive the summary's admin_addr" 65

  local run_id keydir
  run_id="$(date -u +%Y%m%dT%H%M%SZ)"
  keydir="$OUT_DIR/keys/$run_id"
  umask 077
  mkdir -p "$keydir"
  chmod 700 "$OUT_DIR/keys" "$keydir"

  declare -A addr
  local role pw
  for role in submitter approver voter-a voter-b emergency; do
    pw="$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')"
    printf '%s' "$pw" >"$keydir/$role.pw"
    "$CAST" wallet new "$keydir" "$role" --unsafe-password "$pw" >/dev/null
    chmod 600 "$keydir/$role" "$keydir/$role.pw"
    addr[$role]="$("$CAST" wallet address --keystore "$keydir/$role" --password-file "$keydir/$role.pw")"
    info "provisioned $role ${addr[$role]}"
  done
  local as_deployer=(--private-key "$deployer_key")
  local as_approver=(--keystore "$keydir/approver" --password-file "$keydir/approver.pw")

  for role in submitter approver voter-a voter-b emergency; do
    send "${as_deployer[@]}" --value 2ether "${addr[$role]}" >/dev/null
  done

  local until
  until="$(( $(date +%s) + 30 * 24 * 3600 ))"
  send "${as_deployer[@]}" "$gateway" \
    'authorizeAgent(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))' \
    "${addr[submitter]}" "(true,$until,1,1,${addr[submitter]},[],0x0000000000000000000000000000000000000000,0,0,[])" >/dev/null
  send "${as_deployer[@]}" "$gateway" 'committeeRegister(address,string)' "${addr[submitter]}" "fusion-stage-submitter-$run_id" >/dev/null
  info "submitter registered on the gateway and the IC policy"

  send "${as_deployer[@]}" "$governance" 'setVotingPower(address,uint256)' "${addr[voter-a]}" 1 >/dev/null
  send "${as_deployer[@]}" "$governance" 'setVotingPower(address,uint256)' "${addr[voter-b]}" 1 >/dev/null
  local current_quorum
  current_quorum="$(call "$governance" 'quorumThreshold()(uint256)')"
  [[ "$current_quorum" =~ ^[0-9]+$ ]] || die "could not read quorumThreshold()"
  if (( current_quorum < 2 )); then
    send "${as_deployer[@]}" "$governance" 'setQuorumThreshold(uint256)' 2 >/dev/null
  fi
  if [[ "$(has_role "$router" "$ADMIN_ROLE" "$governance")" != 1 ]]; then
    send "${as_deployer[@]}" "$router" 'grantRole(bytes32,address)' "$ADMIN_ROLE" "$governance" >/dev/null
  fi
  info "two voters with power 1 each; quorum $(call "$governance" 'quorumThreshold()(uint256)')"

  local work safe
  work="$(mktemp -d /tmp/fusion-ceremony.XXXXXX)"
  trap 'rm -rf "$work"' RETURN
  (cd "$REPO_ROOT" && "$FORGE" script contracts/script/DeployRehearsalSafe.s.sol:DeployRehearsalSafe \
      --rpc-url "$RPC_URL" "${as_approver[@]}" --sender "${addr[approver]}" --broadcast --slow) >"$work/safe.log" 2>&1 \
    || { tail -20 "$work/safe.log" >&2; die "DeployRehearsalSafe failed"; }
  safe="$(awk '/RehearsalSafe deployed:/ { print $3 }' "$work/safe.log" | tail -1)"
  is_address "$safe" || die "could not read the RehearsalSafe address"
  info "rehearsal safe $safe owned by the approver"

  (cd "$REPO_ROOT" && \
    VAULT_ADDRESS="$vault" GATEWAY_ADDRESS="$gateway" REGISTRY_ADDRESS="$registry" ROUTER_ADDRESS="$router" \
    GOVERNANCE_ADDRESS="$governance" SAFE_ADDRESS="$safe" EMERGENCY_ADDRESS="${addr[emergency]}" \
    TIMELOCK_MIN_DELAY="$MIN_DELAY" IC_POLICY_ADDRESS="$ic_policy" CONSENSUS_RECEIPT_ADDRESS="$receipt" \
    RECEIPT_ADMIN_ADDRESS="$admin" DEPLOYMENT_OUT="$work/timelock.json" \
    "$FORGE" script contracts/script/DeployTimelock.s.sol:DeployTimelock \
      --rpc-url "$RPC_URL" "${as_deployer[@]}" --broadcast --slow) >"$work/timelock.log" 2>&1 \
    || { grep -E "Error|revert|require" "$work/timelock.log" | tail -10 >&2; die "DeployTimelock failed"; }
  [[ -f "$work/timelock.json" ]] || die "DeployTimelock wrote no manifest"

  local tag sha out
  tag="$(git -C "$REPO_ROOT" describe --tags --exact-match 2>/dev/null || echo untagged)"
  sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  out="$OUT_DIR/fusion-stage-record-$run_id.json"
  jq --arg run "$run_id" --arg tag "$tag" --arg sha "$sha" --argjson chain "$chain_id" \
     --argjson delay "$MIN_DELAY" --argjson vaults "$vault_json" --arg deployer "$admin" \
     --arg submitter "${addr[submitter]}" --arg approver "${addr[approver]}" \
     --arg voter_a "${addr[voter-a]}" --arg voter_b "${addr[voter-b]}" --arg emergency "${addr[emergency]}" \
     --arg keydir "$keydir" \
     '. + {
        generated_by: "scripts/stage/fusion-ceremony.sh", run_id: $run, core_tag: $tag, core_sha: $sha,
        generated_at: (now | todate), chain_id: $chain, min_delay: $delay, deployer: $deployer,
        vault_addresses: $vaults,
        ephemeral: {submitter: $submitter, approver: $approver, voters: [$voter_a, $voter_b],
                    emergency: $emergency, keystore_dir: $keydir}
      }' "$work/timelock.json" >"$out"
  umask 022
  chmod 644 "$out"
  cp "$out" "$OUT_DIR/fusion-stage-record.json"
  info "wrote $out"

  RECORD="$out"
  verify_record
}

# ─── release ─────────────────────────────────────────────────────────────────
release_receipt() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  [[ "$RECEIPT_ID" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "--receipt-id must be a bytes32" 64
  local receipt timelock safe keydir delay data salt zero op
  receipt="$(rec .addresses.consensus_receipt)"; timelock="$(rec .addresses.timelock)"
  safe="$(rec .addresses.safe)"; keydir="$(rec .ephemeral.keystore_dir)"; delay="$(rec .min_delay)"
  [[ -f "$keydir/approver" ]] || die "approver keystore is gone (discarded?): $keydir" 65
  if [[ "$(call "$receipt" 'isReleased(bytes32)(bool)' "$RECEIPT_ID")" == "true" ]]; then
    echo '{"action":"already_released"}'
    return 0
  fi
  local as_approver=(--keystore "$keydir/approver" --password-file "$keydir/approver.pw")
  data="$("$CAST" calldata 'releaseReceipt(bytes32)' "$RECEIPT_ID")"
  zero="0x0000000000000000000000000000000000000000000000000000000000000000"
  salt="$RECEIPT_ID"
  op="$(call "$timelock" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' "$receipt" 0 "$data" "$zero" "$salt")"
  local schedule_tx="" execute_tx
  if [[ "$(call "$timelock" 'isOperation(bytes32)(bool)' "$op")" != "true" ]]; then
    schedule_tx="$(send "${as_approver[@]}" "$safe" 'exec(address,uint256,bytes)' "$timelock" 0 \
      "$("$CAST" calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' "$receipt" 0 "$data" "$zero" "$salt" "$delay")")"
    info "scheduled release $op; waiting ${delay}s"
  fi
  for _ in $(seq 1 $(( delay / 5 + 60 ))); do
    [[ "$(call "$timelock" 'isOperationReady(bytes32)(bool)' "$op")" == "true" ]] && break
    sleep 5
  done
  [[ "$(call "$timelock" 'isOperationReady(bytes32)(bool)' "$op")" == "true" ]] || die "timelock operation never became ready: $op"
  execute_tx="$(send "${as_approver[@]}" "$safe" 'exec(address,uint256,bytes)' "$timelock" 0 \
    "$("$CAST" calldata 'execute(address,uint256,bytes,bytes32,bytes32)' "$receipt" 0 "$data" "$zero" "$salt")")"
  [[ "$(call "$receipt" 'isReleased(bytes32)(bool)' "$RECEIPT_ID")" == "true" ]] || die "execute mined but the receipt is not released"
  jq -n --arg op "$op" --arg s "$schedule_tx" --arg e "$execute_tx" '{action:"released_via_timelock", operation:$op, schedule_tx:$s, execute_tx:$e}'
}

discard_keys() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  local keydir
  keydir="$(rec .ephemeral.keystore_dir)"
  [[ "$keydir" == */keys/* && -d "$keydir" ]] || die "no keystore directory to discard: $keydir" 65
  find "$keydir" -type f -exec shred -u -z -n 3 {} +
  rmdir "$keydir"
  echo "discarded $keydir"
}

case "$ACTION" in
  run) run_ceremony ;;
  verify) [[ -n "$RECORD" ]] || usage; verify_record ;;
  release) [[ -n "$RECORD" ]] || usage; release_receipt ;;
  discard) [[ -n "$RECORD" ]] || usage; discard_keys ;;
  *) usage ;;
esac
