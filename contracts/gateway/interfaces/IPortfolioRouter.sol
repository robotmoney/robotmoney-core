// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2 — Portfolio Router
pragma solidity ^0.8.24;

/// @title IPortfolioRouter
/// @notice Minimal interface for PortfolioRouter used by RobotMoneyGateway.
/// @dev The gateway only needs `depositFor`; the full router surface is in
///      contracts/PortfolioRouter.sol.
interface IPortfolioRouter {
    /// @notice Split `amount` USDC across active vaults by the current weight
    ///         vector. Shares are minted to `receiver` instead of `msg.sender`.
    /// @param receiver          Address that receives minted vault shares per leg.
    /// @param amount            Total USDC to deposit. Must be pre-approved to this contract.
    /// @param minSharesPerLeg   Per-leg slippage floor. Pass empty array to skip.
    /// @return sharesPerLeg     Vault shares minted per leg (parallel to weight list).
    function depositFor(address receiver, uint256 amount, uint256[] calldata minSharesPerLeg)
        external
        returns (uint256[] memory sharesPerLeg);
}
