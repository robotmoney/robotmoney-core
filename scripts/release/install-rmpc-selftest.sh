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
#  3. The hostile CHECKSUM FILE. Every assertion in (1) and (2) tests a checksum
#     file this repo PRODUCES against an archive an attacker controls. That got
#     the direction backwards for one whole class: `sha256sum -c FILE` verifies
#     whichever filenames FILE lists, so a downloaded `.sha256` holding the digest
#     of the empty file and naming `/dev/null` made any archive verify — proved by
#     running it against this installer. Those assertions live in the
#     "a .sha256 that names a different file is refused" section and are the only
#     ones that feed the installer a hostile *input* rather than a hostile archive.
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
# `shasum` is required, not optional: the macOS-packaging assertions below run
# the release workflow's own packaging step with sha256sum removed from PATH,
# which is exactly what a macos-latest runner looks like. python3 extracts the
# workflow's matrix and step bodies and flips a byte in the corrupt fixture.
for tool in curl tar sha256sum shasum python3 install grep; do
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
  pass "packaging emits '<64-hex>  ${ARCHIVE}' — the single-line, archive-naming shape install-rmpc.sh's coverage check requires"
else
  fail "checksum file is not '<64-hex>  ${ARCHIVE}': $(cat "$RELEASES/${ARCHIVE}.sha256")"
fi

# ---------- positive path: intact archive verifies, extracts, installs ----------
echo ""
echo "--- selftest: intact archive verifies and proceeds to install ---"
DEST_OK="$WORKDIR/bin-ok"
OUT_OK=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_OK" \
  --base-url "file://$WORKDIR/releases" --allow-insecure-base-url 2>&1)
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
  --base-url "file://$WORKDIR/releases-corrupt" --allow-insecure-base-url 2>&1)
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
  --base-url "file://$WORKDIR/releases-swapped" --allow-insecure-base-url 2>&1)
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
  --base-url "file://$WORKDIR/releases-nosum" --allow-insecure-base-url 2>&1)
EXIT_NOSUM=$?

if [[ $EXIT_NOSUM -ne 0 && ! -e "$DEST_NOSUM/rmpc" ]]; then
  pass "missing checksum: installer refused to install (exit $EXIT_NOSUM, nothing written)"
else
  fail "missing checksum: installer exited $EXIT_NOSUM and may have installed (output: $OUT_NOSUM)"
fi

# ---------- negative path: a checksum file that does not COVER this archive ----------
# Every case above hands the installer an archive an attacker controls and a
# checksum file this repo produced (or none at all). This one inverts it: the
# archive is whatever the attacker likes, and the *checksum file* is the lie. `sha256sum -c FILE` and
# `shasum -a 256 -c FILE` verify whichever filenames FILE lists and exit 0 when
# those match — so a one-line `.sha256` holding the digest of some other file,
# naming that other file, made the installer print "verified" over a trojan.
#
# This is the hostile-INPUT case, and it is exactly what the earlier assertions
# missed: they cover the checksum file the packaging step PRODUCES (:74, and the
# macOS round trip below), never a downloaded one that names a different path.
echo ""
echo "--- selftest: a .sha256 that names a different file is refused ---"

# The trojan archive is well-formed and installs cleanly if it is ever reached —
# only the coverage check stands between it and $DEST.
mkdir -p "$WORKDIR/stage-decoy"
printf '#!/usr/bin/env bash\necho "TROJAN rmpc"\n' > "$WORKDIR/stage-decoy/rmpc"
chmod +x "$WORKDIR/stage-decoy/rmpc"

# make_decoy_release <dirname> -> prints the release root
# Builds "$WORKDIR/<dirname>/$TAG/$ARCHIVE" holding the trojan binary. The
# caller then writes whatever .sha256 its case needs beside it.
make_decoy_release() {
  local name="$1"
  local root="$WORKDIR/$name"
  rm -rf "$root"
  mkdir -p "$root/$TAG"
  ( cd "$root/$TAG" && tar -czf "$ARCHIVE" -C "$WORKDIR/stage-decoy" rmpc )
  echo "$root"
}

