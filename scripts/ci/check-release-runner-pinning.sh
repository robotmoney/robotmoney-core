#!/usr/bin/env bash
# Canonical: docs/technical/ci-environments.md (issue #660; security-model.md §13)
#
# Static lint for the release-workflow hardening invariants:
#
#   1. No job in .github/workflows/release-*.yml runs on a floating `*-latest`
#      runner alias (ubuntu-latest, macos-latest, windows-latest). Release jobs
#      must use a version-pinned GitHub-hosted label (e.g. ubuntu-24.04,
#      macos-15) or a self-hosted label. Both plain `runs-on:` values and
#      matrix `runner:` values are covered.
#
#   2. Every release workflow declares `environment: production` at least once,
#      so the publish/release job is gated behind GitHub's protected-environment
#      required-reviewer approval before any external write.
#
# Run locally:  bash scripts/ci/check-release-runner-pinning.sh
# Run in CI:    .github/workflows/suite-17-ci-velocity-guard.yml (release-runner-pinning job)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

shopt -s nullglob
release_workflows=("${REPO_ROOT}"/.github/workflows/release-*.yml)
shopt -u nullglob

if [ "${#release_workflows[@]}" -eq 0 ]; then
  echo "check-release-runner-pinning: ERROR — no .github/workflows/release-*.yml files found." >&2
  exit 1
fi

failures=0

for wf in "${release_workflows[@]}"; do
  rel="${wf#"${REPO_ROOT}"/}"

  # Invariant 1: no floating *-latest runner label on runs-on: or matrix runner: lines.
  if unpinned=$(grep -nE '^[[:space:]]*(runs-on|runner):[[:space:]].*-latest' "${wf}"); then
    echo "FAIL ${rel}: unpinned '*-latest' runner label(s) found — pin to a versioned label (e.g. ubuntu-24.04, macos-15) or a self-hosted label:" >&2
    echo "${unpinned//$'\n'/$'\n'  }" >&2
    failures=$((failures + 1))
  fi

  # Invariant 2: the workflow declares the protected production environment.
  if ! grep -qE '^[[:space:]]*environment:[[:space:]]*production[[:space:]]*$' "${wf}"; then
    echo "FAIL ${rel}: no job declares 'environment: production' — the publish/release job must be gated behind the protected environment (issue #660)." >&2
    failures=$((failures + 1))
  fi
done

if [ "${failures}" -gt 0 ]; then
  echo "check-release-runner-pinning: ${failures} violation(s). See docs/technical/ci-environments.md." >&2
  exit 1
fi

echo "OK: ${#release_workflows[@]} release workflow(s) use pinned runners and declare the production environment."
