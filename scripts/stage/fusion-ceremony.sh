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
#   fusion-ceremony.sh ensure  [--record FILE] [--summary FILE] [--out-dir DIR] [--rpc-url URL]
#   fusion-ceremony.sh verify  --record FILE [--rpc-url URL]
#   fusion-ceremony.sh release --record FILE --receipt-id 0x.. [--rpc-url URL]
#   fusion-ceremony.sh propose --record FILE --draft-file FILE [--rpc-url URL] [--out-dir DIR]
#   fusion-ceremony.sh propose-negative --record FILE --draft-file FILE [--rpc-url URL]
#   fusion-ceremony.sh vote    --record FILE [--rpc-url URL] [--out-dir DIR]
#   fusion-ceremony.sh execute --record FILE [--rpc-url URL] [--out-dir DIR]
#   fusion-ceremony.sh discard --record FILE
#   fusion-ceremony.sh handover-vaults --record FILE [--rpc-url URL]
#
# run      provisions fresh submitter / approver / approver-b / approver-c /
#          two voters / emergency keys (host-local keystores, 0600, never
#          printed), registers the submitter as the one committee agent, gives
#          the two voters power, creates a real 2-of-3 Safe (a SafeProxy on the
#          canonical SafeL2 singleton via the canonical SafeProxyFactory; owners
#          approver, approver-b, approver-c) and the TimelockController
#          handover, then runs `verify` and writes a GENERATED record to
#          $OUT_DIR/fusion-stage-record-<run>.json (+ fusion-stage-record.json).
#          There is no fallback: a chain without the canonical Safe set cannot
#          run the ceremony (docs/technical/governance-isomorphism.md R8).
# ensure   the idempotent form of `run`: verifies the record against the live
#          chain and re-provisions only when the ceremony is actually absent
#          (a devnet reboot wipes the Safe, the timelock and the key funding
#          while leaving a plausible-looking record behind). Callers use this
#          so environment setup is never a manual prerequisite.
# verify   asserts the acceptance topology on chain; exit 1 on any failure.
# release  releases a receipt the way a timelocked stage must: the Safe
#          schedules on the TimelockController through execTransaction signed
#          by two distinct owners, waits the delay, then executes the same way.
#          Idempotent on an already-released receipt.
# propose  puts a governance draft's propose(address[],uint256[]) calldata through
#          the same Safe -> TimelockController path, then PROVES the authority it
#          used: currentProposalId must advance by exactly one, the stored
#          proposal's vaults and bps must equal the draft's four canonical
#          buckets summing 10000, and its proposer must be the timelock itself.
#          Idempotent on a live Active/Queued proposal, read from RouterGovernance
#          rather than from the timelock. The salt is domain separated from the
#          one `release` uses, so the two operations are distinguishable.
# propose-negative  the control that makes `propose` mean something: the SAME
#          calldata sent straight from the operator EOA must revert
#          AccessControlUnauthorizedAccount. eth_call only, so it burns no nonce
#          and changes no state.
# vote     drives the two ephemeral voters through the Active proposal as plain
#          EOAs (vote(uint256) has no role guard): a key with no voting power is
#          refused NoVotingPower first, then voter-a votes, then execute() is
#          shown to revert QuorumNotReached on the one-vote tally — probed inside
#          an Anvil snapshot at a chain time past votingDeadline, because
#          execute() answers VotingStillOpen before it looks at the tally at all,
#          and rolled straight back so voter-b can still vote — then voter-b
#          votes and the tally is asserted against the proposal's snapshotQuorum.
#          Idempotent: a voter that already voted is skipped and said so in the
#          result rather than being sent into AlreadyVoted. Each vote that lands
#          is followed by a G08 weight witness (see `execute`), and a witness
#          that could not be taken or written is reported in the result's own
#          weight_witness field rather than lost in passing.
# execute  the transition G08 grades: the Queued proposal's weight vector applied
#          to PortfolioRouter. execute(uint256) has no role guard, so an
#          unprivileged ephemeral key sends it. The router's vector and the
#          proposal id are witnessed first; then, BEFORE any clock movement,
#          execute() is shown to revert the error the live state owes
#          (VotingStillOpen while voting is open, ExecutionDelayNotElapsed once
#          it closes) so the delay is never asserted vacuously; then chain time
#          is jumped past votingDeadline and past executableAfter, the tx is
#          sent, and ProposalExecuted / WeightsApplied are decoded. The live
#          router weights are then graded PER VAULT and exactly against the
#          receipt - 833/8167/667/333 bps for rmAGENT/rmUSDC/rmPROTO/rmRWA -
#          never as a sum. Idempotent on an already-executed proposal.
#          G08 also asks that ONLY this transition change those weights, which a
#          single pre-execute reading cannot show. propose and vote each append a
#          WITNESS of the router's vector — per vault, with chain time and block —
#          to $OUT_DIR/weight-witness/<run>-cycle-<proposal>.jsonl, and execute
#          compares every witness of its own cycle against the others and against
#          its live reading before it moves the clock, reporting
#          weights_unchanged_until_execute. Equal witnesses with the propose one
#          among them assert it; a disagreement is the breach G08 exists to catch
#          and stops the ceremony; no witness, a missing propose witness, or a
#          line this run cannot read is reported unproven, never as a pass.
# discard  shreds the run's keystores (AC-ID-06: discarded after the run).
# handover-vaults  moves ADMIN_ROLE (to the timelock) and EMERGENCY_ROLE (to the
#          emergency key) off the deployer on every vault DeployTimelock does not
#          cover (the demo rmPROTO / rmAGENT / rmRWA vaults). `run` does this
#          itself; the action exists so an interrupted ceremony can finish.
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
DRAFT_FILE=""

# The whole leading comment block, so an added action never falls off the end of
# a hardcoded line range.
usage() { awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2; exit 64; }
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
    --draft-file) DRAFT_FILE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

ADMIN_ROLE="$("$CAST" keccak "ADMIN_ROLE" 2>/dev/null || true)"
DEFAULT_ADMIN_ROLE="0x0000000000000000000000000000000000000000000000000000000000000000"
AGENT_ROLE="$("$CAST" keccak "AGENT_ROLE" 2>/dev/null || true)"
COMMITTEE_AGENT_ROLE="$("$CAST" keccak "COMMITTEE_AGENT_ROLE" 2>/dev/null || true)"
PROPOSER_ROLE="$("$CAST" keccak "PROPOSER_ROLE" 2>/dev/null || true)"
EMERGENCY_ROLE="$("$CAST" keccak "EMERGENCY_ROLE" 2>/dev/null || true)"
ROLE_GRANTED_TOPIC="$("$CAST" keccak "RoleGranted(bytes32,address,address)" 2>/dev/null || true)"
EXECUTOR_ROLE="$("$CAST" keccak "EXECUTOR_ROLE" 2>/dev/null || true)"

# Canonical Safe v1.4.1 (docs/technical/governance-isomorphism.md §2.2). Safe is
# third-party infrastructure the fork fixture carries; this script never deploys
# a Safe implementation, only creates an account (a SafeProxy) on it (R1, R5).
# SafeL2, not the L1 singleton: the stage chain is a Base fork, and Base is an
# L2 (R4).
SAFE_L2_SINGLETON="0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"
SAFE_PROXY_FACTORY="0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"
SAFE_FALLBACK_HANDLER="0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"
ZERO_ADDRESS="0x0000000000000000000000000000000000000000"
# The Safe's owners are three dedicated approver keys, not keys that already
# hold another role: the submitter is the agent whose receipts the Safe
# releases, the voters are RouterGovernance's approving body, and the
# emergency key is the independent hot key. Owning the Safe with any of them
# would fuse two governing bodies into one signer set.
SAFE_OWNER_ROLES=(approver approver-b approver-c)
SAFE_THRESHOLD=2

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

# `call` swallows stderr so the boolean helpers above can treat a revert as
# false. That turns a call against a codeless address into an empty string,
# which `set -e` then reports as a bare exit 1 with no diagnostic at all.
# Anything that MUST have code gets named here first.
has_code() { [[ -n "$("$CAST" code "$1" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]0x')" ]]; }
require_contract() {
  has_code "$1" || die "$2 $1 has no code on $RPC_URL — the record predates this chain; run \`fusion-ceremony.sh ensure\`" 65
}

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
  local each_vault
  while read -r each_vault; do
    check "AC-CORE-05 timelock holds ADMIN_ROLE on vault $each_vault" "$(has_role "$each_vault" "$ADMIN_ROLE" "$timelock")"
  done < <(jq -r '.vault_addresses[]' "$RECORD" | sort -u)
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
repo_deployer_key() {
  local key
  key="$(sed -n '/pub const DEPLOYER_PRIVATE_KEY_HEX/{n;p}' "$REPO_ROOT/testing/smoke-test/src/lib.rs" | tr -d ' ";')"
  [[ "$(lower "$("$CAST" wallet address --private-key "$key")")" == "$(lower "$1")" ]] \
    || die "repo deployer constant does not derive the expected deployer $1" 65
  printf '%s' "$key"
}

send() {
  # send <key-args...> -- <cast send args...>; refuses a mined-but-reverted tx (C-17).
  local out status
  out="$("$CAST" send --rpc-url "$RPC_URL" --json "$@")" || die "cast send failed: ${*: -3}"
  status="$(jq -r '.status // empty' <<<"$out")"
  [[ "$status" == "0x1" ]] || die "transaction reverted or unconfirmed (status=$status): ${*: -3}"
  jq -r '.transactionHash' <<<"$out"
}

# ─── the Safe signing path (governance-isomorphism.md R9-R11) ────────────────
# Every privileged operation goes through Safe.execTransaction with `threshold`
# distinct owner signatures over the EIP-712 SafeTx digest the Safe itself
# computes (getTransactionHash), packed ascending by owner address — the port of
# contracts/test/SafeIntegration.t.sol's _buildTwoOwnerSigs. Signatures come
# from the keystores (`cast wallet sign --no-hash`), never from a key on a
# command line. --no-hash signs the digest as-is, which Safe verifies as a plain
# ECDSA signature (v 27/28).

