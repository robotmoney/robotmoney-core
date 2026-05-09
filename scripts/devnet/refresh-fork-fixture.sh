#!/usr/bin/env bash
# Convenience wrapper around scripts/devnet/snapshot-fork.sh.
#
# Refresh cadence: monthly is fine for the devnet's fork-state fixture.
# Bump it whenever:
#   - upstream contracts the fork interacts with change at a known block, OR
#   - more than ~6 months have elapsed since CURRENT.json's captured_at.
#
# This wrapper is here so the refresh step has a memorable name in the
# runbook and so CI can pin a single command in `docs/technical/full-stack-devnet.md`.
#
# Canonical: docs/technical/full-stack-devnet.md §"Refreshing the fork-state fixture"
# Issue: #146.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec bash "$REPO_ROOT/scripts/devnet/snapshot-fork.sh" "$@"
