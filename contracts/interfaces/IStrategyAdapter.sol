// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface every Robot Money strategy adapter must implement.
/// @dev All mutating functions are restricted to onlyVault inside implementations.
interface IStrategyAdapter {
    /// @notice Receive `amount` USDC from the vault and deploy it into the underlying protocol.
    function deploy(uint256 amount) external;

    /// @notice Withdraw `amount` USDC from the underlying protocol and return it to the vault.
    /// @return actual The amount of USDC actually withdrawn (may be ≤ amount on shortfall).
    function withdraw(uint256 amount) external returns (uint256 actual);

    /// @notice Live USDC value held by this adapter (principal + accrued interest).
    function totalAssets() external view returns (uint256);

    /// @notice Rescue non-USDC tokens accidentally sent to this contract.
    function rescueTokens(address token, address to) external;
}
