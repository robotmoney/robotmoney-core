#!/usr/bin/env bash
# install-rmpc-selftest.sh — offline round-trip self-test for the checksum-verified
# rmpc install path.
#
# Canonical: scripts/release/install-rmpc.sh, .github/workflows/release-rmpc.yml
# Issue: #1204; #1242 (the extracted steps must not be able to reconfigure the
# sandbox that runs them — see "disarm the sandbox judging it" below); #1236 (the
# checksum shares a trust root with the archive, so the install path also has to
# verify build provenance — see "build provenance" below).
#
# WHY THIS SELFTEST EXISTS
# Two pieces of #1204's behaviour would otherwise never execute in CI:
#
#  1. release-rmpc.yml only triggers on `push: tags: rmpc-v*.*.*` and workflow_dispatch,
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
#  4. The BUILD PROVENANCE gate (#1236). Everything in (1)-(3) tests a control
#     whose trust root is the release itself, so none of it can stop an attacker
#     who can write that release. `gh attestation verify` is the control that can,
#     and nothing about it — that it is called at all, that the signer identity is
#     pinned, that a bad verdict is fatal before extraction, that a missing
#     verifier is a refusal rather than a downgrade — had any coverage. The
#     signature itself cannot be checked offline; the GATING can, and is.
#
# No network, no real release, no rmpc build: the fixture "binary" is a shell
# script, and install-rmpc.sh downloads it through curl's `file://` support via
# its --base-url seam, so the production code path is the one under test.
#
# Output contract: one `PASS: ...` / `FAIL: ...` line per assertion plus a final
# RMPC_INSTALL_SELFTEST_EXECUTED=<n>. plugins/robotmoney-swarm/tests/run-tests.sh
# folds these into its own counters; the script is also runnable on its own.

# ERREXIT IS DELIBERATELY OFF, ONCE, FOR THE WHOLE FILE.
# Every case here runs a command that is EXPECTED to fail (a tampered archive, a
# refused base URL, an unpaired artifact set) and asserts on its exit status, so
# `$?` is captured explicitly at each site and there is nothing for errexit to
# add. There used to be `set +e`/`set -e` pairs around those captures; since
# errexit was never on, they did not restore it — they switched it ON from the
# first pair to the end of the file, and an unguarded assignment there killed the
# run before it could print its `RMPC_INSTALL_SELFTEST_EXECUTED=<n>` contract
# line. Truncating silently is the one failure this script must not have, so the
# pairs are gone: do not reintroduce `set -e` here, and do not add one locally.
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

# ---------- the `gh` stub: the offline seam for the provenance check (#1236) ----------
# install-rmpc.sh now refuses any archive without a Sigstore build-provenance
# attestation it can verify with `gh attestation verify`. That call is a network
# lookup against GitHub's attestation store and a Sigstore trust root, and this
# selftest is offline by construction (file:// fixtures, no release, no build) —
# so a real verification cannot happen here and MUST NOT be faked into a green.
#
# WHAT IS AND IS NOT PROVEN BELOW
# The cryptography is gh's and is not under test. What IS under test, and what
# had no coverage at all before #1236, is the installer's GATING: that it calls
# the verifier at all, that it pins the identity when it does, that a non-zero
# verdict is fatal before extraction, and that a missing `gh` is a refusal rather
# than a silent downgrade. Those are exactly the properties a future edit can
# delete without any other test noticing.
#
# So the stub shadows the real `gh` on PATH, records the argv it was called with
# so the pinning can be asserted, and takes its exit status from GH_STUB_EXIT.
# It is placed on PATH for the WHOLE file on purpose: every positive-path
# assertion above and below now runs through the attest step, so deleting that
# step does not quietly leave them green — it empties the argv log and reds the
# invocation assertions.
GH_STUB_BIN="$WORKDIR/gh-stub-bin"
GH_ARGV_LOG="$WORKDIR/gh-argv.log"
mkdir -p "$GH_STUB_BIN"
: > "$GH_ARGV_LOG"
cat > "$GH_STUB_BIN/gh" <<'GH_STUB'
#!/usr/bin/env bash
# Records its argv and exits with GH_STUB_EXIT (default 0). Never touches the
# network. `${GH_ARGV_LOG:-/dev/null}` so an invocation that somehow loses the
# variable degrades to a silent success rather than an unexplained failure in
# code that is not what the surrounding assertion is about.
printf '%s\n' "$*" >> "${GH_ARGV_LOG:-/dev/null}"
exit "${GH_STUB_EXIT:-0}"
GH_STUB
chmod +x "$GH_STUB_BIN/gh"
export GH_ARGV_LOG
export PATH="$GH_STUB_BIN:$PATH"

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
# The extractor is written to a file rather than run from a heredoc because the
# hostile-workflow fixtures at the end of this section run the SAME code against
# deliberately doctored copies of release-rmpc.yml. A fixture that exercised a
# second, parallel copy of the parser would prove nothing about this one.
EXTRACTOR_PY="$WORKDIR/extract-workflow.py"
cat > "$EXTRACTOR_PY" <<'PY'
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

