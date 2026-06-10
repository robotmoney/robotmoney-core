#!/usr/bin/env bash
# Canonical: docs/technical/security-model.md §13 "Release signing" (issue #659)
#
# Static lint for the release signing + provenance invariants. A one-line YAML
# edit can silently turn a signed release back into an unsigned one; this
# guard makes that edit fail the QUICK CI tier instead.
#
#   1. No release workflow creates an unsigned git tag: every `git tag`
#      creation uses `-s` (signed annotated), and a `git tag -v` verification
#      runs before any tag push.
#   2. release-dapp.yml invokes docker/build-push-action with
#      `provenance: true` and `sbom: true`, and pushes via skopeo so the
#      attestation manifests survive (no `docker load` of the release image).
#   3. release-dapp.yml signs the pushed image digest (`cosign sign`), attaches
#      a SLSA provenance attestation (`cosign attest --type slsaprovenance`),
#      and verifies both fail-closed (`cosign verify`,
#      `cosign verify-attestation`).
#   4. release-rmpc.yml signs every release archive (`cosign sign-blob`),
#      verifies the bundles (`cosign verify-blob`) BEFORE the GitHub Release is
#      created, and uploads the `.sigstore.json` bundles as Release assets.
#   5. Keyless OIDC only: `id-token: write` is present in both workflows at
#      job level, and the workflow-level permissions block stays read-only —
#      no long-lived signing key, no workflow-global write scope.
#
# Run locally:  bash scripts/ci/check-release-signing.sh
# Run in CI:    .github/workflows/suite-17-ci-velocity-guard.yml (release-signing job)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DAPP_WF="${REPO_ROOT}/.github/workflows/release-dapp.yml"
RMPC_WF="${REPO_ROOT}/.github/workflows/release-rmpc.yml"

failures=0

fail() {
  echo "FAIL $1: $2" >&2
  failures=$((failures + 1))
}

require() {
  # require <file> <grep -E pattern> <message>
  local wf="$1" pattern="$2" message="$3"
  local rel="${wf#"${REPO_ROOT}"/}"
  if ! grep -qE -- "${pattern}" "${wf}"; then
    fail "${rel}" "${message} (expected pattern: ${pattern})"
  fi
}

first_line_of() {
  # first_line_of <file> <grep -E pattern> -> line number or empty
  grep -nE -- "$2" "$1" | head -n1 | cut -d: -f1
}

for wf in "${DAPP_WF}" "${RMPC_WF}"; do
  rel="${wf#"${REPO_ROOT}"/}"

  if [ ! -f "${wf}" ]; then
    fail "${rel}" "release workflow not found"
    continue
  fi

  # --- Invariant 1: signed annotated tags only, verified before push -------
  # Any `git tag <name>` creation that is not `git tag -s` is an unsigned tag.
  if unsigned_tag=$(grep -nE 'git tag "' "${wf}"); then
    fail "${rel}" "unsigned 'git tag' creation found — release tags must be created with 'git tag -s' (signed annotated):"
    echo "  ${unsigned_tag}" >&2
  fi
  require "${wf}" 'git tag -s' "no signed tag creation ('git tag -s') found"
  require "${wf}" 'git tag -v' "no in-workflow tag verification ('git tag -v') found"
  # The tag-push event path must reject lightweight/unsigned tags fail-closed.
  require "${wf}" 'BEGIN \(PGP SIGNATURE\|SSH SIGNATURE\|SIGNED MESSAGE\)' \
    "no pushed-tag signature presence check found (tag-push releases must fail closed on unsigned tags)"

  # --- Invariant 5: keyless OIDC, job-scoped write permissions --------------
  require "${wf}" '^[[:space:]]+id-token: write$' \
    "no job-level 'id-token: write' grant found (keyless Sigstore signing requires the Actions OIDC token)"
  # Workflow-level permissions block (column-0 'permissions:' up to the next
  # column-0 key) must not contain any write scope.
  toplevel_perms=$(awk '/^permissions:/{inblock=1; next} inblock && /^[^[:space:]#]/{inblock=0} inblock{print}' "${wf}")
  if printf '%s\n' "${toplevel_perms}" | grep -q 'write'; then
    fail "${rel}" "workflow-level permissions block grants a write scope — write permissions must stay job-local (issues #660/#659)"
  fi
done

# --- Invariant 2: dapp image built with provenance + SBOM, pushed losslessly -
require "${DAPP_WF}" '^[[:space:]]+provenance: true$' "docker/build-push-action must set 'provenance: true'"
require "${DAPP_WF}" '^[[:space:]]+sbom: true$' "docker/build-push-action must set 'sbom: true'"
require "${DAPP_WF}" 'outputs: type=oci' "release image must be exported as an OCI archive (docker-archive drops attestation manifests)"
require "${DAPP_WF}" 'skopeo copy --all --preserve-digests' "release image must be pushed with 'skopeo copy --all --preserve-digests'"
if grep -vE '^[[:space:]]*#' "${DAPP_WF}" | grep -qE 'docker load'; then
  fail ".github/workflows/release-dapp.yml" "'docker load' found — loading the OCI archive drops the provenance/SBOM attestation manifests"
fi

# --- Invariant 3: dapp image signed + attested + verified fail-closed --------
require "${DAPP_WF}" 'cosign sign --yes' "pushed image digest must be signed with 'cosign sign'"
require "${DAPP_WF}" 'cosign attest --yes --type slsaprovenance' "SLSA provenance must be attached with 'cosign attest --type slsaprovenance'"
require "${DAPP_WF}" 'cosign verify ' "image signature must be verified in-workflow ('cosign verify')"
require "${DAPP_WF}" 'cosign verify-attestation --type slsaprovenance' "provenance attestation must be verified in-workflow ('cosign verify-attestation')"

# --- Invariant 4: rmpc archives signed + verified before Release creation ----
require "${RMPC_WF}" 'cosign sign-blob --yes --bundle' "every release archive must be signed with 'cosign sign-blob --bundle'"
require "${RMPC_WF}" 'cosign verify-blob' "archive bundles must be verified in-workflow ('cosign verify-blob')"
require "${RMPC_WF}" 'artifacts/\*\.tar\.gz\.sigstore\.json' "the .sigstore.json bundles must be uploaded as Release assets"

verify_line=$(first_line_of "${RMPC_WF}" 'cosign verify-blob')
release_line=$(first_line_of "${RMPC_WF}" 'softprops/action-gh-release')
if [ -n "${verify_line}" ] && [ -n "${release_line}" ] && [ "${verify_line}" -ge "${release_line}" ]; then
  fail ".github/workflows/release-rmpc.yml" "'cosign verify-blob' (line ${verify_line}) must run BEFORE the GitHub Release is created (line ${release_line})"
fi

if [ "${failures}" -gt 0 ]; then
  echo "check-release-signing: ${failures} violation(s). See docs/technical/security-model.md §13 'Release signing'." >&2
  exit 1
fi

echo "OK: release workflows sign tags, sign/attest artifacts keyless, and verify fail-closed before publishing."
