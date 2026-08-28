#!/usr/bin/env bash
# Guard exercise for .github/scripts/assert_manifest_ahead_of_tags.sh
#
# Canonical: .github/scripts/assert_manifest_ahead_of_tags.sh
# Issues: #1191 (the guard), #1243 (tag namespacing + change scoping)
#
# WHY THIS EXISTS
# assert_manifest_ahead_of_tags.sh is a CI guard whose subject is REPOSITORY
# STATE — the published tag list — so on `dev` it only ever sees one tag set:
# the real one, in the one arrangement that passes. Every branch that MATTERS
# (collision, regression, tagless checkout, unreadable manifest, prerelease
# ordering, a foreign tag in the retired namespace, the post-release state) is
# therefore unreachable in CI, and a guard whose failure paths never execute is a
# guard nobody has checked. This drives it against synthetic repositories built
# per case, asserting the exit code each one must produce.
#
# The prerelease cases are the reason this file was written rather than assumed.
# `sort -V` ranks `0.4.0-rc.1` AFTER `0.4.0`, the inverse of semver, so a
# published prerelease became the newest release and a manifest correctly sitting
# at 0.4.0 was reported as BEHIND it — turning every open PR red on a true
# statement's negation. That is a false RED, not a false green, so it could
# never be caught by the guard passing on `dev`.
#
# The namespace and scoping cases (issue #1243) are the same kind of claim about
# a state `dev` cannot reach: that a dApp release under the retired `v*.*.*`
# namespace cannot raise the rmpc floor, and that the post-release state — the
# one every release deterministically creates — reds only changes that touch the
# rmpc crate. Both are asserted here by execution, not by reading the workflow.
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
MIN_EXPECTED_ASSERTIONS=29

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
# LEGACY_CEILING (0.3.3) is the frozen summary of the retired shared namespace,
# so it is the floor in every case below that publishes no rmpc-v* tag.
expect_exit 0 "manifest ahead of the newest release passes" \
  "0.3.4" v0.0.1 v0.3.2 v0.3.3

expect_exit 0 "manifest ahead of the newest rmpc-v* release passes" \
  "0.4.1" v0.3.3 rmpc-v0.4.0

# `sort -V` vs a lexical sort: 0.10.0 outranks 0.9.0.
expect_exit 0 "double-digit minor is ordered numerically, not lexically" \
  "0.11.0" v0.3.3 rmpc-v0.9.0 rmpc-v0.10.0

expect_exit 1 "a manifest BEHIND rmpc-v0.10.0 is caught even though it sorts after it lexically" \
  "0.9.1" v0.3.3 rmpc-v0.9.0 rmpc-v0.10.0

# ---------- the two failures the guard exists to catch ----------
expect_exit 1 "manifest pinned at an already-published rmpc version is a collision" \
  "0.4.0" v0.3.3 rmpc-v0.4.0

expect_exit 1 "manifest behind the newest rmpc release is a regression" \
  "0.3.4" v0.3.3 rmpc-v0.4.0

# ---------- the retired shared namespace stays a floor, frozen ----------
# v0.0.1 … v0.3.3 really were rmpc releases — `rmpc-v0.3.3-*.tar.gz` archives are
# published and installable — so parking the manifest on 0.3.3 is a real
# collision and must remain one even though no rmpc-v* tag exists yet.
expect_exit 1 "manifest pinned at the last shared-namespace rmpc release is still a collision" \
  "0.3.3" v0.3.2 v0.3.3

expect_exit 1 "manifest behind the last shared-namespace rmpc release is still a regression" \
  "0.2.0" v0.3.2 v0.3.3

# THE COUPLING CASE (issue #1243). release-dapp.yml publishes into `v*.*.*` with
# an unvalidated tag input. Under the old shared glob this exact arrangement
# exited 1 "Version regression", so a dApp-only release blocked every rmpc PR
# until the rmpc crate was bumped above a version chosen for the dApp.
expect_exit 0 "a dApp release far ahead in the retired v*.*.* namespace does NOT raise the rmpc floor" \
  "0.3.4" v0.3.3 v9.9.9

