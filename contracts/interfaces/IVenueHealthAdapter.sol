// SPDX-License-Identifier: MIT
// Canonical: docs/technical/adapter-architecture.md — A venue that refuses a supply (security round 3)
pragma solidity ^0.8.24;

/// @notice Legacy pause-only withdrawal signal used by Aave and Compound adapters.
interface IVenueHealthAdapter {
    /// @notice False while the venue refuses withdrawals: an Aave reserve that is paused or
    ///         inactive, a Comet that refuses withdrawals at the venue.
    function venueWithdrawable() external view returns (bool);
}