# safe_tx_hash <safe> <to> <data>: the SafeTx digest for a value-0 CALL with no
# gas refund, at the Safe's current nonce.
safe_tx_hash() {
  local safe="$1" to="$2" data="$3" nonce digest
  nonce="$(call "$safe" 'nonce()(uint256)')"
  [[ "$nonce" =~ ^[0-9]+$ ]] || die "could not read nonce() from safe $safe"
  digest="$(call "$safe" 'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)'     "$to" 0 "$data" 0 0 0 0 "$ZERO_ADDRESS" "$ZERO_ADDRESS" "$nonce")"
  [[ "$digest" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "could not read getTransactionHash() from safe $safe"
  printf '%s' "$digest"
}

# safe_signatures <digest> <count>: `count` signatures over `digest` from the
# record's Safe signers, lowest owner address first (Safe rejects anything not
# strictly ascending, GS026), packed as one 0x-prefixed byte string.
safe_signatures() {
  local digest="$1" count="$2" keydir addr role sig packed="" n=0
  keydir="$(rec .ephemeral.keystore_dir)"
  while IFS=$'\t' read -r addr role; do
    (( n < count )) || break
    [[ -f "$keydir/$role" && -f "$keydir/$role.pw" ]] \
      || die "safe signer keystore is gone (discarded?): $keydir/$role" 65
    sig="$("$CAST" wallet sign --no-hash --keystore "$keydir/$role" --password-file "$keydir/$role.pw" "$digest")" \
      || die "could not sign the SafeTx digest as $role"
    [[ "$sig" =~ ^0x[0-9a-fA-F]{130}$ ]] || die "signature from $role is not 65 bytes: $sig"
    packed+="${sig#0x}"
    n=$((n + 1))
  done < <(jq -r '.ephemeral.safe_signers[] | [(.address | ascii_downcase), .role] | @tsv' "$RECORD" | LC_ALL=C sort)
  (( n == count )) || die "the record names $n Safe signers; $count are needed"
  printf '0x%s' "$packed"
}

# safe_exec <safe> <to> <data>: one Safe transaction, signed by exactly the
# threshold the Safe reports, sent by the approver (any account may relay a
# fully-signed SafeTx; the signatures are the authority, not the sender).
# Prints the transaction hash. A Safe whose threshold is below 2 is refused
# rather than driven (R6).
safe_exec() {
  local safe="$1" to="$2" data="$3" threshold digest sigs keydir
  threshold="$(call "$safe" 'getThreshold()(uint256)')"
  [[ "$threshold" =~ ^[0-9]+$ ]] && (( threshold >= 2 )) \
    || die "safe $safe reports threshold '$threshold'; refusing to drive a Safe that cannot enforce quorum (R6)"
  digest="$(safe_tx_hash "$safe" "$to" "$data")"
  sigs="$(safe_signatures "$digest" "$threshold")"
  keydir="$(rec .ephemeral.keystore_dir)"
  send --keystore "$keydir/approver" --password-file "$keydir/approver.pw" "$safe" \
    'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)' \
    "$to" 0 "$data" 0 0 0 0 "$ZERO_ADDRESS" "$ZERO_ADDRESS" "$sigs"
}

# create_safe <salt-nonce> <owner>...: a SafeProxy on SafeL2 via the canonical
# factory, threshold $SAFE_THRESHOLD, the canonical fallback handler (R5).
# Prints the new Safe's address. No fallback of any kind when the Safe set is
# absent (R8): the fixture is what has to change, and check-fork-safe-set.sh
# says so at fixture-build time.
create_safe() {
  local salt="$1" owners setup predicted name
  shift
  for name in "SafeL2 singleton:$SAFE_L2_SINGLETON" "SafeProxyFactory:$SAFE_PROXY_FACTORY" \
              "CompatibilityFallbackHandler:$SAFE_FALLBACK_HANDLER"; do
    has_code "${name#*:}" \
      || die "canonical ${name%%:*} ${name#*:} has no code on $RPC_URL: this chain lacks the Safe v1.4.1 set (governance-isomorphism.md R2) and the ceremony has no stand-in (R8)" 65
  done
  owners="[$(IFS=,; echo "$*")]"
  setup="$("$CAST" calldata 'setup(address[],uint256,address,bytes,address,address,uint256,address)' \
    "$owners" "$SAFE_THRESHOLD" "$ZERO_ADDRESS" 0x "$SAFE_FALLBACK_HANDLER" "$ZERO_ADDRESS" 0 "$ZERO_ADDRESS")"
  # The factory's CREATE2 address depends only on (singleton, initializer,
  # salt), so an eth_call names the proxy before the transaction creates it.
  predicted="$("$CAST" call --rpc-url "$RPC_URL" "$SAFE_PROXY_FACTORY" \
    'createProxyWithNonce(address,bytes,uint256)(address)' "$SAFE_L2_SINGLETON" "$setup" "$salt" 2>/dev/null | awk '{print $1; exit}')"
  is_address "$predicted" || die "SafeProxyFactory.createProxyWithNonce would not create a proxy (eth_call answered '$predicted')"
  send "${CREATE_SAFE_SENDER[@]}" "$SAFE_PROXY_FACTORY" 'createProxyWithNonce(address,bytes,uint256)' \
    "$SAFE_L2_SINGLETON" "$setup" "$salt" >/dev/null
  has_code "$predicted" || die "createProxyWithNonce mined but $predicted has no code"
  printf '%s' "$predicted"
}

# ─── chain time ──────────────────────────────────────────────────────────────
# Read the latest block's timestamp as decimal seconds (cast may print hex).
chain_time() {
  local t
  t="$("$CAST" block latest --rpc-url "$RPC_URL" --field timestamp 2>/dev/null | tr -cd '[:alnum:]')"
  if [[ "$t" == 0x* ]]; then t="$("$CAST" to-dec "$t" 2>/dev/null)"; fi
  [[ "$t" =~ ^[0-9]+$ ]] || die "could not read the latest block timestamp from $RPC_URL"
  printf '%s' "$t"
}

# jump_to <unix timestamp>: fast-forward chain time on an Anvil-backed devnet
# instead of sleeping through a timelock delay in real seconds.
#
# The single mined block that carries the new timestamp is not enough to make
# the jump visible downstream: services/explorer-indexer/src/lib.rs:48 hard-codes
# CONFIRMATIONS = 5 and caps the safe head at tip-5, so the indexer and the
# explorer API keep reporting the pre-jump head until six further blocks land.
#
# A chain that rejects the Anvil methods is not a devnet we may fast-forward, and
# silently sleeping instead would turn a wrong-chain mistake into an hours-long
# hang, so this dies loudly rather than falling back.
jump_to() {
  local target="$1" before after skew wall i
  [[ "$target" =~ ^[0-9]+$ ]] || die "jump_to needs a unix timestamp, got '$target'" 64
  before="$(chain_time)"
  # A resumed run reaches here with the chain already past the target: the
  # timelock operation was scheduled, the delay elapsed, and only the execute is
  # left. Anvil refuses anvil_setNextBlockTimestamp for anything not ahead of the
  # latest block, so asking for a backwards jump would be reported below as a
  # chain that does not speak the Anvil methods at all. There is nothing to move.
  if (( target <= before )); then
    info "chain time $before is already at or past $target; nothing to jump"
    return 0
  fi
  "$CAST" rpc --rpc-url "$RPC_URL" anvil_setNextBlockTimestamp "$target" >/dev/null 2>&1 \
    || die "anvil_setNextBlockTimestamp rejected by $RPC_URL for target $target (chain time $before): this chain is not Anvil-backed, and the ceremony will not sleep through the timelock delay instead"
  "$CAST" rpc --rpc-url "$RPC_URL" evm_mine >/dev/null 2>&1 \
    || die "evm_mine rejected by $RPC_URL: this chain is not Anvil-backed, and the ceremony will not sleep through the timelock delay instead"
  # Six confirmation blocks so the indexer's safe head (tip-5) reaches the jump.
  for i in 1 2 3 4 5 6; do
    "$CAST" rpc --rpc-url "$RPC_URL" evm_mine >/dev/null 2>&1 \
      || die "evm_mine failed on confirmation block $i of 6 after jumping to $target"
  done
  after="$(chain_time)"
  wall="$(date +%s)"
  skew=$(( after - wall ))
  info "chain time $before -> $after (+$(( after - before ))s, 7 blocks mined); chain now runs ${skew}s ahead of wall clock $wall"
}

# ─── a chain time the ceremony must not keep ─────────────────────────────────
# Some rules can only be graded at a chain time the ceremony has to walk back
# from: the quorum rule is one, because RouterGovernance.execute() reverts
# VotingStillOpen before it ever compares votesFor with the quorum, so the tally
# rule is only reachable once voting has closed — and a closed window would end
# voter-b's chance to vote. The probe therefore runs inside an Anvil snapshot
# that is rolled straight back.
#
# ONE block, never jump_to's seven: the block carrying the probe's timestamp
# stays inside the indexer's confirmation buffer (safe head is tip-5), so the
# rollback is invisible to everything downstream.
snapshot_take() {
  local id
  id="$("$CAST" rpc --rpc-url "$RPC_URL" evm_snapshot 2>/dev/null | tr -d '"[:space:]')"
  [[ "$id" =~ ^(0x[0-9a-fA-F]+|[0-9]+)$ ]] \
    || die "evm_snapshot rejected by $RPC_URL (returned '${id:-<empty>}'): this chain is not Anvil-backed, and a rule that needs a throwaway chain time will not be claimed without being proved"
  printf '%s' "$id"
}

snapshot_restore() {
  local id="$1" out
  out="$("$CAST" rpc --rpc-url "$RPC_URL" evm_revert "$id" 2>/dev/null | tr -d '"[:space:]')"
  [[ "$out" == "true" ]] \
    || die "evm_revert $id rejected by $RPC_URL (returned '${out:-<empty>}'): the chain is left at the probe's timestamp and the ceremony will not continue from a state it cannot account for"
}

mine_one_at() {
  local target="$1" before
  [[ "$target" =~ ^[0-9]+$ ]] || die "mine_one_at needs a unix timestamp, got '$target'" 64
  before="$(chain_time)"
  (( target > before )) || die "mine_one_at $target is not ahead of chain time $before" 1
  "$CAST" rpc --rpc-url "$RPC_URL" anvil_setNextBlockTimestamp "$target" >/dev/null 2>&1 \
    || die "anvil_setNextBlockTimestamp rejected by $RPC_URL for target $target (chain time $before): this chain is not Anvil-backed"
  "$CAST" rpc --rpc-url "$RPC_URL" evm_mine >/dev/null 2>&1 \
    || die "evm_mine rejected by $RPC_URL: this chain is not Anvil-backed"
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
  deployer_key="$(repo_deployer_key "$admin")"

  local run_id keydir
  run_id="$(date -u +%Y%m%dT%H%M%SZ)"
  keydir="$OUT_DIR/keys/$run_id"
  umask 077
  mkdir -p "$keydir"
  chmod 700 "$OUT_DIR/keys" "$keydir"

  declare -A addr
  local role pw
  for role in submitter "${SAFE_OWNER_ROLES[@]}" voter-a voter-b emergency; do
    pw="$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')"
    printf '%s' "$pw" >"$keydir/$role.pw"
    "$CAST" wallet new "$keydir" "$role" --unsafe-password "$pw" >/dev/null
    chmod 600 "$keydir/$role" "$keydir/$role.pw"
    addr[$role]="$("$CAST" wallet address --keystore "$keydir/$role" --password-file "$keydir/$role.pw")"
    info "provisioned $role ${addr[$role]}"
  done
  local as_deployer=(--private-key "$deployer_key")
  local as_approver=(--keystore "$keydir/approver" --password-file "$keydir/approver.pw")

  for role in submitter "${SAFE_OWNER_ROLES[@]}" voter-a voter-b emergency; do
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

  local work safe owner_addrs=() signers_json
  work="$(mktemp -d /tmp/fusion-ceremony.XXXXXX)"
  trap 'rm -rf "$work"' RETURN
  for role in "${SAFE_OWNER_ROLES[@]}"; do owner_addrs+=("${addr[$role]}"); done
  CREATE_SAFE_SENDER=("${as_approver[@]}")
  safe="$(create_safe "$("$CAST" keccak "fusion-stage-safe-$run_id")" "${owner_addrs[@]}")"
  info "safe $safe: ${SAFE_THRESHOLD}-of-${#owner_addrs[@]} on SafeL2, owners ${SAFE_OWNER_ROLES[*]}"
  signers_json="$(for role in "${SAFE_OWNER_ROLES[@]}"; do
      jq -n --arg r "$role" --arg a "${addr[$role]}" '{role: $r, address: $a}'
    done | jq -s .)"

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
     --arg keydir "$keydir" --argjson safe_signers "$signers_json" \
     '. + {
        generated_by: "scripts/stage/fusion-ceremony.sh", run_id: $run, core_tag: $tag, core_sha: $sha,
        generated_at: (now | todate), chain_id: $chain, min_delay: $delay, deployer: $deployer,
        vault_addresses: $vaults,
        ephemeral: {submitter: $submitter, approver: $approver, voters: [$voter_a, $voter_b],
                    emergency: $emergency, keystore_dir: $keydir, safe_signers: $safe_signers}
      }' "$work/timelock.json" >"$out"
  umask 022
  chmod 644 "$out"
  cp "$out" "$OUT_DIR/fusion-stage-record.json"
  info "wrote $out"

  RECORD="$out"
  handover_vaults
  verify_record
}

# ─── handover of vaults outside DeployTimelock ────────────────────────────────
handover_vaults() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  local deployer timelock emergency primary key vault
  deployer="$(rec .deployer)"; timelock="$(rec .addresses.timelock)"
  emergency="$(rec .ephemeral.emergency)"; primary="$(lower "$(rec .addresses.vault)")"
  key="$(repo_deployer_key "$deployer")"
  while read -r vault; do
    is_address "$vault" || die "record vault_addresses carries a non-address: $vault" 65
    [[ "$(lower "$vault")" == "$primary" ]] && continue
    if [[ "$(has_role "$vault" "$ADMIN_ROLE" "$deployer")" != 1 ]]; then
      info "vault $vault: deployer already holds no ADMIN_ROLE"
      continue
    fi
    # EMERGENCY_ROLE is administered by ADMIN_ROLE, so it moves first (as in DeployTimelock).
    if [[ "$(has_role "$vault" "$EMERGENCY_ROLE" "$deployer")" == 1 ]]; then
      send --private-key "$key" "$vault" 'grantRole(bytes32,address)' "$EMERGENCY_ROLE" "$emergency" >/dev/null
      send --private-key "$key" "$vault" 'revokeRole(bytes32,address)' "$EMERGENCY_ROLE" "$deployer" >/dev/null
    fi
    send --private-key "$key" "$vault" 'grantRole(bytes32,address)' "$ADMIN_ROLE" "$timelock" >/dev/null
    [[ "$(has_role "$vault" "$ADMIN_ROLE" "$timelock")" == 1 ]] || die "timelock missing ADMIN_ROLE on $vault after grant"
    send --private-key "$key" "$vault" 'revokeRole(bytes32,address)' "$ADMIN_ROLE" "$deployer" >/dev/null
    info "vault $vault: ADMIN_ROLE -> timelock, EMERGENCY_ROLE -> emergency key, deployer revoked"
  done < <(jq -r '.vault_addresses[]' "$RECORD" | sort -u)
}

