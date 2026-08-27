#!/usr/bin/env bash
# Guard exercise for .github/scripts/assert_manifest_ahead_of_tags.sh
#
# Canonical: .github/scripts/assert_manifest_ahead_of_tags.sh
# Issue: #1191
#
# WHY THIS EXISTS
# assert_manifest_ahead_of_tags.sh is a CI guard whose subject is REPOSITORY
# STATE — the published tag list — so on `dev` it only ever sees one tag set:
# the real one, in the one arrangement that passes. Every branch that MATTERS
# (collision, regression, tagless checkout, unreadable manifest, prerelease
# ordering) is therefore unreachable in CI, and a guard whose failure paths
# never execute is a guard nobody has checked. This drives it against synthetic
# repositories built per case, asserting the exit code each one must produce.
#
# The prerelease cases are the reason this file was written rather than assumed.
# `sort -V` ranks `v0.4.0-rc.1` AFTER `v0.4.0`, the inverse of semver, so a
# published prerelease became LATEST_TAG and a manifest correctly sitting at
# 0.4.0 was reported as BEHIND it — turning every open PR red on a true
# statement's negation. That is a false RED, not a false green, so it could
# never be caught by the guard passing on `dev`.
#
# No network, no rmpc build, no real tags: each case is a throwaway `git init`
# in a temp dir with fixture tags and a two-line Cargo.toml.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/assert_manifest_ahead_of_tags.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FATAL: guard not found at $SCRIPT" >&2
  exit 2
fi

# A case that stops being REACHED is indistinguishable from one that passes, so
# the count of assertions actually executed is asserted too. Raise this together
# with any case you add; lowering it is how coverage disappears quietly.
MIN_EXPECTED_ASSERTIONS=15

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# make_repo <manifest-version> [tag ...] -> prints the repo path
# An empty manifest-version writes a [package] block with no `version` key,
# which is the "could not read version" case.
#
# The directory comes from mktemp, not a counter: make_repo is called inside a
# command substitution, so a counter would increment in a SUBSHELL and every
# case would silently reuse the first case's repo — inheriting its tags and
# quietly testing the wrong arrangement.
make_repo() {
  local version="$1"
  shift
  local dir
  dir="$(mktemp -d "$WORKDIR/case-XXXXXX")"
  mkdir -p "$dir/clients/rust-payment-client"

  {
    echo '[package]'
    echo 'name = "rust-payment-client"'
    [[ -n "$version" ]] && echo "version = \"${version}\""
    echo 'edition = "2021"'
    echo ''
    echo '[dependencies]'
    echo 'version = "9.9.9"'
  } > "$dir/clients/rust-payment-client/Cargo.toml"

  git -C "$dir" init --quiet >/dev/null
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "test"
  git -C "$dir" add -A
  git -C "$dir" commit --quiet -m "fixture" >/dev/null
  local tag
  for tag in "$@"; do
    git -C "$dir" tag "$tag"
  done
  printf '%s\n' "$dir"
}

# expect_exit <expected> <description> <manifest-version> [tag ...]
expect_exit() {
  local expected="$1" desc="$2" version="$3"
  shift 3
  local dir out code
  dir="$(make_repo "$version" "$@")"
  out="$(cd "$dir" && bash "$SCRIPT" 2>&1)" && code=0 || code=$?
  if [[ "$code" -eq "$expected" ]]; then
    pass "$desc (exit $code)"
  else
    fail "$desc — expected exit $expected, got $code (output: $out)"
  fi
}

echo "--- guard exercise: assert_manifest_ahead_of_tags.sh ---"

# ---------- the passing arrangement ----------
expect_exit 0 "manifest ahead of the newest release tag passes" \
  "0.3.4" v0.0.1 v0.3.2 v0.3.3

# `sort -V` vs a lexical sort: 0.10.0 outranks 0.9.0.
expect_exit 0 "double-digit minor is ordered numerically, not lexically" \
  "0.11.0" v0.9.0 v0.10.0

expect_exit 1 "a manifest BEHIND v0.10.0 is caught even though it sorts after it lexically" \
  "0.9.1" v0.9.0 v0.10.0

# ---------- the two failures the guard exists to catch ----------
expect_exit 1 "manifest pinned at an already-published version is a collision" \
  "0.3.3" v0.3.2 v0.3.3

expect_exit 1 "manifest behind the newest release tag is a regression" \
  "0.2.0" v0.3.2 v0.3.3

# ---------- fail-closed, never a silent pass ----------
# A tagless (shallow) checkout must be a hard error: the guard cannot see its
# subject, and exiting 0 there is the false green the coverage policy forbids.
expect_exit 2 "a tagless checkout is a hard error, not a pass" \
  "0.3.4"

expect_exit 2 "a [package] block with no version is a hard error" \
  "" v0.3.3

MISSING_DIR="$WORKDIR/no-manifest"
mkdir -p "$MISSING_DIR"
MISSING_OUT="$(cd "$MISSING_DIR" && bash "$SCRIPT" 2>&1)" && MISSING_CODE=0 || MISSING_CODE=$?
if [[ "$MISSING_CODE" -eq 2 ]]; then
  pass "a missing manifest is a hard error (exit 2)"
else
  fail "a missing manifest should exit 2, got $MISSING_CODE (output: $MISSING_OUT)"
fi

# Non-release tags must not raise the floor: a dryrun-* upload or a feature
# marker is not a published version.
expect_exit 0 "non-release tags do not raise the floor" \
  "0.3.4" v0.3.3 dryrun-abc1234 some-feature-marker

# ---------- prerelease precedence (semver §11) ----------
# THE REGRESSION CASE. Before semver_sort, `sort -V` made v0.4.0-rc.1 the
# newest tag, so a manifest at 0.4.0 — which semver ranks ABOVE that rc — was
# reported as behind it and every open PR to dev went red.
expect_exit 0 "a manifest at X.Y.Z is AHEAD of the published X.Y.Z-rc.N" \
  "0.4.0" v0.3.3 v0.4.0-rc.1

expect_exit 0 "a later rc outranks an earlier one without outranking the release" \
  "0.4.0" v0.4.0-rc.1 v0.4.0-rc.2

# A prerelease still counts as published: parking the manifest on one is the
# same self-identification harm as parking it on a final release.
expect_exit 1 "manifest pinned at a published prerelease is a collision" \
  "0.4.0-rc.1" v0.3.3 v0.4.0-rc.1

expect_exit 1 "manifest behind a published prerelease is a regression" \
  "0.3.3" v0.3.2 v0.4.0-rc.1

# The prerelease suffix may itself contain a hyphen; only the FIRST one is the
# separator, so `rc-1` must not be split further.
expect_exit 0 "a hyphen INSIDE the prerelease identifier does not break ordering" \
  "0.4.0" v0.4.0-rc-1

# Once the final release ships it outranks its own prereleases again.
expect_exit 1 "the final release outranks its prereleases (collision on X.Y.Z)" \
  "0.4.0" v0.4.0-rc.1 v0.4.0

TOTAL=$((PASS + FAIL))
echo ""
echo "=== assert_manifest_ahead_of_tags guard exercise: ${PASS} passed, ${FAIL} failed ==="

if [[ "$TOTAL" -lt "$MIN_EXPECTED_ASSERTIONS" ]]; then
  echo "FAIL: only ${TOTAL} assertions ran, fewer than the ${MIN_EXPECTED_ASSERTIONS} this file declares — a case stopped being reached" >&2
  exit 1
fi

echo "MANIFEST_GUARD_ASSERTIONS_EXECUTED=${TOTAL}"
[[ "$FAIL" -eq 0 ]] || exit 1
