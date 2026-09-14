#!/usr/bin/env bash
# Repeatable cross-repo Fusion devnet acceptance run, driven from `pinza`.
#
# WHAT THIS IS
# ------------
# project-fusion.md AC-E2E-05 requires the whole path to be "a repeatable
# cross-repo CI/devnet test, not only a one-off manual demonstration". This is
# that test. It takes ONE argument — the public URL of a receipt produced and
# signed by robotmoney-frontend — and drives the whole core-side path against a
# devnet:
#
#   verify   fetch the URL, canonicalize, derive digest and receipt id, verify
#            every embedded Ed25519 signature, check the bps total and the
#            bucket -> vault mapping                     AC-CORE-02 AC-FMT-02..04
#   negative tampered bytes, tampered prose, unsupported schema, unauthorized
#            submit, unauthorized release — none of which may change allocation
#            state or send a transaction                 AC-FMT-06 AC-E2E-06
#   record   anchor the digest through RobotMoneyGateway using the retrying,
#            idempotent worker                           AC-CORE-01 AC-CORE-09 AC-E2E-02
#   index    indexer and explorer API converge on the same digest and URL
#                                                        AC-CORE-06 AC-CORE-07
#   release  admin release, then the two duplicate refusals that only exist once
#            something is anchored                       AC-CORE-03 AC-E2E-03 AC-E2E-06
#   dapp     the dapp serves the receipt surface          AC-CORE-08
#   govern   release produces at most a human-reviewable draft and no on-chain
#            proposal                                    AC-GOV-01 AC-GOV-02 AC-E2E-04
#
# Every stage appends assertions to a machine-readable result file. ANY failed
# assertion makes the script exit non-zero; a stage that is skipped is recorded
# as skipped and never silently counted as a pass.
#
# STAGE SELECTION IS FIRST-CLASS, because "verify and refuse, but anchor
# nothing" is a real operating mode: it is how this script is dry-run before the
# first real receipt exists, and how it is re-run against an already-anchored
# receipt. `--stages verify,negative` (equivalently `--no-anchor`) touches the
# chain only through eth_call.
#
#   scripts/fusion/devnet-acceptance.sh <receipt-url> [--stages a,b,c|--no-anchor]
#                                       [--expected-digest 0x..] [--out FILE]
#
# Required environment (no defaults are invented — an unset address would turn
# an assertion into a silent skip):
#   FUSION_RMPC_CONFIG       operator config TOML for the SUBMITTER identity
#   FUSION_RPC_URL           devnet JSON-RPC
#   FUSION_GATEWAY_ADDRESS   RobotMoneyGateway
#   FUSION_RECEIPT_ADDRESS   ConsensusRecommendationReceipt
#   FUSION_GOVERNANCE_ADDRESS RouterGovernance      (INV-4 witness)
#   FUSION_ROUTER_ADDRESS    PortfolioRouter        (INV-4 witness)
#   FUSION_VAULT_ADDRESSES   rmUSDC,rmPROTO,rmAGENT,rmRWA in canonical bucket
#                            order                  (INV-4 witness + AC-FMT-04)
# Required for the negative stage:
#   FUSION_UNAUTHORIZED_SUBMITTER  an EOA with neither AGENT_ROLE nor
#                                  COMMITTEE_AGENT_ROLE
#   FUSION_SUBMITTER_ADDRESS       the authorized submitter, used as the control
#                                  that keeps the two reverts non-vacuous
#   FUSION_UNAUTHORIZED_RELEASER   an EOA WITHOUT ADMIN_ROLE on the receipt
#                                  contract (defaults to the unauthorized
#                                  submitter, which is only correct when that
#                                  address also lacks ADMIN_ROLE)
# Required for the index stage:  FUSION_EXPLORER_API
# Required for the dapp stage:   FUSION_DAPP_URL
# Required for the release stage: FUSION_RELEASE_KEYSTORE, FUSION_RELEASE_PASSWORD_FILE,
#   FUSION_RELEASE_ADDRESS   the admin EOA that keystore unlocks — declared, not
#                            scraped from the file, because keystore layouts differ
# Optional: RMPC_BIN, CAST_BIN, FUSION_INDEX_TIMEOUT_SECS (default 180),
#           FUSION_EVIDENCE_DIR (raw command output is written there)
set -uo pipefail

# T24: ONE envelope-unwrap rule, shared with every other consumer and pinned by
# tests/fixtures/consensus-receipt.envelope.json. This script used to carry two
# hand-written jq copies of it that had already diverged from each other.
FUSION_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"
# shellcheck source=lib/receipt-envelope.sh
source "$FUSION_LIB_DIR/receipt-envelope.sh"
# T10: ONE INV-4 witness reader, shared with cross-repo-acceptance.sh. This
# script used to fold stderr into the compared values and discard every `cast`
# exit status, so ten failed reads recorded a PASS.
# shellcheck source=lib/inv4.sh
source "$FUSION_LIB_DIR/inv4.sh"

# The explorer API row is a DIFFERENT object from the published envelope, and it
# had its own inline dual-shape idiom in three places here (`.receipt_id? //
# .receipt?.receipt_id?`, `(.receipt.verified // .verified)`,
# `(.receipt.released // .released)`) that disagreed with each other about which
# object wins. One helper, one rule, self-tested.
# shellcheck source=lib/explorer-api.sh
source "$FUSION_LIB_DIR/explorer-api.sh"

ALL_STAGES="verify negative record index release dapp govern"
STAGES="$ALL_STAGES"
RECEIPT_URL=""
EXPECTED_DIGEST=""
RESULT_FILE="${FUSION_RESULT_FILE:-fusion-acceptance-result.json}"

usage() { sed -n '2,60p' "$0" >&2; exit 64; }

while (( $# )); do
  case "$1" in
    --stages)          STAGES="${2//,/ }"; shift 2 ;;
    --no-anchor)       STAGES="verify negative"; shift ;;
    --expected-digest) EXPECTED_DIGEST="$2"; shift 2 ;;
    --out)             RESULT_FILE="$2"; shift 2 ;;
    -h|--help)         usage ;;
    -*)                echo "unknown option: $1" >&2; usage ;;
    *)                 [[ -z "$RECEIPT_URL" ]] || { echo "only one receipt URL" >&2; usage; }
                       RECEIPT_URL="$1"; shift ;;
  esac
