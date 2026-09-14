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
#   1. top level has `schema_version` AND no `receipt` key -> it IS the receipt
#   2. else `.receipt` has `schema_version` -> the receipt is `.receipt`
#   3. else                                 -> REFUSE (non-zero, no output file)
#
# RULE 1 AND THE DECOY — WHY THE `receipt` KEY IS A REFUSAL, NOT A TIE-BREAK
# -------------------------------------------------------------------------
# VERIFY/T24-refuter1.md fed both implementations of "the one rule" the body
#   {"schema_version":"1.0","receipt":{"schema_version":"1.0"}}
# and they DISAGREED: this function took rule 1, exited 0 and wrote the whole
# decoy object as receipt.json, while rmpc
# (`ConsensusReceipt::from_json_slice`) refused it with
# `ErrReceiptSchema: unknown field \`receipt\``. The acceptance gate's shell
# copy accepted a body rmpc refuses — two live implementations, not one rule.
#
# Rust reaches its refusal through `#[serde(deny_unknown_fields)]`: the top
# level DID win (that is why serde saw `receipt` at all), and then the receipt
# schema, which models no `receipt` field, refused the body by name. Shell
# cannot re-implement the schema, but it does not need to: the one input on
# which the two rules could ever disagree is a top level that is BOTH
# receipt-shaped and envelope-shaped, and that body is ambiguous by
# construction. So it is REFUSED here too, with its own exit code, rather than
# resolved by precedence. Asserted in scripts/fusion/tests/run-tests.sh against
# the same literal rmpc's unit test uses.
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
    # The decoy: receipt-shaped AND envelope-shaped at once. rmpc refuses this
    # body (`unknown field `receipt``); so does this function, so that the one
    # rule has exactly one behaviour. See the header.
    if jq -e 'has("receipt")' "$body" >/dev/null 2>&1; then
      echo "receipt_unwrap_envelope: $body is AMBIGUOUS — it carries a top-level \`schema_version\` (it is receipt-shaped) and also a \`receipt\` key (it is envelope-shaped). rmpc refuses this body with \`unknown field \\\`receipt\\\`\`; refusing it here too keeps the shell and Rust rules identical" >&2
      return 4
    fi
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
