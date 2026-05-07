#!/usr/bin/env bash
# Canonical: docs/implementation-plan.md §11 + docs/technical/explorer-schema-decisions.md
# Implements: issue #57 acceptance criterion
# "Scripted indexer run against a fork-anvil range exits 0 and
#  populates all 9 tables (asserted by Rust integration test)".
#
# This is a thin convenience wrapper. The actual assertions live in
# `services/explorer-indexer/tests/fork_indexer.rs`. The wrapper exists
# so the acceptance criterion has a single executable entry point that
# matches the wording of the issue.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT/services/explorer-indexer"

echo "[explorer-indexer] running integration tests"
echo "[explorer-indexer] RMPC_FORK_RPC_URL=${RMPC_FORK_RPC_URL:-<unset>}"
echo "[explorer-indexer] Docker-only tests skip cleanly without docker;"
echo "[explorer-indexer] fork_indexer test skips cleanly without RMPC_FORK_RPC_URL."

cargo test \
    --test migrations \
    --test idempotency \
    --test rpc_failure \
    --test fork_indexer \
    -- --nocapture
