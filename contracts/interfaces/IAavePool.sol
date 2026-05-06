// SPDX-License-Identifier: MIT
// Canonical: none — external Aave v3 pool integration interface
pragma solidity ^0.8.24;

/// @notice Minimal Aave V3 Pool interface used by AaveV3Adapter.
interface IAavePool {
    /// @notice Supply `amount` of `asset` to Aave on behalf of `onBehalfOf`.
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    /// @notice Withdraw `amount` of `asset` from Aave and send to `to`.
    /// @param amount Use type(uint256).max to withdraw the full aToken balance.
    /// @return actual The actual amount of underlying asset withdrawn.
    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external returns (uint256 actual);
}