# ─── release ─────────────────────────────────────────────────────────────────
release_receipt() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  [[ "$RECEIPT_ID" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "--receipt-id must be a bytes32" 64
  local receipt timelock safe keydir delay data salt zero op
  receipt="$(rec .addresses.consensus_receipt)"; timelock="$(rec .addresses.timelock)"
  safe="$(rec .addresses.safe)"; keydir="$(rec .ephemeral.keystore_dir)"; delay="$(rec .min_delay)"
  [[ -f "$keydir/approver" ]] || die "approver keystore is gone (discarded?): $keydir" 65
  require_contract "$timelock" timelock
  require_contract "$safe" safe
  if [[ "$(call "$receipt" 'isReleased(bytes32)(bool)' "$RECEIPT_ID")" == "true" ]]; then
    echo '{"action":"already_released"}'
    return 0
  fi
  data="$("$CAST" calldata 'releaseReceipt(bytes32)' "$RECEIPT_ID")"
  zero="0x0000000000000000000000000000000000000000000000000000000000000000"
  salt="$RECEIPT_ID"
  op="$(call "$timelock" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' "$receipt" 0 "$data" "$zero" "$salt")"
  if [[ "$(call "$timelock" 'isOperationDone(bytes32)(bool)' "$op")" == "true" ]]; then
    jq -n --arg op "$op" '{action:"already_proposed", operation:$op}'
    return 0
  fi
  local schedule_tx="" execute_tx
  if [[ "$(call "$timelock" 'isOperation(bytes32)(bool)' "$op")" != "true" ]]; then
    schedule_tx="$(safe_exec "$safe" "$timelock" \
      "$("$CAST" calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' "$receipt" 0 "$data" "$zero" "$salt" "$delay")")"
    info "scheduled release $op; jumping chain time past the ${delay}s delay"
  fi
  # Devnet time is ours to move: read when the timelock says the operation is
  # ready and jump the chain there, rather than sitting out $delay real seconds.
  local ready
  ready="$(call "$timelock" 'getTimestamp(bytes32)(uint256)' "$op")"
  if [[ "$ready" =~ ^[0-9]+$ ]] && (( ready > 1 )); then
    jump_to "$(( ready + 1 ))"
  fi
  [[ "$(call "$timelock" 'isOperationReady(bytes32)(bool)' "$op")" == "true" ]] || die "timelock operation never became ready: $op"
  execute_tx="$(safe_exec "$safe" "$timelock" \
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

# ─── governance propose ──────────────────────────────────────────────────────
# Signatures the propose path is graded against. Kept as names, never as
# hand-copied selectors, so a contract rename breaks the ceremony loudly.
PROPOSE_SIG='propose(address[],uint256[])'
PROPOSAL_CREATED_SIG='ProposalCreated(uint256,address,address[],uint256[],uint64)'
ACCESS_CONTROL_ERROR_SIG='AccessControlUnauthorizedAccount(address,bytes32)'

# The draft's calldata, refused unless it really is a propose(address[],uint256[])
# call. The timelock executes whatever bytes it was handed, so the selector is
# checked here, before anything is signed or scheduled.
draft_propose_calldata() {
  local data selector expected
  data="$(jq -r '.drafts[0].propose_calldata // empty' "$DRAFT_FILE")"
  [[ -n "$data" ]] || die "no propose_calldata in $DRAFT_FILE" 65
  [[ "$data" =~ ^0x[0-9a-fA-F]+$ ]] || die "propose_calldata in $DRAFT_FILE is not hex: $data" 65
  (( ${#data} >= 10 )) || die "propose_calldata in $DRAFT_FILE is shorter than a selector: $data" 65
  selector="$(lower "${data:0:10}")"
  expected="$(lower "$("$CAST" sig "$PROPOSE_SIG")")"
  [[ "$selector" == "$expected" ]] \
    || die "propose_calldata selector $selector is not $PROPOSE_SIG ($expected)" 65

  # The selector alone is not the promise. The timelock executes these exact
  # bytes, so calldata that encodes a different vector than the draft's own
  # vaults/bps list would be scheduled, waited out and executed, and only the
  # post-execute assertion would notice — by which time a wrong Active proposal
  # is on chain and blocks every later propose with ActiveProposalExists. So the
  # arguments are decoded and graded here, before anything is signed.
  local decoded encoded_vaults encoded_bps want_vaults want_bps
  decoded="$("$CAST" abi-decode --input "$PROPOSE_SIG" "0x${data:10}")" \
    || die "propose_calldata in $DRAFT_FILE does not decode as $PROPOSE_SIG" 65
  encoded_vaults="$(cast_array_lines "$(sed -n '1p' <<<"$decoded")")"
  encoded_bps="$(cast_array_lines "$(sed -n '2p' <<<"$decoded")")"
  want_vaults="$(draft_vault_list)"
  want_bps="$(draft_bps_list)"
  [[ "$encoded_vaults" == "$want_vaults" ]] \
    || die "propose_calldata encodes vaults [$(tr '\n' ' ' <<<"$encoded_vaults")], not the draft's own list [$(tr '\n' ' ' <<<"$want_vaults")]" 65
  [[ "$encoded_bps" == "$want_bps" ]] \
    || die "propose_calldata encodes bps [$(tr '\n' ' ' <<<"$encoded_bps")], not the draft's own weights [$(tr '\n' ' ' <<<"$want_bps")]" 65
  printf '%s' "$data"
}

# The draft's four canonical buckets, one value per line.
draft_vault_list() { jq -r '.drafts[0].vaults[].vault' "$DRAFT_FILE" | tr '[:upper:]' '[:lower:]'; }
draft_bps_list() { jq -r '.drafts[0].vaults[].weight_bps' "$DRAFT_FILE"; }

# One cast-printed array line -> one lowercased value per line, with cast's
# human annotations (`2500 [2.5e3]`) dropped.
cast_array_lines() { tr -d '[]' <<<"$1" | tr ',' '\n' | awk 'NF { print tolower($1) }'; }

# A newline-separated list as a JSON array of strings / of numbers.
json_str_array() { jq -Rn '[inputs | select(length > 0)]'; }
json_num_array() { jq -Rn '[inputs | select(length > 0) | tonumber]'; }

# The draft's receipt id, which every propose artefact is keyed on.
draft_receipt_id() {
  local rid
  rid="$(jq -r '.drafts[0].receipt_id // empty' "$DRAFT_FILE")"
  [[ "$rid" =~ ^0x[0-9a-fA-F]{64}$ ]] \
    || die "draft carries no bytes32 receipt_id (got '${rid:-<absent>}'); a propose operation is keyed on the receipt and will not run without one" 65
  printf '%s' "$rid"
}

# The timelock salt for a propose operation. `release` salts its operation with
# the bare receipt id, so reusing that here would make the two indistinguishable
# in timelock evidence — same salt, same receipt, different authority claim.
# Domain separating on the literal "propose" keeps them apart. There is
# deliberately no placeholder fallback: "0x00" is not a bytes32, and a draft with
# no receipt id is not proposable.
#
# The second ingredient is the governance proposal id this cycle starts from.
# OpenZeppelin's TimelockController stamps an executed operation _DONE_TIMESTAMP
# forever (lib/openzeppelin-contracts/contracts/governance/TimelockController.sol),
# so an operation id keyed on the receipt alone could be scheduled exactly once
# in the chain's lifetime: a second governance cycle for the same draft would
# find a Done operation that isOperationReady() answers false for, and no clock
# jump would ever change that. Keying the salt on the cycle keeps every rerun
# WITHIN a cycle on the same operation (the id only moves when propose lands)
# while giving the next cycle an operation of its own.
propose_salt() {
  "$CAST" keccak "$("$CAST" abi-encode 'salt(bytes32,string,uint256)' "$1" 'propose' "$2")"
}

# Every assertion the stored proposal owes the draft this run was handed: the
# draft's canonical vault order, its exact bps, a 10000 total, and the timelock
# as the proposer. Takes the raw activeProposal() blob so a caller that also
# needs the values reads the chain once.
#
# This is the assertion that proves ADMIN_ROLE was actually exercised: propose()
# is onlyRole(ADMIN_ROLE) and records msg.sender as the proposer, and only the
# timelock holds that role. A proposer that is anything else means the proposal
# arrived by some other authority, whatever the id movement suggests.
grade_stored_proposal() {
  local proposal="$1" timelock="$2" pid="$3" draft_vaults="$4" draft_bps="$5"
  local stored_proposer stored_vaults stored_bps stored_sum
  stored_proposer="$(sed -n '2p' <<<"$proposal" | awk '{print $1}')"
  stored_vaults="$(cast_array_lines "$(sed -n '3p' <<<"$proposal")")"
  stored_bps="$(cast_array_lines "$(sed -n '4p' <<<"$proposal")")"
  stored_sum="$(awk '{s += $1} END {print s + 0}' <<<"$stored_bps")"
  [[ "$stored_vaults" == "$draft_vaults" ]] \
    || die "stored proposal vaults do not equal the draft's canonical order: on chain [$(tr '\n' ' ' <<<"$stored_vaults")] vs draft [$(tr '\n' ' ' <<<"$draft_vaults")]"
  [[ "$stored_bps" == "$draft_bps" ]] \
    || die "stored proposal bps do not equal the draft's: on chain [$(tr '\n' ' ' <<<"$stored_bps")] vs draft [$(tr '\n' ' ' <<<"$draft_bps")]"
  [[ "$stored_sum" == "10000" ]] || die "stored proposal bps total $stored_sum, not 10000"
  [[ "$(lower "$stored_proposer")" == "$(lower "$timelock")" ]] \
    || die "proposal $pid names proposer $stored_proposer, not the timelock $timelock: the ADMIN_ROLE path was not the one used" 1
}

# ─── G08: the router vector, witnessed across the whole cycle ────────────────
# G08's wording is that ONLY the execute transition may change PortfolioRouter
# weights. One reading taken just before execute cannot say that: it says
# nothing about what the vector did while the proposal was being created and
# voted on, which is the whole of what the rule asks. propose, vote and execute
# are three separate CLI invocations, so a reading taken during propose only
# survives to execute on disk.
#
# These are those readings: append-only witness records, one per stage, keyed to
# the cycle (the governance proposal id) so a second cycle is never graded
# against the first cycle's vector, and to the record's run id so a rebooted
# devnet — which restarts proposal ids at 1 while the old file sits on disk —
# cannot have its history read as this run's.
GET_WEIGHTS_SIG='getWeights()(address[],uint256[])'
WITNESS_STAGES='propose vote-a vote-b'

# `<address>\t<bps>` lines from a parallel address list and bps list. A length
# mismatch is a corrupt vector, not something to zip short and keep going.
zip_pairs() {
  local vaults="$1" bps="$2" label="$3" nv nb
  nv="$(grep -c '[^[:space:]]' <<<"$vaults" || true)"
  nb="$(grep -c '[^[:space:]]' <<<"$bps" || true)"
  [[ "$nv" == "$nb" ]] || die "$label pairs $nv vaults with $nb bps" 1
  (( nv > 0 )) || return 0
  paste -d'\t' <(printf '%s\n' "$vaults") <(printf '%s\n' "$bps")
}

# One of the router's weight views as `<address>\t<bps>` lines. Empty output is a
# real answer: the voted vector is empty until a proposal has passed.
router_weight_pairs() {
  local router="$1" sig="$2" out
  out="$("$CAST" call --rpc-url "$RPC_URL" "$router" "$sig")" \
    || die "could not read ${sig%%(*}() from router $router"
  zip_pairs "$(cast_array_lines "$(sed -n '1p' <<<"$out")")" \
            "$(cast_array_lines "$(sed -n '2p' <<<"$out")")" "router ${sig%%(*}()"
}

# One vault's bps out of a pair list: the value when the list names the vault
# exactly once, and an empty string when it does not name it at all. A vault
# named twice is a corrupt vector, never a silent first hit.
weight_lookup() {
  local pairs="$1" vault="$2" hits count
  hits="$(awk -F'\t' -v v="$(lower "$vault")" '$1 == v { print $2 }' <<<"$pairs")"
  count="$(grep -c '[^[:space:]]' <<<"$hits" || true)"
  (( count <= 1 )) || die "a weight vector names vault $vault $count times: [$(tr '\n' ' ' <<<"$pairs")]" 1
  printf '%s' "$(tr -d '[:space:]' <<<"$hits")"
}

# This cycle's witness file. $OUT_DIR is where the ceremony already keeps the
# record, and every action defaults to the same one, so propose, vote and
# execute all find it without being told.
witness_file() {
  local pid="$1" run
  [[ "$pid" =~ ^[0-9]+$ ]] || die "a weight witness is keyed on a numeric proposal id, got '$pid'" 64
  run="$(jq -r '.run_id // "unkeyed"' "$RECORD" | tr -cd '[:alnum:]._-')"
  printf '%s/weight-witness/%s-cycle-%s.jsonl' "$OUT_DIR" "${run:-unkeyed}" "$pid"
}

# The latest block number as a decimal, or the JSON literal `null` when the
# chain will not say. A witness carries it so an auditor can place the reading
# in chain history rather than in wall-clock time.
chain_block() {
  local n=""
  n="$("$CAST" block-number --rpc-url "$RPC_URL" 2>/dev/null | tr -cd '[:alnum:]')" || n=""
  if [[ "$n" == 0x* ]]; then n="$("$CAST" to-dec "$n" 2>/dev/null || true)"; fi
  [[ "$n" =~ ^[0-9]+$ ]] || { printf 'null'; return 0; }
  printf '%s' "$n"
}

# The router's weight for every vault the record names, as one sorted line of
# `<key>=<address>=<bps>` tokens. A vault the vector does not name reads as
# `absent`, which is a value like any other: it has to stay absent until execute
# too, so a bucket appearing out of nowhere counts as a change.
router_vector_fingerprint() {
  local pairs="$1" key vault bps out="" sep=""
  while read -r key; do
    [[ -n "$key" ]] || continue
    vault="$(lower "$(rec ".vault_addresses.$key")")"
    is_address "$vault" || die "record carries no address for vault $key" 65
    bps="$(weight_lookup "$pairs" "$vault")" || exit $?
    out+="$sep$key=$vault=${bps:-absent}"
    sep=" "
  done < <(jq -r '.vault_addresses | keys[]' "$RECORD")
  printf '%s' "$out"
}

# One fingerprint as the JSON array a reader can audit: {vault_key, vault,
# router_bps}, with a bucket the vector does not name reported as null rather
# than as a weight of 0.
witness_weights_json() {
  tr ' ' '\n' <<<"$1" | awk -F= 'NF == 3 { print $1; print $2; print $3 }' \
    | jq -Rn '[inputs] as $a
      | [range(0; ($a | length); 3)
         | {vault_key: $a[.], vault: $a[. + 1],
            router_bps: (if $a[. + 2] == "absent" then null else ($a[. + 2] | tonumber) end)}]'
}

# record_weight_witness <stage> <router> <proposal-id>: append ONE witness — the
# stage, the chain time and block it was taken at, and the router's weight for
# every vault the record names — to this cycle's witness file.
#
# A witness is never faked, and a lost one is never swallowed either: this
# returns non-zero and leaves $WITNESS_RESULT describing the loss, which propose
# and vote both carry in their own JSON so a driver reading the result sees a
# degraded proof instead of a whole one.
#
# What it must NOT do is die. Every caller records AFTER its transactions are
# mined, so a failed READING here would throw away the JSON evidence of chain
# work that already landed — one RPC blip on getWeights() would cost the whole
# propose record, ProposalCreated decode included, with the proposal itself
# irreversibly on chain. A read failure is therefore contained exactly like a
# write failure: the run loses one witness and execute grades
# weights_unchanged_until_execute unproven, which is the honest answer.
WITNESS_RESULT='{"recorded":false,"stage":null,"reason":"no weight witness was attempted"}'

# Say the loss on stderr and leave it in $WITNESS_RESULT for the caller's JSON.
witness_lost() {
  local stage="$1" pid="$2" file="$3" why="$4"
  WITNESS_RESULT="$(jq -cn --arg s "$stage" --arg f "$file" --arg why "$why" \
    '{recorded:false, stage:$s, witness_file:$f, reason:$why}')"
  info "$why (cycle $pid, $file): execute will report weights_unchanged_until_execute unproven rather than claim a proof it does not have"
}

record_weight_witness() {
  local stage="$1" router="$2" pid="$3" file dir pairs fingerprint weights now block line
  file="$(witness_file "$pid")" || exit $?
  dir="$(dirname "$file")"
  # Every read in one condition, so a router that will not answer — or a record
  # whose vault list no longer matches it — costs this witness and nothing else.
  if ! pairs="$(router_weight_pairs "$router" "$GET_WEIGHTS_SIG")" \
     || ! fingerprint="$(router_vector_fingerprint "$pairs")" \
     || ! weights="$(witness_weights_json "$fingerprint")" \
     || ! now="$(chain_time)"; then
    witness_lost "$stage" "$pid" "$file" "could not read the router vector for the $stage weight witness"
    return 1
  fi
  block="$(chain_block)"
  if ! line="$(jq -cn --arg stage "$stage" --arg pid "$pid" --arg router "$router" \
    --arg fp "$fingerprint" --argjson weights "$weights" \
    --argjson t "$now" --argjson b "$block" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{stage:$stage, proposal_id:$pid, router:$router, chain_time:$t, block_number:$b,
      recorded_at:$at, fingerprint:$fp, weights:$weights}')"; then
    witness_lost "$stage" "$pid" "$file" "could not build the $stage weight witness record"
    return 1
  fi
  if ! mkdir -p "$dir" 2>/dev/null || ! printf '%s\n' "$line" >>"$file" 2>/dev/null; then
    witness_lost "$stage" "$pid" "$file" "could not write the $stage weight witness"
    return 1
  fi
  WITNESS_RESULT="$(jq -cn --arg s "$stage" --arg f "$file" --arg fp "$fingerprint" \
    --argjson t "$now" --argjson b "$block" \
    '{recorded:true, stage:$s, witness_file:$f, fingerprint:$fp, chain_time:$t, block_number:$b}')"
  info "witnessed the router vector at stage $stage of cycle $pid (chain time $now, block $block): [$fingerprint]"
}

# grade_weight_witnesses <proposal-id> <live-fingerprint>: every witness this
# cycle recorded, compared to each other AND to the caller's own live reading.
# Prints ONE JSON object, and there are exactly three answers:
#
#   • every witness agrees with every other and with the live vector, the
#     PROPOSE witness is among them, and the file held nothing this run could
#     not read -> {"asserted":true, ...}, the only shape a reader may read as a
#     proof.
#   • any disagreement -> the ceremony DIES. A router vector that moved before
#     execute is precisely the breach G08 exists to detect, so it is never
#     swallowed into a false verdict or a quiet skip.
#   • a record this run cannot stand behind -> {"asserted":false, reason:…}.
#     "This run could not test it" is said out loud, never dressed up as a pass.
#     Three things land here, each named in its own reason: no witness at all
#     (an execute run standalone against a cycle whose propose and vote ran
#     before this feature); a line this run cannot read as a witness, which a
#     truncated append leaves behind and which may have said anything; and a
#     file with no propose witness in it, which can only show the vector held
#     from the first vote onward while G08 asks about the whole cycle.
#
# A file that cannot be read is NOT a reason to die. Only a weights
# DISAGREEMENT is, because only that is evidence of the breach; an unreadable
# record is the "could not test this" case, and killing execute over it would
# cost the transition's own grading too.
grade_weight_witnesses() {
  local pid="$1" live_fp="$2"
  local file line stage fp count=0 corrupt=0 stages_seen=""
  local first_fp="" first_stage="" disagreements="" witnesses='[]'
  file="$(witness_file "$pid")" || exit $?
  if [[ -s "$file" ]]; then
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      if ! jq -e . >/dev/null 2>&1 <<<"$line"; then
        corrupt=$(( corrupt + 1 )); continue
      fi
      stage="$(jq -r '.stage // ""' <<<"$line")"
      [[ " $WITNESS_STAGES " == *" $stage "* ]] || continue
      fp="$(jq -r '.fingerprint // ""' <<<"$line")"
      if [[ -z "$fp" ]]; then
        corrupt=$(( corrupt + 1 )); continue
      fi
      count=$(( count + 1 ))
      stages_seen+=" $stage"
      if (( count == 1 )); then first_fp="$fp"; first_stage="$stage"; fi
      [[ "$fp" == "$first_fp" ]] \
        || disagreements+="the $stage witness reads [$fp] where the $first_stage witness read [$first_fp]; "
      [[ "$fp" == "$live_fp" ]] \
        || disagreements+="the $stage witness reads [$fp] where the router reads [$live_fp] at execute; "
      witnesses="$(jq -c --argjson acc "$witnesses" '$acc + [.]' <<<"$line")"
    done <"$file"
  fi
  # Graded first, and whatever else the file holds: a vector that moved before
  # execute is the breach, and no amount of missing record excuses it.
  if [[ -n "$disagreements" ]]; then
    die "PortfolioRouter weights changed before execute in governance cycle $pid: ${disagreements%; } — G08 grades this transition as the ONLY thing that may change the router's weights, so a vector that moved during propose or voting is that breach, not a clause to report as unproven" 1
  fi
  local reason=""
  if (( count == 0 )); then
    reason="no propose or vote weight witness was recorded for governance cycle $pid, so this run cannot say whether the router vector held across propose and both votes"
  elif (( corrupt > 0 )); then
    reason="weight witness file $file carries $corrupt line(s) this run cannot read as a witness (a truncated append leaves exactly that), so the record of governance cycle $pid is partial and cannot carry the claim"
  elif [[ " $stages_seen " != *" propose "* ]]; then
    reason="no propose weight witness was recorded for governance cycle $pid (only:${stages_seen}), so this run can say nothing about the router vector between the proposal being created and the first vote"
  fi
  if [[ -n "$reason" ]]; then
    info "$reason; the weights-unchanged-until-execute clause is reported UNPROVEN, never passed"
    jq -cn --arg pid "$pid" --arg file "$file" --arg live "$live_fp" --arg reason "$reason" \
      --argjson n "$count" --argjson c "$corrupt" --argjson w "$witnesses" \
      '{asserted:false, proposal_id:$pid, witnesses:$w, witness_file:$file, witness_count:$n,
        corrupt_lines:$c, live_fingerprint:$live, reason:$reason}'
    return 0
  fi
  info "the router vector held across $count witnessed stage(s) of cycle $pid and still reads the same at execute: [$live_fp]"
  jq -cn --arg pid "$pid" --arg file "$file" --arg live "$live_fp" --argjson n "$count" \
    --argjson c "$corrupt" --argjson w "$witnesses" \
    '{asserted:true, proposal_id:$pid, witness_file:$file, witness_count:$n,
      corrupt_lines:$c, live_fingerprint:$live, witnesses:$w,
      claim:"every propose and vote witness of this cycle read the same PortfolioRouter vector, and the router still reads it at execute: only this transition can have changed it"}'
}

propose_governance() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  [[ -n "${DRAFT_FILE:-}" ]] || die "--draft-file is required" 64
  [[ -f "$DRAFT_FILE" ]] || die "draft file not found: $DRAFT_FILE" 65
  local governance timelock safe keydir delay data salt zero op receipt_id router
  governance="$(rec .addresses.governance)"; timelock="$(rec .addresses.timelock)"
  safe="$(rec .addresses.safe)"; keydir="$(rec .ephemeral.keystore_dir)"; delay="$(rec .min_delay)"
  router="$(rec .addresses.router)"
  is_address "$router" || die "record carries no router address to witness weights against: '$router'" 65
  [[ -f "$keydir/approver" ]] || die "approver keystore is gone (discarded?): $keydir" 65
  require_contract "$governance" governance
  require_contract "$timelock" timelock
  require_contract "$safe" safe

  data="$(draft_propose_calldata)"
  receipt_id="$(draft_receipt_id)"

  # The draft's own vector, checked before it is put on chain: four canonical
  # buckets whose bps total 10000, which is what RouterGovernance.propose will
  # itself enforce and what the stored proposal is compared against afterwards.
  local draft_vaults draft_bps draft_count draft_sum
  draft_vaults="$(draft_vault_list)"
  draft_bps="$(draft_bps_list)"
  draft_count="$(jq '[.drafts[0].vaults[]] | length' "$DRAFT_FILE")"
  draft_sum="$(jq '[.drafts[0].vaults[].weight_bps] | add // 0' "$DRAFT_FILE")"
  [[ "$draft_count" == "4" ]] || die "draft names $draft_count vaults, not the four canonical buckets" 65
  [[ "$draft_sum" == "10000" ]] || die "draft weights total $draft_sum bps, not 10000" 65

  # Idempotency is a question about RouterGovernance, not about the timelock.
  # The timelock's isOperationDone only says whether one schedule/execute pair
  # ran; it says nothing about a proposal created by some other route, and it
  # answers "no" for a salt that has simply changed. The contract's own rule is
  # that an Active or Queued proposal blocks a new one (ActiveProposalExists),
  # so that is the state this reads — before anything is scheduled or signed.
  local pid_before state state_name
  pid_before="$(call "$governance" 'currentProposalId()(uint256)')"
  [[ "$pid_before" =~ ^[0-9]+$ ]] || die "could not read currentProposalId() from governance $governance"
  if [[ "$pid_before" != "0" ]]; then
    state="$(call "$governance" 'proposalState(uint256)(uint8)' "$pid_before")"
    [[ "$state" =~ ^[0-9]+$ ]] || die "could not read proposalState($pid_before) from governance $governance"
    # ProposalState: 0 Active, 1 Defeated, 2 Queued, 3 Executed, 4 Cancelled.
    if [[ "$state" == "0" || "$state" == "2" ]]; then
      state_name=Active
      [[ "$state" == "2" ]] && state_name=Queued
      # Idempotent is a claim about THIS draft, not about any proposal at all.
      # The live proposal is graded against the draft before the run is allowed
      # to report success, so a proposal left behind by a different draft — or
      # one whose proposer is not the timelock, the corruption the positive path
      # exists to catch — is refused here rather than recorded as "proposed".
      local live_proposal
      live_proposal="$("$CAST" call --rpc-url "$RPC_URL" "$governance" "$ACTIVE_PROPOSAL_SIG")" \
        || die "could not read activeProposal() from governance $governance"
      grade_stored_proposal "$live_proposal" "$timelock" "$pid_before" "$draft_vaults" "$draft_bps"
      info "proposal $pid_before is already $state_name on $governance and matches the draft; scheduling nothing"
      # G08 starts here, not at execute: the vector the router carries while the
      # proposal is merely Active is the first thing execute compares against.
      record_weight_witness propose "$router" "$pid_before" || true
      jq -n --arg pid "$pid_before" --arg st "$state_name" --argjson witness "$WITNESS_RESULT" \
        '{action:"already_proposed", proposal_id:$pid, proposal_state:$st,
          weight_witness:$witness}'
      return 0
    fi
  fi

  zero="0x0000000000000000000000000000000000000000000000000000000000000000"
  salt="$(propose_salt "$receipt_id" "$pid_before")"
  [[ "$salt" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "derived propose salt is not a bytes32: $salt"

  op="$(call "$timelock" 'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)' "$governance" 0 "$data" "$zero" "$salt")"
  [[ "$op" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "could not hash the propose operation on timelock $timelock"

  # A Done operation is not a stuck one: TimelockController stamps it
  # _DONE_TIMESTAMP and isOperationReady() answers false for it forever. Saying
  # so here keeps that state from surfacing as "never became ready", which names
  # the wrong cause and sends the operator to wait out a delay that has passed.
  if [[ "$(call "$timelock" 'isOperationDone(bytes32)(bool)' "$op")" == "true" ]]; then
    die "timelock operation $op (salt $salt) is already Done on $timelock: this draft's propose has already run through the timelock for the cycle starting at proposal id $pid_before, and OpenZeppelin's TimelockController never runs a Done operation twice" 1
  fi

  local schedule_tx="" execute_tx=""
  if [[ "$(call "$timelock" 'isOperation(bytes32)(bool)' "$op")" != "true" ]]; then
    schedule_tx="$(safe_exec "$safe" "$timelock" \
      "$("$CAST" calldata 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' "$governance" 0 "$data" "$zero" "$salt" "$delay")")"
    info "scheduled propose $op (salt $salt); jumping chain time past the ${delay}s delay"
  fi
  # Devnet time is ours to move: read when the timelock says the operation is
  # ready and jump the chain there, rather than sitting out $delay real seconds.
  local ready
  ready="$(call "$timelock" 'getTimestamp(bytes32)(uint256)' "$op")"
  if [[ "$ready" =~ ^[0-9]+$ ]] && (( ready > 1 )); then
    jump_to "$(( ready + 1 ))"
  fi
  [[ "$(call "$timelock" 'isOperationReady(bytes32)(bool)' "$op")" == "true" ]] || die "timelock operation never became ready: $op"
  execute_tx="$(safe_exec "$safe" "$timelock" \
    "$("$CAST" calldata 'execute(address,uint256,bytes,bytes32,bytes32)' "$governance" 0 "$data" "$zero" "$salt")")"

  # ── the authority path, proved rather than assumed ────────────────────────
  # A changed currentProposalId only says something happened. propose() sets it
  # to exactly currentProposalId + 1, so anything else means the id moved by a
  # route this ceremony did not drive.
  local pid_after
  pid_after="$(call "$governance" 'currentProposalId()(uint256)')"
  [[ "$pid_after" =~ ^[0-9]+$ ]] || die "could not read currentProposalId() after execute"
  [[ "$pid_after" == "$(( pid_before + 1 ))" ]] \
    || die "currentProposalId went $pid_before -> $pid_after; propose() advances it by exactly one"

  local proposal stored_id stored_proposer stored_vaults stored_bps stored_sum
  proposal="$("$CAST" call --rpc-url "$RPC_URL" "$governance" \
    'activeProposal()(uint256,address,address[],uint256[],uint64,uint64,uint256,uint256,bool,bool)')" \
    || die "could not read activeProposal() back from governance $governance"
  stored_id="$(sed -n '1p' <<<"$proposal" | awk '{print $1}')"
  stored_proposer="$(sed -n '2p' <<<"$proposal" | awk '{print $1}')"
  stored_vaults="$(cast_array_lines "$(sed -n '3p' <<<"$proposal")")"
  stored_bps="$(cast_array_lines "$(sed -n '4p' <<<"$proposal")")"
  stored_sum="$(awk '{s += $1} END {print s + 0}' <<<"$stored_bps")"

  [[ "$stored_id" == "$pid_after" ]] \
    || die "activeProposal() reports id $stored_id, not the new currentProposalId $pid_after"
  grade_stored_proposal "$proposal" "$timelock" "$pid_after" "$draft_vaults" "$draft_bps"
  info "proposal $pid_after stored with proposer $stored_proposer (the timelock) over $draft_count buckets totalling $stored_sum bps"

  # ── ProposalCreated, decoded from the execute receipt ──────────────────────
  local created_topic receipt_json created_log ev_pid ev_proposer ev_data ev_decoded
  local ev_vaults ev_bps ev_deadline created_json
  created_topic="$(lower "$("$CAST" keccak "$PROPOSAL_CREATED_SIG")")"
  receipt_json="$("$CAST" receipt --rpc-url "$RPC_URL" "$execute_tx" --json)" \
    || die "could not fetch the execute receipt $execute_tx"
  created_log="$(jq -c --arg addr "$(lower "$governance")" --arg topic "$created_topic" \
    '[.logs[]? | select((.address | ascii_downcase) == $addr and ((.topics[0] // "") | ascii_downcase) == $topic)] | last // empty' \
    <<<"$receipt_json")"
  [[ -n "$created_log" ]] || die "execute receipt $execute_tx carries no ProposalCreated log from $governance"
  ev_pid="$("$CAST" to-dec "$(jq -r '.topics[1]' <<<"$created_log")")"
  ev_proposer="$(jq -r '.topics[2]' <<<"$created_log")"
  ev_proposer="0x${ev_proposer: -40}"
  ev_data="$(jq -r '.data' <<<"$created_log")"
  ev_decoded="$("$CAST" abi-decode 'ProposalCreated()(address[],uint256[],uint64)' "$ev_data")" \
    || die "could not decode the ProposalCreated payload of $execute_tx"
  ev_vaults="$(cast_array_lines "$(sed -n '1p' <<<"$ev_decoded")")"
  ev_bps="$(cast_array_lines "$(sed -n '2p' <<<"$ev_decoded")")"
  ev_deadline="$(sed -n '3p' <<<"$ev_decoded" | awk '{print $1}')"

  [[ "$ev_pid" == "$pid_after" ]] || die "ProposalCreated names proposal $ev_pid, not $pid_after"
  [[ "$(lower "$ev_proposer")" == "$(lower "$timelock")" ]] \
    || die "ProposalCreated names proposer $ev_proposer, not the timelock $timelock"
  [[ "$ev_vaults" == "$draft_vaults" ]] || die "ProposalCreated vaults do not equal the draft's"
  [[ "$ev_bps" == "$draft_bps" ]] || die "ProposalCreated bps do not equal the draft's"

  created_json="$(jq -n --arg pid "$ev_pid" --arg proposer "$ev_proposer" \
    --arg deadline "$ev_deadline" --arg tx "$execute_tx" \
    --argjson vaults "$(json_str_array <<<"$ev_vaults")" \
    --argjson bps "$(json_num_array <<<"$ev_bps")" \
    '{event:"ProposalCreated", proposal_id:$pid, proposer:$proposer, vaults:$vaults,
      bps:$bps, voting_deadline:$deadline, tx:$tx}')"

  # ── the G08 witness: the router vector at the moment the proposal exists ──
  # Recorded now, kept on disk, and compared by `execute` against the vote-stage
  # witnesses and its own live reading. Nothing but execute may move it.
  record_weight_witness propose "$router" "$pid_after" || true

  # The keystore stays: vote and execute still need the approver and the voters.
  # Shredding is the standalone `discard` action, run when the ceremony is over.
  jq -n --arg op "$op" --arg s "$schedule_tx" --arg e "$execute_tx" --arg pid "$pid_after" \
    --arg before "$pid_before" --arg salt "$salt" --arg rid "$receipt_id" \
    --arg proposer "$stored_proposer" --arg timelock "$timelock" \
    --argjson vaults "$(json_str_array <<<"$stored_vaults")" \
    --argjson bps "$(json_num_array <<<"$stored_bps")" \
    --argjson sum "$stored_sum" --argjson created "$created_json" \
    --argjson witness "$WITNESS_RESULT" \
    '{action:"proposed_via_timelock", operation:$op, salt:$salt, receipt_id:$rid,
      schedule_tx:$s, execute_tx:$e, proposal_id:$pid, proposal_id_before:$before,
      proposer:$proposer, timelock:$timelock, vaults:$vaults, bps:$bps, bps_total:$sum,
      proposal_created:$created, weight_witness:$witness}'
}

# ─── governance propose: the negative control ────────────────────────────────
# The positive path can only show that SOMETHING created a proposal. This shows
# what happens without the timelock: the same bytes, sent by the operator EOA
# that runs the ceremony, must be refused by propose()'s onlyRole(ADMIN_ROLE)
# modifier — which runs before any of the contract's own validation, so the
# answer is AccessControlUnauthorizedAccount whatever else is on chain.
#
# eth_call, never a transaction: the control burns no nonce, spends no gas and
# leaves no state behind, so it can run before or after the positive path.
propose_negative() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  [[ -n "${DRAFT_FILE:-}" ]] || die "--draft-file is required" 64
  [[ -f "$DRAFT_FILE" ]] || die "draft file not found: $DRAFT_FILE" 65
  local governance timelock operator data expected_err
  governance="$(rec .addresses.governance)"; timelock="$(rec .addresses.timelock)"
  operator="$(rec .ephemeral.submitter)"
  is_address "$operator" || die "record carries no submitter address to call from" 65
  require_contract "$governance" governance

  data="$(draft_propose_calldata)"
  expected_err="$(lower "$("$CAST" sig "$ACCESS_CONTROL_ERROR_SIG")")"

  local out revert_data=""
  if out="$("$CAST" call "$governance" --data "$data" --from "$operator" --rpc-url "$RPC_URL" 2>&1)"; then
    die "propose() from the operator EOA $operator SUCCEEDED in eth_call (returned '${out:-<empty>}'): the ADMIN_ROLE guard on $governance is not in force" 1
  fi

  # Prefer the `data: "0x.."` field foundry prints for a custom error; fall back
  # to the longest hex blob in the message, minus the address we called.
  revert_data="$(sed -n 's/.*data: *"\(0x[0-9a-fA-F]*\)".*/\1/p' <<<"$out" | tail -1)"
  if [[ -z "$revert_data" ]]; then
    revert_data="$(grep -oiE '0x[0-9a-f]{8,}' <<<"$out" | grep -vix "$governance" | grep -vix "$operator" | tail -1 || true)"
  fi

  local matched=""
  if [[ -n "$revert_data" && "$(lower "${revert_data:0:10}")" == "$expected_err" ]]; then
    matched="selector"
  elif grep -qi 'AccessControlUnauthorizedAccount' <<<"$out"; then
    matched="name"
  else
    die "propose() from $operator reverted, but not with AccessControlUnauthorizedAccount ($expected_err): ${revert_data:-$out}" 1
  fi

  # When the full custom-error payload came back, grade its operands too: the
  # refused account must be the caller and the missing role must be ADMIN_ROLE.
  local decoded_json='null' err_account err_role
  if [[ "${#revert_data}" == "138" ]]; then
    err_account="0x${revert_data:34:40}"
    err_role="0x${revert_data:74:64}"
    [[ "$(lower "$err_account")" == "$(lower "$operator")" ]] \
      || die "AccessControlUnauthorizedAccount names account $err_account, not the caller $operator" 1
    [[ "$(lower "$err_role")" == "$(lower "$ADMIN_ROLE")" ]] \
      || die "AccessControlUnauthorizedAccount names role $err_role, not ADMIN_ROLE $ADMIN_ROLE" 1
    decoded_json="$(jq -n --arg a "$err_account" --arg r "$err_role" '{account:$a, needed_role:$r}')"
  else
    info "revert payload is ${#revert_data} chars; matched by $matched without decoding operands"
  fi

  info "operator EOA $operator cannot call propose() on $governance: AccessControlUnauthorizedAccount"
  jq -n --arg gov "$governance" --arg caller "$operator" --arg tl "$timelock" \
    --arg sel "$(lower "${data:0:10}")" --arg err "$expected_err" \
    --arg rd "$revert_data" --arg matched "$matched" --argjson decoded "$decoded_json" \
    '{action:"propose_refused_from_eoa", governance:$gov, caller:$caller,
      only_admin_is:$tl, calldata_selector:$sel, expected_error:"AccessControlUnauthorizedAccount",
      expected_error_selector:$err, revert_data:$rd, matched_by:$matched, decoded:$decoded}'
}

# ─── governance vote ─────────────────────────────────────────────────────────
# Names, never hand-copied selectors, so a contract rename breaks this loudly.
VOTE_SIG='vote(uint256)'
EXECUTE_SIG='execute(uint256)'
VOTE_CAST_SIG='VoteCast(uint256,address,uint256,uint256)'
NO_VOTING_POWER_SIG='NoVotingPower()'
VOTING_STILL_OPEN_SIG='VotingStillOpen()'
QUORUM_NOT_REACHED_SIG='QuorumNotReached()'
ACTIVE_PROPOSAL_SIG='activeProposal()(uint256,address,address[],uint256[],uint64,uint64,uint256,uint256,bool,bool)'

# The revert payload foundry printed for a failed `cast call`: the `data: "0x.."`
# field when it is there, otherwise the last long hex blob in the message with
# the addresses we passed in filtered back out.
revert_payload() {
  local out="$1"; shift
  local data candidates skip
  data="$(sed -n 's/.*data: *"\(0x[0-9a-fA-F]*\)".*/\1/p' <<<"$out" | tail -1)"
  if [[ -z "$data" ]]; then
    candidates="$(grep -oiE '0x[0-9a-f]{8,}' <<<"$out" || true)"
    for skip in "$@"; do
      candidates="$(grep -vix "$skip" <<<"$candidates" || true)"
    done
    data="$(tail -1 <<<"$candidates")"
  fi
  printf '%s' "$data"
}

# assert_call_reverts <label> <Error()> <from> <target> <sig> [args...]
# An eth_call that MUST revert with one named custom error. A call that succeeds
# is a failure, and so is a call that reverts with anything else: the clause is
# only worth something if it names the specific error, so "it failed somehow"
# never passes. Prints "<error>\t<selector|name>\t<payload>" on success.
assert_call_reverts() {
  local label="$1" error_sig="$2" from="$3" target="$4"; shift 4
  local name expected out payload
  name="${error_sig%%(*}"
  expected="$(lower "$("$CAST" sig "$error_sig")")"
  if out="$("$CAST" call --rpc-url "$RPC_URL" --from "$from" "$target" "$@" 2>&1)"; then
    die "$label SUCCEEDED in eth_call (returned '${out:-<empty>}'): it must revert $name" 1
  fi
  payload="$(revert_payload "$out" "$from" "$target")"
  if [[ -n "$payload" && "$(lower "${payload:0:10}")" == "$expected" ]]; then
    printf '%s\t%s\t%s' "$name" "selector" "$payload"
  elif grep -q "$name" <<<"$out"; then
    printf '%s\t%s\t%s' "$name" "name" "$payload"
  else
    die "$label reverted, but not with $name ($expected): ${payload:-$out}" 1
  fi
}

# The VoteCast log of one mined vote, decoded and graded against the proposal and
# the voter it has to name. Prints one JSON object.
decode_vote_cast() {
  local tx="$1" governance="$2" pid="$3" voter="$4"
  local topic receipt_json log ev_pid ev_voter ev_decoded ev_power ev_total
  topic="$(lower "$("$CAST" keccak "$VOTE_CAST_SIG")")"
  receipt_json="$("$CAST" receipt --rpc-url "$RPC_URL" "$tx" --json)" \
    || die "could not fetch the vote receipt $tx"
  log="$(jq -c --arg addr "$(lower "$governance")" --arg topic "$topic" \
    '[.logs[]? | select((.address | ascii_downcase) == $addr and ((.topics[0] // "") | ascii_downcase) == $topic)] | last // empty' \
    <<<"$receipt_json")"
  [[ -n "$log" ]] || die "vote receipt $tx carries no VoteCast log from $governance"
  ev_pid="$("$CAST" to-dec "$(jq -r '.topics[1]' <<<"$log")")"
  ev_voter="$(jq -r '.topics[2]' <<<"$log")"
  ev_voter="0x${ev_voter: -40}"
  ev_decoded="$("$CAST" abi-decode 'VoteCast()(uint256,uint256)' "$(jq -r '.data' <<<"$log")")" \
    || die "could not decode the VoteCast payload of $tx"
  ev_power="$(sed -n '1p' <<<"$ev_decoded" | awk '{print $1}')"
  ev_total="$(sed -n '2p' <<<"$ev_decoded" | awk '{print $1}')"
  [[ "$ev_pid" == "$pid" ]] || die "VoteCast in $tx names proposal $ev_pid, not $pid"
  [[ "$(lower "$ev_voter")" == "$(lower "$voter")" ]] \
    || die "VoteCast in $tx names voter $ev_voter, not $voter"
  [[ "$ev_power" =~ ^[1-9][0-9]*$ ]] \
    || die "VoteCast in $tx credits $voter with power '$ev_power'"
  [[ "$ev_total" =~ ^[0-9]+$ ]] || die "VoteCast in $tx carries a non-numeric tally '$ev_total'"
  jq -n --arg pid "$ev_pid" --arg voter "$ev_voter" --argjson power "$ev_power" \
     --argjson total "$ev_total" --arg tx "$tx" \
     '{event:"VoteCast", proposal_id:$pid, voter:$voter, power:$power, total_for:$total, tx:$tx}'
}

# Fields 5 (votingDeadline), 7 (votesFor) and 8 (snapshotQuorum) of the stored
# proposal, as three decimal numbers on one line.
proposal_tally() {
  local governance="$1" proposal deadline votes quorum
  proposal="$("$CAST" call --rpc-url "$RPC_URL" "$governance" "$ACTIVE_PROPOSAL_SIG")" \
    || die "could not read activeProposal() from governance $governance"
  deadline="$(sed -n '5p' <<<"$proposal" | awk '{print $1}')"
  votes="$(sed -n '7p' <<<"$proposal" | awk '{print $1}')"
  quorum="$(sed -n '8p' <<<"$proposal" | awk '{print $1}')"
  [[ "$deadline" =~ ^[0-9]+$ && "$votes" =~ ^[0-9]+$ && "$quorum" =~ ^[0-9]+$ ]] \
    || die "activeProposal() on $governance returned a non-numeric deadline/tally/quorum: '$deadline' '$votes' '$quorum'"
  printf '%s %s %s' "$deadline" "$votes" "$quorum"
}

proposal_state_name() {
  local state="$1"
  case "$state" in
    0) printf 'Active' ;;
    1) printf 'Defeated' ;;
    2) printf 'Queued' ;;
    3) printf 'Executed' ;;
    4) printf 'Cancelled' ;;
    *) printf 'unknown(%s)' "$state" ;;
  esac
}

