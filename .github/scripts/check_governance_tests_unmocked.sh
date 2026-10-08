#!/usr/bin/env bash
# Fail if a governance e2e test goes back to a mock, an EOA governor, or a stubbed RPC (issue 1647).
#
# docs/technical/security-model.md section 16 forbids mocking in rmpc CLI integration tests and in
# the dapp Playwright e2e: they run on the real Safe and TimelockController on the Twin chain. Each
# rule below is "file::forbidden regex::why". A missing file is NOT an error: a deleted test cannot
# mock anything. The require-executed guards prove the replacement tests actually ran.
#
# USAGE: check_governance_tests_unmocked.sh [root]   (default: the repository root)
# Self-test: .github/scripts/tests/test_check_governance_tests_unmocked.sh.
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel)}"

rules=(
  'clients/rust-payment-client/tests/cli_get_timelock.rs::mockito|5afe::a mock JSON-RPC server or a fake Safe (the data path runs in testing/fork-e2e-rust/tests/rmpc_get_timelock_fork.rs)'
  'testing/fork-e2e-rust/tests/rmpc_get_timelock_fork.rs::skip_if_no_fork::the EOA proposer or a fork-skip: use the smoke-test Fixture (real Safe + timelock) and require_prereqs'
  'scripts/fusion/devnet-acceptance.sh::FUSION_RELEASE_ADDRESS::the approver EOA as the duplicate-release sender: it hits AccessControlUnauthorizedAccount before ReceiptAlreadyReleased, send the probe from FUSION_TIMELOCK_ADDRESS'
)

fail=0
for rule in "${rules[@]}"; do
  file="${rule%%::*}"; rest="${rule#*::}"; pat="${rest%%::*}"; why="${rest#*::}"
  [ -f "$root/$file" ] || continue
  if hits="$(grep -nE "$pat" "$root/$file")"; then
    echo "$file:" >&2
    echo "$hits" >&2
    echo "ERROR: $file must not contain $why (issue 1647)." >&2
    fail=1
  fi
done
[ "$fail" -eq 0 ] || exit 1
echo "ok: governance e2e tests are unmocked"
