#!/usr/bin/env bash
# Retry one frontend-produced Fusion receipt until its exact digest is anchored.
# Idempotency is the on-chain (receipt_id, payload_digest) pair: before and after
# every submission attempt we accept success only when the existing receipt has
# the same digest. A conflicting digest is fatal and is never overwritten.
set -euo pipefail

fail() { echo "fusion-submit-worker: $*" >&2; exit 1; }

: "${FUSION_RMPC_CONFIG:?set FUSION_RMPC_CONFIG}"
: "${FUSION_RECEIPT_URL:?set FUSION_RECEIPT_URL}"
: "${FUSION_RECEIPT_ADDRESS:?set FUSION_RECEIPT_ADDRESS}"
: "${FUSION_RPC_URL:?set FUSION_RPC_URL}"

RMPC_BIN="${RMPC_BIN:-rmpc}"
CAST_BIN="${CAST_BIN:-cast}"
RETRY_SECS="${FUSION_RETRY_SECS:-15}"
MAX_ATTEMPTS="${FUSION_MAX_ATTEMPTS:-0}" # zero means persistent
READ_RETRIES="${FUSION_READ_RETRIES:-3}"            # per-cycle chain-read attempts
POST_SUBMIT_READ_RETRIES="${FUSION_POST_SUBMIT_READ_RETRIES:-5}"
READ_RETRY_SECS="${FUSION_READ_RETRY_SECS:-2}"
READ_FAILURE_ALERT="${FUSION_READ_FAILURE_ALERT:-3}" # consecutive read outages before paging

