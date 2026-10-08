#!/usr/bin/env bash
# Fail if a devnet test binary can report PASSED without its prerequisites (issue 1436).
#
# A test that prints "skipping" and returns early is recorded as PASSED by libtest, and
# cargo_test_require_executed.sh counts it as executed. The only safe shape is the shared
# `require_prereqs(name)` (smoke_test lib), which asserts. This guard fails when a test file
# under the scanned directories
#   - defines or calls a `skip_if_no_prereqs`-style helper, or
#   - calls `prerequisites_available()` directly (use `require_prereqs` instead).
#
# USAGE: check_no_silent_prereq_skip.sh [dir ...]   (default: the two devnet test dirs)
# Self-test: .github/scripts/tests/test_check_no_silent_prereq_skip.sh
set -euo pipefail

if [ "$#" -gt 0 ]; then
  dirs=("$@")
else
  root="$(git rev-parse --show-toplevel)"
  dirs=("$root/testing/smoke-test/tests" "$root/testing/ethereum-testnet/e2e-rust/tests")
fi

hits="$(grep -rnE --include='*.rs' 'skip_if_no_[A-Za-z_]*|prerequisites_available[[:space:]]*\(' "${dirs[@]}" || true)"
if [ -n "$hits" ]; then
  echo "$hits" >&2
  echo "ERROR: early-return prerequisite skip in a devnet test. Call smoke_test::require_prereqs(name) instead (issue 1436)." >&2
  exit 1
fi
echo "ok: no silent prerequisite skip in ${dirs[*]}"
