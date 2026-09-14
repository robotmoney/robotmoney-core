#!/usr/bin/env bash
# Persistent, restart-safe ReceiptReleased watcher. It emits human-review-only
# proposal drafts via rmpc; it never invokes a write command or signs anything.
#
# LIVENESS IS A PROPERTY OF THIS LOOP, NOT JUST OF ONE SCAN
# ---------------------------------------------------------
# AC-GOV-01 asks for a *persistent* watcher, and AC-E2E-06 requires the tampered
# receipt path not to break the system. Both fail the same way: one receipt in
# the confirmed range that can never be drafted (tampered bytes, a digest that
# does not match the anchored one, a receipt id that does not derive from the
# bytes) makes the scan fail, the cursor never advances, the rescanned range
# grows without bound and every later release is never drafted — silently.
#
# The opposite failure is just as bad and was the one actually shipped: absorb
# EVERYTHING and the cursor sails past receipts nothing ever examined. A 404, a
# 503 or a 10 s timeout would then permanently un-draft a released receipt, and
# because the cursor moved, the stall alert could not fire either.
#
# So refusals are split by CAUSE, and the cause decides the cursor:
#
#   1. CONTENT refusals (tampered bytes, digest mismatch, bad signature, no
#      eligible vault) are properties of that receipt and reproduce forever.
#      `rmpc governance draft-proposal` reports them as `"refused"` entries
#      inside the range result and exits 0. This loop reads `.drafts[]`,
#      QUARANTINES each refused receipt and ALERTS — and only then advances the
#      cursor. An exit code alone can no longer be mistaken for "all clear".
#   2. TRANSPORT refusals (unreachable payload URL, unreadable file, RPC down)
#      are properties of the moment. rmpc exits non-zero for them; the cursor is
#      HELD and the range retried, which is where holding is correct.
#   3. A cursor that has not advanced for FUSION_STALL_ALERT_CYCLES cycles
#      alerts, and the scan window is capped so `from` can never sit at the
#      genesis start block forever.
#   4. A failed chain read (`cast block-number`) is itself a transport failure,
#      not a reason to die: under `set -e` a bare assignment used to terminate
#      the whole loop with no alert at all. It is guarded, counted and retried,
#      and a supervisor (scripts/fusion/fusion-draft-watcher.service) restarts
#      the process if it ever does exit.
set -euo pipefail

fail() { echo "fusion-draft-watcher: $*" >&2; exit 1; }

