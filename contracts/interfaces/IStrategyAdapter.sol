// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters
pragma solidity ^0.8.24;

/// @notice Minimal interface every Robot Money strategy adapter must implement.
/// @dev All mutating functions are restricted to onlyVault inside implementations.
interface IStrategyAdapter {
    /// @notice Receive `amount` USDC from the vault and deploy it into the underlying protocol.
    /// @param amount Amount of USDC (6-decimal units) to deploy into the protocol.
    function deploy(uint256 amount) external;

    /// @notice Withdraw `amount` USDC from the underlying protocol and return it to the vault.
    /// @param amount Amount of USDC to withdraw; pass `type(uint256).max` to withdraw all.
    /// @return actual The amount of USDC actually withdrawn (may be ≤ amount on shortfall).
    function withdraw(uint256 amount) external returns (uint256 actual);

    /// @notice Live USDC value held by this adapter (principal + accrued interest).
    function totalAssets() external view returns (uint256);

    /// @notice Permissionlessly sweep a NON-protected foreign token to the fixed
    ///         quarantine address (custody invariants INV-1/INV-2). Anyone may
    ///         call; the destination is a hardcoded constant, never caller-supplied.
    ///         Reverts when `token` is USDC or the adapter's strategy/share token.
    /// @param token Address of the foreign ERC-20 to quarantine.
    function sweepForeignToken(address token) external;
}
