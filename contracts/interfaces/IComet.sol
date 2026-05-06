// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Compound V3 Comet interface used by CompoundV3Adapter.
/// @dev Comet is not ERC-4626. supply/withdraw always credit/debit msg.sender.
///      balanceOf returns live underlying USDC including accrued interest.
interface IComet {
    /// @notice Supply `amount` of `asset` into Compound V3 (credits msg.sender).
    function supply(address asset, uint256 amount) external;

    /// @notice Withdraw `amount` of `asset` from Compound V3 (sends to msg.sender).
    /// @param amount Use type(uint256).max to withdraw the full balance.
    function withdraw(address asset, uint256 amount) external;

    /// @notice Live USDC balance of `account` including accrued interest.
    function balanceOf(address account) external view returns (uint256);
}
