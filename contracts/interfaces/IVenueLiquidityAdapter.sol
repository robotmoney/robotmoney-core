// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Optional withdrawal liquidity probe for a strategy adapter.
/// @dev Adapters implementing this interface advertise its interface ID through ERC-165.
interface IVenueLiquidityAdapter {
    /// @return open Whether the venue permits withdrawals under current conditions.
    /// @return available The maximum underlying the adapter can withdraw immediately.
    function withdrawalLiquidity() external view returns (bool open, uint256 available);
}