done
[[ -n "$RECEIPT_URL" ]] || usage

for s in $STAGES; do
  [[ " $ALL_STAGES " == *" $s "* ]] || { echo "unknown stage: $s" >&2; exit 64; }
done

RMPC_BIN="${RMPC_BIN:-rmpc}"
CAST_BIN="${CAST_BIN:-cast}"
INDEX_TIMEOUT="${FUSION_INDEX_TIMEOUT_SECS:-180}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for bin in "$RMPC_BIN" "$CAST_BIN" jq curl; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 3; }
done
for v in FUSION_RMPC_CONFIG FUSION_RPC_URL FUSION_GATEWAY_ADDRESS FUSION_RECEIPT_ADDRESS \
         FUSION_GOVERNANCE_ADDRESS FUSION_ROUTER_ADDRESS FUSION_VAULT_ADDRESSES; do
  [[ -n "${!v:-}" ]] || { echo "missing required environment variable: $v" >&2; exit 3; }
done

EVIDENCE="${FUSION_EVIDENCE_DIR:-}"
[[ -z "$EVIDENCE" ]] || mkdir -p "$EVIDENCE"
keep() { [[ -z "$EVIDENCE" ]] || printf '%s\n' "$2" >"$EVIDENCE/$1"; }

# ── result accumulation ──────────────────────────────────────────────────────
: >"$WORK/assertions.ndjson"
FAILED=0
SKIPPED_UNCONFIGURED=0
# THE TWO SKIP REASONS ARE NOT THE SAME THING (T11).
#   not_selected        the operator asked for a subset. Honest, and green.
#   unconfigured        the stage WAS selected and its config is missing. The
#                       assertion the operator asked for did not run, so the run
#                       is NOT green — this used to be invisible to the verdict.
#   prerequisite_failed an earlier assertion already FAILED; `failed>0` carries it.
#   delegated           executed by a named other suite, never by this script.
SKIP_REASONS="not_selected unconfigured prerequisite_failed delegated"
record_assertion() { # <stage> <id> <PASS|FAIL|SKIP> <detail> [skip-reason]
  local reason="${5:-}"
  if [[ "$3" == "SKIP" ]]; then
    # A SKIP with no declared reason is the bug this field exists to prevent, so
    # it is not silently defaulted to the green one.
    [[ " $SKIP_REASONS " == *" $reason "* ]] || reason="unconfigured"
  else
    reason=""
  fi
  jq -cn --arg stage "$1" --arg id "$2" --arg result "$3" --arg detail "$4" --arg reason "$reason" \
    '{stage:$stage,assertion:$id,result:$result,reason:$reason,detail:$detail}' >>"$WORK/assertions.ndjson"
  case "$3" in
    PASS) printf 'PASS  [%s] %s\n' "$1" "$2" ;;
    SKIP) if [[ "$reason" == "unconfigured" ]]; then
            SKIPPED_UNCONFIGURED=$((SKIPPED_UNCONFIGURED + 1))
            printf 'SKIP! [%s] %s — UNCONFIGURED (stage selected, config missing): %s\n' "$1" "$2" "$4" >&2
          else
            printf 'SKIP  [%s] %s — %s (%s)\n' "$1" "$2" "$4" "$reason"
          fi ;;
    *)    FAILED=1; printf 'FAIL  [%s] %s — %s\n' "$1" "$2" "$4" >&2 ;;
  esac
}
expect() { # <stage> <id> <condition-exit-status-already-evaluated:0|1> <detail>
  if (( $3 == 0 )); then record_assertion "$1" "$2" PASS "$4"
  else record_assertion "$1" "$2" FAIL "$4"; fi
}
have_stage() { [[ " $STAGES " == *" $1 "* ]]; }

