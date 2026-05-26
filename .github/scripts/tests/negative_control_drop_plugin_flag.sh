#!/usr/bin/env bash
# Canonical: docs/testing/headless-opencode-tests.md (issue #461).
#
# Negative control: prove the workflow-lint one-liner from issue #461
# catches a regression where someone drops --plugin "$PWD/plugins/robotmoney-cli"
# from a future edit of suite-11b-opencode-headless.yml.
#
# The script:
#   1. Copies the workflow file to a tempdir.
#   2. Strips every occurrence of --plugin "$PWD/plugins/robotmoney-cli".
#   3. Re-runs the lint one-liner against the mutated copy.
#   4. Exits 0 iff the lint step FAILED on the mutated copy (i.e. the
#      regression was caught). Exits non-zero if the lint passes despite
#      the flag being stripped — that would mean the lint is broken.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORKFLOW="${REPO_ROOT}/.github/workflows/suite-11b-opencode-headless.yml"

if [ ! -f "$WORKFLOW" ]; then
  echo "FAIL: workflow file not found: $WORKFLOW" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
MUTATED="${TMPDIR}/workflow.yml"

# Strip --plugin "$PWD/plugins/robotmoney-cli" from every line.
# Use a fixed-string sed (with escaped $) so the substitution is exact.
sed 's| --plugin "\$PWD/plugins/robotmoney-cli"||g' "$WORKFLOW" > "$MUTATED"

# Sanity: confirm the mutation actually changed the file.
if cmp -s "$WORKFLOW" "$MUTATED"; then
  echo "FAIL: sed did not modify the workflow — pattern did not match." >&2
  exit 1
fi

# Re-run the AC lint check on the mutated copy.
count="$(grep -c -F -- '--plugin "$PWD/plugins/robotmoney-cli"' "$MUTATED" || true)"

if [ "$count" -ge 2 ]; then
  echo "FAIL: lint did NOT catch the regression — mutated workflow still" \
       "reported $count occurrences of the plugin flag." >&2
  exit 1
fi

echo "OK: stripping --plugin from the workflow drops the count to $count," \
     "below the required >= 2 threshold. Lint catches the regression."
