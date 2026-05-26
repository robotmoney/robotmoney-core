// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters (devnet/test passthrough)
// Issue: #277 — Wire RobotMoneyVault + PassthroughAdapter into smoke-test devnet
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";

/// @title PassthroughAdapter
/// @notice A no-yield IStrategyAdapter that simply holds deposited USDC in this
///         contract with no external protocol calls. Intended solely for smoke-test
///         devnet deployments where real yield adapters (AaveV3, Morpho, etc.) are
///         unavailable or unnecessary.
///
/// @dev This adapter satisfies the IStrategyAdapter interface required by
///      RobotMoneyVault.addAdapter(). No interest accrues — totalAssets() always
///      returns the raw USDC balance held by this contract.
///
///      Usage: deploy this adapter, then call vault.addAdapter(address(adapter), capBps)
///      from the ADMIN_ROLE account so the vault routes deposits through it.
///
///      This adapter must NOT be used on mainnet — it provides zero yield.
contract PassthroughAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    /// @notice USDC token address.
    IERC20 public immutable USDC;
    /// @notice Address of the RobotMoneyVault that owns this adapter.
    address public immutable VAULT;

    /// @notice Caller is not the configured `VAULT` address.
    error OnlyVault();
    /// @notice Constructor received a zero address.
    error ZeroAddress();
    /// @notice Attempted to rescue USDC (the protected vault asset).
    error CannotRescueUsdc();

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
    /// @dev USDC cannot be rescued (it is the protected vault asset). Any other
    ///      token accidentally sent to this contract may be rescued by the vault.
    function rescueTokens(address token, address to) external onlyVault {
        if (token == address(USDC)) revert CannotRescueUsdc();
        IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }
}
