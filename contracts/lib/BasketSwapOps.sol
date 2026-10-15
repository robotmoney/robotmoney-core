// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §9 (EIP-170 size budget, item 2)
// (See also: contracts/vaults/BasketVault.sol — every caller below; docs/architecture.md §4.1 —
//  Vault Family (basket vault base); docs/adr/ADR-0007-basket-vault-drawdown-redemption-policy.md;
//  QA plan D6 (dust legs), core 1778 (one-unit sell margin), audit 2026-06-09 L-5 (deadlines))
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {BasketAssetConfigGuard} from "./BasketAssetConfigGuard.sol";
import {ForeignTokenQuarantine} from "./ForeignTokenQuarantine.sol";
import {BpsMath} from "./BpsMath.sol";

/// @dev The two TWAP valuation views of `BasketVault` the swap legs price their floors with. The
///      library runs as the vault (DELEGATECALL), so these are self-calls to the vault's own views,
///      and the floors are exactly the ones the vault computed inline before ADR-0014.
interface IBasketValuation {
    function assetUsdcValue(uint256 index, uint256 amount) external view returns (uint256);
    function assetTokenValue(uint256 index, uint256 usdcAmount) external view returns (uint256);
}

/// @title BasketSwapOps
/// @notice Every swap a `BasketVault` makes: the deposit buy legs, the redeem sell legs, the two
///         emergency unwinds and the removed-asset re-absorption, plus the emergency-guard and TWAP
///         window writes. A CREATE2-linked library: `public` functions run as the vault through
///         `DELEGATECALL`, so `address(this)` is the vault, `msg.sender` is the vault's caller, token
///         approvals and balances are the vault's, and events are emitted from the vault's address.
/// @dev Why it exists (ADR-0014 §9): behind a UUPS proxy each basket kind also carries the upgrade
///      code and its former constructor as an initializer; moving the swap paths out keeps the three
///      kinds under EIP-170 with the 1,024-byte margin the ADR requires. The vault keeps every role
///      check, the `nonReentrant` guards, the redeem entry gas floor, the market checks and all
///      share accounting. Each swap's TWAP floor is read back through the vault's
///      `assetUsdcValue` / `assetTokenValue` views, so pricing has one implementation, in the vault.
///
///      Events and errors mirror the vault's declarations (same topics and selectors).
library BasketSwapOps {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @notice Per-token emergency unwind configuration (`BasketVault.emergencyUnwindGuard`). The one
    ///         declaration (ADR-0014 §8): the vault's mapping and this library use the same type.
    /// @param minUsdcOut      Admin reference floor: the hard minimum on the non-override path and
    ///                        the upper-loss reference on the override path.
    /// @param overrideAllowed Whether `emergencyUnwindWithOverride` may run for the token.
    /// @param maxLossBps      Maximum loss versus `minUsdcOut` on the override path. The override
    ///                        floor is `minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`; `MAX_BPS`
    ///                        reproduces the legacy zero floor, `0` forbids any loss.
    struct EmergencyUnwindGuard {
        uint256 minUsdcOut;
        bool overrideAllowed;
        uint256 maxLossBps;
    }

    /// @dev The vault values every swap needs. Memory, so each call takes one reference.
    /// @param usdc           The vault asset.
    /// @param router         The default Uniswap V3 router (`BasketVault.SWAP_ROUTER`).
    /// @param maxSlippageBps The vault's `maxSlippageBps`, the haircut on every TWAP floor.
    struct Venue {
        address usdc;
        ISwapRouter router;
        uint256 maxSlippageBps;
    }

    uint256 internal constant MAX_BPS = BpsMath.BPS_DENOMINATOR;

    // ─── Mirrored vault events ────────────────────────────────────────

    event Swapped(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );
    event WeightSnapshot(
        address indexed depositor, address[] assets, uint256[] bpsWeights, uint256 timestamp
    );
    event EmergencyUnwindOverrideUsed(
        address indexed token,
        uint256 amountIn,
        uint256 minUsdcOut,
        uint256 appliedFloor,
        address indexed caller
    );
    event EmergencyUnwindGuardSet(
        address indexed token,
        uint256 oldMinUsdcOut,
        uint256 newMinUsdcOut,
        bool overrideAllowed,
        uint256 maxLossBps
    );
    event TwapWindowUpdated(address indexed token, uint32 oldWindow, uint32 newWindow);

    // ─── Mirrored vault errors ────────────────────────────────────────

    error InvalidParam();
    error AssetNotFound();
    error AssetInBasket();
    error SlippageExceeded();
    error EmergencyUnwindOverrideDisabled();
    error EmergencyFloorUnavailable(address token);
    error EmergencyUnwindLossCapExceeded(address token, uint256 received, uint256 appliedFloor);

    // ─── Deposit buy legs ─────────────────────────────────────────────

    /// @notice Split `usdcAmount` equally across the active assets and buy each leg. Body of
    ///         `BasketVault._routeDeposit`. The first active asset absorbs the indivisible remainder.
    ///         Each leg's `amountOutMinimum` is its TWAP token value less `maxSlippageBps`. Emits
    ///         `Swapped` per leg, then one `WeightSnapshot` recording the equal-weight allocation
    ///         (docs/architecture.md §7.1, ADR-0003).
    function routeDeposit(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        Venue memory v,
        address caller,
        uint256 usdcAmount
    ) public {
        uint256 n = _activeCount(assets);
        if (n == 0 || usdcAmount == 0) return;

        uint256 perAsset = usdcAmount / n;
        uint256 firstExtra = usdcAmount - perAsset * n;
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 swapIn = perAsset + firstExtra;
            firstExtra = 0;
            if (swapIn == 0) continue;
            _buyLeg(assets[i], v, i, swapIn);
        }

        (address[] memory snapshotAssets, uint256[] memory snapshotWeights) =
            _weightSnapshot(assets, n);
        emit WeightSnapshot(caller, snapshotAssets, snapshotWeights, block.timestamp);
    }

    // ─── Redeem sell legs ─────────────────────────────────────────────

    /// @notice Sell `shares / supplyBefore` of each active asset for USDC and add the same share of
    ///         idle USDC. Body of `BasketVault._sellProportional`. Returns the USDC collected.
    /// @dev A leg is priced one input unit short (core 1778: a V3 pool rounds the fee-adjusted input
    ///      down by one unit, which failed the floor on a dust leg). A leg whose floor is zero is
    ///      dust (QA plan D6, SR-L12): its sale can pay zero, which the V4 adapter refuses, so it is
    ///      skipped and stays with the remaining holders.
    function sellProportional(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        Venue memory v,
        uint256 shares,
        uint256 supplyBefore
    ) public returns (uint256 usdcOut) {
        // Idle USDC proportion owed to this redeemer (captured before swaps change balances).
        uint256 idleBefore = IERC20(v.usdc).balanceOf(address(this));
        if (idleBefore > 0) usdcOut += idleBefore.mulDiv(shares, supplyBefore);
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            usdcOut += _sellLeg(assets[i], v, i, shares, supplyBefore);
        }
    }

    // ─── Emergency unwinds (EMERGENCY_ROLE checked by the vault) ──────

    /// @notice Swap every active asset back to USDC. Body of `BasketVault.emergencyUnwind` after
    ///         the deposit halt.
    /// @dev The per-leg floor is max(TWAP floor, configured `minUsdcOut`); when the TWAP read
    ///      reverts, a non-zero configured floor is required (`EmergencyFloorUnavailable`). A leg
    ///      whose TWAP floor rounds to zero USDC units is dust and is skipped (QA plan D6): one
    ///      donated wei cannot block the unwind.
    function emergencyUnwind(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        mapping(address => EmergencyUnwindGuard) storage guards,
        Venue memory v
    ) public {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            _unwindLeg(assets[i], guards, v, i);
        }
    }

    /// @notice Oracle-independent unwind of `tokens`, each bounded by its guard's upper-loss cap.
    ///         Body of `BasketVault.emergencyUnwindWithOverride` after the deposit halt. Emits
    ///         `EmergencyUnwindOverrideUsed` before each swap.
    function emergencyUnwindWithOverride(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        mapping(address => EmergencyUnwindGuard) storage guards,
        Venue memory v,
        address[] memory tokens
    ) public {
        uint256 len = tokens.length;
        for (uint256 i = 0; i < len; i++) {
            EmergencyUnwindGuard memory guard = guards[tokens[i]];
            if (!guard.overrideAllowed) revert EmergencyUnwindOverrideDisabled();
            BasketAssetConfigGuard.AssetInfo memory assetInfo =
                activeAssetForToken(assets, tokens[i]);
            uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
            if (bal == 0) continue;
            uint256 appliedFloor = guard.minUsdcOut * (MAX_BPS - guard.maxLossBps) / MAX_BPS;
            emit EmergencyUnwindOverrideUsed(
                assetInfo.token, bal, guard.minUsdcOut, appliedFloor, msg.sender
            );
            _swapAllToUsdcWithCap(v, assetInfo, appliedFloor);
        }
    }

    /// @notice Body of `BasketVault.reabsorbRemovedAsset` (INV-2, LIFE-6, AZ-BSK-5): swap a balance
    ///         that reappeared on the removed asset at `index` back to USDC into NAV under its TWAP
    ///         floor, or, when the TWAP read reverts (degraded pool), sweep it to the fixed quarantine
    ///         address rather than strand it. Reverts `SlippageExceeded` when the TWAP floor is below
    ///         the caller's `minUsdcOut`. A dust balance (floor rounds to zero) is left in place.
    function reabsorbRemovedAsset(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        Venue memory v,
        uint256 index,
        uint256 minUsdcOut
    ) public {
        BasketAssetConfigGuard.AssetInfo memory assetInfo = assets[index]; // reverts on OOB index
        // Only inactive (removed) entries qualify: active assets are already counted in NAV and
        // are sold proportionally on withdrawal.
        if (assetInfo.active) revert AssetInBasket();
        uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
        try IBasketValuation(address(this)).assetUsdcValue(index, bal) returns (uint256 twapValue) {
            uint256 floor = _applySlippage(twapValue, v.maxSlippageBps);
            if (floor < minUsdcOut) revert SlippageExceeded();
            _swapAllToUsdc(v, assetInfo, floor);
        } catch {
            // Pool degraded: TWAP unavailable. Sweep rather than strand (INV-1); `sweep` emits
            // ForeignTokenQuarantined(token, amount, caller).
            ForeignTokenQuarantine.sweep(assetInfo.token, msg.sender);
        }
    }

    // ─── Governed writes (ADMIN_ROLE checked by the vault) ────────────

    /// @notice Body of `BasketVault.setEmergencyUnwindGuard`: `token` must be an active asset and
    ///         `maxLossBps` at most `MAX_BPS`.
    function setEmergencyUnwindGuard(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        mapping(address => EmergencyUnwindGuard) storage guards,
        address token,
        uint256 minUsdcOut,
        bool overrideAllowed,
        uint256 maxLossBps
    ) public {
        if (maxLossBps > MAX_BPS) revert InvalidParam();
        activeAssetForToken(assets, token);
        uint256 oldMin = guards[token].minUsdcOut;
        guards[token] = EmergencyUnwindGuard({
            minUsdcOut: minUsdcOut, overrideAllowed: overrideAllowed, maxLossBps: maxLossBps
        });
        emit EmergencyUnwindGuardSet(token, oldMin, minUsdcOut, overrideAllowed, maxLossBps);
    }

    /// @notice Body of `BasketVault.setTwapWindow` after the vault's range check: `token` must be an
    ///         active asset whose pool holds enough observation history to serve `window` now
    ///         (core 1494: a window the pool cannot serve would make every NAV read revert).
    function setTwapWindow(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        mapping(address => uint32) storage twapWindow,
        address token,
        uint32 window
    ) public {
        BasketAssetConfigGuard.requireObservationHistory(
            activeAssetForToken(assets, token).pool, window
        );
        uint32 old = twapWindow[token];
        twapWindow[token] = window;
        emit TwapWindowUpdated(token, old, window);
    }

    /// @dev The ACTIVE row for `token`; reverts `AssetNotFound` when none is active.
    function activeAssetForToken(BasketAssetConfigGuard.AssetInfo[] storage assets, address token)
        internal
        view
        returns (BasketAssetConfigGuard.AssetInfo memory)
    {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (assets[i].active && assets[i].token == token) return assets[i];
        }
        revert AssetNotFound();
    }

    // ─── Private helpers ──────────────────────────────────────────────

    function _activeCount(BasketAssetConfigGuard.AssetInfo[] storage assets)
        private
        view
        returns (uint256 count)
    {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (assets[i].active) count++;
        }
    }

    /// @dev The `WeightSnapshot` arrays: each active asset with `MAX_BPS / n` bps, the first active
    ///      one also taking the `MAX_BPS % n` remainder.
    function _weightSnapshot(BasketAssetConfigGuard.AssetInfo[] storage assets, uint256 n)
        private
        view
        returns (address[] memory tokens, uint256[] memory weights)
    {
        tokens = new address[](n);
        weights = new uint256[](n);
        uint256 baseWeightBps = MAX_BPS / n;
        uint256 extra = MAX_BPS - baseWeightBps * n;
        uint256 idx;
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            tokens[idx] = assets[i].token;
            weights[idx] = baseWeightBps + extra;
            extra = 0;
            idx++;
        }
    }

    /// @dev Haircut a USDC (or token) value by the configured max slippage.
    function _applySlippage(uint256 value, uint256 maxSlippageBps) private pure returns (uint256) {
        return value * (MAX_BPS - maxSlippageBps) / MAX_BPS;
    }

    /// @dev Buy leg `i`: `swapIn` USDC for the asset at its slippage-bounded TWAP floor.
    function _buyLeg(
        BasketAssetConfigGuard.AssetInfo storage a,
        Venue memory v,
        uint256 i,
        uint256 swapIn
    ) private {
        uint256 minOut = _applySlippage(
            IBasketValuation(address(this)).assetTokenValue(i, swapIn), v.maxSlippageBps
        );
        address token = a.token;
        uint256 amountOut = _executeSwap(v, a.adapter, v.usdc, token, a.swapFee, swapIn, minOut);
        emit Swapped(v.usdc, token, swapIn, amountOut);
    }

    /// @dev Sell leg `i` of a proportional redeem; returns the USDC it received (0 when skipped).
    function _sellLeg(
        BasketAssetConfigGuard.AssetInfo storage a,
        Venue memory v,
        uint256 i,
        uint256 shares,
        uint256 supplyBefore
    ) private returns (uint256 received) {
        address token = a.token;
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return 0;
        uint256 sellAmount = bal.mulDiv(shares, supplyBefore);
        if (sellAmount == 0) return 0;
        // Core 1778: price one input unit less (a one-unit leg floors at zero and is skipped).
        uint256 minUsdcOut = _applySlippage(
            IBasketValuation(address(this)).assetUsdcValue(i, sellAmount - 1), v.maxSlippageBps
        );
        // QA plan D6 (E4, SR-L12): a zero floor means the leg is worth about one USDC unit or less.
        if (minUsdcOut == 0) return 0;
        received = _executeSwap(v, a.adapter, token, v.usdc, a.swapFee, sellAmount, minUsdcOut);
        emit Swapped(token, v.usdc, sellAmount, received);
    }

    /// @dev One `emergencyUnwind` leg.
    function _unwindLeg(
        BasketAssetConfigGuard.AssetInfo storage a,
        mapping(address => EmergencyUnwindGuard) storage guards,
        Venue memory v,
        uint256 i
    ) private {
        BasketAssetConfigGuard.AssetInfo memory assetInfo = a;
        uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
        if (bal == 0) return;
        uint256 configuredMin = guards[assetInfo.token].minUsdcOut;
        uint256 effectiveFloor;
        try IBasketValuation(address(this)).assetUsdcValue(i, bal) returns (uint256 twapValue) {
            uint256 twapFloor = _applySlippage(twapValue, v.maxSlippageBps);
            // QA plan D6: dust (a floor that rounds to zero) stays put whatever the configured
            // minimum. Its sale can pay zero, which the V4 adapter refuses. `removeAsset` accepts it.
            if (twapFloor == 0) return;
            effectiveFloor = twapFloor > configuredMin ? twapFloor : configuredMin;
        } catch {
            if (configuredMin == 0) revert EmergencyFloorUnavailable(assetInfo.token);
            effectiveFloor = configuredMin;
        }
        _swapAllToUsdc(v, assetInfo, effectiveFloor);
    }

    // slither-disable-start reentrancy-balance
    // The callers hold the vault's `nonReentrant` guard, so the pre-call `balanceOf` read cannot be
    // observed by a reentrant call before the swap completes; `Swapped` uses the returned amount.
    /// @dev Sell the vault's whole balance of `assetInfo.token` for at least `minUsdcOut` USDC.
    ///      A zero balance or a zero floor is a no-op that returns 0 (QA plan D6: a zero floor marks
    ///      dust; its sale can pay zero, which the V4 adapter refuses). Returns the USDC received.
    function _swapAllToUsdc(
        Venue memory v,
        BasketAssetConfigGuard.AssetInfo memory assetInfo,
        uint256 minUsdcOut
    ) private returns (uint256 received) {
        uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
        if (bal == 0 || minUsdcOut == 0) return 0;
        received = _executeSwap(
            v, assetInfo.adapter, assetInfo.token, v.usdc, assetInfo.swapFee, bal, minUsdcOut
        );
        emit Swapped(assetInfo.token, v.usdc, bal, received);
    }

    /// @dev Override-path sale: passes `appliedFloor` as the router-level `amountOutMinimum` and also
    ///      enforces it with the typed `EmergencyUnwindLossCapExceeded`, so callers see one error
    ///      whatever the router's own slippage revert looks like. Unlike `_swapAllToUsdc`, a zero
    ///      floor still sells: `maxLossBps == MAX_BPS` is the legacy zero-floor override.
    function _swapAllToUsdcWithCap(
        Venue memory v,
        BasketAssetConfigGuard.AssetInfo memory assetInfo,
        uint256 appliedFloor
    ) private {
        uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
        if (bal == 0) return;
        uint256 received = _executeSwap(
            v, assetInfo.adapter, assetInfo.token, v.usdc, assetInfo.swapFee, bal, appliedFloor
        );
        if (received < appliedFloor) {
            revert EmergencyUnwindLossCapExceeded(assetInfo.token, received, appliedFloor);
        }
        emit Swapped(assetInfo.token, v.usdc, bal, received);
    }

    // slither-disable-end reentrancy-balance

    /// @dev Route a swap through the per-asset adapter when set, or the default Uniswap V3 router.
    ///      Approves exactly `amountIn` before the call and clears the approval after. Output goes to
    ///      the vault (`address(this)`). The deadline is the current block: every swap executes
    ///      synchronously inside the caller's transaction, equivalent to a tx-level deadline
    ///      (audit 2026-06-09, L-5). External integrators calling adapters directly MUST supply a
    ///      real deadline.
    function _executeSwap(
        Venue memory v,
        address adapter,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut
    ) private returns (uint256 amountOut) {
        if (adapter != address(0)) {
            // Adapter pulls `tokenIn` from this contract via transferFrom.
            IERC20(tokenIn).forceApprove(adapter, amountIn);
            amountOut = IBasketSwapAdapter(adapter)
                .swap(
                    tokenIn, tokenOut, fee, amountIn, minAmountOut, address(this), block.timestamp
                );
            IERC20(tokenIn).forceApprove(adapter, 0);
        } else {
            // Default Uniswap V3 path (backward-compatible).
            IERC20(tokenIn).forceApprove(address(v.router), amountIn);
            amountOut = v.router
                .exactInputSingle(
                    ISwapRouter.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                        fee: fee,
                        recipient: address(this),
                        amountIn: amountIn,
                        amountOutMinimum: minAmountOut,
                        sqrtPriceLimitX96: 0
                    })
                );
            IERC20(tokenIn).forceApprove(address(v.router), 0);
        }
    }
}
