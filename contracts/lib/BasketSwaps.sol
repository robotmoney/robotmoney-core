// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (basket swaps and emergency unwind)
// (See also: contracts/vaults/BasketVault.sol; issue #428 — guarded emergency unwind minimums;
//            issue 1808 — moved out of the vault so the proxied basket family fits EIP-170)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {BasketAssetConfigGuard} from "./BasketAssetConfigGuard.sol";
import {ForeignTokenQuarantine} from "./ForeignTokenQuarantine.sol";
import {BpsMath} from "./BpsMath.sol";

/// @dev The vault getters the emergency unwind reads from `address(this)` (the vault).
interface IBasketSwapsVault {
    function emergencyUnwindGuard(address token)
        external
        view
        returns (uint256 minUsdcOut, bool overrideAllowed, uint256 maxLossBps);
    function maxSlippageBps() external view returns (uint256);
    function emergencyTwapUsdcValue(BasketAssetConfigGuard.AssetInfo calldata a, uint256 amount)
        external
        view
        returns (uint256);
}

/// @title BasketSwaps
/// @notice The basket vault's one swap executor and its two emergency unwinds, as an externally
///         linked library. Its code runs by DELEGATECALL as the vault (`address(this)` is the
///         vault, `msg.sender` is the vault's caller), so approvals, balances and events are the
///         vault's. The logic is the code `BasketVault` carried inline before issue 1808,
///         unchanged; it moved so the proxied basket family fits EIP-170. Every swap pays the
///         vault itself: there is no caller-supplied recipient (INV-1).
library BasketSwaps {
    using SafeERC20 for IERC20;

    uint256 internal constant MAX_BPS = BpsMath.BPS_DENOMINATOR;

    /// @dev Same signatures as the `BasketVault` events (the vault declares them for its ABI).
    event Swapped(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );
    event EmergencyUnwindOverrideUsed(
        address indexed token,
        uint256 amountIn,
        uint256 minUsdcOut,
        uint256 appliedFloor,
        address indexed caller
    );

    /// @dev Same selectors as the `BasketVault` errors.
    error EmergencyFloorUnavailable(address token);
    error EmergencyUnwindOverrideDisabled();
    error EmergencyUnwindLossCapExceeded(address token, uint256 received, uint256 appliedFloor);
    error AssetNotFound();
    error AssetInBasket();
    error SlippageExceeded();

    /// @notice Swap `amountIn` of `tokenIn` to `tokenOut` for the vault, through the asset's
    ///         adapter when set, else the Uniswap V3 `router`. Approval is set before the call
    ///         and cleared after. The deadline is the current block: every swap runs
    ///         synchronously inside the caller's transaction (audit 2026-06-09, L-5).
    function swap(
        address adapter,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        ISwapRouter router
    ) public returns (uint256 amountOut) {
        if (adapter != address(0)) {
            // Adapter pulls `tokenIn` from the vault via transferFrom.
            IERC20(tokenIn).forceApprove(adapter, amountIn);
            amountOut = IBasketSwapAdapter(adapter)
                .swap(
                    tokenIn, tokenOut, fee, amountIn, minAmountOut, address(this), block.timestamp
                );
            IERC20(tokenIn).forceApprove(adapter, 0);
        } else {
            IERC20(tokenIn).forceApprove(address(router), amountIn);
            amountOut = router.exactInputSingle(
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
            IERC20(tokenIn).forceApprove(address(router), 0);
        }
    }

    /// @notice `BasketVault.emergencyUnwind` after the deposit halt: swap every active asset's
    ///         balance to USDC. The per-leg floor is max(TWAP-derived, configured minUsdcOut).
    ///         With the oracle unavailable a non-zero configured floor is required.
    // slither-disable-next-line reentrancy-balance
    function unwindAll(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        address usdc,
        ISwapRouter router
    ) public {
        uint256 slippageBps = IBasketSwapsVault(address(this)).maxSlippageBps();
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            BasketAssetConfigGuard.AssetInfo memory a = assets[i];
            uint256 bal = IERC20(a.token).balanceOf(address(this));
            if (bal == 0) continue;
            _swapToUsdc(a, bal, _emergencyFloor(a, bal, slippageBps), usdc, router);
        }
    }

    /// @notice `BasketVault.emergencyUnwindWithOverride` after the deposit halt: for each named
    ///         active token whose guard permits overrides, swap its balance to USDC under the
    ///         oracle-independent loss cap `minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`,
    ///         emitting `EmergencyUnwindOverrideUsed` before each swap.
    // slither-disable-next-line reentrancy-balance
    function unwindWithOverride(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        address[] calldata tokens,
        address usdc,
        ISwapRouter router
    ) public {
        uint256 len = tokens.length;
        for (uint256 i = 0; i < len; i++) {
            (uint256 minUsdcOut, bool overrideAllowed, uint256 maxLossBps) =
                IBasketSwapsVault(address(this)).emergencyUnwindGuard(tokens[i]);
            if (!overrideAllowed) revert EmergencyUnwindOverrideDisabled();
            BasketAssetConfigGuard.AssetInfo memory a = _activeAssetForToken(assets, tokens[i]);
            uint256 bal = IERC20(a.token).balanceOf(address(this));
            if (bal == 0) continue;
            uint256 appliedFloor = minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS;
            emit EmergencyUnwindOverrideUsed(a.token, bal, minUsdcOut, appliedFloor, msg.sender);
            uint256 received = _swapToUsdc(a, bal, appliedFloor, usdc, router);
            if (received < appliedFloor) {
                revert EmergencyUnwindLossCapExceeded(a.token, received, appliedFloor);
            }
        }
    }

    /// @notice `BasketVault.reabsorbRemovedAsset`: swap a balance that reappeared on a removed
    ///         (inactive) asset back to USDC into NAV under the TWAP-derived, slippage-bounded
    ///         floor, which must not undercut the caller's `minUsdcOut` (AZ-BSK-5). When the
    ///         pool is degraded (the TWAP read reverts) the balance is swept to the fixed
    ///         quarantine address instead of being stranded (LIFE-6). No caller-supplied
    ///         recipient (INV-1). Panics on an out-of-range `index`.
    // slither-disable-next-line reentrancy-balance
    function reabsorb(
        BasketAssetConfigGuard.AssetInfo[] storage assets,
        uint256 index,
        uint256 minUsdcOut,
        address usdc,
        ISwapRouter router
    ) public {
        BasketAssetConfigGuard.AssetInfo memory a = assets[index];
        if (a.active) revert AssetInBasket();
        uint256 bal = IERC20(a.token).balanceOf(address(this));
        IBasketSwapsVault self = IBasketSwapsVault(address(this));
        try self.emergencyTwapUsdcValue(a, bal) returns (uint256 twapValue) {
            uint256 floor = twapValue * (MAX_BPS - self.maxSlippageBps()) / MAX_BPS;
            if (floor < minUsdcOut) revert SlippageExceeded();
            if (bal != 0) _swapToUsdc(a, bal, floor, usdc, router);
        } catch {
            ForeignTokenQuarantine.sweep(a.token, msg.sender);
        }
    }

    /// @dev max(TWAP-derived floor, configured minUsdcOut). With the oracle unavailable (the
    ///      self-only `emergencyTwapUsdcValue` reverts) a non-zero configured floor is required.
    function _emergencyFloor(
        BasketAssetConfigGuard.AssetInfo memory a,
        uint256 bal,
        uint256 slippageBps
    ) private view returns (uint256) {
        IBasketSwapsVault self = IBasketSwapsVault(address(this));
        (uint256 configuredMin,,) = self.emergencyUnwindGuard(a.token);
        try self.emergencyTwapUsdcValue(a, bal) returns (uint256 twapValue) {
            uint256 twapFloor = twapValue * (MAX_BPS - slippageBps) / MAX_BPS;
            return twapFloor > configuredMin ? twapFloor : configuredMin;
        } catch {
            if (configuredMin == 0) revert EmergencyFloorUnavailable(a.token);
            return configuredMin;
        }
    }

    /// @dev Swap `bal` of the asset to USDC under `floor` and emit `Swapped`.
    function _swapToUsdc(
        BasketAssetConfigGuard.AssetInfo memory a,
        uint256 bal,
        uint256 floor,
        address usdc,
        ISwapRouter router
    ) private returns (uint256 received) {
        received = swap(a.adapter, a.token, usdc, a.swapFee, bal, floor, router);
        emit Swapped(a.token, usdc, bal, received);
    }

    function _activeAssetForToken(BasketAssetConfigGuard.AssetInfo[] storage assets, address token)
        private
        view
        returns (BasketAssetConfigGuard.AssetInfo memory)
    {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (assets[i].active && assets[i].token == token) return assets[i];
        }
        revert AssetNotFound();
    }
}
