#!/usr/bin/env bash
# Self-tests for the Fusion acceptance harnesses in scripts/fusion/.
#
# WHY THESE EXIST
# ---------------
# project-fusion.md AC-CORE-09 requires the submitter to be "retryable/idempotent".
# That property lives in shell, and it is exactly the kind of claim that is
# asserted in a comment and never executed. These tests execute it, along with
# the acceptance harnesses' refusal paths.
#
# Issue 1698 deleted the released-receipt draft watcher (watch-released-drafts.sh
# and its systemd units) and every `rmpc governance draft-proposal` step: a
# consensus receipt is applied by RouterGovernance.applyReceipt (publish
# contracts govern row apply-receipt), which releases it and sets the router
# weights in one call, so there is no proposal and nothing to draft.
#
# HOW
# ---
# `rmpc` and `cast` are replaced by stub binaries on PATH whose behavior is driven
# by files in a scratch directory, so an attempt, a chain state and a failure are
# all observable without a node. The negative control matters most: the
# --no-anchor test asserts the stub `rmpc` was NEVER invoked with a write
# subcommand, which is a claim no amount of reading the script can settle.
#
# Usage: scripts/fusion/tests/run-tests.sh   (exit 0 = all passed)
set -uo pipefail

FUSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$FUSION_DIR/../.." && pwd)"

# MINIMUM EXECUTED-ASSERTION FLOOR
# -------------------------------
# This suite runs under `set -uo pipefail` WITHOUT `-e`, and used to end at
# `[[ "$FAIL" -eq 0 ]]`. That is a false-green generator: truncate the file, or
# let a block abort early, and the run prints "42 passed, 0 failed" and exits 0.
# Reproduced by deleting the 12-assertion devnet-acceptance.sh block. "Exit 0"
# is not "tested" -- the number of assertions that ACTUALLY executed is the only
# thing that distinguishes the two, so the exit code now depends on it.
#
# The floor is the FULL count as of the commit that last raised it, so it is
# exactly equal to what a healthy run executes and leaves no slack a truncation
# could hide in. It was 55, then 63; the round-2 harness cycle (T10, T11, T15,
# T16, T25, T29) adds the guards below; merging the T01/T07/T09 watcher guards with them at
# integration took the union to 156, and merging with r2/wf1-verify-fixes (the decoy check
# and explorer-API block) raises the total to 170, and the timelock-sourced duplicate-release probe
# check (issue 1647) makes it 171. Issue 1698 deleted the draft watcher and every
# draft-proposal assertion; with the govern-stage weight-setter checks that
# replace the draft checks, the full count is 117. Issue 1849 moved the release
# step to the apply-receipt row and its checks make it 129. Raise it whenever
# assertions are added; lowering it is a deliberate, reviewable act and the
# workflow re-checks the same number independently (see below), so lowering it
# here alone buys nothing.
MIN_EXPECTED_ASSERTIONS=129

# The workflow that runs this suite re-asserts the same floor against the
# machine-readable FUSION_SELFTESTS_EXECUTED line, precisely so a silently
# lowered MIN_EXPECTED_ASSERTIONS cannot buy a green on its own. Any slack
# between the two numbers re-opens the window this guard exists to close, so the
# drift is asserted here too -- red in CI on the commit that introduces it.
#
# INTEGRATION NOTE (round-2): the paired workflow is suite-27-fusion-assertion-
# floor.yml, NOT suite-25-fusion-harness-selftests.yml. suite-25 carries the
# floor as of the commit that created it (63) and the round-2 change protocol
# (§4/§10) forbids modifying an existing workflow file, so suite-25 is left
# untouched -- its 63 remains a true lower bound and stays green. suite-27 is a
# NEW file (which the protocol permits) holding the real floor, and it is the
# one this equality is asserted against. Fold suite-27 back into suite-25 and
# repoint this variable when the freeze lifts.
FUSION_SELFTEST_WORKFLOW="$REPO_ROOT/.github/workflows/suite-27-fusion-assertion-floor.yml"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ok   — $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL — $*" >&2; }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want: $3, got: $2)"; fi; }

# ─── Stub harness ────────────────────────────────────────────────────────────
# STUB_DIR/chain_digest   — digest getReceiptById reports ("" = not recorded)
# STUB_DIR/submit_fail_n  — number of leading submit attempts that fail
# STUB_DIR/attempts       — one line per rmpc submit attempt
# STUB_DIR/rmpc_calls     — every rmpc argv, one line each
# STUB_DIR/submit_no_anchor   — non-empty: submit exits 0 WITHOUT anchoring
# STUB_DIR/uri_embeds_digest  — non-empty: payloadUri contains the derived digest
# STUB_DIR/malformed_tuple    — non-empty: getReceiptById emits a garbage tuple
# STUB_DIR/rpc_down           — non-empty: every `cast call` fails like an outage
# STUB_DIR/released           — non-empty: isReleased reports true
# STUB_DIR/release_sends      — one line per apply (or `cast send`) broadcast
# STUB_DIR/govern_calls       — every govern-apply argv, one line each
# STUB_DIR/govern_row         — the row name govern-apply prints (default apply-receipt)
# STUB_DIR/cast_calls         — every `cast` argv, one line each
# STUB_DIR/witness_drift      — non-empty: totalAssets moves one unit per read
# STUB_DIR/weights            — what getWeights and currentWeights report
# STUB_DIR/setter_weights_drift — non-empty: currentWeights reports a new vector
#                               on every read after the first (a weight change)
# STUB_DIR/submit_refuses_tampered — non-empty: rmpc receipt submit refuses neg-* files
# STUB_DIR/api_json           — body curl returns for an explorer-API GET
# STUB_DIR/alert_posts        — one line per webhook POST body
# STUB_DIR/alert_post_fail    — non-empty: every webhook POST fails
new_stubs() {
  STUB_DIR="$(mktemp -d)"
  mkdir -p "$STUB_DIR/bin"
  : >"$STUB_DIR/chain_digest"
  echo 0 >"$STUB_DIR/submit_fail_n"
  : >"$STUB_DIR/attempts"
  : >"$STUB_DIR/rmpc_calls"
  : >"$STUB_DIR/submit_no_anchor"
  : >"$STUB_DIR/uri_embeds_digest"
  : >"$STUB_DIR/malformed_tuple"
  : >"$STUB_DIR/rpc_down"
  : >"$STUB_DIR/verify_ok_false_exit_zero"
  : >"$STUB_DIR/released"
  : >"$STUB_DIR/release_sends"
  : >"$STUB_DIR/govern_calls"
  echo apply-receipt >"$STUB_DIR/govern_row"
  : >"$STUB_DIR/cast_calls"
  : >"$STUB_DIR/record.json"
  : >"$STUB_DIR/witness_drift"
  : >"$STUB_DIR/witness_reads"
  : >"$STUB_DIR/alert_posts"
  : >"$STUB_DIR/alert_post_fail"
  : >"$STUB_DIR/curl_fetch_fail"
  : >"$STUB_DIR/submit_refuses_tampered"
  : >"$STUB_DIR/setter_weights_drift"
  : >"$STUB_DIR/setter_weight_reads"
  echo "([0xaa],[10000])" >"$STUB_DIR/weights"

  cat >"$STUB_DIR/bin/rmpc" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/rmpc_calls"
case "$1" in
  receipt)
    for a in "$@"; do [[ "$a" == "verify" ]] && sub=verify; [[ "$a" == "submit" ]] && sub=submit; done
    if [[ "${sub:-}" == "verify" ]]; then
      # A refusal reported as `ok:false` WITH exit 0 — the shape rmpc's own
      # governance scan mode uses on purpose, and the shape an exit-code-only
      # assertion would read as a pass.
      if [[ -s "$STUB_DIR/verify_ok_false_exit_zero" ]]; then
        echo '{"ok":false,"error":"ErrReceiptSignatureInvalid"}'
        exit 0
      fi
      if [[ -s "$STUB_DIR/submit_refuses_tampered" && "$*" == *neg-* ]]; then
        echo '{"ok":false,"error":"ErrReceiptTampered"}'
        exit 1
      fi
      printf '{"ok":true,"action":"verify","receipt_id":"%s","payload_digest":"%s","analyst_signatures":[{"member_id":"a1","verified":true},{"member_id":"a2","verified":true}]}\n' \
        "$FUSION_TEST_RECEIPT_ID" "$FUSION_TEST_DIGEST"
      exit 0
    fi
    # A tampered receipt file must be refused against the anchored digest, and
    # must never reach a broadcast. `neg-` is how the orchestrator names them.
    if [[ -s "$STUB_DIR/submit_refuses_tampered" && "$*" == *neg-* ]]; then
      if [[ "$*" == *neg-schema* ]]; then
        echo '{"ok":false,"error":"ErrUnsupportedSchema","detail":"schema_version 2.0 is not supported"}' >&2
      else
        echo '{"ok":false,"error":"ErrPayloadDigestMismatch"}' >&2
      fi
      exit 1
    fi
    echo "submit" >>"$STUB_DIR/attempts"
    n="$(cat "$STUB_DIR/submit_fail_n")"
    if (( $(wc -l <"$STUB_DIR/attempts") <= n )); then
      echo "stub: broadcast failed" >&2
      exit 1
    fi
    # A submit that reports success but anchors nothing: the exact shape the
    # post-submit re-read exists to catch (AC-CORE-09, "a missing expected
    # anchor is not silent").
    if [[ ! -s "$STUB_DIR/submit_no_anchor" ]]; then
      printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
    fi
    echo '{"ok":true,"action":"submit"}'
    exit 0
    ;;
