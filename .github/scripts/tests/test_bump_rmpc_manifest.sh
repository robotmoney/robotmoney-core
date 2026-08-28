#!/usr/bin/env bash
# Exercise for .github/scripts/bump_rmpc_manifest.sh
#
# Canonical: .github/scripts/bump_rmpc_manifest.sh
# Issue: #1243
#
# WHY THIS EXISTS
# bump_rmpc_manifest.sh is the automated half of the release/PR version contract:
# publishing a release deterministically leaves `dev` failing the manifest-ahead
# guard, and this script is what opens the fix. It runs inside release-rmpc.yml,
# which fires ONLY on a tag — so without this file its first execution ever would
# be during a real release, on `dev`, holding `contents: write`. That is not a
# place to discover that the patch arithmetic went lexical or that the rewrite ate
# a dependency's `version =` key.
#
# The last assertion is the one that matters most: it does not just check the
# string the script printed, it feeds the rewritten manifest to the real guard
# and asserts the guard now passes. That is the actual contract between the two —
# "the bump the release opens is a bump the PR guard accepts" — and it is
# unprovable by reading either file.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/bump_rmpc_manifest.sh"
GUARD="${REPO_ROOT}/.github/scripts/assert_manifest_ahead_of_tags.sh"

for f in "$SCRIPT" "$GUARD"; do
  if [[ ! -f "$f" ]]; then
    echo "FATAL: not found at $f" >&2
    exit 2
  fi
done

# Raise this together with any case you add; lowering it is how coverage
# disappears quietly.
MIN_EXPECTED_ASSERTIONS=15

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# A manifest shaped like the real one: a [package] version AND a dependency key
# also spelled `version = `, which is the thing a blunt sed corrupts.
make_manifest() {
  local version="$1" dir
  dir="$(mktemp -d "$WORKDIR/case-XXXXXX")"
  mkdir -p "$dir/clients/rust-payment-client"
  {
    echo '[package]'
    echo 'name = "rust-payment-client"'
    [[ -n "$version" ]] && echo "version = \"${version}\""
    echo 'edition = "2021"'
    echo ''
    echo '[dependencies]'
    echo 'serde = { version = "1.0", features = ["derive"] }'
    echo ''
    echo '[dependencies.clap]'
    echo 'version = "4.5.0"'
  } > "$dir/clients/rust-payment-client/Cargo.toml"
  printf '%s\n' "$dir"
}

package_version() {
  awk '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{
         gsub(/^version[[:space:]]*=[[:space:]]*"/,""); gsub(/".*$/,""); print; exit }' "$1"
}

echo "--- exercise: bump_rmpc_manifest.sh ---"

# ---------- the case every release creates ----------
DIR="$(make_manifest "0.4.0")"
OUT="$(cd "$DIR" && bash "$SCRIPT" rmpc-v0.4.0 2>&1)" && CODE=0 || CODE=$?
MF="$DIR/clients/rust-payment-client/Cargo.toml"
if [[ "$CODE" -eq 0 ]]; then
  pass "the post-release collision state is rewritten (exit 0)"
else
  fail "post-release collision should exit 0, got $CODE (output: $OUT)"
fi
if grep -qx "next=0.4.1" <<<"$OUT"; then
  pass "the next version is announced as next=0.4.1 for release-rmpc.yml to read"
else
  fail "expected a 'next=0.4.1' line, got: $OUT"
fi
if [[ "$(package_version "$MF")" == "0.4.1" ]]; then
  pass "[package] version is now 0.4.1"
else
  fail "[package] version is $(package_version "$MF"), expected 0.4.1"
fi
# THE REWRITE THAT MUST NOT SPREAD. A sed on /^version/ would leave these alone,
# but a sed on /version *=/ rewrites clap's to the crate version and the manifest
# silently stops resolving.
if grep -q 'serde = { version = "1.0"' "$MF" && grep -q '^version = "4.5.0"$' "$MF"; then
  pass "dependency 'version =' keys are untouched by the rewrite"
else
  fail "the rewrite corrupted a dependency version key: $(cat "$MF")"
fi

# ---------- the tag can arrive in any of its shapes ----------
for TAGFORM in "rmpc-v0.4.0" "v0.4.0" "0.4.0"; do
  DIR="$(make_manifest "0.4.0")"
  (cd "$DIR" && bash "$SCRIPT" "$TAGFORM" >/dev/null 2>&1) && CODE=0 || CODE=$?
  if [[ "$CODE" -eq 0 && "$(package_version "$DIR/clients/rust-payment-client/Cargo.toml")" == "0.4.1" ]]; then
    pass "release version '$TAGFORM' is normalised and bumped to 0.4.1"
  else
    fail "release version '$TAGFORM' did not bump correctly (exit $CODE)"
  fi
done

# ---------- arithmetic, not string surgery ----------
DIR="$(make_manifest "0.9.9")"
(cd "$DIR" && bash "$SCRIPT" rmpc-v0.9.9 >/dev/null 2>&1) || true
if [[ "$(package_version "$DIR/clients/rust-payment-client/Cargo.toml")" == "0.9.10" ]]; then
  pass "0.9.9 bumps to 0.9.10, not 0.9.91 or 0.10.0"