# Names this selftest's sandbox owns, plus the ones bash consults BEFORE it runs
# a single line of the extracted body. Issue #1242: these used to be spliced
# straight through from release-rmpc.yml into the `env -i` that contains the
# extracted step, which let the file under test rewrite the containment the
# assertions depend on. `PATH:` put sha256sum back inside the "macOS runner"
# simulation, so the packaging step's macOS dispatch could be deleted outright
# with every assertion still green; `BASH_ENV:` makes bash source a file that is
# not the step body at all, and `--noprofile --norc` do NOT suppress it. There is
# no value of these names that a workflow can safely supply to its own test
# harness, so they are refused at extraction time: an extractor error blocks
# execution and turns the parse assertion red, which is exactly what should
# happen to a step trying to configure the sandbox that judges it.
REFUSED_ENV_NAMES = {
    "BASHOPTS",
    "BASH_ENV",
    "ENV",
    "GITHUB_ENV",
    "HOME",
    "IFS",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PATH",
    "SHELLOPTS",
}

# What the sandbox hands every extracted body. A body may read these without
# declaring them; anything else it reads has to come from its own `env:` block.
SANDBOX_PROVIDED = {"GITHUB_ENV", "HOME", "PATH"}

# `$NAME` / `${NAME}` reads, and the two shapes that bind a name inside the body
# itself. `${#arr[@]}` and `$(cmd)` deliberately do not match: neither is a read
# of an environment name.
NAME_REF = re.compile(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)")
NAME_ASSIGNED = re.compile(r"^\s*(?:export\s+|local\s+|declare\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
NAME_FOR_LOOP = re.compile(r"^\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b")


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


def step_env_block(body, step_name):
    """Parse the step's own `env:` mapping into {name: substituted value}.

    A step-level `env:` is how a hardened workflow keeps a `${{ }}` expression
    out of the shell text it would otherwise be interpolated into — exactly the
    change review-security asked for on the packaging step. An extractor that
    reads only `run: |` renders such a step as a body full of UNBOUND names,
    records NO error (there is no `${{ }}` left in the body to fail on), and
    then reports whatever the unbound names happen to break as a defect in the
    workflow. So the mapping is parsed here, its values go through the same
    substitute() as the body, and an entry this extractor cannot read is an
    extractor error rather than a silent omission.
    """
    env = {}
    k = 0
    while k < len(body):
        cur = body[k]
        if re.match(r"\s*env:\s*$", cur):
            env_indent = indent(cur)
            k += 1
            while k < len(body):
                nxt = body[k]
                if not nxt.strip() or nxt.lstrip().startswith("#"):
                    k += 1
                    continue
                if indent(nxt) <= env_indent:
                    break
                m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*):\s*(\S.*?)\s*$", nxt)
                if not m:
                    errors.append(
                        "step '%s' has an env: entry this extractor cannot read: %s"
                        % (step_name, nxt.strip())
                    )
                    return env
                name = m.group(1)
                if name in REFUSED_ENV_NAMES:
                    errors.append(
                        "step '%s' declares env: %s — this selftest's sandbox owns "
                        "that name, or bash reads it before the step body runs, so "
                        "the workflow would be configuring the harness that tests "
                        "it (issue #1242). Refusing to splice it."
                        % (step_name, name)
                    )
                    k += 1
                    continue
                value = m.group(2)
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                env[name] = substitute(value, "env: of step '%s'" % step_name)
                k += 1
            return env
        k += 1
    return env


def check_bound_names(text, step_env, step_name):
    """Refuse a body that reads a name nothing in reach of the sandbox sets.

    This extractor reads STEP-level `env:` only. Move a variable up to the job's
    or the workflow's `env:` block and it vanishes from the rendering: the body
    still reads `${NAME}`, there is no `${{ }}` left for substitute() to fail on,
    and the bodies run without `set -u` — so the name expands to the empty string
    and the step "succeeds" having packaged nothing under a name like
    `rmpc--macos-arm64.tar.gz`. A silently vacuous body is the exact shape this
    whole section exists to stop, so an unbound read is an extractor error.
    """
    bound = set()
    for line in text.splitlines():
        m = NAME_ASSIGNED.match(line)
        if m:
            bound.add(m.group(1))
        m = NAME_FOR_LOOP.match(line)
        if m:
            bound.add(m.group(1))
    for name in sorted(set(NAME_REF.findall(text))):
        if name in bound or name in step_env or name in SANDBOX_PROVIDED:
            continue
        errors.append(
            "step '%s' reads ${%s}, which its own env: block does not declare and "
            "the sandbox does not supply — this extractor reads step-level env: "
            "only, so a job- or workflow-level declaration renders here as an "
            "empty string instead of a failure (issue #1242)"
            % (step_name, name)
        )


def step_run_block(step_name):
    """Return (runnable body, step env mapping) for a named step, or (None, {})."""
    pattern = re.compile(r"\s*-\s+name:\s+" + re.escape(step_name) + r"\s*$")
    matches = [i for i, line in enumerate(lines) if pattern.match(line)]
    if not matches:
        errors.append("step '%s' not found in the workflow" % step_name)
        return None, {}
    if len(matches) > 1:
        # This used to bind to the first match anywhere in the file. A decoy step
        # of the same name in an earlier job was therefore extracted and executed
        # while the real one stayed broken — every assertion green over a step
        # that never ran (issue #1242). Ambiguity is refused, never guessed.
        errors.append(
            "step name '%s' matches %d steps (lines %s) — this extractor cannot "
            "tell which one the release actually runs, and binding to the first "
            "would let a decoy step be tested in place of the real one"
            % (step_name, len(matches), ", ".join(str(n + 1) for n in matches))
        )
        return None, {}

    i = matches[0]
    base = indent(lines[i])
    body = []
    j = i + 1
    while j < len(lines):
        cur = lines[j]
        if cur.strip() and indent(cur) <= base:
            break
        body.append(cur)
        j += 1
    step_env = step_env_block(body, step_name)
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
            text = "\n".join(b[pad:] if b.strip() else "" for b in block) + "\n"
            return text, step_env
    errors.append("step '%s' has no 'run: |' block" % step_name)
    return None, step_env


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