esac
echo "stub rmpc: unexpected argv: $*" >&2
exit 2
STUB

  # The release stage runs the govern apply command (publish contracts govern,
  # row apply-receipt, through the real Safe and the timelock; issue 1849), so
  # this fake govern command, not `cast send`, records the broadcast, flips
  # `released` and moves the router weights the way applyReceipt does. It refuses
  # like the real row: no --receipt-id or no readable --payload file is a usage
  # error (64), an already released receipt is refused (65). `cast send` is never
  # called for a release.
  cat >"$STUB_DIR/bin/govern-apply" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/govern_calls"
id=""; payload=""; prev=""
for a in "$@"; do
  [[ "$prev" == "--receipt-id" ]] && id="$a"
  [[ "$prev" == "--payload" ]] && payload="$a"
  prev="$a"
done
if [[ -z "$id" || -z "$payload" || ! -s "$payload" ]]; then
  echo "stub govern-apply: --row apply-receipt needs --receipt-id 0x<bytes32> and a readable --payload FILE" >&2
  exit 64
fi
if [[ -s "$STUB_DIR/released" ]]; then
  echo "stub govern-apply: receipt $id is already released" >&2
  exit 65
fi
echo "apply $*" >>"$STUB_DIR/release_sends"
echo 1 >"$STUB_DIR/released"
echo "([0xaa,0xbb],[6000,4000])" >"$STUB_DIR/weights"
row="$(cat "$STUB_DIR/govern_row")"
printf '{"row":"%s","phase":"scheduled","txHash":"0x%064d","status":1}\n' "$row" 1
printf '{"row":"%s","phase":"executed","txHash":"0x%064d","status":1}\n' "$row" 2
exit 0
STUB
  chmod +x "$STUB_DIR/bin/govern-apply"

  cat >"$STUB_DIR/bin/cast" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/cast_calls"
case "$1" in
  code) echo "0x60006000fd"; exit 0 ;;
  chain-id) echo 918453; exit 0 ;;
  send)
    echo "send $*" >>"$STUB_DIR/release_sends"
    printf '%s\n' "$STUB_DIR/released" >/dev/null
    echo 1 >"$STUB_DIR/released"
    echo '{"status":"0x1","transactionHash":"0xdeadbeef"}'
    exit 0 ;;
  call)
    sig="$3"
    d="$(cat "$STUB_DIR/chain_digest")"
    if [[ -s "$STUB_DIR/rpc_down" ]]; then
      echo "stub cast: connection refused" >&2
      exit 1
    fi
    case "$sig" in
      currentWeights*)
        # The weight setter's read of the router. With setter_weights_drift set,
        # every read after the first reports a moved vector: the shape of a
        # receipt applied (applyReceipt) inside the window.
        if [[ -s "$STUB_DIR/setter_weights_drift" && -s "$STUB_DIR/setter_weight_reads" ]]; then
          echo "read" >>"$STUB_DIR/setter_weight_reads"
          echo "([0xaa,0xbb],[5000,5000])"
        else
          echo "read" >>"$STUB_DIR/setter_weight_reads"
          cat "$STUB_DIR/weights"
        fi
        exit 0 ;;
      getWeights*)        cat "$STUB_DIR/weights"; exit 0 ;;
      totalAssets*)
        # One unit of drift per read when asked for: the accrual shape INV-4 has
        # to distinguish from a signalling-path asset movement, and the shape
        # BOTH harnesses must reach the same verdict on.
        if [[ -s "$STUB_DIR/witness_drift" ]]; then
          n="$(wc -l <"$STUB_DIR/witness_reads" | tr -d ' ')"
          echo "read" >>"$STUB_DIR/witness_reads"
          echo $((1000000 + n))
        else
          echo 1000000
        fi
        exit 0 ;;
      totalSupply*) echo 999000; exit 0 ;;
      isRecorded*) [[ -n "$d" ]] && echo true || echo false; exit 0 ;;
      isReleased*) [[ -s "$STUB_DIR/released" ]] && echo true || echo false; exit 0 ;;
      releaseReceipt*)
        # An eth_call of releaseReceipt. onlyRole(ADMIN_ROLE) runs first: only the
        # timelock holds ADMIN_ROLE, so any other --from reverts on authority and
        # never reaches the one-shot check (issue 1647).
        if [[ "$*" != *"--from $FUSION_TIMELOCK_ADDRESS"* ]]; then
          echo "server returned an error response: execution reverted: AccessControlUnauthorizedAccount()" >&2
          exit 1
        fi
        # Already-released receipts revert.
        if [[ -s "$STUB_DIR/released" ]]; then
          echo "server returned an error response: execution reverted: ReceiptAlreadyReleased()" >&2
          exit 1
        fi
        exit 0 ;;
      consensusRecordReceipt*)
        if [[ -n "$d" ]]; then
          echo "server returned an error response: execution reverted: ReceiptAlreadyRecorded()" >&2
          exit 1
        fi
        exit 0 ;;
      getReceiptById*)
        [[ -n "$d" ]] || exit 1
        if [[ -s "$STUB_DIR/malformed_tuple" ]]; then
          echo "not-a-tuple"
          exit 0
        fi
        uri="https://example.invalid/r,1"
        # The adversarial URI: it EMBEDS the digest the worker derived, so a
        # substring match over the whole decoded struct would report the
        # conflicting anchor as "already anchored" and exit 0.
        [[ -s "$STUB_DIR/uri_embeds_digest" ]] && uri="https://example.invalid/$FUSION_TEST_DIGEST.json"
        echo "($FUSION_TEST_RECEIPT_ID, $d, \"$uri\", 0x00000000000000000000000000000000000000aa, 1757000000, 0, false)"
        exit 0 ;;
    esac
    exit 1 ;;
esac
echo "stub cast: unexpected argv: $*" >&2
exit 2
STUB

  chmod +x "$STUB_DIR/bin/rmpc" "$STUB_DIR/bin/cast"
  export STUB_DIR
  export PATH="$STUB_DIR/bin:$PATH"
  FUSION_TEST_RECEIPT_ID="0x$(printf 'ab%.0s' {1..32})"
  FUSION_TEST_DIGEST="0x$(printf 'cd%.0s' {1..32})"
  export FUSION_TEST_RECEIPT_ID FUSION_TEST_DIGEST
  : >"$STUB_DIR/api_json"
}

# A curl stub every acceptance test shares, so the three hand-copied inline
# heredocs cannot drift. It serves the receipt for `-o FILE`, the explorer-API
# body for a consensus-receipts GET, and records webhook POSTs.
new_curl_stub() {
  cat >"$STUB_DIR/bin/curl" <<'CURLSTUB'
#!/usr/bin/env bash
out=""; prev=""; post=0; data=""; url=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  [[ "$prev" == "-X" && "$a" == "POST" ]] && post=1
  [[ "$prev" == "--data" ]] && data="$a"
  [[ "$a" == http* ]] && url="$a"
  prev="$a"
done
if (( post )); then
  printf '%s\n' "$data" >>"$STUB_DIR/alert_posts"
  [[ -s "$STUB_DIR/alert_post_fail" ]] && { echo "stub curl: webhook refused" >&2; exit 22; }
  exit 0
fi
if [[ -n "$out" ]]; then
  [[ -s "$STUB_DIR/curl_fetch_fail" ]] && exit 22
  cp "$STUB_DIR/receipt.json" "$out"
  exit 0
fi
if [[ "$url" == *consensus-receipts* ]]; then
  [[ -s "$STUB_DIR/api_json" ]] || exit 22
  cat "$STUB_DIR/api_json"
  exit 0
fi
exit 0
CURLSTUB
  chmod +x "$STUB_DIR/bin/curl"
}

