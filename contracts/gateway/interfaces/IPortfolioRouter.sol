// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2 — Portfolio Router
pragma solidity ^0.8.24;

/// @title IPortfolioRouter
/// @notice Minimal interface for PortfolioRouter used by RobotMoneyGateway.
/// @dev The gateway needs `depositFor` and `redeemFor`; the full router
///      surface is in contracts/PortfolioRouter.sol.
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

    /// @notice Redeem vault shares proportionally across all vaults in the
    ///         current weight vector. Pulls shares from `shareHolder` via ERC-20
    ///         `transferFrom` (shareHolder must approve the router for each vault
    ///         share token), calls `vault.redeem` on each leg, and forwards
    ///         USDC only to `assetRecipient`.
    /// @param shareHolder       Address whose vault shares are redeemed (must have
    ///                          approved the router to spend shares per vault).
    /// @param assetRecipient    Address that receives the redeemed USDC per leg.
    /// @param sharesPerLeg      Vault shares to redeem per leg (parallel to weight list).
    ///                          Length must match the current weight vector.
    /// @return assetsPerLeg     USDC received per leg (parallel to `sharesPerLeg`).
    function redeemFor(address shareHolder, address assetRecipient, uint256[] calldata sharesPerLeg)
        external
        returns (uint256[] memory assetsPerLeg);

    /// @notice Return the currently active vault list used for deposit/redeem
    ///         routing (the voted vector when active, otherwise the default).
    /// @return vaults  Ordered vault addresses in the effective weight vector.
    /// @return bps     Parallel weight array in basis points.
    function getEffectiveWeights()
        external
        view
        returns (address[] memory vaults, uint256[] memory bps);
}
