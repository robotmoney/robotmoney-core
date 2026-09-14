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
record_assertion() { # <stage> <id> <PASS|FAIL|SKIP> <detail>
  jq -cn --arg stage "$1" --arg id "$2" --arg result "$3" --arg detail "$4" \
    '{stage:$stage,assertion:$id,result:$result,detail:$detail}' >>"$WORK/assertions.ndjson"
  case "$3" in
    PASS) printf 'PASS  [%s] %s\n' "$1" "$2" ;;
    SKIP) printf 'SKIP  [%s] %s — %s\n' "$1" "$2" "$4" ;;
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
  local v out
  out="proposals=$("$CAST_BIN" call "$FUSION_GOVERNANCE_ADDRESS" 'currentProposalId()(uint256)' \
        --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"$'\n'
  out+="weights=$("$CAST_BIN" call "$FUSION_ROUTER_ADDRESS" 'getWeights()(address[],uint256[])' \
        --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"$'\n'
  for v in "${VAULTS[@]}"; do
    v="${v// /}"
    out+="assets:$v=$("$CAST_BIN" call "$v" 'totalAssets()(uint256)' --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"$'\n'
    out+="supply:$v=$("$CAST_BIN" call "$v" 'totalSupply()(uint256)' --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"$'\n'
  done
  printf '%s' "$out"
}
W_START="$(witnesses)"
keep "witnesses-before.txt" "$W_START"

# `assert_witnesses_unchanged` compares against a BASELINE VARIABLE, not always
# against the script's first reading, and the difference is deliberate. A mapped
# vault with a live yield adapter accrues: rmUSDC on devnet 918453 was measured
# moving 1000004 -> 1000008 (4 units of 1e-6 USDC) over about 50 idle minutes
# with no receipt within a thousand blocks. Comparing the end of a long run
# against a snapshot taken before the negative stage would therefore report
# accrual as an INV-4 breach — a FALSE failure, which erodes the gate exactly as
# badly as a false pass.
#
# The criterion is NOT softened: the comparison is still exact equality, and no
# tolerance is introduced. What changes is the WINDOW. Record and release are
# what INV-4 is about, so the witnesses bracketing them are read immediately
# before the record stage and immediately after the last write stage, which is
# the narrowest honest window. The failure message names the confound so a
# one-unit drift on a yield-bearing vault is diagnosed rather than mistaken for
# a signalling-path asset movement.
assert_witnesses_unchanged() { # <stage> <label> [baseline]
  local now diff baseline
  baseline="${3:-$W_START}"
  now="$(witnesses)"
  diff="$(diff <(printf '%s' "$baseline") <(printf '%s' "$now") || true)"
  [[ -z "$diff" ]]
  expect "$1" "$2 — vault balances, router weights and proposal count unchanged (INV-4)" $? \
    "${diff:-no allocation-state witness moved}${diff:+
NOTE: a mapped vault with a yield adapter accrues on its own. If the ONLY \
movement is a small totalAssets/totalSupply drift on a yield-bearing vault, \
attribute it before calling it an INV-4 breach; proposal count and router \
weights cannot drift and any movement there is real.}"
  keep "witnesses-after-$1.txt" "$now"
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
    if jq -e 'has("schema_version")' "$body1" >/dev/null 2>&1; then
      cp "$body1" "$WORK/receipt.json"
    else
      jq -e '.receipt | has("schema_version")' "$body1" >/dev/null 2>&1 \
        && jq '.receipt' "$body1" >"$WORK/receipt.json" || cp "$body1" "$WORK/receipt.json"
    fi
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
  record_assertion verify "stage not selected" SKIP "stages: $STAGES"
fi