[[ "$RETRY_SECS" =~ ^[0-9]+$ && "$RETRY_SECS" -gt 0 ]] || fail "FUSION_RETRY_SECS must be > 0"
[[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || fail "FUSION_MAX_ATTEMPTS must be >= 0"
command -v "$RMPC_BIN" >/dev/null || fail "rmpc binary not found: $RMPC_BIN"
command -v "$CAST_BIN" >/dev/null || fail "cast binary not found: $CAST_BIN"
command -v jq >/dev/null || fail "jq is required"
for value in "$READ_RETRIES" "$POST_SUBMIT_READ_RETRIES" "$READ_RETRY_SECS" "$READ_FAILURE_ALERT"; do
  [[ "$value" =~ ^[0-9]+$ ]] || fail "read retry knobs must be integers"
done
(( READ_RETRIES > 0 && POST_SUBMIT_READ_RETRIES > 0 )) || fail "read retry counts must be > 0"

RPC_ERR="$(mktemp)"
trap 'rm -f "$RPC_ERR"' EXIT

verify_args=(--receipt-url "$FUSION_RECEIPT_URL")
submit_args=(--receipt-url "$FUSION_RECEIPT_URL")
if [[ -n "${FUSION_RECEIPT_FILE:-}" ]]; then
  verify_args=(--receipt-file "$FUSION_RECEIPT_FILE")
  submit_args+=(--receipt-file "$FUSION_RECEIPT_FILE")
fi

verified="$("$RMPC_BIN" receipt -c "$FUSION_RMPC_CONFIG" verify "${verify_args[@]}")" \
  || fail "receipt verification failed; no submission attempted"
receipt_id="$(jq -er '.receipt_id' <<<"$verified")"
payload_digest="$(jq -er '.payload_digest' <<<"$verified")"

# Read the chain once and classify the answer into exactly one of three states,
# because conflating two of them is how this worker used to misbehave:
#   0 = this exact (receipt_id, payload_digest) pair is anchored
#   1 = nothing is anchored for this receipt id
#   2 = the read RPC did not answer (outage, timeout, wrong endpoint)
# State 2 used to be indistinguishable from state 1, so a read-side outage made
# the worker re-broadcast forever (burning nonces, never alerting) and — worse —
# a transient read failure in the two lines after a SUCCESSFUL submit made it
# exit non-zero claiming the anchor was unobservable, aborting the caller under
# set -e even though the receipt had landed.
# A conflicting digest for this id is FATAL in any state: that is someone else's
# commitment and is never overwritten.
ANCHOR_ABSENT=1
ANCHOR_UNREADABLE=2
anchor_state() {
  local recorded tuple anchored rc
  recorded="$("$CAST_BIN" call "$FUSION_RECEIPT_ADDRESS" \
    'isRecorded(bytes32)(bool)' "$receipt_id" --rpc-url "$FUSION_RPC_URL" 2>"$RPC_ERR")" || rc=$?
  if [[ -n "${rc:-}" ]]; then
    echo "fusion-submit-worker: isRecorded read failed (exit $rc): $(tr -d '\n' <"$RPC_ERR")" >&2
    return "$ANCHOR_UNREADABLE"
  fi
  [[ "$recorded" == "true" ]] || return "$ANCHOR_ABSENT"
  tuple="$("$CAST_BIN" call "$FUSION_RECEIPT_ADDRESS" \
    'getReceiptById(bytes32)((bytes32,bytes32,string,address,uint64,uint64,bool))' \
    "$receipt_id" --rpc-url "$FUSION_RPC_URL" 2>"$RPC_ERR")" || rc=$?
  if [[ -n "${rc:-}" ]]; then
    echo "fusion-submit-worker: getReceiptById read failed (exit $rc): $(tr -d '\n' <"$RPC_ERR")" >&2
    return "$ANCHOR_UNREADABLE"
  fi
  # Compare the payloadDigest FIELD, not a substring of the whole tuple: the
  # struct also carries receiptId and a free-form payloadUri, and a substring
  # match would accept a digest that appears anywhere in either.
  # Receipt(bytes32 receiptId, bytes32 payloadDigest, string payloadUri, ...) —
  # both leading fields are fixed-width hex, so the first two commas delimit
  # payloadDigest regardless of what the URI contains.
  anchored="$(tr -d '() \n' <<<"$tuple" | cut -d, -f2 | tr '[:upper:]' '[:lower:]')"
  [[ "$anchored" =~ ^0x[0-9a-f]{64}$ ]] \
    || fail "could not read payloadDigest from getReceiptById output: $tuple"
  [[ "$anchored" == "${payload_digest,,}" ]] \
    || fail "receipt_id $receipt_id is already anchored with a conflicting digest \
(on chain: $anchored, derived: $payload_digest)"
  return 0
}

# Read with bounded retry, so an unavailable read endpoint is a named failure
# rather than a re-broadcast or a false "not observable". Sets ANCHOR_STATE to
# 0 (matching anchor) or 1 (nothing anchored) and returns 0; returns non-zero
# only when the RPC never answered.
#
# Deliberately a global rather than an echoed value in `$(...)`: `anchor_state`
# calls `fail` on a conflicting on-chain digest, and inside a command
# substitution that exit would kill only the subshell — turning a fatal
# "someone else anchored this id" into an ordinary read failure the loop
# retries forever.
ANCHOR_STATE=""
read_anchor_state() {
  local attempts="${1:-1}" i=1 st
  while true; do
    anchor_state && { ANCHOR_STATE=0; return 0; }
    st=$?
    if (( st == ANCHOR_ABSENT )); then ANCHOR_STATE="$ANCHOR_ABSENT"; return 0; fi
    if (( i >= attempts )); then
      ANCHOR_STATE="$ANCHOR_UNREADABLE"
      return 1
    fi
    echo "fusion-submit-worker: read retry $i/$attempts after an unreadable chain state" >&2
    i=$((i + 1))
    sleep "$READ_RETRY_SECS"
  done
}

attempt=0
read_failures=0
while true; do
  if read_anchor_state "$READ_RETRIES"; then
    read_failures=0
  else
    # The read side is down. Do NOT re-broadcast on a chain state we cannot
    # see: that burns nonces and gas against an unknown anchor state.
    read_failures=$((read_failures + 1))
    if (( read_failures >= READ_FAILURE_ALERT )); then
      echo "fusion-submit-worker: ALERT chain reads have failed $read_failures consecutive \
cycles at $FUSION_RPC_URL; anchor state for $receipt_id is unknown" >&2
      read_failures=0
    fi
    sleep "$RETRY_SECS"
    continue
  fi

  if [[ "$ANCHOR_STATE" == "0" ]]; then
    jq -n --arg receipt_id "$receipt_id" --arg payload_digest "$payload_digest" \
      '{ok:true,action:"already_anchored",receipt_id:$receipt_id,payload_digest:$payload_digest}'
    exit 0
  fi

  attempt=$((attempt + 1))
  echo "fusion-submit-worker: attempt $attempt receipt_id=$receipt_id" >&2
  if "$RMPC_BIN" receipt -c "$FUSION_RMPC_CONFIG" submit \
      "${submit_args[@]}" --expected-digest "$payload_digest"; then
    # Confirmation gets its own bounded read loop: "I could not read the chain"
    # must never be reported as "the anchor is missing" right after a success.
    read_anchor_state "$POST_SUBMIT_READ_RETRIES" || \
      fail "submit reported success but the chain could not be read back after \
$POST_SUBMIT_READ_RETRIES attempts; anchor state is UNKNOWN, not absent"
    [[ "$ANCHOR_STATE" == "0" ]] \
      || fail "submit reported success but the exact digest is not observable on chain"
    exit 0
  fi

  # A receipt-timeout can race with mining. Re-read before deciding to retry.
  if read_anchor_state "$READ_RETRIES" && [[ "$ANCHOR_STATE" == "0" ]]; then
    exit 0
  fi
  if [[ "$MAX_ATTEMPTS" -ne 0 && "$attempt" -ge "$MAX_ATTEMPTS" ]]; then
    fail "attempt budget exhausted; receipt remains unanchored"
  fi
  sleep "$RETRY_SECS"
done
