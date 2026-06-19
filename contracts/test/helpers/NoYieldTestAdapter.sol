// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../../interfaces/IStrategyAdapter.sol";
import {ForeignTokenQuarantine} from "../../lib/ForeignTokenQuarantine.sol";

/// @title NoYieldTestAdapter
/// @notice A test-only, no-yield IStrategyAdapter that simply holds deposited
///         USDC in this contract with no external protocol calls. It exists
///         purely to give RobotMoneyVault unit tests a lossless, deterministic
///         adapter that satisfies the IStrategyAdapter interface without
///         depending on real Aave/Compound/Morpho protocol state.
///
/// @dev Lives under `contracts/test/` so it is NOT part of the production
///      artifact set (`foundry.toml` `src = "contracts"`, `test =
///      "contracts/test"`). No interest accrues — `totalAssets()` always
///      returns the raw USDC balance held by this contract.
///
///      This adapter must NEVER be deployed to a live chain — it provides zero
///      yield and exists only as a unit-test fixture.
contract NoYieldTestAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    /// @notice USDC token address.
    IERC20 public immutable USDC;
    /// @notice Address of the RobotMoneyVault that owns this adapter.
    address public immutable VAULT;

    /// @notice Caller is not the configured `VAULT` address.
    error OnlyVault();
    /// @notice Constructor received a zero address.
    error ZeroAddress();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    /// @param usdc_  Address of the USDC token (6-decimal ERC-20).
    /// @param vault_ Address of the RobotMoneyVault that owns this adapter.
    constructor(address usdc_, address vault_) {
        if (usdc_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev USDC is already transferred to this contract by the vault before
    ///      `deploy` is called — nothing further is needed.
    function deploy(
        uint256 /* amount */
    )
        external
        onlyVault
    {
        // No external protocol — USDC stays in this contract.
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev Transfers up to `amount` USDC back to the vault. If the balance
    ///      is insufficient, transfers the entire remaining balance.
    function withdraw(uint256 amount) external onlyVault returns (uint256 actual) {
        uint256 bal = USDC.balanceOf(address(this));
        actual = amount > bal ? bal : amount;
        if (actual > 0) {
            USDC.safeTransfer(VAULT, actual);
        }
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev USDC (the protected vault asset) cannot be swept. Any other token
    ///      accidentally sent to this contract is permissionlessly quarantined.
    function sweepForeignToken(address token) external {
        if (token == address(USDC)) revert ForeignTokenQuarantine.TokenIsProtected(token);
        ForeignTokenQuarantine.sweep(token, msg.sender);
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev No-yield test adapter holds only raw USDC with no reward tokens —
    ///      harvest is a no-op and always succeeds.
    function harvestRewards() external {}
}
