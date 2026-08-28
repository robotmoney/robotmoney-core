#!/usr/bin/env bash
# Assert the rmpc manifest version is STRICTLY AHEAD of every published rmpc release.
#
# WHY THIS EXISTS (issue #1191 — the half `tests/cli_version.rs` structurally cannot cover)
# `rmpc --version` prints `CARGO_PKG_VERSION`, i.e. the `version` field of
# clients/rust-payment-client/Cargo.toml. `tests/cli_version.rs` compares the
# binary's output against `env!("CARGO_PKG_VERSION")` — BOTH SIDES COME FROM THE
# SAME MANIFEST, so that test is tautological on staleness by construction. It
# proves the binary agrees with the manifest; it can never prove the manifest
# says anything true about which build you are holding.
#
# The failure that actually shipped was staleness, not disagreement: the manifest
# sat at the `0.1.0` placeholder while six releases went out as v0.0.1 … v0.3.3,
# so every published archive contained a binary reporting `rmpc 0.1.0`. An
# `assert_ne!(.., "0.1.0")` only pins that one literal. Parking the manifest on
# an ALREADY-PUBLISHED version (e.g. leaving `dev` at 0.3.3 after v0.3.3 ships)
# reproduces the identical harm with a different string: every `dev` build then
# self-identifies as the shipped release line, and an operator still cannot tell
# a patched build from the release. Worse, a release-time `manifest == tag`
# assertion PASSES for such a build, certifying the collision instead of
# catching it.
#
# The invariant that makes `--version` identify a unique artifact is therefore
# ordering, not equality: the in-development manifest must name a version no
# release has consumed. That is what this script checks, and it is only
# checkable against repository state (the tag list), never from inside the crate.
#
# WHICH TAGS COUNT — AND WHY THAT IS NOT SIMPLY "ALL OF THEM" (issue #1243)
# This guard used to glob `v[0-9]*.[0-9]*.[0-9]*`, which is the namespace
# `release-dapp.yml` ALSO publishes into. A dApp-only release therefore raised
# the rmpc floor, and every PR — including PRs that never touch the rmpc crate —
# went red until somebody bumped the rmpc crate above a version chosen for a
# completely different component. Two independent release trains were coupled
# through a shared glob.
#
# rmpc releases now live in their own namespace, `rmpc-vX.Y.Z`, owned solely by
# release-rmpc.yml (see its `on: push: tags:` and its `Validate inputs` step).
# Only that namespace can raise the floor here, so a `v*.*.*` tag — dApp release,
# hand-pushed marker, anything — is structurally incapable of blocking an rmpc PR.
#
# LEGACY_CEILING is the one thing the retired namespace still contributes.
# v0.0.1 … v0.3.3 WERE rmpc releases: archives named `rmpc-v0.3.3-*.tar.gz` are
# published and installable today, so a manifest at 0.3.3 is a real collision and
# must stay one. Rather than reading those tags (which would re-open the coupling
# the moment a dApp release lands at v0.4.0), the newest of them is pinned here as
# a constant floor. It is frozen by construction: release-rmpc.yml no longer
# publishes into `v*.*.*`, so nothing can ever add to the set this constant
# summarises.
#
# SCOPING (`--changed-paths-from`) — issue #1243
# The subject of this guard is the rmpc crate's manifest, and the state it
# reports is a property of the BRANCH, not of the change under review. Left
# unscoped it ran on every PR to `dev`, so the instant a release published, every
# open PR in the repository went red on a fact none of them had introduced and
# none of them could fix. Given a changed-path list this guard applies only when
# the change actually touches the rmpc crate; the release's own post-release bump
# PR (opened automatically by release-rmpc.yml) does touch it, and is what clears
# the state. The skip is announced, never silent, and both branches are executed
# by .github/scripts/tests/test_assert_manifest_ahead_of_tags.sh. Omitting the
# flag — or passing a file that is empty because the caller could not determine
# the change set — runs the guard unscoped, which is the fail-safe direction.
#
# USAGE
#   assert_manifest_ahead_of_tags.sh [manifest-path] [--changed-paths-from FILE]
# Defaults to clients/rust-payment-client/Cargo.toml relative to the repo root.
#
# REQUIREMENTS
# Release tags must be present locally. CI checkouts are shallow and tagless by
# default, so fetch BOTH namespaces first — `refs/tags/v*` does not match
# `rmpc-v*`:
#   git fetch --depth=1 origin \
#     '+refs/tags/v*:refs/tags/v*' '+refs/tags/rmpc-v*:refs/tags/rmpc-v*'
# A checkout with no release tag of either namespace is treated as a hard error,
# not a pass — a guard that silently succeeds when it cannot see its subject is
# the false green this repository's test-coverage policy exists to prevent. The
# retired `v*.*.*` tags are permanent repository state, so their presence is a
# reliable canary that the fetch actually happened.
#
# Reference: skills/_shared/test-coverage-policy.md (invariant 2: Exit 0 != tested).

