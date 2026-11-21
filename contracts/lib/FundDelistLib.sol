// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 rules 4-7, §5.11.4, §5.11.5, §7 RB-19 & RB-34;
//            docs/technical/one-vault-timed-flows-eng-plan.md E32, E38, E39, E43, E50, E53, E55, E57
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {RobotMoneyVaultOps} from "./RobotMoneyVaultOps.sol";
import {ExclusionLedger} from "../ExclusionLedger.sol";
import {FundExclusionLedger} from "../FundExclusionLedger.sol";
import {
    AssetConfig,
    AssetKind,
    FeedStatus,
    FundInitParams,
    IFundEvents,
    Plan,
    PlanStatus,
    BPS,
    DEFAULT_MIN_SEED_USDC,
    DEFAULT_POOL_SHARE_BPS,
    DEFAULT_IN_KIND_BPS,
    DEFAULT_IN_KIND_FLOOR_USDC,
    DEFAULT_IN_KIND_PERIOD
} from "../FundTypes.sol";
import {IExactOutSwapAdapter} from "../interfaces/IFlowAdapters.sol";
import {IFlowQueue} from "../interfaces/IFlowQueue.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {DelistClaimAccount, FundState, FundStorage} from "./FundStorage.sol";
import {FundAdapterGuard} from "./FundAdapterGuard.sol";
import {FundValuationLib} from "./FundValuationLib.sol";

