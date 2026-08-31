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
#   download archive -> download .sha256 -> VERIFY -> ATTEST -> extract -> install
#
# A mismatch aborts at the VERIFY step. Nothing is extracted and nothing is
# installed, so a download that does not match the checksum cannot leave an
# executable on disk. VERIFY also refuses a checksum file that does not COVER
# this archive: `sha256sum -c` verifies whichever filenames the file lists, so a
# hostile `.sha256` naming some other file would otherwise make any archive
# "verify". See the VERIFY block for the two guards and why both are there.
#
# TWO CONTROLS, TWO DIFFERENT TRUST ROOTS
# The checksum alone could never authenticate a release, because the `.sha256` is
# fetched from the same release, the same host and the same TLS session as the
# archive and nothing signs either one. Anyone able to write to the release
# publishes a matching `.sha256` beside a malicious archive, and a checksum-only
# installer prints `verified` over a trojan. That was issue #1236. So there are
# now two checks, and the second one is the one with an independent trust root:
#
#   1. CHECKSUM (#1204) — cheap, local, and the one that produces a legible
#      failure for the common cases: a truncated or corrupted download, and a
#      mirror/proxy/cache that serves bytes the release does not hold.
#   2. BUILD PROVENANCE (#1236) — `gh attestation verify` against a Sigstore
#      attestation minted by GitHub Actions with an OIDC workflow identity.
#      Minting one requires an `id-token: write` Actions run in this repository;
#      it CANNOT be produced by anyone who merely holds `contents: write` on the
#      release. That is what makes it out-of-band with respect to the release
#      assets, which is the whole point.
#
# WHAT PROVENANCE DOES AND DOES NOT PROVE — read this before quoting it
# It DOES defeat: a leaked release-write token, a stolen `GITHUB_TOKEN`, a
# compromised maintainer account used only to edit release assets, and a
# tampering mirror/proxy/CDN. None of those can produce a Sigstore certificate
# naming `.github/workflows/release-rmpc.yml` in this repository.
#
# It does NOT prove the code was reviewed. Provenance answers "this archive came
# out of THAT workflow in THIS repository", not "the commit it was built from was
# any good". An attacker who can push a ref to this repository can push a tag,
# trigger the release workflow, and receive a perfectly genuine attestation for
# whatever that ref contains. Closing that requires branch/tag protection and
# review on `.github/workflows/release-rmpc.yml` — repository settings, not
# anything this script can assert. Do not read `attested` as `reviewed`.
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
#   install-rmpc.sh --tag rmpc-v0.4.0 --dest ~/.local/bin
#   install-rmpc.sh --tag rmpc-v0.4.0 --dest ./bin --platform linux-amd64 \
#                   --base-url file:///tmp/fixture-releases --allow-insecure-base-url
#
# EXIT CODES
#   0  installed: checksum verified AND build provenance attested
#   2  usage error / missing prerequisite / non-https --base-url without the opt-out.
#      A missing `gh` lands here, alongside a missing sha256sum: both are hard
#      refusals, never a downgrade to "install it unverified".
#   3  download failed
#   4  NOT VERIFIED — checksum mismatch, missing checksum file, a checksum file
#      that does not cover this archive, or a digest tool that failed to run.
#      Nothing extracted, nothing installed.
#   5  extraction produced no rmpc binary
#   6  NOT ATTESTED — no Sigstore build-provenance attestation for this archive
#      that verifies against this repository and its release workflow. The bytes
#      match a checksum published beside them, and that is exactly the property
#      an attacker with release-write can forge, so this is a refusal.
#      Nothing extracted, nothing installed.

set -euo pipefail

DEFAULT_BASE_URL="https://github.com/robotmoney/robotmoney-core/releases/download"

# The provenance identity, pinned here rather than passed in. These are the two
# halves of "who is allowed to vouch for an rmpc archive": the repository the
# attestation is looked up against, and the workflow whose OIDC identity must
# appear in the Sigstore certificate. --repo alone would accept an attestation
# minted by ANY workflow in this repository, so --signer-workflow is not
# optional decoration. Neither value is reachable from argv or the environment:
# a trust anchor a caller can retarget is not a trust anchor.
ATTEST_REPO="robotmoney/robotmoney-core"
ATTEST_SIGNER_WORKFLOW="robotmoney/robotmoney-core/.github/workflows/release-rmpc.yml"

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

[[ -n "$TAG"  ]] || { usage; die 2 "--tag is required (e.g. --tag rmpc-v0.4.0; releases up to v0.3.3 used the bare vX.Y.Z form)"; }
[[ -n "$DEST" ]] || { usage; die 2 "--dest is required (a directory on PATH)"; }

