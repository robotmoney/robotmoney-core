#!/usr/bin/env bash
# Reports, by name, whether the RMPC_FORK_RPC_URL Actions secret is
# configured — without ever printing its value.
#
# Issue #1239: no repo/org secret named RMPC_FORK_RPC_URL is provisioned yet,
# so `secrets.RMPC_FORK_RPC_URL` is empty and the live-RPC fork steps in
# suite-01-02-forge-tests.yml (fork-regressions job) and
# suite-21-nightly.yml (live-base-fork-drift job) fall back to unkeyed public
# Base endpoints (the list lives in scripts/devnet/fork-rpc-lib.sh), which
# rate-limit aggressively. That surfaced as an unexplained
# Cloudflare 429 / "Archive requests require a personal token" deep in a job
# log, and was investigated as test flakiness before being traced back here.
#
# This script makes the fallback loud: called with the raw, pre-fallback
# `secrets.RMPC_FORK_RPC_URL` value, it emits a `::warning::` annotation naming
# the missing secret when empty, so the condition is visible in the run
# summary instead of requiring a raw-log grep.
#
# The value is never echoed: RMPC_FORK_RPC_URL must be stored as an Actions
# *secret* (not variable) because this repo is public and GitHub does not
# mask `vars.*` values anywhere they appear, including a step's `env:` block
# in the log. A keyed provider URL (Alchemy/QuickNode/Ankr/etc.) embeds the
# API key in the path or query string, so a variable would leak credentials
# into a public CI log on every run; a secret is masked wherever GitHub
# prints it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/devnet/fork-rpc-lib.sh
. "$SCRIPT_DIR/fork-rpc-lib.sh"

value="${1:-}"

if [ -z "$value" ]; then
  fallbacks="$(fork_rpc_public_endpoints | while IFS= read -r ep; do fork_rpc_origin "$ep"; done | paste -sd, -)"
  echo "::warning::RMPC_FORK_RPC_URL Actions secret is not set. This job is falling back to unkeyed public Base endpoints (${fallbacks}), which rate-limit aggressively (issue #1239). Provision a keyed Base archive RPC (Alchemy, QuickNode, Ankr, or equivalent) and set it as the RMPC_FORK_RPC_URL repository or organization Actions secret to fix this permanently."
  exit 0
fi

echo "RMPC_FORK_RPC_URL is configured; using the configured Base RPC endpoint."
