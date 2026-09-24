#!/usr/bin/env bash
# Offline self-test for scripts/stage/fusion-ceremony.sh `verify` (C-21: a gate
# is not evidence until it has been shown to fail). A fake `cast` answers every
# chain read from a state table; the baseline topology must pass, and each
# single broken fact must make `verify` exit 1 naming that fact.
#
# The same fake `cast` also plays a minimal stateful chain for `propose`,
# `propose-negative`, `vote`, `execute` and the `jump_to` helper they all use:
# `send` mutates a proposal/timelock-operation table the way the real
# contracts would (currentProposalId, hasVoted, applied weights, timelock
# operation timestamps), and `call` answers eth_call negative controls with
# the exact custom error the live state owes. `rpc` answers
# anvil_setNextBlockTimestamp / evm_mine so `jump_to` can fast-forward it, and
# can be told to refuse them so the die-if-not-anvil path is exercised too.
#
# The Safe is played as a real 2-of-3 would behave (issue #1447): `wallet sign`
# returns a signature that names its signer and the digest it signed, and
# `execTransaction` refuses too few signatures (GS020), a signature over the
# wrong digest or from a non-owner, or signers not strictly ascending (GS026),
# before it forwards anything to the timelock. The ceremony therefore only
# passes if it collects `threshold` distinct owner signatures over the digest
# the Safe itself reports, packed in the order the Safe demands.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CEREMONY="$HERE/../fusion-ceremony.sh"
REAL_CAST="$(command -v cast)" || { echo "selftest needs foundry's cast for keccak" >&2; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

a() { printf '0x%040x' "$1"; }
GATEWAY=$(a 1); ROUTER=$(a 2); GOVERNANCE=$(a 3); RECEIPT=$(a 4); IC=$(a 5); TIMELOCK=$(a 6)
SAFE=$(a 7); REGISTRY=$(a 8); VAULT=$(a 9); DEPLOYER=$(a 10); SUBMITTER=$(a 11); APPROVER=$(a 12)
VOTER_A=$(a 13); VOTER_B=$(a 14); EMERGENCY=$(a 15)
# The Safe's other two owners. Record order is approver, approver-b, approver-c,
# but by address approver-c (0x..11) sorts before approver-b (0x..1001), so the
# ceremony only passes if it signs in address order, not record order.
APPROVER_B=$(a 4097); APPROVER_C=$(a 17)
VAULT_AGENT=$(a 20); VAULT_USDC=$(a 21); VAULT_PROTO=$(a 22); VAULT_RWA=$(a 23)
ADMIN=$("$REAL_CAST" keccak ADMIN_ROLE); AGENT=$("$REAL_CAST" keccak AGENT_ROLE)
COMMITTEE=$("$REAL_CAST" keccak COMMITTEE_AGENT_ROLE)
PROPOSER=$("$REAL_CAST" keccak PROPOSER_ROLE); EXECUTOR=$("$REAL_CAST" keccak EXECUTOR_ROLE)
HASH=0x$(printf 'ab%.0s' {1..32})
# The canonical SafeProxy v1.4.1 runtime code hash verify pins (R12).
SAFE_PROXY_HASH=0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c
SAFE_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99

# ─── the fake chain ──────────────────────────────────────────────────────────
# `verify` only ever reads, so the original fake cast was a pure table lookup.
# propose/vote/execute also SEND, so this fake now also mutates $FAKE_STATE the
# way the real contracts would: a proposal table (id, proposer, vaults, bps,
# deadline, executableAfter, votes, quorum, executed), a hasVoted table, a
# timelock-operation table keyed by the real hashOperation() formula (computed
# with the real cast, since it is pure keccak/abi.encode with no chain state
# of its own), and the router's applied weights. Everything pure (keccak,
# calldata, sig, abi-encode, abi-decode, to-dec) is delegated to the real cast.
cat >"$WORK/cast" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
VOTING_PERIOD=1000
EXEC_DELAY=500
state() { awk -F'\t' -v k="$1" '$1 == k { v = $2; f = 1 } END { if (f) print v; else exit 1 }' "$FAKE_STATE"; }
set_state() {
  grep -v -F "$1"$'\t' "$FAKE_STATE" >"$FAKE_STATE.new" 2>/dev/null || true
  printf '%s\t%s\n' "$1" "$2" >>"$FAKE_STATE.new"
  mv "$FAKE_STATE.new" "$FAKE_STATE"
}
lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
current_clock() { state clock || echo 0; }
next_tx() { local n; n="$(state txseq || echo 0)"; n=$((n + 1)); set_state txseq "$n"; printf '0x%064x' "$n"; }
emit_send_result() { printf '{"status":"0x1","transactionHash":"%s"}\n' "$1"; }
revert_send() { echo "fake cast: send reverted: $1" >&2; exit 1; }
pad_uint() { printf '0x%064x' "$1"; }
pad_addr() { printf '0x000000000000000000000000%s' "$(lower "${1#0x}")"; }
bracket_list() {
  local out="" tok first=1
  for tok in $1; do
    if (( first )); then out="$tok"; first=0; else out="$out,$tok"; fi
  done
  printf '[%s]' "$out"
}
paste_pairs() {
  local vaults="$1" bps="$2" v b out="" first=1
  local -a va=($vaults) ba=($bps)
  for ((i = 0; i < ${#va[@]}; i++)); do
    if (( first )); then out="${va[i]}:${ba[i]}"; first=0; else out="$out ${va[i]}:${ba[i]}"; fi
  done
  printf '%s' "$out"
}
hash_op() {
  "$REAL_CAST" keccak "$("$REAL_CAST" abi-encode 'f(address,uint256,bytes,bytes32,bytes32)' "$1" "$2" "$3" "$4" "$5")"
}
# selector -> custom-error revert, in the exact `data: "0x.."` shape the
# script's own revert_payload()/propose_negative parse out of `cast call`.
revert_with() {
  local sig="$1"; shift
  local sel body types
  sel="$("$REAL_CAST" sig "$sig")"
  if (( $# > 0 )); then
    types="${sig#*(}"; types="${types%)}"
    body="$("$REAL_CAST" abi-encode "f($types)" "$@")"; body="${body#0x}"
  else
    body=""
  fi
  echo "Error: execution reverted, data: \"${sel}${body}\"" >&2
  exit 1
}
proposal_state_of() {
  local pid="$1" executed deadline votes quorum now
  executed="$(state "proposal:$pid:executed" || echo false)"
  if [[ "$executed" == "true" ]]; then echo 3; return; fi
  deadline="$(state "proposal:$pid:deadline" || echo 0)"
  votes="$(state "proposal:$pid:votes" || echo 0)"
  quorum="$(state "proposal:$pid:quorum" || echo 0)"
  now="$(current_clock)"
  if (( now <= deadline )); then echo 0; return; fi
  if (( votes >= quorum )); then echo 2; else echo 1; fi
}
print_active_proposal() {
  local pid vaults bps deadline executable votes quorum executed proposer
  pid="$(state proposalid || echo 0)"
  proposer="$(state "proposal:$pid:proposer" || echo 0x0000000000000000000000000000000000000000)"
  vaults="$(bracket_list "$(state "proposal:$pid:vaults" || echo '')")"
  bps="$(bracket_list "$(state "proposal:$pid:bps" || echo '')")"
  deadline="$(state "proposal:$pid:deadline" || echo 0)"
  executable="$(state "proposal:$pid:executable" || echo 0)"
  votes="$(state "proposal:$pid:votes" || echo 0)"
  quorum="$(state "proposal:$pid:quorum" || echo 0)"
  executed="$(state "proposal:$pid:executed" || echo false)"
  printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
    "$pid" "$proposer" "$vaults" "$bps" "$deadline" "$executable" "$votes" "$quorum" "$executed" false
}
print_weight_pairs() {
  local raw addrs="" bpsl="" pair v b first=1
  raw="$(state "weights:$1" || echo '')"
  for pair in $raw; do
    v="${pair%%:*}"; b="${pair##*:}"
    if (( first )); then addrs="$v"; bpsl="$b"; first=0; else addrs="$addrs, $v"; bpsl="$bpsl, $b"; fi
  done
  printf '[%s]\n[%s]\n' "$addrs" "$bpsl"
}
op_flag() {
  local op ts done_
  op="$(lower "$1")"
  ts="$(state "timelockop:$op:ts" || echo 0)"
  done_="$(state "timelockop:$op:done" || echo false)"
  case "$2" in
    is_operation) [[ "$ts" != "0" ]] && echo true || echo false ;;
    is_done) echo "$done_" ;;
    is_ready)
      if [[ "$done_" == "true" || "$ts" == "0" ]]; then echo false
      elif (( $(current_clock) >= ts )); then echo true
      else echo false; fi ;;
  esac
}
vote_call_check() {
  local power; power="$(state "power:$(lower "${1:-}")" || echo 0)"
  [[ "$power" != "0" ]] || revert_with 'NoVotingPower()'
  echo true
}
execute_call_check() {
  local pid="$1" executed now deadline exec_after votes quorum
  # `never_reverts_execute`: a governance whose execute() refuses nothing at all,
  # so the too-early control has something real to catch.
  [[ "$(state never_reverts_execute || echo false)" != "true" ]] || { echo true; return; }
  executed="$(state "proposal:$pid:executed" || echo false)"
  [[ "$executed" != "true" ]] || revert_with 'AlreadyExecuted()'
  now="$(current_clock)"
  deadline="$(state "proposal:$pid:deadline" || echo 0)"
  exec_after="$(state "proposal:$pid:executable" || echo 0)"
  votes="$(state "proposal:$pid:votes" || echo 0)"
  quorum="$(state "proposal:$pid:quorum" || echo 0)"
  (( now > deadline )) || revert_with 'VotingStillOpen()'
  # `no_quorum_rule`: a governance that never enforces the tally. The one-vote
  # control must refuse such a chain instead of reporting a proof.
  if [[ "$(state no_quorum_rule || echo false)" != "true" ]]; then
    (( votes >= quorum )) || revert_with 'QuorumNotReached()'
  fi
  (( now >= exec_after )) || revert_with 'ExecutionDelayNotElapsed()'
  echo true
}
handle_raw_data_call() {
  local from="$1" admin_role
  admin_role="$("$REAL_CAST" keccak 'ADMIN_ROLE')"
  revert_with 'AccessControlUnauthorizedAccount(address,bytes32)' "$from" "$admin_role"
}
do_propose() {
  local governance="$1" calldata="$2" proposer="$3" body decoded vaults bps
  body="0x${calldata:10}"
  decoded="$("$REAL_CAST" abi-decode --input 'propose(address[],uint256[])' "$body")"
  vaults="$(tr -d '[]' <<<"$(sed -n '1p' <<<"$decoded")" | tr ',' '\n' | awk 'NF{print tolower($1)}' | tr '\n' ' ')"
  bps="$(tr -d '[]' <<<"$(sed -n '2p' <<<"$decoded")" | tr ',' '\n' | awk 'NF{print $1}' | tr '\n' ' ')"
  vaults="${vaults% }"; bps="${bps% }"
  local pid_before pid now quorum deadline executable
  pid_before="$(state proposalid || echo 0)"; pid=$((pid_before + 1))
  now="$(current_clock)"; quorum="$(state quorum || echo 0)"
  deadline=$((now + VOTING_PERIOD)); executable=$((deadline + EXEC_DELAY))
  # `impersonate_proposer`, when set, makes the STORED proposal (but not the
  # ProposalCreated event below) claim a different proposer than the timelock
  # that actually drove this call — a corruption no correctly wired contract
  # would produce, but exactly what propose_governance's own
  # proposer-must-be-the-timelock assertion exists to catch.
  local stored_proposer; stored_proposer="$(state impersonate_proposer || echo "$proposer")"
  set_state proposalid "$pid"
  set_state "proposal:$pid:proposer" "$(lower "$stored_proposer")"
  set_state "proposal:$pid:vaults" "$vaults"
  set_state "proposal:$pid:bps" "$bps"
  set_state "proposal:$pid:deadline" "$deadline"
  set_state "proposal:$pid:executable" "$executable"
  set_state "proposal:$pid:votes" "0"
  set_state "proposal:$pid:quorum" "$quorum"
  set_state "proposal:$pid:executed" "false"
  local topic0 t1 t2 evdata log tx
  topic0="$(lower "$("$REAL_CAST" keccak 'ProposalCreated(uint256,address,address[],uint256[],uint64)')")"
  t1="$(pad_uint "$pid")"; t2="$(pad_addr "$proposer")"
  evdata="$("$REAL_CAST" abi-encode 'f(address[],uint256[],uint64)' "$(bracket_list "$vaults")" "$(bracket_list "$bps")" "$deadline")"
  log="$(jq -n --arg addr "$(lower "$governance")" --arg t0 "$topic0" --arg t1 "$t1" --arg t2 "$t2" --arg data "$evdata" \
    '{address:$addr, topics:[$t0,$t1,$t2], data:$data}')"
  tx="$(next_tx)"
  set_state "receiptlogs:$(lower "$tx")" "$(jq -c -n --argjson l "$log" '[$l]')"
  emit_send_result "$tx"
}
safe_digest() {
  # The fake's SafeTx digest: pure keccak over (to, data, nonce), so the digest
  # getTransactionHash reports and the one execTransaction checks agree.
  local to="$1" data="$2" nonce="$3"
  "$REAL_CAST" keccak "$("$REAL_CAST" abi-encode 'f(address,uint256,bytes,uint256)' "$to" 0 "$data" "$nonce")"
}
safe_revert() {
  # The Safe's own revert string, the way `cast send` / `cast call` report it.
  echo "Error: server returned an error response: error code 3: execution reverted: $1" >&2
  exit 1
}
check_safe_signatures() {
  # check_safe_signatures <safe> <to> <data> <sigs>: Safe.checkSignatures,
  # ECDSA branch only, with the fake signature layout r=signer, s=digest.
  local safe; safe="$(lower "$1")"
  local to="$2" data="$3" sigs="${4#0x}" threshold nonce digest owners i chunk signer signed last=""
  threshold="$(state "threshold:$safe" || echo 2)"
  nonce="$(state "safenonce:$safe" || echo 0)"
  digest="$(lower "$(safe_digest "$to" "$data" "$nonce")")"
  owners=" $(state "owners:$safe" || true) "
  (( ${#sigs} >= threshold * 130 )) || safe_revert GS020
  for (( i = 0; i < threshold; i++ )); do
    chunk="${sigs:$((i * 130)):130}"
    signer="0x${chunk:24:40}"; signed="0x${chunk:64:64}"
    [[ "$(lower "$signed")" == "$digest" ]] || safe_revert GS026
    # `safe_accepts_non_owners` / `safe_accepts_duplicates`: a Safe whose
    # owner or ordering check is broken, for verify's GS026 controls to catch.
    [[ "$owners" == *" $(lower "$signer") "* || "$(state safe_accepts_non_owners || echo false)" == true ]] \
      || safe_revert GS026
    if ! [[ "$(lower "$signer")" == "$last" && "$(state safe_accepts_duplicates || echo false)" == true ]]; then
      [[ -z "$last" || "$(lower "$signer")" > "$last" ]] || safe_revert GS026
    fi
    last="$(lower "$signer")"
  done
}
handle_exec_transaction() {
  local safe="$1" to="$2" data="$3" sigs="$4" n
  [[ "$(state safe_accepts_anything || echo false)" == "true" ]] || check_safe_signatures "$safe" "$to" "$data" "$sigs"
  n="$(state "safenonce:$(lower "$safe")" || echo 0)"
  set_state "safenonce:$(lower "$safe")" "$((n + 1))"
  handle_safe_exec "$to" "$data"
}
handle_safe_exec() {
  local timelock="$1" calldata="$2" sel schedule_sel execute_sel body
  sel="$(lower "${calldata:0:10}")"
  schedule_sel="$(lower "$("$REAL_CAST" sig 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)')")"
  execute_sel="$(lower "$("$REAL_CAST" sig 'execute(address,uint256,bytes,bytes32,bytes32)')")"
  body="0x${calldata:10}"
  if [[ "$sel" == "$schedule_sel" ]]; then
    local out tgt val data pred salt delay op ts
    mapfile -t out < <("$REAL_CAST" abi-decode --input 'schedule(address,uint256,bytes,bytes32,bytes32,uint256)' "$body")
    tgt="${out[0]}"; val="${out[1]%% *}"; data="${out[2]}"; pred="${out[3]}"; salt="${out[4]}"; delay="${out[5]%% *}"
    op="$(lower "$(hash_op "$tgt" "$val" "$data" "$pred" "$salt")")"
    ts=$(( $(current_clock) + delay ))
    set_state "timelockop:$op:ts" "$ts"
    set_state "timelockop:$op:done" "false"
    emit_send_result "$(next_tx)"
  elif [[ "$sel" == "$execute_sel" ]]; then
    local out tgt val data pred salt op ready done_ inner_sel propose_sel
    mapfile -t out < <("$REAL_CAST" abi-decode --input 'execute(address,uint256,bytes,bytes32,bytes32)' "$body")
    tgt="${out[0]}"; val="${out[1]%% *}"; data="${out[2]}"; pred="${out[3]}"; salt="${out[4]}"
    op="$(lower "$(hash_op "$tgt" "$val" "$data" "$pred" "$salt")")"
    ready="$(state "timelockop:$op:ts" || echo 0)"
    done_="$(state "timelockop:$op:done" || echo false)"
    [[ "$done_" != "true" ]] || revert_send "timelock operation $op already done"
    [[ "$ready" != "0" ]] && (( $(current_clock) >= ready )) || revert_send "timelock operation $op not ready"
    set_state "timelockop:$op:done" "true"
    inner_sel="$(lower "${data:0:10}")"
    propose_sel="$(lower "$("$REAL_CAST" sig 'propose(address[],uint256[])')")"
    local release_sel; release_sel="$(lower "$("$REAL_CAST" sig 'releaseReceipt(bytes32)')")"
    if [[ "$inner_sel" == "$propose_sel" ]]; then
      do_propose "$tgt" "$data" "$timelock"
    elif [[ "$inner_sel" == "$release_sel" ]]; then
      local rid
      rid="$(lower "$("$REAL_CAST" abi-decode --input 'releaseReceipt(bytes32)' "0x${data:10}" | head -1 | awk '{print $1}')")"
      set_state "released:$rid" true
      emit_send_result "$(next_tx)"
    else
      revert_send "unhandled inner selector $inner_sel on $tgt"
    fi
  else
    revert_send "unhandled timelock selector $sel"
  fi
}
handle_vote() {
  local governance="$1" pid="$2" voter="$3" power votes tx topic0 t1 t2 evdata log
  power="$(state "power:$(lower "$voter")" || echo 0)"
  [[ "$power" != "0" ]] || revert_send "NoVotingPower"
  [[ "$(state "voted:$pid:$(lower "$voter")" || echo false)" != "true" ]] || revert_send "AlreadyVoted"
  set_state "voted:$pid:$(lower "$voter")" "true"
  votes="$(state "proposal:$pid:votes" || echo 0)"; votes=$((votes + power))
  set_state "proposal:$pid:votes" "$votes"
  topic0="$(lower "$("$REAL_CAST" keccak 'VoteCast(uint256,address,uint256,uint256)')")"
  t1="$(pad_uint "$pid")"; t2="$(pad_addr "$voter")"
  evdata="$("$REAL_CAST" abi-encode 'f(uint256,uint256)' "$power" "$votes")"
  log="$(jq -n --arg addr "$(lower "$governance")" --arg t0 "$topic0" --arg t1 "$t1" --arg t2 "$t2" --arg data "$evdata" \
    '{address:$addr, topics:[$t0,$t1,$t2], data:$data}')"
  tx="$(next_tx)"
  set_state "receiptlogs:$(lower "$tx")" "$(jq -c -n --argjson l "$log" '[$l]')"
  emit_send_result "$tx"
}
handle_execute() {
  local governance="$1" pid="$2" caller="$3"
  local executed now deadline exec_after votes quorum vaults bps pairs tx
  executed="$(state "proposal:$pid:executed" || echo false)"
  [[ "$executed" != "true" ]] || revert_send "AlreadyExecuted"
  now="$(current_clock)"
  deadline="$(state "proposal:$pid:deadline" || echo 0)"
  exec_after="$(state "proposal:$pid:executable" || echo 0)"
  votes="$(state "proposal:$pid:votes" || echo 0)"
  quorum="$(state "proposal:$pid:quorum" || echo 0)"
  (( now > deadline )) || revert_send "VotingStillOpen"
  (( votes >= quorum )) || revert_send "QuorumNotReached"
  (( now >= exec_after )) || revert_send "ExecutionDelayNotElapsed"
  set_state "proposal:$pid:executed" "true"
  vaults="$(state "proposal:$pid:vaults" || echo '')"
  bps="$(state "proposal:$pid:bps" || echo '')"
  pairs="$(paste_pairs "$vaults" "$bps")"
  set_state "weights:voted" "$pairs"
  set_state "weights:effective" "$pairs"
  tx="$(next_tx)"
  local pe_topic pe_t1 pe_t2 pe_log wa_topic wa_t1 wa_data wa_log
  pe_topic="$(lower "$("$REAL_CAST" keccak 'ProposalExecuted(uint256,address)')")"
  pe_t1="$(pad_uint "$pid")"; pe_t2="$(pad_addr "$caller")"
  pe_log="$(jq -n --arg addr "$(lower "$governance")" --arg t0 "$pe_topic" --arg t1 "$pe_t1" --arg t2 "$pe_t2" \
    '{address:$addr, topics:[$t0,$t1,$t2], data:"0x"}')"
  wa_topic="$(lower "$("$REAL_CAST" keccak 'WeightsApplied(uint256,address[],uint256[])')")"
  wa_t1="$(pad_uint "$pid")"
  wa_data="$("$REAL_CAST" abi-encode 'f(address[],uint256[])' "$(bracket_list "$vaults")" "$(bracket_list "$bps")")"
  wa_log="$(jq -n --arg addr "$(lower "$governance")" --arg t0 "$wa_topic" --arg t1 "$wa_t1" --arg data "$wa_data" \
    '{address:$addr, topics:[$t0,$t1], data:$data}')"
  set_state "receiptlogs:$(lower "$tx")" "$(jq -c -n --argjson a "$pe_log" --argjson b "$wa_log" '[$a,$b]')"
  emit_send_result "$tx"
}

# `unreadable:<address>`: every read of that account fails, as an RPC that
# times out or a node that lost the account would.
unreadable() {
  [[ "$(state "unreadable:$(lower "$1")" || echo false)" != true ]] \
    || { echo "fake cast: request for $1 timed out" >&2; exit 1; }
}

pos=(); data=""; field=""; keystore=""; privkey=""
while (( $# )); do
  case "$1" in
    --rpc-url|--from|--from-block|--address) [[ "$1" == "--address" ]] && addr="$2"; [[ "$1" == "--from" ]] && from="$2"; shift 2 ;;
    --json) shift ;;
    --data) data="$2"; shift 2 ;;
    --field) field="$2"; shift 2 ;;
    --keystore) keystore="$2"; shift 2 ;;
    --password-file) shift 2 ;;
    --private-key) privkey="$2"; shift 2 ;;
    *) pos+=("$1"); shift ;;
  esac
done
[[ -n "$keystore" ]] && from="$(state "keystore:$(basename "$keystore")" || true)"
[[ -n "$privkey" ]] && from="$(state "privkey:$(lower "$privkey")" || true)"

case "${pos[0]}" in
  keccak|calldata|sig|abi-encode|abi-decode|to-dec) exec "$REAL_CAST" "${pos[@]}" ;;
  wallet)
    # `wallet new` is how `run` mints a key. No case here may reach it
    # unless it means to provision, so it leaves a mark and refuses.
    if [[ "${pos[1]:-}" == "new" ]]; then set_state wallet_new_called true; echo "fake cast: wallet new refused" >&2; exit 1; fi
    [[ "${pos[1]:-}" == "sign" ]] || { echo "fake cast: unhandled wallet ${pos[1]:-}" >&2; exit 1; }
    [[ " ${pos[*]} " == *" --no-hash "* ]] || { echo "fake cast: SafeTx digests must be signed --no-hash" >&2; exit 1; }
    [[ -n "${from:-}" ]] || { echo "fake cast: wallet sign with no known keystore" >&2; exit 1; }
    digest="${pos[${#pos[@]}-1]}"
    printf '0x000000000000000000000000%s%s1b\n' "$(lower "${from#0x}")" "$(lower "${digest#0x}")" ;;
  chain-id) state chain ;;
  block-number) state blocknum || echo 0 ;;
  codehash) unreadable "${pos[1]}"; state "codehash:$(lower "${pos[1]}")" || echo 0x00 ;;
  code) unreadable "${pos[1]}"; state "codehash:$(lower "${pos[1]}")" || echo 0x00 ;;
  balance) state "balance:$(lower "${pos[1]}")" || echo 0 ;;
  storage)
    unreadable "${pos[1]}"
    # A Safe proxy's slot 0 (masterCopy), its guard slot and its fallback
    # handler slot; anything else reads zero, as unwritten storage does.
    case "$(lower "${pos[2]:-0}")" in
      0|0x0) slotkey=singleton ;;
      0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8) slotkey=guard ;;
      0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5) slotkey=handler ;;
      *) slotkey=none ;;
    esac
    printf '0x000000000000000000000000%s\n' "$(lower "$(state "$slotkey:$(lower "${pos[1]}")" || echo 0x0000000000000000000000000000000000000000)" | sed 's/^0x//')" ;;
  block)
    [[ "$field" == "timestamp" ]] || { echo "fake cast: unhandled block field '$field'" >&2; exit 1; }
    current_clock ;;
  rpc)
    case "${pos[1]:-}" in
      eth_getLogs) state rpclogs || echo '[]' ;;
      anvil_setNextBlockTimestamp)
        [[ "$(state anvil_reject || echo false)" != "true" ]] || { echo "fake cast: rpc refused (chain is not anvil-backed)" >&2; exit 1; }
        set_state clock "${pos[2]}" ;;
      evm_mine)
        [[ "$(state anvil_reject || echo false)" != "true" ]] || { echo "fake cast: rpc refused (chain is not anvil-backed)" >&2; exit 1; }
        set_state blocknum "$(( $(state blocknum || echo 0) + 1 ))" ;;
      evm_snapshot)
        # A snapshot is the whole state table copied aside; evm_revert puts it
        # back, exactly as anvil restores state AND block time.
        [[ "$(state anvil_reject || echo false)" != "true" ]] || { echo "fake cast: rpc refused (chain is not anvil-backed)" >&2; exit 1; }
        n="$(state snapseq || echo 0)"; n=$((n + 1)); set_state snapseq "$n"
        cp "$FAKE_STATE" "$FAKE_STATE.snap.$n"
        printf '"0x%x"\n' "$n" ;;
      evm_revert)
        n="$("$REAL_CAST" to-dec "${pos[2]}" 2>/dev/null || echo "${pos[2]}")"
        if [[ -f "$FAKE_STATE.snap.$n" ]]; then
          cp "$FAKE_STATE.snap.$n" "$FAKE_STATE"; rm -f "$FAKE_STATE.snap.$n"; echo true
        else
          echo false
        fi ;;
      *) echo "fake cast: unhandled rpc method ${pos[1]:-}" >&2; exit 1 ;;
    esac ;;
  logs) key="logs:$(lower "$addr"):${pos[2]:-none}"
        accts="$(state "$key" || true)"
        printf '['; sep=""
        for x in $accts; do
          printf '%s{"topics":["0x%064x","%s","0x000000000000000000000000%s","0x%064x"]}' "$sep" 0 "${pos[2]:-0x00}" "${x#0x}" 0
          sep=","
        done
        printf ']\n' ;;
  receipt)
    tx="$(lower "${pos[1]}")"
    jq -n --argjson logs "$(state "receiptlogs:$tx" || echo '[]')" '{logs:$logs}' ;;
  call)
    c="$(lower "${pos[1]}")"; sig="${pos[2]:-}"
    unreadable "$c"
    if [[ -z "$sig" && -n "$data" ]]; then
      handle_raw_data_call "${from:-}"
    else
      case "$sig" in
        'hasRole(bytes32,address)(bool)') state "role:$c:${pos[3]}:$(lower "${pos[4]}")" || echo false ;;
        'quorumThreshold()(uint256)') state quorum ;;
        'totalVotingPower()(uint256)') state total ;;
        'votingPower(address)(uint256)') state "power:$(lower "${pos[3]}")" || echo 0 ;;
        'owner()(address)') state "owner:$c" ;;
        'nonce()(uint256)')
          [[ "$(state nonce_unreadable || echo false)" != true ]] || { echo "fake cast: nonce() timed out" >&2; exit 1; }
          state "safenonce:$c" || echo 0 ;;
        'getThreshold()(uint256)') state "threshold:$c" || echo 2 ;;
        'getModulesPaginated(address,uint256)(address[],address)')
          printf '[%s]\n0x0000000000000000000000000000000000000001\n' "$(state "modules:$c" || true)" ;;
        'getOwners()(address[])')
          owners_list="$(state "owners:$c" || true)"
          printf '[%s]\n' "$(tr ' ' '\n' <<<"$owners_list" | sed '/^$/d' | paste -sd, - | sed 's/,/, /g')" ;;
        'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)(bool)')
          [[ "$(state safe_accepts_anything || echo false)" == "true" ]] || check_safe_signatures "$c" "${pos[3]}" "${pos[5]}" "${pos[12]}"
          echo true ;;
        'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)')
          safe_digest "${pos[3]}" "${pos[5]}" "${pos[12]}" ;;
        'getMinDelay()(uint256)') state delay ;;
        'setWeights(address[],uint256[])') [[ "$(state "setweights:$(lower "${from:-}")" || echo revert)" == ok ]] ;;
        'isReleased(bytes32)(bool)') state "released:$(lower "${pos[3]}")" || echo false ;;
        'currentProposalId()(uint256)') state proposalid || echo 0 ;;
        'proposalState(uint256)(uint8)') proposal_state_of "${pos[3]}" ;;
        'hasVoted(uint256,address)(bool)') state "voted:${pos[3]}:$(lower "${pos[4]}")" || echo false ;;
        'activeProposal()(uint256,address,address[],uint256[],uint64,uint64,uint256,uint256,bool,bool)') print_active_proposal ;;
        'getWeights()(address[],uint256[])')
          # `getweights_fails`: a router read that times out, which is what the
          # witness has to survive without killing the action that took it.
          [[ "$(state getweights_fails || echo false)" != "true" ]] \
            || { echo "fake cast: getWeights() read failed" >&2; exit 1; }
          print_weight_pairs voted ;;
        'getEffectiveWeights()(address[],uint256[])') print_weight_pairs effective ;;
        'hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)') hash_op "${pos[3]}" "${pos[4]}" "${pos[5]}" "${pos[6]}" "${pos[7]}" ;;
        'isOperation(bytes32)(bool)') op_flag "${pos[3]}" is_operation ;;
        'isOperationReady(bytes32)(bool)') op_flag "${pos[3]}" is_ready ;;
        'isOperationDone(bytes32)(bool)') op_flag "${pos[3]}" is_done ;;
        'getTimestamp(bytes32)(uint256)') state "timelockop:$(lower "${pos[3]}"):ts" || echo 0 ;;
        'vote(uint256)') vote_call_check "${from:-}" ;;
        'execute(uint256)') execute_call_check "${pos[3]}" ;;
        *) echo "fake cast: unhandled call $sig" >&2; exit 1 ;;
      esac
    fi ;;
  send)
    target="${pos[1]}"; sig="${pos[2]}"
    case "$sig" in
      'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)')
        handle_exec_transaction "$target" "${pos[3]}" "${pos[5]}" "${pos[12]}" ;;
      'vote(uint256)') handle_vote "$target" "${pos[3]}" "${from:-}" ;;
      'execute(uint256)') handle_execute "$target" "${pos[3]}" "${from:-}" ;;
      *) echo "fake cast: unhandled send $sig" >&2; exit 1 ;;
    esac ;;
  *) echo "fake cast: unhandled ${pos[0]}" >&2; exit 1 ;;