# ── INV-4 witnesses ──────────────────────────────────────────────────────────
# AC-CORE-04 names three: vault balances, router weights, proposal count. All
# three are read, because weights and proposal count alone would miss an asset
# movement.
IFS=',' read -r -a VAULTS <<<"$FUSION_VAULT_ADDRESSES"
# EXACTLY FOUR, in canonical bucket order. AC-FMT-04 names four buckets and four
# vaults; a short list would either index an unset array element (fatal under
# `set -u`, so the run dies instead of reporting) or silently check fewer vaults
# than the criterion requires. Refuse at startup instead.
if (( ${#VAULTS[@]} != 4 )); then
  echo "FUSION_VAULT_ADDRESSES must name EXACTLY 4 vaults in canonical bucket order \
(conservative_defi_yield, protocol_tokens, agent_tokens, real_world_assets); got ${#VAULTS[@]}" >&2
  exit 3
fi
witnesses() {
  # Deliberately swallows the non-zero status: the SENTINEL is the signal, and
  # `assert_witnesses_unchanged` refuses on it. Returning early here would leave
  # the blocker assertion unrecorded, which is the same silence in a new place.
  inv4_witnesses "$CAST_BIN" "$FUSION_RPC_URL" "$FUSION_GOVERNANCE_ADDRESS" \
    "$FUSION_ROUTER_ADDRESS" "${VAULTS[@]}" || true
}
W_START="$(witnesses)"
keep "witnesses-before.txt" "$W_START"
# Fail LOUDLY at startup rather than carrying an unreadable baseline into every
# later comparison. This is the same class as the missing-address refusal above.
if inv4_unreadable "$W_START"; then
  echo "INV-4 witnesses are not readable at startup — refusing to run a gate whose \
blocker assertion could only compare one absence against another: $W_START" >&2
  echo "check FUSION_RPC_URL, FUSION_GOVERNANCE_ADDRESS, FUSION_ROUTER_ADDRESS and \
FUSION_VAULT_ADDRESSES against the deployment manifest" >&2
  INV4_STARTUP_UNREADABLE=1
else
  INV4_STARTUP_UNREADABLE=0
fi

# `assert_witnesses_unchanged` compares against a BASELINE VARIABLE, not always
# against the script's first reading, and the difference is deliberate: see
# INV4_ACCRUAL_NOTE in lib/inv4.sh. Record and release are what INV-4 is about,
# so the witnesses bracketing them are read immediately before the record stage
# and immediately after the last write stage, which is the narrowest honest
# window. The criterion is NOT softened — the comparison is still exact equality.
assert_witnesses_unchanged() { # <stage> <label> [baseline]
  local now diff baseline id
  baseline="${3:-$W_START}"
  now="$(witnesses)"
  id="$2 — vault balances, router weights and proposal count unchanged (INV-4)"
  keep "witnesses-after-$1.txt" "$now"
  # AN UNREADABLE WITNESS IS A FAILED ASSERTION, NEVER A PASS. Two snapshots of
  # the same error text diff clean, which is exactly how ten failed reads used
  # to record "no allocation-state witness moved".
  if inv4_unreadable "$baseline" || inv4_unreadable "$now"; then
    record_assertion "$1" "$id" FAIL \
      "INV-4 witnesses could not be READ, so nothing was compared. before: ${baseline:-<empty>} after: ${now:-<empty>}"
    return 0
  fi
  diff="$(diff <(printf '%s' "$baseline") <(printf '%s' "$now") || true)"
  [[ -z "$diff" ]]
  expect "$1" "$id" $? "${diff:-no allocation-state witness moved}${diff:+
$INV4_ACCRUAL_NOTE}"
}

# ── stage: verify ────────────────────────────────────────────────────────────
RECEIPT_ID=""; PAYLOAD_DIGEST=""
if have_stage verify; then
  body1="$WORK/fetch1.json"; body2="$WORK/fetch2.json"
  curl -fsS "$RECEIPT_URL" -o "$body1"; rc1=$?
  curl -fsS "$RECEIPT_URL" -o "$body2"; rc2=$?
  (( rc1 == 0 && rc2 == 0 )); expect verify "the public receipt URL is fetchable" $? "$RECEIPT_URL"
  if (( rc1 == 0 && rc2 == 0 )); then
    cmp -s "$body1" "$body2"
    expect verify "AC-FE-07 repeated fetches of the stable URL are byte-identical" $? \
      "sha256 $(sha256sum "$body1" | cut -d' ' -f1)"
  fi

  # The publisher may serve the receipt inside an envelope. Normalise ONCE,
  # here, so every later stage reads the same object the digest was taken over.
  if [[ -s "$body1" ]]; then
    receipt_unwrap_envelope "$body1" "$WORK/receipt.json" || true
  fi

  verify_out="$("$RMPC_BIN" receipt -c "$FUSION_RMPC_CONFIG" verify --receipt-url "$RECEIPT_URL" 2>&1)"
  vrc=$?
  keep "verify.json" "$verify_out"
  # Exit code AND envelope, for the same reason the govern stage checks both:
  # an rmpc subcommand can report `ok:false` without exiting non-zero, and a
  # verification reported as passed when it did not is the worst failure this
  # script can have.
  { (( vrc == 0 )) && jq -e '.ok == true' <<<"$verify_out" >/dev/null 2>&1; }
  expect verify "AC-CORE-02 core fetches the URL and verifies schema, canonical bytes, digest and every embedded signature" $? "exit $vrc; $verify_out"
  if (( vrc == 0 )) && jq -e '.ok == true' <<<"$verify_out" >/dev/null 2>&1; then
    RECEIPT_ID="$(jq -r '.receipt_id' <<<"$verify_out")"
    PAYLOAD_DIGEST="$(jq -r '.payload_digest' <<<"$verify_out")"
    jq -e '[.analyst_signatures[].verified] | length > 0 and all' <<<"$verify_out" >/dev/null
    expect verify "every embedded analyst signature verifies" $? \
      "$(jq -c '[.analyst_signatures[] | {member_id,verified}]' <<<"$verify_out")"
    if [[ -n "$EXPECTED_DIGEST" ]]; then
      [[ "$PAYLOAD_DIGEST" == "$EXPECTED_DIGEST" ]]
      expect verify "derived payload_digest equals --expected-digest" $? \
        "derived $PAYLOAD_DIGEST expected $EXPECTED_DIGEST"
    fi

    # AC-FMT-03: the weights are the allocation. An absent array is a FAILED
    # assertion, never a skipped one — a receipt with no weights cannot carry a
    # recommendation, and reporting that as "nothing to check" is how the
    # condition stays invisible.
    total="$(jq -r '[.weights[]?.weight_bps] | add // "null"' <"$WORK/receipt.json" 2>/dev/null)"
    [[ "$total" == "10000" ]]
    expect verify "AC-FMT-03 the receipt carries four bucket weights totalling exactly 10000 bps" $? \
      "weights total: $total (null means the receipt carries no weights array at all)"

    mapped=0; missing=""
    for i in 0 1 2 3; do
      bucket="$(jq -r --argjson i "$i" '.weights[$i]?.bucket // empty' <"$WORK/receipt.json")"
      [[ -n "$bucket" ]] || { missing+="bucket[$i] "; continue; }
      want="${VAULTS[$i]// /}"
      code="$("$CAST_BIN" code "$want" --rpc-url "$FUSION_RPC_URL" 2>/dev/null | tr -d '[:space:]')"
      [[ -n "$code" && "$code" != "0x" ]] && mapped=$((mapped+1)) || missing+="$bucket->$want "
    done
    (( mapped == 4 ))
    expect verify "AC-FMT-04 all four receipt buckets resolve to deployed devnet vault addresses" $? \
      "resolved $mapped/4${missing:+; unresolved: $missing}"
  fi
else
  record_assertion verify "stage not selected" SKIP "stages: $STAGES" not_selected
fi

# ── stage: negative ──────────────────────────────────────────────────────────
if have_stage negative; then
  if [[ ! -s "$WORK/receipt.json" ]]; then
    curl -fsS "$RECEIPT_URL" -o "$WORK/fetch1.json" || true
    if [[ -s "$WORK/fetch1.json" ]]; then
      receipt_unwrap_envelope "$WORK/fetch1.json" "$WORK/receipt.json" || true
    fi
  fi
  if [[ -s "$WORK/receipt.json" ]] && jq -e 'has("schema_version")' "$WORK/receipt.json" >/dev/null 2>&1; then

    jq '.analyst_signatures[0].signature = (.analyst_signatures[0].signature | .[0:1] as $h |
        (if $h == "A" then "B" else "A" end) + .[1:])' "$WORK/receipt.json" >"$WORK/neg-sig.json"
    "$RMPC_BIN" receipt -c "$FUSION_RMPC_CONFIG" verify --receipt-file "$WORK/neg-sig.json" >"$WORK/neg-sig.out" 2>&1
    nrc=$?
    { (( nrc != 0 )) || ! jq -e '.ok == true' "$WORK/neg-sig.out" >/dev/null 2>&1; }
    expect negative "AC-E2E-06 a tampered analyst signature is refused" $? \
      "exit $nrc; $(tr -d '\n' <"$WORK/neg-sig.out")"

    jq '.judge.rationale = "TAMPERED: move everything into the bucket the attacker controls."' \
      "$WORK/receipt.json" >"$WORK/neg-prose.json"
    if [[ -n "$PAYLOAD_DIGEST" ]]; then
      "$RMPC_BIN" receipt -c "$FUSION_RMPC_CONFIG" submit --receipt-file "$WORK/neg-prose.json" \
        --receipt-url "$RECEIPT_URL" --expected-digest "$PAYLOAD_DIGEST" >"$WORK/neg-prose.out" 2>&1
      prc=$?
      { (( prc != 0 )) && ! grep -q tx_hash "$WORK/neg-prose.out"; }
      expect negative "AC-CORE-02 tampered judge prose is refused against the expected digest and NO transaction is sent" $? \
        "$(tr -d '\n' <"$WORK/neg-prose.out")"
    else
      record_assertion negative "tampered judge prose" SKIP "no digest from the verify stage" prerequisite_failed
    fi

    # THE FOURTH NEGATIVE CASE: TAMPERED WEIGHTS (T15). The three cases above
    # tamper a signature, prose and the schema version, and none of them touches
    # the one field that becomes treasury calldata. 10000/0/0/0 is the whole
    # treasury into one bucket — the attack this gate exists to refuse.
    jq '.weights = [(.weights[0] | .weight_bps = 10000),
                    (.weights[1] | .weight_bps = 0),
                    (.weights[2] | .weight_bps = 0),
                    (.weights[3] | .weight_bps = 0)]' \
      "$WORK/receipt.json" >"$WORK/neg-weights.json" 2>/dev/null
    if [[ -s "$WORK/neg-weights.json" ]] && jq -e '[.weights[].weight_bps] == [10000,0,0,0]' \
         "$WORK/neg-weights.json" >/dev/null 2>&1; then
      if [[ -n "$PAYLOAD_DIGEST" ]]; then
        "$RMPC_BIN" receipt -c "$FUSION_RMPC_CONFIG" submit --receipt-file "$WORK/neg-weights.json" \
          --receipt-url "$RECEIPT_URL" --expected-digest "$PAYLOAD_DIGEST" >"$WORK/neg-weights.out" 2>&1
        wrc=$?
        { (( wrc != 0 )) && ! grep -q tx_hash "$WORK/neg-weights.out"; }
        expect negative "AC-FMT-03 a receipt whose weights were rewritten to 10000/0/0/0 is refused against the anchored digest and NO transaction is sent" $? \
          "exit $wrc; $(tr -d '\n' <"$WORK/neg-weights.out" | head -c 300)"
      else
        record_assertion negative "tampered weights refused against the anchored digest" SKIP \
          "no digest from the verify stage" prerequisite_failed
      fi

      # And it must never become a governance handoff: no propose_calldata.
      "$RMPC_BIN" governance -c "$FUSION_RMPC_CONFIG" draft-proposal \
        --receipt-id "${RECEIPT_ID:-0x}" --receipt-file "$WORK/neg-weights.json" \
        >"$WORK/neg-weights-draft.json" 2>&1
      ! jq -e '[.drafts[]? | select((.propose_calldata | type) == "string" and (.propose_calldata | length) > 0)]
               | length > 0' "$WORK/neg-weights-draft.json" >/dev/null 2>&1
      expect negative "AC-GOV-01 a weights-tampered receipt produces NO propose_calldata" $? \
        "$(head -c 300 "$WORK/neg-weights-draft.json")"
      keep "negative-tampered-weights.txt" "$(cat "$WORK/neg-weights.out" 2>/dev/null; cat "$WORK/neg-weights-draft.json" 2>/dev/null)"
    else
      record_assertion negative "tampered weights refused against the anchored digest" FAIL \
        "could not build the weights-tamper case: the receipt does not carry four weights"
    fi

    jq '.schema_version = "2.0"' "$WORK/receipt.json" >"$WORK/neg-schema.json"
    "$RMPC_BIN" receipt -c "$FUSION_RMPC_CONFIG" submit --receipt-file "$WORK/neg-schema.json" \
      --receipt-url "$RECEIPT_URL" >"$WORK/neg-schema.out" 2>&1
    src_rc=$?
    { (( src_rc != 0 )) && ! grep -q tx_hash "$WORK/neg-schema.out" \
      && grep -qi 'schema_version' "$WORK/neg-schema.out"; }
    expect negative "AC-FMT-06 an unsupported schema_version produces NO transaction and a diagnosable error" $? \
      "$(tr -d '\n' <"$WORK/neg-schema.out")"
    keep "negative-unsupported-schema.txt" "$(cat "$WORK/neg-schema.out")"
  else
    record_assertion negative "receipt-derived negative cases" FAIL "could not read the receipt bytes from $RECEIPT_URL"
  fi

  if [[ -n "${FUSION_UNAUTHORIZED_SUBMITTER:-}" && -n "$RECEIPT_ID" && -n "$PAYLOAD_DIGEST" ]]; then
    out="$("$CAST_BIN" call "$FUSION_GATEWAY_ADDRESS" \
      'consensusRecordReceipt(bytes32,bytes32,string)(uint256)' "$RECEIPT_ID" "$PAYLOAD_DIGEST" \
      "$RECEIPT_URL" --from "$FUSION_UNAUTHORIZED_SUBMITTER" --rpc-url "$FUSION_RPC_URL" 2>&1)"
    urc=$?
    (( urc != 0 ))
    expect negative "AC-CORE-01 an unauthorized submitter's gateway call reverts" $? "$(tr -d '\n' <<<"$out" | head -c 300)"
    if [[ -n "${FUSION_SUBMITTER_ADDRESS:-}" ]]; then
      out="$("$CAST_BIN" call "$FUSION_GATEWAY_ADDRESS" \
        'consensusRecordReceipt(bytes32,bytes32,string)(uint256)' "$RECEIPT_ID" "$PAYLOAD_DIGEST" \
        "$RECEIPT_URL" --from "$FUSION_SUBMITTER_ADDRESS" --rpc-url "$FUSION_RPC_URL" 2>&1)"
      crc=$?
      # Non-vacuity control. Once the receipt IS recorded the same call reverts
      # ReceiptAlreadyRecorded, which is also a correct answer here.
      { (( crc == 0 )) || grep -q 'ReceiptAlreadyRecorded' <<<"$out"; }
      expect negative "CONTROL the AUTHORIZED submitter's identical call is accepted, so the revert above is not vacuous" $? \
        "$(tr -d '\n' <<<"$out" | head -c 300)"
    else
      record_assertion negative "authorized-submitter control" SKIP \
        "FUSION_SUBMITTER_ADDRESS unset — the negative stage was SELECTED, so the control that keeps \
the unauthorized-submit revert non-vacuous did not run" unconfigured
    fi

    # A DIFFERENT IDENTITY FROM THE SUBMIT CASE, ON PURPOSE. Release is gated by
    # ADMIN_ROLE on the receipt contract, submission by AGENT_ROLE on the
    # gateway plus COMMITTEE_AGENT_ROLE on the IC policy. An EOA can easily lack
    # one and hold the other — the run's approver key holds ADMIN_ROLE and no
    # agent role — and reusing one address for both turns this assertion into a
    # ReceiptNotFound, which is not an authority refusal at all.
    releaser="${FUSION_UNAUTHORIZED_RELEASER:-$FUSION_UNAUTHORIZED_SUBMITTER}"
    out="$("$CAST_BIN" call "$FUSION_RECEIPT_ADDRESS" 'releaseReceipt(bytes32)' "$RECEIPT_ID" \
      --from "$releaser" --rpc-url "$FUSION_RPC_URL" 2>&1)"
    rrc=$?
    { (( rrc != 0 )) && grep -q 'AccessControlUnauthorizedAccount' <<<"$out"; }
    expect negative "AC-E2E-06 an unauthorized release by $releaser reverts on AUTHORITY, before receipt existence is consulted" $? \
      "$(tr -d '\n' <<<"$out" | head -c 300)"
  else
    # T11: the negative stage was SELECTED. A missing FUSION_UNAUTHORIZED_SUBMITTER
    # is unconfigured (the run is not green); a missing receipt id means an earlier
    # assertion already FAILED and is carried by `failed > 0`.
    if [[ -z "${FUSION_UNAUTHORIZED_SUBMITTER:-}" ]]; then
      record_assertion negative "unauthorized submit/release" SKIP \
        "FUSION_UNAUTHORIZED_SUBMITTER is unset and the negative stage was selected" unconfigured
    else
      record_assertion negative "unauthorized submit/release" SKIP \
        "the verify stage produced no receipt id or digest" prerequisite_failed
    fi
  fi

  assert_witnesses_unchanged negative "after every negative case"
