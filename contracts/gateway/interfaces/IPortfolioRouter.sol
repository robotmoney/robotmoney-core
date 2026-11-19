// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.2 — Portfolio Router
pragma solidity ^0.8.24;

/// @title IPortfolioRouter
/// @notice Minimal interface for integrations that call PortfolioRouter.
/// @dev The current gateway deposits to one ERC-4626 vault. The full router interface
///      is in contracts/PortfolioRouter.sol.
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

    /// @notice Redeem vault shares from an explicit, caller-supplied set of
    ///         vaults. Each vault sends assets directly to the supplied recipient.
    ///         The holder approves the router on the vault share token. An operator must
    ///         also have a router redemption allowance for each vault and recipient.
    /// @param shareHolder       Owner of the shares passed to the vault redeem call.
    /// @param assetRecipient    Address that receives the redeemed USDC per leg.
    /// @param vaults            Explicit list of vault addresses to redeem from.
    ///                          Each must be registered. Drives the redeem legs;
    ///                          `sharesPerLeg`/`minAssetsPerLeg` are parallel to it.
    /// @param sharesPerLeg      Vault shares to redeem per leg (parallel to `vaults`).
    ///                          Length must match `vaults`.
    /// @param minAssetsPerLeg   Per-leg USDC slippage floor (parallel to `vaults`).
    ///                          Reverts `SlippageExceeded` if realized proceeds fall
    ///                          below the floor. A floor of 0 disables the check for
    ///                          that leg; length must match `vaults`.
    /// @param deadline          Unix timestamp after which the call reverts
    ///                          `DeadlineExpired`. Pass `type(uint256).max` to disable.
    /// @return assetsPerLeg     USDC received per leg (parallel to `vaults`).
    function redeemFor(
        address shareHolder,
        address assetRecipient,
        address[] calldata vaults,
        uint256[] calldata sharesPerLeg,
        uint256[] calldata minAssetsPerLeg,
        uint256 deadline
    ) external returns (uint256[] memory assetsPerLeg);

    /// @notice Return the currently active vault list used for deposit/redeem
    ///         routing (the voted vector when active, otherwise the default).
    /// @return vaults  Ordered vault addresses in the effective weight vector.
    /// @return bps     Parallel weight array in basis points.
    function getEffectiveWeights()
        external
        view
        returns (address[] memory vaults, uint256[] memory bps);
}
