#!/usr/bin/env bash
# Offline self-test for scripts/stage/fusion-ceremony.sh `verify` (C-21: a gate
# is not evidence until it has been shown to fail). A fake `cast` answers every
# chain read from a state table; the baseline topology must pass, and each
# single broken fact must make `verify` exit 1 naming that fact.
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
ADMIN=$("$REAL_CAST" keccak ADMIN_ROLE); AGENT=$("$REAL_CAST" keccak AGENT_ROLE)
COMMITTEE=$("$REAL_CAST" keccak COMMITTEE_AGENT_ROLE)
PROPOSER=$("$REAL_CAST" keccak PROPOSER_ROLE); EXECUTOR=$("$REAL_CAST" keccak EXECUTOR_ROLE)
HASH=0x$(printf 'ab%.0s' {1..32})

cat >"$WORK/cast" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state() { awk -F'\t' -v k="$1" '$1 == k { v = $2; f = 1 } END { if (f) print v; else exit 1 }' "$FAKE_STATE"; }
lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
pos=()
while (( $# )); do
  case "$1" in
    --rpc-url|--from|--from-block|--address) [[ "$1" == "--address" ]] && addr="$2"; [[ "$1" == "--from" ]] && from="$2"; shift 2 ;;
    --json) shift ;;
    *) pos+=("$1"); shift ;;
  esac
done
case "${pos[0]}" in
  keccak|calldata) exec "$REAL_CAST" "${pos[@]}" ;;
  chain-id) state chain ;;
  codehash) state "codehash:$(lower "${pos[1]}")" || echo 0x00 ;;
  balance) state "balance:$(lower "${pos[1]}")" || echo 0 ;;
  logs) key="logs:$(lower "$addr"):${pos[2]:-none}"
        accts="$(state "$key" || true)"
        printf '['; sep=""
        for x in $accts; do
          printf '%s{"topics":["0x%064x","%s","0x000000000000000000000000%s","0x%064x"]}' "$sep" 0 "${pos[2]:-0x00}" "${x#0x}" 0
          sep=","
        done
        printf ']\n' ;;
  call) c="$(lower "${pos[1]}")"; sig="${pos[2]}"
        case "$sig" in
          'hasRole(bytes32,address)(bool)') state "role:$c:${pos[3]}:$(lower "${pos[4]}")" || echo false ;;
          'quorumThreshold()(uint256)') state quorum ;;
          'totalVotingPower()(uint256)') state total ;;
          'votingPower(address)(uint256)') state "power:$(lower "${pos[3]}")" || echo 0 ;;
          'owner()(address)') state "owner:$c" ;;
          'getMinDelay()(uint256)') state delay ;;
          'setWeights(address[],uint256[])') [[ "$(state "setweights:$(lower "${from:-}")" || echo revert)" == ok ]] ;;
          *) echo "fake cast: unhandled call $sig" >&2; exit 1 ;;
        esac ;;
  *) echo "fake cast: unhandled ${pos[0]}" >&2; exit 1 ;;
esac
FAKE
chmod +x "$WORK/cast"

baseline() {
  local r
  {
    printf 'chain\t918453\nquorum\t2\ntotal\t2\ndelay\t120\n'
    printf 'owner:%s\t%s\n' "$SAFE" "$APPROVER"
    for r in "$GATEWAY" "$ROUTER" "$GOVERNANCE" "$RECEIPT" "$IC" "$TIMELOCK" "$SAFE" "$REGISTRY" "$VAULT"; do
      printf 'codehash:%s\t%s\n' "$r" "$HASH"
    done
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
    '{chain_id: 918453, min_delay: 120, deployer: $d,
      addresses: {gateway: $g, router: $r, governance: $gov, consensus_receipt: $rc, ic_policy: $ic,
                  timelock: $t, safe: $s, registry: $reg, vault: $v, emergency: $e},
      code_hashes: {gateway: $h, router: $h, governance: $h, consensus_receipt: $h, ic_policy: $h,
                    timelock: $h, safe: $h, registry: $h, vault: $h},
      vault_addresses: {rmUSDC: $v, rmPROTO: $v, rmAGENT: $v, rmRWA: $v},
      ephemeral: {submitter: $sub, approver: $ap, voters: [$va, $vb], emergency: $e}}' >"$WORK/record.json"
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

expect_ok

baseline; set_state "role:$(lc "$ROUTER"):$ADMIN:$(lc "$GOVERNANCE")" false
expect_fail "governance without router ADMIN_ROLE" "RouterGovernance holds router ADMIN_ROLE"

baseline; set_state "setweights:$(lc "$DEPLOYER")" ok
expect_fail "deployer still able to setWeights" "deployer EOA cannot call router.setWeights"

baseline; set_state quorum 1
expect_fail "placeholder quorum of 1" "quorumThreshold >= 2"

baseline; set_state "logs:$(lc "$IC"):$COMMITTEE" "$SUBMITTER $VOTER_A"; set_state "role:$(lc "$IC"):$COMMITTEE:$(lc "$VOTER_A")" true
expect_fail "a voter who is also a committee agent" "committee agents and non-zero voters are disjoint"

baseline; set_state "owner:$(lc "$SAFE")" "$DEPLOYER"
expect_fail "a safe the approver does not drive" "approver is the only key"

baseline; set_state "role:$(lc "$RECEIPT"):$ADMIN:$(lc "$DEPLOYER")" true
expect_fail "deployer keeping receipt ADMIN_ROLE" "deployer holds no ADMIN_ROLE on consensus_receipt"

baseline; jq --arg ap "$SUBMITTER" '.ephemeral.approver = $ap' "$WORK/record.json" >"$WORK/r2" && mv "$WORK/r2" "$WORK/record.json"
expect_fail "submitter reused as approver" "are distinct"

baseline; set_state "codehash:$(lc "$TIMELOCK")" 0xdead
expect_fail "timelock code hash drift" "code hash of timelock"

baseline; set_state "role:$(lc "$TIMELOCK"):$PROPOSER:$(lc "$SAFE")" false
expect_fail "timelock without the safe as proposer" "safe is the timelock proposer"

echo "fusion-ceremony selftest: $PASSED passed, $FAILED failed"
(( FAILED == 0 && PASSED == 10 ))
