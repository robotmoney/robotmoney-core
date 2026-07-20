// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters (Compound V3 Comet venue)
//            docs/technical/unified-vault-spec.md §2 (`IPositionAdapter`), §3 (lending retrofit)
// (See also: docs/prd.md §11.1 — Stable Yield Vault)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {IComet} from "../interfaces/IComet.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

/// @title CompoundV3Adapter
/// @notice Strategy adapter that supplies USDC to Compound V3 (Comet) on Base.
/// @dev Compound V3 is non-ERC-4626. The Comet contract is itself the cUSDCv3 token.
///      `supply` always credits msg.sender. `withdraw` always sends to msg.sender.
///      So this adapter must FORWARD withdrawn USDC to the vault.
///      `COMET.balanceOf(account)` returns live underlying USDC with interest applied.
///      Deployed: 0x8247da22a59fce074c102431048d0ce7294c2652 (Base mainnet)
///      Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun, viaIR=true
///
///      ADR-0010 retrofit: implements BOTH the v1 `IStrategyAdapter` (still
///      called by the deployed RobotMoneyVault) and the unified-vault
///      `IPositionAdapter`. The v2 `deploy`/`withdraw` add min-out slippage
///      floors and a realized-value return; Comet USDC supply/redemption is
///      exact (1:1), so the floors are trivially satisfied but still enforced
///      (revert `SlippageExceeded` below the floor). `isExact()` returns true.
contract CompoundV3Adapter is IStrategyAdapter, IPositionAdapter {
    using SafeERC20 for IERC20;

    /// @notice USDC token address used for deposits and withdrawals.
    /// @dev Stored as `address` so the auto-generated getter satisfies the
    ///      `IPositionAdapter.USDC()` identity view (returns `address`).
    address public immutable USDC;
    /// @notice Compound V3 (Comet) contract; also the cUSDCv3 share token.
    IComet public immutable COMET;
    /// @notice Address of the RobotMoneyVault that owns this adapter.
    address public immutable VAULT;

    /// @notice Constructor passed `address(0)` for one of the immutable addresses.
    error ZeroAddress();
    /// @notice `Comet.withdrawTo` returned fewer USDC than requested.
    /// @param requested Amount of USDC requested for withdrawal.
    /// @param actual    Amount of USDC actually received from Compound.
    error WithdrawShortfall(uint256 requested, uint256 actual);

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address comet_, address usdc_, address vault_) {
        if (comet_ == address(0) || usdc_ == address(0) || vault_ == address(0)) {
            revert ZeroAddress();
        }
        COMET = IComet(comet_);
        USDC = usdc_;
        VAULT = vault_;
    }

    /// @dev Shared supply choreography for the v1 and v2 `deploy` entry points.
    function _supply(uint256 amount) private {
        IERC20(USDC).safeIncreaseAllowance(address(COMET), amount);
        COMET.supply(USDC, amount);
        uint256 remaining = IERC20(USDC).allowance(address(this), address(COMET));
        if (remaining > 0) {
            IERC20(USDC).forceApprove(address(COMET), 0);
        }
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
        // slither-disable-start reentrancy-balance
        // Justification: `preBalance`/`postBalance` is the standard balance-delta
        // pattern for Compound V3, which does not support transfer callbacks.
        // Only the `VAULT` (which is `nonReentrant` at the call site) can call
        // this function, so reentrancy via `COMET.withdraw` is not reachable.
        uint256 preBalance = IERC20(USDC).balanceOf(address(this));
        COMET.withdraw(USDC, amount);
        uint256 postBalance = IERC20(USDC).balanceOf(address(this));
        uint256 actual = postBalance - preBalance;

        if (actual > 0) {
            IERC20(USDC).safeTransfer(VAULT, actual);
        }
        // slither-disable-end reentrancy-balance

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
        uint256 amount = usdcWanted;
        bool all = usdcWanted == type(uint256).max;
        if (!all) {
            // Clamp the target at the liquidatable balance so an over-ask
            // clamps (spec §2.2) instead of borrowing/reverting inside Comet.
            uint256 bal = COMET.balanceOf(address(this));
            if (amount > bal) amount = bal;
        }
        // slither-disable-start reentrancy-balance
        // Same balance-delta justification as the v1 `withdraw` above.
        uint256 preBalance = IERC20(USDC).balanceOf(address(this));
        if (all || amount > 0) {
            // `type(uint256).max` withdraws the full balance (Comet native).
            COMET.withdraw(USDC, amount);
        }
        usdcOut = IERC20(USDC).balanceOf(address(this)) - preBalance;
        if (usdcOut > 0) {
            IERC20(USDC).safeTransfer(VAULT, usdcOut);
        }
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
        return COMET.balanceOf(address(this));
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Comet USDC supply/redemption is 1:1 exact. Registration cross-check +
    ///      monitoring only — never a per-call gate.
    function isExact() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IPositionAdapter
    function sweepForeignToken(address token)
        external
        override(IStrategyAdapter, IPositionAdapter)
    {
        if (token == USDC || token == address(COMET)) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(token, msg.sender);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Compound V3 (Comet) interest accrues continuously in the principal
    ///      balance — there are no discrete claimable reward tokens on the USDC
    ///      supply market. This function is a no-op and always succeeds.
    function harvestRewards() external override(IStrategyAdapter, IPositionAdapter) {}
}
