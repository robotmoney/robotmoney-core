#!/usr/bin/env bash
# install-rmpc-selftest.sh — offline round-trip self-test for the checksum-verified
# rmpc install path.
#
# Canonical: scripts/release/install-rmpc.sh, .github/workflows/release-rmpc.yml
# Issue: #1204.
#
# WHY THIS SELFTEST EXISTS
# Two pieces of #1204's behaviour would otherwise never execute in CI:
#
#  1. release-rmpc.yml only triggers on `push: tags: v*.*.*` and workflow_dispatch,
#     so the step that publishes `<archive>.tar.gz.sha256` never runs on a PR. This
#     selftest re-creates that step's exact commands on a fixture archive and, on
#     top of that, asserts the workflow still contains them — mirroring
#     scripts/devnet/check-fork-state-digest-selftest.sh, which covers a helper
#     snapshot-fork.sh relies on but CI never reaches.
#
#  2. The corrupted-download path. A checksum that is published but never compared
#     is decoration, so the load-bearing assertion here is the negative one: flip a
#     byte in the archive and prove install-rmpc.sh exits non-zero at the VERIFY
#     step, with no binary at the destination — it must abort *before* `install`,
#     not fail somewhere after having already dropped an executable on disk.
#
# No network, no real release, no rmpc build: the fixture "binary" is a shell
# script, and install-rmpc.sh downloads it through curl's `file://` support via
# its --base-url seam, so the production code path is the one under test.
#
# Output contract: one `PASS: ...` / `FAIL: ...` line per assertion plus a final
# RMPC_INSTALL_SELFTEST_EXECUTED=<n>. plugins/robotmoney-swarm/tests/run-tests.sh
# folds these into its own counters; the script is also runnable on its own.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/release/install-rmpc.sh"
RELEASE_WORKFLOW="$REPO_ROOT/.github/workflows/release-rmpc.yml"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# Hard prerequisites. Loud-skip policy: a missing tool fails the selftest, it
# never turns it into a zero-assertion green.
for tool in curl tar sha256sum install grep; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "FATAL: required tool '$tool' is not installed — refusing to skip." >&2
    exit 1
  }
done
[[ -x "$INSTALLER" ]] || { echo "FATAL: $INSTALLER is missing or not executable." >&2; exit 1; }

WORKDIR="$(mktemp -d -t install-rmpc-selftest.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

TAG="v0.0.0-selftest"
PLATFORM="linux-amd64"
ARCHIVE="rmpc-${TAG}-${PLATFORM}.tar.gz"
RELEASES="$WORKDIR/releases/$TAG"
mkdir -p "$RELEASES" "$WORKDIR/stage"

