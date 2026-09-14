#!/usr/bin/env bash
# Self-tests for the Fusion acceptance harnesses in scripts/fusion/.
#
# WHY THESE EXIST
# ---------------
# project-fusion.md AC-CORE-09 requires the submitter to be "retryable/idempotent"
# and AC-GOV-01 requires "watcher/restart/idempotency tests [that] prove draft-only
# behavior". Both properties live in shell, and both are exactly the kind of claim
# that is asserted in a comment and never executed. These tests execute them.
#
# HOW
# ---
# `rmpc` and `cast` are replaced by stub binaries on PATH whose behavior is driven
# by files in a scratch directory, so an attempt, a chain state and a failure are
# all observable without a node. The negative control matters most: the watcher
# test asserts the stub `rmpc` was NEVER invoked with a write subcommand, which is
# a claim no amount of reading the script can settle.
#
# Usage: scripts/fusion/tests/run-tests.sh   (exit 0 = all passed)
set -uo pipefail

FUSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
# STUB_DIR/block_number   — what `cast block-number` reports
# STUB_DIR/scan_fail      — non-empty makes rmpc governance draft-proposal fail
# STUB_DIR/scan_exit      — exit code that failure uses (default 1)
# STUB_DIR/submit_no_anchor   — non-empty: submit exits 0 WITHOUT anchoring
# STUB_DIR/uri_embeds_digest  — non-empty: payloadUri contains the derived digest
# STUB_DIR/malformed_tuple    — non-empty: getReceiptById emits a garbage tuple
# STUB_DIR/rpc_down           — non-empty: every `cast call` fails like an outage
# STUB_DIR/released           — non-empty: isReleased reports true
# STUB_DIR/release_sends      — one line per `cast send` (a release broadcast)
new_stubs() {
  STUB_DIR="$(mktemp -d)"
  mkdir -p "$STUB_DIR/bin"
  : >"$STUB_DIR/chain_digest"
  echo 0 >"$STUB_DIR/submit_fail_n"
  : >"$STUB_DIR/attempts"
  : >"$STUB_DIR/rmpc_calls"
  echo 100 >"$STUB_DIR/block_number"
  : >"$STUB_DIR/scan_fail"
  echo 1 >"$STUB_DIR/scan_exit"
  : >"$STUB_DIR/submit_no_anchor"
  : >"$STUB_DIR/uri_embeds_digest"
  : >"$STUB_DIR/malformed_tuple"
  : >"$STUB_DIR/rpc_down"
  : >"$STUB_DIR/verify_ok_false_exit_zero"
  : >"$STUB_DIR/released"
  : >"$STUB_DIR/release_sends"

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
      printf '{"ok":true,"action":"verify","receipt_id":"%s","payload_digest":"%s"}\n' \
        "$FUSION_TEST_RECEIPT_ID" "$FUSION_TEST_DIGEST"
      exit 0
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
  governance)
    [[ -s "$STUB_DIR/scan_fail" ]] && { echo "stub: scan failed" >&2; exit "$(cat "$STUB_DIR/scan_exit")"; }
    echo '{"ok":true,"drafts":[]}'
    exit 0
    ;;
esac
echo "stub rmpc: unexpected argv: $*" >&2
exit 2
STUB

  cat >"$STUB_DIR/bin/cast" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  block-number) cat "$STUB_DIR/block_number"; exit 0 ;;
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
      isRecorded*) [[ -n "$d" ]] && echo true || echo false; exit 0 ;;
      isReleased*) [[ -s "$STUB_DIR/released" ]] && echo true || echo false; exit 0 ;;
      releaseReceipt*)
        # An eth_call of releaseReceipt: already-released receipts revert.
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
if grep -q "ALERT chain reads have failed" <<<"$err"; then
  ok "consecutive read outages page"
else
  bad "a read-side outage was silent: $err"
fi

# ─── AC-GOV-01: restart-safe, draft-only watcher ─────────────────────────────
echo "AC-GOV-01 — watch-released-drafts.sh"

watcher_env() {
  export FUSION_RMPC_CONFIG="$STUB_DIR/rmpc.toml"; : >"$FUSION_RMPC_CONFIG"
  export FUSION_RPC_URL="http://127.0.0.1:1"
  export FUSION_RECEIPT_URL_TEMPLATE="https://example.invalid/{receipt_id}.json"
  export FUSION_DRAFT_CURSOR="$STUB_DIR/state/cursor"
  export FUSION_START_BLOCK=10
  export FUSION_CONFIRMATIONS=2
  export FUSION_RUN_ONCE=1
}

