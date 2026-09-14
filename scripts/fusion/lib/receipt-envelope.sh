#!/usr/bin/env bash
# The ONE shell implementation of the consensus-receipt envelope-unwrap rule (T24).
#
# WHY THIS FILE EXISTS
# --------------------
# §E.1 recorded three consumers of the envelope shape with no shared fixture.
# It was wider than that: `devnet-acceptance.sh` carried two more hand-written
# `jq` copies, and the negative-stage copy had dropped the
# `.receipt | has("schema_version")` guard the verify-stage copy had — so on a
# body that was neither a receipt nor an envelope it wrote the literal `null`
# into `receipt.json` and every later assertion read that. One rule, one
# implementation, one shared fixture
# (`tests/fixtures/consensus-receipt.envelope.json`).
#
# THE RULE (also stated in tests/fixtures/CONSENSUS-RECEIPT-SHARED-FIXTURES.md):
#   1. top level has `schema_version`      -> it IS the receipt
#   2. else `.receipt` has `schema_version` -> the receipt is `.receipt`
#   3. else                                 -> REFUSE (non-zero, no output file)
#
# Usage: receipt_unwrap_envelope <body.json> <receipt-out.json>
#        exit 0 = a receipt was written; non-zero = refused, nothing written.

receipt_unwrap_envelope() {
  local body="$1" out="$2"

  if [[ ! -s "$body" ]]; then
    echo "receipt_unwrap_envelope: $body is missing or empty" >&2
    return 2
  fi
  if ! jq -e . "$body" >/dev/null 2>&1; then
    echo "receipt_unwrap_envelope: $body is not valid JSON" >&2
    return 2
  fi

  if jq -e 'has("schema_version")' "$body" >/dev/null 2>&1; then
    cp "$body" "$out"
    return 0
  fi
  if jq -e '.receipt | objects | has("schema_version")' "$body" >/dev/null 2>&1; then
    # A temp file, then a move: a jq failure must never leave a truncated or
    # `null` receipt.json behind for a later stage to read as real.
    if jq -e '.receipt' "$body" >"$out.tmp" 2>/dev/null; then
      mv "$out.tmp" "$out"
      return 0
    fi
    rm -f "$out.tmp"
    echo "receipt_unwrap_envelope: $body looked like an envelope but .receipt could not be extracted" >&2
    return 3
  fi

  echo "receipt_unwrap_envelope: $body is neither a schema-1.0 receipt nor an envelope carrying one" >&2
  return 1
}
