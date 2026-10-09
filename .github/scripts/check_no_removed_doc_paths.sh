#!/usr/bin/env bash
# Guard: the retired sprint plan and scout notes must stay deleted.
#
# Canonical: docs/development/ci-suites.md (suite 13, doc-validators)
# Issue: #1556
#
# The live plan is the GitHub release, phase and feature issues. docs/sprint/
# and docs/scout/ described a plan nobody follows. This guard fails when they
# return or when a tracked file links to them. Run from any directory. Set
# CHECK_REPO_ROOT to point at a synthetic tree (used by the self-test).
set -euo pipefail

ROOT="${CHECK_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

PATTERN='docs/sprint|docs/scout|week-sprint|azimuth-az-0623-contract-remediation-scout|azimuth-client-hardening-seam|code-review-snapshot-consolidation|contract-security-remediation-scout|documentation-completeness-scout|ic-gateway-seam'
GUIDE="docs/testing/base-testnet-guide.md"
fail=0

if [[ -e docs/sprint || -e docs/scout ]]; then
  echo "FAIL: docs/sprint or docs/scout exists" >&2
  fail=1
fi

if [[ ! -f "$GUIDE" ]]; then
  echo "FAIL: $GUIDE is missing" >&2
  fail=1
fi

for f in testing/fork-e2e-rust/src/base_testnet.rs testing/smoke-test/src/base_testnet.rs; do
  if ! git grep -q -F "$GUIDE" -- "$f"; then
    echo "FAIL: $f does not point at $GUIDE" >&2
    fail=1
  fi
done

hits="$(git grep -n -E "$PATTERN" -- . \
  ':(exclude).github/scripts/check_no_removed_doc_paths.sh' \
  ':(exclude).github/scripts/tests/test_check_no_removed_doc_paths.sh' || true)"
if [[ -n "$hits" ]]; then
  echo "FAIL: tracked files mention removed doc paths:" >&2
  echo "$hits" >&2
  fail=1
fi

if [[ -f "$GUIDE" ]]; then
  guide_dir="$(dirname "$GUIDE")"
  while IFS= read -r link; do
    target="${link%%#*}"
    [[ -z "$target" ]] && continue
    if [[ ! -e "$guide_dir/$target" ]]; then
      echo "FAIL: broken relative link in $GUIDE: $link" >&2
      fail=1
    fi
  done < <(grep -oE '\]\([^)#:]+(#[^)]*)?\)' "$GUIDE" | sed -E 's/^\]\(//; s/\)$//')
fi

if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "OK: no removed doc paths"