# Default-reject any base URL that is not https://. Printing "verified" over a
# plaintext fetch is the thing being prevented; the opt-out exists for the
# offline selftest's file:// fixtures and has to be typed out.
if [[ "$ALLOW_INSECURE_BASE_URL" -eq 0 && "$BASE_URL" != https://* ]]; then
  die 2 "--base-url '$BASE_URL' is not https:// — refusing an insecure download channel. Pass --allow-insecure-base-url if you really mean it (the offline selftest does)."
fi

command -v curl >/dev/null 2>&1 || die 2 "curl is required to download the release archive"
command -v tar  >/dev/null 2>&1 || die 2 "tar is required to unpack the release archive"

# `gh` is a HARD prerequisite, checked here — before anything is downloaded —
# rather than at the attest step, so an operator who does not have it learns
# that in the first second instead of after a multi-megabyte fetch. Refusing is
# the only correct behaviour: the alternative is a script that quietly installs
# a binary whose provenance it could not check, which is the pre-#1236 state
# this script exists to leave behind. `gh attestation verify` needs GitHub API
# reach (and therefore, on a rate-limited network, `gh auth login` or GH_TOKEN);
# it arrived in gh 2.49.
command -v gh   >/dev/null 2>&1 || die 2 "gh (GitHub CLI, >= 2.49) is required to verify this archive's build-provenance attestation — refusing to install rmpc unattested. Install it from https://cli.github.com and re-run."

# sha256sum on Linux, shasum -a 256 on macOS. Refusing to run without one is the
# whole point of this script — never degrade to "install it unverified".
# Note these are the DIGEST forms, not the `-c` check forms: see the VERIFY
# section below for why this script never lets the checksum file pick its own
# subject.
if command -v sha256sum >/dev/null 2>&1; then
  SHA_DIGEST=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA_DIGEST=(shasum -a 256)
else
  die 2 "neither sha256sum nor shasum is available — refusing to install rmpc unverified"
fi

if [[ -z "$PLATFORM" ]]; then
  OS=$(uname -s | tr '[:upper:]' '[:lower:]' | sed 's/darwin/macos/')
  ARCH=$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
  PLATFORM="${OS}-${ARCH}"
fi

# rmpc releases are tagged `rmpc-vX.Y.Z` (issue #1243) but the archive inside is
# named `rmpc-vX.Y.Z-<platform>.tar.gz` — one `rmpc-`, not two. The release
# workflow's packaging step applies the identical strip, so this handles both the
# current namespace and the legacy `vX.Y.Z` tags (v0.0.1 … v0.3.3), where the
# strip is a no-op. The DIRECTORY in the URL is always the full tag.
ARCHIVE="rmpc-${TAG#rmpc-}-${PLATFORM}.tar.gz"
WORKDIR="$(mktemp -d -t install-rmpc.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

# CURL_NET — bounded, retried fetches. Without a timeout a half-open connection
# to the release CDN leaves the documented BOOTSTRAP.md install hanging on
# "STEP download" forever instead of failing with exit 3, and an operator cannot
# tell a stall from a slow download. --retry covers the transient case so the
# bound does not turn a blip into a failed install.
CURL_NET=(--connect-timeout 15 --max-time 300 --retry 3 --retry-connrefused)

echo "[install-rmpc] STEP download  ${BASE_URL}/${TAG}/${ARCHIVE}"
curl -fsSL "${CURL_NET[@]}" -o "$WORKDIR/$ARCHIVE" "${BASE_URL}/${TAG}/${ARCHIVE}" \
  || die 3 "could not download ${BASE_URL}/${TAG}/${ARCHIVE}"

echo "[install-rmpc] STEP download  ${BASE_URL}/${TAG}/${ARCHIVE}.sha256"
curl -fsSL "${CURL_NET[@]}" -o "$WORKDIR/$ARCHIVE.sha256" "${BASE_URL}/${TAG}/${ARCHIVE}.sha256" \
  || die 4 "no published checksum for ${ARCHIVE} — refusing to install an unverifiable binary"

# VERIFY — the downloaded .sha256 is DATA, never an instruction.
#
# `sha256sum -c FILE` / `shasum -a 256 -c FILE` verify whichever filenames the
# checksum file happens to list, and exit 0 once all of those lines match. The
# file therefore chooses its own subject. An attacker who serves the download —
# the mirror/proxy/cache/CDN this script claims to detect — publishes a malicious
# archive next to a one-line `.sha256` holding the well-known digest of the empty
# file and naming `/dev/null`. `-c` reports OK, and this script would print
# "verified" over a trojan. That was reproduced against this installer.
#
# So two guards, in this order:
#   1. SHAPE + COVERAGE — exactly one line, and that line must name ${ARCHIVE}.
#      A checksum file that does not cover this archive is refused outright, with
#      a message that says so rather than a misleading "mismatch".
#   2. DIGEST — the archive is hashed HERE and compared with that line's digest.
#      The subject of the comparison is chosen by this script, so even a shape
#      that slipped past guard 1 cannot redirect the check at another file.
# Guard 2 is what makes the property hold; guard 1 is what makes the refusal
# legible. Neither is load-bearing on the other.
echo "[install-rmpc] STEP verify    ${ARCHIVE}.sha256"

# `wc -l` pads its output on macOS, so strip whitespace before it lands in the
# error message.
SHA_LINES=$(wc -l < "$WORKDIR/$ARCHIVE.sha256" | tr -d "[:space:]")
if [[ "$SHA_LINES" -ne 1 ]]; then
  die 4 "published checksum file for ${ARCHIVE} holds ${SHA_LINES} lines, expected exactly 1 — refusing. Nothing was extracted and nothing was installed."
fi

if ! grep -Eq "^[0-9a-f]{64} [ *]${ARCHIVE//./\\.}\$" "$WORKDIR/$ARCHIVE.sha256"; then
  # The rejected file is attacker-supplied, so scrub non-printables before
  # echoing it — a checksum file must never be able to write escape sequences
  # to an operator's terminal.
  echo "[install-rmpc] published:  $(head -c 200 "$WORKDIR/$ARCHIVE.sha256" | tr -c "[:print:]" "?")" >&2
  die 4 "published checksum file does not name ${ARCHIVE} — refusing to accept a checksum for some other file. Nothing was extracted and nothing was installed."
fi

EXPECTED_SHA=$(cut -d' ' -f1 < "$WORKDIR/$ARCHIVE.sha256")

# A digest tool that FAILS is not a mismatch, and must not exit with an
# undocumented bare 1. It cannot false-verify — guard 1 above forces
# EXPECTED_SHA to be 64 hex characters, so an empty or truncated ACTUAL_SHA can
# only ever compare unequal — but a wrapper routing on this script's exit codes
# deserves one of the documented ones, and the operator deserves a line saying
# the hash never ran.
if ! ACTUAL_SHA=$( (cd "$WORKDIR" && "${SHA_DIGEST[@]}" "$ARCHIVE") | cut -d' ' -f1 ); then
  die 4 "could not compute the sha256 of ${ARCHIVE} — ${SHA_DIGEST[*]} failed, so the download is unverified. Nothing was extracted and nothing was installed."
fi
if [[ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
  echo "[install-rmpc] expected: $EXPECTED_SHA" >&2
  echo "[install-rmpc] actual:   $ACTUAL_SHA" >&2
  die 4 "ChecksumMismatch for ${ARCHIVE} — the download does not match its published sha256. Nothing was extracted and nothing was installed."
fi
echo "[install-rmpc] verified       ${ARCHIVE} matches its published sha256"

# ATTEST — the out-of-band trust anchor (issue #1236).
#
# Everything above this line shares a trust root with the archive: the `.sha256`
# came from the same release, over the same connection, and whoever can write
# that release can write both. This step does not. `gh attestation verify` looks
# up a Sigstore bundle by the archive's DIGEST and checks the signing
# certificate's OIDC identity, which GitHub's Fulcio instance issues to an
# Actions run and nothing else. To forge it you need an `id-token: write` run in
# this repository, not merely the ability to upload a release asset.
#
# --repo pins the repository the attestation must be linked to; without
# --signer-workflow, any workflow in that repository could vouch for the archive,
# so the release workflow's path is pinned too. --deny-self-hosted-runners
# rejects an attestation minted on a runner this project does not use — every
# entry in release-rmpc.yml's build matrix is GitHub-hosted.
#
# This runs AFTER the checksum, not instead of it: the checksum is what turns a
# truncated download into a one-line local failure, and it is the control that
# still works when GitHub's attestation API is unreachable. It runs BEFORE
# extract for the same reason the checksum does — an archive that fails here has
# never been unpacked, so nothing it contains has touched the disk outside the
# temporary directory this script removes on exit.
echo "[install-rmpc] STEP attest    ${ARCHIVE}"
if ! ATTEST_OUT=$(gh attestation verify "$WORKDIR/$ARCHIVE" \
      --repo "$ATTEST_REPO" \
      --signer-workflow "$ATTEST_SIGNER_WORKFLOW" \
      --deny-self-hosted-runners 2>&1); then
  # gh's diagnostic quotes attacker-influenced material (certificate fields from
  # whatever bundle it found), so scrub non-printables the same way the rejected
  # checksum file is scrubbed before it reaches an operator's terminal.
  printf '%s\n' "$ATTEST_OUT" | tr -c "[:print:]\n" "?" >&2
  die 6 "NotAttested: ${ARCHIVE} has no build-provenance attestation that verifies against ${ATTEST_REPO} and ${ATTEST_SIGNER_WORKFLOW}. A matching sha256 proves only that the archive matches a checksum published beside it, which anyone who can write the release can also do — so this is a refusal, not a warning. If gh reported an auth or rate-limit problem, run 'gh auth login' and retry; if this release predates #1236 it has no attestation at all and cannot be installed by this script. Nothing was extracted and nothing was installed."
fi
echo "[install-rmpc] attested      ${ARCHIVE} was built by ${ATTEST_SIGNER_WORKFLOW}"

echo "[install-rmpc] STEP extract   ${ARCHIVE}"
tar xzf "$WORKDIR/$ARCHIVE" -C "$WORKDIR"
[[ -f "$WORKDIR/rmpc" ]] || die 5 "${ARCHIVE} did not contain an 'rmpc' binary"

mkdir -p "$DEST"
echo "[install-rmpc] STEP install   ${DEST}/rmpc"
install -m 755 "$WORKDIR/rmpc" "$DEST/rmpc"

echo "[install-rmpc] OK: installed verified, attested rmpc ${TAG} (${PLATFORM}) to ${DEST}/rmpc"
