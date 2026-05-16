// SPDX-License-Identifier: MIT
// Canonical: config/feature-flags.json — cross-system feature flag registry.
// Implements: issue #389 — cross-system feature flag registry.
pragma solidity ^0.8.24;

/// @title FeatureFlags
/// @notice Pure bitmap library for reading feature flags encoded in a uint256.
///         Each flag occupies one bit at the position equal to its `id` in the
///         registry (`config/feature-flags.json`).  The bitmap is stored
///         off-chain (e.g. in a deployment config or governance variable) and
///         passed in wherever a gate check is needed — no storage cost.
///
///         Flag IDs (stable — never renumber):
///           0  MULTI_VAULT_ENABLED       gates multi-vault UI + indexer paths
///           1  PORTFOLIO_ROUTER_ENABLED  gates router deposit path
///           2  INDEXER_MULTI_VAULT_EVENTS gates indexer VaultRegistry events
library FeatureFlags {
    // -------------------------------------------------------------------------
    // Flag ID constants — mirror config/feature-flags.json exactly.
    // -------------------------------------------------------------------------

    /// @dev Gates multi-vault UI surfaces in the dapp and multi-vault event
    ///      indexing in the explorer-indexer.
    uint8 public constant MULTI_VAULT_ENABLED = 0;

    /// @dev Gates the PortfolioRouter deposit path and the RouterGovernance
    ///      panel in the dapp.
    uint8 public constant PORTFOLIO_ROUTER_ENABLED = 1;

    /// @dev Gates VaultRegistered / VaultStatusChanged event ingestion in the
    ///      explorer-indexer.
    uint8 public constant INDEXER_MULTI_VAULT_EVENTS = 2;

    // -------------------------------------------------------------------------
    // Core helper
    // -------------------------------------------------------------------------

    /// @notice Returns true iff the flag at `flagId` is set in `bitmap`.
    /// @param flagId  Bit position (0-255).  Must match an entry in the
    ///                registry; unknown IDs simply return false.
    /// @param bitmap  The packed uint256 feature-flag state.
    function isEnabled(uint8 flagId, uint256 bitmap) internal pure returns (bool) {
        return (bitmap >> flagId) & 1 == 1;
    }

    /// @notice Returns a bitmap with the flag at `flagId` set.
    ///         Convenience for tests and deployment scripts.
    function set(uint8 flagId, uint256 bitmap) internal pure returns (uint256) {
        return bitmap | (uint256(1) << flagId);
    }

    /// @notice Returns a bitmap with the flag at `flagId` cleared.
    function clear(uint8 flagId, uint256 bitmap) internal pure returns (uint256) {
        return bitmap & ~(uint256(1) << flagId);
    }
}
