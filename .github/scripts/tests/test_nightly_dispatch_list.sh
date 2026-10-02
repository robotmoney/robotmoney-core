#!/usr/bin/env bash
# Self-test for the nightly dispatch job (core 1495). Run on every pull request by
# suite-13-doc-checks.yml.
#
# It asserts:
#   1. every suite workflow is in the SUITES list or the documented exclusion list
#      (check_nightly_dispatch_list.py), and removing one suite is detected, naming it
#      (negative control, here and inside the python self-test);
#   2. suite-21-nightly.yml passes actionlint;
#   3. the fork-pin age step carries continue-on-error: true (yq);
#   4. the live-base-fork-drift job and its script and test are gone, and nothing in
#      .github, scripts or docs references them or the other deleted files;
#   5. the nightly drift alarm text is absent from the docs and the three forge test headers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
NIGHTLY=.github/workflows/suite-21-nightly.yml
CHECK=.github/scripts/check_nightly_dispatch_list.py
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { echo "FAIL - $1" >&2; exit 1; }

# 1. coverage, positive and negative.
python3 "$CHECK" >/dev/null || bad "a suite workflow is missing from the dispatch list"
ok "every suite workflow is in SUITES or EXCLUDED"
python3 "$CHECK" --self-test >/dev/null || bad "the python self-test failed"
ok "the python self-test passes (removed suite and new suite are detected)"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
victim=suite-12-openclaw.yml
mkdir -p "$tmp/.github/workflows" "$tmp/.github/scripts"
cp .github/workflows/*.yml "$tmp/.github/workflows/"
cp "$CHECK" "$tmp/.github/scripts/"
grep -v "^[[:space:]]*$victim[[:space:]]*$" "$NIGHTLY" >"$tmp/.github/workflows/suite-21-nightly.yml"
if out="$(python3 "$tmp/.github/scripts/$(basename "$CHECK")" 2>&1)"; then
  bad "removing $victim from the list still exited 0"
fi
[[ "$out" == *"$victim"* ]] || bad "the failure did not name $victim: $out"
ok "removing $victim exits non-zero and names it"

# 2. actionlint.
if command -v actionlint >/dev/null 2>&1; then
  actionlint "$NIGHTLY" || bad "actionlint rejects $NIGHTLY"
  ok "actionlint passes on $NIGHTLY"
elif [[ "${NIGHTLY_SELFTEST_ALLOW_NO_ACTIONLINT:-}" == 1 ]]; then
  echo "skip - actionlint not installed (NIGHTLY_SELFTEST_ALLOW_NO_ACTIONLINT=1)"
else
  bad "actionlint is not installed: CI installs it, set NIGHTLY_SELFTEST_ALLOW_NO_ACTIONLINT=1 to skip locally"
fi

# 3. the fork-pin age step cannot fail the run.
yq -e '.jobs."fork-pin-age-warning".steps[] | select(.run == "scripts/devnet/check-fork-pin-age.sh || true") | .["continue-on-error"] == true' "$NIGHTLY" >/dev/null \
  || bad "the fork-pin age step does not carry continue-on-error: true"
ok "the fork-pin age step carries continue-on-error: true"
yq -e '.jobs | has("live-base-fork-drift") | not' "$NIGHTLY" >/dev/null || bad "the live-base-fork-drift job is still in $NIGHTLY"
ok "the live-base-fork-drift job is gone"

# 4. deleted files are absent and unreferenced.
for f in scripts/devnet/run-live-base-fork-drift.sh .github/scripts/tests/test_live_base_fork_drift.sh; do
  [[ ! -e "$f" ]] || bad "$f still exists"
done
ok "the deleted drift script and its test are absent"
self=".github/scripts/tests/test_nightly_dispatch_list.sh"
if hits="$(grep -rnE 'live-base-fork-drift|run-live-base-fork-drift|test_live_base_fork_drift' .github scripts docs --exclude-dir=node_modules --exclude-dir=code-reviews | grep -v "^$self:" || true)" && [[ -n "$hits" ]]; then
  echo "$hits" >&2; bad "something still references the deleted drift job or script"
fi
ok "no file under .github, scripts or docs references the deleted drift job, script or test"
if [[ ! -e scripts/devnet/check-fork-rpc-configured.sh ]]; then
  if hits="$(grep -rn 'check-fork-rpc-configured' .github scripts docs --exclude-dir=code-reviews || true)" && [[ -n "$hits" ]]; then
    echo "$hits" >&2; bad "check-fork-rpc-configured.sh is deleted but still referenced"
  fi
  ok "check-fork-rpc-configured.sh is deleted and unreferenced"
fi

# 5. the drift alarm text.
alarm='drift[- ]alarm|live-drift|nightly live|nightly drift (alarm|fires)|non-blocking nightly'
files=(docs/development/ci-suites.md docs/development/environments.md docs/technical/smart-contracts.md
       scripts/devnet/refresh-fork-fixture.sh
       contracts/test/VaultForkRegressions.t.sol contracts/test/DeploySeedDeposit.t.sol contracts/test/SafeIntegration.t.sol)
for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  if grep -nEi "$alarm" "$f" >&2; then bad "$f still carries the nightly drift alarm text"; fi
done
ok "the nightly drift alarm text is absent from the docs and the forge test headers"

echo "nightly dispatch list selftest: $PASS checks passed"
