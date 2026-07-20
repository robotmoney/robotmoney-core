// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters (Morpho Gauntlet venue)
//            docs/technical/unified-vault-spec.md §2 (`IPositionAdapter`), §3 (lending retrofit)
// (See also: docs/prd.md §11.1 — Stable Yield Vault)
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";

/// @title MorphoAdapter
/// @notice Wraps the Morpho Gauntlet USDC Prime vault on Base.
/// @dev MORPHO_VAULT is itself an ERC-4626 vault; shares are held by this adapter.
///      Deployed: 0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9 (Base mainnet)
///      Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun
///
///      ADR-0010 retrofit: implements BOTH the v1 `IStrategyAdapter` (still
///      called by the deployed RobotMoneyVault) and the unified-vault
///      `IPositionAdapter`. The v2 `deploy`/`withdraw` add min-out slippage
///      floors and a realized-value return; because Morpho USDC↔share
///      conversion is treated as exact (1:1 redemption claim), the min-out
///      checks are trivially satisfied but still enforced (revert
///      `SlippageExceeded` below the floor). `isExact()` returns true; the vault
///      attests exactness separately at `addAdapter` (spec §2.2, C2).
contract MorphoAdapter is IStrategyAdapter, IPositionAdapter {
    using SafeERC20 for IERC20;

    /// @notice Morpho Gauntlet USDC Prime ERC-4626 vault address.
    IERC4626 public immutable MORPHO_VAULT;
    /// @notice USDC token address used for deposits and withdrawals.
    /// @dev Stored as `address` so the auto-generated getter satisfies the
    ///      `IPositionAdapter.USDC()` identity view (returns `address`).
    address public immutable USDC;
    /// @notice Address of the RobotMoneyVault that owns this adapter.
    address public immutable VAULT;

    /// @notice `MORPHO_VAULT.withdraw` delivered fewer USDC to VAULT than requested.
    /// @param requested Amount of USDC requested for withdrawal.
    /// @param actual    Amount of USDC actually received by VAULT.
    error WithdrawShortfall(uint256 requested, uint256 actual);
    /// @notice Constructor passed `address(0)` for one of the immutable addresses.
    error ZeroAddress();
    /// @notice Proposed deployment would push adapter balance above `maxExposure`.
    /// @param current   Current deployed balance (totalAssets) before this deploy.
    /// @param amount    Amount being deployed.
    /// @param cap       Configured maxExposure cap.
    error ExposureCapExceeded(uint256 current, uint256 amount, uint256 cap);

    /// @notice Maximum USDC that may be deployed into Morpho at one time.
    ///         Zero means uncapped (default). Set via `setMaxExposure`.
    uint256 public maxExposure;

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address morphoVault_, address usdc_, address vault_) {
        if (morphoVault_ == address(0) || usdc_ == address(0) || vault_ == address(0)) {
            revert ZeroAddress();
        }
        MORPHO_VAULT = IERC4626(morphoVault_);
        USDC = usdc_;
        VAULT = vault_;
    }

    /// @notice Set the governance-configurable per-adapter max-exposure cap.
    ///         Only callable by the `VAULT` address.
    /// @param cap Maximum USDC that may be deployed into Morpho at one time.
    ///            Set to 0 to disable the cap (uncapped, default behavior).
    function setMaxExposure(uint256 cap) external onlyVault {
        maxExposure = cap;
    }

    /// @dev Shared deposit choreography for the v1 and v2 `deploy` entry points.
    ///      Enforces the exposure cap, then does the exact-allowance deposit.
    // ADP-5 / NC-12: set the exact allowance with `forceApprove` (which zeroes first for
    // non-standard ERC-20s) rather than the additive, non-zeroing `safeIncreaseAllowance`,
    // then unconditionally reset to zero after the call so no residual allowance can ever
    // linger across deploys.
    function _deposit(uint256 amount) private {
        // FS-VLT-10: enforce governance-configurable exposure cap when non-zero.
        uint256 cap = maxExposure;
        if (cap > 0) {
            uint256 current = MORPHO_VAULT.convertToAssets(MORPHO_VAULT.balanceOf(address(this)));
            if (current + amount > cap) {
                revert ExposureCapExceeded(current, amount, cap);
            }
        }
        IERC20(USDC).forceApprove(address(MORPHO_VAULT), amount);
        MORPHO_VAULT.deposit(amount, address(this));
        IERC20(USDC).forceApprove(address(MORPHO_VAULT), 0);
    }

    /// @inheritdoc IStrategyAdapter
    function deploy(uint256 amount) external onlyVault {
        _deposit(amount);
    }

    /// @inheritdoc IPositionAdapter
    function deploy(uint256 usdcIn, uint256 minValueOut)
        external
        onlyVault
        returns (uint256 valueAdded)
    {
        _deposit(usdcIn);
        // Exact lending adapter: the USDC-denominated value added is exactly
        // `usdcIn`. Enforce the (trivially satisfied) min-out floor anyway.
        valueAdded = usdcIn;
        if (valueAdded < minValueOut) revert SlippageExceeded();
    }

    /// @inheritdoc IStrategyAdapter
    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        // slither-disable-start reentrancy-balance
        // Justification: `preBalance`/`postBalance` is the standard balance-delta
        // pattern to measure what Morpho actually delivered. MORPHO_VAULT is an
        // ERC-4626 vault that does not issue transfer callbacks, and only the
        // `VAULT` (which is `nonReentrant` at the call site) can invoke this
        // function, so reentrancy via `MORPHO_VAULT.withdraw` is not reachable.
        uint256 preBalance = IERC20(USDC).balanceOf(VAULT);
        MORPHO_VAULT.withdraw(amount, VAULT, address(this));
        uint256 postBalance = IERC20(USDC).balanceOf(VAULT);
        uint256 actual = postBalance - preBalance;
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
        // slither-disable-start reentrancy-balance
        // Same balance-delta justification as the v1 `withdraw` above.
        uint256 preBalance = IERC20(USDC).balanceOf(VAULT);
        uint256 shares = MORPHO_VAULT.balanceOf(address(this));
        uint256 redeemable = MORPHO_VAULT.convertToAssets(shares);
        // `type(uint256).max` = withdraw-all sentinel; an over-ask clamps at the
        // liquidatable balance (spec §2.2). Both drain via `redeem(shares)` to
        // avoid ERC-4626 rounding when asking for the full asset amount.
        if (usdcWanted == type(uint256).max || usdcWanted >= redeemable) {
            if (shares > 0) {
                MORPHO_VAULT.redeem(shares, VAULT, address(this));
            }
        } else {
            MORPHO_VAULT.withdraw(usdcWanted, VAULT, address(this));
        }
        usdcOut = IERC20(USDC).balanceOf(VAULT) - preBalance;
        // slither-disable-end reentrancy-balance
        // Shortfall against the min-out floor reverts; shortfall against
        // `usdcWanted` above the floor already clamped above (spec §2.2).
        if (usdcOut < minUsdcOut) revert SlippageExceeded();
    }

    /// @inheritdoc IPositionAdapter
    function totalAssets()
        external
        view
        override(IStrategyAdapter, IPositionAdapter)
        returns (uint256)
    {
        uint256 shares = MORPHO_VAULT.balanceOf(address(this));
        return MORPHO_VAULT.convertToAssets(shares);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Morpho USDC↔share redemption is treated as exact (1:1 hard claim).
    ///      Registration cross-check + monitoring only — never a per-call gate.
    function isExact() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IPositionAdapter
    function sweepForeignToken(address token)
        external
        override(IStrategyAdapter, IPositionAdapter)
    {
        if (token == USDC || token == address(MORPHO_VAULT)) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(token, msg.sender);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Morpho Gauntlet USDC Prime yield accrues automatically into the
    ///      ERC-4626 share price — there are no discrete claimable reward tokens
    ///      on this venue. This function is a no-op and always succeeds.
    function harvestRewards() external override(IStrategyAdapter, IPositionAdapter) {}
}