# ---------- build the fixture release exactly as release-rmpc.yml packages one ----------
printf '#!/usr/bin/env bash\necho "rmpc selftest fixture"\n' > "$WORKDIR/stage/rmpc"
chmod +x "$WORKDIR/stage/rmpc"
( cd "$RELEASES" \
  && tar -czf "$ARCHIVE" -C "$WORKDIR/stage" rmpc \
  && sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256" )

echo "--- selftest: the release packaging step produces a usable checksum file ---"
if grep -Eq "^[0-9a-f]{64}  ${ARCHIVE}\$" "$RELEASES/${ARCHIVE}.sha256"; then
  pass "packaging emits '<64-hex>  ${ARCHIVE}' — the format sha256sum -c consumes"
else
  fail "checksum file is not in sha256sum -c format: $(cat "$RELEASES/${ARCHIVE}.sha256")"
fi

# ---------- positive path: intact archive verifies, extracts, installs ----------
echo ""
echo "--- selftest: intact archive verifies and proceeds to install ---"
DEST_OK="$WORKDIR/bin-ok"
OUT_OK=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_OK" \
  --base-url "file://$WORKDIR/releases" 2>&1)
EXIT_OK=$?

if [[ $EXIT_OK -eq 0 ]]; then
  pass "intact archive: installer exited 0"
else
  fail "intact archive: installer exited $EXIT_OK (output: $OUT_OK)"
fi

if grep -q 'STEP verify' <<<"$OUT_OK" && grep -q 'STEP install' <<<"$OUT_OK"; then
  pass "intact archive: verify ran and install was reached"
else
  fail "intact archive: expected both a verify and an install step (output: $OUT_OK)"
fi

if [[ -f "$DEST_OK/rmpc" ]]; then
  pass "intact archive: rmpc landed at the destination"
else
  fail "intact archive: no rmpc at $DEST_OK/rmpc"
fi

MODE=$(stat -c '%a' "$DEST_OK/rmpc" 2>/dev/null || stat -f '%Lp' "$DEST_OK/rmpc" 2>/dev/null || echo "?")
if [[ "$MODE" == "755" ]]; then
  pass "intact archive: installed with mode 755"
else
  fail "intact archive: installed with mode '$MODE', expected 755"
fi

# ---------- negative path: one flipped byte must abort before install ----------
echo ""
echo "--- selftest: corrupted archive aborts at verify, never reaching install ---"
CORRUPT="$WORKDIR/releases-corrupt/$TAG"
mkdir -p "$CORRUPT"
cp "$RELEASES/${ARCHIVE}.sha256" "$CORRUPT/"
cp "$RELEASES/$ARCHIVE" "$CORRUPT/"
# Flip one byte in the middle of the archive — the published .sha256 is left
# untouched, which is exactly the tampered-download shape being defended against.
python3 - "$CORRUPT/$ARCHIVE" <<'PY'
import pathlib
import sys

p = pathlib.Path(sys.argv[1])
data = bytearray(p.read_bytes())
data[len(data) // 2] ^= 0xFF
p.write_bytes(data)
PY

DEST_BAD="$WORKDIR/bin-bad"
OUT_BAD=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_BAD" \
  --base-url "file://$WORKDIR/releases-corrupt" 2>&1)
EXIT_BAD=$?

if [[ $EXIT_BAD -ne 0 ]]; then
  pass "corrupted archive: installer exited non-zero ($EXIT_BAD)"
else
  fail "corrupted archive: installer exited 0 — a tampered download was accepted"
fi

if grep -q 'ChecksumMismatch' <<<"$OUT_BAD"; then
  pass "corrupted archive: failed loudly with ChecksumMismatch"
else
  fail "corrupted archive: output does not name ChecksumMismatch (output: $OUT_BAD)"
fi

if grep -q 'STEP install' <<<"$OUT_BAD"; then
  fail "corrupted archive: the install step was reached despite a bad checksum"
else
  pass "corrupted archive: the install step was never reached"
fi

if [[ -e "$DEST_BAD/rmpc" ]]; then
  fail "corrupted archive: an rmpc binary was left at $DEST_BAD/rmpc"
else
  pass "corrupted archive: no binary was written to the destination"
fi

# ---------- negative path: a SUBSTITUTED archive (valid tarball, wrong bytes) ----------
# The byte-flip above is the literal "corrupted tarball" case, and gzip would catch
# most of it on its own. This is the case only the checksum catches: a perfectly
# well-formed archive whose `rmpc` is not the one that was released. Without the
# verify step this installs cleanly and the operator generates a signing key with
# somebody else's binary.
echo ""
echo "--- selftest: a substituted but well-formed archive is rejected ---"
SWAP="$WORKDIR/releases-swapped/$TAG"
mkdir -p "$SWAP" "$WORKDIR/stage-trojan"
cp "$RELEASES/${ARCHIVE}.sha256" "$SWAP/"
printf '#!/usr/bin/env bash\necho "not the released rmpc"\n' > "$WORKDIR/stage-trojan/rmpc"
chmod +x "$WORKDIR/stage-trojan/rmpc"
( cd "$SWAP" && tar -czf "$ARCHIVE" -C "$WORKDIR/stage-trojan" rmpc )

if tar tzf "$SWAP/$ARCHIVE" >/dev/null 2>&1; then
  pass "substituted archive: the decoy is a valid tarball, so only the checksum can reject it"
else
  fail "substituted archive: fixture is not a valid tarball — the test would prove nothing"
fi

DEST_SWAP="$WORKDIR/bin-swap"
OUT_SWAP=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_SWAP" \
  --base-url "file://$WORKDIR/releases-swapped" 2>&1)
EXIT_SWAP=$?

if [[ $EXIT_SWAP -ne 0 ]] && grep -q 'ChecksumMismatch' <<<"$OUT_SWAP"; then
  pass "substituted archive: rejected with ChecksumMismatch (exit $EXIT_SWAP)"
else
  fail "substituted archive: installer exited $EXIT_SWAP without a ChecksumMismatch (output: $OUT_SWAP)"
fi

if [[ -e "$DEST_SWAP/rmpc" ]]; then
  fail "substituted archive: a foreign rmpc was installed at $DEST_SWAP/rmpc"
else
  pass "substituted archive: no foreign binary reached the destination"
fi

# ---------- negative path: a release with no published checksum fails closed ----------
echo ""
echo "--- selftest: a release publishing no .sha256 fails closed ---"
NOSUM="$WORKDIR/releases-nosum/$TAG"
mkdir -p "$NOSUM"
cp "$RELEASES/$ARCHIVE" "$NOSUM/"

DEST_NOSUM="$WORKDIR/bin-nosum"
OUT_NOSUM=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_NOSUM" \
  --base-url "file://$WORKDIR/releases-nosum" 2>&1)
EXIT_NOSUM=$?

if [[ $EXIT_NOSUM -ne 0 && ! -e "$DEST_NOSUM/rmpc" ]]; then
  pass "missing checksum: installer refused to install (exit $EXIT_NOSUM, nothing written)"
else
  fail "missing checksum: installer exited $EXIT_NOSUM and may have installed (output: $OUT_NOSUM)"
fi

# ---------- the release workflow still publishes what this path consumes ----------
# release-rmpc.yml never runs on a PR, so these two lines are the only thing
# standing between a refactor of that workflow and an install path that silently
# has no checksum to verify against.
echo ""
echo "--- selftest: release-rmpc.yml still publishes the .sha256 assets ---"
# shellcheck disable=SC2016  # matching the workflow's literal text, not expanding it
if grep -q 'sha256sum "${ARCHIVE}" > "${ARCHIVE}.sha256"' "$RELEASE_WORKFLOW"; then
  pass "release-rmpc.yml still generates <archive>.sha256 at packaging time"
else
  fail "release-rmpc.yml no longer generates <archive>.sha256 — the install path has nothing to verify"
fi

if grep -q 'artifacts/\*.tar.gz.sha256' "$RELEASE_WORKFLOW"; then
  pass "release-rmpc.yml still attaches *.tar.gz.sha256 to the GitHub Release"
else
  fail "release-rmpc.yml no longer attaches *.tar.gz.sha256 to the Release"
fi

# ---------- summary ----------
echo ""
TOTAL=$((PASS + FAIL))
echo "=== install-rmpc selftest: $PASS passed, $FAIL failed ==="
echo "RMPC_INSTALL_SELFTEST_EXECUTED=$TOTAL"

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
