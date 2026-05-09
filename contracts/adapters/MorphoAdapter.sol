// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §5.2 — Bucket A (stable yield, multi-venue)
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";

/// @title MorphoAdapter
/// @notice Wraps the Morpho Gauntlet USDC Prime vault on Base.
/// @dev MORPHO_VAULT is itself an ERC-4626 vault; shares are held by this adapter.
///      Deployed: 0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9 (Base mainnet)
///      Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun
contract MorphoAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    /// @notice Morpho Gauntlet USDC Prime ERC-4626 vault address.
    IERC4626 public immutable MORPHO_VAULT;
    /// @notice USDC token address used for deposits and withdrawals.
    IERC20 public immutable USDC;
    /// @notice Address of the RobotMoneyVault that owns this adapter.
    address public immutable VAULT;

    /// @notice Caller is not the configured `VAULT` address.
    error OnlyVault();
    /// @notice `MORPHO_VAULT.withdraw` delivered fewer USDC to VAULT than requested.
    /// @param requested Amount of USDC requested for withdrawal.
    /// @param actual    Amount of USDC actually received by VAULT.
    error WithdrawShortfall(uint256 requested, uint256 actual);
    /// @notice `rescueToken` refused — the token is USDC or the Morpho vault share (protected vault assets).
    error CannotRescueProtectedToken();
    /// @notice Constructor passed `address(0)` for one of the immutable addresses.
    error ZeroAddress();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address morphoVault_, address usdc_, address vault_) {
        if (morphoVault_ == address(0) || usdc_ == address(0) || vault_ == address(0)) {
            revert ZeroAddress();
        }
        MORPHO_VAULT = IERC4626(morphoVault_);
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256 amount) external onlyVault {
        USDC.safeIncreaseAllowance(address(MORPHO_VAULT), amount);
        MORPHO_VAULT.deposit(amount, address(this));
        uint256 remaining = USDC.allowance(address(this), address(MORPHO_VAULT));
        if (remaining > 0) {
            USDC.forceApprove(address(MORPHO_VAULT), 0);
        }
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        // slither-disable-start reentrancy-balance
        // Justification: `preBalance`/`postBalance` is the standard balance-delta
        // pattern to measure what Morpho actually delivered. MORPHO_VAULT is an
        // ERC-4626 vault that does not issue transfer callbacks, and only the
        // `VAULT` (which is `nonReentrant` at the call site) can invoke this
        // function, so reentrancy via `MORPHO_VAULT.withdraw` is not reachable.
        uint256 preBalance = USDC.balanceOf(VAULT);
        MORPHO_VAULT.withdraw(amount, VAULT, address(this));
        uint256 postBalance = USDC.balanceOf(VAULT);
        uint256 actual = postBalance - preBalance;
        // slither-disable-end reentrancy-balance
        if (amount != type(uint256).max && actual < amount) {
            revert WithdrawShortfall(amount, actual);
        }
        return actual;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        uint256 shares = MORPHO_VAULT.balanceOf(address(this));
        return MORPHO_VAULT.convertToAssets(shares);
    }

    /// @inheritdoc IStrategyAdapter
    function rescueTokens(address token, address to) external onlyVault {
        if (token == address(USDC) || token == address(MORPHO_VAULT)) {
            revert CannotRescueProtectedToken();
        }
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
    }
}
