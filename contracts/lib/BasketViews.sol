// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0003-basketvault-rebalancing-model.md
//            docs/architecture.md §7.1 — Previews (cost-preview / realized-weight views)
//            docs/technical/recorder-manipulation-1793.md (the USDC sell anchor, `checkSellAnchor`)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TwapTickMath} from "./TwapTickMath.sol";
import {IObservablePool} from "../interfaces/IObservablePool.sol";

/// @dev The one recorder-only read the sell anchor needs. A V4 asset's `pool` is always the
///      `UniswapV4PriceRecorder` (BasketAssetConfigGuard.Venue.V4), which answers it.
interface IRecorderHistory {
    function oldestObservation() external view returns (uint32);
}

/// @dev Minimal read surface of `BasketVault` consumed by the weight-preview
///      views. Declared here (not imported from BasketVault) to avoid a cyclic
///      library↔contract import.
interface IBasketVaultViews {
    function activeAssetCount() external view returns (uint256);
    function assetCount() external view returns (uint256);
    function assets(uint256 index)
        external
        view
        returns (
            address token,
            address pool,
            uint24 swapFee,
            bool active,
            address adapter,
            uint8 venue
        );
    function assetUsdcValue(uint256 index, uint256 amount) external view returns (uint256);
    function assetTokenValue(uint256 index, uint256 usdcAmount) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function effectiveTwapWindow(address token) external view returns (uint32);
    function asset() external view returns (address);
    function navDeviationGuardBps() external view returns (uint256);
    function maxSlippageBps() external view returns (uint256);
}

