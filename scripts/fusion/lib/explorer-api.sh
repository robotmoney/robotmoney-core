#!/usr/bin/env bash
# The ONE shell implementation of the explorer API's consensus-receipt row shape.
#
# WHY THIS FILE EXISTS
# --------------------
# T24 consolidated the *published envelope* unwrap into
# `lib/receipt-envelope.sh`, but VERIFY/T24-refuter2.md (D2) and
# VERIFY/R4-core-refuter2.md (DEFECT 4) both named a residual: a SECOND,
# inline, tolerant dual-shape idiom survived in devnet-acceptance.sh for a
# DIFFERENT object — the explorer API's row at
# `GET {api}/v1/consensus-receipts/{receipt_id}`:
#
#   :399  jq -e '.receipt_id? // .receipt?.receipt_id? // empty'
#   :418  jq -e '(.receipt.verified // .verified) == true'
#   :420  jq -r '.receipt.verified // .verified'
#   :495  jq -e '(.receipt.released // .released) == true'
#
# Those are not the T24 rule, so they were correctly out of its scope — but
# they are the same unguarded shape, three times, written slightly differently
# each time (note :399 prefers the BARE field and :418 prefers the WRAPPED one:
# on a body carrying both, those two lines read different objects). `a // b` is
# also false-y-collapsing: `.receipt.verified` of `false` falls through to
# `.verified`, so a row explicitly reporting verified=false could be answered
# by an unrelated sibling key.
#
# THE RULE:
#   1. top level has `receipt_id`  -> the top level IS the row
#   2. else `.receipt` has `receipt_id` -> the row is `.receipt`
#   3. BOTH  -> REFUSE (ambiguous; the two old idioms disagreed here)
#   4. NEITHER -> REFUSE (non-zero, nothing written)
#
# Usage:
#   explorer_api_row <body.json>            # prints the row object, exit 0
#   explorer_api_field <body.json> <field>  # prints one raw field of the row
#   explorer_api_flag_is_true <body.json> <field>   # exit 0 iff field === true
#
# Self-tested in scripts/fusion/tests/run-tests.sh.

explorer_api_row() {
  local body="$1"

  if [[ ! -s "$body" ]]; then
    echo "explorer_api_row: $body is missing or empty" >&2
    return 2
  fi
  if ! jq -e . "$body" >/dev/null 2>&1; then
    echo "explorer_api_row: $body is not valid JSON" >&2
    return 2
  fi

  local top nested
  top=no; nested=no
  jq -e 'objects | has("receipt_id")' "$body" >/dev/null 2>&1 && top=yes
  jq -e '.receipt | objects | has("receipt_id")' "$body" >/dev/null 2>&1 && nested=yes

  if [[ "$top" == yes && "$nested" == yes ]]; then
    echo "explorer_api_row: $body is AMBIGUOUS — it carries both a top-level \`receipt_id\` and a \`.receipt.receipt_id\`. The idioms this helper replaced disagreed about which one to read; refusing is the only answer that cannot silently read the wrong object" >&2
    return 4
  fi
  if [[ "$top" == yes ]]; then
    jq -c '.' "$body"
    return 0
  fi
  if [[ "$nested" == yes ]]; then
    jq -c '.receipt' "$body"
    return 0
  fi

  echo "explorer_api_row: $body is not an explorer consensus-receipt row (no \`receipt_id\` at the top level or under \`.receipt\`)" >&2
  return 1
}

explorer_api_field() {
  local body="$1" field="$2" row
  row="$(explorer_api_row "$body")" || return $?
  # `--arg`, not string interpolation into the program: a field name is data.
  jq -r --arg f "$field" 'if has($f) then .[$f] else "<absent>" end' <<<"$row"
}

# Exit 0 ONLY on JSON `true`. Not `"true"`, not a truthy fallback from a
# sibling key, not an absent field: the assertions that call this are
# AC-CORE-07's verified/released clauses, where "we could not tell" must read
# as false, and where the old `a // b` collapsed an explicit `false` into a
# lookup of a different key.
explorer_api_flag_is_true() {
  local body="$1" field="$2" row
  row="$(explorer_api_row "$body")" || return $?
  jq -e --arg f "$field" '.[$f] == true' <<<"$row" >/dev/null 2>&1
}