esac
FAKE
chmod +x "$WORK/cast"

baseline() {
  local r
  {
    printf 'chain\t918453\nquorum\t2\ntotal\t2\ndelay\t120\n'
    printf 'owners:%s\t%s %s %s\n' "$(lc "$SAFE")" "$(lc "$APPROVER")" "$(lc "$APPROVER_B")" "$(lc "$APPROVER_C")"
    printf 'threshold:%s\t2\n' "$(lc "$SAFE")"
    printf 'singleton:%s\t%s\n' "$(lc "$SAFE")" "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"
    printf 'handler:%s\t%s\n' "$(lc "$SAFE")" "$SAFE_HANDLER"
    printf 'keystore:%s\t%s\n' approver "$APPROVER" approver-b "$APPROVER_B" approver-c "$APPROVER_C" \
      submitter "$SUBMITTER" voter-a "$VOTER_A"
    for r in "$GATEWAY" "$ROUTER" "$GOVERNANCE" "$RECEIPT" "$IC" "$TIMELOCK" "$REGISTRY" "$VAULT"; do
      printf 'codehash:%s\t%s\n' "$r" "$HASH"
    done
    printf 'codehash:%s\t%s\n' "$SAFE" "$SAFE_PROXY_HASH"
    printf 'balance:%s\t2000000000000000000\nbalance:%s\t2000000000000000000\n' "$SUBMITTER" "$APPROVER"
    printf 'role:%s:%s:%s\ttrue\n' "$GATEWAY" "$AGENT" "$SUBMITTER" "$IC" "$COMMITTEE" "$SUBMITTER" \
      "$ROUTER" "$ADMIN" "$GOVERNANCE" "$TIMELOCK" "$PROPOSER" "$SAFE" "$TIMELOCK" "$EXECUTOR" "$SAFE"
    for r in "$GATEWAY" "$ROUTER" "$GOVERNANCE" "$REGISTRY" "$VAULT" "$RECEIPT" "$IC"; do
      printf 'role:%s:%s:%s\ttrue\n' "$r" "$ADMIN" "$TIMELOCK"
    done
    printf 'logs:%s:%s\t%s\n' "$IC" "$COMMITTEE" "$SUBMITTER" "$GATEWAY" "$AGENT" "$SUBMITTER"
    printf 'logs:%s:none\t%s %s\n' "$GOVERNANCE" "$VOTER_A" "$VOTER_B"
    printf 'power:%s\t1\npower:%s\t1\n' "$VOTER_A" "$VOTER_B"
  } >"$WORK/state"
  jq -n --arg g "$GATEWAY" --arg r "$ROUTER" --arg gov "$GOVERNANCE" --arg rc "$RECEIPT" --arg ic "$IC" \
    --arg t "$TIMELOCK" --arg s "$SAFE" --arg reg "$REGISTRY" --arg v "$VAULT" --arg d "$DEPLOYER" \
    --arg sub "$SUBMITTER" --arg ap "$APPROVER" --arg va "$VOTER_A" --arg vb "$VOTER_B" --arg e "$EMERGENCY" --arg h "$HASH" \
    --arg apb "$APPROVER_B" --arg apc "$APPROVER_C" --arg keydir "$WORK/vkeys" --arg sh "$SAFE_PROXY_HASH" \
    '{chain_id: 918453, min_delay: 120, deployer: $d,
      addresses: {gateway: $g, router: $r, governance: $gov, consensus_receipt: $rc, ic_policy: $ic,
                  timelock: $t, safe: $s, registry: $reg, vault: $v, emergency: $e},
      code_hashes: {gateway: $h, router: $h, governance: $h, consensus_receipt: $h, ic_policy: $h,
                    timelock: $h, safe: $sh, registry: $h, vault: $h},
      vault_addresses: {rmUSDC: $v, rmPROTO: $v, rmAGENT: $v, rmRWA: $v},
      ephemeral: {submitter: $sub, approver: $ap, voters: [$va, $vb], emergency: $e, keystore_dir: $keydir,
                 safe_signers: [{role: "approver", address: $ap}, {role: "approver-b", address: $apb},
                                {role: "approver-c", address: $apc}]}}' >"$WORK/record.json"
  rm -rf "$WORK/vkeys"; mkdir -p "$WORK/vkeys"
  local role
  for role in approver approver-b approver-c submitter voter-a; do : >"$WORK/vkeys/$role"; : >"$WORK/vkeys/$role.pw"; done
}

lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
set_state() { grep -v -F "$1"$'\t' "$WORK/state" >"$WORK/state.new" || true; printf '%s\t%s\n' "$1" "$2" >>"$WORK/state.new"; mv "$WORK/state.new" "$WORK/state"; }

run_verify() {
  set +e
  FAKE_STATE="$WORK/state" REAL_CAST="$REAL_CAST" CAST="$WORK/cast" \
    "$CEREMONY" verify --record "$WORK/record.json" --rpc-url http://fake >"$WORK/out" 2>&1
  local rc=$?
  set -e
  return $rc
}

PASSED=0; FAILED=0
expect_ok() {
  baseline
  if run_verify; then PASSED=$((PASSED + 1)); echo "ok   baseline topology verifies"
  else FAILED=$((FAILED + 1)); echo "FAIL baseline topology did not verify"; grep FAIL "$WORK/out" | head; fi
}
expect_fail() {
  local name="$1" needle="$2"
  if run_verify; then
    FAILED=$((FAILED + 1)); echo "FAIL $name: verify exited 0"
  elif grep -q "^FAIL  .*$needle" "$WORK/out"; then
    PASSED=$((PASSED + 1)); echo "ok   $name is refused"
  else
    FAILED=$((FAILED + 1)); echo "FAIL $name: exited non-zero without naming '$needle'"; grep FAIL "$WORK/out" | head -3
  fi
}