def job_body(job_name):
    """Return the lines of jobs.<job_name>, refusing an ambiguous match."""
    starts = [
        i for i, line in enumerate(lines)
        if re.match(r"^  " + re.escape(job_name) + r":\s*$", line)
    ]
    if len(starts) != 1:
        errors.append(
            "expected exactly one 'jobs.%s' block, found %d" % (job_name, len(starts))
        )
        return []
    body = []
    for line in lines[starts[0] + 1:]:
        if line.strip() and indent(line) <= 2:
            break
        body.append(line)
    return body


def build_job_facts():
    """Read the two workflow-side halves of #1236's control out of jobs.build.

    Everything else this extractor produces is a `run:` body that gets EXECUTED,
    because a grep proves presence and not executability (see the section header
    below). These two cannot be: `permissions:` is consumed by GitHub's token
    minter and `uses: actions/attest-build-provenance` by the Actions runner —
    neither has a shell body to run, and neither can mint a real Sigstore
    attestation offline. So they are read STRUCTURALLY out of the parsed job
    block instead of matched anywhere in the file: a `permissions:` map belonging
    to some other job, or an attest step sitting in a job that was never granted
    `id-token: write`, does not satisfy them. That is the strongest honest
    assertion available offline, and it is labelled as presence where it is used.
    """
    body = job_body("build")
    perms = []
    attest_subject = ""
    for i, line in enumerate(body):
        if re.match(r"^    permissions:\s*$", line):
            for nxt in body[i + 1:]:
                if not nxt.strip() or nxt.lstrip().startswith("#"):
                    continue
                if indent(nxt) <= 4:
                    break
                m = re.match(r"\s*([A-Za-z-]+):\s*(\S+)\s*$", nxt)
                if m:
                    perms.append("%s:%s" % (m.group(1), m.group(2)))
        m = re.match(r"\s*-?\s*uses:\s*(actions/attest-build-provenance\S*)\s*$", line)
        if m:
            for nxt in body[i + 1:]:
                if nxt.strip() and (
                    indent(nxt) < indent(line) or nxt.lstrip().startswith("- ")
                ):
                    break
                sub = re.match(r"\s*subject-path:\s*(\S.*?)\s*$", nxt)
                if sub:
                    attest_subject = sub.group(1)
                    break
    return perms, attest_subject


build_perms, attest_subject = build_job_facts()
meta.append("build_permissions=%s" % ",".join(sorted(build_perms)))
meta.append("attest_subject=%s" % attest_subject)

for step_name, filename in (
    ("Package tar.gz", "package.sh"),
    ("Assert every archive ships its checksum", "pairing.sh"),
):
    block, step_env = step_run_block(step_name)
    # The env file is written even when empty, so the bash side never has to
    # distinguish "this step declares no env:" from "the extractor did not look".
    (out / (filename[: -len(".sh")] + ".env")).write_text(
        "".join("%s=%s\n" % (name, value) for name, value in step_env.items())
    )
    if block is not None:
        rendered = substitute(block, step_name)
        check_bound_names(rendered, step_env, step_name)
        (out / filename).write_text(rendered)

(out / "meta.txt").write_text("\n".join(meta) + "\n")
(out / "errors.txt").write_text("\n".join(errors) + "\n" if errors else "")
PY

# extract_workflow — run the extractor over <workflow.yml> into <outdir>.
extract_workflow() {
  mkdir -p "$2"
  python3 "$EXTRACTOR_PY" "$1" "$2"
}

extract_workflow "$RELEASE_WORKFLOW" "$WF_DIR"

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
# read_step_env — load the NAME=value pairs the extractor read out of a step's
# own `env:` block into STEP_ENV, ready to splice into an `env -i` invocation.
# `env -i` starts from an empty environment on purpose, so anything the step
# declares for itself has to be handed back explicitly or the body runs with
# those names unbound and misbehaves in ways that look like workflow defects.
STEP_ENV=()
read_step_env() {
  local file="$1" kv
  STEP_ENV=()
  [[ -f "$file" ]] || return 0
  while IFS= read -r kv; do
    [[ -n "$kv" ]] && STEP_ENV+=("$kv")
  done < "$file"
  return 0
}