# A receipt with the four canonical bucket weights, so the weights assertions
# (T15) have something real to bind to.
receipt_fixture() {
  cat >"$STUB_DIR/receipt.json" <<'RJSON'
{"schema_version":"1.0",
 "weights":[{"bucket":"conservative_defi_yield","weight_bps":4000},
            {"bucket":"protocol_tokens","weight_bps":3000},
            {"bucket":"agent_tokens","weight_bps":2000},
            {"bucket":"real_world_assets","weight_bps":1000}]}
RJSON
}

worker_env() {
  export FUSION_RMPC_CONFIG="$STUB_DIR/rmpc.toml"
  : >"$FUSION_RMPC_CONFIG"
  export FUSION_RECEIPT_URL="https://example.invalid/receipt.json"
  export FUSION_RECEIPT_ADDRESS="0x00000000000000000000000000000000000000bb"
  export FUSION_RPC_URL="http://127.0.0.1:1"
  export FUSION_RETRY_SECS=1
  export FUSION_READ_RETRIES=1
  export FUSION_POST_SUBMIT_READ_RETRIES=1
  export FUSION_READ_RETRY_SECS=0
  export FUSION_READ_FAILURE_ALERT=1
  unset FUSION_RECEIPT_FILE || true
}

# ─── AC-CORE-09: retry / idempotency ─────────────────────────────────────────
echo "AC-CORE-09 — submit-receipt-worker.sh"

new_stubs; worker_env
echo 2 >"$STUB_DIR/submit_fail_n"
export FUSION_MAX_ATTEMPTS=5
out="$("$FUSION_DIR/submit-receipt-worker.sh" 2>/dev/null)"; rc=$?
check "retries a failed broadcast until the digest is on chain" "$rc" "0"
check "took exactly three attempts" "$(wc -l <"$STUB_DIR/attempts" | tr -d ' ')" "3"

new_stubs; worker_env
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
export FUSION_MAX_ATTEMPTS=5
out="$("$FUSION_DIR/submit-receipt-worker.sh" 2>/dev/null)"; rc=$?
check "already-anchored matching digest exits 0" "$rc" "0"
check "already-anchored broadcasts nothing" "$(wc -l <"$STUB_DIR/attempts" | tr -d ' ')" "0"
check "already-anchored reports the no-op" \
  "$(jq -r '.action' <<<"$out")" "already_anchored"

new_stubs; worker_env
printf '0x%s\n' "$(printf 'ef%.0s' {1..32})" >"$STUB_DIR/chain_digest"
export FUSION_MAX_ATTEMPTS=5
err="$("$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"; rc=$?
check "conflicting on-chain digest is fatal" "$rc" "1"
check "conflicting digest never broadcasts" "$(wc -l <"$STUB_DIR/attempts" | tr -d ' ')" "0"
if grep -q "conflicting digest" <<<"$err"; then
  ok "conflicting digest names the conflict"
else
  bad "conflicting digest error is not diagnosable: $err"
fi

new_stubs; worker_env
echo 99 >"$STUB_DIR/submit_fail_n"
export FUSION_MAX_ATTEMPTS=2
err="$("$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"; rc=$?
check "exhausted attempt budget exits non-zero" "$rc" "1"
check "attempt budget is honoured exactly" "$(wc -l <"$STUB_DIR/attempts" | tr -d ' ')" "2"
if grep -q "remains unanchored" <<<"$err"; then
  ok "exhausted budget says the receipt is unanchored"
else
  bad "exhausted budget is silent about the outcome: $err"
fi

# A conflicting anchor whose payloadUri EMBEDS the derived digest. The
# pre-remediation implementation compared the digest as a substring of the whole
# decoded Receipt struct, so it would read this as "already anchored", print
# ok:true and exit 0 — silently accepting someone else's commitment. The
# field-exact comparison must still call it a conflict.
new_stubs; worker_env
printf '0x%s\n' "$(printf 'ef%.0s' {1..32})" >"$STUB_DIR/chain_digest"
echo 1 >"$STUB_DIR/uri_embeds_digest"
export FUSION_MAX_ATTEMPTS=5
err="$("$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"; rc=$?
check "a conflicting digest hidden in the payloadUri is still a conflict" "$rc" "1"
check "the payloadUri decoy never triggers a broadcast" \
  "$(wc -l <"$STUB_DIR/attempts" | tr -d ' ')" "0"
if grep -q "conflicting digest" <<<"$err"; then
  ok "the payloadUri decoy is reported as a conflict, not as already_anchored"
else
  bad "substring-style acceptance of a conflicting anchor: $err"
fi

# AC-CORE-09: "a missing expected anchor is not silent." A submit that returns
# success without anchoring must not be believed.
new_stubs; worker_env
echo 1 >"$STUB_DIR/submit_no_anchor"
export FUSION_MAX_ATTEMPTS=1
err="$("$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"; rc=$?
check "a submit that anchors nothing exits non-zero" "$rc" "1"
if grep -q "not observable on chain" <<<"$err"; then
  ok "the unobservable anchor is named"
else
  bad "a successful-looking submit that anchored nothing was silent: $err"
fi

# A malformed getReceiptById tuple must fail loudly rather than be parsed into
# something that happens to compare equal (or unequal) by luck.
new_stubs; worker_env
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
echo 1 >"$STUB_DIR/malformed_tuple"
export FUSION_MAX_ATTEMPTS=1
err="$("$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"; rc=$?
check "a malformed on-chain tuple is fatal" "$rc" "1"
if grep -q "could not read payloadDigest" <<<"$err"; then
  ok "the malformed tuple is named"
else
  bad "a malformed tuple was parsed silently: $err"
fi

# A read-side outage is NOT "nothing is anchored": broadcasting into an unknown
# chain state burns nonces against an anchor that may already exist.
new_stubs; worker_env
echo 1 >"$STUB_DIR/rpc_down"
export FUSION_MAX_ATTEMPTS=1
err="$(timeout 10 "$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"; rc=$?
check "an unreadable chain never broadcasts" "$(wc -l <"$STUB_DIR/attempts" | tr -d ' ')" "0"
check "an unreadable chain keeps waiting rather than exiting success" "$rc" "124"
if grep -q "ALERT \[fusion_submit_worker_chain_reads_down\] chain reads have failed" <<<"$err"; then
  ok "consecutive read outages page"
else
  bad "a read-side outage was silent: $err"
fi

# ─── devnet-acceptance.sh ────────────────────────────────────────────────────
# The orchestrator (AC-E2E-05). What is worth executing about it is not the
# happy path — that needs a chain — but the three ways it could LIE: skipping a
# stage and calling the run green, reaching a write path in the no-anchor mode,
# and reporting a missing witness address as a pass.
echo
echo "devnet-acceptance.sh"

acceptance_env() {
  export PATH="$STUB_DIR/bin:$PATH"
  export STUB_DIR
  export RMPC_BIN=rmpc CAST_BIN=cast
  export FUSION_RMPC_CONFIG="$STUB_DIR/config.toml"
  export FUSION_RPC_URL="http://127.0.0.1:1"
  export FUSION_GATEWAY_ADDRESS=0x0000000000000000000000000000000000000001
  export FUSION_RECEIPT_ADDRESS=0x0000000000000000000000000000000000000002
  export FUSION_GOVERNANCE_ADDRESS=0x0000000000000000000000000000000000000003
  export FUSION_ROUTER_ADDRESS=0x0000000000000000000000000000000000000004
  export FUSION_VAULT_ADDRESSES=0x0000000000000000000000000000000000000005,0x0000000000000000000000000000000000000006,0x0000000000000000000000000000000000000007,0x0000000000000000000000000000000000000008
  : >"$STUB_DIR/config.toml"
  RESULT="$STUB_DIR/result.json"
}
assertion_result() { jq -r --arg t "$1" '[.assertions[]|select(.assertion|test($t))|.result]|join(",")' "$RESULT" 2>/dev/null; }