new_stubs; watcher_env
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1; rc=$?
check "one confirmed pass exits 0" "$rc" "0"
check "cursor advanced past the confirmed head (100-2+1)" \
  "$(cat "$FUSION_DRAFT_CURSOR")" "99"

# Restart with no new confirmed blocks: nothing to scan, cursor untouched.
: >"$STUB_DIR/rmpc_calls"
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1
check "restart with no new confirmed blocks scans nothing" \
  "$(wc -l <"$STUB_DIR/rmpc_calls" | tr -d ' ')" "0"
check "cursor is unchanged when no new confirmed blocks arrived" \
  "$(cat "$FUSION_DRAFT_CURSOR")" "99"

# Restart with the chain advanced: the window must resume at the durable cursor,
# never reset to FUSION_START_BLOCK. This is the restart-safety property.
echo 110 >"$STUB_DIR/block_number"
: >"$STUB_DIR/rmpc_calls"
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1
check "restart resumes from the durable cursor, not FUSION_START_BLOCK" \
  "$(grep -c -- '--from-block 99' "$STUB_DIR/rmpc_calls")" "1"
check "restart re-scanned no already-scanned block" \
  "$(grep -c -- "--from-block $FUSION_START_BLOCK" "$STUB_DIR/rmpc_calls")" "0"
check "cursor advanced to the new confirmed head (110-2+1)" \
  "$(cat "$FUSION_DRAFT_CURSOR")" "109"

new_stubs; watcher_env
echo 1 >"$STUB_DIR/scan_fail"
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1; rc=$?
check "a failed scan exits non-zero under FUSION_RUN_ONCE" "$rc" "1"
check "a failed scan does not advance the cursor" \
  "$(cat "$FUSION_DRAFT_CURSOR")" "10"

# THE WEDGE. One receipt in the confirmed range that can never be drafted (404
# payload, tampered bytes, receipt-id mismatch) used to stop the cursor dead:
# every later release went undrafted forever and nothing alerted. An
# EXIT_REFUSAL (2) must quarantine the range and MOVE ON.
new_stubs; watcher_env
echo 1 >"$STUB_DIR/scan_fail"
echo 2 >"$STUB_DIR/scan_exit"
export FUSION_DRAFT_QUARANTINE="$STUB_DIR/state/quarantine"
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1
check "a refused range advances the cursor instead of wedging" \
  "$(cat "$FUSION_DRAFT_CURSOR")" "99"
check "the refused range is quarantined durably" \
  "$(grep -c '10' "$FUSION_DRAFT_QUARANTINE")" "1"

# A later good release must actually be drafted after that poison range.
echo 300 >"$STUB_DIR/block_number"
: >"$STUB_DIR/scan_fail"
: >"$STUB_DIR/rmpc_calls"
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1; rc=$?
check "the next range after a quarantined one is scanned" "$rc" "0"
check "it resumes at the block after the quarantined range" \
  "$(grep -c -- '--from-block 99' "$STUB_DIR/rmpc_calls")" "1"

# A transport/startup failure (exit 3) is where holding the cursor IS correct,
# and a cursor that will not move must page rather than sit quietly.
new_stubs; watcher_env
echo 1 >"$STUB_DIR/scan_fail"
echo 3 >"$STUB_DIR/scan_exit"
export FUSION_STALL_ALERT_CYCLES=1
err="$("$FUSION_DIR/watch-released-drafts.sh" 2>&1 >/dev/null)"; rc=$?
check "a transport failure holds the cursor" "$(cat "$FUSION_DRAFT_CURSOR")" "10"
if grep -q "ALERT cursor has not advanced" <<<"$err"; then
  ok "a motionless cursor pages"
else
  bad "the cursor stalled with no alert: $err"
fi
unset FUSION_STALL_ALERT_CYCLES

# The scan window is capped, so a held cursor can never grow an unbounded range.
new_stubs; watcher_env
echo 1000000 >"$STUB_DIR/block_number"
export FUSION_MAX_SCAN_BLOCKS=100
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1
check "the scan window is capped at FUSION_MAX_SCAN_BLOCKS" \
  "$(grep -c -- '--to-block 0x6d' "$STUB_DIR/rmpc_calls")" "1"