else
  fail "0.9.9 bumped to $(package_version "$DIR/clients/rust-payment-client/Cargo.toml"), expected 0.9.10"
fi

# A prerelease is superseded by its own final release (semver §11).
DIR="$(make_manifest "0.4.0-rc.1")"
(cd "$DIR" && bash "$SCRIPT" rmpc-v0.4.0-rc.1 >/dev/null 2>&1) || true
if [[ "$(package_version "$DIR/clients/rust-payment-client/Cargo.toml")" == "0.4.0" ]]; then
  pass "a released prerelease bumps to its own final release (0.4.0-rc.1 -> 0.4.0)"
else
  fail "0.4.0-rc.1 bumped to $(package_version "$DIR/clients/rust-payment-client/Cargo.toml"), expected 0.4.0"
fi

# ---------- no-op and error paths ----------
# A release cut from an older commit, or a re-run after the bump already merged.
DIR="$(make_manifest "0.5.0")"
OUT="$(cd "$DIR" && bash "$SCRIPT" rmpc-v0.4.0 2>&1)" && CODE=0 || CODE=$?
if [[ "$CODE" -eq 3 && "$(package_version "$DIR/clients/rust-payment-client/Cargo.toml")" == "0.5.0" ]]; then
  pass "a manifest that is not on the released version is left alone (exit 3)"
else
  fail "expected exit 3 and an untouched manifest, got exit $CODE / $(package_version "$DIR/clients/rust-payment-client/Cargo.toml")"
fi

DIR="$(make_manifest "")"
(cd "$DIR" && bash "$SCRIPT" rmpc-v0.4.0 >/dev/null 2>&1) && CODE=0 || CODE=$?
if [[ "$CODE" -eq 2 ]]; then
  pass "a [package] block with no version is a hard error (exit 2)"
else
  fail "missing [package] version should exit 2, got $CODE"
fi

DIR="$(mktemp -d "$WORKDIR/case-XXXXXX")"
(cd "$DIR" && bash "$SCRIPT" rmpc-v0.4.0 >/dev/null 2>&1) && CODE=0 || CODE=$?
if [[ "$CODE" -eq 2 ]]; then
  pass "a missing manifest is a hard error (exit 2)"
else
  fail "missing manifest should exit 2, got $CODE"
fi

DIR="$(make_manifest "0.4.0")"
(cd "$DIR" && bash "$SCRIPT" "not-a-version" >/dev/null 2>&1) && CODE=0 || CODE=$?
if [[ "$CODE" -eq 2 ]]; then
  pass "a released-version argument that is not a version is a hard error (exit 2)"
else
  fail "'not-a-version' should exit 2, got $CODE"
fi

# ---------- the contract between the two guards ----------
# The point of the whole job: the bump release-rmpc.yml opens must be a bump the
# PR guard accepts. Same synthetic repo, both scripts, in the order a release
# actually runs them.
DIR="$(make_manifest "0.4.0")"
git -C "$DIR" init --quiet >/dev/null
git -C "$DIR" config user.email "test@example.com"
git -C "$DIR" config user.name "test"
git -C "$DIR" add -A
git -C "$DIR" commit --quiet -m "post-release state" >/dev/null
git -C "$DIR" tag v0.3.3
git -C "$DIR" tag rmpc-v0.4.0

BEFORE_OUT="$(cd "$DIR" && bash "$GUARD" 2>&1)" && BEFORE=0 || BEFORE=$?
(cd "$DIR" && bash "$SCRIPT" rmpc-v0.4.0 >/dev/null 2>&1) || true
AFTER_OUT="$(cd "$DIR" && bash "$GUARD" 2>&1)" && AFTER=0 || AFTER=$?

if [[ "$BEFORE" -eq 1 ]]; then
  pass "the state a release leaves behind really does fail the manifest-ahead guard (exit 1)"
else
  fail "expected the post-release state to fail the guard with exit 1, got $BEFORE (output: $BEFORE_OUT)"
fi
if [[ "$AFTER" -eq 0 ]]; then
  pass "the bump this script writes makes that same repository pass the guard (exit 0)"
else
  fail "expected the guard to pass after the bump, got $AFTER (output: $AFTER_OUT)"
fi

TOTAL=$((PASS + FAIL))
echo ""
echo "=== bump_rmpc_manifest exercise: ${PASS} passed, ${FAIL} failed ==="

if [[ "$TOTAL" -lt "$MIN_EXPECTED_ASSERTIONS" ]]; then
  echo "FAIL: only ${TOTAL} assertions ran, fewer than the ${MIN_EXPECTED_ASSERTIONS} this file declares — a case stopped being reached" >&2
  exit 1
fi

echo "BUMP_SCRIPT_ASSERTIONS_EXECUTED=${TOTAL}"
[[ "$FAIL" -eq 0 ]] || exit 1