expect_exit 0 "a whole run of foreign v*.*.* releases still does not raise the rmpc floor" \
  "0.3.4" v0.3.3 v0.4.0 v0.5.0 v1.0.0

# The rmpc namespace is not similarly ignorable: the same version published as an
# rmpc release IS a floor.
expect_exit 1 "the same version published as rmpc-v9.9.9 DOES raise the floor" \
  "0.3.4" v0.3.3 rmpc-v9.9.9

# ---------- fail-closed, never a silent pass ----------
# A tagless (shallow) checkout must be a hard error: the guard cannot see its
# subject, and exiting 0 there is the false green the coverage policy forbids.
expect_exit 2 "a checkout with no release tag in either namespace is a hard error, not a pass" \
  "0.3.4"

# The retired tags are permanent repository state, so they are the fetch canary —
# but an rmpc-v* tag alone also proves the fetch happened.
expect_exit 0 "rmpc-v* tags alone satisfy the fetch canary" \
  "0.4.1" rmpc-v0.4.0

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
  "0.3.4" v0.3.3 dryrun-abc1234 some-feature-marker rmpc-nightly

# ---------- prerelease precedence (semver §11) ----------
# THE REGRESSION CASE. Before semver_sort, `sort -V` made rmpc-v0.4.0-rc.1 the
# newest release, so a manifest at 0.4.0 — which semver ranks ABOVE that rc — was
# reported as behind it and every open PR to dev went red.
expect_exit 0 "a manifest at X.Y.Z is AHEAD of the published X.Y.Z-rc.N" \
  "0.4.0" v0.3.3 rmpc-v0.4.0-rc.1

expect_exit 0 "a later rc outranks an earlier one without outranking the release" \
  "0.4.0" rmpc-v0.4.0-rc.1 rmpc-v0.4.0-rc.2

# A prerelease still counts as published: parking the manifest on one is the
# same self-identification harm as parking it on a final release.
expect_exit 1 "manifest pinned at a published prerelease is a collision" \
  "0.4.0-rc.1" v0.3.3 rmpc-v0.4.0-rc.1

expect_exit 1 "manifest behind a published prerelease is a regression" \
  "0.3.4" v0.3.3 rmpc-v0.4.0-rc.1

# The prerelease suffix may itself contain a hyphen; only the FIRST one is the
# separator, so `rc-1` must not be split further.
expect_exit 0 "a hyphen INSIDE the prerelease identifier does not break ordering" \
  "0.4.0" rmpc-v0.4.0-rc-1

# Once the final release ships it outranks its own prereleases again.
expect_exit 1 "the final release outranks its prereleases (collision on X.Y.Z)" \
  "0.4.0" rmpc-v0.4.0-rc.1 rmpc-v0.4.0

# ---------- change scoping (issue #1243): the post-release state ----------
# Every release deterministically leaves `dev` with manifest == the just-released
# tag, which is a collision. Unscoped, that reds EVERY open PR in the repository
# until somebody bumps the manifest. These cases pin the reconciliation: the state
# still fails for a change that touches the rmpc crate (so the bump is not
# optional and cannot be missed), and does not exist for a change that does not.
#
# expect_exit_scoped <expected> <desc> <manifest-version> <paths...> -- <tags...>
expect_exit_scoped() {
  local expected="$1" desc="$2" version="$3"
  shift 3
  local paths=() tags=() seen_sep=0 arg
  for arg in "$@"; do
    if [[ "$arg" == "--" ]]; then seen_sep=1; continue; fi
    if [[ "$seen_sep" -eq 1 ]]; then tags+=("$arg"); else paths+=("$arg"); fi
  done
  local dir out code listfile
  dir="$(make_repo "$version" ${tags[@]+"${tags[@]}"})"
  listfile="$dir/changed-paths.txt"
  : > "$listfile"
  for arg in ${paths[@]+"${paths[@]}"}; do printf '%s\n' "$arg" >> "$listfile"; done
  out="$(cd "$dir" && bash "$SCRIPT" clients/rust-payment-client/Cargo.toml \
          --changed-paths-from "$listfile" 2>&1)" && code=0 || code=$?
  if [[ "$code" -eq "$expected" ]]; then
    pass "$desc (exit $code)"
  else
    fail "$desc — expected exit $expected, got $code (output: $out)"
  fi
}