else
  record_assertion negative "stage not selected" SKIP "stages: $STAGES" not_selected
fi

# ── stage: record ────────────────────────────────────────────────────────────
# The INV-4 window for the write stages opens here, not at script start.
W_PRE_WRITE="$W_START"
if have_stage record || have_stage release; then
  W_PRE_WRITE="$(witnesses)"
  keep "witnesses-before-writes.txt" "$W_PRE_WRITE"
fi

if have_stage record; then
  if [[ -z "$RECEIPT_ID" ]]; then
    record_assertion record "anchor the digest" FAIL "the verify stage did not produce a receipt id"
  else
    FUSION_RECEIPT_URL="$RECEIPT_URL" FUSION_MAX_ATTEMPTS="${FUSION_MAX_ATTEMPTS:-5}" \
      "$HERE/submit-receipt-worker.sh" >"$WORK/record.out" 2>&1
    wrc=$?
    keep "record-worker.txt" "$(cat "$WORK/record.out")"
    (( wrc == 0 )); expect record "AC-CORE-09 the retrying, idempotent submit worker anchors the digest" $? \
      "$(tail -c 400 "$WORK/record.out")"

    recorded="$("$CAST_BIN" call "$FUSION_RECEIPT_ADDRESS" 'isRecorded(bytes32)(bool)' "$RECEIPT_ID" \
      --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"
    [[ "$recorded" == "true" ]]
    expect record "AC-E2E-02 the receipt id is recorded on chain" $? "isRecorded=$recorded"

    tuple="$("$CAST_BIN" call "$FUSION_RECEIPT_ADDRESS" \
      'getReceiptById(bytes32)((bytes32,bytes32,string,address,uint64,uint64,bool))' "$RECEIPT_ID" \
      --rpc-url "$FUSION_RPC_URL" 2>&1)"
    keep "record-onchain-tuple.txt" "$tuple"
    # T16: FIELD-EXACT, not a substring of the decoded struct. The tuple carries
    # receiptId, payloadDigest AND the operator-supplied payloadUri, so
    # `grep -qi -- "${PAYLOAD_DIGEST#0x}"` over the whole thing reports PASS for a
    # tuple whose real digest field is wrong but whose content-addressed URI
    # carries the right one — and this run's own watcher template is
    # `{receipt_id}.json`, one convention change from exactly that. This is the
    # comparison submit-receipt-worker.sh already implements and explains.
    # Receipt(bytes32 receiptId, bytes32 payloadDigest, string payloadUri, ...):
    # both leading fields are fixed-width hex, so the first two commas delimit
    # payloadDigest regardless of what the URI contains.
    anchored_digest="$(tr -d '() \n' <<<"$tuple" | cut -d, -f2 | tr '[:upper:]' '[:lower:]')"
    { [[ "$anchored_digest" =~ ^0x[0-9a-f]{64}$ ]] && [[ "$anchored_digest" == "${PAYLOAD_DIGEST,,}" ]]; }
    expect record "the stored payloadDigest FIELD equals the digest core derived from the URL" $? \
      "payloadDigest field: ${anchored_digest:-<unparseable>}; derived: $PAYLOAD_DIGEST; tuple: $(tr -d '\n' <<<"$tuple" | head -c 200)"
    grep -qF -- "$RECEIPT_URL" <<<"$tuple"
    expect record "the stored payloadUri is the public URL that served those bytes" $? "$(tr -d '\n' <<<"$tuple" | head -c 300)"
  fi
