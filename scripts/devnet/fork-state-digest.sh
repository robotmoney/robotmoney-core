#!/usr/bin/env bash
# sha256 integrity binding for fork-state golden fixtures (ADR-0011 addendum).
#
# Canonical: docs/adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md
# Issue: #1152.
#
# The checked-in `.anvil-state` blobs under testing/fixtures/fork-state/ are
# large, single-line, unreviewable-by-eyeball binaries that are the sole state
# source for every merge-gating fork suite. This helper binds each blob to a
# `state_sha256` field in its manifest so a hand-edited blob (malicious PR or
# misbehaving automation) is a loud CI failure, never a silent pass, while a
# legitimate regeneration shows up in review as an intentional manifest+digest
# diff (the reviewable proxy for the unreviewable blob).
#
# Two subcommands operate on a (<state_file>, <manifest_json>) pair:
#
#   write  <state_file> <manifest_json>
#     Computes sha256 of the raw state_file bytes and writes/overwrites the
#     manifest's `state_sha256` field in place (all other fields preserved).
#     Used by snapshot-fork.sh at capture time, and reusable directly by an
#     offline round-trip self-test.
#
#   verify <state_file> <manifest_json>
#     Recomputes sha256 of the raw state_file bytes and compares it to the
#     manifest's `state_sha256` field. Exits non-zero — never warns and
#     continues — if the field is missing or the digest does not match, per
#     ADR-0011 loud-fail semantics. Used by check-fork-manifest.sh
#     (suite-01-02, inherited via run-golden-forge-forks.sh) and directly by
#     the suite-05 anvil-goldens/anvil-governance matrix groups, which load
#     CURRENT.anvil-state via ForkFixture and so bypass check-fork-manifest.sh.
#
# Usage:
#   scripts/devnet/fork-state-digest.sh write  <state_file> <manifest_json>
#   scripts/devnet/fork-state-digest.sh verify <state_file> <manifest_json>
set -euo pipefail

usage() {
  echo "usage: $0 {write|verify} <state_file> <manifest_json>" >&2
  exit 64
}

[ $# -eq 3 ] || usage
CMD="$1"
STATE_FILE="$2"
MANIFEST="$3"

[ -f "$STATE_FILE" ] || { echo "ERROR: state file not found: $STATE_FILE" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "ERROR: manifest not found: $MANIFEST" >&2; exit 1; }

DIGEST="$(sha256sum "$STATE_FILE" | awk '{print $1}')"

case "$CMD" in
  write)
    TMP="$(mktemp -t fork-state-digest.XXXXXX.json)"
    jq --arg d "$DIGEST" '.state_sha256 = $d' "$MANIFEST" > "$TMP"
    mv "$TMP" "$MANIFEST"
    echo "[fork-state-digest] wrote state_sha256=$DIGEST to $MANIFEST"
    ;;
  verify)
    RECORDED="$(jq -r '.state_sha256 // empty' "$MANIFEST")"
    if [ -z "$RECORDED" ]; then
      echo "ERROR: $MANIFEST has no state_sha256 field (missing digest, ADR-0011)" >&2
      exit 1
    fi
    if [ "$RECORDED" != "$DIGEST" ]; then
      echo "ERROR: state_sha256 mismatch for $STATE_FILE (ADR-0011 tamper gate)" >&2
      echo "  manifest ($MANIFEST): $RECORDED" >&2
      echo "  computed:              $DIGEST" >&2
      exit 1
    fi
    echo "[fork-state-digest] OK: $STATE_FILE matches state_sha256 in $MANIFEST"
    ;;
  *)
    usage
    ;;
esac