# ── stage: negative ──────────────────────────────────────────────────────────
if have_stage negative; then
  if [[ ! -s "$WORK/receipt.json" ]]; then
    curl -fsS "$RECEIPT_URL" -o "$WORK/fetch1.json" || true
    if [[ -s "$WORK/fetch1.json" ]]; then
      jq -e 'has("schema_version")' "$WORK/fetch1.json" >/dev/null 2>&1 \
        && cp "$WORK/fetch1.json" "$WORK/receipt.json" \
        || jq '.receipt' "$WORK/fetch1.json" >"$WORK/receipt.json"
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
      record_assertion negative "tampered judge prose" SKIP "no digest from the verify stage"
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
      record_assertion negative "authorized-submitter control" SKIP "FUSION_SUBMITTER_ADDRESS unset"
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
    record_assertion negative "unauthorized submit/release" SKIP \
      "needs FUSION_UNAUTHORIZED_SUBMITTER and a verified receipt"
  fi

  assert_witnesses_unchanged negative "after every negative case"
else
  record_assertion negative "stage not selected" SKIP "stages: $STAGES"
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
    grep -qi -- "${PAYLOAD_DIGEST#0x}" <<<"$tuple"
    expect record "the stored payloadDigest equals the digest core derived from the URL" $? "$(tr -d '\n' <<<"$tuple" | head -c 300)"
    grep -qF -- "$RECEIPT_URL" <<<"$tuple"
    expect record "the stored payloadUri is the public URL that served those bytes" $? "$(tr -d '\n' <<<"$tuple" | head -c 300)"
  fi
else
  record_assertion record "stage not selected" SKIP "stages: $STAGES"
fi

# ── stage: index ─────────────────────────────────────────────────────────────
if have_stage index; then
  if [[ -z "${FUSION_EXPLORER_API:-}" || -z "$RECEIPT_ID" ]]; then
    record_assertion index "indexer and API convergence" SKIP "needs FUSION_EXPLORER_API and a recorded receipt"
  else
    deadline=$(( $(date +%s) + INDEX_TIMEOUT ))
    api=""
    while (( $(date +%s) < deadline )); do
      api="$(curl -fsS "${FUSION_EXPLORER_API%/}/v1/consensus-receipts/$RECEIPT_ID" 2>/dev/null)" && \
        jq -e '.receipt_id? // .receipt?.receipt_id? // empty' <<<"$api" >/dev/null 2>&1 && break
      api=""; sleep 5
    done
    keep "index-api.json" "${api:-<no answer within ${INDEX_TIMEOUT}s>}"
    [[ -n "$api" ]]
    expect index "AC-CORE-06 the record appears in the index under the declared confirmation policy" $? \
      "within ${INDEX_TIMEOUT}s"
    if [[ -n "$api" ]]; then
      grep -qi -- "${PAYLOAD_DIGEST#0x}" <<<"$api"
      expect index "AC-CORE-07 the explorer API reports the same payload digest as the chain" $? "$(head -c 300 <<<"$api")"
      grep -qF -- "$RECEIPT_URL" <<<"$api"
      expect index "AC-CORE-07 the explorer API reports the same payload URL as the chain" $? "$(head -c 300 <<<"$api")"
    fi
  fi
else
  record_assertion index "stage not selected" SKIP "stages: $STAGES"
fi

# ── stage: release ───────────────────────────────────────────────────────────
if have_stage release; then
  if [[ -z "${FUSION_RELEASE_KEYSTORE:-}" || -z "${FUSION_RELEASE_PASSWORD_FILE:-}" \
        || -z "${FUSION_RELEASE_ADDRESS:-}" || -z "$RECEIPT_ID" ]]; then
    record_assertion release "admin release" SKIP \
      "needs FUSION_RELEASE_KEYSTORE, FUSION_RELEASE_PASSWORD_FILE, FUSION_RELEASE_ADDRESS \
and a recorded receipt"
  else
    "$CAST_BIN" send "$FUSION_RECEIPT_ADDRESS" 'releaseReceipt(bytes32)' "$RECEIPT_ID" \
      --rpc-url "$FUSION_RPC_URL" --keystore "$FUSION_RELEASE_KEYSTORE" \
      --password-file "$FUSION_RELEASE_PASSWORD_FILE" --json >"$WORK/release.json" 2>&1
    rel=$?
    keep "release-tx.json" "$(cat "$WORK/release.json")"
    { (( rel == 0 )) && [[ "$(jq -r '.status // empty' "$WORK/release.json" 2>/dev/null)" == "0x1" ]]; }
    expect release "AC-CORE-03 the admin release transaction succeeds" $? "$(head -c 300 "$WORK/release.json")"

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
      record_assertion release "duplicate record" SKIP "FUSION_SUBMITTER_ADDRESS unset"
    fi
  fi
