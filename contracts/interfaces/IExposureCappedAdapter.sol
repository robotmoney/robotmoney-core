// SPDX-License-Identifier: MIT
// Canonical: docs/technical/adapter-architecture.md §4 — Implemented Adapters (Morpho exposure cap)
pragma solidity ^0.8.24;

/// @notice Strategy adapter with a per-adapter exposure cap (`MorphoAdapter`).
/// @dev `setMaxExposure` is `onlyVault` in the adapter. The vault reaches it through
///      `RobotMoneyVault.setAdapterMaxExposure`, which is `ADMIN_ROLE`-gated.
interface IExposureCappedAdapter {
    /// @notice Set the maximum USDC the adapter may hold in its venue. 0 removes the cap.
    /// @param cap Cap in 6-decimal USDC units.
    function setMaxExposure(uint256 cap) external;
}
