#!/usr/bin/env bash
# Upgradeable storage-layout gate (ADR-0014 §8). Folds in the former gateway-only gate (issue 1476).
#
# Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §8;
#            docs/technical/smart-contract-invariants.md (UPG-5, storage layout of proxied contracts).
#
# For every contract listed in contracts/test/fixtures/storage-layout/proxied.txt, compares the live
# layout record from `forge inspect` (storage variables and storage-struct members with type labels
# that keep their defining contract, the inheritance linearization, every linked library with the
# keccak256 of its code, and the OpenZeppelin submodule commits) with the committed snapshot
# contracts/test/fixtures/storage-layout/<Contract>.json, which must equal that record exactly: an
# append is recorded with --write in the change that makes it (security round 3), and a snapshot must
# record every struct and enum its storage reaches. State may only be appended, or take slots
# from a `__gap` that shrinks by exactly those slots; storage structs must not change and storage enums
# may only gain members at the end; the linearization, the libraries and the OpenZeppelin commits must
# not change; GovernedUpgrade must stay in every listed contract's linearization; proxied.txt, the
# sources and the ADR-0014 §1 table must agree. `--base <ref>` holds the committed snapshots to the
# same storage rules against the snapshots at <ref>, so `--write` cannot launder a non-append change.
# The parent alone is not an anchor: a red commit that rewrote a snapshot becomes the next commit's
# parent. `--release-anchor` holds them to the same rules against every annotated production
# release/<version> tag, the layout a release put live. A contract proxied at the anchor must still
# be listed, and one listed there with no snapshot is never treated as new.
# The rules live in scripts/ci/storage_layout_gate.py.
#
# Usage (repo root, after `forge build`):
#   scripts/ci/check-storage-layout.sh                  compare every listed contract
#   scripts/ci/check-storage-layout.sh <Contract>...    compare the named contracts (and coverage)
#   scripts/ci/check-storage-layout.sh --base <ref> [C...]
#                                                       compare the committed snapshots with those at
#                                                       <ref> (CI: the PR base or the previous tip)
#   scripts/ci/check-storage-layout.sh --release-anchor [C...]
#                                                       the same compare against every annotated
#                                                       production release/* tag in the clone
#   scripts/ci/check-storage-layout.sh --write [C...]   rewrite snapshots to the code's layout, in the
#                                                       change that appends to it (review the diff)
#   scripts/ci/check-storage-layout.sh --selftest       prove each rule fires on a mutated record
#
# Exit codes: 0 pass; 1 a rule failed; 2 tooling or input error.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
command -v python3 >/dev/null || { echo "check-storage-layout: python3 is required" >&2; exit 2; }
command -v "${FORGE:-forge}" >/dev/null || { echo "check-storage-layout: forge is required" >&2; exit 2; }
command -v "${CAST:-cast}" >/dev/null || { echo "check-storage-layout: cast is required" >&2; exit 2; }

case "${1:-}" in
  -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
esac

exec python3 "$REPO_ROOT/scripts/ci/storage_layout_gate.py" "$@"