else
  record_assertion release "stage not selected" SKIP "stages: $STAGES"
fi

# ── stage: dapp ──────────────────────────────────────────────────────────────
if have_stage dapp; then
  if [[ -z "${FUSION_DAPP_URL:-}" ]]; then
    record_assertion dapp "dapp surface" SKIP "FUSION_DAPP_URL unset"
  else
    code="$(curl -s -o "$WORK/dapp.html" -w '%{http_code}' "$FUSION_DAPP_URL")"
    [[ "$code" == "200" ]]
    expect dapp "the dapp is served" $? "HTTP $code from $FUSION_DAPP_URL"
    keep "dapp-index.html" "$(head -c 4000 "$WORK/dapp.html")"
    record_assertion dapp \
      "AC-CORE-08 released / not-applied rendering and signature labelling" SKIP \
      "requires the Playwright spec clients/dapp/tests/e2e/consensus-receipts.spec.ts against \
this deployment; this script asserts reachability only and must not report the browser \
assertions as passed"
  fi
else
  record_assertion dapp "stage not selected" SKIP "stages: $STAGES"
fi

# ── stage: govern ────────────────────────────────────────────────────────────
if have_stage govern; then
  if [[ -z "$RECEIPT_ID" ]]; then
    record_assertion govern "governance draft" SKIP "no receipt id"
  else
    proposals_before="$("$CAST_BIN" call "$FUSION_GOVERNANCE_ADDRESS" 'currentProposalId()(uint256)' \
      --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"
    "$RMPC_BIN" governance -c "$FUSION_RMPC_CONFIG" draft-proposal --receipt-id "$RECEIPT_ID" \
      --receipt-file "$WORK/receipt.json" >"$WORK/draft.json" 2>&1
    drc=$?
    keep "governance-draft.json" "$(cat "$WORK/draft.json")"
    # ASSERT ON THE ENVELOPE, NOT ON THE EXIT CODE. `rmpc governance
    # draft-proposal` deliberately EXITS 0 while reporting `{"ok":false, …}` for
    # a per-receipt content refusal, so that one undraftable receipt cannot wedge
    # the range scan the draft watcher runs (see watch-released-drafts.sh). That
    # is correct there and a trap here: checking `$?` alone would have reported
    # `{"ok":false,"error":"ErrReceiptNotReleased"}` as a PASS. Measured against
    # the rc.1 stand-in during QA step 3.8, which is how this was found.
    { (( drc == 0 )) && jq -e '.ok == true' "$WORK/draft.json" >/dev/null 2>&1; }
    expect govern "AC-GOV-01 release produces a governance handoff result" $? \
      "exit $drc; $(head -c 400 "$WORK/draft.json")"
    if jq -e '.ok == true' "$WORK/draft.json" >/dev/null 2>&1; then
      jq -e '.drafts | length <= 1' "$WORK/draft.json" >/dev/null
      expect govern "AC-GOV-01 at most ONE human-reviewable draft is produced" $? \
        "$(jq -c '[.drafts[]?.status]' "$WORK/draft.json")"
    fi
    proposals_after="$("$CAST_BIN" call "$FUSION_GOVERNANCE_ADDRESS" 'currentProposalId()(uint256)' \
      --rpc-url "$FUSION_RPC_URL" 2>&1 | tr -d '[:space:]')"
    [[ "$proposals_before" == "$proposals_after" ]]
    expect govern "AC-E2E-04 drafting submits NO on-chain proposal" $? \
      "currentProposalId $proposals_before -> $proposals_after"
  fi
else
  record_assertion govern "stage not selected" SKIP "stages: $STAGES"
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
             skipped:[.[]|select(.result=="SKIP")]|length},
    ok:([.[]|select(.result=="FAIL")]|length==0)}' \
  "$WORK/assertions.ndjson" >"$RESULT_FILE"

printf '\n%s\n' "result: $RESULT_FILE"
jq -c '.summary' "$RESULT_FILE"
exit "$FAILED"
