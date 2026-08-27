#!/usr/bin/env bash
# Rewrite the rmpc crate manifest to the next unreleased version after a release.
#
# Canonical: .github/workflows/release-rmpc.yml (job `bump-manifest`)
# Issues: #1191 (why the manifest may not sit on a published version), #1243
#         (why the release itself has to fix the state it creates)
#
# WHY THIS EXISTS
# release-rmpc.yml's `verify-version` requires manifest == tag. The PR guard
# .github/scripts/assert_manifest_ahead_of_tags.sh requires manifest > newest
# published release. Both are right, and together they mean that publishing a
# release leaves `dev` in the state the PR guard rejects — BY CONSTRUCTION, every
# single time. Somebody has to bump the manifest immediately afterwards, and
# "somebody has to remember" is what issue #1243 was filed about.
#
# WHY IT IS A SCRIPT AND NOT A `run:` BLOCK
# It is the only part of the release path with real logic in it — prerelease
# supersession, patch arithmetic that must not go lexical, and an in-place
# manifest rewrite that must not touch `version = ` keys under [dependencies].
# release-rmpc.yml fires only on a tag, so a `run:` block here would first
# execute during an actual release, on `dev`, with `contents: write`. As a script
# it is driven on every PR by .github/scripts/tests/test_bump_rmpc_manifest.sh.
#
# USAGE
#   bump_rmpc_manifest.sh <released-version> [manifest-path]
# <released-version> accepts the release tag in any of its shapes: rmpc-v0.4.0,
# v0.4.0 or 0.4.0. Manifest defaults to clients/rust-payment-client/Cargo.toml.
#
# EXIT CODES
#   0  manifest rewritten; `next=<version>` printed on stdout
#   3  nothing to do — the manifest is not sitting on the released version, so
#      this branch is not in the post-release collision state. Not an error: a
#      release cut from an older commit, or a re-run after the bump already
#      merged, both land here.
#   2  usage error, missing manifest, or an unreadable [package] version

set -euo pipefail

RELEASED_RAW="${1:-}"
MANIFEST="${2:-clients/rust-payment-client/Cargo.toml}"

if [ -z "${RELEASED_RAW}" ]; then
  echo "::error::bump_rmpc_manifest: <released-version> is required (e.g. rmpc-v0.4.0)" >&2
  exit 2
fi

# rmpc-v0.4.0 -> v0.4.0 -> 0.4.0. Prefix-only strips, so a bare 0.4.0 is a no-op.
RELEASED="${RELEASED_RAW#rmpc-}"
RELEASED="${RELEASED#v}"

if ! printf '%s' "${RELEASED}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "::error::bump_rmpc_manifest: '${RELEASED_RAW}' is not a release version (expected rmpc-vX.Y.Z, vX.Y.Z or X.Y.Z, optionally with a prerelease suffix)" >&2
  exit 2
fi

if [ ! -f "${MANIFEST}" ]; then
  echo "::error::bump_rmpc_manifest: manifest not found at ${MANIFEST}" >&2
  exit 2
fi

read_package_version() {
  awk '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{
         gsub(/^version[[:space:]]*=[[:space:]]*"/,""); gsub(/".*$/,""); print; exit }' "$1"
}

CURRENT="$(read_package_version "${MANIFEST}")"

if [ -z "${CURRENT}" ]; then
  echo "::error::bump_rmpc_manifest: could not read [package] version from ${MANIFEST}" >&2
  exit 2
fi

if [ "${CURRENT}" != "${RELEASED}" ]; then
  echo "manifest is ${CURRENT}, not the just-released ${RELEASED} — not the post-release collision state, nothing to bump"
  exit 3
fi

# A prerelease is superseded by its own final release (semver §11), so
# 0.4.0-rc.1 bumps to 0.4.0, not to 0.4.0-rc.2 and not to 0.4.1.
# Otherwise: patch + 1, computed arithmetically. `0.9.9` must become `0.9.10`,
# which any string-level increment gets wrong.
case "${RELEASED}" in
  *-*)
    NEXT="${RELEASED%%-*}"
    ;;
  *)
    NEXT="$(printf '%s\n' "${RELEASED}" | awk -F. '{print $1"."$2"."$3+1}')"
    ;;
esac

# Rewrite ONLY the [package] version. `version = ` also appears as a dependency
# key (`version = "9.9.9"` under [dependencies]), so a blunt sed corrupts the
# manifest while still looking like it worked.
awk -v next_version="${NEXT}" '
  /^\[package\]/ { p = 1; print; next }
  /^\[/          { p = 0 }
  p && !done && /^version[[:space:]]*=/ {
    print "version = \"" next_version "\""; done = 1; next
  }
  { print }
' "${MANIFEST}" > "${MANIFEST}.bump.tmp"

VERIFY="$(read_package_version "${MANIFEST}.bump.tmp")"
if [ "${VERIFY}" != "${NEXT}" ]; then
  rm -f "${MANIFEST}.bump.tmp"
  echo "::error::bump_rmpc_manifest: rewrite did not take — ${MANIFEST} would still read '${VERIFY}' instead of '${NEXT}'" >&2
  exit 2
fi

mv "${MANIFEST}.bump.tmp" "${MANIFEST}"

echo "bumped ${MANIFEST}: ${CURRENT} -> ${NEXT} (after release ${RELEASED_RAW})"
echo "next=${NEXT}"