check "the cursor advances one capped page at a time" \
  "$(cat "$FUSION_DRAFT_CURSOR")" "110"
unset FUSION_MAX_SCAN_BLOCKS

# FUSION_START_BLOCK is mandatory: an implicit "latest" would silently skip
# every release that happened before the watcher first started.
new_stubs; watcher_env
unset FUSION_START_BLOCK
: >"$STUB_DIR/rmpc_calls"
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1; rc=$?
check "an unset FUSION_START_BLOCK refuses to start" "$rc" "1"
check "it refuses before calling rmpc or cast at all" \
  "$(wc -l <"$STUB_DIR/rmpc_calls" | tr -d ' ')" "0"
export FUSION_START_BLOCK=10

# Negative control: the watcher must never reach a write path.
new_stubs; watcher_env
"$FUSION_DIR/watch-released-drafts.sh" >/dev/null 2>&1
if grep -Eq '(^| )(submit|propose|vote|deposit|withdraw|send)( |$)' "$STUB_DIR/rmpc_calls"; then
  bad "watcher invoked a write subcommand: $(cat "$STUB_DIR/rmpc_calls")"
else
  ok "watcher invoked only read/draft subcommands"
fi
check "watcher passes --to-block as a hex quantity eth_getLogs accepts" \
  "$(grep -cE -- '--to-block 0x[0-9a-f]+' "$STUB_DIR/rmpc_calls")" "1"

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

# A REFUSAL REPORTED AS ok:false WITH EXIT 0 MUST NOT PASS. `rmpc governance
# draft-proposal` uses exactly that shape on purpose, so an exit-code-only
# assertion would read a refusal as a successful verification. Measured against
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
# `releaseReceipt` is a one-shot transition: a second send reverts
# ReceiptAlreadyReleased, so asserting on a fresh status 0x1 would fail the
# second run for doing exactly what a released receipt should do. The record
# stage has always been idempotent (submit-receipt-worker.sh reports
# `already_anchored` and broadcasts nothing); the release stage was not, and the
# asymmetry only appears on a second run.
new_stubs; acceptance_env
printf '{"schema_version":"1.0"}' >"$STUB_DIR/receipt.json"
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"   # already anchored
echo 1 >"$STUB_DIR/released"                                     # already released
export FUSION_RELEASE_KEYSTORE="$STUB_DIR/ks.json" \
       FUSION_RELEASE_PASSWORD_FILE="$STUB_DIR/pass" \
       FUSION_RELEASE_ADDRESS=0x00000000000000000000000000000000000000cc \
       FUSION_SUBMITTER_ADDRESS=0x00000000000000000000000000000000000000dd
: >"$STUB_DIR/ks.json"; : >"$STUB_DIR/pass"
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
if [[ -s "$RESULT" ]] && jq -e '[.assertions[] | select(.stage=="release" and (.assertion|test("the admin release transaction succeeds")))]
      | length == 1 and all(.result == "PASS" and (.assertion|test("idempotent no-op")))' "$RESULT" >/dev/null 2>&1; then
  ok "an already-released receipt is recorded as an idempotent no-op, named as one"
else
  bad "the second release was not an idempotent no-op: $(jq -c '[.assertions[]|select(.stage=="release")|{a:.assertion,r:.result}]' "$RESULT" 2>/dev/null)"
fi

# AND THE FIRST RUN MUST STILL SEND ONE. The no-op must not become a blanket
# pass that never releases anything.
new_stubs; acceptance_env
printf '{"schema_version":"1.0"}' >"$STUB_DIR/receipt.json"
printf '%s\n' "$FUSION_TEST_DIGEST" >"$STUB_DIR/chain_digest"
export FUSION_RELEASE_KEYSTORE="$STUB_DIR/ks.json" \
       FUSION_RELEASE_PASSWORD_FILE="$STUB_DIR/pass" \
       FUSION_RELEASE_ADDRESS=0x00000000000000000000000000000000000000cc \
       FUSION_SUBMITTER_ADDRESS=0x00000000000000000000000000000000000000dd
: >"$STUB_DIR/ks.json"; : >"$STUB_DIR/pass"
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
check "an unreleased receipt still broadcasts exactly one release" \
  "$(wc -l <"$STUB_DIR/release_sends" | tr -d ' ')" "1"

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
rm -rf "$UW"

echo
echo "scripts/fusion self-tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
