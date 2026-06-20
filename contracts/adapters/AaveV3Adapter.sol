// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters (Aave V3 venue)
// (See also: docs/prd.md §11.1 — Stable Yield Vault)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

/// @title AaveV3Adapter
/// @notice Strategy adapter that supplies USDC to Aave V3 Pool on Base.
/// @dev aTokens are rebasing — `A_TOKEN.balanceOf(this)` returns live underlying with accrued interest.
///      Aave's `Pool.withdraw` sends USDC directly to the `to` address (we pass VAULT) — clean, no hop.
///      Deployed: 0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea (Base mainnet)
///      Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun
contract AaveV3Adapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    /// @notice USDC token address used for deposits and withdrawals.
    IERC20 public immutable USDC;
    /// @notice aBasUSDC rebasing token; `balanceOf(this)` returns live underlying USDC.
    IERC20 public immutable A_TOKEN;
    /// @notice Aave V3 Pool contract used for `supply` and `withdraw`.
    IAavePool public immutable POOL;
    /// @notice Address of the RobotMoneyVault that owns this adapter.
    address public immutable VAULT;

    /// @notice Caller is not the configured `VAULT` address.
    error OnlyVault();
    /// @notice Constructor passed `address(0)` for one of the immutable addresses.
    error ZeroAddress();
    /// @notice `Pool.withdraw` returned fewer USDC than requested.
    /// @param requested Amount of USDC requested for withdrawal.
    /// @param actual    Amount of USDC actually received from the pool.
    error WithdrawShortfall(uint256 requested, uint256 actual);

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address pool_, address usdc_, address aToken_, address vault_) {
        if (
            pool_ == address(0) || usdc_ == address(0) || aToken_ == address(0)
                || vault_ == address(0)
        ) {
            revert ZeroAddress();
        }
        POOL = IAavePool(pool_);
        USDC = IERC20(usdc_);
        A_TOKEN = IERC20(aToken_);
        VAULT = vault_;
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256 amount) external onlyVault {
        // ADP-5 / NC-12: set the exact allowance with `forceApprove` (which zeroes first for
        // non-standard ERC-20s) rather than the additive, non-zeroing `safeIncreaseAllowance`,
        // then unconditionally reset to zero after the call so no residual allowance can ever
        // linger across deploys.
        USDC.forceApprove(address(POOL), amount);
        POOL.supply(address(USDC), amount, address(this), 0);
        USDC.forceApprove(address(POOL), 0);
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        uint256 actual = POOL.withdraw(address(USDC), amount, VAULT);
        if (amount != type(uint256).max && actual < amount) {
            revert WithdrawShortfall(amount, actual);
        }
        return actual;
    }

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view returns (uint256) {
        return A_TOKEN.balanceOf(address(this));
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address token) external {
        if (token == address(USDC) || token == address(A_TOKEN)) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(token, msg.sender);
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev Aave V3 interest accrues continuously in the rebasing aToken balance —
    ///      there are no discrete claimable reward tokens on the USDC supply venue.
    ///      This function is a no-op and always succeeds.
    function harvestRewards() external {}
}