# alert <dedup_key> <summary…>
#
# The dedup key is a parameter because a quarantined receipt and a stalled
# cursor are different incidents: collapsing them onto one key means resolving
# either one closes both, which is the failure `alert.rs` names outright.
alert() {
  local key="$1"; shift
  echo "fusion-draft-watcher: ALERT $*" >&2
  if [[ -n "${FUSION_ALERT_WEBHOOK:-}" ]] && command -v curl >/dev/null && command -v jq >/dev/null; then
    curl -fsS -m 10 -X POST -H 'content-type: application/json' \
      --data "$(jq -n --arg s "$*" --arg k "$key" '{event_action:"trigger",dedup_key:$k,payload:{summary:$s,severity:"critical",source:"fusion-draft-watcher"}}')" \
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
# Every cycle's draft result is persisted, so "what did the watcher actually
# see?" is answerable after the fact rather than only from a lost stdout.
RESULT_FILE="${FUSION_DRAFT_RESULT:-${FUSION_DRAFT_CURSOR}.last-result.json}"

# rmpc governance draft-proposal exit codes.
EXIT_REFUSAL=2

for value in "$POLL_SECS" "$CONFIRMATIONS" "$FUSION_START_BLOCK" "$MAX_SPAN" "$STALL_CYCLES"; do
  [[ "$value" =~ ^[0-9]+$ ]] || fail "poll, confirmations, start block, scan span and stall cycles must be integers"
done
(( MAX_SPAN > 0 )) || fail "FUSION_MAX_SCAN_BLOCKS must be > 0"
command -v "$RMPC_BIN" >/dev/null || fail "rmpc binary not found: $RMPC_BIN"
command -v "$CAST_BIN" >/dev/null || fail "cast binary not found: $CAST_BIN"
# jq is load-bearing now, not decorative: without it the refused entries inside
# an ok:true range cannot be read at all, and the watcher would be back to
# trusting an exit code. Refuse at startup rather than degrade silently.
command -v jq >/dev/null || fail "jq not found; it is required to read the per-receipt draft results"

mkdir -p "$(dirname "$FUSION_DRAFT_CURSOR")" "$(dirname "$QUARANTINE")" "$(dirname "$RESULT_FILE")"
if [[ ! -e "$FUSION_DRAFT_CURSOR" ]]; then
  printf '%s\n' "$FUSION_START_BLOCK" >"$FUSION_DRAFT_CURSOR"
fi

write_cursor() {
  local next="$1" tmp="${FUSION_DRAFT_CURSOR}.tmp.$$"
  printf '%s\n' "$next" >"$tmp"
  mv "$tmp" "$FUSION_DRAFT_CURSOR"
}

# Read the producer's own contract. Returns 0 if the range is clean, 1 if it
# carried at least one refused receipt (already quarantined and alerted).
quarantine_refusals() {
  local out="$1" from="$2" to="$3" refused_count line
  if ! refused_count="$(jq -r '[.drafts[]? | select(.status == "refused")] | length' <<<"$out" 2>/dev/null)"; then
    # An unparseable range result is NOT "no refusals": it is a result we could
    # not read, and reading it is the whole defence.
    alert "fusion_draft_watcher_unreadable_result" \
      "range $from-$to produced a draft result that is not JSON; treating the range as unverified"
    return 1
  fi
  [[ "$refused_count" =~ ^[0-9]+$ ]] || return 1
  (( refused_count > 0 )) || return 0
  while IFS= read -r line; do
    printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$from" "$to" "$line" >>"$QUARANTINE"
  done < <(jq -r '.drafts[]? | select(.status == "refused")
                  | [(.receipt_id // "?"), (.error // "?"), (.reason // "")] | @tsv' <<<"$out")
  alert "fusion_draft_watcher_refused_receipt" \
    "$refused_count receipt(s) in range $from-$to were REFUSED and could not be drafted; \
quarantined in $QUARANTINE"
  return 1
}

stalled_cycles=0
read_failures=0
while true; do
  scan_failed=0
  from="$(tr -d '[:space:]' <"$FUSION_DRAFT_CURSOR")"
  [[ "$from" =~ ^[0-9]+$ ]] || fail "invalid cursor: $from"

  # A chain read can fail for the same reasons a payload fetch can. Under
  # `set -e` a bare `head="$(cast block-number)"` terminated the whole loop —
  # no alert, no stall increment, and an exit 1 indistinguishable from a config
  # error. Guard it, validate the shape before any arithmetic, and retry.
  if ! head="$("$CAST_BIN" block-number --rpc-url "$FUSION_RPC_URL" 2>/dev/null)" \
     || [[ ! "$head" =~ ^[0-9]+$ ]]; then
    read_failures=$((read_failures + 1))
    stalled_cycles=$((stalled_cycles + 1))
    echo "fusion-draft-watcher: chain head read failed (attempt $read_failures); cursor remains at $from" >&2
    if (( read_failures >= STALL_CYCLES )); then
      alert "fusion_draft_watcher_chain_read" \
        "cast block-number has failed $read_failures consecutive times against $FUSION_RPC_URL; \
no release can be drafted while the chain is unreadable"
      read_failures=0
    fi
    if [[ "${FUSION_RUN_ONCE:-0}" == "1" ]]; then
      exit 1
    fi
    sleep "$POLL_SECS"
    continue
  fi
  read_failures=0

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
    draft_out="$("$RMPC_BIN" governance -c "$FUSION_RMPC_CONFIG" draft-proposal \
      --from-block "$from" --to-block "$to_hex" \
      --receipt-url-template "$FUSION_RECEIPT_URL_TEMPLATE" 2>/dev/null)" || rc=$?
    printf '%s\n' "$draft_out" >"$RESULT_FILE"

    if (( rc == 0 )); then
      # EXIT 0 IS NOT "NOTHING WAS REFUSED". Read the per-receipt contract the
      # producer emits, quarantine and page BEFORE the cursor moves — once it
      # has moved, that receipt is never looked at again.
      if quarantine_refusals "$draft_out" "$from" "$to"; then
        stalled_cycles=0
      else
        scan_failed=1
        stalled_cycles=0
      fi
      write_cursor $((to + 1))
    elif (( rc == EXIT_REFUSAL )); then
      # Single-receipt-shaped content refusal escaping into range mode. Record
      # the range so a human can replay it, then move on: a poison receipt must
      # cost one range, never every future release.
      quarantine_refusals "$draft_out" "$from" "$to" || true
      printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$from" "$to" "range-refused exit $rc" >>"$QUARANTINE"
      alert "fusion_draft_watcher_refused_receipt" \
        "range $from-$to refused (exit $rc); quarantined in $QUARANTINE and skipped"
      write_cursor $((to + 1))
      stalled_cycles=0
      scan_failed=1
    else
      # Transport / RPC / configuration. The receipts in this range were never
      # examined, so the range is NOT complete: hold the cursor and retry.
      stalled_cycles=$((stalled_cycles + 1))
      echo "fusion-draft-watcher: scan failed (exit $rc); cursor remains at $from and will retry" >&2
      if (( stalled_cycles >= STALL_CYCLES )); then
        alert "fusion_draft_watcher_stalled" \
          "cursor has not advanced past block $from for $stalled_cycles cycles (last exit $rc)"
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
