// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters (Aave V3 venue)
//            docs/technical/unified-vault-spec.md §2 (`IPositionAdapter`), §3 (lending retrofit)
// (See also: docs/prd.md §11.1 — Stable Yield Vault)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

/// @title AaveV3Adapter
/// @notice Strategy adapter that supplies USDC to Aave V3 Pool on Base.
/// @dev aTokens are rebasing — `A_TOKEN.balanceOf(this)` returns live underlying with accrued interest.
///      Aave's `Pool.withdraw` sends USDC directly to the `to` address (we pass VAULT) — clean, no hop.
///      Deployed: 0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea (Base mainnet)
///      Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun
///
///      ADR-0010 retrofit: implements BOTH the v1 `IStrategyAdapter` (still
///      called by the deployed RobotMoneyVault) and the unified-vault
///      `IPositionAdapter`. The v2 `deploy`/`withdraw` add min-out slippage
///      floors and a realized-value return; Aave USDC supply/redemption is
///      exact (1:1), so the floors are trivially satisfied but still enforced
///      (revert `SlippageExceeded` below the floor). `isExact()` returns true.
contract AaveV3Adapter is IStrategyAdapter, IPositionAdapter {
    using SafeERC20 for IERC20;

    /// @notice USDC token address used for deposits and withdrawals.
    /// @dev Stored as `address` so the auto-generated getter satisfies the
    ///      `IPositionAdapter.USDC()` identity view (returns `address`).
    address public immutable USDC;
    /// @notice aBasUSDC rebasing token; `balanceOf(this)` returns live underlying USDC.
    IERC20 public immutable A_TOKEN;
    /// @notice Aave V3 Pool contract used for `supply` and `withdraw`.
    IAavePool public immutable POOL;
    /// @notice Address of the RobotMoneyVault that owns this adapter.
    address public immutable VAULT;

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
        USDC = usdc_;
        A_TOKEN = IERC20(aToken_);
        VAULT = vault_;
    }

    /// @dev Shared supply choreography for the v1 and v2 `deploy` entry points.
    // ADP-5 / NC-12: set the exact allowance with `forceApprove` (which zeroes first for
    // non-standard ERC-20s) rather than the additive, non-zeroing `safeIncreaseAllowance`,
    // then unconditionally reset to zero after the call so no residual allowance can ever
    // linger across deploys.
    function _supply(uint256 amount) private {
        IERC20(USDC).forceApprove(address(POOL), amount);
        POOL.supply(USDC, amount, address(this), 0);
        IERC20(USDC).forceApprove(address(POOL), 0);
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256 amount) external onlyVault {
        _supply(amount);
    }

    /// @inheritdoc IPositionAdapter
    function deploy(uint256 usdcIn, uint256 minValueOut)
        external
        onlyVault
        returns (uint256 valueAdded)
    {
        _supply(usdcIn);
        // Exact lending adapter: value added is exactly `usdcIn`. Enforce the
        // (trivially satisfied) min-out floor anyway.
        valueAdded = usdcIn;
        if (valueAdded < minValueOut) revert SlippageExceeded();
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        uint256 actual = POOL.withdraw(USDC, amount, VAULT);
        if (amount != type(uint256).max && actual < amount) {
            revert WithdrawShortfall(amount, actual);
        }
        return actual;
    }

    /// @inheritdoc IPositionAdapter
    function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
        external
        onlyVault
        returns (uint256 usdcOut)
    {
        // slither-disable-start reentrancy-balance
        // Justification: the `A_TOKEN.balanceOf` clamp read precedes the
        // `POOL.withdraw` external call, but this function is `onlyVault` and the
        // `VAULT` is `nonReentrant` at the call site, so the read cannot be
        // exploited via reentrancy (same rationale as the v1 balance-delta paths).
        uint256 amount = usdcWanted;
        if (amount != type(uint256).max) {
            // Clamp the target at the liquidatable balance so an over-ask
            // clamps (spec §2.2) instead of reverting inside Aave.
            uint256 bal = A_TOKEN.balanceOf(address(this));
            if (amount > bal) amount = bal;
        }
        // `type(uint256).max` withdraws the full aToken balance (Aave native).
        usdcOut = amount == 0 ? 0 : POOL.withdraw(USDC, amount, VAULT);
        // slither-disable-end reentrancy-balance
        // Shortfall against the min-out floor reverts (spec §2.2).
        if (usdcOut < minUsdcOut) revert SlippageExceeded();
    }

    /// @inheritdoc IPositionAdapter
    function totalAssets()
        external
        view
        override(IStrategyAdapter, IPositionAdapter)
        returns (uint256)
    {
        return A_TOKEN.balanceOf(address(this));
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Aave USDC supply/redemption is 1:1 exact. Registration cross-check +
    ///      monitoring only — never a per-call gate.
    function isExact() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IPositionAdapter
    function sweepForeignToken(address token)
        external
        override(IStrategyAdapter, IPositionAdapter)
    {
        if (token == USDC || token == address(A_TOKEN)) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(token, msg.sender);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Aave V3 interest accrues continuously in the rebasing aToken balance —
    ///      there are no discrete claimable reward tokens on the USDC supply venue.
    ///      This function is a no-op and always succeeds.
    function harvestRewards() external override(IStrategyAdapter, IPositionAdapter) {}
}
