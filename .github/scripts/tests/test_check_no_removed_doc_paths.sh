#!/usr/bin/env bash
# Self-test for .github/scripts/check_no_removed_doc_paths.sh
#
# Canonical: .github/scripts/check_no_removed_doc_paths.sh
# Issue: #1556
#
# Builds throwaway git trees. Asserts the guard is green on a clean tree and
# red on a planted docs/sprint link and a planted docs/scout link. Also checks
# the workflow wires both scripts and the diff stays inside the allowed paths.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="$REPO_ROOT/.github/scripts/check_no_removed_doc_paths.sh"
cases=0
failures=0

make_tree() {
  local d
  d="$(mktemp -d)"
  mkdir -p "$d/docs/testing" "$d/testing/fork-e2e-rust/src" "$d/testing/smoke-test/src"
  echo "# guide" >"$d/docs/testing/base-testnet-guide.md"
  echo "//! See docs/testing/base-testnet-guide.md" >"$d/testing/fork-e2e-rust/src/base_testnet.rs"
  echo "//! See docs/testing/base-testnet-guide.md" >"$d/testing/smoke-test/src/base_testnet.rs"
  echo "clean" >"$d/docs/other.md"
  git -C "$d" init -q
  git -C "$d" add -A
  echo "$d"
}

run_guard() { CHECK_REPO_ROOT="$1" bash "$GUARD" >/dev/null 2>&1; }

expect() { # name want(0|nonzero) tree
  cases=$((cases + 1))
  local rc=0
  run_guard "$3" || rc=$?
  if { [[ $2 == 0 ]] && [[ $rc -ne 0 ]]; } || { [[ $2 != 0 ]] && [[ $rc -eq 0 ]]; }; then
    echo "FAIL: $1 (exit $rc)" >&2
    failures=$((failures + 1))
  else
    echo "ok: $1"
  fi
}

t="$(make_tree)"
expect "clean tree passes" 0 "$t"

echo "[plan](docs/sprint/x.md)" >>"$t/docs/other.md"
git -C "$t" add -A
expect "planted docs/sprint link fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
echo "[note](docs/scout/x.md)" >>"$t/docs/other.md"
git -C "$t" add -A
expect "planted docs/scout link fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
echo "[x](../nope.md)" >>"$t/docs/testing/base-testnet-guide.md"
git -C "$t" add -A
expect "broken guide link fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
mkdir "$t/docs/sprint"
expect "existing docs/sprint dir fails" 1 "$t"
rm -rf "$t"

# Real tree is clean.
cases=$((cases + 1))
if bash "$GUARD" >/dev/null 2>&1; then echo "ok: real tree passes"; else
  echo "FAIL: real tree" >&2
  failures=$((failures + 1))
fi

# Workflow wires both scripts.
for s in check_no_removed_doc_paths.sh test_check_no_removed_doc_paths.sh; do
  cases=$((cases + 1))
  if grep -q "$s" "$REPO_ROOT/.github/workflows/suite-13-doc-checks.yml"; then
    echo "ok: workflow runs $s"
  else
    echo "FAIL: workflow missing $s" >&2
    failures=$((failures + 1))
  fi
done

# Diff scope: only allowed paths, Rust changes are //! comment lines.
base="$(git -C "$REPO_ROOT" merge-base HEAD origin/dev 2>/dev/null || true)"
if [[ -z "$base" ]]; then
  # Shallow checkout: fetch the base branch, then retry. Never skip silently.
  git -C "$REPO_ROOT" fetch --quiet --unshallow origin dev 2>/dev/null ||
    git -C "$REPO_ROOT" fetch --quiet origin dev 2>/dev/null || true
  base="$(git -C "$REPO_ROOT" merge-base HEAD origin/dev 2>/dev/null || true)"
fi
if [[ -z "$base" ]]; then
  echo "FAIL: cannot resolve merge-base with origin/dev; the diff-scope cases cannot run (shallow checkout? use fetch-depth: 0)" >&2
  exit 1
fi
cases=$((cases + 1))
bad="$(git -C "$REPO_ROOT" diff --name-only "$base" |
  grep -v -E '^(docs/|\.github/|tests/fixtures/committee-vote\.schema\.json$|testing/(fork-e2e-rust|smoke-test)/src/base_testnet\.rs$|scripts/ci/check-no-test-only-code\.ts$|scripts/devnet/check-twin-chain-ci-selftest\.ts$|clients/rust-payment-client/(src/commands/committee\.rs|src/gateway/mod\.rs|tests/committee\.rs)$|contracts/(PortfolioRouter|RobotMoneyVault|RouterGovernance)\.sol$|contracts/gateway/RobotMoneyGateway\.sol$|contracts/test/(GatewayRouter\.t|RedeemGasGuards\.t|RobotMoneyVaultRedeemGas\.t|RobotMoneyVaultRedeemGasMechanism\.t|RobotMoneyVaultRedeemGasRootCause\.t)\.sol$|contracts/doc/src/pages/|contracts/doc/vocs\.sidebar\.ts$|testing/fork-e2e-rust/tests/(withdrawal|router|governance)\.rs$|contracts/script/(DeployRouterGovernance|DeployTimelock)\.s\.sol$|contracts/test/(DeployRouterGovernanceDefaults|DeployTimelock|DeployTimelockCommittee|GovernanceExecutePathAfterHandover|PortfolioRouter|RouterGovernance|SafeIntegration)\.t\.sol$|contracts/test/fv/(DeployAssertions|FvInvariants)\.t\.sol$|publish-contracts/|clients/dapp/src/lib/abi\.generated\.ts$|clients/rust-payment-client/abi/PortfolioRouter\.json$)' || true)"
if [[ -n "$bad" ]]; then
  echo "FAIL: diff touches paths outside scope: $bad" >&2
  failures=$((failures + 1))
else
  echo "ok: diff paths in scope"
fi
cases=$((cases + 1))
badrs="$(git -C "$REPO_ROOT" diff -U0 "$base" -- '*.rs' \
  ':(exclude)testing/fork-e2e-rust/tests/withdrawal.rs' \
  ':(exclude)testing/fork-e2e-rust/tests/router.rs' \
  ':(exclude)clients/rust-payment-client/src/commands/committee.rs' \
  ':(exclude)clients/rust-payment-client/src/gateway/mod.rs' \
  ':(exclude)clients/rust-payment-client/tests/committee.rs' \
  ':(exclude)testing/fork-e2e-rust/tests/governance.rs' | grep -E '^[+-][^+-]' | grep -v -E '^[+-]//!' || true)"
if [[ -n "$badrs" ]]; then
  echo "FAIL: Rust diff has non-//! lines: $badrs" >&2
  failures=$((failures + 1))
else
  echo "ok: Rust diff is comment-only"
fi

if [[ $cases -eq 0 ]]; then
  echo "FAIL: zero cases ran" >&2
  exit 1
fi
echo "$cases cases, $failures failures"
[[ $failures -eq 0 ]]