# expect_summary <name> <rc>: verify's own tail line was printed and it exited
# exactly <rc>, so the run ended in verify's summary rather than in an abort.
expect_summary() {
  local name="$1" want="$2" rc=0
  run_verify || rc=$?
  if [[ "$rc" == "$want" ]] && grep -qE '^verify: ([0-9]+ assertion\(s\) failed|every assertion passed)' "$WORK/out"; then
    PASSED=$((PASSED + 1)); echo "ok   $name reaches verify's summary line (exit $rc)"
  else
    FAILED=$((FAILED + 1)); echo "FAIL $name: exit $rc, summary line $(grep -c '^verify: ' "$WORK/out") time(s)"; tail -3 "$WORK/out"
  fi
}

expect_ok

baseline; set_state "role:$(lc "$ROUTER"):$ADMIN:$(lc "$GOVERNANCE")" false
expect_fail "governance without router ADMIN_ROLE" "RouterGovernance holds router ADMIN_ROLE"

baseline; set_state "setweights:$(lc "$DEPLOYER")" ok
expect_fail "deployer still able to setWeights" "deployer EOA cannot call router.setWeights"

baseline; set_state quorum 1
expect_fail "placeholder quorum of 1" "quorumThreshold >= 2"

baseline; set_state "logs:$(lc "$IC"):$COMMITTEE" "$SUBMITTER $VOTER_A"; set_state "role:$(lc "$IC"):$COMMITTEE:$(lc "$VOTER_A")" true
expect_fail "a voter who is also a committee agent" "committee agents and non-zero voters are disjoint"

# governance-isomorphism.md §4.4: the Safe is graded from the Safe.
baseline; set_state "threshold:$(lc "$SAFE")" 1
expect_fail "a 1-of-3 Safe" "safe threshold is 2"
baseline; set_state "threshold:$(lc "$SAFE")" 1
expect_fail "a 1-of-3 Safe that one key can drive" "one owner signature cannot drive the safe"
baseline; set_state "owners:$(lc "$SAFE")" "$(lc "$APPROVER") $(lc "$APPROVER_B") $(lc "$DEPLOYER")"
expect_fail "a Safe whose owners are not the record's signers" "safe owners are exactly the record's signers"
baseline; set_state "singleton:$(lc "$SAFE")" "0x41675C099F32341bf84BFc5382aF534df5C7461a"
expect_fail "a Safe on the L1 singleton" "safe delegates to the SafeL2 singleton"
baseline; set_state safe_accepts_anything true
expect_fail "a Safe that executes on one signature (quorum configured, not enforced)" "one owner signature cannot drive the safe"
baseline; rm -f "$WORK/vkeys/approver-b"
expect_fail "signer keystores gone: quorum enforcement unproven, not assumed" "one owner signature cannot drive the safe"
baseline; set_state "owners:$(lc "$SAFE")" ""
expect_fail "a Safe with no readable owner set" "safe owners are exactly the record's signers"
baseline; jq --arg d "$DEPLOYER" '.ephemeral.safe_signers[2].address = $d' "$WORK/record.json" >"$WORK/r2" && mv "$WORK/r2" "$WORK/record.json"
expect_fail "the deployer reused as a Safe signer" "are distinct"

# R12 beyond the configuration: the code at the Safe address, its modules, its
# guard and its fallback handler are all read from chain, and a Safe that
# accepts a repeated or a non-owner signature is caught by its GS026 controls.
baseline; set_state "codehash:$(lc "$SAFE")" "$HASH"
jq --arg h "$HASH" '.code_hashes.safe = $h' "$WORK/record.json" >"$WORK/r2" && mv "$WORK/r2" "$WORK/record.json"
expect_fail "a fake Safe (not SafeProxy code) the record agrees with" "safe runtime code is the canonical SafeProxy v1.4.1"
baseline; set_state "modules:$(lc "$SAFE")" "$DEPLOYER"
expect_fail "a Safe with a module enabled" "safe has no modules enabled"
baseline; set_state "guard:$(lc "$SAFE")" "$DEPLOYER"
expect_fail "a Safe with a guard set" "safe has no guard set"
baseline; set_state "handler:$(lc "$SAFE")" "$DEPLOYER"
expect_fail "a Safe with a non-canonical fallback handler" "fallback handler is the canonical CompatibilityFallbackHandler"
baseline; set_state safe_accepts_duplicates true
expect_fail "a Safe that counts one owner's signature twice" "one owner's signature twice cannot drive the safe"
baseline; set_state safe_accepts_non_owners true
expect_fail "a Safe that counts non-owner signatures" "two non-owner signatures cannot drive the safe"
baseline; rm -f "$WORK/vkeys/voter-a.pw"
expect_fail "non-owner keystores gone: the non-owner control is unproven, not assumed" "two non-owner signatures cannot drive the safe"
# Item 2 of the #1447 review: an unreadable Safe is a list of FAIL lines and the
# summary, never a silent abort half way through verify.
baseline; set_state "unreadable:$(lc "$SAFE")" true
expect_fail "an unreadable Safe" "safe threshold is 2"
expect_summary "an unreadable Safe" 1
baseline; set_state nonce_unreadable true
expect_fail "a Safe whose nonce() cannot be read" "one owner signature cannot drive the safe (unproven: could not read nonce()"
expect_summary "a Safe whose nonce() cannot be read" 1

baseline; set_state "role:$(lc "$RECEIPT"):$ADMIN:$(lc "$DEPLOYER")" true
expect_fail "deployer keeping receipt ADMIN_ROLE" "deployer holds no ADMIN_ROLE on consensus_receipt"

baseline; jq --arg ap "$SUBMITTER" '.ephemeral.approver = $ap' "$WORK/record.json" >"$WORK/r2" && mv "$WORK/r2" "$WORK/record.json"
expect_fail "submitter reused as approver" "are distinct"

baseline; set_state "codehash:$(lc "$TIMELOCK")" 0xdead
expect_fail "timelock code hash drift" "code hash of timelock"

baseline; set_state "role:$(lc "$TIMELOCK"):$PROPOSER:$(lc "$SAFE")" false
expect_fail "timelock without the safe as proposer" "safe is the timelock proposer"