else
  record_assertion record "stage not selected" SKIP "stages: $STAGES" not_selected
fi

# ── stage: index ─────────────────────────────────────────────────────────────
if have_stage index; then
  if [[ -z "${FUSION_EXPLORER_API:-}" ]]; then
    record_assertion index "indexer and API convergence" SKIP \
      "FUSION_EXPLORER_API is unset and the index stage was selected" unconfigured
  elif [[ -z "$RECEIPT_ID" ]]; then
    record_assertion index "indexer and API convergence" SKIP \
      "no receipt id — an earlier stage already failed" prerequisite_failed
  else
    deadline=$(( $(date +%s) + INDEX_TIMEOUT ))
    api=""
    while (( $(date +%s) < deadline )); do
      api="$(curl -fsS "${FUSION_EXPLORER_API%/}/v1/consensus-receipts/$RECEIPT_ID" 2>/dev/null)" && \
        printf '%s' "$api" >"$WORK/index-api-poll.json" && \
        explorer_api_row "$WORK/index-api-poll.json" >/dev/null 2>&1 && break
      api=""; sleep 5
    done
    keep "index-api.json" "${api:-<no answer within ${INDEX_TIMEOUT}s>}"
    [[ -n "$api" ]]
    expect index "AC-CORE-06 the record appears in the index under the declared confirmation policy" $? \
      "within ${INDEX_TIMEOUT}s"
    if [[ -n "$api" ]]; then
      # T16: the API body echoes payload_uri too, so a substring match passes on a
      # body whose payload_digest is wrong and whose URL happens to carry the digest.
      jq -e --arg d "$PAYLOAD_DIGEST" \
        '((.payload_digest // .receipt.payload_digest) | ascii_downcase) == ($d | ascii_downcase)' \
        <<<"$api" >/dev/null 2>&1
      expect index "AC-CORE-07 the explorer API reports the same payload digest FIELD as the chain" $? \
        "api payload_digest: $(jq -r '.payload_digest // .receipt.payload_digest // "<absent>"' <<<"$api" 2>/dev/null); chain: $PAYLOAD_DIGEST"
      jq -e --arg u "$RECEIPT_URL" '(.payload_uri // .receipt.payload_uri) == $u' <<<"$api" >/dev/null 2>&1
      expect index "AC-CORE-07 the explorer API reports the same payload URL FIELD as the chain" $? \
        "api payload_uri: $(jq -r '.payload_uri // .receipt.payload_uri // "<absent>"' <<<"$api" 2>/dev/null); chain: $RECEIPT_URL"
      # THE INDEXER'S OWN VERIFICATION, AND ITS ONE-SHOT TRAP. The indexer fetches
      # payload_uri and recomputes the digest on its FIRST scan of the
      # ReceiptRecorded event, and stores verified=false PERMANENTLY if that fetch
      # fails — it does not retry. So the anchored URL must be reachable FROM
      # INSIDE the indexer's container network before the anchor is indexed, not
      # merely from the machine running this script. A false here is not a
      # transient: it is a row that will never become true without a reindex.
      printf '%s' "$api" >"$WORK/index-api.json"
      explorer_api_flag_is_true "$WORK/index-api.json" verified
      expect index "AC-CORE-07 the indexer independently re-fetched the payload URL and reproduced the digest (verified=true)" $? \
        "verified=$(explorer_api_field "$WORK/index-api.json" verified 2>/dev/null); if false, the indexer could not reach \
the anchored URL from inside its own network on the first scan, and the row will NOT self-heal"
    fi
  fi