# --- case A: the well-known digest of the empty file, naming /dev/null ---
DEVNULL_ROOT=$(make_decoy_release "releases-devnull")
printf '%s  /dev/null\n' \
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" \
  > "$DEVNULL_ROOT/$TAG/${ARCHIVE}.sha256"

DEST_DEVNULL="$WORKDIR/bin-devnull"
OUT_DEVNULL=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_DEVNULL" \
  --base-url "file://$DEVNULL_ROOT" --allow-insecure-base-url 2>&1)
EXIT_DEVNULL=$?

if [[ $EXIT_DEVNULL -eq 4 ]]; then
  pass "uncovered checksum: a .sha256 naming /dev/null is refused with exit 4"
else
  fail "uncovered checksum: installer exited $EXIT_DEVNULL on a .sha256 naming /dev/null, expected 4 (output: $OUT_DEVNULL)"
fi

if [[ -e "$DEST_DEVNULL/rmpc" ]]; then
  fail "uncovered checksum: a trojan rmpc was installed at $DEST_DEVNULL/rmpc using a checksum for /dev/null"
else
  pass "uncovered checksum: no binary reached the destination"
fi

# The refusal has to happen BEFORE the script vouches for the bytes. Printing
# "verified" and then failing later would still put that word in an operator's
# scrollback next to a trojan.
if grep -q 'verified' <<<"$OUT_DEVNULL"; then
  fail "uncovered checksum: the installer printed 'verified' for an archive its .sha256 does not name (output: $OUT_DEVNULL)"
else
  pass "uncovered checksum: the word 'verified' was never printed"
fi

