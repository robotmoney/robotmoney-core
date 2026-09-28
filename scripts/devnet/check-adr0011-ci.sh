#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
FORGE="$ROOT/.github/workflows/suite-01-02-forge-tests.yml"
NIGHTLY="$ROOT/.github/workflows/suite-21-nightly.yml"

if grep -n 'secrets\.RMPC_FORK_RPC_URL' "$FORGE"; then
  echo "merge-gating fork workflow still references the RPC secret" >&2
  exit 1
fi
if ! grep -q 'Assert tampered fixture is red' "$FORGE"; then
  echo "suite-01-02 fork-regressions job is missing the ADR-0011 sha256 tamper self-test step (issue #1152)" >&2
  exit 1
fi
if ! grep -q 'Assert missing digest is red' "$FORGE"; then
  echo "suite-01-02 fork-regressions job is missing the ADR-0011 sha256 missing-digest self-test step (issue #1152)" >&2
  exit 1
fi
grep -q '^  schedule:' "$NIGHTLY"
grep -q '^  workflow_dispatch:' "$NIGHTLY"
if grep -Eq '^  (push|pull_request):' "$NIGHTLY"; then
  echo "nightly workflow must not run on push or pull_request" >&2
  exit 1
fi
# Issue #1239: the public fallback list lives only in scripts/devnet/fork-rpc-lib.sh.
# A YAML `vars.RMPC_FORK_RPC_URL || '<url>'` fallback would fork a second copy.
if grep -nE "vars\.RMPC_FORK_RPC_URL[[:space:]]*\|\|" "$FORGE" "$NIGHTLY"; then
  echo "fork RPC fallback must come from scripts/devnet/fork-rpc-lib.sh, not a workflow expression (issue #1239)" >&2
  exit 1
fi
grep -q 'FORK_RPC_URL: ${{ vars.RMPC_FORK_RPC_URL }}' "$NIGHTLY"
# Every live-RPC forge step in the merge gate goes through the attributing
# runner, so an RPC failure is titled as one instead of reading as a regression.
if grep -nE '^[[:space:]]*forge test .*ForkTest' "$FORGE"; then
  echo "live-RPC fork suites must run via scripts/devnet/run-live-rpc-forge-fork.sh (issue #1239)" >&2
  exit 1
fi
for contract in UniV3AssetPositionAdapterForkTest UniV4AssetPositionAdapterForkTest AerodromeAssetPositionAdapterForkTest; do
  grep -qE "scripts/devnet/run-live-rpc-forge-fork\.sh .*\"$contract\"" "$FORGE" || {
    echo "suite-01-02 fork-regressions no longer runs $contract through run-live-rpc-forge-fork.sh (issue #1239)" >&2
    exit 1
  }
done
grep -q 'bash .github/scripts/tests/test_run_live_rpc_forge_fork.sh' "$FORGE"
grep -q 'Open or update fork drift tracking issue' "$NIGHTLY"
if grep -q 'secrets\.RMPC_FORK_RPC_URL' "$NIGHTLY"; then
  echo "nightly RPC must use a public variable/default, not a secret" >&2
  exit 1
fi
echo "ADR-0011 CI structure is valid"