/// @title BasketViews
/// @notice Off-chain weight-preview views for `BasketVault`, extracted into an
///         externally-linked (DELEGATECALL) library so the array-building loops
///         are NOT inlined into every vault in the already-EIP-170-tight basket
///         family. Arithmetic is identical to the prior inline implementations.
library BasketViews {
    using Math for uint256;

    uint256 internal constant MAX_BPS = 10_000;

    /// @notice Window of the USDC sell anchor (core 1793, QA plan D5): 4 hours, eight times the 1800 s NAV window.
    /// @dev A displacement held for the 1800 s NAV window drags the NAV TWAP, and the sell floor with it, all the way to the
    ///      held price. The same hold moves this anchor by a quarter of the displacement at most, so a USDC redeem refuses
    ///      while the held spot sits more than the guard below it. The recorder ring must hold the window under one record
    ///      per 2 s block (14_400 / 2 + 1 = 7_201 slots, `DeployUniswapV4PriceRecorder.RING_SLOTS`), or a spammer could
    ///      evict the history and shorten the anchor to the NAV window.
    uint32 internal constant SELL_ANCHOR_WINDOW = 14_400;
    /// @dev `BasketAssetConfigGuard.Venue.V4`: the only venue whose TWAP is the in-protocol recorder (core 1676).
    uint8 internal constant VENUE_V4 = 1;
    /// @dev USDC amount priced both ways by the sell anchor: 1,000,000 USDC, so the token amount carries enough digits for a
    ///      basis-point compare even for a high-priced 8-decimal token. Decimals cancel in the ratio.
    uint256 internal constant SELL_ANCHOR_PROBE_USDC = 1e12;

    /// @notice A USDC redeem would sell `token` at a live price more than `thresholdBps` below its sell anchor (core 1793).
    ///         The holder exits through `redeemInKind`, which reads no price, or waits for the price to settle.
    /// @param token        The basket asset whose sale was refused.
    /// @param belowBps     How far the live price sits below the anchor, in basis points of the anchor price.
    /// @param thresholdBps The vault's `navDeviationGuardBps`.
    error SpotBelowSellAnchor(address token, uint256 belowBps, uint256 thresholdBps);

    /// @notice Build the per-asset shortlist (token, pool, fee, active, balance)
    ///         for off-chain/rmpc display. Externally linked so the array-building
    ///         loop is not inlined into the EIP-170-tight `AgentTokenVault`.
    function shortlist(IBasketVaultViews vault)
        public
        view
        returns (
            address[] memory tokens,
            address[] memory pools,
            uint24[] memory fees,
            bool[] memory active,
            uint256[] memory balances
        )
    {
        uint256 len = vault.assetCount();
        tokens = new address[](len);
        pools = new address[](len);
        fees = new uint24[](len);
        active = new bool[](len);
        balances = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            (address token, address pool, uint24 fee, bool act,,) = vault.assets(i);
            tokens[i] = token;
            pools[i] = pool;
            fees[i] = fee;
            active[i] = act;
            balances[i] = IERC20(token).balanceOf(address(vault));
        }
    }

    /// @notice ORA-4 / F-10 — revert if any active basket asset's executable
    ///         market (slot0 spot) price diverges from its NAV-pricing TWAP
    ///         beyond `thresholdBps`. No-op when `thresholdBps` is 0. Externally
    ///         linked so the per-asset loop is not inlined into the EIP-170-tight
    ///         vault family.
    /// @param vault       The basket vault (read surface).
    /// @param usdc        The quote token (USDC).
    /// @param thresholdBps Max permitted spot-vs-TWAP divergence in bps.
    function checkNavDeviation(IBasketVaultViews vault, address usdc, uint256 thresholdBps)
        public
        view
    {
        if (thresholdBps == 0) return;
        uint256 len = vault.assetCount();
        for (uint256 i = 0; i < len; i++) {
            (address token, address pool,, bool active,,) = vault.assets(i);
            if (!active) continue;
            // Probe a TWAP-priced token notional for ~1 USDC so decimals cancel.
            uint256 probe = vault.assetTokenValue(i, 1e6);
            TwapTickMath.requireWithinDeviation(
                pool, token, usdc, vault.effectiveTwapWindow(token), probe, thresholdBps
            );
        }
    }

    /// @notice The vault's one market-check entry point: the ORA-4 deviation guard on deposit (`sell` false) or the USDC
    ///         sell anchor on redeem (`sell` true), with the vault's own `navDeviationGuardBps` and USDC. Runs as the vault
    ///         (delegatecall) and reads both through self-calls, so each vault call site passes one bool (EIP-170).
    function checkMarket(bool sell) public view {
        IBasketVaultViews vault = IBasketVaultViews(address(this));
        address usdc = vault.asset();
        uint256 thresholdBps = vault.navDeviationGuardBps();
        if (sell) checkSellAnchor(vault, usdc, thresholdBps);
        else checkNavDeviation(vault, usdc, thresholdBps);
    }

    /// @notice USDC sell anchor (core 1793, QA plan D5). Revert `SpotBelowSellAnchor` when a USDC `redeem` would sell a held
    ///         Uniswap V4 basket asset at a live price more than `thresholdBps` below that asset's `SELL_ANCHOR_WINDOW` mean.
    ///         No-op when `thresholdBps` is 0. Externally linked so the loop is not inlined into the EIP-170-tight vault.
    /// @dev Why: the recorder is permissionless and moves 600 ticks per record, so a manipulator who holds the pool price
    ///      down drags the 1800 s NAV TWAP, and with it the TWAP sell floor, onto the held price within one window. Every
    ///      USDC redeem in that window then sells at the depressed price and passes the floor. The anchor needs the hold
    ///      to last `SELL_ANCHOR_WINDOW` instead. Only the sell side is gated: a live price ABOVE the anchor pays the
    ///      redeemer more, and deposits keep the ORA-4 guard (`checkNavDeviation`). Only V4 legs are gated: V3 and
    ///      Aerodrome pools write their own per-block observations and are deeper. A leg the vault holds none of is
    ///      skipped, because the redeem sells none of it. So is a leg the vault holds only dust of (QA plan D6): a balance
    ///      whose TWAP sale floor rounds to zero USDC units, which `BasketVault._sellProportional` never sells. Without
    ///      that, one donated wei after an unwind would refuse every USDC redeem while the price sits below the anchor.
    ///      The dust test prices the balance only on the refusal path, so a normal redeem pays no extra TWAP read.
    ///      `redeemInKind` never calls this, so the holder's oracle-free exit stays open (ADR-0007, core 1665).
    /// @param vault        The basket vault (read surface).
    /// @param usdc         The quote token (USDC).
    /// @param thresholdBps The vault's `navDeviationGuardBps`.
    function checkSellAnchor(IBasketVaultViews vault, address usdc, uint256 thresholdBps)
        public
        view
    {
        if (thresholdBps == 0) return;
        uint256 len = vault.assetCount();
        for (uint256 i = 0; i < len; i++) {
            (address token, address pool,, bool active,, uint8 venue) = vault.assets(i);
            if (!active || venue != VENUE_V4) continue;
            uint256 bal = IERC20(token).balanceOf(address(vault));
            if (bal == 0) continue;
            uint256 belowBps = spotBelowSellAnchorBps(pool, token, usdc);
            if (belowBps > thresholdBps && !_isDust(vault, i, bal)) {
                revert SpotBelowSellAnchor(token, belowBps, thresholdBps);
            }
        }
    }

    /// @dev QA plan D6: true when `bal` of asset `index` is dust, a balance whose TWAP sale floor
    ///      (`value * (MAX_BPS - maxSlippageBps) / MAX_BPS`, the vault's `_applySlippage`) rounds to zero USDC units.
    ///      The same test as `BasketAssetConfigGuard.deactivateAsset` and the vault's sell and unwind loops.
    function _isDust(IBasketVaultViews vault, uint256 index, uint256 bal)
        private
        view
        returns (bool)
    {
        return vault.assetUsdcValue(index, bal) * (MAX_BPS - vault.maxSlippageBps()) / MAX_BPS == 0;
    }

    /// @notice How far `token`'s live price on the recorder `pool` sits below its sell anchor, in basis points of the anchor
    ///         price. 0 when the live price is at or above the anchor. Monitors and tests read the same number the gate uses.
    function spotBelowSellAnchorBps(address pool, address token, address usdc)
        public
        view
        returns (uint256 bps)
    {
        uint32 window = sellAnchorWindow(pool);
        if (window == 0) return 0;
        // Price 1,000,000 USDC in `token` both ways. A lower token price buys MORE tokens, so the live price is below the
        // anchor exactly when `spotTokens > anchorTokens`, and (spot - anchor) / spot is 1 - livePrice / anchorPrice.
        uint256 anchorTokens = TwapTickMath.priceFromTick(
            TwapTickMath.meanTick(pool, window), usdc, token, SELL_ANCHOR_PROBE_USDC
        );
        (, int24 spotTick,,) = IObservablePool(pool).slot0();
        uint256 spotTokens =
            TwapTickMath.priceFromTick(spotTick, usdc, token, SELL_ANCHOR_PROBE_USDC);
        if (spotTokens <= anchorTokens) return 0;
        bps = (spotTokens - anchorTokens).mulDiv(MAX_BPS, spotTokens);
    }

    /// @notice The window the sell anchor reads on recorder `pool`: `SELL_ANCHOR_WINDOW`, or the recorder's whole history
    ///         when that is shorter (a young recorder). A shorter history weakens the anchor toward the NAV window; it never
    ///         blocks a redeem by itself. With the 7_201-slot ring the history reaches the full window 4 hours after the
    ///         recorder stage and no spammer can shorten it again.
    function sellAnchorWindow(address pool) public view returns (uint32 window) {
        uint32 age = uint32(block.timestamp) - IRecorderHistory(pool).oldestObservation();
        window = age < SELL_ANCHOR_WINDOW ? age : SELL_ANCHOR_WINDOW;
    }

    /// @notice Equal-weight cost preview: how `usdcAmount` would be allocated
    ///         across active assets at current TWAP prices.
    function previewDepositWeights(IBasketVaultViews vault, uint256 usdcAmount)
        public
        view
        returns (address[] memory activeAssets, uint256[] memory amountsOut)
    {
        uint256 n = vault.activeAssetCount();
        activeAssets = new address[](n);
        amountsOut = new uint256[](n);
        if (n == 0 || usdcAmount == 0) return (activeAssets, amountsOut);

        uint256 perAsset = usdcAmount / n;
        uint256 remainder = usdcAmount - perAsset * n;
        uint256 len = vault.assetCount();
        uint256 idx = 0;
        bool firstActive = true;

        for (uint256 i = 0; i < len; i++) {
            (address token, bool active) = _tokenActive(vault, i);
            if (!active) continue;
            uint256 swapIn = firstActive ? perAsset + remainder : perAsset;
            firstActive = false;
            activeAssets[idx] = token;
            amountsOut[idx] = swapIn > 0 ? vault.assetTokenValue(i, swapIn) : 0;
            idx++;
        }
    }

    /// @dev Read only the (token, active) fields of asset `index`, isolating the
    ///      6-tuple destructure so the caller loops stay shallow enough to compile
    ///      without viaIR.
    function _tokenActive(IBasketVaultViews vault, uint256 index)
        private
        view
        returns (address token, bool active)
    {
        (token,,, active,,) = vault.assets(index);
    }

    /// @notice Per-depositor realized weight vector in basis points.
    function realizedWeights(IBasketVaultViews vault, address depositor)
        public
        view
        returns (address[] memory activeAssets, uint256[] memory bpsWeights)
    {
        uint256 n = vault.activeAssetCount();
        activeAssets = new address[](n);
        bpsWeights = new uint256[](n);
        if (n == 0) return (activeAssets, bpsWeights);

        if (vault.balanceOf(depositor) == 0 || vault.totalSupply() == 0) {
            return (activeAssets, bpsWeights);
        }

        // bpsWeights is filled with per-asset USDC values, then normalized in place.
        uint256 totalValue = _fillRealizedValues(vault, depositor, activeAssets, bpsWeights);
        if (totalValue > 0) {
            for (uint256 j = 0; j < n; j++) {
                bpsWeights[j] = bpsWeights[j].mulDiv(MAX_BPS, totalValue);
            }
        }
    }

    /// @dev Populate `activeAssets`/`valuesOut` with each active asset's token and
    ///      the depositor's pro-rata USDC value; returns the summed value. Split
    ///      out of `realizedWeights` to keep both frames shallow (no viaIR).
    function _fillRealizedValues(
        IBasketVaultViews vault,
        address depositor,
        address[] memory activeAssets,
        uint256[] memory valuesOut
    ) private view returns (uint256 totalValue) {
        uint256 supply = vault.totalSupply();
        uint256 depositorShares = vault.balanceOf(depositor);
        uint256 len = vault.assetCount();
        uint256 idx = 0;
        for (uint256 i = 0; i < len; i++) {
            (address token, bool active) = _tokenActive(vault, i);
            if (!active) continue;
            uint256 depositorBal =
                Math.mulDiv(IERC20(token).balanceOf(address(vault)), depositorShares, supply);
            uint256 val = depositorBal > 0 ? vault.assetUsdcValue(i, depositorBal) : 0;
            activeAssets[idx] = token;
            valuesOut[idx] = val;
            totalValue += val;
            idx++;
        }
    }
}