read_proposal_state() {
  local governance="$1" pid="$2" state
  state="$(call "$governance" 'proposalState(uint256)(uint8)' "$pid")"
  [[ "$state" =~ ^[0-9]+$ ]] || die "could not read proposalState($pid) from governance $governance"
  printf '%s' "$state"
}

# vote(uint256) carries no role guard, so this is plain EOA sending: the two
# ephemeral voters, one power each, against the quorum of 2 `run` provisions.
vote_governance() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  local governance keydir voter_a voter_b powerless acct who router
  governance="$(rec .addresses.governance)"; keydir="$(rec .ephemeral.keystore_dir)"
  voter_a="$(rec '.ephemeral.voters[0]')"; voter_b="$(rec '.ephemeral.voters[1]')"
  powerless="$(rec .ephemeral.emergency)"; router="$(rec .addresses.router)"
  is_address "$router" || die "record carries no router address to witness weights against: '$router'" 65
  for acct in "$governance" "$voter_a" "$voter_b" "$powerless"; do
    is_address "$acct" || die "record carries a non-address where the vote path needs one: '$acct'" 65
  done
  require_contract "$governance" governance
  for who in voter-a voter-b; do
    [[ -f "$keydir/$who" && -f "$keydir/$who.pw" ]] \
      || die "$who keystore is gone (discarded?): $keydir" 65
  done

  # ── 1. the proposal, and the state that makes voting possible at all ──────
  local pid state state_name
  pid="$(call "$governance" 'currentProposalId()(uint256)')"
  [[ "$pid" =~ ^[0-9]+$ ]] || die "could not read currentProposalId() from governance $governance"
  [[ "$pid" != "0" ]] \
    || die "governance $governance holds no proposal (currentProposalId is 0): run \`fusion-ceremony.sh propose\` first" 65
  state="$(read_proposal_state "$governance" "$pid")"
  state_name="$(proposal_state_name "$state")"
  [[ "$state" == "0" ]] \
    || die "proposal $pid is $state_name, not Active: vote() would revert ProposalNotActive, and this ceremony will not pretend a vote happened" 1
  info "voting on proposal $pid ($state_name) at $governance"

  # ── 2. NEGATIVE: voting power is the gate, proved from a key that has none ─
  local neg neg_error neg_matched neg_payload
  neg="$(assert_call_reverts "vote($pid) from the powerless key $powerless" \
          "$NO_VOTING_POWER_SIG" "$powerless" "$governance" "$VOTE_SIG" "$pid")" || exit $?
  IFS=$'\t' read -r neg_error neg_matched neg_payload <<<"$neg"
  info "powerless key $powerless cannot vote on proposal $pid: $neg_error (matched by $neg_matched)"

  # ── 3. voter-a votes, unless an earlier run already spent its vote ────────
  local a_voted a_outcome tx_a="" vote_cast_a=null voter_a_json
  a_voted="$(call "$governance" 'hasVoted(uint256,address)(bool)' "$pid" "$voter_a")"
  if [[ "$a_voted" == "true" ]]; then
    a_outcome="already_voted"
    info "voter-a $voter_a already voted on proposal $pid; sending nothing"
  else
    a_outcome="voted"
    tx_a="$(send --keystore "$keydir/voter-a" --password-file "$keydir/voter-a.pw" \
              "$governance" "$VOTE_SIG" "$pid")"
    vote_cast_a="$(decode_vote_cast "$tx_a" "$governance" "$pid" "$voter_a")" || exit $?
    info "voter-a $voter_a voted in $tx_a"
  fi
  voter_a_json="$(jq -n --arg addr "$voter_a" --arg outcome "$a_outcome" --arg tx "$tx_a" \
    --argjson cast "$vote_cast_a" \
    '{address:$addr, outcome:$outcome, tx:(if $tx == "" then null else $tx end), vote_cast:$cast}')"

  # G08: the router vector with voter-a's vote on chain. Taken BEFORE the
  # closed-window probe below, so it witnesses the real chain and never the
  # throwaway state the snapshot rolls back.
  local witness_a witness_b
  record_weight_witness vote-a "$router" "$pid" || true
  witness_a="$WITNESS_RESULT"

  # ── 4. one vote is not enough, against the error the live state dictates ──
  # While the window is open execute() reverts VotingStillOpen; once it closes
  # with the tally short of quorum it reverts QuorumNotReached. Either way the
  # assertion names the one error, so the clause cannot pass on a bare failure.
  local deadline votes_mid quorum now expected_sig insufficient_json
  # Command substitution, not process substitution: a `die` inside proposal_tally
  # has to end the ceremony rather than hand `read` an empty line.
  local tally
  tally="$(proposal_tally "$governance")" || exit $?
  read -r deadline votes_mid quorum <<<"$tally"
  if (( votes_mid == 0 )); then
    die "proposal $pid still shows 0 votes after voter-a's turn: no vote is on chain to reason about" 1
  fi
  if (( votes_mid < quorum )); then
    local exec_out exec_error exec_matched exec_payload snap probe_rc=0 probe_at now_back
    now="$(chain_time)"
    expected_sig="$QUORUM_NOT_REACHED_SIG"
    # The rule being claimed here is the TALLY rule, and execute() only reaches
    # it once voting has closed: while `block.timestamp <= votingDeadline` it
    # reverts VotingStillOpen before it compares votesFor with the quorum at all
    # (contracts/RouterGovernance.sol execute()). Accepting VotingStillOpen as
    # the proof would pass against a governance contract with no quorum rule
    # whatsoever, so the window is closed first — inside a snapshot, because a
    # closed window would end voter-b's chance to vote — and the refusal is
    # graded as QuorumNotReached at a chain time where nothing else can produce
    # it.
    if (( now <= deadline )); then
      snap="$(snapshot_take)"
      # Re-read the clock inside the snapshot: an Anvil on --block-time 1 keeps
      # mining, so the target has to be ahead of where the chain is NOW, and
      # past the deadline either way.
      now="$(chain_time)"
      probe_at=$(( deadline + 1 ))
      (( probe_at > now )) || probe_at=$(( now + 1 ))
      mine_one_at "$probe_at"
    else
      probe_at="$now"
      snap=""
    fi
    exec_out="$(assert_call_reverts "execute($pid) with $votes_mid of $quorum votes at closed-window chain time $probe_at" \
                 "$expected_sig" "$voter_a" "$governance" "$EXECUTE_SIG" "$pid")" || probe_rc=$?
    # The snapshot goes back whatever the probe said, so a failed assertion does
    # not also leave the chain past the deadline.
    [[ -z "$snap" ]] || snapshot_restore "$snap"
    (( probe_rc == 0 )) || exit "$probe_rc"
    IFS=$'\t' read -r exec_error exec_matched exec_payload <<<"$exec_out"
    now_back="$(chain_time)"
    if [[ -n "$snap" ]]; then
      (( now_back <= deadline )) \
        || die "evm_revert left chain time $now_back past the voting deadline $deadline of proposal $pid: voter-b can no longer vote, so the run stops rather than defeating the proposal it was told to carry" 1
    fi
    info "one vote ($votes_mid of $quorum) cannot execute proposal $pid once voting closes: $exec_error (probed at chain time $probe_at, chain back at $now_back)"
    insufficient_json="$(jq -n --argjson votes "$votes_mid" --argjson quorum "$quorum" \
      --arg err "$exec_error" --arg matched "$exec_matched" --arg payload "$exec_payload" \
      --argjson now "$now_back" --argjson probe "$probe_at" --argjson deadline "$deadline" \
      --argjson rolled "$(if [[ -n "$snap" ]]; then echo true; else echo false; fi)" \
      '{asserted:true, votes_for_at_check:$votes, quorum:$quorum, expected_error:$err,
        matched_by:$matched, revert_data:$payload, chain_time:$now, probe_chain_time:$probe,
        voting_deadline:$deadline, window:"closed", rolled_back:$rolled}')"
  else
    # A rerun where both voters already voted. Saying so beats claiming a proof
    # that the chain state can no longer support.
    info "proposal $pid already holds $votes_mid of $quorum votes; the one-vote-is-insufficient clause is not claimed"
    insufficient_json="$(jq -n --argjson votes "$votes_mid" --argjson quorum "$quorum" \
      '{asserted:false, votes_for_at_check:$votes, quorum:$quorum,
        reason:"both votes were already on chain before this run, so a single-vote execute could not be tested"}')"
  fi

  # ── 5. voter-b votes, unless an earlier run already spent its vote ────────
  local b_voted b_outcome tx_b="" vote_cast_b=null voter_b_json
  b_voted="$(call "$governance" 'hasVoted(uint256,address)(bool)' "$pid" "$voter_b")"
  if [[ "$b_voted" == "true" ]]; then
    b_outcome="already_voted"
    info "voter-b $voter_b already voted on proposal $pid; sending nothing"
  else
    now="$(chain_time)"
    (( now <= deadline )) \
      || die "the voting window on proposal $pid closed at $deadline (chain time $now) with $votes_mid of $quorum votes: voter-b can no longer vote and the proposal is Defeated" 1
    b_outcome="voted"
    tx_b="$(send --keystore "$keydir/voter-b" --password-file "$keydir/voter-b.pw" \
              "$governance" "$VOTE_SIG" "$pid")"
    vote_cast_b="$(decode_vote_cast "$tx_b" "$governance" "$pid" "$voter_b")" || exit $?
    info "voter-b $voter_b voted in $tx_b"
  fi
  voter_b_json="$(jq -n --arg addr "$voter_b" --arg outcome "$b_outcome" --arg tx "$tx_b" \
    --argjson cast "$vote_cast_b" \
    '{address:$addr, outcome:$outcome, tx:(if $tx == "" then null else $tx end), vote_cast:$cast}')"

  # G08: the router vector with the quorum now on chain. Voting is the last
  # thing that happens before execute, so this is the witness closest to it.
  record_weight_witness vote-b "$router" "$pid" || true
  witness_b="$WITNESS_RESULT"

  # ── 6. the tally now meets the proposal's own snapshot quorum ─────────────
  local votes_final quorum_final state_after state_after_name
  tally="$(proposal_tally "$governance")" || exit $?
  read -r deadline votes_final quorum_final <<<"$tally"
  (( votes_final >= quorum_final )) \
    || die "proposal $pid holds $votes_final of $quorum_final votes after both voters: quorum is not reached" 1
  state_after="$(read_proposal_state "$governance" "$pid")"
  state_after_name="$(proposal_state_name "$state_after")"
  info "proposal $pid tally $votes_final of $quorum_final; state $state_after_name"

  jq -n --arg gov "$governance" --arg pid "$pid" --argjson votes "$votes_final" \
    --argjson quorum "$quorum_final" --argjson deadline "$deadline" \
    --arg state "$state_after_name" --argjson a "$voter_a_json" --argjson b "$voter_b_json" \
    --arg neg_caller "$powerless" --arg neg_err "$neg_error" --arg neg_matched "$neg_matched" \
    --arg neg_payload "$neg_payload" --argjson insufficient "$insufficient_json" \
    --argjson wa "$witness_a" --argjson wb "$witness_b" \
    '{action:"voted_to_quorum", governance:$gov, proposal_id:$pid, votes_for:$votes,
      snapshot_quorum:$quorum, quorum_reached:($votes >= $quorum), voting_deadline:$deadline,
      proposal_state_after:$state,
      voter_a:$a, voter_b:$b,
      no_voting_power_control:{caller:$neg_caller, expected_error:"NoVotingPower",
                               observed_error:$neg_err, matched_by:$neg_matched,
                               revert_data:$neg_payload},
      one_vote_insufficient:$insufficient,
      weight_witness:{vote_a:$wa, vote_b:$wb}}'
}

