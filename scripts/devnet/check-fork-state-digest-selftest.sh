#!/usr/bin/env bash
# Offline round-trip self-test for scripts/devnet/fork-state-digest.sh.
#
# Canonical: docs/adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md
# Issue: #1152.
#
# Exercises the write/verify helper end-to-end with a throwaway temp blob and
# manifest — no network, no Docker, no real fork fixture touched. This is the
# offline proxy for the digest helper snapshot-fork.sh relies on to seed
# state_sha256 at capture time: write must produce a digest verify accepts,
# and a one-byte tamper of the blob must make verify reject it (non-zero
# exit), never silently pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/devnet/fork-state-digest.sh"

WORKDIR="$(mktemp -d -t fork-state-digest-selftest.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

BLOB="$WORKDIR/blob.anvil-state"
MANIFEST="$WORKDIR/manifest.json"

printf 'not-real-anvil-state-bytes-%s-%s' "$$" "$RANDOM" > "$BLOB"
echo '{}' > "$MANIFEST"

echo "[selftest] write"
"$HELPER" write "$BLOB" "$MANIFEST"
if ! jq -e '.state_sha256 | type == "string" and length == 64' "$MANIFEST" >/dev/null; then
  echo "ERROR: write did not populate a 64-char state_sha256" >&2
  exit 1
fi

echo "[selftest] verify (expect green)"
"$HELPER" verify "$BLOB" "$MANIFEST"

echo "[selftest] byte-flip then verify (expect red)"
python3 - "$BLOB" <<'PY'
import pathlib
import sys

p = pathlib.Path(sys.argv[1])
data = bytearray(p.read_bytes())
data[0] ^= 0xFF
p.write_bytes(data)
PY

if "$HELPER" verify "$BLOB" "$MANIFEST"; then
  echo "ERROR: verify unexpectedly accepted a tampered blob" >&2
  exit 1
fi

echo "[selftest] OK: fork-state-digest.sh write/verify round-trips correctly"