else
  record_assertion index "stage not selected" SKIP "stages: $STAGES" not_selected
fi

# ── stage: release ───────────────────────────────────────────────────────────
if have_stage release; then
  if [[ -z "${FUSION_RELEASE_KEYSTORE:-}" || -z "${FUSION_RELEASE_PASSWORD_FILE:-}" \
        || -z "${FUSION_RELEASE_ADDRESS:-}" ]]; then
    record_assertion release "admin release" SKIP \
      "the release stage was SELECTED but FUSION_RELEASE_KEYSTORE / FUSION_RELEASE_PASSWORD_FILE / \
FUSION_RELEASE_ADDRESS are not all set" unconfigured
  elif [[ -z "$RECEIPT_ID" ]]; then
    record_assertion release "admin release" SKIP \
      "no receipt id — an earlier stage already failed" prerequisite_failed
  else
    # IDEMPOTENT, BECAUSE THIS SCRIPT IS REQUIRED TO BE RUN TWICE.
    # AC-E2E-05 asks for a repeatable test, and the bundle wording invokes this
    # path twice against the SAME receipt. `releaseReceipt` is a one-shot state
    # transition: a second send reverts ReceiptAlreadyReleased, and asserting on
    # a fresh status 0x1 would have failed the second run for doing exactly what
    # a released receipt should do. The record stage has been idempotent from the
    # start (submit-receipt-worker.sh reports `already_anchored` and broadcasts
    # nothing); the release stage was not, and that asymmetry only shows up on a
    # second run. Reading the state FIRST is also what an operator does.
    already_released="$("$CAST_BIN" call "$FUSION_RECEIPT_ADDRESS" 'isReleased(bytes32)(bool)' \
      "$RECEIPT_ID" --rpc-url "$FUSION_RPC_URL" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$already_released" == "true" ]]; then
      keep "release-tx.json" "{\"action\":\"already_released\",\"receipt_id\":\"$RECEIPT_ID\"}"
      record_assertion release \
        "AC-CORE-03 the admin release transaction succeeds (idempotent no-op: already released, no second transaction sent)" \
        PASS "isReleased=true before this run; releaseReceipt was NOT re-broadcast"
    else
      "$CAST_BIN" send "$FUSION_RECEIPT_ADDRESS" 'releaseReceipt(bytes32)' "$RECEIPT_ID" \
        --rpc-url "$FUSION_RPC_URL" --keystore "$FUSION_RELEASE_KEYSTORE" \
        --password-file "$FUSION_RELEASE_PASSWORD_FILE" --json >"$WORK/release.json" 2>&1
      rel=$?
      keep "release-tx.json" "$(cat "$WORK/release.json")"
      { (( rel == 0 )) && [[ "$(jq -r '.status // empty' "$WORK/release.json" 2>/dev/null)" == "0x1" ]]; }
      expect release "AC-CORE-03 the admin release transaction succeeds" $? "$(head -c 300 "$WORK/release.json")"
    fi

    released="$("$CAST_BIN" call "$FUSION_RECEIPT_ADDRESS" 'isReleased(bytes32)(bool)' "$RECEIPT_ID" \
      --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"
    [[ "$released" == "true" ]]
    expect release "AC-E2E-03 the receipt reads as released" $? "isReleased=$released"

    # The two duplicate refusals that cannot exist until something is anchored.
    # `--from` is the OPERATOR-DECLARED admin address, not an address scraped out
    # of the keystore file: keystore layouts differ (an `rmpc` keystore carries
    # no `address` key at all), and an empty `--from` would make this assertion
    # fail for the wrong reason — a diagnosable false failure, but still a lie
    # about which check was exercised.
    out="$("$CAST_BIN" call "$FUSION_RECEIPT_ADDRESS" 'releaseReceipt(bytes32)' "$RECEIPT_ID" \
      --from "$FUSION_RELEASE_ADDRESS" --rpc-url "$FUSION_RPC_URL" 2>&1)"
    grep -q 'ReceiptAlreadyReleased' <<<"$out"
    expect release "AC-CORE-03 a duplicate release is rejected (ReceiptAlreadyReleased)" $? "$(tr -d '\n' <<<"$out" | head -c 300)"

    if [[ -n "${FUSION_SUBMITTER_ADDRESS:-}" ]]; then
      out="$("$CAST_BIN" call "$FUSION_GATEWAY_ADDRESS" \
        'consensusRecordReceipt(bytes32,bytes32,string)(uint256)' "$RECEIPT_ID" "$PAYLOAD_DIGEST" \
        "$RECEIPT_URL" --from "$FUSION_SUBMITTER_ADDRESS" --rpc-url "$FUSION_RPC_URL" 2>&1)"
      grep -q 'ReceiptAlreadyRecorded' <<<"$out"
      expect release "AC-E2E-06 a duplicate record of the same receipt id is rejected (ReceiptAlreadyRecorded)" $? \
        "$(tr -d '\n' <<<"$out" | head -c 300)"
    else
      record_assertion release "duplicate record" SKIP \
        "FUSION_SUBMITTER_ADDRESS unset and the release stage was selected" unconfigured
    fi

    # AC-CORE-07's release clause: the public API must agree that it is released,
    # under the same confirmation policy the index stage waited on.
    if [[ -n "${FUSION_EXPLORER_API:-}" ]]; then
      deadline=$(( $(date +%s) + INDEX_TIMEOUT )); rel_api=""
      while (( $(date +%s) < deadline )); do
        rel_api="$(curl -fsS "${FUSION_EXPLORER_API%/}/v1/consensus-receipts/$RECEIPT_ID" 2>/dev/null)" && \
          printf '%s' "$rel_api" >"$WORK/release-api-poll.json" && \
          explorer_api_flag_is_true "$WORK/release-api-poll.json" released && break
        rel_api=""; sleep 5
      done
      keep "release-api.json" "${rel_api:-<not released in the API within ${INDEX_TIMEOUT}s>}"
      [[ -n "$rel_api" ]]
      expect release "AC-CORE-07 the public API reports the receipt as released" $? "within ${INDEX_TIMEOUT}s"
    else
      record_assertion release "API release state" SKIP \
        "FUSION_EXPLORER_API unset and the release stage was selected" unconfigured
    fi
  fi