# ─── governance execute ──────────────────────────────────────────────────────
# Names, never hand-copied selectors, so a contract rename breaks this loudly.
PROPOSAL_EXECUTED_SIG='ProposalExecuted(uint256,address)'
WEIGHTS_APPLIED_SIG='WeightsApplied(uint256,address[],uint256[])'
EXECUTION_DELAY_NOT_ELAPSED_SIG='ExecutionDelayNotElapsed()'
ALREADY_EXECUTED_SIG='AlreadyExecuted()'
GET_EFFECTIVE_WEIGHTS_SIG='getEffectiveWeights()(address[],uint256[])'

# The one vector this transition is allowed to end on, keyed by the record's
# vault_addresses. G08 grades it PER VAULT and exactly: 10000 bps is reachable by
# vectors that are not this one, so nothing on the execute path ever adds a sum
# and calls it a match.
CANONICAL_WEIGHTS='rmAGENT 833
rmUSDC 8167
rmPROTO 667
rmRWA 333'

# `<address>\t<bps>` lines as a JSON array of {vault, bps}.
pairs_json() {
  awk -F'\t' 'NF { print $1; print $2 }' <<<"$1" \
    | jq -Rn '[inputs] as $a | [range(0; ($a | length); 2) | {vault: $a[.], bps: ($a[. + 1] | tonumber)}]'
}