# run_extracted_step — execute one extracted step body inside the sandbox.
#   $1 body file, $2 the directory to run in (also HOME), $3 GITHUB_ENV (optional)
# Echoes the body's combined output; returns the body's exit status.
#
# WHY THE STEP'S OWN env: IS SPLICED *FIRST* (issue #1242)
# `env -i A=1 A=2` applies its assignments left to right, so the LAST one wins.
# The step's `env:` used to come last, which meant release-rmpc.yml — the file
# this section exists to test — could set `PATH:` and replace the sandbox's PATH
# with one that still has sha256sum on it. Reverting the packaging step to a bare
# `sha256sum` (the exact `high` this selftest was written to catch) then left all
# 30 assertions green, still printing "runs to completion with no sha256sum on
# PATH". A guard that the guarded file can disarm is worse than no guard, so the
# harness's own assignments are written LAST and win unconditionally.
# step_env_block() additionally refuses these names outright, so nothing should
# reach this splice at all. Both, on purpose: the ordering still holds for a name
# the refusal list has not learned about yet, and the refusal still holds if a
# future call site gets the ordering wrong.
run_extracted_step() {
  local body="$1" root="$2" github_env="${3:-}"
  local -a sandbox=(PATH="$NOSHA_BIN" HOME="$root")
  [[ -n "$github_env" ]] && sandbox+=(GITHUB_ENV="$github_env")
  ( cd "$root" && env -i \
    ${STEP_ENV[@]+"${STEP_ENV[@]}"} \
    "${sandbox[@]}" \
    "$(command -v bash)" --noprofile --norc -e -o pipefail "$body" 2>&1 )
}

PKG_RAN=no
if [[ -f "$WF_DIR/package.sh" && -z "$WF_ERRORS" ]]; then
  read_step_env "$WF_DIR/package.env"
  PKG_RAN=yes
  PKG_OUT=$(run_extracted_step "$WF_DIR/package.sh" "$PKG_DIR" "$PKG_DIR/github_env")
  PKG_EXIT=$?
else
  PKG_OUT="the Package tar.gz step could not be extracted cleanly: ${WF_ERRORS:-step not found}"
  PKG_EXIT=127
fi

# This assertion knows one fact — the exit status — and reports it plus the
# captured output. It deliberately does NOT name a cause: an earlier version
# hard-coded "no sha256sum on PATH" for every non-zero exit, which would send an
# operator to revert the workflow's `env:` hardening over a harness bug.
if [[ "$PKG_RAN" != "yes" ]]; then
  fail "packaging step never executed under the macOS runner simulation: $PKG_OUT"
elif [[ $PKG_EXIT -eq 0 ]]; then
  pass "packaging step runs to completion with no sha256sum on PATH (the macOS runner case)"
else
  fail "packaging step exited $PKG_EXIT under the macOS runner simulation (PATH without sha256sum) — read the captured output for the cause before changing release-rmpc.yml (output: $PKG_OUT)"
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
OUT_MAC=$("$INSTALLER" --tag "$TAG" --platform "macos-arm64" --dest "$DEST_MAC" \
  --base-url "file://$WORKDIR/releases-macos" --allow-insecure-base-url 2>&1)
EXIT_MAC=$?

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
  read_step_env "$WF_DIR/pairing.env"
  run_extracted_step "$WF_DIR/pairing.sh" "$root" >/dev/null 2>&1
}

PAIR_OK_ROOT="$WORKDIR/pair-ok"
mkdir -p "$PAIR_OK_ROOT"
make_artifacts "$PAIR_OK_ROOT/artifacts" "${MATRIX_ENTRIES:-4}" keep
run_pairing_guard "$PAIR_OK_ROOT"
PAIR_OK_EXIT=$?

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
run_pairing_guard "$PAIR_BAD_ROOT"
PAIR_BAD_EXIT=$?

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
# `|| true`: pairing.sh is absent whenever the step could not be extracted, and
# a failed sed must leave PAIR_EXPECTED empty for the assertion below to report,
# never abort the run before the summary.
PAIR_EXPECTED=$(sed -n 's/^EXPECTED_ARCHIVES=\([0-9]\+\)$/\1/p' "$WF_DIR/pairing.sh" 2>/dev/null | head -1 || true)
if [[ -n "$PAIR_EXPECTED" && "$PAIR_EXPECTED" == "$MATRIX_ENTRIES" ]]; then
  pass "pairing guard expects $PAIR_EXPECTED archives, matching the $MATRIX_ENTRIES build-matrix entries"
else
  fail "pairing guard expects '${PAIR_EXPECTED:-<none>}' archives but the build matrix has $MATRIX_ENTRIES entries — add a target and the count guard stops matching"
fi

# ---------- release-rmpc.yml must not be able to disarm the sandbox judging it ----------
# Issue #1242. Everything above generates shell out of a PR-editable YAML file and
# runs it, so the assertions are only worth something while the harness's own
# containment beats anything that file can say. It did not: the step's `env:` was
# spliced LAST into `env -i`, which applies assignments left to right, so a single
# `PATH:` key added to the packaging step's `env:` block put sha256sum back inside
# the "macOS runner" simulation. Reverting that step to a bare `sha256sum` — the
# exact defect this selftest was written to catch — then produced 30 passed, 0
# failed, exit 0, still printing "runs to completion with no sha256sum on PATH".
# Reproduced end to end before the fix; these assertions are what stop it coming
# back. Two independent defences are asserted here, because either one alone is a
# single edit away from silence:
#   1. ORDERING — the sandbox's PATH/HOME/GITHUB_ENV are applied after anything
#      the step declares, so a spliced value can never win.
#   2. REFUSAL — the extractor rejects the names the sandbox owns (and the ones
#      bash reads before the body runs, e.g. BASH_ENV) rather than ordering
#      around them, recording an extractor error that blocks execution outright.
# The fixtures below are hostile COPIES of release-rmpc.yml run through the same
# extractor; the real workflow is never modified.
echo ""
echo "--- selftest: the workflow under test cannot disarm the selftest's sandbox ---"

