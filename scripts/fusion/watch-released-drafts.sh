#!/usr/bin/env bash
# Persistent, restart-safe ReceiptReleased watcher. It emits human-review-only
# proposal drafts via rmpc; it never invokes a write command or signs anything.
#
# LIVENESS IS A PROPERTY OF THIS LOOP, NOT JUST OF ONE SCAN
# ---------------------------------------------------------
# AC-GOV-01 asks for a *persistent* watcher, and AC-E2E-06 requires the tampered
# receipt path not to break the system. Both fail the same way: one receipt in
# the confirmed range that can never be drafted (404 payload URL, tampered
# bytes, a receipt id that does not derive from the bytes) makes the scan fail,
# the cursor never advances, the rescanned range grows without bound and every
# later release is never drafted — silently. Three defences, in order:
#
#   1. `rmpc governance draft-proposal` reports per-receipt content refusals
#      inside the range result and exits 0 for the range. Non-zero from scan
#      mode now means transport/RPC/config.
#   2. If it exits EXIT_REFUSAL (2) anyway, the range is written to a durable
#      quarantine file and the cursor advances past it. Only exit 3 (startup /
#      transport) holds the cursor, which is where holding is correct.
#   3. A cursor that has not advanced for FUSION_STALL_ALERT_CYCLES cycles
#      alerts, and the scan window is capped so `from` can never sit at the
#      genesis start block forever.
set -euo pipefail

fail() { echo "fusion-draft-watcher: $*" >&2; exit 1; }
alert() {
  echo "fusion-draft-watcher: ALERT $*" >&2
  if [[ -n "${FUSION_ALERT_WEBHOOK:-}" ]] && command -v curl >/dev/null && command -v jq >/dev/null; then
    curl -fsS -m 10 -X POST -H 'content-type: application/json' \
      --data "$(jq -n --arg s "$*" '{event_action:"trigger",dedup_key:"fusion_draft_watcher_stalled",payload:{summary:$s,severity:"critical",source:"fusion-draft-watcher"}}')" \
      "$FUSION_ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
}

: "${FUSION_RMPC_CONFIG:?set FUSION_RMPC_CONFIG}"
: "${FUSION_RPC_URL:?set FUSION_RPC_URL}"
: "${FUSION_RECEIPT_URL_TEMPLATE:?set FUSION_RECEIPT_URL_TEMPLATE}"
: "${FUSION_DRAFT_CURSOR:?set FUSION_DRAFT_CURSOR to a durable cursor file}"

RMPC_BIN="${RMPC_BIN:-rmpc}"
CAST_BIN="${CAST_BIN:-cast}"
POLL_SECS="${FUSION_POLL_SECS:-15}"
CONFIRMATIONS="${FUSION_CONFIRMATIONS:-2}"
: "${FUSION_START_BLOCK:?set FUSION_START_BLOCK; implicit latest would silently skip history}"
# Largest span scanned in one call. Caps both RPC cost and the unbounded-rescan
# failure mode: a held cursor still only ever asks for this many blocks.
MAX_SPAN="${FUSION_MAX_SCAN_BLOCKS:-50000}"
# Cycles of a motionless cursor before paging.
STALL_CYCLES="${FUSION_STALL_ALERT_CYCLES:-3}"
QUARANTINE="${FUSION_DRAFT_QUARANTINE:-${FUSION_DRAFT_CURSOR}.quarantine}"

# rmpc governance draft-proposal exit codes.
EXIT_REFUSAL=2

for value in "$POLL_SECS" "$CONFIRMATIONS" "$FUSION_START_BLOCK" "$MAX_SPAN" "$STALL_CYCLES"; do
  [[ "$value" =~ ^[0-9]+$ ]] || fail "poll, confirmations, start block, scan span and stall cycles must be integers"
done
(( MAX_SPAN > 0 )) || fail "FUSION_MAX_SCAN_BLOCKS must be > 0"
command -v "$RMPC_BIN" >/dev/null || fail "rmpc binary not found: $RMPC_BIN"
command -v "$CAST_BIN" >/dev/null || fail "cast binary not found: $CAST_BIN"

mkdir -p "$(dirname "$FUSION_DRAFT_CURSOR")"
if [[ ! -e "$FUSION_DRAFT_CURSOR" ]]; then
  printf '%s\n' "$FUSION_START_BLOCK" >"$FUSION_DRAFT_CURSOR"
fi

write_cursor() {
  local next="$1" tmp="${FUSION_DRAFT_CURSOR}.tmp.$$"
  printf '%s\n' "$next" >"$tmp"
  mv "$tmp" "$FUSION_DRAFT_CURSOR"
}

stalled_cycles=0
while true; do
  scan_failed=0
  from="$(tr -d '[:space:]' <"$FUSION_DRAFT_CURSOR")"
  [[ "$from" =~ ^[0-9]+$ ]] || fail "invalid cursor: $from"
  head="$("$CAST_BIN" block-number --rpc-url "$FUSION_RPC_URL")"
  if (( head >= CONFIRMATIONS )); then to=$((head - CONFIRMATIONS)); else to=0; fi
  # Page through a long backlog rather than asking for every block at once.
  if (( to - from + 1 > MAX_SPAN )); then to=$((from + MAX_SPAN - 1)); fi

  if (( from <= to )); then
    # eth_getLogs takes a hex quantity or a block tag, never a decimal string.
    # `cast block-number` prints decimal, so the conversion happens here rather
    # than being left to whatever the node does with "1234".
    to_hex="$(printf '0x%x' "$to")"
    # draft-proposal is structurally read-only (it imports no signer, no nonce
    # lock and no broadcast path). Advance the durable cursor only after the
    # complete confirmed range was scanned successfully.
    rc=0
    "$RMPC_BIN" governance -c "$FUSION_RMPC_CONFIG" draft-proposal \
      --from-block "$from" --to-block "$to_hex" \
      --receipt-url-template "$FUSION_RECEIPT_URL_TEMPLATE" || rc=$?
    if (( rc == 0 )); then
      write_cursor $((to + 1))
      stalled_cycles=0
    elif (( rc == EXIT_REFUSAL )); then
      # A content refusal the scanner could not absorb. Record the range so a
      # human can replay it, then move on: a poison receipt must cost one
      # range, never every future release.
      printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$from" "$to" >>"$QUARANTINE"
      alert "range $from-$to refused (exit $rc); quarantined in $QUARANTINE and skipped"
      write_cursor $((to + 1))
      stalled_cycles=0
      scan_failed=1
    else
      stalled_cycles=$((stalled_cycles + 1))
      echo "fusion-draft-watcher: scan failed (exit $rc); cursor remains at $from and will retry" >&2
      if (( stalled_cycles >= STALL_CYCLES )); then
        alert "cursor has not advanced past block $from for $stalled_cycles cycles (last exit $rc)"
        stalled_cycles=0
      fi
      scan_failed=1
    fi
  fi
  if [[ "${FUSION_RUN_ONCE:-0}" == "1" ]]; then
    exit "${scan_failed:-0}"
  fi
  sleep "$POLL_SECS"
done