# weight_must_be <label> <pairs> <vault> <expected-bps>: exact per-vault equality
# or the ceremony stops. An absent vault fails here rather than reading as 0.
weight_must_be() {
  local label="$1" pairs="$2" vault="$3" want="$4" got
  got="$(weight_lookup "$pairs" "$vault")" || exit $?
  [[ -n "$got" ]] || die "$label does not name vault $vault at all, so its weight is not $want" 1
  [[ "$got" =~ ^[0-9]+$ ]] || die "$label gives vault $vault a non-numeric bps '$got'" 1
  [[ "$got" == "$want" ]] || die "$label gives vault $vault $got bps, not the canonical $want" 1
  printf '%s' "$got"
}

# The canonical vector asserted against both router views and, when a receipt
# vector is passed, against the event the transition emitted. Prints the
# per-vault JSON array on success.
assert_canonical_weights() {
  local voted="$1" effective="$2" event="${3:-}"
  local key want vault v_bps e_bps ev_bps out='[]'
  while read -r key want; do
    [[ -n "$key" ]] || continue
    vault="$(rec ".vault_addresses.$key")"
    is_address "$vault" || die "record carries no address for vault $key" 65
    v_bps="$(weight_must_be "router getWeights()" "$voted" "$vault" "$want")" || exit $?
    e_bps="$(weight_must_be "router getEffectiveWeights()" "$effective" "$vault" "$want")" || exit $?
    ev_bps=null
    if [[ -n "$event" ]]; then
      ev_bps="$(weight_must_be "the WeightsApplied receipt" "$event" "$vault" "$want")" || exit $?
    fi
    out="$(jq -cn --argjson acc "$out" --arg k "$key" --arg vault "$vault" \
      --argjson want "$want" --argjson voted "$v_bps" --argjson eff "$e_bps" --argjson ev "$ev_bps" \
      '$acc + [{vault_key:$k, vault:$vault, expected_bps:$want, router_bps:$voted,
                effective_bps:$eff, weights_applied_bps:$ev}]')"
  done <<<"$CANONICAL_WEIGHTS"
  printf '%s' "$out"
}