# (1) Ordering, executed through the real runner. The step env file here is
# written by hand rather than extracted, precisely so the ordering is proved for
# a name the refusal list would otherwise have stopped upstream — this is the
# defence that has to hold when the refusal list has not heard of a name yet.
ORDER_ROOT="$WORKDIR/env-order"
HOSTILE_BIN="$WORKDIR/hostile-bin"
mkdir -p "$ORDER_ROOT" "$HOSTILE_BIN"
: > "$ORDER_ROOT/github_env"
# shellcheck disable=SC2016  # the $-expansions are the GENERATED body's, read
# inside the sandbox; expanding them here would write this shell's values into
# the fixture and assert nothing.
printf 'printf "PATH=%%s\\nHOME=%%s\\nGITHUB_ENV=%%s\\n" "$PATH" "$HOME" "$GITHUB_ENV"\n' \
  > "$ORDER_ROOT/body.sh"
{
  printf 'PATH=%s\n' "$HOSTILE_BIN"
  printf 'HOME=%s\n' "$WORKDIR/hostile-home"
  printf 'GITHUB_ENV=%s\n' "$WORKDIR/hostile-github-env"
} > "$ORDER_ROOT/body.env"
read_step_env "$ORDER_ROOT/body.env"
ORDER_OUT=$(run_extracted_step "$ORDER_ROOT/body.sh" "$ORDER_ROOT" "$ORDER_ROOT/github_env")
STEP_ENV=()
ORDER_WANT=$(printf 'PATH=%s\nHOME=%s\nGITHUB_ENV=%s' \
  "$NOSHA_BIN" "$ORDER_ROOT" "$ORDER_ROOT/github_env")

if [[ "$ORDER_OUT" == "$ORDER_WANT" ]]; then
  pass "sandbox ordering: a step env: declaring PATH/HOME/GITHUB_ENV cannot override the sandbox's own values"
else
  fail "sandbox ordering: a step env: overrode the sandbox — the extracted body saw '$ORDER_OUT', expected '$ORDER_WANT'; a workflow PATH: can put sha256sum back inside the macOS simulation and make that assertion vacuous"
fi

# (2) Refusal, proved on hostile copies of the real workflow.
MUTATOR_PY="$WORKDIR/mutate-workflow.py"
cat > "$MUTATOR_PY" <<'PY'
"""Write a deliberately hostile copy of release-rmpc.yml for one fixture.

Each mutation is anchored on the real file, so a fixture whose anchor has moved
exits non-zero and says so rather than producing a copy that asserts nothing —
a silently vacuous fixture is the failure mode this whole section is about.
"""
import pathlib
import sys

src, dst, mutation = sys.argv[1], sys.argv[2], sys.argv[3]
lines = pathlib.Path(src).read_text().splitlines(True)
STEP = "- name: Package tar.gz"


def step_start():
    for i, line in enumerate(lines):
        if line.strip() == STEP:
            return i
    sys.exit("no '%s' step in %s — this fixture's anchor moved" % (STEP, src))


def env_block_start(i):
    for j in range(i, len(lines)):
        if lines[j].strip() == "env:":
            return j
        if lines[j].strip().startswith("run:"):
            break
    sys.exit("the '%s' step has no env: block — this fixture's anchor moved" % STEP)


if mutation == "step-env-path":
    lines.insert(env_block_start(step_start()) + 1, "          PATH: /hostile/bin\n")
elif mutation == "step-env-bash-env":
    lines.insert(
        env_block_start(step_start()) + 1, "          BASH_ENV: /hostile/preamble.sh\n"
    )
elif mutation == "duplicate-step":
    i = step_start()
    lines[i:i] = ["      %s\n" % STEP, "        run: |\n", "          echo decoy\n", "\n"]
elif mutation == "env-moved-up":
    # The variable did not disappear — it moved to the job's or the workflow's
    # `env:`, which the extractor does not read. The body still reads ${VERSION}.
    start = env_block_start(step_start())
    for j in range(start + 1, len(lines)):
        if lines[j].strip().startswith("VERSION:"):
            del lines[j]
            break
    else:
        sys.exit("the '%s' step declares no VERSION: — this fixture's anchor moved" % STEP)
else:
    sys.exit("unknown mutation '%s'" % mutation)

pathlib.Path(dst).write_text("".join(lines))
PY

# hostile_extract — build one hostile copy, run the REAL extractor over it, and
# echo whatever it recorded in errors.txt. A fixture that failed to build reports
# itself in that same channel, so it can only ever produce a FAIL, never a quiet
# pass.
hostile_extract() {
  local mutation="$1" dir="$WORKDIR/hostile/$1" mutate_err
  rm -rf "$dir"
  mkdir -p "$dir/out"
  if ! mutate_err=$(python3 "$MUTATOR_PY" "$RELEASE_WORKFLOW" "$dir/release-rmpc.yml" \
    "$mutation" 2>&1); then
    echo "FIXTURE DID NOT BUILD: $mutate_err"
    return 0
  fi
  extract_workflow "$dir/release-rmpc.yml" "$dir/out" >/dev/null 2>&1
  cat "$dir/out/errors.txt" 2>/dev/null
}

