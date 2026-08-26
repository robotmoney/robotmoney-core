#!/usr/bin/env bash
# Assert the rmpc manifest version is STRICTLY AHEAD of every published release tag.
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
# USAGE
#   assert_manifest_ahead_of_tags.sh [manifest-path]
# Defaults to clients/rust-payment-client/Cargo.toml relative to the repo root.
#
# REQUIREMENTS
# Release tags must be present locally. CI checkouts are shallow and tagless by
# default, so fetch them first:
#   git fetch --depth=1 origin '+refs/tags/v*:refs/tags/v*'
# A tagless checkout is treated as a hard error, not a pass — a guard that
# silently succeeds when it cannot see its subject is the false green this
# repository's test-coverage policy exists to prevent.
#
# Reference: skills/_shared/test-coverage-policy.md (invariant 2: Exit 0 != tested).

set -euo pipefail

MANIFEST="${1:-clients/rust-payment-client/Cargo.toml}"

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

# Only vX.Y.Z tags are release tags; anything else (dryrun-*, feature markers)
# is not a published version and must not raise the floor. Prereleases
# (vX.Y.Z-rc.N) DO match and DO count: release-rmpc.yml accepts them, so one can
# be published, and a published prerelease is a version an operator can be
# holding. See semver_sort below for the ordering they require.
TAGS="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' || true)"

if [ -z "${TAGS}" ]; then
  echo "::error::assert_manifest_ahead_of_tags: no v*.*.* tags visible. This guard compares the manifest against published releases, so a tagless checkout cannot pass it. Fetch tags first: git fetch --depth=1 origin '+refs/tags/v*:refs/tags/v*'" >&2
  exit 2
fi

# semver_sort — `sort -V` with semver's PRERELEASE precedence.
#
# The tag glob above deliberately admits prereleases: release-rmpc.yml's
# `Validate inputs` accepts `vX.Y.Z-rc.N`, so one can be published and a
# published prerelease is still a version an operator can be holding. But
# `sort -V` reads `-rc.1` as an extra version COMPONENT and therefore ranks
# `v0.4.0-rc.1` AFTER `v0.4.0` — the exact inverse of semver §11, which ranks
# a prerelease BEFORE its release. Left uncorrected, publishing v0.4.0-rc.1
# makes it LATEST_TAG, and a manifest correctly sitting at 0.4.0 is then
# reported as "behind" it: every open PR to dev goes red on a true statement's
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

LATEST_TAG="$(printf '%s\n' "${TAGS}" | semver_sort | tail -1)"
LATEST_VERSION="${LATEST_TAG#v}"

echo "manifest: ${MANIFEST_VERSION}  (${MANIFEST})"
echo "newest published release tag: ${LATEST_TAG}"

if [ "${MANIFEST_VERSION}" = "${LATEST_VERSION}" ]; then
  echo "::error::Version collision: ${MANIFEST} is pinned at ${MANIFEST_VERSION}, which release ${LATEST_TAG} already published. Every build from this branch would self-identify as that release, so an operator cannot tell a patched build from the shipped one — the exact harm issue #1191 describes. Bump 'version' to the next unreleased value (e.g. the patch above ${LATEST_VERSION})." >&2
  exit 1
fi

# semver_sort orders 1.9.0 < 1.10.0 correctly (a plain lexical sort does not)
# and 0.4.0-rc.1 < 0.4.0 correctly (a plain `sort -V` does not).
HIGHEST="$(printf '%s\n%s\n' "${MANIFEST_VERSION}" "${LATEST_VERSION}" | semver_sort | tail -1)"
if [ "${HIGHEST}" != "${MANIFEST_VERSION}" ]; then
  echo "::error::Version regression: ${MANIFEST} is at ${MANIFEST_VERSION}, BEHIND the newest published release ${LATEST_TAG}. Builds from this branch would claim to be an older release than one already distributed. Bump 'version' above ${LATEST_VERSION}; see issue #1191." >&2
  exit 1
fi

echo "OK: ${MANIFEST_VERSION} is strictly ahead of the newest published release ${LATEST_TAG}"