# An unknown stage name is a typo in an acceptance invocation. Refusing is the
# only safe answer: silently running a subset would report a green run that
# never executed the stage the operator asked for.
new_stubs; acceptance_env
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/r --stages verify,typo >/dev/null 2>&1
check "an unknown stage name is refused" "$?" "64"

# A missing witness address must refuse at startup, not turn an INV-4 assertion
# into a silent skip.
new_stubs; acceptance_env
unset FUSION_ROUTER_ADDRESS
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/r --no-anchor >/dev/null 2>&1
check "a missing INV-4 witness address refuses to start" "$?" "3"
export FUSION_ROUTER_ADDRESS=0x0000000000000000000000000000000000000004

# No receipt URL at all is a usage error, never an empty green run.
new_stubs; acceptance_env
"$FUSION_DIR/devnet-acceptance.sh" >/dev/null 2>&1
check "no receipt URL is a usage error" "$?" "64"

# AC-FMT-04 names four buckets and four vaults. A short list must refuse rather
# than check fewer vaults than the criterion requires.
new_stubs; acceptance_env
export FUSION_VAULT_ADDRESSES=0x0000000000000000000000000000000000000005
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/r --no-anchor >/dev/null 2>&1
check "a vault list that is not exactly four refuses to start" "$?" "3"

# A REFUSAL REPORTED AS ok:false WITH EXIT 0 MUST NOT PASS. An rmpc subcommand
# can report a refusal in exactly that shape, so an exit-code-only assertion
# would read a refusal as a successful verification. Measured against
# the real rc.1 stand-in during step 3.8, which is how the trap was found.
new_stubs; acceptance_env
: >"$STUB_DIR/receipt.json"
printf '{"schema_version":"1.0"}' >"$STUB_DIR/receipt.json"
echo 1 >"$STUB_DIR/verify_ok_false_exit_zero"
cat >"$STUB_DIR/bin/curl" <<'CURLSTUB'
#!/usr/bin/env bash
out=""
prev=""
for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done
[[ -n "$out" ]] && cp "$STUB_DIR/receipt.json" "$out"
exit 0
CURLSTUB
chmod +x "$STUB_DIR/bin/curl"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify   --out "$RESULT" >/dev/null 2>&1
if [[ -s "$RESULT" ]] && jq -e '[.assertions[] | select(.stage=="verify" and (.assertion|test("AC-CORE-02")))] |
      length == 1 and all(.result == "FAIL")' "$RESULT" >/dev/null 2>&1; then
  ok "a verification that reports ok:false with exit 0 is recorded as a FAILURE"
else
  bad "an ok:false verification was not failed: $(jq -c '[.assertions[]|{a:.assertion,r:.result}]' "$RESULT" 2>/dev/null)"
fi

# THE NEGATIVE CONTROL. --no-anchor must never reach a write subcommand, and an
# unreachable receipt URL must make the run FAIL rather than pass vacuously.
new_stubs; acceptance_env
: >"$STUB_DIR/rmpc_calls"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --no-anchor \
  --out "$RESULT" >/dev/null 2>&1
check "an unfetchable receipt URL fails the run" "$?" "1"
if grep -Eq '(^| )(submit|propose|vote|deposit|withdraw|send)( |$)' "$STUB_DIR/rmpc_calls"; then
  bad "--no-anchor reached a write subcommand: $(cat "$STUB_DIR/rmpc_calls")"
else
  ok "--no-anchor invoked no write subcommand"
fi
if [[ -s "$RESULT" ]] && jq -e '.ok == false and .summary.failed > 0' "$RESULT" >/dev/null 2>&1; then
  ok "the machine-readable result records the failure"
else
  bad "the result file did not record a failure: $(cat "$RESULT" 2>/dev/null)"
fi
if [[ -s "$RESULT" ]] && jq -e '[.assertions[] | select(.stage=="record" or .stage=="release")] |
      length > 0 and all(.result == "SKIP")' "$RESULT" >/dev/null 2>&1; then
  ok "unselected stages are recorded as SKIP, never counted as passes"
else
  bad "unselected stages were not recorded as skipped"
fi

# THE RELEASE STAGE MUST BE IDEMPOTENT, BECAUSE THE SCRIPT IS RUN TWICE.
# AC-E2E-05's bundle wording invokes this path twice against the SAME receipt.
# A receipt applies once (issue 1849: the stage runs govern row apply-receipt,
# which releases it and sets its weights): a second apply is refused as already
# released, so asserting on a fresh status 0x1 would fail the
# second run for doing exactly what a released receipt should do. The record
# stage has always been idempotent (submit-receipt-worker.sh reports
# `already_anchored` and broadcasts nothing); the release stage was not, and the
# asymmetry only appears on a second run.
new_stubs; acceptance_env
printf '{"schema_version":"1.0"}' >"$STUB_DIR/receipt.json"
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"   # already anchored
echo 1 >"$STUB_DIR/released"                                     # already released
export FUSION_GOVERN_CMD="$STUB_DIR/bin/govern-apply" \
       FUSION_TIMELOCK_ADDRESS=0x00000000000000000000000000000000000000cc \
       FUSION_SUBMITTER_ADDRESS=0x00000000000000000000000000000000000000dd
cat >"$STUB_DIR/bin/curl" <<'CURLSTUB'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done
[[ -n "$out" ]] && cp "$STUB_DIR/receipt.json" "$out"
exit 0
CURLSTUB
chmod +x "$STUB_DIR/bin/curl"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,release \
  --out "$RESULT" >/dev/null 2>&1
check "a second run broadcasts NO release transaction" \
  "$(wc -l <"$STUB_DIR/release_sends" | tr -d ' ')" "0"
if [[ -s "$RESULT" ]] && jq -e '[.assertions[] | select(.stage=="release" and (.assertion|test("the Safe applies the receipt through the timelock")))]
      | length == 1 and all(.result == "PASS" and (.assertion|test("idempotent no-op")))' "$RESULT" >/dev/null 2>&1; then
  ok "an already-released receipt is recorded as an idempotent no-op, named as one"
else
  bad "the second release was not an idempotent no-op: $(jq -c '[.assertions[]|select(.stage=="release")|{a:.assertion,r:.result}]' "$RESULT" 2>/dev/null)"
fi

# AND THE FIRST RUN MUST STILL SEND ONE. The no-op must not become a blanket
# pass that never releases anything.
new_stubs; acceptance_env
receipt_fixture   # four bucket weights, so the verify stage is all PASS
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
export FUSION_GOVERN_CMD="$STUB_DIR/bin/govern-apply" \
       FUSION_TIMELOCK_ADDRESS=0x00000000000000000000000000000000000000cc \
       FUSION_SUBMITTER_ADDRESS=0x00000000000000000000000000000000000000dd
cat >"$STUB_DIR/bin/curl" <<'CURLSTUB'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [[ "$prev" == "-o" ]] && out="$a"; prev="$a"; done
[[ -n "$out" ]] && cp "$STUB_DIR/receipt.json" "$out"
exit 0
CURLSTUB
chmod +x "$STUB_DIR/bin/curl"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,release,govern \
  --out "$RESULT" >/dev/null 2>&1
check "an unreleased receipt still broadcasts exactly one apply" \
  "$(wc -l <"$STUB_DIR/release_sends" | tr -d ' ')" "1"