HOSTILE_PATH_ERRORS="$(hostile_extract step-env-path)"
if grep -q "declares env: PATH" <<<"$HOSTILE_PATH_ERRORS"; then
  pass "a packaging step declaring 'env: PATH:' is refused by the extractor, so it never runs and the macOS assertion cannot be made vacuous"
else
  fail "a packaging step declaring 'env: PATH:' was accepted — that value would replace the sandbox PATH, putting sha256sum back into the macOS runner simulation (extractor errors: ${HOSTILE_PATH_ERRORS:-<none>})"
fi

HOSTILE_BASH_ENV_ERRORS="$(hostile_extract step-env-bash-env)"
if grep -q "declares env: BASH_ENV" <<<"$HOSTILE_BASH_ENV_ERRORS"; then
  pass "a packaging step declaring 'env: BASH_ENV:' is refused — bash would have sourced that file before the step body, which no assertion here can see"
else
  fail "a packaging step declaring 'env: BASH_ENV:' was accepted — bash sources it before the extracted body, so code outside the step text runs invisibly (--noprofile/--norc do not suppress it) (extractor errors: ${HOSTILE_BASH_ENV_ERRORS:-<none>})"
fi

HOSTILE_DUP_ERRORS="$(hostile_extract duplicate-step)"
if grep -q "matches 2 steps" <<<"$HOSTILE_DUP_ERRORS"; then
  pass "two steps sharing the name 'Package tar.gz' are refused rather than resolved to the first match"
else
  fail "a duplicate 'Package tar.gz' step was resolved silently to the first match — a decoy step in an earlier job is then extracted and executed while the real one stays broken (extractor errors: ${HOSTILE_DUP_ERRORS:-<none>})"
fi

HOSTILE_MOVED_ERRORS="$(hostile_extract env-moved-up)"
# shellcheck disable=SC2016  # '${VERSION}' is literal text inside the extractor's
# error message, not an expansion this shell should perform.
if grep -q 'reads ${VERSION}' <<<"$HOSTILE_MOVED_ERRORS"; then
  pass "a body reading a name its own env: no longer declares is refused — the extractor reads step-level env: only, and says so instead of rendering an empty string"
else
  fail "a body reading \${VERSION} with no step-level declaration was extracted anyway — moved to a job- or workflow-level env: that name expands to empty here, and the step 'succeeds' having packaged nothing (extractor errors: ${HOSTILE_MOVED_ERRORS:-<none>})"
fi

# ---------- an insecure base URL must not be able to print "verified" ----------
echo ""
echo "--- selftest: a non-https --base-url is refused without the explicit opt-out ---"
OUT_HTTP=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$WORKDIR/bin-http" \
  --base-url "http://mirror.invalid/releases" 2>&1)
EXIT_HTTP=$?

if [[ $EXIT_HTTP -eq 2 && ! -e "$WORKDIR/bin-http/rmpc" ]]; then
  pass "insecure base URL: http:// is refused with exit 2 before anything is downloaded"
else
  fail "insecure base URL: installer exited $EXIT_HTTP on a plaintext --base-url (output: $OUT_HTTP)"
fi

# ---------- a digest tool that cannot run must not exit undocumented ----------
# The installer's exit codes are its interface: a wrapper routes on them. A
# failing sha256sum/shasum used to fall out as a bare 1 with no ERROR line —
# not in the documented set, and indistinguishable from any other bash failure.
# It can never false-verify (the coverage guard forces a 64-hex expected digest,
# so an empty actual can only mismatch), so this asserts the CLASSIFICATION: the
# unverifiable case reports itself as unverifiable, code 4, like every other one.
echo ""
echo "--- selftest: a digest tool that fails exits 4, not an undocumented 1 ---"

BROKEN_SHA_BIN="$WORKDIR/broken-sha-bin"
mkdir -p "$BROKEN_SHA_BIN"
for stub in sha256sum shasum; do
  printf '#!/usr/bin/env bash\necho "%s: simulated failure" >&2\nexit 1\n' "$stub" \
    > "$BROKEN_SHA_BIN/$stub"
  chmod +x "$BROKEN_SHA_BIN/$stub"
done

DEST_BROKEN="$WORKDIR/bin-broken-sha"
OUT_BROKEN=$(PATH="$BROKEN_SHA_BIN:$PATH" "$INSTALLER" --tag "$TAG" --platform "$PLATFORM" \
  --dest "$DEST_BROKEN" --base-url "file://$WORKDIR/releases" --allow-insecure-base-url 2>&1)
EXIT_BROKEN=$?

if [[ $EXIT_BROKEN -eq 4 && ! -e "$DEST_BROKEN/rmpc" ]] \
  && grep -q 'could not compute the sha256' <<< "$OUT_BROKEN"; then
  pass "a digest tool that fails is reported as unverified with exit 4, and nothing is installed"
else
  fail "a failing digest tool produced exit $EXIT_BROKEN (expected 4) with dest $([[ -e "$DEST_BROKEN/rmpc" ]] && echo populated || echo empty) (output: $OUT_BROKEN)"
fi