baseline; set_state rpclogs "[{\"address\":\"$VAULT\",\"topics\":[\"0x00\",\"$ADMIN\",\"0x00\"]}]"
set_state "role:$(lc "$VAULT"):$ADMIN:$(lc "$DEPLOYER")" true
expect_fail "deployer keeping a role on a contract outside the handover" "deployer EOA holds no role on any contract"

baseline; set_state rpclogs "[{\"address\":\"$VAULT\",\"topics\":[\"0x00\",\"$ADMIN\",\"0x00\"]}]"
if run_verify; then PASSED=$((PASSED + 1)); echo "ok   a role granted and later revoked is not a failure"
else FAILED=$((FAILED + 1)); echo "FAIL a revoked role was reported as held"; grep FAIL "$WORK/out" | head -3; fi

baseline; jq --arg rwa "$(a 16)" '.vault_addresses.rmRWA = $rwa' "$WORK/record.json" >"$WORK/r2" && mv "$WORK/r2" "$WORK/record.json"
expect_fail "a demo vault the timelock does not administer" "timelock holds ADMIN_ROLE on vault $(a 16)"

# ─── ensure ──────────────────────────────────────────────────────────────────
# ensure verifies a live ceremony and provisions only a FRESH chain. A chain
# whose recorded timelock/Safe still has code but whose ceremony cannot be
# driven (a keystore or password gone) must be refused with exit 65 and the
# reboot instruction, before a single key is minted.
run_ensure() {
  set +e
  FAKE_STATE="$WORK/state" REAL_CAST="$REAL_CAST" CAST="$WORK/cast" \
    "$CEREMONY" ensure --record "$WORK/record.json" --summary "$WORK/no-summary.log" \
    --out-dir "$WORK/ensure-out" --rpc-url http://fake >"$WORK/out" 2>&1
  local rc=$?
  set -e
  return $rc
}
ensure_refused() {
  local name="$1" rc=0
  rm -rf "$WORK/ensure-out"; mkdir -p "$WORK/ensure-out"
  run_ensure || rc=$?
  if [[ "$rc" == 65 ]] && grep -q "reboot the devnet (chain down/up)" "$WORK/out" \
     && ! grep -q '^wallet_new_called' "$WORK/state" && [[ ! -e "$WORK/ensure-out/keys" ]]; then
    PASSED=$((PASSED + 1)); echo "ok   ensure on $name is refused (exit 65, reboot the devnet, no key minted)"
  else
    FAILED=$((FAILED + 1)); echo "FAIL ensure on $name: exit $rc"; tail -3 "$WORK/out"
  fi
}

baseline
if run_ensure && grep -q "ceremony is live on this chain; provisioning nothing" "$WORK/out" \
   && grep -q "^verify: every assertion passed" "$WORK/out"; then
  PASSED=$((PASSED + 1)); echo "ok   ensure on a live ceremony provisions nothing and verifies"
else
  FAILED=$((FAILED + 1)); echo "FAIL ensure on a live ceremony"; tail -3 "$WORK/out"
fi
baseline; rm -f "$WORK/vkeys/submitter"
ensure_refused "a used chain (recorded timelock and Safe have code, submitter key gone)"
baseline; rm -f "$WORK/vkeys/approver-c"
ensure_refused "a used chain whose approver-c keystore is gone"
baseline; rm -f "$WORK/vkeys/approver-c.pw"
ensure_refused "a used chain whose approver-c password is gone"
baseline; rm -f "$WORK/vkeys/approver-c"; set_state "codehash:$(lc "$TIMELOCK")" 0x00
ensure_refused "a used chain where only the recorded Safe still has code"
# The positive twin: the same missing keystore on a REBOOTED chain (neither the
# timelock nor the Safe has code) is not refused as used; ensure goes on to
# provision, which in this harness stops at the missing summary.
baseline; rm -f "$WORK/vkeys/approver-c"
set_state "codehash:$(lc "$TIMELOCK")" 0x00; set_state "codehash:$(lc "$SAFE")" 0x00
rc=0; rm -rf "$WORK/ensure-out"; mkdir -p "$WORK/ensure-out"; run_ensure || rc=$?
if grep -q "summary not found" "$WORK/out" && ! grep -q "reboot the devnet" "$WORK/out"; then
  PASSED=$((PASSED + 1)); echo "ok   ensure on a rebooted chain goes on to provision (exit $rc at the missing summary)"
else
  FAILED=$((FAILED + 1)); echo "FAIL ensure on a rebooted chain: exit $rc"; tail -3 "$WORK/out"
fi

echo "fusion-ceremony selftest: $PASSED passed, $FAILED failed"

# ─── propose / propose-negative / vote / execute / jump_to ──────────────────
# These five actions share one chain, provisioned once per lifecycle (unlike
# `verify` above, propose->vote->execute is a sequence: execute needs a voted
# proposal, and idempotency needs the state its own predecessor left behind).
# The fake cast's `send` case plays the contracts well enough to make that
# sequence real: currentProposalId advances, hasVoted/votes accumulate,
# timelock operations gate on their own scheduled timestamp, and the router's
# weights only change through governance's own execute().
GOV_PASSED=0; GOV_FAILED=0
gov_ok() {
  local name="$1" rc=0
  run_action || rc=$?
  if [[ "$rc" == 0 ]]; then GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   $name"
  else GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL $name: exited $rc — $(tail -5 "$WORK/out" "$WORK/err")"; fi
}
gov_fail_needle() {
  local name="$1" needle="$2" rc=0
  run_action || rc=$?
  if [[ "$rc" == 0 ]]; then
    GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL $name: exited 0"
  elif grep -qF "$needle" "$WORK/out.combined"; then
    GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   $name is refused"
  else
    GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL $name: exited non-zero without naming '$needle'"; tail -5 "$WORK/out.combined"
  fi
}
json_field() { jq -r "$1" "$WORK/out.json" 2>/dev/null; }
json_field_c() { jq -c "$1" "$WORK/out.json" 2>/dev/null; }

# A four-vault topology distinct from `verify`'s (which collapses all four
# canonical buckets onto one address on purpose — `verify` never grades a
# per-vault weight, but execute's G08 grading does, and weight_lookup dies on
# a vault named twice in one vector).
gov_baseline() {
  {
    printf 'chain\t918453\nquorum\t2\ntotal\t2\ndelay\t120\nclock\t1000000000\ntxseq\t0\nproposalid\t0\nblocknum\t100\n'
    printf 'owner:%s\t%s\n' "$SAFE" "$APPROVER"
    for r in "$GOVERNANCE" "$TIMELOCK" "$SAFE" "$ROUTER"; do printf 'codehash:%s\t%s\n' "$r" "$HASH"; done
    printf 'power:%s\t1\npower:%s\t1\n' "$VOTER_A" "$VOTER_B"
    printf 'keystore:approver\t%s\n' "$APPROVER"
    printf 'keystore:approver-b\t%s\n' "$APPROVER_B"
    printf 'keystore:approver-c\t%s\n' "$APPROVER_C"
    printf 'keystore:voter-a\t%s\n' "$VOTER_A"
    printf 'keystore:voter-b\t%s\n' "$VOTER_B"
    printf 'owners:%s\t%s %s %s\n' "$(lc "$SAFE")" "$(lc "$APPROVER")" "$(lc "$APPROVER_B")" "$(lc "$APPROVER_C")"
    printf 'threshold:%s\t2\n' "$(lc "$SAFE")"
  } >"$WORK/state"
  rm -rf "$WORK/out-dir"
  mkdir -p "$WORK/out-dir"
  mkdir -p "$WORK/keys"
  : >"$WORK/keys/approver"; : >"$WORK/keys/approver.pw"
  : >"$WORK/keys/approver-b"; : >"$WORK/keys/approver-b.pw"
  : >"$WORK/keys/approver-c"; : >"$WORK/keys/approver-c.pw"
  : >"$WORK/keys/voter-a"; : >"$WORK/keys/voter-a.pw"
  : >"$WORK/keys/voter-b"; : >"$WORK/keys/voter-b.pw"
  jq -n --arg gov "$GOVERNANCE" --arg t "$TIMELOCK" --arg s "$SAFE" --arg r "$ROUTER" --arg d "$DEPLOYER" \
    --arg sub "$SUBMITTER" --arg ap "$APPROVER" --arg va "$VOTER_A" --arg vb "$VOTER_B" --arg e "$EMERGENCY" \
    --arg keydir "$WORK/keys" --arg run "selftest" --arg apb "$APPROVER_B" --arg apc "$APPROVER_C" \
    --arg vagent "$VAULT_AGENT" --arg vusdc "$VAULT_USDC" --arg vproto "$VAULT_PROTO" --arg vrwa "$VAULT_RWA" \
    '{chain_id: 918453, min_delay: 120, deployer: $d, run_id: $run,
      addresses: {gateway: $t, router: $r, governance: $gov, consensus_receipt: $t, ic_policy: $t,
                  timelock: $t, safe: $s, registry: $t, vault: $vusdc, emergency: $e},
      code_hashes: {},
      vault_addresses: {rmUSDC: $vusdc, rmPROTO: $vproto, rmAGENT: $vagent, rmRWA: $vrwa},
      ephemeral: {submitter: $sub, approver: $ap, voters: [$va, $vb], emergency: $e, keystore_dir: $keydir,
                 safe_signers: [{role: "approver", address: $ap}, {role: "approver-b", address: $apb},
                                {role: "approver-c", address: $apc}]}}' \
    >"$WORK/record.json"
}

# A draft naming the four canonical buckets in the canonical bps G08 grades:
# 833/8167/667/333 for rmAGENT/rmUSDC/rmPROTO/rmRWA.
write_draft() {
  local receipt_id="$1"
  local calldata
  calldata="$("$REAL_CAST" calldata 'propose(address[],uint256[])' \
    "[$VAULT_AGENT,$VAULT_USDC,$VAULT_PROTO,$VAULT_RWA]" "[833,8167,667,333]")"
  jq -n --arg rid "$receipt_id" --arg cd "$calldata" \
    --arg vagent "$VAULT_AGENT" --arg vusdc "$VAULT_USDC" --arg vproto "$VAULT_PROTO" --arg vrwa "$VAULT_RWA" \
    '{drafts: [{receipt_id: $rid, propose_calldata: $cd,
                vaults: [{vault: $vagent, weight_bps: 833}, {vault: $vusdc, weight_bps: 8167},
                         {vault: $vproto, weight_bps: 667}, {vault: $vrwa, weight_bps: 333}]}]}' \
    >"$WORK/draft.json"
}

RECEIPT_A=0x$(printf '%064x' 101)

run_action() {
  set +e
  FAKE_STATE="$WORK/state" REAL_CAST="$REAL_CAST" CAST="$WORK/cast" \
    "$CEREMONY" "$ACTION" --record "$WORK/record.json" --draft-file "$WORK/draft.json" \
    --out-dir "$WORK/out-dir" --rpc-url http://fake \
    >"$WORK/out" 2>"$WORK/err"
  local rc=$?
  set -e
  cat "$WORK/out" "$WORK/err" >"$WORK/out.combined" 2>/dev/null || true
  # `propose` prints one JSON object on stdout; the other actions do too.
  cp "$WORK/out" "$WORK/out.json" 2>/dev/null || true
  return $rc
}
# gov_fail_needle greps stdout+stderr combined, since `die` writes to stderr.
run_action_combined() { run_action; local rc=$?; mv "$WORK/out.combined" "$WORK/out"; return $rc; }

