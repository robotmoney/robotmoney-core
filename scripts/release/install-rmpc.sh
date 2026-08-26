#!/usr/bin/env bash
# install-rmpc.sh — the canonical, checksum-verified way to install a released
# `rmpc` binary. Core owns the release artifacts (.github/workflows/release-rmpc.yml
# publishes `<archive>.tar.gz` AND `<archive>.tar.gz.sha256`), so core owns the
# verification recipe too.
#
# Canonical: issue #1204 (an artifact fetched at runtime with no provenance check).
#
# WHY THIS SCRIPT EXISTS
# The onboarding instructions used to pipe the release tarball straight into tar
# (`curl -fsSL <url> | tar xz && install -m 755 rmpc ...`). That extracts and then
# installs bytes that were never checked against anything, and the very next thing
# a new operator does with the binary is generate a signing key. Piping into `tar`
# is also unfixable in place: by the time you could compare a checksum the archive
# has already been unpacked. So the order here is deliberate and load-bearing:
#
#   download archive -> download .sha256 -> VERIFY -> extract -> install
#
# A mismatch aborts at the VERIFY step. Nothing is extracted and nothing is
# installed, so a download that does not match the checksum cannot leave an
# executable on disk.
#
# WHAT THIS CHECK DOES AND DOES NOT PROVE
# Be precise about the trust root: the `.sha256` is fetched from the same release,
# the same host and the same TLS session as the archive, and nothing signs either
# one. So this DETECTS a corrupted, truncated or substituted download — a mirror,
# proxy or cache that serves different bytes than the release holds. It does NOT
# AUTHENTICATE the release itself: anyone able to write to the release (a leaked
# `contents: write` token, a compromised maintainer account, a malicious workflow
# run) publishes a matching `.sha256` beside a malicious archive and this script
# reports `verified`. Real provenance needs an out-of-band anchor — build
# attestation or a detached signature over the checksum with a committed public
# key — which this script does not yet have.
#
# WHY --base-url IS A FLAG
# It is the offline seam. scripts/release/install-rmpc-selftest.sh points it at a
# `file://` URL holding a locally built fixture archive, which lets CI execute this
# exact code path — including the corrupted-archive path — with no network. There
# is one implementation; the tests do not re-describe it.
#
# A non-`https://` base URL is refused unless --allow-insecure-base-url is given.
# BASE_URL is read from argv only, never the environment, so this is not an
# attacker-reachable downgrade — it is a copy-paste surface, and it matters
# because the very next line this script prints is "verified", which would
# otherwise vouch for bytes fetched in the clear. The selftest opts out
# explicitly; an operator has to mean it.
#
# USAGE
#   install-rmpc.sh --tag v0.3.1 --dest ~/.local/bin
#   install-rmpc.sh --tag v0.3.1 --dest ./bin --platform linux-amd64 \
#                   --base-url file:///tmp/fixture-releases --allow-insecure-base-url
#
# EXIT CODES
#   0  installed, checksum verified
#   2  usage error / missing prerequisite / non-https --base-url without the opt-out
#   3  download failed
#   4  CHECKSUM MISMATCH or missing checksum file — nothing extracted, nothing installed
#   5  extraction produced no rmpc binary

set -euo pipefail

DEFAULT_BASE_URL="https://github.com/robotmoney/robotmoney-core/releases/download"

TAG=""
DEST=""
PLATFORM=""
BASE_URL="$DEFAULT_BASE_URL"
ALLOW_INSECURE_BASE_URL=0

die() {
  echo "[install-rmpc] ERROR: $2" >&2
  exit "$1"
}

usage() {
  sed -n '/^# USAGE/,/^# EXIT CODES/p' "$0" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)      TAG="${2:-}"; shift 2 ;;
    --dest)     DEST="${2:-}"; shift 2 ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --allow-insecure-base-url) ALLOW_INSECURE_BASE_URL=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *)          usage; die 2 "unknown argument '$1'" ;;
  esac
done

[[ -n "$TAG"  ]] || { usage; die 2 "--tag is required (e.g. --tag v0.3.1)"; }
[[ -n "$DEST" ]] || { usage; die 2 "--dest is required (a directory on PATH)"; }

# Default-reject any base URL that is not https://. Printing "verified" over a
# plaintext fetch is the thing being prevented; the opt-out exists for the
# offline selftest's file:// fixtures and has to be typed out.
if [[ "$ALLOW_INSECURE_BASE_URL" -eq 0 && "$BASE_URL" != https://* ]]; then
  die 2 "--base-url '$BASE_URL' is not https:// — refusing an insecure download channel. Pass --allow-insecure-base-url if you really mean it (the offline selftest does)."
fi

command -v curl >/dev/null 2>&1 || die 2 "curl is required to download the release archive"
command -v tar  >/dev/null 2>&1 || die 2 "tar is required to unpack the release archive"

# sha256sum on Linux, shasum -a 256 on macOS. Refusing to run without one is the
# whole point of this script — never degrade to "install it unverified".
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CHECK=(sha256sum -c)
elif command -v shasum >/dev/null 2>&1; then
  SHA_CHECK=(shasum -a 256 -c)
else
  die 2 "neither sha256sum nor shasum is available — refusing to install rmpc unverified"
fi

if [[ -z "$PLATFORM" ]]; then
  OS=$(uname -s | tr '[:upper:]' '[:lower:]' | sed 's/darwin/macos/')
  ARCH=$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
  PLATFORM="${OS}-${ARCH}"
fi

ARCHIVE="rmpc-${TAG}-${PLATFORM}.tar.gz"
WORKDIR="$(mktemp -d -t install-rmpc.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "[install-rmpc] STEP download  ${BASE_URL}/${TAG}/${ARCHIVE}"
curl -fsSL -o "$WORKDIR/$ARCHIVE" "${BASE_URL}/${TAG}/${ARCHIVE}" \
  || die 3 "could not download ${BASE_URL}/${TAG}/${ARCHIVE}"

echo "[install-rmpc] STEP download  ${BASE_URL}/${TAG}/${ARCHIVE}.sha256"
curl -fsSL -o "$WORKDIR/$ARCHIVE.sha256" "${BASE_URL}/${TAG}/${ARCHIVE}.sha256" \
  || die 4 "no published checksum for ${ARCHIVE} — refusing to install an unverifiable binary"

echo "[install-rmpc] STEP verify    ${ARCHIVE}.sha256"
if ! (cd "$WORKDIR" && "${SHA_CHECK[@]}" "$ARCHIVE.sha256" >/dev/null 2>&1); then
  echo "[install-rmpc] expected: $(cut -d' ' -f1 < "$WORKDIR/$ARCHIVE.sha256")" >&2
  die 4 "ChecksumMismatch for ${ARCHIVE} — the download does not match its published sha256. Nothing was extracted and nothing was installed."
fi
echo "[install-rmpc] verified       ${ARCHIVE} matches its published sha256"

echo "[install-rmpc] STEP extract   ${ARCHIVE}"
tar xzf "$WORKDIR/$ARCHIVE" -C "$WORKDIR"
[[ -f "$WORKDIR/rmpc" ]] || die 5 "${ARCHIVE} did not contain an 'rmpc' binary"

mkdir -p "$DEST"
echo "[install-rmpc] STEP install   ${DEST}/rmpc"
install -m 755 "$WORKDIR/rmpc" "$DEST/rmpc"

echo "[install-rmpc] OK: installed verified rmpc ${TAG} (${PLATFORM}) to ${DEST}/rmpc"