# ---------- #1236: build provenance is the out-of-band anchor the checksum is not ----------
# Every assertion above this line proves the checksum control works. None of them
# could ever prove the release is AUTHENTIC, because the `.sha256` is published
# by whoever published the archive: a leaked `contents: write` token writes both,
# and the installer prints "verified" over a trojan. The control with a different
# trust root is `gh attestation verify` — a Sigstore certificate carrying the
# release workflow's OIDC identity, which cannot be minted without an
# `id-token: write` Actions run in this repository.
#
# WHAT THESE ASSERTIONS COVER, AND WHAT THEY DO NOT
# They do NOT verify a signature: no real attestation exists offline, and faking
# one into a green would be worse than having no test. They cover the installer's
# GATING, which is the half that lives in this repository and the half a future
# edit can delete silently:
#   - the verifier is invoked at all, on the archive that was just checksummed;
#   - the identity is PINNED when it is (`--repo` plus `--signer-workflow`; with
#     only `--repo`, any workflow in this repository could vouch for an archive,
#     which readmits the malicious-workflow-run case #1236 names);
#   - a non-zero verdict is FATAL, with the documented exit 6, before extract;
#   - a missing `gh` is a refusal, not a downgrade to "install it unattested".
# Delete the attest block from install-rmpc.sh and the first seven of these go
# red; that is the fail-without-the-fix property this section exists to have.
echo ""
echo "--- selftest: an archive whose build provenance does not verify is refused ---"

# --- the invocation itself: shape and identity pinning ---
: > "$GH_ARGV_LOG"
DEST_ATT_OK="$WORKDIR/bin-attest-ok"
OUT_ATT_OK=$("$INSTALLER" --tag "$TAG" --platform "$PLATFORM" --dest "$DEST_ATT_OK" \
  --base-url "file://$WORKDIR/releases" --allow-insecure-base-url 2>&1)
EXIT_ATT_OK=$?
GH_CALL="$(cat "$GH_ARGV_LOG")"

if [[ $EXIT_ATT_OK -eq 0 ]] && grep -q "attestation verify" <<<"$GH_CALL" \
  && grep -q "$ARCHIVE" <<<"$GH_CALL"; then
  pass "provenance: the installer runs 'gh attestation verify' over ${ARCHIVE} on the install path"
else
  fail "provenance: no 'gh attestation verify' call naming ${ARCHIVE} was recorded (installer exit $EXIT_ATT_OK, gh calls: '${GH_CALL:-<none>}', output: $OUT_ATT_OK)"
fi

if grep -q -- "--repo robotmoney/robotmoney-core" <<<"$GH_CALL"; then
  pass "provenance: the verification is scoped to --repo robotmoney/robotmoney-core"
else
  fail "provenance: the gh call does not pin --repo robotmoney/robotmoney-core, so an attestation linked to any repository would be accepted (gh calls: '${GH_CALL:-<none>}')"
fi

# --signer-workflow is the difference between "somebody's workflow in this repo
# built it" and "the release workflow built it". Without it, the malicious
# workflow run in #1236's threat list is back in scope.
if grep -q -- "--signer-workflow robotmoney/robotmoney-core/.github/workflows/release-rmpc.yml" <<<"$GH_CALL" \
  && grep -q -- "--deny-self-hosted-runners" <<<"$GH_CALL"; then
  pass "provenance: the signer identity is pinned to release-rmpc.yml on a GitHub-hosted runner"
else
  fail "provenance: the gh call does not pin --signer-workflow to .github/workflows/release-rmpc.yml (and --deny-self-hosted-runners) — any workflow in the repository could then vouch for an archive (gh calls: '${GH_CALL:-<none>}')"
fi

# Ordering is load-bearing exactly as it is for the checksum: an archive that
# fails provenance must never have been unpacked.
ATT_LINE=$(grep -n 'STEP attest' <<<"$OUT_ATT_OK" | head -1 | cut -d: -f1)
EXTRACT_LINE=$(grep -n 'STEP extract' <<<"$OUT_ATT_OK" | head -1 | cut -d: -f1)
if [[ -n "$ATT_LINE" && -n "$EXTRACT_LINE" && "$ATT_LINE" -lt "$EXTRACT_LINE" ]]; then
  pass "provenance: the attest step runs before extract, so a failure cannot unpack anything"
else
  fail "provenance: expected 'STEP attest' before 'STEP extract' (attest at line '${ATT_LINE:-<absent>}', extract at '${EXTRACT_LINE:-<absent>}') (output: $OUT_ATT_OK)"
fi

# --- the refusal path: verification fails ---
# This is the fixture the acceptance criteria ask for: an archive that is intact,
# correctly checksummed, and has no attestation that verifies. Everything the
# pre-#1236 installer checked passes here.
: > "$GH_ARGV_LOG"
DEST_ATT_BAD="$WORKDIR/bin-attest-bad"
OUT_ATT_BAD=$(GH_STUB_EXIT=1 "$INSTALLER" --tag "$TAG" --platform "$PLATFORM" \
  --dest "$DEST_ATT_BAD" --base-url "file://$WORKDIR/releases" --allow-insecure-base-url 2>&1)
EXIT_ATT_BAD=$?

if [[ $EXIT_ATT_BAD -eq 4 ]]; then
  # Guard against a pass for the wrong reason: this fixture's checksum is good,
  # so a 4 here means the archive never reached the attest step at all.
  fail "provenance: the unattested archive was rejected at the CHECKSUM step (exit 4), so the attestation gate did not execute (output: $OUT_ATT_BAD)"
elif [[ $EXIT_ATT_BAD -eq 6 ]]; then
  pass "provenance: an archive whose attestation does not verify is refused with the documented exit 6"
