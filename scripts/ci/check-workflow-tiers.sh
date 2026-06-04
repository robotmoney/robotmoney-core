#!/usr/bin/env bash
# Canonical: docs/development/ci-suites.md (CI velocity tier model)
#
# Static validator for the issue #600 CI velocity invariants. Thin wrapper around
# scripts/ci/check_workflow_tiers.py so the gate can be invoked by name from a
# workflow and run locally with one command. Ensures PyYAML is importable, then
# delegates. Exits 0 when every invariant holds, nonzero on the first violation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if ! python3 -c "import yaml" >/dev/null 2>&1; then
  echo "check-workflow-tiers: installing PyYAML (not present)..." >&2
  python3 -m pip install --quiet --disable-pip-version-check pyyaml >&2
fi

exec python3 "${REPO_ROOT}/scripts/ci/check_workflow_tiers.py" "$@"