# THE ACCEPTANCE CRITERION for issue #1243: publishing an rmpc release must not
# red a PR that does not touch the rmpc crate. Same repository state in both of
# the next two cases — only the change set differs.
expect_exit_scoped 0 "post-release collision does NOT fail a change outside the rmpc crate" \
  "0.4.0" docs/prd.md contracts/src/Gateway.sol -- v0.3.3 rmpc-v0.4.0

expect_exit_scoped 1 "post-release collision DOES fail a change that touches the rmpc crate" \
  "0.4.0" docs/prd.md clients/rust-payment-client/src/main.rs -- v0.3.3 rmpc-v0.4.0

# The post-release bump PR is itself a change to the crate, so it is checked —
# and it is the change that clears the state.
expect_exit_scoped 0 "the post-release bump PR passes the guard it exists to satisfy" \
  "0.4.1" clients/rust-payment-client/Cargo.toml -- v0.3.3 rmpc-v0.4.0

# A path that merely mentions the crate elsewhere in the string must not count.
expect_exit_scoped 0 "a path containing the crate name but not under it does not pull the guard in" \
  "0.4.0" docs/development/clients/rust-payment-client/notes.md -- v0.3.3 rmpc-v0.4.0

# Scoping must never turn a real failure into a pass for a change that IS in
# scope, and must never be reachable when the caller could not determine the
# change set: an empty list runs the guard unscoped (fail-safe).
expect_exit_scoped 1 "an empty changed-path list runs the guard unscoped rather than skipping it" \
  "0.4.0" -- v0.3.3 rmpc-v0.4.0

# A NAMED but MISSING list is a hard error: the caller asked for scoping and did
# not get it, and both "run unscoped" and "pass" would hide that.
SCOPE_DIR="$(make_repo "0.4.0" v0.3.3 rmpc-v0.4.0)"
SCOPE_OUT="$(cd "$SCOPE_DIR" && bash "$SCRIPT" clients/rust-payment-client/Cargo.toml \
              --changed-paths-from "$SCOPE_DIR/does-not-exist.txt" 2>&1)" && SCOPE_CODE=0 || SCOPE_CODE=$?
if [[ "$SCOPE_CODE" -eq 2 ]]; then
  pass "a named but missing changed-path file is a hard error (exit 2)"
else
  fail "a named but missing changed-path file should exit 2, got $SCOPE_CODE (output: $SCOPE_OUT)"
fi

# The skip is ANNOUNCED. A silent exit 0 is indistinguishable from a pass in a
# CI log, which is the whole failure mode this repository's coverage policy names.
SKIP_DIR="$(make_repo "0.4.0" v0.3.3 rmpc-v0.4.0)"
printf 'docs/prd.md\n' > "$SKIP_DIR/changed-paths.txt"
SKIP_OUT="$(cd "$SKIP_DIR" && bash "$SCRIPT" clients/rust-payment-client/Cargo.toml \
             --changed-paths-from "$SKIP_DIR/changed-paths.txt" 2>&1)" || true
if grep -q "does not apply" <<<"$SKIP_OUT"; then
  pass "the out-of-scope skip announces itself in the CI log"
else
  fail "the out-of-scope skip printed nothing that identifies it as a skip (output: $SKIP_OUT)"
fi

TOTAL=$((PASS + FAIL))
echo ""
echo "=== assert_manifest_ahead_of_tags guard exercise: ${PASS} passed, ${FAIL} failed ==="

if [[ "$TOTAL" -lt "$MIN_EXPECTED_ASSERTIONS" ]]; then
  echo "FAIL: only ${TOTAL} assertions ran, fewer than the ${MIN_EXPECTED_ASSERTIONS} this file declares — a case stopped being reached" >&2
  exit 1
fi

echo "MANIFEST_GUARD_ASSERTIONS_EXECUTED=${TOTAL}"
[[ "$FAIL" -eq 0 ]] || exit 1