else
  record_assertion release "stage not selected" SKIP "stages: $STAGES" not_selected
fi

# ── stage: dapp ──────────────────────────────────────────────────────────────
if have_stage dapp; then
  if [[ -z "${FUSION_DAPP_URL:-}" ]]; then
    record_assertion dapp "dapp surface" SKIP \
      "FUSION_DAPP_URL unset and the dapp stage was selected" unconfigured
  else
    code="$(curl -s -o "$WORK/dapp.html" -w '%{http_code}' "$FUSION_DAPP_URL")"
    [[ "$code" == "200" ]]
    expect dapp "the dapp is served" $? "HTTP $code from $FUSION_DAPP_URL"
    keep "dapp-index.html" "$(head -c 4000 "$WORK/dapp.html")"
    record_assertion dapp \
      "AC-CORE-08 released / not-applied rendering and signature labelling" SKIP \
      "requires the Playwright spec clients/dapp/tests/e2e/consensus-receipts.spec.ts against \
this deployment; this script asserts reachability only and must not report the browser \
assertions as passed" delegated
  fi
else
  record_assertion dapp "stage not selected" SKIP "stages: $STAGES" not_selected
fi

# ── stage: govern ────────────────────────────────────────────────────────────
if have_stage govern; then
  if [[ -z "$RECEIPT_ID" ]]; then
    record_assertion govern "governance draft" SKIP \
      "no receipt id — an earlier stage already failed" prerequisite_failed
  else
    proposals_before="$("$CAST_BIN" call "$FUSION_GOVERNANCE_ADDRESS" 'currentProposalId()(uint256)' \
      --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"
    "$RMPC_BIN" governance -c "$FUSION_RMPC_CONFIG" draft-proposal --receipt-id "$RECEIPT_ID" \
      --receipt-file "$WORK/receipt.json" >"$WORK/draft.json" 2>&1
    drc=$?
    keep "governance-draft.json" "$(cat "$WORK/draft.json")"
    # ASSERT ON THE ENVELOPE, NOT ON THE EXIT CODE.
    #
    # In SCAN mode (`--from-block`, what the draft watcher runs) `rmpc
    # governance draft-proposal` exits 0 for the range while reporting each
    # undraftable receipt as a `"refused"` entry inside `.drafts[]`, so one
    # poison receipt cannot wedge the cursor; the watcher reads those entries
    # rather than the exit code (see watch-released-drafts.sh). In
    # SINGLE-RECEIPT mode, which is what this stage uses, a content refusal
    # exits 2 and a transport/RPC failure exits 3.
    #
    # Neither shape may be read from `$?` alone here: an ok:false envelope with
    # a zero exit was measured against the rc.1 stand-in during QA step 3.8,
    # which is how this was found, and the exit codes are the producer's
    # contract rather than this script's. Both are therefore checked — the exit
    # code AND `.ok`.
    { (( drc == 0 )) && jq -e '.ok == true' "$WORK/draft.json" >/dev/null 2>&1; }
    expect govern "AC-GOV-01 release produces a governance handoff result" $? \
      "exit $drc; $(head -c 400 "$WORK/draft.json")"
    if jq -e '.ok == true' "$WORK/draft.json" >/dev/null 2>&1; then
      # T15. `length <= 1` exits 0 for `drafts: []` AND for
      # `[{"status":"refused"}]`, so the headline claim — "the release produced
      # exactly one reviewable draft whose calldata decodes to those same four
      # vaults and four weights" — could not be distinguished from "the release
      # produced no draft at all". Assert the SHAPE.
      jq -e '(.drafts | length) == 1 and .drafts[0].status == "ready_for_review"
             and (.drafts[0].vaults | length) == 4
             and ([.drafts[0].vaults[].weight_bps] | add) == 10000
             and (.drafts[0].propose_calldata | type) == "string"
             and (.drafts[0].propose_calldata | length) > 0' "$WORK/draft.json" >/dev/null 2>&1
      expect govern "AC-GOV-01 EXACTLY ONE ready_for_review draft over four vaults whose bps total 10000 and which carries propose_calldata" $? \
        "$(jq -c '{n:(.drafts|length),status:[.drafts[]?.status],vaults:(.drafts[0].vaults|length?),
                   bps:[.drafts[0].vaults[]?.weight_bps],calldata:(.drafts[0].propose_calldata|type?)}' \
             "$WORK/draft.json" 2>/dev/null)"

      # AND THE BPS MUST BE THE RECEIPT'S OWN, IN CANONICAL BUCKET ORDER. The
      # weights are the one field that becomes treasury calldata and the one the
      # analyst signature check cannot cover (T01, T02): a draft that totals
      # 10000 over the WRONG four numbers satisfies every assertion above.
      draft_bps="$(jq -c '[.drafts[0].vaults[]?.weight_bps]' "$WORK/draft.json" 2>/dev/null)"
      receipt_bps="$(jq -c '[.weights[]?.weight_bps]' "$WORK/receipt.json" 2>/dev/null)"
      { [[ -n "$receipt_bps" && "$receipt_bps" != "[]" && "$draft_bps" == "$receipt_bps" ]]; }
      expect govern "AC-FMT-04 the drafted bps equal the receipt's weights in canonical bucket order" $? \
        "draft: ${draft_bps:-<none>}; receipt: ${receipt_bps:-<none>} (canonical order: \
conservative_defi_yield, protocol_tokens, agent_tokens, real_world_assets)"
    fi
    proposals_after="$("$CAST_BIN" call "$FUSION_GOVERNANCE_ADDRESS" 'currentProposalId()(uint256)' \
      --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"
    [[ "$proposals_before" == "$proposals_after" ]]
    expect govern "AC-E2E-04 drafting submits NO on-chain proposal" $? \
      "currentProposalId $proposals_before -> $proposals_after"
  fi