else
  fail "provenance: installer exited $EXIT_ATT_BAD on an archive with no verifiable attestation, expected 6 (output: $OUT_ATT_BAD)"
fi

if [[ -e "$DEST_ATT_BAD/rmpc" ]]; then
  fail "provenance: an unattested rmpc was installed at $DEST_ATT_BAD/rmpc"
else
  pass "provenance: no unattested binary reached the destination"
fi

if grep -q 'STEP extract' <<<"$OUT_ATT_BAD" || grep -q 'STEP install' <<<"$OUT_ATT_BAD"; then
  fail "provenance: extract or install was reached despite a failed attestation (output: $OUT_ATT_BAD)"
else
  pass "provenance: neither extract nor install was reached for the unattested archive"
fi

# --- the refusal path: no verifier available ---
# A missing `gh` must fail closed. The tempting shape is "warn and continue",
# which turns the whole control into an opt-out any environment can take by
# accident. The sandbox holds only the tools install-rmpc.sh legitimately needs;
# `gh` is the one deliberately absent, and the assertion names it so a genuinely
# missing prerequisite cannot pass for the case under test.
NOGH_BIN="$WORKDIR/nogh-bin"
mkdir -p "$NOGH_BIN"
for tool in bash curl tar sha256sum shasum mktemp install grep cut wc head tr uname sed rm mkdir cat; do
  tool_path="$(command -v "$tool" 2>/dev/null || true)"
  [[ -n "$tool_path" ]] && ln -sf "$tool_path" "$NOGH_BIN/$tool"
done

DEST_NOGH="$WORKDIR/bin-nogh"
OUT_NOGH=$(PATH="$NOGH_BIN" "$INSTALLER" --tag "$TAG" --platform "$PLATFORM" \
  --dest "$DEST_NOGH" --base-url "file://$WORKDIR/releases" --allow-insecure-base-url 2>&1)
EXIT_NOGH=$?

if [[ $EXIT_NOGH -eq 2 ]] && grep -q 'gh' <<<"$OUT_NOGH" && grep -qi 'refusing' <<<"$OUT_NOGH"; then
  pass "provenance: a missing gh is a hard refusal (exit 2, naming gh), never a downgrade to installing unattested"
else
  fail "provenance: with no gh on PATH the installer exited $EXIT_NOGH — expected a refusal naming gh (output: $OUT_NOGH)"
fi

# The refusal has to land BEFORE the fetch, not after it. install-rmpc.sh checks
# for `gh` alongside curl/tar/sha256sum for that reason: an operator missing the
# verifier should learn it in the first second, not after a multi-megabyte
# download. Asserting it here also keeps this case from passing vacuously — a
# build with no attestation gate at all exits 2 for some unrelated reason further
# down, having already downloaded.
if [[ ! -e "$DEST_NOGH/rmpc" ]] && ! grep -q 'STEP download' <<<"$OUT_NOGH"; then
  pass "provenance: with no verifier present the refusal precedes the download, and nothing is installed"
else
  fail "provenance: with no gh on PATH the installer downloaded first and/or left a binary at $DEST_NOGH/rmpc (output: $OUT_NOGH)"
fi

# --- the producing half, read structurally out of release-rmpc.yml ---
# These two are PRESENCE assertions and are labelled as such: `permissions:` and
# `uses: actions/attest-build-provenance` have no shell body to execute and no
# offline way to mint a real Sigstore bundle, so unlike the `run:` bodies above
# they cannot be run here. What they are not is a grep over the whole file: the
# extractor reads them out of the parsed `jobs.build` block, so a permission map
# belonging to `publish`, or an attest step in a job with no `id-token: write`,
# does not satisfy them. The install-side gating above is what is executed.
BUILD_PERMS=$(sed -n 's/^build_permissions=//p' "$WF_DIR/meta.txt" 2>/dev/null || true)
ATTEST_SUBJECT=$(sed -n 's/^attest_subject=//p' "$WF_DIR/meta.txt" 2>/dev/null || true)

if grep -q 'id-token:write' <<<"$BUILD_PERMS" && grep -q 'attestations:write' <<<"$BUILD_PERMS"; then
  pass "release-rmpc.yml's build job grants id-token: write and attestations: write — without both, no attestation is ever minted"
else
  fail "release-rmpc.yml's build job does not grant both id-token: write and attestations: write (its permissions: '${BUILD_PERMS:-<none>}') — the attest step would fail and releases would ship unattested"
fi

# The subject has to be the SAME name the packaging step exported, or the
# attestation covers bytes other than the ones uploaded.
# shellcheck disable=SC2016  # '${{ env.ARCHIVE }}' is the literal GitHub Actions
# expression as it appears in the YAML, not something this shell should expand.
if [[ "$ATTEST_SUBJECT" == '${{ env.ARCHIVE }}' ]] \
  && grep -q 'ARCHIVE=' "$WF_DIR/package.sh" 2>/dev/null; then
  pass "release-rmpc.yml attests \${{ env.ARCHIVE }} — the exact archive name the packaging step exports"
else
  fail "release-rmpc.yml's attest step covers '${ATTEST_SUBJECT:-<no attest step>}' rather than the \${{ env.ARCHIVE }} the packaging step exports — the attested bytes and the published bytes could drift apart"
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