/// @title FundDelistLib
/// @notice Delisting sales, delisting claim accumulators, asset admission rules 4/6/7 helpers, and
///         initialization with ledger creation for `RobotMoneyFund`, linked externally via DELEGATECALL
///         to preserve EIP-170 headroom. Custody (`safeTransfer` / `forceApprove`) stays in `FundFlowsLib` / `RobotMoneyFund` (G1).
library FundDelistLib {
    using Math for uint256;

    /// @notice Pause an Open/Halted plan on `shutdown` or `emergencyUnwind`, clearing any lazy-expiry deadline.
    function unwindPausePlan(FundState storage s) public {
        s.rebalancePausedUntil = 0;
        Plan storage p = s.plan;
        PlanStatus st = p.status;
        if (st == PlanStatus.Open || st == PlanStatus.Halted) {
            p.status = PlanStatus.Paused;
            emit IFundEvents.PlanStatusChanged(p.id, st, PlanStatus.Paused);
        }
    }

    /// @notice Materialize lazy expiry of `rebalancePausedUntil` in storage if expired while not shut down.
    function syncExpiredPause(FundState storage s) public {
        Plan storage p = s.plan;
        PlanStatus to = FundValuationLib.effectivePlanStatus(s);
        if (to != p.status) {
            s.rebalancePausedUntil = 0;
            PlanStatus from = p.status;
            p.status = to;
            emit IFundEvents.PlanStatusChanged(p.id, from, to);
        }
    }

    /// @notice Rule 6 (E43, RUN-01, OPS-04): require fixed-fee pool and `poolFeeBps + feeMarginBps < legBandBps`.
    function requireBasketFeeAdmission(
        FundState storage s,
        address adapter,
        address pool,
        uint24 poolFeePips
    ) public view {
        FundAdapterGuard.vet(s, adapter);
        bool fixedFee;
        try IExactOutSwapAdapter(adapter).isFixedFeePool(pool) returns (bool isFixed) {
            fixedFee = isFixed;
        } catch {}
        if (!fixedFee) revert IRobotMoneyFund.PoolNotFixedFee(pool);

        uint256 feeBps = (uint256(poolFeePips) + 99) / 100;
        try IExactOutSwapAdapter(adapter).poolFeeBps(pool) returns (uint24 reported) {
            feeBps = reported;
        } catch {}

        address q = s.flowQueue;
        if (q != address(0)) {
            uint256 legBandBps = IFlowQueue(q).flowParams().legBandBps;
            if (feeBps + s.feeMarginBps >= legBandBps) {
                revert IRobotMoneyFund.PoolFeeMarginTooSmall(feeBps, s.feeMarginBps, legBandBps);
            }
        }
    }

    /// @notice Enforce Rule 6 (and forbid non-zero target for `inSale` assets) across target vector `endBps`.
    function requireTargetsFeeBand(FundState storage s, uint16[] memory endBps) public view {
        uint256 n = endBps.length;
        for (uint256 i; i < n; ++i) {
            if (s.inSale[i] && endBps[i] != 0) revert IRobotMoneyFund.AssetInSale(i);
            AssetConfig storage a = s.assets[i];
            if (endBps[i] == 0 || !a.active || a.kind != AssetKind.Basket) continue;
            requireBasketFeeAdmission(s, a.adapter, a.pool, a.poolFee);
        }
    }

    /// @notice ADMIN_ROLE. Open a delisting sale on active Basket asset `index` (D19, D30, E53).
    function delistAsset(FundState storage s, uint256 index) public {
        if (index >= s.assets.length) revert IFundEvents.InvalidAssetIndex(index);
        AssetConfig storage a = s.assets[index];
        if (!a.active || a.kind != AssetKind.Basket) revert IFundEvents.InvalidAssetIndex(index);
        if (s.inSale[index]) revert IRobotMoneyFund.AssetInSale(index);

        s.inSale[index] = true;
        s.targetBps[index] = 0;
        Plan storage p = s.plan;
        if (
            (p.status == PlanStatus.Open
                    || p.status == PlanStatus.Halted
                    || p.status == PlanStatus.Paused) && index < p.endBps.length
        ) {
            p.endBps[index] = 0;
        }

        uint256 tokenUnit = 10 ** IERC20Metadata(a.token).decimals();
        uint256 fallbackPx = _snapshotFallbackPrice(s, index, a, tokenUnit);
        s.saleFallbackPrice[index] = fallbackPx;

        uint256 fundTokens = FundValuationLib.heldBalance(s, index);
        uint256 startVal = fallbackPx == 0 ? 0 : fundTokens.mulDiv(fallbackPx, tokenUnit);
        s.saleStartValue[index] = startVal;
        emit IRobotMoneyFund.AssetDelisted(index, startVal, fallbackPx);
    }

    function _snapshotFallbackPrice(
        FundState storage s,
        uint256 index,
        AssetConfig storage a,
        uint256 tokenUnit
    ) private view returns (uint256) {
        (bool ok,, uint256 px) = FundValuationLib.feedPricePerToken(s, index);
        if (ok && px != 0) return px;
        if (s.lastGoodAssetPrice[index] != 0) return s.lastGoodAssetPrice[index];
        try IBasketSwapAdapter(FundAdapterGuard.vet(s, a.adapter))
            .twapPrice(a.pool, a.token, s.usdc, tokenUnit, a.twapWindow) returns (
            uint256 twapPx
        ) {
            if (twapPx != 0) return twapPx;
        } catch {}
        return 0;
    }

    /// @notice Record `claimTok` tokens set aside for `owner` during a redemption while asset `index` is `inSale`.
    ///         Non-dilutive relative to prior sales (`delistUsdcPerScaled`), split net vs linked fee by `feeBps`.
    function recordDelistClaim(
        FundState storage s,
        uint256 index,
        address owner,
        uint256 claimTok,
        uint256 feeBps
    ) public {
        if (claimTok == 0) return;
        uint256 claimedBefore = s.delistClaimedTokens[index];
        uint256 totalScaledBefore = s.delistTotalScaled[index];
        s.delistClaimedTokens[index] = claimedBefore + claimTok;

        uint256 addScaled = claimedBefore == 0
            ? claimTok * FundStorage.DELIST_UNIT_SCALE
            : claimTok.mulDiv(totalScaledBefore, claimedBefore);
        uint256 feeScaled = addScaled.mulDiv(feeBps, BPS);
        uint256 netScaled = addScaled - feeScaled;

        uint256 acc = s.delistUsdcPerScaled[index];
        if (netScaled != 0) {
            DelistClaimAccount storage c = s.delistClaims[index][owner];
            _harvestDelist(c, acc);
            c.scaled += netScaled;
        }
        if (feeScaled != 0) {
            DelistClaimAccount storage f = s.delistFeeLinked[index][owner];
            _harvestDelist(f, acc);
            f.scaled += feeScaled;
        }
        s.delistTotalScaled[index] = totalScaledBefore + addScaled;
        emit IRobotMoneyFund.DelistClaimRecorded(index, owner, claimTok);
    }

    /// @notice Prepare one bounded delisting sale step on `index`. Closes sale if zero tokens remain.
    function prepareDelistStep(FundState storage s, uint256 index, uint256 maxUsdcNotional)
        public
        returns (
            bool shouldSell,
            uint256 tokensToSell,
            uint256 minOut,
            uint256 expectedUsdc,
            uint256 fundTokensBefore,
            uint256 claimedBefore
        )
    {
        if (index >= s.assets.length) {
            revert IFundEvents.InvalidAssetIndex(index);
        }
        if (!s.inSale[index]) revert IRobotMoneyFund.AssetNotInSale(index);
        if (s.shutdown) return (false, 0, 0, 0, 0, 0);

        fundTokensBefore = FundValuationLib.heldBalance(s, index);
        claimedBefore = s.delistClaimedTokens[index];
        uint256 totalTokens = fundTokensBefore + claimedBefore;
        if (totalTokens == 0) {
            closeDelistSale(s, index);
            return (false, 0, 0, 0, 0, 0);
        }

        (bool ok, FeedStatus st, uint256 feedPx) = FundValuationLib.feedPricePerToken(s, index);
        if (!ok) revert IRobotMoneyFund.FeedUnhealthy(index, st);
        s.saleFallbackPrice[index] = feedPx;
        s.lastGoodAssetPrice[index] = feedPx;

        if (maxUsdcNotional == 0) return (false, 0, 0, 0, fundTokensBefore, claimedBefore);
        uint256 tokenUnit = 10 ** IERC20Metadata(s.assets[index].token).decimals();
        uint256 maxTokens = maxUsdcNotional.mulDiv(tokenUnit, feedPx);
        tokensToSell = maxTokens < totalTokens ? maxTokens : totalTokens;
        if (tokensToSell == 0) return (false, 0, 0, 0, fundTokensBefore, claimedBefore);

        expectedUsdc = tokensToSell.mulDiv(feedPx, tokenUnit);
        minOut = expectedUsdc.mulDiv(BPS - s.delistBandBps, BPS);
        shouldSell = true;
    }

    /// @notice Finalize accounting after a delisting swap (`executeDelistStep` enforces band/budget; `emergencyUnwind` skips them).
    function finalizeDelistSale(
        FundState storage s,
        uint256 index,
        uint256 tokensSold,
        uint256 usdcReceived,
        uint256 expectedUsdc,
        uint256 fundTokensBefore,
        uint256 claimedBefore,
        bool enforceLimits
    ) public returns (uint256 usdcClaim) {
        if (enforceLimits) {
            _enforceDelistLimits(s, index, usdcReceived, expectedUsdc);
        }

        uint256 totalBefore = fundTokensBefore + claimedBefore;
        uint256 claimedSold = (tokensSold >= totalBefore)
            ? claimedBefore
            : tokensSold.mulDiv(claimedBefore, totalBefore);
        usdcClaim = (claimedSold == 0 || tokensSold == 0)
            ? 0
            : (claimedSold == tokensSold
                    ? usdcReceived
                    : usdcReceived.mulDiv(claimedSold, tokensSold));

        if (claimedSold != 0) {
            _recordDelistClaimPot(s, index, claimedBefore, claimedSold, usdcClaim);
        }

        if (FundValuationLib.heldBalance(s, index) == 0 && s.delistClaimedTokens[index] == 0) {
            closeDelistSale(s, index);
        }
        emit IRobotMoneyFund.DelistStepExecuted(index, tokensSold, usdcReceived, usdcClaim);
    }

    function _enforceDelistLimits(
        FundState storage s,
        uint256 index,
        uint256 usdcReceived,
        uint256 expectedUsdc
    ) private {
        uint256 minOut = expectedUsdc.mulDiv(BPS - s.delistBandBps, BPS);
        if (usdcReceived < minOut) {
            revert IRobotMoneyFund.DelistBandExceeded(index, usdcReceived, minOut);
        }
        uint256 stepLoss = expectedUsdc > usdcReceived ? expectedUsdc - usdcReceived : 0;
        uint256 newLoss = s.delistLossSpent[index] + stepLoss;
        uint256 maxBudget = s.saleStartValue[index].mulDiv(s.delistBudgetBps, BPS);
        if (newLoss > maxBudget) {
            revert IRobotMoneyFund.DelistBudgetExceeded(index, newLoss, maxBudget);
        }
        s.delistLossSpent[index] = newLoss;
    }

    function _recordDelistClaimPot(
        FundState storage s,
        uint256 index,
        uint256 claimedBefore,
        uint256 claimedSold,
        uint256 usdcClaim
    ) private {
        s.delistClaimedTokens[index] = claimedBefore - claimedSold;
        uint256 totalScaled = s.delistTotalScaled[index];
        if (usdcClaim != 0 && totalScaled != 0) {
            s.delistUsdcPot[index] += usdcClaim;
            s.reservedClaimUsdc += usdcClaim;
            s.delistUsdcPerScaled[
                index
            ] += usdcClaim.mulDiv(FundStorage.DELIST_ACC_SCALE, totalScaled);
        }
    }

    /// @notice Close an `inSale` asset once zero tokens remain (`heldBalance == 0 && delistClaimedTokens == 0`),
    ///         deactivating it and recording `lastStateStopEndedAt` if no other `inSale` remains (E40, E53).
    function closeDelistSale(FundState storage s, uint256 index) public {
        if (!s.inSale[index]) return;
        s.inSale[index] = false;
        s.assets[index].active = false;
        s.targetBps[index] = 0;
        emit IRobotMoneyFund.AssetDeactivated(index);
        if (!FundValuationLib.hasAssetInSale(s) && block.timestamp > s.lastStateStopEndedAt) {
            s.lastStateStopEndedAt = uint64(block.timestamp);
        }
    }

    /// @notice Consume `owner`'s accrued delisting USDC pot (plus linked fee) into amounts ready for custody payout.
    function consumeDelistClaim(FundState storage s, uint256 index, address owner)
        public
        returns (uint256 netUsdc, uint256 feeUsdc, bool hasClaim)
    {
        if (owner == address(0)) revert IFundEvents.ZeroAddress();
        uint256 acc = s.delistUsdcPerScaled[index];
        DelistClaimAccount storage c = s.delistClaims[index][owner];
        DelistClaimAccount storage f = s.delistFeeLinked[index][owner];
        _harvestDelist(c, acc);
        _harvestDelist(f, acc);

        if (c.scaled == 0 && c.pendingUsdc == 0 && f.scaled == 0 && f.pendingUsdc == 0) {
            return (0, 0, false);
        }
        hasClaim = true;

        netUsdc = c.pendingUsdc;
        feeUsdc = f.pendingUsdc;
        uint256 pot = s.delistUsdcPot[index];
        uint256 totalPay = netUsdc + feeUsdc;
        if (totalPay > pot) {
            feeUsdc = totalPay == 0 ? 0 : pot.mulDiv(feeUsdc, totalPay);
            netUsdc = pot - feeUsdc;
            totalPay = pot;
        }
        s.delistUsdcPot[index] = pot - totalPay;
        s.reservedClaimUsdc -= totalPay;
        c.pendingUsdc = 0;
        f.pendingUsdc = 0;

        if (s.delistClaimedTokens[index] == 0) {
            uint256 burnScaled = c.scaled + f.scaled;
            s.delistTotalScaled[index] -= burnScaled;
            c.scaled = 0;
            f.scaled = 0;
            if (s.delistTotalScaled[index] == 0 && s.delistUsdcPot[index] != 0) {
                // Release negligible rounding dust back to fund idle USDC after the final claimer exits.
                s.reservedClaimUsdc -= s.delistUsdcPot[index];
                s.delistUsdcPot[index] = 0;
            }
        }
    }

    function _harvestDelist(DelistClaimAccount storage accEntry, uint256 acc) private {
        if (accEntry.scaled != 0) {
            uint256 delta = acc - accEntry.usdcDebt;
            if (delta != 0) {
                accEntry.pendingUsdc += accEntry.scaled.mulDiv(delta, FundStorage.DELIST_ACC_SCALE);
            }
        }
        accEntry.usdcDebt = acc;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Initialization & ledger creation
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Create the fund's `FundExclusionLedger` once (moved from `FundAdminLib` for EIP-170 headroom).
    function createLedger(address usdc) public returns (address ledger) {
        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        if (address(x.ledger) != address(0)) revert IFundEvents.InvalidParam();
        ledger = address(new FundExclusionLedger(address(this), IERC20(usdc)));
        x.ledger = ExclusionLedger(ledger);
    }

    /// @notice Validate `FundInitParams`, write core & Step 3d/3f defaults, and deploy the exclusion ledger.
    function initFlows(FundState storage s, FundInitParams memory p) public {
        if (
            p.usdc == address(0) || p.feeRecipient == address(0) || p.admin == address(0)
                || p.emergency == address(0)
        ) {
            revert IFundEvents.ZeroAddress();
        }
        if (
            p.exitFeeBps > FundStorage.MAX_EXIT_FEE_BPS
                || p.maxSlippageBps > FundStorage.MAX_SLIPPAGE_BPS || p.maxSlippageBps == 0
                || p.navDeviationGuardBps > FundStorage.MAX_NAV_DEVIATION_BPS
        ) {
            revert IFundEvents.InvalidParam();
        }
        s.usdc = p.usdc;
        s.tvlCap = p.tvlCap;
        s.perDepositCap = p.perDepositCap;
        s.exitFeeBps = p.exitFeeBps;
        s.feeRecipient = p.feeRecipient;
        s.maxSlippageBps = p.maxSlippageBps;
        s.navDeviationGuardBps = p.navDeviationGuardBps;

        s.minSeedUsdc = DEFAULT_MIN_SEED_USDC;
        s.poolShareBps = DEFAULT_POOL_SHARE_BPS;
        s.inKindBps = DEFAULT_IN_KIND_BPS;
        s.inKindFloorUsdc = DEFAULT_IN_KIND_FLOOR_USDC;
        s.inKindPeriod = DEFAULT_IN_KIND_PERIOD;
        s.minPoolDepthUsdc = FundStorage.DEFAULT_MIN_POOL_DEPTH_USDC;
        s.feeMarginBps = FundStorage.DEFAULT_FEE_MARGIN_BPS;
        s.delistBandBps = FundStorage.DEFAULT_DELIST_BAND_BPS;
        s.delistBudgetBps = FundStorage.DEFAULT_DELIST_BUDGET_BPS;
        s.maxBasketBps = FundStorage.DEFAULT_MAX_BASKET_BPS;
        createLedger(p.usdc);
    }
}