echo "--- propose / propose-negative ---"

# propose-negative: the operator EOA can never call propose(), whatever else
# is true on chain. No state to arrange beyond the contracts existing.
ACTION=propose-negative
gov_baseline; write_draft "$RECEIPT_A"
if run_action_combined; then GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   propose-negative refuses the operator EOA"
else GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL propose-negative: exited nonzero"; tail -5 "$WORK/out"; fi
[[ "$(json_field .action)" == "propose_refused_from_eoa" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   propose-negative names AccessControlUnauthorizedAccount"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL propose-negative did not report the refusal"; }

# propose: selector, +1, stored vaults/bps, proposer==timelock, domain
# separation, all off ONE run against a proposal-free governance.
ACTION=propose
gov_baseline; write_draft "$RECEIPT_A"
gov_ok "propose creates the proposal via the timelock"
[[ "$(json_field .action)" == "proposed_via_timelock" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   propose reports proposed_via_timelock"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL propose action was $(json_field .action)"; }
[[ "$(json_field .proposal_id)" == "1" && "$(json_field .proposal_id_before)" == "0" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   currentProposalId advanced by exactly one"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL proposal_id $(json_field .proposal_id) from before $(json_field .proposal_id_before)"; }
[[ "$(lc "$(json_field .proposer)")" == "$(lc "$TIMELOCK")" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   stored proposer is the timelock"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL stored proposer $(json_field .proposer) is not the timelock"; }
[[ "$(json_field_c '.vaults | sort')" == "$(jq -nc --arg a "$(lc "$VAULT_AGENT")" --arg u "$(lc "$VAULT_USDC")" --arg p "$(lc "$VAULT_PROTO")" --arg r "$(lc "$VAULT_RWA")" '[$a,$u,$p,$r] | sort')" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   stored vaults equal the draft's four buckets"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL stored vaults $(json_field_c '.vaults') do not match the draft"; }
[[ "$(json_field '.bps_total')" == "10000" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   stored bps total 10000"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL stored bps totalled $(json_field '.bps_total')"; }
[[ -n "$(json_field .salt)" && "$(lc "$(json_field .salt)")" != "$(lc "$RECEIPT_A")" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   propose salt is domain separated from the bare receipt id"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL propose salt $(json_field .salt) is not distinguished from receipt_id $RECEIPT_A"; }

# propose again on the SAME (now Active) proposal: ActiveProposalExists
# idempotency. Nothing gets scheduled a second time.
gov_ok "propose is idempotent on an Active proposal"
[[ "$(json_field .action)" == "already_proposed" && "$(json_field .proposal_state)" == "Active" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   rerun reports already_proposed / Active, schedules nothing"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL rerun reported action=$(json_field .action) state=$(json_field .proposal_state)"; }

# Idempotency is a claim about THIS draft. An Active proposal left by a
# different draft must be refused, never reported as "already proposed": the
# acceptance evidence would otherwise name a draft that is nowhere on chain.
ACTION=propose; gov_baseline
write_draft "$RECEIPT_A"
jq '.drafts[0].vaults[0].weight_bps = 834 | .drafts[0].vaults[1].weight_bps = 8166' "$WORK/draft.json" >"$WORK/d2" && mv "$WORK/d2" "$WORK/draft.json"
other_calldata="$("$REAL_CAST" calldata 'propose(address[],uint256[])' \
  "[$VAULT_AGENT,$VAULT_USDC,$VAULT_PROTO,$VAULT_RWA]" "[834,8166,667,333]")"
jq --arg cd "$other_calldata" '.drafts[0].propose_calldata = $cd' "$WORK/draft.json" >"$WORK/d2" && mv "$WORK/d2" "$WORK/draft.json"
run_action >/dev/null 2>&1   # a live Active proposal from ANOTHER draft
write_draft "$RECEIPT_A"
gov_fail_needle "propose refuses to call another draft's live proposal its own" "stored proposal bps do not equal the draft's"

# The proposer==timelock assertion is load-bearing, not decorative: on a
# chain where the stored proposal names someone else (a corruption no
# correctly wired RouterGovernance would produce, but exactly the shape this
# assertion exists to catch), propose must refuse rather than shrug.
ACTION=propose
gov_baseline; write_draft "$RECEIPT_A"
set_state impersonate_proposer "$SUBMITTER"
gov_fail_needle "propose dies when the stored proposer is not the timelock" "not the timelock"

echo "--- jump_to: die if the chain refuses the Anvil RPCs ---"
ACTION=propose
gov_baseline; write_draft "$RECEIPT_A"
set_state anvil_reject true
gov_fail_needle "propose dies when the chain is not Anvil-backed" "not Anvil-backed"

echo "--- release ---"
# G04: the receipt released through Safe -> Timelock. The action schedules the
# operation, reads back WHEN that operation becomes ready (getTimestamp takes the
# operation id — reading it without one used to leave the wait empty and the
# action dead), jumps the clock there, and executes.
RECEIPT_TO_RELEASE="$RECEIPT_A"
run_release() {
  set +e
  FAKE_STATE="$WORK/state" REAL_CAST="$REAL_CAST" CAST="$WORK/cast" \
    "$CEREMONY" release --record "$WORK/record.json" --receipt-id "$RECEIPT_TO_RELEASE" \
    --out-dir "$WORK/out-dir" --rpc-url http://fake >"$WORK/out" 2>"$WORK/err"
  local rc=$?
  set -e
  cat "$WORK/out" "$WORK/err" >"$WORK/out.combined" 2>/dev/null || true
  cp "$WORK/out" "$WORK/out.json" 2>/dev/null || true
  return $rc
}

gov_baseline
if run_release; then GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   release drives the receipt through the Safe and the timelock"
else GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL release: exited nonzero — $(tail -5 "$WORK/out.combined")"; fi
[[ "$(json_field .action)" == "released_via_timelock" && -n "$(json_field .execute_tx)" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   release reports released_via_timelock with both txs"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL release reported action=$(json_field .action) execute_tx=$(json_field .execute_tx)"; }
[[ "$(awk -F'\t' -v k="released:$(lc "$RECEIPT_A")" '$1 == k { print $2 }' "$WORK/state")" == "true" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the receipt is released on chain"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL the receipt was never released on chain"; }

if run_release; then GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   release is idempotent on an already-released receipt"
else GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL release rerun: exited nonzero — $(tail -5 "$WORK/out.combined")"; fi
[[ "$(json_field .action)" == "already_released" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the rerun reports already_released and sends nothing"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL release rerun reported $(json_field .action)"; }

echo "--- vote ---"
gov_baseline; write_draft "$RECEIPT_A"
ACTION=propose; run_action >/dev/null 2>&1   # seed a fresh Active proposal first
ACTION=vote
gov_ok "vote drives both voters to quorum"
[[ "$(json_field .quorum_reached)" == "true" && "$(json_field .votes_for)" == "2" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   tally reaches the snapshot quorum"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL tally $(json_field .votes_for) of $(json_field .snapshot_quorum)"; }
[[ "$(json_field .no_voting_power_control.observed_error)" == "NoVotingPower" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the powerless key is refused NoVotingPower"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL no_voting_power_control reported $(json_field .no_voting_power_control.observed_error)"; }
[[ "$(json_field .one_vote_insufficient.asserted)" == "true" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   one vote is shown insufficient before voter-b votes"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL one_vote_insufficient was not asserted: $(json_field '.one_vote_insufficient')"; }
# The clause has to name the TALLY rule. VotingStillOpen is what execute()
# answers while the window is open whatever the tally is, so only
# QuorumNotReached, probed past the deadline, is evidence of a quorum rule.
[[ "$(json_field .one_vote_insufficient.expected_error)" == "QuorumNotReached" \
   && "$(json_field .one_vote_insufficient.window)" == "closed" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the one-vote clause names QuorumNotReached past the deadline"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL one_vote_insufficient claimed $(json_field .one_vote_insufficient.expected_error) with the window $(json_field .one_vote_insufficient.window)"; }
# ... and the probe must be rolled back, or voter-b could not have voted.
[[ "$(json_field .one_vote_insufficient.rolled_back)" == "true" \
   && "$(json_field .one_vote_insufficient.chain_time)" -le "$(json_field .one_vote_insufficient.voting_deadline)" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the closed-window probe is rolled back before voter-b votes"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL the probe left chain time at $(json_field .one_vote_insufficient.chain_time) (deadline $(json_field .one_vote_insufficient.voting_deadline))"; }
[[ "$(json_field .voter_a.outcome)" == "voted" && "$(json_field .voter_b.outcome)" == "voted" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   both voters are reported voted"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL voter outcomes a=$(json_field .voter_a.outcome) b=$(json_field .voter_b.outcome)"; }

gov_ok "vote is idempotent once both voters have already voted (AlreadyVoted)"
[[ "$(json_field .voter_a.outcome)" == "already_voted" && "$(json_field .voter_b.outcome)" == "already_voted" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   rerun skips both voters as already_voted"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL rerun outcomes a=$(json_field .voter_a.outcome) b=$(json_field .voter_b.outcome)"; }
[[ "$(json_field .one_vote_insufficient.asserted)" == "false" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   rerun does not re-claim the one-vote-insufficient proof"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL rerun re-asserted one_vote_insufficient with both votes already cast"; }

echo "--- execute ---"
ACTION=execute
gov_ok "execute is refused too early (VotingStillOpen, before the deadline)"
[[ "$(json_field .too_early_control.observed_error)" == "VotingStillOpen" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   too-early control names VotingStillOpen before the deadline"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL too_early_control reported $(json_field .too_early_control.observed_error)"; }
[[ "$(json_field .action)" == "executed" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   execute mines once the delay has elapsed"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL execute action was $(json_field .action)"; }
weights_ok=1
for row in "rmAGENT:833" "rmUSDC:8167" "rmPROTO:667" "rmRWA:333"; do
  key="${row%%:*}"; want="${row##*:}"
  got_router="$(json_field ".weights_after[] | select(.vault_key==\"$key\") | .router_bps")"
  got_eff="$(json_field ".weights_after[] | select(.vault_key==\"$key\") | .effective_bps")"
  got_ev="$(json_field ".weights_after[] | select(.vault_key==\"$key\") | .weights_applied_bps")"
  [[ "$got_router" == "$want" && "$got_eff" == "$want" && "$got_ev" == "$want" ]] || weights_ok=0
done
if (( weights_ok )); then GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   every vault got its exact canonical bps (router, effective, event)"
else GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL a vault's weight was not exactly canonical: $(json_field '.weights_after')"; fi

# G08 asks that ONLY this transition change the router's weights. propose and
# both votes each left a witness of the vector they saw; execute compared them
# to each other and to its own live reading before it moved the clock, and the
# clause is only proved when it SAYS so with an explicit true verdict.
[[ "$(json_field .weights_unchanged_until_execute.asserted)" == "true" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   a clean cycle asserts weights_unchanged_until_execute"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL weights_unchanged_until_execute was $(json_field_c '.weights_unchanged_until_execute')"; }
# `unique`: the vote action ran twice above (once for real, once for its
# idempotent rerun), and every run that leaves a vote on chain witnesses the
# vector again. What matters is that all three stages are represented.
[[ "$(json_field_c '[.weights_unchanged_until_execute.witnesses[].stage] | unique')" == '["propose","vote-a","vote-b"]' ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the assertion rests on the propose and both vote witnesses"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL witnessed stages were $(json_field_c '[.weights_unchanged_until_execute.witnesses[].stage]')"; }

gov_ok "execute is idempotent on an already-executed proposal (AlreadyExecuted)"
[[ "$(json_field .action)" == "already_executed" && "$(json_field .already_executed_control.observed_error)" == "AlreadyExecuted" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   rerun reports already_executed and refuses AlreadyExecuted"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL rerun action=$(json_field .action) control=$(json_field .already_executed_control.observed_error)"; }
weights_ok=1
for row in "rmAGENT:833" "rmUSDC:8167" "rmPROTO:667" "rmRWA:333"; do
  key="${row%%:*}"; want="${row##*:}"
  got_router="$(json_field ".weights_after[] | select(.vault_key==\"$key\") | .router_bps")"
  [[ "$got_router" == "$want" ]] || weights_ok=0
done
(( weights_ok )) \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the canonical vector is still live after the idempotent rerun"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL the canonical vector regressed on the idempotent rerun"; }
# The transition already happened, so no witness can be compared against the
# vector the router now carries. That is an untested clause, and the rerun has
# to say so rather than re-claim the proof its predecessor earned.
[[ "$(json_field .weights_unchanged_until_execute.asserted)" == "false" \
   && -n "$(json_field .weights_unchanged_until_execute.reason)" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the rerun reports weights_unchanged_until_execute unproven, with a reason"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL rerun claimed $(json_field_c '.weights_unchanged_until_execute')"; }

echo "--- propose: a second cycle after the first one executed ---"
# The timelock stamps an executed operation Done forever, so an operation id
# keyed on the receipt alone would make this impossible: nothing to schedule,
# nothing ever ready, and a "never became ready" that names the wrong cause.
# This runs straight off the executed proposal the section above left behind.
ACTION=propose
gov_ok "propose opens a second cycle once the first proposal is Executed"
[[ "$(json_field .proposal_id)" == "2" && "$(json_field .proposal_id_before)" == "1" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   the second cycle gets its own proposal id"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL second cycle reported id $(json_field .proposal_id) from before $(json_field .proposal_id_before)"; }

echo "--- propose: calldata that disagrees with the draft ---"
# The timelock executes the bytes it was handed, so calldata that encodes a
# different vector than the draft's own vaults/bps must be refused BEFORE it is
# scheduled — not after it has created a live Active proposal that blocks every
# later propose with ActiveProposalExists.
ACTION=propose; gov_baseline; write_draft "$RECEIPT_A"
bad_calldata="$("$REAL_CAST" calldata 'propose(address[],uint256[])' "[$VAULT_USDC]" "[10000]")"
jq --arg cd "$bad_calldata" '.drafts[0].propose_calldata = $cd' "$WORK/draft.json" >"$WORK/d2" && mv "$WORK/d2" "$WORK/draft.json"
gov_fail_needle "propose refuses calldata that does not encode the draft's vector" "not the draft's own list"

echo "--- vote: the quorum rule itself has to be on chain ---"
# The point of the one-vote clause: on a governance that never compares votesFor
# with the quorum, `vote` must refuse rather than emit the same green evidence.
# The fake chain's execute() keeps its VotingStillOpen and its delay checks and
# drops only the tally check, which is exactly the contract a VotingStillOpen
# assertion would have passed.
ACTION=propose; gov_baseline; write_draft "$RECEIPT_A"; run_action >/dev/null 2>&1
set_state no_quorum_rule true
ACTION=vote
gov_fail_needle "vote refuses a governance with no quorum rule" "not with QuorumNotReached"

echo "--- execute: the weights-unchanged witness across the whole cycle ---"
# propose, vote and execute are three separate invocations, so the witness that
# propose took only reaches execute on disk. These two cases are what makes that
# file worth reading: one where a witness disagrees, and one where there is none.
seed_witnessed_cycle() {
  ACTION=propose; gov_baseline; write_draft "$RECEIPT_A"; run_action >/dev/null 2>&1
  ACTION=vote; run_action >/dev/null 2>&1
  ACTION=execute
}
witness_file_path() { ls "$WORK/out-dir/weight-witness/"*.jsonl 2>/dev/null | head -1; }

# A witness that disagrees is a router whose weights MOVED before execute —
# exactly the breach G08 exists to detect. It must stop the ceremony, never come
# back as a false verdict or a quiet skip.
seed_witnessed_cycle
WF="$(witness_file_path)"
if [[ -s "$WF" ]]; then
  GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   propose and vote left a witness file for the cycle"
else
  GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL no witness file was written under $WORK/out-dir"
fi
jq -c 'if .stage == "propose" then .fingerprint = (.fingerprint | sub("=absent"; "=10000")) else . end' \
  "$WF" >"$WF.tampered" && mv "$WF.tampered" "$WF"
gov_fail_needle "execute dies when a witness says the weights moved before it" \
  "weights changed before execute in governance cycle"

# No witness at all: an execute run standalone against a cycle whose propose and
# vote predate this feature. The transition still runs and is still graded; the
# clause it cannot test is reported UNPROVEN and never as a pass.
seed_witnessed_cycle
rm -f "$(witness_file_path)"
gov_ok "execute still runs the transition when the cycle left no witness"
[[ "$(json_field .action)" == "executed" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   a witnessless cycle still executes and grades the applied vector"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL witnessless execute reported action=$(json_field .action)"; }
[[ "$(json_field .weights_unchanged_until_execute.asserted)" == "false" \
   && "$(json_field .weights_unchanged_until_execute.reason)" == *"no propose or vote weight witness"* ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   a witnessless cycle reports the clause unproven and names why"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL witnessless execute claimed $(json_field_c '.weights_unchanged_until_execute')"; }

echo "--- the weight witness that is lost: said out loud, never swallowed ---"
# A lost witness degrades the proof, so no action may end up looking whole
# without it: propose and vote report what they recorded, and execute refuses
# to build a true verdict on a partial file. None of it may cost the chain work
# the action already did.

# A clean run first, so the reported shape is known before anything breaks.
ACTION=propose; gov_baseline; write_draft "$RECEIPT_A"
gov_ok "propose reports the weight witness it took"
[[ "$(json_field .weight_witness.recorded)" == "true" && "$(json_field .weight_witness.stage)" == "propose" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   propose's JSON carries its recorded witness"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL propose reported weight_witness $(json_field_c .weight_witness)"; }
ACTION=vote
gov_ok "vote reports both of the weight witnesses it took"
[[ "$(json_field .weight_witness.vote_a.recorded)" == "true" \
   && "$(json_field .weight_witness.vote_b.recorded)" == "true" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   vote's JSON carries both recorded witnesses"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL vote reported weight_witness $(json_field_c .weight_witness)"; }

# A witness that cannot be WRITTEN: a plain file sitting where the witness
# directory has to go, which no uid can mkdir -p over. The proposal still goes
# on chain, so the record of it must still come back — carrying the loss.
ACTION=propose; gov_baseline; write_draft "$RECEIPT_A"
rm -rf "$WORK/out-dir/weight-witness"; : >"$WORK/out-dir/weight-witness"
gov_ok "propose still reports its chain work when the witness cannot be written"
[[ "$(json_field .action)" == "proposed_via_timelock" \
   && -n "$(json_field .proposal_created.tx)" \
   && "$(json_field .weight_witness.recorded)" == "false" \
   && "$(json_field .weight_witness.reason)" == *"could not write"* ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   an unwritable witness is reported, and propose's evidence survives it"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL unwritable-witness propose reported action=$(json_field .action) witness=$(json_field_c .weight_witness)"; }
rm -f "$WORK/out-dir/weight-witness"

# A witness that cannot be READ: the router stops answering getWeights() at the
# instant vote-b's vote is already mined. Both votes are irreversible, so the
# action has to come back with them rather than exit on the reading.
ACTION=propose; gov_baseline; write_draft "$RECEIPT_A"; run_action >/dev/null 2>&1
ACTION=vote; set_state getweights_fails true
gov_ok "vote still reports both votes when the router will not answer the witness read"
set_state getweights_fails false
[[ "$(json_field .voter_a.outcome)" == "voted" && "$(json_field .voter_b.outcome)" == "voted" \
   && "$(json_field .weight_witness.vote_a.recorded)" == "false" \
   && "$(json_field .weight_witness.vote_b.reason)" == *"could not read the router vector"* ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   an unreadable router costs the witness and not the votes"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL unreadable-witness vote reported a=$(json_field .voter_a.outcome) b=$(json_field .voter_b.outcome) witness=$(json_field_c .weight_witness)"; }

# A witness file with a TRUNCATED line — what a half-finished append leaves,
# with the next stage's record concatenated onto it. That is a witness this run
# cannot read, not a weights disagreement, so execute must still run the
# transition and must still refuse to call the clause proved.
seed_witnessed_cycle
WF="$(witness_file_path)"
{ head -1 "$WF" | cut -c1-30 | tr -d '\n'; tail -n +2 "$WF"; } >"$WF.truncated"
mv "$WF.truncated" "$WF"
gov_ok "execute still runs the transition over a truncated witness line"
[[ "$(json_field .action)" == "executed" \
   && "$(json_field .weights_unchanged_until_execute.asserted)" == "false" \
   && "$(json_field .weights_unchanged_until_execute.corrupt_lines)" != "0" \
   && "$(json_field .weights_unchanged_until_execute.reason)" == *"cannot read as a witness"* ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   a truncated witness line is unproven, not a dead ceremony and not a pass"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL truncated-witness execute reported action=$(json_field .action) verdict=$(json_field_c .weights_unchanged_until_execute)"; }

# A file with the VOTE witnesses but no propose one — what a propose whose write
# failed leaves behind. Two agreeing witnesses say the vector held from the
# first vote onward; G08 asks about the whole cycle, so that is not the claim.
seed_witnessed_cycle
WF="$(witness_file_path)"
grep -v '"stage":"propose"' "$WF" >"$WF.votes-only" && mv "$WF.votes-only" "$WF"
gov_ok "execute still runs the transition over a propose-less witness file"
[[ "$(json_field .action)" == "executed" \
   && "$(json_field .weights_unchanged_until_execute.asserted)" == "false" \
   && "$(json_field .weights_unchanged_until_execute.reason)" == *"no propose weight witness"* ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   vote witnesses alone cannot carry the weights-unchanged claim"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL propose-less execute claimed $(json_field_c .weights_unchanged_until_execute)"; }

# ─── the Safe signing path (issue #1447) ─────────────────────────────────────
# release is the other Safe -> timelock caller. The fake Safe forwards nothing
# unless execTransaction carries `threshold` owner signatures over its own
# digest, ascending — so each case below is graded by what the Safe accepted.
run_release() {
  set +e
  FAKE_STATE="$WORK/state" REAL_CAST="$REAL_CAST" CAST="$WORK/cast" \
    "$CEREMONY" release --record "$WORK/record.json" --receipt-id "$RECEIPT_A" --rpc-url http://fake \
    >"$WORK/out" 2>"$WORK/err"
  local rc=$?
  set -e
  cat "$WORK/out" "$WORK/err" >"$WORK/out.combined" 2>/dev/null || true
  return $rc
}
release_ok() {
  local name="$1"
  if run_release && [[ "$(jq -r .action "$WORK/out")" == "released_via_timelock" ]] \
     && [[ "$(awk -F'\t' -v k="released:$(lc "$RECEIPT_A")" '$1 == k { print $2 }' "$WORK/state")" == "true" ]]; then
    GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   $name"
  else
    GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL $name: $(tail -3 "$WORK/out.combined")"
  fi
}
release_refused() {
  local name="$1" needle="$2"
  if run_release; then
    GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL $name: release exited 0"
  elif grep -qF -- "$needle" "$WORK/out.combined"; then
    GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   $name is refused"
  else
    GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL $name: refused without naming '$needle' — $(tail -3 "$WORK/out.combined")"
  fi
}

gov_baseline
release_ok "release schedules and executes through a 2-of-3 Safe (signers packed by address, not record order)"
[[ "$(awk -F'\t' -v k="safenonce:$(lc "$SAFE")" '$1 == k { print $2 }' "$WORK/state")" == "2" ]] \
  && { GOV_PASSED=$((GOV_PASSED + 1)); echo "ok   release spent exactly two Safe nonces (schedule, execute)"; } \
  || { GOV_FAILED=$((GOV_FAILED + 1)); echo "FAIL release left Safe nonce at $(awk -F'\t' -v k="safenonce:$(lc "$SAFE")" '$1 == k { print $2 }' "$WORK/state")"; }

gov_baseline; set_state "threshold:$(lc "$SAFE")" 1
release_refused "a Safe reporting threshold 1" "cannot enforce quorum"

gov_baseline
jq '.ephemeral.safe_signers |= .[:1]' "$WORK/record.json" >"$WORK/r2" && mv "$WORK/r2" "$WORK/record.json"
release_refused "a record naming a single Safe signer" "2 are needed"

gov_baseline; rm -f "$WORK/keys/approver-c"
release_refused "a discarded Safe signer keystore" "safe signer keystore is gone"

# The Safe itself, not the ceremony, is the last line: an owner set that does
# not include a signer the record names makes the Safe refuse (GS026).
gov_baseline; set_state "owners:$(lc "$SAFE")" "$(lc "$APPROVER") $(lc "$APPROVER_B") $(lc "$DEPLOYER")"
release_refused "a record signer the Safe does not list as an owner" "GS026"

echo "governance actions selftest: $GOV_PASSED passed, $GOV_FAILED failed"

# ─── test-the-test: prove two of the new assertions actually gate something ──
# C-21 again, now against fusion-ceremony.sh itself: stub the assertion,
# rerun the EXACT scenario that is supposed to catch it, confirm the case
# flips from refused to silently accepted, then restore the file byte for
# byte. A case that still refuses with the assertion gone would be worthless.
STUB_PASSED=0; STUB_FAILED=0
CEREMONY_BACKUP="$WORK/fusion-ceremony.sh.orig"
cp "$CEREMONY" "$CEREMONY_BACKUP"
restore_ceremony() { cp "$CEREMONY_BACKUP" "$CEREMONY"; }
trap 'restore_ceremony; rm -rf "$WORK"' EXIT

patch_literal() {
  # patch_literal <needle> <replacement>: exact, non-regex text substitution,
  # so nothing here depends on getting a regex dialect's escaping right.
  python3 - "$CEREMONY" "$1" "$2" <<'PY'
import sys
path, needle, repl = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
if needle not in text:
    sys.exit("needle not found: " + needle)
open(path, "w").write(text.replace(needle, repl, 1))
PY
}

echo "--- test-the-test: propose proposer==timelock ---"
PROPOSER_CHECK='  [[ "$(lower "$stored_proposer")" == "$(lower "$timelock")" ]] \
    || die "proposal $pid names proposer $stored_proposer, not the timelock $timelock: the ADMIN_ROLE path was not the one used" 1'
patch_literal "$PROPOSER_CHECK" '  true # STUBBED for selftest test-the-test'
ACTION=propose; gov_baseline; write_draft "$RECEIPT_A"
set_state impersonate_proposer "$SUBMITTER"
if run_action; then
  STUB_PASSED=$((STUB_PASSED + 1))
  echo "ok   (test-the-test) propose proposer==timelock: stubbing it turns the refusal into a silent accept"
else
  STUB_FAILED=$((STUB_FAILED + 1))
  echo "FAIL (test-the-test) propose proposer==timelock: still refused with the assertion stubbed out"
fi
restore_ceremony

echo "--- test-the-test: execute too-early negative ---"
# Mirror the proposer case: arrange a chain where execute() refuses NOTHING (so
# the control's own eth_call succeeds where it must revert), confirm the
# unstubbed action refuses it, then stub the assertion and confirm the SAME
# scenario is now silently accepted. A check on the reported error string would
# be a tautology — the stub is the only thing that produces that string.
seed_too_early_chain() {
  ACTION=propose; gov_baseline; write_draft "$RECEIPT_A"; run_action >/dev/null 2>&1
  ACTION=vote; run_action >/dev/null 2>&1
  set_state never_reverts_execute true
  ACTION=execute
}
seed_too_early_chain
if run_action; then
  STUB_FAILED=$((STUB_FAILED + 1))
  echo "FAIL (test-the-test) execute too-early negative: an execute() that refuses nothing was accepted"
else
  STUB_PASSED=$((STUB_PASSED + 1))
  echo "ok   (test-the-test) execute too-early negative: an execute() that refuses nothing is refused"
fi

TOO_EARLY_CHECK='  neg="$(assert_call_reverts "execute($pid_before) at chain time $now_before" \
          "$expected_sig" "$executor" "$governance" "$EXECUTE_SIG" "$pid_before")" || exit $?'
TOO_EARLY_REPL='  neg="STUBBED$(printf "\t")stub$(printf "\t")0x"'
patch_literal "$TOO_EARLY_CHECK" "$TOO_EARLY_REPL"
seed_too_early_chain
if run_action; then
  STUB_PASSED=$((STUB_PASSED + 1))
  echo "ok   (test-the-test) execute too-early negative: stubbing it turns the refusal into a silent accept"
else
  STUB_FAILED=$((STUB_FAILED + 1))
  echo "FAIL (test-the-test) execute too-early negative: still refused with the assertion stubbed out — $(tail -3 "$WORK/out.combined")"
fi
restore_ceremony

echo "--- test-the-test: execute weights-unchanged, the disagreement ---"
# Same shape as the two above: arrange the tampered witness the unstubbed action
# dies on, stub the comparison that dies, and confirm the SAME chain is now
# accepted without a word. A case that still refused would be grading something
# else.
MISMATCH_CHECK='  if [[ -n "$disagreements" ]]; then'
patch_literal "$MISMATCH_CHECK" '  if [[ -n "" ]]; then # STUBBED for selftest test-the-test'
seed_witnessed_cycle
WF="$(witness_file_path)"
jq -c 'if .stage == "propose" then .fingerprint = (.fingerprint | sub("=absent"; "=10000")) else . end' \
  "$WF" >"$WF.tampered" && mv "$WF.tampered" "$WF"
if run_action; then
  STUB_PASSED=$((STUB_PASSED + 1))
  echo "ok   (test-the-test) execute weights-unchanged: stubbing the comparison turns the refusal into a silent accept"
else
  STUB_FAILED=$((STUB_FAILED + 1))
  echo "FAIL (test-the-test) execute weights-unchanged: still refused with the comparison stubbed out — $(tail -3 "$WORK/out.combined")"
fi
restore_ceremony

echo "--- test-the-test: execute weights-unchanged, the missing witness ---"
# The other half of the contract: "I could not test this" must never be dressed
# up as a pass. Flip the no-witness verdict to true and the witnessless case has
# to notice — otherwise it was never reading the verdict at all.
UNPROVEN_VERDICT="'{asserted:false, proposal_id:\$pid, witnesses:\$w, witness_file:\$file, witness_count:\$n,"
patch_literal "$UNPROVEN_VERDICT" "'{asserted:true, proposal_id:\$pid, witnesses:\$w, witness_file:\$file, witness_count:\$n,"
seed_witnessed_cycle
rm -f "$(witness_file_path)"
run_action >/dev/null 2>&1 || true
if [[ "$(json_field .weights_unchanged_until_execute.asserted)" == "true" ]]; then
  STUB_PASSED=$((STUB_PASSED + 1))
  echo "ok   (test-the-test) execute weights-unchanged: a stubbed verdict turns the missing witness into a claimed pass"
else
  STUB_FAILED=$((STUB_FAILED + 1))
  echo "FAIL (test-the-test) execute weights-unchanged: the witnessless case did not flip with the verdict stubbed — $(json_field_c '.weights_unchanged_until_execute')"
fi
restore_ceremony

echo "--- test-the-test: execute weights-unchanged, the missing propose witness ---"
# The gate that keeps two agreeing VOTE witnesses from carrying a whole-cycle
# claim. Drop the gate and the same propose-less file has to turn green, or the
# case above was never reading it.
PROPOSE_GATE='  elif [[ " $stages_seen " != *" propose "* ]]; then'
patch_literal "$PROPOSE_GATE" '  elif false; then # STUBBED for selftest test-the-test'
seed_witnessed_cycle
WF="$(witness_file_path)"
grep -v '"stage":"propose"' "$WF" >"$WF.votes-only" && mv "$WF.votes-only" "$WF"
run_action >/dev/null 2>&1 || true
if [[ "$(json_field .weights_unchanged_until_execute.asserted)" == "true" ]]; then
  STUB_PASSED=$((STUB_PASSED + 1))
  echo "ok   (test-the-test) execute weights-unchanged: stubbing the propose gate turns a vote-only file into a claimed pass"
else
  STUB_FAILED=$((STUB_FAILED + 1))
  echo "FAIL (test-the-test) execute weights-unchanged: the vote-only file did not flip with the propose gate stubbed — $(json_field_c '.weights_unchanged_until_execute')"
fi
restore_ceremony

trap 'rm -rf "$WORK"' EXIT

echo "test-the-test: $STUB_PASSED passed, $STUB_FAILED failed"

TOTAL_FAILED=$((FAILED + GOV_FAILED + STUB_FAILED))
echo "fusion-ceremony selftest TOTAL: $((PASSED + GOV_PASSED + STUB_PASSED)) passed, $TOTAL_FAILED failed"
(( TOTAL_FAILED == 0 ))