set -euo pipefail

MANIFEST=""
CHANGED_PATHS_FILE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --changed-paths-from)
      CHANGED_PATHS_FILE="${2:-}"
      if [ -z "${CHANGED_PATHS_FILE}" ]; then
        echo "::error::assert_manifest_ahead_of_tags: --changed-paths-from needs a file argument" >&2
        exit 2
      fi
      shift 2
      ;;
    -*)
      echo "::error::assert_manifest_ahead_of_tags: unknown option '$1'" >&2
      exit 2
      ;;
    *)
      if [ -n "${MANIFEST}" ]; then
        echo "::error::assert_manifest_ahead_of_tags: unexpected extra argument '$1'" >&2
        exit 2
      fi
      MANIFEST="$1"
      shift
      ;;
  esac
done

MANIFEST="${MANIFEST:-clients/rust-payment-client/Cargo.toml}"

# The crate this guard speaks for. A change that does not touch it cannot make
# the manifest stale and cannot un-stale it either.
RMPC_CRATE_PREFIX="clients/rust-payment-client/"

# The last rmpc release published under the retired shared `v*.*.*` namespace.
# See "WHICH TAGS COUNT" above: this is a frozen summary of v0.0.1 … v0.3.3, not
# a value that tracks anything. Nothing can raise it, because release-rmpc.yml no
# longer publishes into that namespace.
LEGACY_CEILING="0.3.3"

if [ ! -f "${MANIFEST}" ]; then
  echo "::error::assert_manifest_ahead_of_tags: manifest not found at ${MANIFEST}" >&2
  exit 2
fi

# First `version = "..."` under [package]. `cargo metadata` would be exact but
# costs a full dependency resolve; the manifest's package block is the second
# stanza of a hand-maintained file and this read is unambiguous on it.
MANIFEST_VERSION="$(
  awk '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{
         gsub(/^version[[:space:]]*=[[:space:]]*"/,""); gsub(/".*$/,""); print; exit }' "${MANIFEST}"
)"

if [ -z "${MANIFEST_VERSION}" ]; then
  echo "::error::assert_manifest_ahead_of_tags: could not read [package] version from ${MANIFEST}" >&2
  exit 2
fi

# ---- scoping -------------------------------------------------------------
# A NAMED file that does not exist is a hard error, never a skip: the caller
# asked for scoping and did not get it, and quietly running unscoped (or quietly
# passing) both hide that. An EMPTY file means "the caller could not determine
# the change set" and runs the guard unscoped — the fail-safe direction.
if [ -n "${CHANGED_PATHS_FILE}" ]; then
  if [ ! -f "${CHANGED_PATHS_FILE}" ]; then
    echo "::error::assert_manifest_ahead_of_tags: --changed-paths-from '${CHANGED_PATHS_FILE}' does not exist" >&2
    exit 2
  fi
  if [ -s "${CHANGED_PATHS_FILE}" ]; then
    if grep -q "^${RMPC_CRATE_PREFIX}" "${CHANGED_PATHS_FILE}"; then
      echo "scope: this change touches ${RMPC_CRATE_PREFIX} — the manifest guard applies"
    else
      echo "scope: no path under ${RMPC_CRATE_PREFIX} in this change ($(wc -l < "${CHANGED_PATHS_FILE}" | tr -d ' ') file(s)); the rmpc manifest version is not this change's subject, so the guard does not apply. See issue #1243."
      exit 0
    fi
  else
    echo "scope: changed-path list is empty (change set could not be determined) — running the guard unscoped"
  fi
fi

# ---- which tags are visible ----------------------------------------------
# Two globs, two different jobs.
#
# LEGACY_TAGS is the fetch canary only. v0.0.1 … v0.3.3 are permanent repository
# state, so seeing none of them (and no rmpc-v* either) means the checkout is
# shallow/tagless and this guard cannot see its subject.
#
# RMPC_TAGS is the actual floor input: the namespace release-rmpc.yml owns.
# Prereleases (rmpc-vX.Y.Z-rc.N) DO match and DO count — release-rmpc.yml accepts
# them, so one can be published, and a published prerelease is a version an
# operator can be holding. See semver_sort below for the ordering they require.
LEGACY_TAGS="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' || true)"
RMPC_TAGS="$(git tag --list 'rmpc-v[0-9]*.[0-9]*.[0-9]*' || true)"