check "…with no failed assertion" "$(jq -c "[.assertions[]|select(.result==\"FAIL\")|.assertion]" "$RESULT" 2>/dev/null)" "[]"
# Issue 1849: the stage calls the govern command with the receipt id and the
# payload file, and accepts only apply-receipt rows.
check "the govern command gets --receipt-id ID --payload FILE" \
  "$(grep -c -- "--receipt-id $FUSION_TEST_RECEIPT_ID --payload " "$STUB_DIR/govern_calls")" "1"
check "…and the apply-receipt rows PASS AC-CORE-03" \
  "$(assertion_result 'AC-CORE-03 the Safe applies the receipt through the timelock')" "PASS"
# The apply moved the router weights (the stub does what applyReceipt does), so
# INV-4 and AC-E2E-04 must close their window immediately before it.
check "INV-4 closes its window before the apply, which moves the weights by design" \
  "$(assertion_result 'up to the apply-receipt call')" "PASS"
check "AC-E2E-04 compares the weights from before the apply" \
  "$(assertion_result 'recording a receipt sets no router weights')" "PASS"
# The duplicate probe must reach ReceiptAlreadyReleased: it is sent from the
# timelock (the only ADMIN_ROLE holder), so it passes onlyRole first (issue 1647).
check "the duplicate-release probe reaches ReceiptAlreadyReleased (sent from the timelock)" \
  "$(jq -r '[.assertions[]|select(.assertion|test("duplicate release is rejected"))|.result]|first' "$RESULT" 2>/dev/null)" "PASS"
# The SAME stub chain, run again: exactly one apply across the two runs.
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,release,govern \
  --out "$RESULT" >/dev/null 2>&1
check "a second run against the same chain is an idempotent no-op" \
  "$(assertion_result 'idempotent no-op')" "PASS"
check "…with no failed assertion" "$(jq -c "[.assertions[]|select(.result==\"FAIL\")|.assertion]" "$RESULT" 2>/dev/null)" "[]"
check "…and sends no second apply (one across both runs)" \
  "$(wc -l <"$STUB_DIR/release_sends" | tr -d ' ')" "1"

# A status-1 row that is NOT apply-receipt (the refused release-receipt row, say)
# must FAIL AC-CORE-03: only apply-receipt rows count.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
echo release-receipt >"$STUB_DIR/govern_row"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,release \
  --out "$RESULT" >/dev/null 2>&1
check "a status-1 row that is not apply-receipt FAILS AC-CORE-03" \
  "$(assertion_result 'AC-CORE-03 the Safe applies the receipt through the timelock')" "FAIL"

# ─── T10: one shared INV-4 witness reader, failing LOUDLY ────────────────────
# `witnesses()` built each reading as `out="name=$(cast call … 2>&1 | …)"`:
# stderr folded into the compared value, exit status eaten by the pipe. With a
# `cast` that failed every read, the blocker INV-4 assertion recorded PASS with
# the detail "no allocation-state witness moved". Ten failed reads, one green
# gate. These tests execute that.
echo
echo "T10 — INV-4 witnesses (lib/inv4.sh)"

inv4_results() { jq -r '[.assertions[]|select(.assertion|test("INV-4"))|.result]|unique|join(",")' "$RESULT" 2>/dev/null; }

new_stubs; acceptance_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/rpc_down"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --no-anchor --out "$RESULT" >/dev/null 2>&1
check "an unreadable chain fails the run" "$?" "1"
check "the INV-4 assertion is FAIL, not a PASS over two identical error texts" "$(inv4_results)" "FAIL"
check "an unreadable-witness run is not ok" "$(jq -r '.ok' "$RESULT" 2>/dev/null)" "false"
if jq -e '[.assertions[]|select(.assertion|test("INV-4"))]|length>0 and all(.detail|test("could not be READ"))' \
     "$RESULT" >/dev/null 2>&1; then
  ok "the INV-4 failure says the witnesses were not read, not that nothing moved"
else
  bad "the unreadable INV-4 witnesses were not named: $(jq -c '[.assertions[]|select(.assertion|test("INV-4"))|{r:.result,d:.detail}]' "$RESULT" 2>/dev/null)"
fi

# THE NEGATIVE CONTROL. With the same stubs answering, the very same assertion
# must PASS — otherwise the test above would pass on a script that always fails.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/submit_refuses_tampered"
export FUSION_UNAUTHORIZED_SUBMITTER=0x00000000000000000000000000000000000000ee
export FUSION_SUBMITTER_ADDRESS=0x00000000000000000000000000000000000000dd
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --no-anchor --out "$RESULT" >/dev/null 2>&1
check "a readable chain records the INV-4 assertion as PASS" "$(inv4_results)" "PASS"
for q in currentWeights getWeights totalAssets totalSupply; do
  if grep -q "$q" "$STUB_DIR/cast_calls"; then ok "devnet-acceptance reads $q as an INV-4 witness"
  else bad "devnet-acceptance never read $q"; fi
done
unset FUSION_UNAUTHORIZED_SUBMITTER FUSION_SUBMITTER_ADDRESS

# A ONE-UNIT DRIFT MUST REACH THE SAME VERDICT IN BOTH HARNESSES.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/witness_drift"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --no-anchor --out "$RESULT" >/dev/null 2>&1
devnet_drift_rc=$?
check "devnet-acceptance fails on a one-unit witness drift" "$devnet_drift_rc" "1"
check "and records it as a FAILED INV-4 assertion" "$(inv4_results)" "FAIL"
if jq -e '[.assertions[]|select(.assertion|test("INV-4"))]|all(.detail|test("yield adapter accrues"))' \
     "$RESULT" >/dev/null 2>&1; then
  ok "the drift failure carries the accrual note so it can be attributed"
else
  bad "the drift failure dropped the accrual note"
fi

cross_repo_env() {
  export FUSION_FRONTEND_RECEIPT_FILE="$STUB_DIR/receipt.json"
  export FUSION_FRONTEND_RECEIPT_URL="https://example.invalid/receipt.json"
  export FUSION_RMPC_CONFIG="$STUB_DIR/config.toml"; : >"$FUSION_RMPC_CONFIG"
  export FUSION_RECEIPT_ADDRESS=0x0000000000000000000000000000000000000002
  export FUSION_RPC_URL="http://127.0.0.1:1"
  export FUSION_GOVERNANCE_ADDRESS=0x0000000000000000000000000000000000000003
  export FUSION_ROUTER_ADDRESS=0x0000000000000000000000000000000000000004
  export FUSION_VAULT_ADDRESSES=0x0000000000000000000000000000000000000005,0x0000000000000000000000000000000000000006,0x0000000000000000000000000000000000000007,0x0000000000000000000000000000000000000008
  export FUSION_GOVERN_CMD="$STUB_DIR/bin/govern-apply"
  export FUSION_EVIDENCE_DIR="$STUB_DIR/evidence"
  export FUSION_MAX_ATTEMPTS=3
  export RMPC_BIN=rmpc CAST_BIN=cast
  export PATH="$STUB_DIR/bin:$PATH"
  export STUB_DIR
  unset FUSION_SKIP_RELEASE FUSION_ALERT_WEBHOOK FUSION_RECEIPT_URL FUSION_RECEIPT_FILE || true
  : >"$STUB_DIR/config.toml"
}

new_stubs; cross_repo_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/witness_drift"
"$FUSION_DIR/cross-repo-acceptance.sh" >/dev/null 2>&1
check "cross-repo-acceptance reaches the SAME verdict on the same one-unit drift" "$?" "$devnet_drift_rc"
for q in currentWeights getWeights totalAssets totalSupply; do
  if grep -q "$q" "$STUB_DIR/cast_calls"; then ok "cross-repo-acceptance reads $q as an INV-4 witness"
  else bad "cross-repo-acceptance never read $q (it used to read only totalAssets)"; fi
done

# ─── T11: the verdict derives from every SELECTED stage ─────────────────────
# `ok:([.[]|select(.result=="FAIL")]|length==0)` then `exit "$FAILED"` — SKIP was
# invisible to both. Stages selected with none of their config supplied SKIPped
# every assertion and reported {failed:0, ok:true, exit 0}.
echo
echo "T11 — the acceptance verdict"

new_stubs; acceptance_env; new_curl_stub; receipt_fixture
unset FUSION_GOVERN_CMD FUSION_TIMELOCK_ADDRESS \
      FUSION_EXPLORER_API FUSION_DAPP_URL FUSION_UNAUTHORIZED_SUBMITTER FUSION_SUBMITTER_ADDRESS || true
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages release --out "$RESULT" >/dev/null 2>&1
check "a SELECTED but unconfigured release stage exits non-zero" "$?" "1"
check "…and the run is not ok" "$(jq -r '.ok' "$RESULT" 2>/dev/null)" "false"
check "…while the FAIL count is still zero, which is the whole point" \
  "$(jq -r '.summary.failed' "$RESULT" 2>/dev/null)" "0"
check "…because the skip is counted as unconfigured, not as not_selected" \
  "$(jq -r '.summary.skipped_unconfigured' "$RESULT" 2>/dev/null)" "1"

new_stubs; acceptance_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/submit_refuses_tampered"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,negative --out "$RESULT" >/dev/null 2>&1
check "an unset FUSION_UNAUTHORIZED_SUBMITTER on a SELECTED negative stage exits non-zero" "$?" "1"
check "…with ok false" "$(jq -r '.ok' "$RESULT" 2>/dev/null)" "false"
check "…and zero FAILs, so only the SKIP reason can have produced the verdict" \
  "$(jq -r '.summary.failed' "$RESULT" 2>/dev/null)" "0"

# NEGATIVE CONTROL 1: the same unconfigured variable, with the stage NOT selected.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify --out "$RESULT" >/dev/null 2>&1
check "a run whose unconfigured stages were never SELECTED exits 0" "$?" "0"
check "…is ok" "$(jq -r '.ok' "$RESULT" 2>/dev/null)" "true"
check "…counts no unconfigured skips" "$(jq -r '.summary.skipped_unconfigured' "$RESULT" 2>/dev/null)" "0"
check "…and records the other six stages as not_selected" \
  "$(jq -r '.summary.skipped_not_selected' "$RESULT" 2>/dev/null)" "6"

# NEGATIVE CONTROL 2: configure the variable and the unconfigured count must drop
# to zero for the very same selected stage.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/submit_refuses_tampered"
export FUSION_UNAUTHORIZED_SUBMITTER=0x00000000000000000000000000000000000000ee
export FUSION_SUBMITTER_ADDRESS=0x00000000000000000000000000000000000000dd
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,negative --out "$RESULT" >/dev/null 2>&1
check "configuring the variable removes the unconfigured skip" \
  "$(jq -r '.summary.skipped_unconfigured' "$RESULT" 2>/dev/null)" "0"
unset FUSION_UNAUTHORIZED_SUBMITTER FUSION_SUBMITTER_ADDRESS

# ─── T15 / issue 1698: the govern stage and the weights binding ────────────
# Issue 1698 removed the draft step: RouterGovernance.applyReceipt releases a
# receipt and sets the router weights in one call, so the govern stage now
# asserts that recording a receipt set no weights up to the apply (issue 1849),
# read through the weight setter (RouterGovernance.currentWeights).
echo
echo "T15 — govern stage (no weight change) and weights assertions"


new_stubs; acceptance_env; new_curl_stub; receipt_fixture
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,govern --out "$RESULT" >/dev/null 2>&1
check "unchanged weight-setter weights PASS the govern stage" "$(assertion_result 'recording a receipt sets no router weights')" "PASS"
check "…and the govern stage never calls rmpc governance" "$(grep -c '^governance' "$STUB_DIR/rmpc_calls")" "0"

# NEGATIVE CONTROL: weights that moved inside the window must FAIL the stage.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/setter_weights_drift"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,govern --out "$RESULT" >/dev/null 2>&1
check "weight-setter weights that moved FAIL the govern stage" "$(assertion_result 'recording a receipt sets no router weights')" "FAIL"
check "…and fail the run" "$(jq -r '.ok' "$RESULT" 2>/dev/null)" "false"

# An unreadable weight setter is a FAILURE, never a pass over two absences.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/rpc_down"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,govern --out "$RESULT" >/dev/null 2>&1
check "an unreadable weight setter FAILS the govern stage" "$(assertion_result 'recording a receipt sets no router weights')" "FAIL"

# The fourth negative case: weights rewritten to 10000/0/0/0.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
echo 1 >"$STUB_DIR/submit_refuses_tampered"
export FUSION_UNAUTHORIZED_SUBMITTER=0x00000000000000000000000000000000000000ee
export FUSION_SUBMITTER_ADDRESS=0x00000000000000000000000000000000000000dd
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,negative --out "$RESULT" >/dev/null 2>&1
check "a weights-tampered receipt is refused against the anchored digest" "$(assertion_result 'rewritten to 10000/0/0/0')" "PASS"
if grep -q 'neg-weights' "$STUB_DIR/rmpc_calls"; then
  ok "the weights-tamper case actually reached rmpc"
else
  bad "the weights-tamper negative case never ran"
fi

# NEGATIVE CONTROL: a stack that ACCEPTS the tampered weights must FAIL the gate.
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
: >"$STUB_DIR/submit_refuses_tampered"          # rmpc accepts everything
export FUSION_UNAUTHORIZED_SUBMITTER=0x00000000000000000000000000000000000000ee
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,negative --out "$RESULT" >/dev/null 2>&1
check "a stack that accepts tampered weights FAILS the refusal assertion" "$(assertion_result 'rewritten to 10000/0/0/0')" "FAIL"
unset FUSION_UNAUTHORIZED_SUBMITTER FUSION_SUBMITTER_ADDRESS

# cross-repo-acceptance.sh has no draft step either (issue 1698).
new_stubs; cross_repo_env; new_curl_stub; receipt_fixture
"$FUSION_DIR/cross-repo-acceptance.sh" >/dev/null 2>&1
check "cross-repo-acceptance passes with the apply-receipt path and unchanged witnesses up to the apply" "$?" "0"
check "…and never calls rmpc governance" "$(grep -c '^governance' "$STUB_DIR/rmpc_calls")" "0"

# ─── T16: the anchored digest is compared FIELD-EXACTLY ─────────────────────
# The orchestrator did `grep -qi -- "${PAYLOAD_DIGEST#0x}"` against the whole
# decoded tuple — which carries receiptId, payloadDigest AND the
# operator-supplied payloadUri — and against the whole explorer-API body.
echo
echo "T16 — field-exact digest comparison"

new_stubs; acceptance_env; new_curl_stub; receipt_fixture
printf '0x%s\n' "$(printf 'ef%.0s' {1..32})" >"$STUB_DIR/chain_digest"   # WRONG digest field
echo 1 >"$STUB_DIR/uri_embeds_digest"                                    # right digest in the URI
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,record --out "$RESULT" >/dev/null 2>&1
check "a wrong payloadDigest hidden behind a content-addressed URI FAILS" "$(assertion_result 'stored payloadDigest FIELD')" "FAIL"
check "…and fails the run" "$(jq -r '.ok' "$RESULT" 2>/dev/null)" "false"

new_stubs; acceptance_env; new_curl_stub; receipt_fixture
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
echo 1 >"$STUB_DIR/uri_embeds_digest"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,record --out "$RESULT" >/dev/null 2>&1
check "the matching payloadDigest field still PASSES with the same URI" "$(assertion_result 'stored payloadDigest FIELD')" "PASS"

api_body() { # <digest> <uri>
  jq -n --arg id "$FUSION_TEST_RECEIPT_ID" --arg d "$1" --arg u "$2" \
    '{receipt_id:$id,payload_digest:$d,payload_uri:$u,verified:true,released:true}' >"$STUB_DIR/api_json"
}
new_stubs; acceptance_env; new_curl_stub; receipt_fixture
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
export FUSION_EXPLORER_API="https://explorer.invalid" FUSION_INDEX_TIMEOUT_SECS=3
api_body "0x$(printf 'ef%.0s' {1..32})" "https://example.invalid/$FUSION_TEST_DIGEST.json"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,index --out "$RESULT" >/dev/null 2>&1
check "an API body whose payload_digest is wrong but whose payload_uri carries the digest FAILS" \
  "$(assertion_result 'same payload digest FIELD')" "FAIL"

new_stubs; acceptance_env; new_curl_stub; receipt_fixture
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
export FUSION_EXPLORER_API="https://explorer.invalid" FUSION_INDEX_TIMEOUT_SECS=3
api_body "$FUSION_TEST_DIGEST" "https://example.invalid/receipt"
"$FUSION_DIR/devnet-acceptance.sh" https://example.invalid/receipt --stages verify,index --out "$RESULT" >/dev/null 2>&1
check "an API body that agrees field-for-field PASSES" "$(assertion_result 'same payload digest FIELD')" "PASS"
check "…including the payload URL field" "$(assertion_result 'same payload URL FIELD')" "PASS"
unset FUSION_EXPLORER_API FUSION_INDEX_TIMEOUT_SECS

# ─── T29: cross-repo-acceptance.sh's release stage is idempotent ────────────
# The script the runbook calls "the AC-E2E-05 seam" sent unconditionally under
# `set -euo pipefail`, so the SECOND run aborted at that line: the INV-4
# comparison and the evidence JSON after it never ran, and
# a real INV-4 regression between the two runs would be invisible behind it.
echo
echo "T29 — cross-repo release idempotency"

new_stubs; cross_repo_env; new_curl_stub; receipt_fixture
out="$("$FUSION_DIR/cross-repo-acceptance.sh" 2>/dev/null)"
check "an unreleased receipt broadcasts exactly one release" \
  "$(wc -l <"$STUB_DIR/release_sends" | tr -d ' ')" "1"
check "…and reports the release as sent" "$(jq -r '.release.action' <<<"$out" 2>/dev/null)" "sent"
# Issue 1849: the apply-receipt row gets the receipt id and the frontend receipt
# file as its payload, and INV-4 closes before the apply moves the weights.
check "…calling the govern command with --receipt-id ID --payload FILE" \
  "$(grep -c -- "--receipt-id $FUSION_TEST_RECEIPT_ID --payload $FUSION_FRONTEND_RECEIPT_FILE" "$STUB_DIR/govern_calls")" "1"
check "…and INV-4 holds up to the apply, which moved the weights" \
  "$(jq -r '.inv4.unchanged' <<<"$out" 2>/dev/null)" "true"

out="$("$FUSION_DIR/cross-repo-acceptance.sh" 2>/dev/null)"; rc=$?
check "a second run against the same receipt still exits 0" "$rc" "0"
check "…broadcasts NO second release" "$(wc -l <"$STUB_DIR/release_sends" | tr -d ' ')" "1"
check "…names the no-op in the evidence JSON" "$(jq -r '.release.action' <<<"$out" 2>/dev/null)" "already_released"
check "…and still reaches the INV-4 comparison after it" \
  "$(jq -r '.inv4.unchanged' <<<"$out" 2>/dev/null)" "true"
if jq -e '[.stages[]|select(test("already_released"))]|length==1' <<<"$out" >/dev/null 2>&1; then
  ok "the already_released no-op is a named stage entry"
else
  bad "the second run's stages do not name the no-op: $(jq -c '.stages' <<<"$out" 2>/dev/null)"
fi

# Only apply-receipt rows count: a status-1 row of any other name fails the seam.
new_stubs; cross_repo_env; new_curl_stub; receipt_fixture
echo release-receipt >"$STUB_DIR/govern_row"
"$FUSION_DIR/cross-repo-acceptance.sh" >/dev/null 2>&1
check "cross-repo-acceptance fails on a status-1 row that is not apply-receipt" "$?" "1"

# ─── T25: the alert path is validated, split by condition, and POSTED ───────
# submit-receipt-worker.sh had NO alerting code: its "ALERT" was an `echo … >&2`,
# which under nohup reaches nobody, while runbook §5.5 claimed both harnesses
# page. The other (the draft watcher, deleted in issue 1698) posted only if curl
# and jq happened to be present, shared one dedup key across two conditions,
# never resolved, and discarded delivery failures with `|| true`.
echo
echo "T25 — the Fusion harness alert path"

# A PATH with every binary these scripts need EXCEPT curl, so the startup
# validation is exercised for real rather than simulated.
path_without_curl() {
  local d="$STUB_DIR/nocurl" b src
  mkdir -p "$d"
  for b in bash env jq mktemp tr sleep dirname cat rm mv wc grep date sed cut diff timeout basename mkdir touch printf; do
    src="$(command -v "$b" 2>/dev/null)" && ln -sf "$src" "$d/$b"
  done
  cp "$STUB_DIR/bin/rmpc" "$STUB_DIR/bin/cast" "$d/"
  printf '%s' "$d"
}

new_stubs; worker_env
NOCURL="$(path_without_curl)"
export FUSION_ALERT_WEBHOOK="https://alerts.invalid/hook"
export FUSION_MAX_ATTEMPTS=1
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
err="$(PATH="$NOCURL" bash "$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"; rc=$?
check "the worker refuses to start when the webhook is set but curl is missing" "$rc" "1"
if grep -q "curl is not on PATH" <<<"$err"; then
  ok "the undeliverable alert path is named at startup"
else
  bad "the worker started with an undeliverable alert path: $err"
fi
# NEGATIVE CONTROL: the same PATH with no webhook must START and warn.
unset FUSION_ALERT_WEBHOOK
err="$(PATH="$NOCURL" bash "$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"; rc=$?
check "…but an unset webhook still starts" "$rc" "0"
if grep -q "WARNING FUSION_ALERT_WEBHOOK is unset" <<<"$err"; then
  ok "an unset webhook logs one explicit stderr-only warning"
else
  bad "the stderr-only alert path was silent: $err"
fi

# THE PAGE MUST BE POSTED, NOT ECHOED.
new_stubs; worker_env; new_curl_stub
export FUSION_ALERT_WEBHOOK="https://alerts.invalid/hook"
echo 1 >"$STUB_DIR/rpc_down"
export FUSION_MAX_ATTEMPTS=1
timeout 8 "$FUSION_DIR/submit-receipt-worker.sh" >/dev/null 2>&1
if jq -e 'select(.event_action=="trigger" and .dedup_key=="fusion_submit_worker_chain_reads_down")' \
     "$STUB_DIR/alert_posts" >/dev/null 2>&1; then
  ok "the worker POSTs its read-outage page under its own dedup key"
else
  bad "the worker's ALERT never reached the webhook: $(cat "$STUB_DIR/alert_posts")"
fi
# NEGATIVE CONTROL: no outage, no page.
new_stubs; worker_env; new_curl_stub
export FUSION_ALERT_WEBHOOK="https://alerts.invalid/hook"
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
export FUSION_MAX_ATTEMPTS=1
timeout 8 "$FUSION_DIR/submit-receipt-worker.sh" >/dev/null 2>&1
check "a healthy worker pages nobody" "$(wc -l <"$STUB_DIR/alert_posts" | tr -d ' ')" "0"

# A DELIVERY FAILURE IS LOGGED, NOT SWALLOWED BY `|| true`.
new_stubs; worker_env; new_curl_stub
export FUSION_ALERT_WEBHOOK="https://alerts.invalid/hook"
echo 1 >"$STUB_DIR/alert_post_fail"
echo 1 >"$STUB_DIR/rpc_down"
export FUSION_MAX_ATTEMPTS=1
err="$(timeout 8 "$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"
if grep -q "ALERT DELIVERY FAILED" <<<"$err"; then
  ok "a page that could not be delivered is reported, not discarded"
else
  bad "the undelivered page was swallowed: $err"
fi
# NEGATIVE CONTROL: a webhook that accepts must not log a delivery failure.
new_stubs; worker_env; new_curl_stub
export FUSION_ALERT_WEBHOOK="https://alerts.invalid/hook"
echo 1 >"$STUB_DIR/rpc_down"
export FUSION_MAX_ATTEMPTS=1
err="$(timeout 8 "$FUSION_DIR/submit-receipt-worker.sh" 2>&1 >/dev/null)"
if grep -q "ALERT DELIVERY FAILED" <<<"$err"; then
  bad "a successful delivery was reported as failed: $err"
else
  ok "a delivered page logs no delivery failure"
fi
unset FUSION_ALERT_WEBHOOK

# ─── T24: the one envelope-unwrap rule, driven by the SHARED fixture ─────────
# Not an inline literal. tests/fixtures/consensus-receipt.envelope.json is
# byte-identical to robotmoney-frontend's copy and pinned by both fixture
# manifests, so this test and rmpc's test read the same bytes.
source "$FUSION_DIR/lib/receipt-envelope.sh"
REPO_ROOT="$(cd "$FUSION_DIR/../.." && pwd)"
FX="$REPO_ROOT/tests/fixtures"
UW="$(mktemp -d)"

receipt_unwrap_envelope "$FX/consensus-receipt.envelope.json" "$UW/from-envelope.json"
check "the shared envelope fixture unwraps (exit)" "$?" "0"
receipt_unwrap_envelope "$FX/consensus-receipt.valid.json" "$UW/from-bare.json"
check "a bare receipt passes through (exit)" "$?" "0"
if cmp -s "$UW/from-envelope.json" "$UW/from-bare.json"; then
  ok "unwrapping the envelope yields the bare receipt byte-for-byte"
else
  bad "the envelope's .receipt is not the shared valid fixture: $(diff <(jq -S . "$UW/from-envelope.json") <(jq -S . "$UW/from-bare.json") | head -5)"
fi
check "the unwrapped object carries schema_version" \
  "$(jq -r '.schema_version' "$UW/from-envelope.json")" "1.0"

# THE NEGATIVE THAT THE DELETED jq COPY GOT WRONG. The negative-stage copy had
# dropped the `.receipt | has("schema_version")` guard, so a body that was
# neither a receipt nor an envelope wrote the literal `null` into receipt.json
# and every later assertion read that as real.
printf '{"error":"not found"}' >"$UW/neither.json"
receipt_unwrap_envelope "$UW/neither.json" "$UW/neither-out.json" 2>/dev/null
check "a body that is neither receipt nor envelope is REFUSED" "$?" "1"
check "and no receipt file is left behind" "$([[ -e "$UW/neither-out.json" ]] && echo yes || echo no)" "no"
printf 'not json at all' >"$UW/garbage.json"
receipt_unwrap_envelope "$UW/garbage.json" "$UW/garbage-out.json" 2>/dev/null
check "non-JSON is REFUSED" "$?" "2"
# An envelope whose .receipt is itself not a receipt must not be unwrapped.
jq '.receipt = {"note":"no schema_version here"}' "$FX/consensus-receipt.envelope.json" >"$UW/bad-inner.json"
receipt_unwrap_envelope "$UW/bad-inner.json" "$UW/bad-inner-out.json" 2>/dev/null
check "an envelope carrying a non-receipt is REFUSED" "$?" "1"

# THE DECOY THE TWO IMPLEMENTATIONS DISAGREED ON (VERIFY/T24-refuter1.md).
# This literal is the SAME one rmpc's unit test uses
# (clients/rust-payment-client/src/consensus_receipt.rs,
# a_published_envelope_is_unwrapped_to_the_same_bytes_as_the_bare_receipt).
# Before this fix, bash exited 0 and wrote the whole decoy as receipt.json
# while rmpc refused it with `unknown field \`receipt\`` — the acceptance
# gate accepted a body the verifier refuses. "One rule" means one behaviour.
printf '{"schema_version":"1.0","receipt":{"schema_version":"1.0"}}' >"$UW/decoy.json"
receipt_unwrap_envelope "$UW/decoy.json" "$UW/decoy-out.json" 2>/dev/null
check "the receipt-shaped-AND-envelope-shaped decoy is REFUSED, as rmpc refuses it" "$?" "4"
check "and the decoy leaves no receipt file behind" \
  "$([[ -e "$UW/decoy-out.json" ]] && echo yes || echo no)" "no"
rm -rf "$UW"

# ─── The ONE explorer-API row rule (lib/explorer-api.sh) ────────────────────
# Replaces three inline `a // b` dual-shape idioms in devnet-acceptance.sh that
# disagreed with each other about which object wins (:399 preferred the bare
# field, :418/:495 preferred the wrapped one) and that collapsed an explicit
# `false` into a lookup of a different key.
# shellcheck source=../lib/explorer-api.sh
source "$FUSION_DIR/lib/explorer-api.sh"
EX="$(mktemp -d)"

printf '{"receipt_id":"0xabc","verified":true,"released":false}' >"$EX/bare.json"
check "a bare explorer row resolves its receipt_id" \
  "$(explorer_api_field "$EX/bare.json" receipt_id)" "0xabc"
explorer_api_flag_is_true "$EX/bare.json" verified
check "a bare row reporting verified=true is TRUE" "$?" "0"
explorer_api_flag_is_true "$EX/bare.json" released
check "a bare row reporting released=false is FALSE" "$?" "1"

printf '{"receipt":{"receipt_id":"0xabc","verified":true,"released":true}}' >"$EX/wrapped.json"
check "a wrapped explorer row resolves its receipt_id" \
  "$(explorer_api_field "$EX/wrapped.json" receipt_id)" "0xabc"
explorer_api_flag_is_true "$EX/wrapped.json" released
check "a wrapped row reporting released=true is TRUE" "$?" "0"

# THE AMBIGUITY THE OLD IDIOMS RESOLVED INCONSISTENTLY: with both shapes
# present, :399 read the top level and :418 read `.receipt`. Refuse instead.
printf '{"receipt_id":"0xTOP","receipt":{"receipt_id":"0xNESTED"}}' >"$EX/both.json"
explorer_api_row "$EX/both.json" >/dev/null 2>&1
check "a row carrying BOTH shapes is REFUSED rather than silently picked" "$?" "4"

printf '{"error":"not found"}' >"$EX/neither.json"
explorer_api_row "$EX/neither.json" >/dev/null 2>&1
check "a body that is no explorer row at all is REFUSED" "$?" "1"
printf 'not json' >"$EX/garbage.json"
explorer_api_row "$EX/garbage.json" >/dev/null 2>&1
check "non-JSON is REFUSED by the explorer helper too" "$?" "2"

# The false-y collapse `a // b` produced: an explicit verified=false with an
# unrelated sibling `verified` on the other shape used to read as true.
# The false-y collapse `(.receipt.verified // .verified)` produced: the row's
# OWN verified is an explicit `false`, and `//` treats false as "absent" and
# falls through to an unrelated top-level sibling that says true. The helper
# resolves the row ONCE (here: `.receipt`, since only it carries receipt_id)
# and reads the flag off that row and nothing else.
printf '{"receipt":{"receipt_id":"0xabc","verified":false},"verified":true}' >"$EX/collapse.json"
check "the collapse body resolves to the row that owns receipt_id" \
  "$(explorer_api_field "$EX/collapse.json" receipt_id)" "0xabc"
explorer_api_flag_is_true "$EX/collapse.json" verified
check "an explicit verified=false is NOT collapsed into a sibling key saying true" "$?" "1"

# A flag that is the STRING "true" is not the boolean true.
printf '{"receipt_id":"0xabc","verified":"true"}' >"$EX/stringy.json"
explorer_api_flag_is_true "$EX/stringy.json" verified
check "a stringy \"true\" is not JSON true" "$?" "1"
# An absent flag reads as false, never as an error swallowed into a pass.
explorer_api_flag_is_true "$EX/stringy.json" released
check "an absent flag is FALSE" "$?" "1"
rm -rf "$EX"

# ─── The workflow's independent floor must not trail this script's ──────────
if [[ ! -f "$FUSION_SELFTEST_WORKFLOW" ]]; then
  # Loud-skip policy: no workflow, no second opinion -- that is a red, not a pass.
  bad "$FUSION_SELFTEST_WORKFLOW is missing — nothing re-checks this suite's executed count independently"
else
  WORKFLOW_FLOOR="$(grep -o 'count" -lt [0-9][0-9]*' "$FUSION_SELFTEST_WORKFLOW" \
    | head -1 | grep -o '[0-9][0-9]*$' || true)"
  if [[ -z "$WORKFLOW_FLOOR" ]]; then
    bad "could not read the executed-assertion floor out of $(basename "$FUSION_SELFTEST_WORKFLOW") — the independent guard may have been removed"
  elif [[ "$WORKFLOW_FLOOR" == "$MIN_EXPECTED_ASSERTIONS" ]]; then
    ok "the workflow's floor ($WORKFLOW_FLOOR) equals MIN_EXPECTED_ASSERTIONS ($MIN_EXPECTED_ASSERTIONS)"
  else
    bad "the workflow's floor is $WORKFLOW_FLOOR but MIN_EXPECTED_ASSERTIONS is $MIN_EXPECTED_ASSERTIONS — raise both in the same commit"
  fi
fi

echo
echo "scripts/fusion self-tests: $PASS passed, $FAIL failed"
# Machine-readable contract line. The workflow greps THIS, not the exit code,
# so a suite that asserted nothing cannot report a green.
echo "FUSION_SELFTESTS_EXECUTED=$PASS"
if [[ "$PASS" -lt "$MIN_EXPECTED_ASSERTIONS" ]]; then
  echo "FAIL — only $PASS assertions executed, expected at least $MIN_EXPECTED_ASSERTIONS: a suite that asserts nothing is a false green" >&2
fi
[[ "$FAIL" -eq 0 && "$PASS" -ge "$MIN_EXPECTED_ASSERTIONS" ]]
