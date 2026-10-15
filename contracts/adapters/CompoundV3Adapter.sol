// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.3 — Vault Adapters (Compound V3 Comet venue)
// (See also: docs/prd.md §11.1 — Stable Yield Vault)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IVenueHealthAdapter} from "../interfaces/IVenueHealthAdapter.sol";
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
///      Implements the `IStrategyAdapter` called by RobotMoneyVault. The
///      two-argument `deploy`/`withdraw` overloads add min-out slippage
///      floors and a realized-value return; Comet USDC supply/redemption is
///      exact (1:1), so the floors are trivially satisfied but still enforced
///      (revert `SlippageExceeded` below the floor). `isExact()` returns true.
contract CompoundV3Adapter is IStrategyAdapter, IVenueHealthAdapter {
    using SafeERC20 for IERC20;

    /// @notice USDC token address used for deposits and withdrawals.
    /// @dev Stored as `address` so the auto-generated getter satisfies the
    ///      `USDC()` identity view (returns `address`).
    address public immutable USDC;
    /// @notice Compound V3 (Comet) contract; also the cUSDCv3 share token.
    IComet public immutable COMET;
    /// @notice Address of the RobotMoneyVault that owns this adapter.
    address public immutable VAULT;

    /// @notice The caller of a mutating function is not the bound `VAULT`.
    error OnlyVault();
    /// @notice A min-out slippage floor was breached.
    error SlippageExceeded();
    /// @notice Constructor passed `address(0)` for one of the immutable addresses.
    error ZeroAddress();
    /// @notice `Comet.withdrawTo` returned fewer USDC than requested.
    /// @param requested Amount of USDC requested for withdrawal.
    /// @param actual    Amount of USDC actually received from Compound.
    error WithdrawShortfall(uint256 requested, uint256 actual);
    /// @notice Comet refused a `deploy(uint256)` supply with `isWithdrawPaused` also set, so
    ///         the adapter did not hand the USDC back (security round 3).
    /// @param reason Comet's revert data.
    error VenueWithdrawalsClosed(bytes reason);

    /// @notice Comet refused a `deploy(uint256)` supply, and the USDC went straight back to
    ///         `VAULT`, which keeps it idle (security round 2). Comet refuses while its supply
    ///         is paused (`isSupplyPaused`); a pause that also covers withdrawals reverts instead
    ///         (security round 3).
    /// @param amount USDC handed back to `VAULT`.
    /// @param reason Comet's revert data.
    event DeployRefused(uint256 amount, bytes reason);

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

    /// @dev Supply choreography of the min-out `deploy`, which reverts when Comet refuses.
    ///      `deploy(uint256)` runs the same steps but hands a refused supply back to `VAULT`.
    function _supply(uint256 amount) private {
        IERC20(USDC).safeIncreaseAllowance(address(COMET), amount);
        COMET.supply(USDC, amount);
        _clearAllowance();
    }

    /// @dev Zero any allowance a supply left on `COMET`.
    function _clearAllowance() private {
        uint256 remaining = IERC20(USDC).allowance(address(this), address(COMET));
        if (remaining > 0) {
            IERC20(USDC).forceApprove(address(COMET), 0);
        }
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev Security round 2: a supply Comet refuses while only its supply is paused does not
    ///      revert. The adapter sends `amount` back to `VAULT` and emits `DeployRefused`, and the
    ///      vault leaves that USDC idle (`UnroutedDeposit`). Before this a paused Comet reverted
    ///      every rmUSDC deposit, every router deposit with an rmUSDC leg and keeper `rebalance`.
    ///      Security round 3: a refusal while `isWithdrawPaused` is set too reverts
    ///      `VenueWithdrawalsClosed`. The vault still counts the Comet balance at face, and idle
    ///      USDC made from this slice (or pulled from the other venues by a `rebalance`) would
    ///      pay early exits at that NAV while any haircut falls on the holders who stay. The
    ///      min-out overload below still reverts.
    function deploy(uint256 amount) external onlyVault {
        IERC20(USDC).safeIncreaseAllowance(address(COMET), amount);
        try COMET.supply(USDC, amount) {}
        catch (bytes memory reason) {
            if (!venueWithdrawable()) revert VenueWithdrawalsClosed(reason);
            IERC20(USDC).safeTransfer(VAULT, amount);
            emit DeployRefused(amount, reason);
        }
        _clearAllowance();
    }

    /// @inheritdoc IVenueHealthAdapter
    /// @dev Comet's pause guardian pauses supply and withdraw separately (`isWithdrawPaused`).
    function venueWithdrawable() public view returns (bool) {
        return !COMET.isWithdrawPaused();
    }

    /// @notice Min-out variant of `deploy`: reverts `SlippageExceeded` below `minValueOut`.
    /// @param usdcIn Amount of USDC (6-decimal units) to deploy into the venue.
    /// @param minValueOut Minimum value the venue position must gain, else revert.
    /// @return valueAdded Value added to the position, in USDC units.
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

    /// @notice Min-out variant of `withdraw`: reverts `SlippageExceeded` below `minUsdcOut`.
    /// @param usdcWanted USDC to withdraw; `type(uint256).max` withdraws everything.
    /// @param minUsdcOut Minimum USDC that must reach the vault, else revert.
    /// @return usdcOut USDC actually sent to the vault.
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

    /// @inheritdoc IStrategyAdapter
    function totalAssets() external view override returns (uint256) {
        return COMET.balanceOf(address(this));
    }

    /// @notice Bytecode-level exactness declaration (monitoring only).
    /// @dev Comet USDC supply/redemption is 1:1 exact. Registration cross-check +
    ///      monitoring only — never a per-call gate.
    function isExact() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IStrategyAdapter
    function sweepForeignToken(address token) external override {
        if (token == USDC || token == address(COMET)) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(token, msg.sender);
    }

    /// @inheritdoc IStrategyAdapter
    /// @dev Compound V3 (Comet) interest accrues continuously in the principal
    ///      balance — there are no discrete claimable reward tokens on the USDC
    ///      supply market. This function is a no-op and always succeeds.
    function harvestRewards() external override {}
}