if [ -z "${LEGACY_TAGS}" ] && [ -z "${RMPC_TAGS}" ]; then
  echo "::error::assert_manifest_ahead_of_tags: no release tags visible in either namespace. This guard compares the manifest against published releases, so a tagless checkout cannot pass it. Fetch tags first: git fetch --depth=1 origin '+refs/tags/v*:refs/tags/v*' '+refs/tags/rmpc-v*:refs/tags/rmpc-v*'" >&2
  exit 2
fi

# semver_sort — `sort -V` with semver's PRERELEASE precedence.
#
# The tag glob above deliberately admits prereleases: release-rmpc.yml's
# `Validate inputs` accepts `rmpc-vX.Y.Z-rc.N`, so one can be published and a
# published prerelease is still a version an operator can be holding. But
# `sort -V` reads `-rc.1` as an extra version COMPONENT and therefore ranks
# `0.4.0-rc.1` AFTER `0.4.0` — the exact inverse of semver §11, which ranks
# a prerelease BEFORE its release. Left uncorrected, publishing rmpc-v0.4.0-rc.1
# makes it the newest release, and a manifest correctly sitting at 0.4.0 is then
# reported as "behind" it: every open rmpc PR goes red on a true statement's
# negation. (It fails safe — availability only, never a false green — but the
# guard would be wrong about the one ordering it exists to assert.)
#
# GNU sort gives `~` the "sorts before everything, including nothing at all"
# precedence semver assigns to a prerelease suffix, so the FIRST `-` (the
# suffix separator; any later `-` is inside the prerelease identifier and must
# not move) is swapped to `~` for the sort and swapped back after. Git refuses
# `~` in a ref name, so the round trip cannot collide with a real tag.
semver_sort() {
  sed 's/-/~/' | sort -V | sed 's/~/-/'
}

# Floor candidates: every published rmpc release version, plus the frozen
# summary of the retired shared namespace.
CANDIDATES="$(
  {
    printf '%s\n' "${LEGACY_CEILING}"
    printf '%s\n' "${RMPC_TAGS}" | sed 's/^rmpc-v//'
  } | grep -v '^$' || true
)"

LATEST_VERSION="$(printf '%s\n' "${CANDIDATES}" | semver_sort | tail -1)"

# Name the winner the way an operator would look it up.
if printf '%s\n' "${RMPC_TAGS}" | grep -qx "rmpc-v${LATEST_VERSION}"; then
  LATEST_TAG="rmpc-v${LATEST_VERSION}"
else
  LATEST_TAG="v${LATEST_VERSION} (final release of the retired shared v*.*.* namespace)"
fi

echo "manifest: ${MANIFEST_VERSION}  (${MANIFEST})"
echo "newest published rmpc release: ${LATEST_TAG}"

if [ "${MANIFEST_VERSION}" = "${LATEST_VERSION}" ]; then
  echo "::error::Version collision: ${MANIFEST} is pinned at ${MANIFEST_VERSION}, which rmpc release ${LATEST_TAG} already published. Every build from this branch would self-identify as that release, so an operator cannot tell a patched build from the shipped one — the exact harm issue #1191 describes. Bump 'version' to the next unreleased value (e.g. the patch above ${LATEST_VERSION}). Immediately after a release this is expected: release-rmpc.yml opens the bump PR itself — merge it, or see docs/development/releasing.md." >&2
  exit 1
fi

# semver_sort orders 1.9.0 < 1.10.0 correctly (a plain lexical sort does not)
# and 0.4.0-rc.1 < 0.4.0 correctly (a plain `sort -V` does not).
HIGHEST="$(printf '%s\n%s\n' "${MANIFEST_VERSION}" "${LATEST_VERSION}" | semver_sort | tail -1)"
if [ "${HIGHEST}" != "${MANIFEST_VERSION}" ]; then
  echo "::error::Version regression: ${MANIFEST} is at ${MANIFEST_VERSION}, BEHIND the newest published rmpc release ${LATEST_TAG}. Builds from this branch would claim to be an older release than one already distributed. Bump 'version' above ${LATEST_VERSION}; see issue #1191." >&2
  exit 1
fi

echo "OK: ${MANIFEST_VERSION} is strictly ahead of the newest published rmpc release ${LATEST_TAG}"