# The last log at <address> whose topic0 is <topic>, out of a `cast receipt --json`.
receipt_log() {
  jq -c --arg addr "$(lower "$2")" --arg topic "$3" \
    '[.logs[]? | select((.address | ascii_downcase) == $addr and ((.topics[0] // "") | ascii_downcase) == $topic)] | last // empty' \
    <<<"$1"
}

# execute(uint256) carries no role guard at all, so this sends from voter-a: a
# key that holds no role anywhere. The transition it drives is the one G08 grades
# as the only thing that may change PortfolioRouter weights, so the action
# witnesses the vector going in, proves the too-early refusal BEFORE it touches
# the clock, and then grades the applied vector per vault against the receipt.
execute_governance() {
  [[ -f "$RECORD" ]] || die "record not found: $RECORD" 65
  local governance router keydir executor acct
  governance="$(rec .addresses.governance)"; router="$(rec .addresses.router)"
  keydir="$(rec .ephemeral.keystore_dir)"; executor="$(rec '.ephemeral.voters[0]')"
  for acct in "$governance" "$router" "$executor"; do
    is_address "$acct" || die "record carries a non-address where the execute path needs one: '$acct'" 65
  done
  require_contract "$governance" governance
  require_contract "$router" router
  [[ -f "$keydir/voter-a" && -f "$keydir/voter-a.pw" ]] \
    || die "voter-a keystore is gone (discarded?): $keydir" 65

  # ── 1. the witness: the router vector going in, and the proposal id ───────
  # Read before anything is asserted, sent or jumped, so the result carries the
  # exact vector the transition started from.
  local pid_before voted_before effective_before
  pid_before="$(call "$governance" 'currentProposalId()(uint256)')"
  [[ "$pid_before" =~ ^[0-9]+$ ]] || die "could not read currentProposalId() from governance $governance"
  [[ "$pid_before" != "0" ]] \
    || die "governance $governance holds no proposal (currentProposalId is 0): run \`fusion-ceremony.sh propose\` and \`vote\` first" 65
  voted_before="$(router_weight_pairs "$router" "$GET_WEIGHTS_SIG")" || exit $?
  effective_before="$(router_weight_pairs "$router" "$GET_EFFECTIVE_WEIGHTS_SIG")" || exit $?

  local key want vault before_bps canonical_before=1
  while read -r key want; do
    [[ -n "$key" ]] || continue
    vault="$(rec ".vault_addresses.$key")"
    is_address "$vault" || die "record carries no address for vault $key" 65
    before_bps="$(weight_lookup "$voted_before" "$vault")" || exit $?
    [[ "$before_bps" == "$want" ]] || canonical_before=0
  done <<<"$CANONICAL_WEIGHTS"

  local state state_name
  state="$(read_proposal_state "$governance" "$pid_before")"
  state_name="$(proposal_state_name "$state")"
  info "proposal $pid_before is $state_name on $governance; router $router holds [$(tr '\n' ' ' <<<"$voted_before")]"

  # ── idempotent: an already-executed proposal is reported, never re-sent ───
  # The weights are still graded, and execute() is still shown to refuse, so a
  # rerun proves the end state rather than quietly skipping it.
  if [[ "$state" == "3" ]]; then
    local idem idem_err idem_matched idem_payload idem_json idem_unchanged
    idem="$(assert_call_reverts "execute($pid_before) on the already-executed proposal" \
             "$ALREADY_EXECUTED_SIG" "$executor" "$governance" "$EXECUTE_SIG" "$pid_before")" || exit $?
    IFS=$'\t' read -r idem_err idem_matched idem_payload <<<"$idem"
    idem_json="$(assert_canonical_weights "$voted_before" "$effective_before" "")" || exit $?
    # The transition already happened, so the vector on the router is the one it
    # applied and no witness can be compared against it any more. That is an
    # untested clause, and it is reported as one: an explicit false verdict, so a
    # reader grades it unproven instead of reading a pass into a rerun.
    idem_unchanged="$(jq -cn --arg pid "$pid_before" \
      '{asserted:false,
        reason:("proposal " + $pid + " was already executed before this run, so the router already carries the vector that transition applied and this run cannot witness the vector holding across propose and both votes")}')"
    info "proposal $pid_before was already executed; the canonical vector is live and execute() is refused: $idem_err"
    jq -n --arg gov "$governance" --arg router "$router" --arg pid "$pid_before" \
      --arg executor "$executor" --arg err "$idem_err" --arg matched "$idem_matched" \
      --arg payload "$idem_payload" --argjson weights "$idem_json" \
      --argjson before "$(pairs_json "$voted_before")" \
      --argjson before_eff "$(pairs_json "$effective_before")" \
      --argjson unchanged "$idem_unchanged" \
      '{action:"already_executed", governance:$gov, router:$router, proposal_id:$pid,
        executor:null, tx:null, proposal_state_before:"Executed", proposal_state_after:"Executed",
        weights_before:{voted:$before, effective:$before_eff},
        weights_after:$weights, weights_unchanged_until_execute:$unchanged,
        proposal_executed:null, weights_applied:null,
        already_executed_control:{caller:$executor, expected_error:"AlreadyExecuted",
                                  observed_error:$err, matched_by:$matched, revert_data:$payload}}'
    return 0
  fi

  # A router that already carries the canonical vector cannot be used to show
  # that THIS transition is what changed it.
  (( canonical_before == 0 )) \
    || die "router $router already carries the canonical vector before this execute: G08 grades this transition as the only thing that changes PortfolioRouter weights, and that claim cannot be made about weights already applied" 1

  # ── 1b. the G08 clause itself: the vector held across propose and the votes ─
  # Every witness propose and vote left on disk for THIS cycle, compared to each
  # other and to the reading above — before the clock is touched and long before
  # execute() is sent, so nothing this action does can be what kept them equal.
  # A disagreement dies inside grade_weight_witnesses; an absent witness comes
  # back as an explicit false verdict rather than as a pass.
  local live_fingerprint unchanged_json
  live_fingerprint="$(router_vector_fingerprint "$voted_before")" || exit $?
  unchanged_json="$(grade_weight_witnesses "$pid_before" "$live_fingerprint")" || exit $?

  local proposal stored_id deadline executable votes quorum n
  proposal="$("$CAST" call --rpc-url "$RPC_URL" "$governance" "$ACTIVE_PROPOSAL_SIG")" \
    || die "could not read activeProposal() from governance $governance"
  stored_id="$(sed -n '1p' <<<"$proposal" | awk '{print $1}')"
  deadline="$(sed -n '5p' <<<"$proposal" | awk '{print $1}')"
  executable="$(sed -n '6p' <<<"$proposal" | awk '{print $1}')"
  votes="$(sed -n '7p' <<<"$proposal" | awk '{print $1}')"
  quorum="$(sed -n '8p' <<<"$proposal" | awk '{print $1}')"
  for n in "$stored_id" "$deadline" "$executable" "$votes" "$quorum"; do
    [[ "$n" =~ ^[0-9]+$ ]] || die "activeProposal() on $governance returned a non-numeric field: '$n'" 1
  done
  [[ "$stored_id" == "$pid_before" ]] \
    || die "activeProposal() reports id $stored_id, not currentProposalId $pid_before" 1

  case "$state" in
    0|2) ;;
    1) die "proposal $pid_before is Defeated with $votes of $quorum votes: execute() reverts QuorumNotReached forever and no clock jump changes that" 1 ;;
    4) die "proposal $pid_before is Cancelled: it can never be executed" 1 ;;
    *) die "proposal $pid_before is $state_name: there is nothing to execute" 1 ;;
  esac
  (( votes >= quorum )) \
    || die "proposal $pid_before holds $votes of $quorum votes: it turns Defeated the moment voting closes, so run \`fusion-ceremony.sh vote\` first" 1

  # ── 2. NEGATIVE, before the clock moves at all ───────────────────────────
  # Which error is owed is dictated by the live state: VotingStillOpen while the
  # window is open, ExecutionDelayNotElapsed once it closes with quorum met and
  # the delay still running. A chain already past executableAfter cannot exercise
  # the too-early path, and an execute proved only against an elapsed delay would
  # say nothing about the delay, so that case stops the ceremony.
  local now_before expected_sig neg neg_err neg_matched neg_payload
  now_before="$(chain_time)"
  if (( now_before <= deadline )); then
    expected_sig="$VOTING_STILL_OPEN_SIG"
  elif (( now_before < executable )); then
    expected_sig="$EXECUTION_DELAY_NOT_ELAPSED_SIG"
  else
    die "chain time $now_before is already past executableAfter $executable before this action moved the clock: the too-early control cannot be exercised, and the execution delay would go unproven" 1
  fi
  neg="$(assert_call_reverts "execute($pid_before) at chain time $now_before" \
          "$expected_sig" "$executor" "$governance" "$EXECUTE_SIG" "$pid_before")" || exit $?
  IFS=$'\t' read -r neg_err neg_matched neg_payload <<<"$neg"
  info "execute($pid_before) is refused too early at chain time $now_before: $neg_err (matched by $neg_matched)"

  # ── 3. the clock, moved in the two steps the contract gates on ───────────
  local now state_queued
  if (( now_before <= deadline )); then
    jump_to "$(( deadline + 1 ))"
  fi
  state_queued="$(read_proposal_state "$governance" "$pid_before")"
  [[ "$state_queued" == "2" ]] \
    || die "proposal $pid_before is $(proposal_state_name "$state_queued") once voting closed, not Queued: quorum did not carry" 1
  now="$(chain_time)"
  if (( now < executable )); then
    jump_to "$(( executable + 1 ))"
  fi
  now="$(chain_time)"
  (( now >= executable )) \
    || die "chain time $now is still below executableAfter $executable after the jump" 1

  # ── 4. execute, sent by a key that holds no role anywhere ────────────────
  local tx
  tx="$(send --keystore "$keydir/voter-a" --password-file "$keydir/voter-a.pw" \
          "$governance" "$EXECUTE_SIG" "$pid_before")"
  info "execute($pid_before) mined in $tx from the unprivileged key $executor"

  local receipt_json pe_topic wa_topic pe_log wa_log
  receipt_json="$("$CAST" receipt --rpc-url "$RPC_URL" "$tx" --json)" \
    || die "could not fetch the execute receipt $tx"
  pe_topic="$(lower "$("$CAST" keccak "$PROPOSAL_EXECUTED_SIG")")"
  wa_topic="$(lower "$("$CAST" keccak "$WEIGHTS_APPLIED_SIG")")"
  pe_log="$(receipt_log "$receipt_json" "$governance" "$pe_topic")"
  wa_log="$(receipt_log "$receipt_json" "$governance" "$wa_topic")"
  [[ -n "$pe_log" ]] || die "execute receipt $tx carries no ProposalExecuted log from $governance" 1
  [[ -n "$wa_log" ]] || die "execute receipt $tx carries no WeightsApplied log from $governance" 1

  local pe_pid pe_executor pe_json
  pe_pid="$("$CAST" to-dec "$(jq -r '.topics[1]' <<<"$pe_log")")"
  pe_executor="$(jq -r '.topics[2]' <<<"$pe_log")"
  pe_executor="0x${pe_executor: -40}"
  [[ "$pe_pid" == "$pid_before" ]] || die "ProposalExecuted names proposal $pe_pid, not $pid_before" 1
  [[ "$(lower "$pe_executor")" == "$(lower "$executor")" ]] \
    || die "ProposalExecuted names executor $pe_executor, not the sender $executor" 1
  pe_json="$(jq -n --arg pid "$pe_pid" --arg executor "$pe_executor" --arg tx "$tx" \
    '{event:"ProposalExecuted", proposal_id:$pid, executor:$executor, tx:$tx}')"

  local wa_pid wa_decoded wa_vaults wa_bps wa_pairs wa_count wa_json
  wa_pid="$("$CAST" to-dec "$(jq -r '.topics[1]' <<<"$wa_log")")"
  wa_decoded="$("$CAST" abi-decode 'WeightsApplied()(address[],uint256[])' "$(jq -r '.data' <<<"$wa_log")")" \
    || die "could not decode the WeightsApplied payload of $tx"
  wa_vaults="$(cast_array_lines "$(sed -n '1p' <<<"$wa_decoded")")"
  wa_bps="$(cast_array_lines "$(sed -n '2p' <<<"$wa_decoded")")"
  wa_pairs="$(zip_pairs "$wa_vaults" "$wa_bps" "WeightsApplied in $tx")" || exit $?
  wa_count="$(grep -c '[^[:space:]]' <<<"$wa_pairs" || true)"
  [[ "$wa_pid" == "$pid_before" ]] || die "WeightsApplied names proposal $wa_pid, not $pid_before" 1
  [[ "$wa_count" == "4" ]] \
    || die "WeightsApplied in $tx carries $wa_count legs, not the four canonical buckets" 1
  wa_json="$(jq -n --arg pid "$wa_pid" --arg tx "$tx" \
    --argjson vaults "$(json_str_array <<<"$wa_vaults")" \
    --argjson bps "$(json_num_array <<<"$wa_bps")" \
    '{event:"WeightsApplied", proposal_id:$pid, vaults:$vaults, bps:$bps, tx:$tx}')"

  # ── 5. the live router vector, per vault, against the receipt ────────────
  # Every bucket is compared on its own against the canonical value the receipt
  # also has to carry. No sum is ever taken: 10000 bps is reachable by vectors
  # that are not this one.
  local voted_after effective_after voted_count after_json
  voted_after="$(router_weight_pairs "$router" "$GET_WEIGHTS_SIG")" || exit $?
  effective_after="$(router_weight_pairs "$router" "$GET_EFFECTIVE_WEIGHTS_SIG")" || exit $?
  voted_count="$(grep -c '[^[:space:]]' <<<"$voted_after" || true)"
  [[ "$voted_count" == "4" ]] \
    || die "router $router weights $voted_count vaults after execute, not the four canonical buckets" 1
  after_json="$(assert_canonical_weights "$voted_after" "$effective_after" "$wa_pairs")" || exit $?

  local pid_after state_after state_after_name
  pid_after="$(call "$governance" 'currentProposalId()(uint256)')"
  [[ "$pid_after" == "$pid_before" ]] \
    || die "currentProposalId moved $pid_before -> $pid_after across execute(): execute applies weights, it never creates a proposal" 1
  state_after="$(read_proposal_state "$governance" "$pid_before")"
  state_after_name="$(proposal_state_name "$state_after")"
  [[ "$state_after" == "3" ]] \
    || die "proposal $pid_before is $state_after_name after execute, not Executed" 1
  info "proposal $pid_before is $state_after_name; router $router now weights four buckets 833/8167/667/333 bps"

  jq -n --arg gov "$governance" --arg router "$router" --arg pid "$pid_before" \
    --arg tx "$tx" --arg executor "$executor" --arg state_before "$state_name" \
    --arg neg_expected "${expected_sig%%(*}" --arg neg_err "$neg_err" \
    --arg neg_matched "$neg_matched" --arg neg_payload "$neg_payload" \
    --argjson now_before "$now_before" --argjson deadline "$deadline" \
    --argjson executable "$executable" --argjson now "$now" \
    --argjson votes "$votes" --argjson quorum "$quorum" \
    --argjson before "$(pairs_json "$voted_before")" \
    --argjson before_eff "$(pairs_json "$effective_before")" \
    --argjson after "$after_json" --argjson pe "$pe_json" --argjson wa "$wa_json" \
    --argjson unchanged "$unchanged_json" \
    '{action:"executed", governance:$gov, router:$router, proposal_id:$pid,
      executor:$executor, tx:$tx,
      proposal_state_before:$state_before, proposal_state_after:"Executed",
      votes_for:$votes, snapshot_quorum:$quorum,
      weights_before:{voted:$before, effective:$before_eff},
      weights_after:$after,
      weights_unchanged_until_execute:$unchanged,
      proposal_executed:$pe, weights_applied:$wa,
      too_early_control:{caller:$executor, expected_error:$neg_expected, observed_error:$neg_err,
                         matched_by:$neg_matched, revert_data:$neg_payload,
                         chain_time_at_check:$now_before},
      timing:{chain_time_at_check:$now_before, voting_deadline:$deadline,
              executable_after:$executable, chain_time_at_execute:$now}}'
}