# --- case B: multi-line — the real line plus a decoy line ---
# Non-vacuous on purpose: line 1 is the CORRECT digest for the archive, so this
# can only be rejected for its shape, never for a mismatch.
MULTI_ROOT=$(make_decoy_release "releases-multiline")
( cd "$MULTI_ROOT/$TAG" && sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256" )
printf '%s  /dev/null\n' \
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" \
  >> "$MULTI_ROOT/$TAG/${ARCHIVE}.sha256"

DEST_MULTI="$WORKDIR/bin-multiline"
OUT_MULTI=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_MULTI" \
  --base-url "file://$MULTI_ROOT" --allow-insecure-base-url 2>&1)
EXIT_MULTI=$?

if [[ $EXIT_MULTI -eq 4 && ! -e "$DEST_MULTI/rmpc" ]]; then
  pass "multi-line checksum: a two-line .sha256 is refused with exit 4 and nothing installed"
else
  fail "multi-line checksum: installer exited $EXIT_MULTI and may have installed (output: $OUT_MULTI)"
fi

# --- case C: a correct checksum for a different REAL file ---
# /dev/null is a special case (its digest is famous and it is always readable).
# This proves the guard is about COVERAGE, not about that one path: the decoy is
# an ordinary file with ordinary content, and its digest in the .sha256 is
# genuinely correct — `sha256sum -c` would happily report OK.
printf 'not the rmpc release archive\n' > "$WORKDIR/decoy-real.bin"
DECOY_SHA=$(sha256sum "$WORKDIR/decoy-real.bin" | cut -d' ' -f1)
OTHER_ROOT=$(make_decoy_release "releases-otherfile")
printf '%s  %s\n' "$DECOY_SHA" "$WORKDIR/decoy-real.bin" \
  > "$OTHER_ROOT/$TAG/${ARCHIVE}.sha256"

DEST_OTHER="$WORKDIR/bin-otherfile"
OUT_OTHER=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_OTHER" \
  --base-url "file://$OTHER_ROOT" --allow-insecure-base-url 2>&1)
EXIT_OTHER=$?

if [[ $EXIT_OTHER -eq 4 ]]; then
  pass "uncovered checksum: a valid checksum for a different real file is refused with exit 4"
else
  fail "uncovered checksum: installer exited $EXIT_OTHER on a checksum covering $WORKDIR/decoy-real.bin, expected 4 (output: $OUT_OTHER)"
fi

if [[ -e "$DEST_OTHER/rmpc" ]]; then
  fail "uncovered checksum: a trojan rmpc was installed at $DEST_OTHER/rmpc using a checksum for another real file"
else
  pass "uncovered checksum: no binary reached the destination for the other-real-file case"
fi

# ---------- the release workflow still publishes what this path consumes ----------
# release-rmpc.yml never runs on a PR, so this file is the only thing standing
# between a refactor of that workflow and an install path that silently has no
# checksum to verify against.
#
# WHY THESE ARE EXECUTED, NOT GREPPED
# This section used to be a grep for the literal text of the packaging line. That
# grep passed on a line that could not run: the matrix packages on macos-latest
# for two of its four targets, macOS ships no `sha256sum`, and the step would
# have exited 127 — taking `publish` (which `needs: build`) with it, so a tag
# would have published nothing at all. **The grep proved presence, never
# executability.** So instead of matching text, the assertions below extract the
# workflow's own step bodies and RUN them: the packaging step against a runner
# with `sha256sum` removed from PATH (which is what a macOS runner is), and the
# pairing guard against fixture artifact directories. A step that cannot run on a
# runner its own matrix names is now red here, on every PR.
echo ""
echo "--- selftest: release-rmpc.yml's own steps, extracted and executed ---"

WF_DIR="$WORKDIR/workflow"
mkdir -p "$WF_DIR"

# Extract, from the workflow itself: every runner the build matrix names, the
# `Package tar.gz` step body, and the pairing-guard step body. The `${{ }}`
# expressions are substituted with fixture values so the bodies are runnable; an
# expression this extractor does not know about is reported as an error rather
# than quietly dropped, because a silently-mangled body would prove nothing.
python3 - "$RELEASE_WORKFLOW" "$WF_DIR" <<'PY'
import pathlib
import re
import sys

lines = pathlib.Path(sys.argv[1]).read_text().splitlines()
out = pathlib.Path(sys.argv[2])
meta = []
errors = []

SUBS = {
    "needs.resolve.outputs.version": "v0.0.0-selftest",
    "matrix.os_label": "macos-arm64",
    "matrix.target": "aarch64-apple-darwin",
}


def indent(line):
    return len(line) - len(line.lstrip())


def substitute(text, where):
    def repl(m):
        key = m.group(1).strip()
        if key not in SUBS:
            errors.append("unsubstituted expression '%s' in step '%s'" % (key, where))
            return "UNSUBSTITUTED"
        return SUBS[key]

    return re.sub(r"\$\{\{([^}]*)\}\}", repl, text)


def step_run_block(step_name):
    for i, line in enumerate(lines):
        if re.match(r"\s*-\s+name:\s+" + re.escape(step_name) + r"\s*$", line):
            base = indent(line)
            body = []
            j = i + 1
            while j < len(lines):
                cur = lines[j]
                if cur.strip() and indent(cur) <= base:
                    break
                body.append(cur)
                j += 1
            for k, cur in enumerate(body):
                if re.match(r"\s*run:\s*\|\s*$", cur):
                    run_indent = indent(cur)
                    block = []
                    for nxt in body[k + 1:]:
                        if nxt.strip() and indent(nxt) <= run_indent:
                            break
                        block.append(nxt)
                    while block and not block[-1].strip():
                        block.pop()
                    pad = min(indent(b) for b in block if b.strip())
                    return "\n".join(b[pad:] if b.strip() else "" for b in block) + "\n"
            errors.append("step '%s' has no 'run: |' block" % step_name)
            return None
    errors.append("step '%s' not found in the workflow" % step_name)
    return None


# Every runner the build matrix names, plus any literal runs-on in the file.
runners = []
for line in lines:
    m = re.match(r"\s*-?\s*runner:\s*(\S+)\s*$", line)
    if m:
        runners.append(m.group(1))
    m = re.match(r"\s*runs-on:\s*([A-Za-z][\w.-]*)\s*$", line)
    if m:
        runners.append(m.group(1))
(out / "runners.txt").write_text("\n".join(runners) + "\n")


def matrix_include_entries():
    """Count jobs.build.strategy.matrix.include entries structurally.

    Counting `runner:` lines instead would miscount an entry that inherits its
    runner, or over-count a stray `runner:` key elsewhere in the file — the
    number would then disagree with the real archive count while the equality
    assertion still passed. This walks the actual nesting, and reports an error
    (turning the parse assertion red) rather than guessing.
    """
    base = -1
    i = 0
    for key in ("jobs:", "build:", "strategy:", "matrix:", "include:"):
        found = False
        while i < len(lines):
            line = lines[i]
            if not line.strip() or line.lstrip().startswith("#"):
                i += 1
                continue
            if base >= 0 and indent(line) <= base:
                break
            if line.strip() == key:
                base = indent(line)
                i += 1
                found = True
                break
            i += 1
        if not found:
            errors.append("could not locate '%s' on the path to the build matrix" % key)
            return 0

    count = 0
    item_indent = None
    while i < len(lines):
        line = lines[i]
        if line.strip() and not line.lstrip().startswith("#"):
            if indent(line) <= base:
                break
            if line.lstrip().startswith("- "):
                if item_indent is None:
                    item_indent = indent(line)
                if indent(line) == item_indent:
                    count += 1
        i += 1
    if count == 0:
        errors.append("the build matrix's include: list is empty")
    return count


meta.append("matrix_entries=%d" % matrix_include_entries())

for step_name, filename in (
    ("Package tar.gz", "package.sh"),
    ("Assert every archive ships its checksum", "pairing.sh"),
):
    block = step_run_block(step_name)
    if block is not None:
        (out / filename).write_text(substitute(block, step_name))

(out / "meta.txt").write_text("\n".join(meta) + "\n")
(out / "errors.txt").write_text("\n".join(errors) + "\n" if errors else "")
PY

WF_ERRORS="$(cat "$WF_DIR/errors.txt" 2>/dev/null || echo "extractor did not run")"
MATRIX_ENTRIES=$(sed -n 's/^matrix_entries=//p' "$WF_DIR/meta.txt" 2>/dev/null || echo 0)
MACOS_RUNNERS=$(grep -c '^macos' "$WF_DIR/runners.txt" 2>/dev/null || true)
MACOS_RUNNERS=${MACOS_RUNNERS:-0}

if [[ -z "$WF_ERRORS" ]]; then
  pass "release-rmpc.yml parsed: ${MATRIX_ENTRIES} build-matrix entries, steps extracted for execution"
else
  fail "release-rmpc.yml could not be parsed into runnable steps: $WF_ERRORS"
fi

# Non-vacuity guard. Every macOS assertion below is worthless if the matrix has
# no macOS entry, so the count is asserted rather than assumed.
if [[ "$MACOS_RUNNERS" -ge 1 ]]; then
  pass "release-rmpc.yml builds on $MACOS_RUNNERS macOS runner(s) — the no-sha256sum packaging check is not vacuous"
else
  fail "release-rmpc.yml names no macOS runner — either the matrix shrank or the extractor stopped seeing it"
fi

# The macOS simulation: PATH holds only the tools a runner would provide, and
# sha256sum is not among them. `command -v sha256sum` fails here exactly as it
# does on macos-latest.
NOSHA_BIN="$WORKDIR/nosha-bin"
mkdir -p "$NOSHA_BIN"
for tool in tar gzip shasum cut sed cat rm mkdir ls; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  [[ -n "$tool_path" ]] && ln -sf "$tool_path" "$NOSHA_BIN/$tool"
done

MAC_TARGET="aarch64-apple-darwin"
MAC_ARCHIVE="rmpc-${TAG}-macos-arm64.tar.gz"
PKG_DIR="$WORKDIR/pkg-macos"
mkdir -p "$PKG_DIR/target/$MAC_TARGET/release"
cp "$WORKDIR/stage/rmpc" "$PKG_DIR/target/$MAC_TARGET/release/rmpc"
: > "$PKG_DIR/github_env"

# Only ever execute a body the extractor reported as clean. `errors.txt` is
# non-empty when an expression was left unsubstituted, which means the file on
# disk is a MANGLED rendering of a PR-editable YAML step — running it would
# prove nothing and is the one case where this section generates shell it does
# not understand. The extraction assertion above has already gone red by then.
if [[ -f "$WF_DIR/package.sh" && -z "$WF_ERRORS" ]]; then
  set +e
  PKG_OUT=$(cd "$PKG_DIR" && env -i \
    PATH="$NOSHA_BIN" HOME="$PKG_DIR" GITHUB_ENV="$PKG_DIR/github_env" \
    "$(command -v bash)" --noprofile --norc -e -o pipefail "$WF_DIR/package.sh" 2>&1)
  PKG_EXIT=$?
  set -e
else
  PKG_OUT="the Package tar.gz step could not be extracted cleanly: ${WF_ERRORS:-step not found}"
  PKG_EXIT=127
fi

if [[ $PKG_EXIT -eq 0 ]]; then
  pass "packaging step runs to completion with no sha256sum on PATH (the macOS runner case)"
else
  fail "packaging step exited $PKG_EXIT with no sha256sum on PATH — it cannot run on the macOS half of its own matrix, so a tag would publish nothing (output: $PKG_OUT)"
fi

if grep -Eq "^[0-9a-f]{64}  ${MAC_ARCHIVE}\$" "$PKG_DIR/${MAC_ARCHIVE}.sha256" 2>/dev/null; then
  pass "macOS-packaged checksum is '<64-hex>  ${MAC_ARCHIVE}' — the single-line, archive-naming shape install-rmpc.sh's coverage check requires"
else
  fail "macOS-packaged checksum file is missing or malformed: $(cat "$PKG_DIR/${MAC_ARCHIVE}.sha256" 2>/dev/null || echo '<no file>')"
fi

# The round trip that matters: what the macOS runner would publish is what the
# installer would verify. Packaging and verification are written on two different
# platforms' tools, so proving the format matches by inspection is not enough.
MAC_REL="$WORKDIR/releases-macos/$TAG"
mkdir -p "$MAC_REL"
cp "$PKG_DIR/$MAC_ARCHIVE" "$MAC_REL/" 2>/dev/null || true
cp "$PKG_DIR/${MAC_ARCHIVE}.sha256" "$MAC_REL/" 2>/dev/null || true

DEST_MAC="$WORKDIR/bin-macos"
set +e
OUT_MAC=$("$INSTALLER" --tag "$TAG" --platform "macos-arm64" --dest "$DEST_MAC" \
  --base-url "file://$WORKDIR/releases-macos" --allow-insecure-base-url 2>&1)
EXIT_MAC=$?
set -e

if [[ $EXIT_MAC -eq 0 && -f "$DEST_MAC/rmpc" ]]; then
  pass "round trip: an archive packaged the macOS way verifies and installs through install-rmpc.sh"
else
  fail "round trip: installer exited $EXIT_MAC on a macOS-packaged archive (output: $OUT_MAC)"
fi

# ---------- the release must refuse to publish an archive with no checksum ----------
# `if-no-files-found: error` fires only when the COMBINED glob set is empty and
# `fail_on_unmatched_files` only when a PATTERN matches nothing, so neither one
# enforces archive-to-checksum pairing: three archives can ship unverifiable as
# long as one checksum survives. The guard step does enforce it, and here it is
# executed against both shapes rather than grepped for.
echo ""
echo "--- selftest: the publish job refuses an archive that has no .sha256 ---"

make_artifacts() {
  local dir="$1" count="$2" drop_checksum="$3" i
  rm -rf "$dir"
  mkdir -p "$dir"
  for ((i = 1; i <= count; i++)); do
    printf 'archive %d\n' "$i" > "$dir/rmpc-fixture-$i.tar.gz"
    printf '%064d  rmpc-fixture-%d.tar.gz\n' 0 "$i" > "$dir/rmpc-fixture-$i.tar.gz.sha256"
  done
  [[ "$drop_checksum" == "drop" ]] && rm -f "$dir/rmpc-fixture-1.tar.gz.sha256"
  return 0
}

# run_pairing_guard — execute the extracted publish-step body against a fixture
# artifact tree.
#
# WHY THIS IS SANDBOXED
# This is code generation from a PR-editable YAML file into a shell, exactly like
# the packaging step above, so it gets the same containment: `env -i` with a
# PATH holding only the fixture tool symlinks and HOME pointed at the fixture
# root. Without it, a maintainer running run-tests.sh locally executes whatever
# release-rmpc.yml's publish step currently says against their real $HOME.
# 126 is reserved for "refused to run", so it can never be mistaken for the
# guard's own non-zero rejection of an unpaired artifact set.
run_pairing_guard() {
  local root="$1"
  if [[ ! -f "$WF_DIR/pairing.sh" || -n "$WF_ERRORS" ]]; then
    return 126
  fi
  (cd "$root" && env -i \
    PATH="$NOSHA_BIN" HOME="$root" \
    "$(command -v bash)" --noprofile --norc -e -o pipefail "$WF_DIR/pairing.sh" >/dev/null 2>&1)
}

PAIR_OK_ROOT="$WORKDIR/pair-ok"
mkdir -p "$PAIR_OK_ROOT"
make_artifacts "$PAIR_OK_ROOT/artifacts" "${MATRIX_ENTRIES:-4}" keep
set +e
run_pairing_guard "$PAIR_OK_ROOT"
PAIR_OK_EXIT=$?
set -e

if [[ $PAIR_OK_EXIT -eq 0 ]]; then
  pass "pairing guard: a complete set of ${MATRIX_ENTRIES} archives + checksums passes"
elif [[ $PAIR_OK_EXIT -eq 126 ]]; then
  fail "pairing guard: refused to run the extracted step (${WF_ERRORS:-no pairing step extracted}) — the paired case did not execute"
else
  fail "pairing guard: exited $PAIR_OK_EXIT on a complete, correctly paired artifact set"
fi

PAIR_BAD_ROOT="$WORKDIR/pair-bad"
mkdir -p "$PAIR_BAD_ROOT"
make_artifacts "$PAIR_BAD_ROOT/artifacts" "${MATRIX_ENTRIES:-4}" drop
set +e
run_pairing_guard "$PAIR_BAD_ROOT"
PAIR_BAD_EXIT=$?
set -e

# A missing guard step would also "exit non-zero" here, which would be a pass for
# the wrong reason — the exact shape this whole section exists to stop. So the
# step has to be present for this assertion to be satisfiable at all.
if [[ ! -f "$WF_DIR/pairing.sh" ]]; then
  fail "pairing guard: release-rmpc.yml has no pairing-guard step, so nothing stops an archive shipping without its .sha256"
elif [[ $PAIR_BAD_EXIT -eq 126 ]]; then
  fail "pairing guard: refused to run the extracted step ($WF_ERRORS) — the unpaired case did not execute"
elif [[ $PAIR_BAD_EXIT -ne 0 ]]; then
  pass "pairing guard: an archive with no .sha256 fails the publish job (exit $PAIR_BAD_EXIT)"
else
  fail "pairing guard: exited 0 with an unverifiable archive present — the release would ship it"
fi

# The guard's expected-archive count is a constant in the workflow; it is only
# correct while it equals the build matrix's length. Assert they move together.
PAIR_EXPECTED=$(sed -n 's/^EXPECTED_ARCHIVES=\([0-9]\+\)$/\1/p' "$WF_DIR/pairing.sh" 2>/dev/null | head -1)
if [[ -n "$PAIR_EXPECTED" && "$PAIR_EXPECTED" == "$MATRIX_ENTRIES" ]]; then
  pass "pairing guard expects $PAIR_EXPECTED archives, matching the $MATRIX_ENTRIES build-matrix entries"
else
  fail "pairing guard expects '${PAIR_EXPECTED:-<none>}' archives but the build matrix has $MATRIX_ENTRIES entries — add a target and the count guard stops matching"
fi

# ---------- an insecure base URL must not be able to print "verified" ----------
echo ""
echo "--- selftest: a non-https --base-url is refused without the explicit opt-out ---"
set +e
OUT_HTTP=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$WORKDIR/bin-http" \
  --base-url "http://mirror.invalid/releases" 2>&1)
EXIT_HTTP=$?
set -e

if [[ $EXIT_HTTP -eq 2 && ! -e "$WORKDIR/bin-http/rmpc" ]]; then
  pass "insecure base URL: http:// is refused with exit 2 before anything is downloaded"
else
  fail "insecure base URL: installer exited $EXIT_HTTP on a plaintext --base-url (output: $OUT_HTTP)"
fi

echo ""
echo "--- selftest: release-rmpc.yml still attaches the .sha256 assets ---"
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
