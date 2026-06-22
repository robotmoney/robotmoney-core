// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0003-basketvault-rebalancing-model.md
//            docs/architecture.md §8 — cost-preview / realized-weight views
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TwapTickMath} from "./TwapTickMath.sol";

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
}

/// @title BasketViews
/// @notice Off-chain weight-preview views for `BasketVault`, extracted into an
///         externally-linked (DELEGATECALL) library so the array-building loops
///         are NOT inlined into every vault in the already-EIP-170-tight basket
///         family. Arithmetic is identical to the prior inline implementations.
library BasketViews {
    using Math for uint256;

    uint256 internal constant MAX_BPS = 10_000;

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
