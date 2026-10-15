// SPDX-License-Identifier: MIT
// Canonical: docs/technical/adapter-architecture.md — A venue that refuses a supply (security round 3)
pragma solidity ^0.8.24;

/// @notice Strategy adapter that can report whether its venue still pays withdrawals
///         (`AaveV3Adapter`, `CompoundV3Adapter`).
/// @dev `RobotMoneyVault` closes deposits (`maxDeposit` 0) while an active adapter reports false,
///      through `VaultAdapterOps.anyVenueBlocked`, a `staticcall` that reads a missing or reverting
///      view as true. Minting while a venue cannot pay would count its stuck balance at face, and
///      the new USDC would fund early exits at that NAV (security round 3).
interface IVenueHealthAdapter {
    /// @notice False while the venue refuses withdrawals: an Aave reserve that is paused or
    ///         inactive, a Comet whose withdrawals are paused.
    function venueWithdrawable() external view returns (bool);
}
