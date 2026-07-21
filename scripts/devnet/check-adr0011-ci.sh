#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
FORGE="$ROOT/.github/workflows/suite-01-02-forge-tests.yml"
NIGHTLY="$ROOT/.github/workflows/suite-21-nightly.yml"

if grep -n 'secrets\.RMPC_FORK_RPC_URL' "$FORGE"; then
  echo "merge-gating fork workflow still references the RPC secret" >&2
  exit 1
fi
grep -q '^  schedule:' "$NIGHTLY"
grep -q '^  workflow_dispatch:' "$NIGHTLY"
if grep -Eq '^  (push|pull_request):' "$NIGHTLY"; then
  echo "nightly workflow must not run on push or pull_request" >&2
  exit 1
fi
grep -q "vars.RMPC_FORK_RPC_URL || 'https://base-rpc.publicnode.com'" "$NIGHTLY"
grep -q 'Open or update fork drift tracking issue' "$NIGHTLY"
if grep -q 'secrets\.RMPC_FORK_RPC_URL' "$NIGHTLY"; then
  echo "nightly RPC must use a public variable/default, not a secret" >&2
  exit 1
fi
echo "ADR-0011 CI structure is valid"