# ─── ensure ──────────────────────────────────────────────────────────────────
# A devnet reboot redeploys the base stack at the same deterministic addresses
# but takes the ceremony with it: the Safe and the TimelockController are gone,
# the ephemeral keys hold no gas, and nothing is anchored. The record left on
# disk still looks plausible, so every downstream step fails as an unrelated
# authorization error instead of as a missing environment. These are the
# preconditions `run` establishes and a reboot destroys; anything subtler is
# drift for `verify` to grade, not a reason to redeploy.
ceremony_is_live() {
  local timelock safe keydir who
  [[ -f "$RECORD" ]] || { info "no record at $RECORD"; return 1; }
  jq -e . "$RECORD" >/dev/null 2>&1 || { info "record is not readable json: $RECORD"; return 1; }
  [[ "$(rec .chain_id)" == "$("$CAST" chain-id --rpc-url "$RPC_URL")" ]] \
    || { info "record is for chain $(rec .chain_id), not this one"; return 1; }
  timelock="$(rec .addresses.timelock)"; safe="$(rec .addresses.safe)"
  has_code "$timelock" || { info "timelock $timelock has no code on this chain"; return 1; }
  has_code "$safe" || { info "safe $safe has no code on this chain"; return 1; }
  keydir="$(rec .ephemeral.keystore_dir)"
  # A record from before issue #1447 names a single-key stand-in and no Safe
  # signers; it can never drive a real Safe, so it is re-provisioned.
  [[ "$(jq '.ephemeral.safe_signers // [] | length' "$RECORD")" -ge "$SAFE_THRESHOLD" ]] \
    || { info "record names no Safe signer set (it predates the real Safe)"; return 1; }
  for who in $(jq -r '.ephemeral.safe_signers[].role' "$RECORD"); do
    [[ -f "$keydir/$who" ]] || { info "safe signer $who keystore is gone: $keydir"; return 1; }
  done
  for who in submitter approver; do
    [[ -f "$keydir/$who" ]] || { info "$who keystore is gone: $keydir"; return 1; }
    [[ "$("$CAST" balance "$(rec ".ephemeral.$who")" --rpc-url "$RPC_URL" 2>/dev/null)" != "0" ]] \
      || { info "$who holds no gas on this chain"; return 1; }
  done
  return 0
}

ensure_ceremony() {
  RECORD="${RECORD:-$OUT_DIR/fusion-stage-record.json}"
  if ceremony_is_live; then
    info "ceremony is live on this chain; provisioning nothing"
    verify_record
    return
  fi
  info "provisioning a fresh ceremony against the live chain"
  run_ceremony
}

case "$ACTION" in
  run) run_ceremony ;;
  ensure) ensure_ceremony ;;
  verify) [[ -n "$RECORD" ]] || usage; verify_record ;;
  release) [[ -n "$RECORD" ]] || usage; release_receipt ;;
  propose) [[ -n "$RECORD" ]] || usage; propose_governance ;;
  propose-negative) [[ -n "$RECORD" ]] || usage; propose_negative ;;
  vote) [[ -n "$RECORD" ]] || usage; vote_governance ;;
  execute) [[ -n "$RECORD" ]] || usage; execute_governance ;;
  discard) [[ -n "$RECORD" ]] || usage; discard_keys ;;
  handover-vaults) [[ -n "$RECORD" ]] || usage; handover_vaults; verify_record ;;
  *) usage ;;
esac