else
  record_assertion govern "stage not selected" SKIP "stages: $STAGES" not_selected
fi

# ── final INV-4 comparison across the whole run ──────────────────────────────
if have_stage record || have_stage release; then
  assert_witnesses_unchanged final "across record and release (AC-CORE-04, AC-E2E-03)" "$W_PRE_WRITE"
fi

# ── machine-readable result ──────────────────────────────────────────────────
jq -s --arg url "$RECEIPT_URL" --arg receipt_id "$RECEIPT_ID" --arg digest "$PAYLOAD_DIGEST" \
      --arg stages "$STAGES" --arg started "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg chain "$("$CAST_BIN" chain-id --rpc-url "$FUSION_RPC_URL" 2>/dev/null | tr -d '[:space:]')" \
  '{schema:"fusion-devnet-acceptance/1",
    completed_at:$started, chain_id:$chain, stages_run:($stages|split(" ")),
    receipt_url:$url, receipt_id:$receipt_id, payload_digest:$digest,
    assertions:.,
    summary:{total:length,
             passed:[.[]|select(.result=="PASS")]|length,
             failed:[.[]|select(.result=="FAIL")]|length,
             skipped:[.[]|select(.result=="SKIP")]|length,
             skipped_not_selected:[.[]|select(.result=="SKIP" and .reason=="not_selected")]|length,
             skipped_unconfigured:[.[]|select(.result=="SKIP" and .reason=="unconfigured")]|length,
             skipped_prerequisite_failed:[.[]|select(.result=="SKIP" and .reason=="prerequisite_failed")]|length,
             skipped_delegated:[.[]|select(.result=="SKIP" and .reason=="delegated")]|length},
    # T11: THE VERDICT DERIVES FROM EVERY SELECTED STAGE, NOT FROM THE FAIL COUNT.
    # `ok:([.[]|select(.result=="FAIL")]|length==0)` made SKIP invisible: four
    # stages selected with none of their config supplied SKIPped every assertion
    # and reported {failed:0, ok:true, exit 0}. A stage the operator ASKED FOR
    # whose config is missing did not run, and a run that did not run the gate is
    # not a green gate.
    ok:(([.[]|select(.result=="FAIL")]|length==0)
        and ([.[]|select(.result=="SKIP" and .reason=="unconfigured")]|length==0))}' \
  "$WORK/assertions.ndjson" >"$RESULT_FILE"

printf '\n%s\n' "result: $RESULT_FILE"
jq -c '.summary' "$RESULT_FILE"
if (( SKIPPED_UNCONFIGURED > 0 )); then
  echo "$SKIPPED_UNCONFIGURED selected stage(s) were SKIPPED for missing configuration — \
the assertions you asked for did not run; this is NOT a pass" >&2
fi
if (( INV4_STARTUP_UNREADABLE != 0 )); then
  echo "INV-4 witnesses were unreadable at startup (see above)" >&2
fi
if (( FAILED != 0 || SKIPPED_UNCONFIGURED != 0 || INV4_STARTUP_UNREADABLE != 0 )); then
  exit 1
fi
exit 0
