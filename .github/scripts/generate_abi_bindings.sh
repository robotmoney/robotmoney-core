#!/usr/bin/env bash
# generate_abi_bindings.sh — extract ABI arrays from Foundry artifacts.
#
# Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway (ABI artifact pipeline)
#
# WHY THIS SCRIPT EXISTS
# The Foundry out/ directory is the single canonical source for all contract
# ABIs. Any copy maintained by hand will drift; this script is the authoritative
# re-derivation step. CI runs it and diffs the output so divergence is caught
# before merge (issue #374).
#
# USAGE
#   Run from the repository root after `forge build` has populated out/:
#     bash .github/scripts/generate_abi_bindings.sh
#
# THE TWO BLOCKS BELOW ARE MACHINE-READ (issue #1346)
# `.github/scripts/check_abi_binding_inventory.py`, run by suite-16, parses them.
# It fails CI when an ABI file exists on disk but appears in neither block, when
# an un-gated entry cites no tracking issue, when the issue it cites is not
# open, or when a fully-generated entry is not written below. Editing the prose
# is fine; keep the `#   <path> ...` line shape.
#
# FULLY-GENERATED OUTPUTS (CI drift-gated)
#   clients/rust-payment-client/abi/Erc20.json          ← TestERC20 (mint/burn)
#   clients/rust-payment-client/abi/TimelockController.json
#   clients/rust-payment-client/abi/ConsensusRecommendationReceipt.json
#
# UN-GATED HAND-MAINTAINED FILES (each MUST cite an OPEN tracking issue)
#   clients/rust-payment-client/abi/RobotMoneyGateway.json — frozen: source deleted in PR 2042 (tracking issue #2034)
#   clients/rust-payment-client/abi/VaultRegistry.json — frozen: source deleted in PR 2042 (tracking issue #2034)
#   clients/rust-payment-client/abi/PortfolioRouter.json — frozen: source deleted in PR 2042 (tracking issue #2034)
#   clients/rust-payment-client/abi/RouterGovernance.json — frozen: source deleted in PR 2042 (tracking issue #2034)
#   clients/rust-payment-client/abi/IVault.json — frozen: source deleted in PR 2042 (tracking issue #2034)
#   clients/dapp/src/lib/abi.generated.ts — frozen: six of its nine contracts deleted in PR 2042 (tracking issue #2034)
#
# WHY THE FROZEN FILES ARE NOT REGENERATED (PR 2042)
# PR 2042 replaced the old multi-vault contracts with the 0.9.0 fund. The gateway, registry, router,
# router governance, IVault, RobotMoneyVault and both basket vaults have no Foundry artifact any
# more, so their ABIs cannot be re-derived. The clients still compile against the committed copies
# until they move to the fund surface (issue 2034 for rmpc). abi.generated.ts mixes three live
# contracts (TestERC20, MockVault, ExclusionLedger) with six deleted ones in one file, so the whole
# file is frozen with them.
#
# BOTH BASKET VAULTS ARE NOW GENERATED (issue #1364)
# The dapp's `BASKET_VAULT_SHORTLIST_ABI` names both basket vaults, but #1346
# emitted only `AgentTokenVault` because it was the only one that declared
# `shortlist()` — `ProtocolAssetVault` had none to generate, which is why its
# composition panel rendered "unavailable". #1364 gave `ProtocolAssetVault` the
# same `shortlist()`, so it is emitted here too and `abi-parity.test.ts` now
# compares `BASKET_VAULT_SHORTLIST_ABI` against BOTH canonical artifacts.
# Both live inside the already-drift-gated `abi.generated.ts`; no new file joins
# the inventory.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/out"
RUST_ABI="$REPO_ROOT/clients/rust-payment-client/abi"

if [[ ! -d "$OUT" ]]; then
  echo "ERROR: Foundry out/ directory not found at $OUT" >&2
  echo "       Run 'forge build' first." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helper: extract .abi from a Foundry artifact and write compact JSON
# ---------------------------------------------------------------------------
extract_abi() {
  local artifact="$1"
  local dest="$2"
  python3 -c "
import json, sys
with open('$artifact') as f:
    d = json.load(f)
print(json.dumps(d['abi'], indent=2))
" > "$dest"
  echo "  wrote $dest"
}

# ---------------------------------------------------------------------------
# 1. Rust ABI JSON files (fully generated — CI drift-gated)
# ---------------------------------------------------------------------------
echo "==> Generating Rust ABI JSON files (drift-gated)..."

# Erc20.json maps to TestERC20 (adds mint/burn used by the test fixture)
extract_abi "$OUT/TestERC20.sol/TestERC20.json"                  "$RUST_ABI/Erc20.json"

# Issue #1362: these were hand-trimmed excerpts of the same artifacts, and one
# of them (VaultRegistry, now frozen) had silently drifted into a shape no
# deployed contract returns. They are now full artifact ABIs.
#
# NOTE FOR WHOEVER ADDS THE NEXT ONE: a full artifact ABI names the declaring
# contract of every struct it borrows, so `sol!` emits a module per foreign
# namespace — PortfolioRouter.json carries `struct VaultRegistry.VaultMetadata`.
# `clients/rust-payment-client/src/gateway/mod.rs` expands each binding inside
# its own private module for exactly that reason; expand a new one at file
# scope and the crate stops compiling on a duplicate-module error.
extract_abi "$OUT/TimelockController.sol/TimelockController.json" "$RUST_ABI/TimelockController.json"
extract_abi "$OUT/ConsensusRecommendationReceipt.sol/ConsensusRecommendationReceipt.json" \
                                                                 "$RUST_ABI/ConsensusRecommendationReceipt.json"

echo ""
echo "ABI generation complete."
echo ""
echo "Drift-gated files (CI checks these):"
echo "  clients/rust-payment-client/abi/Erc20.json"
echo "  clients/rust-payment-client/abi/TimelockController.json"
echo "  clients/rust-payment-client/abi/ConsensusRecommendationReceipt.json"
