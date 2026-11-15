// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.3 (pro-rata deposits), §4.4 (redemptions),
//            §5.3 steps 5-8 (executeStep), §5.8 (threats), §5.9.3 checks 7 to 10 and §5.9.4 (timed flows), §6
//            (emergency unwind), §7 RB-3, RB-4, RB-6, RB-7, RB-13, RB-21; docs/technical/one-vault-timed-flows-eng-plan.md
//            E3, E4, E9, E14, E19 (`recordNav`), E20, E23; step 3e: proposal §5.10 and RB-19 (`executeStep`)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "../../../../interfaces/IStrategyAdapter.sol";
import {IBasketSwapAdapter} from "../../../../interfaces/IBasketSwapAdapter.sol";
import {ISwapRouter} from "../../../../interfaces/ISwapRouter.sol";
import {BasketSwaps} from "../../../../lib/BasketSwaps.sol";
import {RobotMoneyVaultOps} from "../../../../lib/RobotMoneyVaultOps.sol";
import {ExclusionLedger} from "../../../../ExclusionLedger.sol";
import {ForeignTokenQuarantine} from "../../../../lib/ForeignTokenQuarantine.sol";
import {
    AssetConfig,
    AssetKind,
    IFundEvents,
    Plan,
    PlanStatus,
    StepOrder,
    StepResult,
    BPS,
    IDLE_INDEX,
    MAX_STEP_COST_BPS,
    LENDING_ROUNDING_UNITS
} from "../FundTypes.sol";
import {PlanMath} from "../PlanMath.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {IExactOutSwapAdapter} from "../interfaces/IFlowAdapters.sol";
import {FundState} from "./FundStorage.sol";
import {FundValuationLib} from "./FundValuationLib.sol";
import {FundPositionLib} from "./FundPositionLib.sol";
import {FundDelistLib} from "./FundDelistLib.sol";
import {FundStepLib} from "./FundStepLib.sol";

/// @title FundFlowsLib
/// @notice Every value-moving path of `RobotMoneyFund` except the share mint/burn and the final payouts, as an
///         externally linked library (DELEGATECALL: `address(this)` is the fund, approvals and balances are
///         the fund's). Every swap goes through `BasketSwaps.swap` with the asset's allowlisted
///         `IBasketSwapAdapter` and pays the fund itself. Every USDC that leaves the fund here goes to an
///         allowlisted Lending adapter, a Basket swap adapter, or the fund's `ExclusionLedger` (RB-3, INV-1).
///         Recipients: the in-kind `receiver` (the holder's own choice, or the request owner the queue names), and
///         `caller` of the FLOW_ROLE functions (the FlowQueue: refunds of unused USDC and sale proceeds).
library FundFlowsLib {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ═════════════════════════════════════════════════════════════════════════
    //  Step 3d flows (proposal §4.3, §4.4, §5.9.3 checks 7 to 10; eng plan E3, E4, E14)
    //
    //  Removed from the live fund (D11, scaffold plan §7.2 item 1): the step 3c deposit path that minted on the
    //  realized TWAP NAV delta, its deficit-first routing against `currentTargetBps` (`PlanMath.deficitSplit`), and
    //  the synchronous `redeemPayout`. The frozen copy under contracts/test/prototype/baseline/ keeps them.
    //
    //  Rounding (INTERFACES.md §2): every purchase rounds UP, every amount paid out rounds DOWN, the mint is the
    //  caller's `sharesOut` (computed by the queue, rounded down). Lending legs move `LENDING_ROUNDING_UNITS` more
    //  on a supply and less on a withdrawal, so venue rounding of one or two units never fails check 10. Check 10
    //  itself is exact (`FundValuationLib.requireProportion`).
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Share units minted per USDC unit by `seed`: the fund's existing scale (`_decimalsOffset() == 18`), so the
    ///      first share costs par (`PRICE_SCALE / 1e18`).
    uint256 internal constant SEED_SHARES_PER_USDC = 1e18;

    uint8 internal constant FLOW_CLAIM_DEFERRED = 0;
    uint8 internal constant FLOW_CLAIM_POSITION = 1;
    uint8 internal constant FLOW_SETTLE_CLAIM = 2;
    uint8 internal constant FLOW_EMERGENCY_UNWIND = 3;
    uint8 internal constant FLOW_EMERGENCY_UNWIND_ASSET = 4;
    uint8 internal constant FLOW_SWEEP_FOREIGN = 5;

    /// @notice Body of `IRobotMoneyFund.seed` (E14). The fund checks ADMIN_ROLE, holds `nonReentrant` and mints the
    ///         returned shares to itself. Once, only at zero supply (`AlreadySeeded`), at least `minSeedUsdc`
    ///         (`SeedBelowMinimum`). Pulls `usdc` from `caller`; it stays idle until the first plan moves it.
    /// @param supply The fund's `totalSupply()` now.
    /// @return shares `usdc × 10^18`.
    function seed(FundState storage s, address caller, uint256 usdc, uint256 supply)
        public
        returns (uint256 shares)
    {
        if (s.seeded || supply != 0) revert IRobotMoneyFund.AlreadySeeded();
        uint256 minSeed = s.minSeedUsdc;
        if (usdc < minSeed) revert IRobotMoneyFund.SeedBelowMinimum(usdc, minSeed);
        s.seeded = true;
        IERC20(s.usdc).safeTransferFrom(caller, address(this), usdc);
        shares = usdc * SEED_SHARES_PER_USDC;
        emit IRobotMoneyFund.Seeded(usdc, shares);
        FundValuationLib.recordNav(s);
    }

    /// @notice Body of `IRobotMoneyFund.mintInKind` (E3, proposal §5.9.3 step 9) up to the mint. The fund checks
    ///         FLOW_ROLE, holds `nonReentrant`, then mints exactly `sharesOut` to `caller`.
    ///         1. Gates (defence in depth, the queue's check 1 already skips deposits then): `NotSeeded` at zero
    ///            supply, `DepositsArePaused`, `FundIsShutdown`, `DepositsClosedDuringExclusion`; `InvalidParam`
    ///            for `sharesOut == 0`; `LegLimitsLength`.
    ///         2. Check 7: snapshot idle and every counted asset's held amount (`FundValuationLib.heldAmounts`).
    ///         3. Pull `maxUsdc` from `caller`. For idle and each counted asset `want = ceil(held × sharesOut /
    ///            supply)`: idle keeps it; Lending supplies `want + LENDING_ROUNDING_UNITS` (a venue that keeps less
    ///            reverts `LendingSupplyRefused`); Basket buys exactly `want` tokens with `swapExactOut`, spending at
    ///            most `maxUsdcPerLeg[i]` (check 9; the venue reverts above it, and `FlowLegLimit` if the adapter
    ///            reports more).
    ///         4. `spent` = idle part + lending supplies + the swap inputs the adapters report. `MintInKindOverMax`
    ///            above `maxUsdc`; else `maxUsdc − spent` goes back to `caller`, so the caller's USDC falls by
    ///            exactly `spent` (never by a balance difference).
    ///         5. Check 10 with `supplyAfter = supply + sharesOut`. The mint that follows moves no asset, so the
    ///            comparison holds after it too. An adapter that under-delivers tokens or keeps unreported USDC
    ///            fails here.
    /// @param supply The fund's `totalSupply()` before the mint.
    function mintInKind(
        FundState storage s,
        address caller,
        uint256 sharesOut,
        uint256 maxUsdc,
        uint256[] memory maxUsdcPerLeg,
        uint256 supply
    ) public returns (uint256 spent) {
        if (supply == 0) revert IRobotMoneyFund.NotSeeded();
        if (FundValuationLib.isDepositsPaused(s) || FundValuationLib.hasAssetInSale(s)) {
            revert IRobotMoneyFund.DepositsArePaused();
        }
        if (s.shutdown) revert IRobotMoneyFund.FundIsShutdown();
        if (FundValuationLib.anyExcluded(s)) {
            revert IRobotMoneyFund.DepositsClosedDuringExclusion();
        }
        if (sharesOut == 0) revert IFundEvents.InvalidParam();
        uint256 n = s.assets.length;
        if (maxUsdcPerLeg.length != n) {
            revert IRobotMoneyFund.LegLimitsLength(maxUsdcPerLeg.length, n);
        }
        (uint256 idle0, uint256[] memory held0) = FundValuationLib.heldAmounts(s);
        address usdc = s.usdc;
        IERC20(usdc).safeTransferFrom(caller, address(this), maxUsdc);
        spent = idle0.mulDiv(sharesOut, supply, Math.Rounding.Ceil);
        for (uint256 i; i < n; ++i) {
            uint256 want = held0[i].mulDiv(sharesOut, supply, Math.Rounding.Ceil);
            if (want == 0) continue;
            AssetConfig storage a = s.assets[i];
            if (a.kind == AssetKind.Lending) {
                spent += _supplyLeg(s, i, want + LENDING_ROUNDING_UNITS);
            } else {
                spent += _buyExact(a, usdc, i, want, maxUsdcPerLeg[i]);
            }
        }
        if (spent > maxUsdc) revert IRobotMoneyFund.MintInKindOverMax(spent, maxUsdc);
        if (maxUsdc != spent) IERC20(usdc).safeTransfer(caller, maxUsdc - spent);
        FundValuationLib.requireProportion(s, idle0, held0, supply, supply + sharesOut);
        emit IRobotMoneyFund.MintedInKind(caller, sharesOut, spent, supply);
        FundValuationLib.recordNav(s);
    }

    /// @notice Body of `IRobotMoneyFund.sellForFlow`, `sellForFlowGross`, and `sellForFlowBatch` after the burn.
    ///         The fund checks FLOW_ROLE, holds `nonReentrant`, and has already burned `shares` of `caller`.
    ///         Net mode (`!ctx.grossOnly && !ctx.batch`) deducts `s.exitFeeBps`; gross mode transfers gross
    ///         and tags `ctx.feeBps` onto emitted claims; batch mode splits any claims directly onto `ctx.owners`
    ///         with linked fees at `ctx.ownerFeeBps`.
    function sellForFlow(
        FundState storage s,
        SellFlowCtx memory ctx,
        uint256[] memory minUsdcPerLeg
    ) public returns (uint256 payout) {
        if (!ctx.grossOnly && !ctx.batch) ctx.feeBps = s.exitFeeBps;
        ctx.usdc = s.usdc;
        return _sellForFlow(s, ctx, minUsdcPerLeg);
    }

    function sellForFlowGross(
        FundState storage s,
        address caller,
        uint256 shares,
        uint256[] memory minUsdcPerLeg,
        uint256 supplyBefore,
        uint256 claimFeeBps
    ) public returns (uint256 payout) {
        SellFlowCtx memory ctx;
        ctx.caller = caller;
        ctx.shares = shares;
        ctx.supplyBefore = supplyBefore;
        ctx.grossOnly = claimFeeBps != type(uint256).max;
        ctx.feeBps = ctx.grossOnly ? claimFeeBps : s.exitFeeBps;
        ctx.usdc = s.usdc;
        return _sellForFlow(s, ctx, minUsdcPerLeg);
    }

    struct SellFlowCtx {
        address caller;
        uint256 shares;
        uint256 supplyBefore;
        uint256 feeBps;
        address usdc;
        bool grossOnly;
        bool batch;
        address[] owners;
        uint256[] ownerShares;
        uint16[] ownerFeeBps;
    }

    function _sellForFlow(
        FundState storage s,
        SellFlowCtx memory ctx,
        uint256[] memory minUsdcPerLeg
    ) private returns (uint256 payout) {
        uint256 n = s.assets.length;
        if (minUsdcPerLeg.length != n) {
            revert IRobotMoneyFund.LegLimitsLength(minUsdcPerLeg.length, n);
        }
        (uint256 idle0, uint256[] memory held0) = FundValuationLib.heldAmounts(s);
        uint256 gross = idle0.mulDiv(ctx.shares, ctx.supplyBefore);
        for (uint256 i; i < n; ++i) {
            uint256 amt = held0[i].mulDiv(ctx.shares, ctx.supplyBefore);
            if (amt != 0) gross += _sellFlowLeg(s, ctx, i, amt, minUsdcPerLeg[i]);
        }
        uint256 fee = ctx.grossOnly ? 0 : gross.mulDiv(ctx.feeBps, BPS);
        payout = gross - fee;
        if (fee != 0) IERC20(ctx.usdc).safeTransfer(s.feeRecipient, fee);
        if (payout != 0) IERC20(ctx.usdc).safeTransfer(ctx.caller, payout);
        FundValuationLib.requireProportion(
            s, idle0, held0, ctx.supplyBefore, ctx.supplyBefore - ctx.shares
        );
        emit IRobotMoneyFund.SoldForFlow(ctx.caller, ctx.shares, gross, fee, payout);
        FundValuationLib.recordNav(s);
    }

    function _sellFlowLeg(
        FundState storage s,
        SellFlowCtx memory ctx,
        uint256 i,
        uint256 amt,
        uint256 minOut
    ) private returns (uint256) {
        AssetConfig memory a = s.assets[i];
        if (a.kind == AssetKind.Lending) {
            if (ctx.batch) {
                return FundPositionLib.takeForFlowBatch(
                    s,
                    i,
                    amt,
                    ctx.shares,
                    ctx.supplyBefore,
                    ctx.owners,
                    ctx.ownerShares,
                    ctx.ownerFeeBps
                );
            }
            return FundPositionLib.takeForFlow(
                s, i, amt, ctx.shares, ctx.supplyBefore, ctx.caller, ctx.feeBps, true
            );
        }
        if (s.inSale[i]) {
            if (ctx.batch) {
                _recordDelistBatch(s, i, amt, ctx);
            } else {
                FundDelistLib.recordDelistClaim(s, i, ctx.caller, amt, ctx.feeBps);
            }
            return 0;
        }
        uint256 got = _swap(a, a.token, ctx.usdc, amt, minOut);
        if (got < minOut) revert IRobotMoneyFund.FlowLegLimit(i, got, minOut);
        return got;
    }

    function _recordDelistBatch(
        FundState storage s,
        uint256 i,
        uint256 amt,
        SellFlowCtx memory ctx
    ) private {
        uint256 remAmt = amt;
        uint256 remShares = ctx.shares;
        for (uint256 k; k < ctx.owners.length && remAmt != 0; ++k) {
            uint256 os = ctx.ownerShares[k];
            if (os == 0) continue;
            uint256 slice = remShares == os ? remAmt : remAmt.mulDiv(os, remShares);
            remAmt -= slice;
            remShares -= os;
            if (slice != 0) {
                FundDelistLib.recordDelistClaim(s, i, ctx.owners[k], slice, ctx.ownerFeeBps[k]);
            }
        }
    }

    /// @dev `mintInKind` lending leg (own frame for stack depth): supply `ask` to lending asset `i` for the holders
    ///      (`FundPositionLib.supply` mints their units); a venue that keeps less reverts `LendingSupplyRefused`.
    function _supplyLeg(FundState storage s, uint256 i, uint256 ask) private returns (uint256) {
        uint256 placed = FundPositionLib.supply(s, i, ask);
        if (placed < ask) revert IRobotMoneyFund.LendingSupplyRefused(i, placed, ask);
        return ask;
    }

    /// @dev Buy exactly `amountOut` of Basket asset `a` with at most `limit` USDC through the asset's exact-output
    ///      adapter (`IExactOutSwapAdapter`, the step 3d test copies). Approve `limit`, swap with recipient = the
    ///      fund, clear the approval. Returns the input the adapter reports; the tokens are checked by check 10.
    function _buyExact(
        AssetConfig storage a,
        address usdc,
        uint256 i,
        uint256 amountOut,
        uint256 limit
    ) private returns (uint256 amountIn) {
        address adapter = a.adapter;
        IERC20(usdc).forceApprove(adapter, limit);
        amountIn = IExactOutSwapAdapter(adapter)
            .swapExactOut(
                usdc, a.token, a.poolFee, amountOut, limit, address(this), block.timestamp
            );
        IERC20(usdc).forceApprove(adapter, 0);
        if (amountIn > limit) revert IRobotMoneyFund.FlowLegLimit(i, amountIn, limit);
    }

    /// @notice Permissionless foreign-token sweep to the fixed quarantine address (INV-1/INV-2).
    function _sweepForeign(FundState storage s, address token, address caller) private {
        if (token == s.usdc || token == address(this)) {
            revert IRobotMoneyFund.ProtectedToken(token);
        }
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            if (token == s.assets[i].token || token == s.assets[i].adapter) {
                revert IRobotMoneyFund.ProtectedToken(token);
            }
        }
        emit IRobotMoneyFund.ForeignTokenSwept(token, ForeignTokenQuarantine.sweep(token, caller));
    }

    /// @notice Oracle-free, swap-free payout of `shares / supplyBefore` (§4.4 `redeemInKind`): the pro-rata
    ///         idle USDC plus the USDC withdrawn pro rata from each counted Lending adapter as one USDC leg,
    ///         then each active Basket token's pro-rata balance. Each leg pays `exitFeeBps` to
    ///         `feeRecipient` and the rest to `receiver` (the caller's own ERC-4626 receiver, INV-1).
    /// @dev Port of `BasketAssetConfigGuard.payInKind` plus the `RobotMoneyVault` lending pull. No TWAP read,
    ///      no swap, never gated by plan state, pause or shutdown (RB-6).
    ///
    ///      Venue freeze (§5.8 row 7: "`redeemInKind` remains open"). One frozen venue must not lock every
    ///      holder of the one vault in. So a leg that cannot pay out does not revert the exit:
    ///      - Lending: `withdraw(want)` runs under try/catch; whatever did not arrive (a revert, a paused
    ///        reserve, 100% utilization, a short fill) is DEFERRED, not forfeited.
    ///      - Basket: each transfer (to the receiver, then the fee) is attempted; one that fails is DEFERRED.
    ///      A deferred amount stays where it is (tokens in the fund, USDC in the adapter) but leaves the
    ///      holders' books: `deferredTotal[i]` is subtracted by `heldBalance`, so NAV and every later pro-rata
    ///      leg exclude it, and the stayers neither gain nor lose by the freeze. The owed account later pulls it
    ///      with `claimDeferred`. The fee share is deferred to `feeRecipient` the same way, so the split is
    ///      exactly what an unfrozen exit would have paid. A Lending claim is a fixed USDC amount: interest on
    ///      it, and any later venue loss, stay with the holders (prototype simplification).
    ///      The idle USDC leg uses a plain transfer: USDC failing for the fund itself stops every path.
    ///
    ///      Step 3d (fund-core, proposal §5.9.4, RB-13): the legs are taken from one check 7 snapshot, each Lending
    ///      leg asks for `LENDING_ROUNDING_UNITS` less than its exact part (nothing when that part is ≤ the margin),
    ///      and check 10 is asserted at the end with `supplyAfter = supplyBefore − shares`.
    ///
    ///      Step 3d (fund-extras: E9, E20, E23, RB-21). The step 3c lending deferral above (a fixed USDC claim) is
    ///      gone for lending legs: `FundPositionLib.inKindLending` pays the lending part in USDC up to the period's
    ///      in-kind allowance and turns the rest, and any part a venue cannot pay, into a claim on a share of the
    ///      position. E23: `receiver == address(0)` reverts `ZeroAddress`; the snapshot reads each lending venue's
    ///      value under try/catch, and a venue whose read reverts becomes a claim on the exiter's units of it with no
    ///      read at all (check 10 then skips that asset: its held amount cannot be read, and its units move exactly);
    ///      every claim and every basket deferral is keyed to `owner`, or to `receiver` when `owner` is the bound
    ///      FlowQueue (escrowed shares: `receiver` is the request's owner, E9).
    function payInKind(
        FundState storage s,
        address receiver,
        address owner,
        uint256 shares,
        uint256 supplyBefore
    ) public {
        if (receiver == address(0)) revert IFundEvents.ZeroAddress();
        address claimant = owner == s.flowQueue ? receiver : owner;
        (uint256 idle0, uint256[] memory held0, uint256[] memory pos0) = _inKindSnapshot(s);
        uint256 usdcLeg = idle0.mulDiv(shares, supplyBefore)
            + FundPositionLib.inKindLending(s, held0, pos0, claimant, shares, supplyBefore);
        _payLeg(s.usdc, receiver, usdcLeg, s.exitFeeBps, s.feeRecipient);
        _inKindBasket(s, held0, receiver, claimant, shares, supplyBefore);
        FundValuationLib.requireProportion(s, idle0, held0, supplyBefore, supplyBefore - shares);
    }

    /// @dev Check 7 snapshot of the in-kind exit, tolerant of a lending venue whose value read reverts (E23): idle
    ///      USDC; per COUNTED asset the holders' held amount (`held`); per counted lending asset its position value
    ///      (`pos`), or `FundPositionLib.UNREADABLE` with `held` 0 when `totalAssets()` reverted.
    function _inKindSnapshot(FundState storage s)
        private
        view
        returns (uint256 idle, uint256[] memory held, uint256[] memory pos)
    {
        idle = FundValuationLib.idleUsdc(s);
        uint256 n = s.assets.length;
        held = new uint256[](n);
        pos = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            if (!FundValuationLib.isCounted(s, i)) continue;
            AssetConfig storage a = s.assets[i];
            if (a.kind == AssetKind.Basket) {
                held[i] = FundValuationLib.heldBalance(s, i);
                continue;
            }
            try IStrategyAdapter(a.adapter).totalAssets() returns (uint256 p) {
                uint256 owed = s.deferredTotal[i];
                p = p > owed ? p - owed : 0;
                pos[i] = p;
                held[i] = FundValuationLib.holdersPart(s, i, p);
            } catch {
                pos[i] = FundPositionLib.UNREADABLE;
            }
        }
    }

    /// @dev `payInKind` Basket legs (own frame for stack depth): each counted token's part, net of the fee; a
    ///      transfer that fails is deferred to `claimant` (E23: keyed to the owner, who can pull it to any address).
    function _inKindBasket(
        FundState storage s,
        uint256[] memory held0,
        address receiver,
        address claimant,
        uint256 shares,
        uint256 supplyBefore
    ) private {
        uint256 n = held0.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (a.kind != AssetKind.Basket) continue;
            uint256 amount = held0[i].mulDiv(shares, supplyBefore);
            if (amount == 0) continue;
            uint256 feeAmt = amount.mulDiv(s.exitFeeBps, BPS);
            if (!_tryTransfer(a.token, receiver, amount - feeAmt)) {
                _deferSplit(s, i, amount, claimant);
            } else if (feeAmt != 0 && !_tryTransfer(a.token, s.feeRecipient, feeAmt)) {
                _defer(s, i, s.feeRecipient, feeAmt);
            }
        }
    }

    /// @notice Pay `account` everything it is owed from asset `index` (`IRobotMoneyFund.claimDeferred`), to
    ///         `to` (the account's own choice, as an ERC-4626 receiver). Basket: transfer the tokens. Lending:
    ///         `withdraw` exactly the owed USDC from the adapter (`DeferredShortfall` when it delivers less, so
    ///         the claim stays whole) and transfer it. Works whatever the asset's status (inactive, excluded):
    ///         the claim was fixed at exit time. Reverts `NothingDeferred` when nothing is owed.
    function _claimDeferred(FundState storage s, uint256 index, address account, address to)
        private
        returns (uint256 amount)
    {
        if (to == address(0)) revert IFundEvents.ZeroAddress();
        amount = s.deferredOf[index][account];
        if (amount == 0) revert IRobotMoneyFund.NothingDeferred(index, account);
        s.deferredOf[index][account] = 0;
        s.deferredTotal[index] -= amount;
        AssetConfig storage a = s.assets[index];
        if (a.kind == AssetKind.Lending) {
            IERC20 usdc = IERC20(s.usdc);
            uint256 before = usdc.balanceOf(address(this));
            IStrategyAdapter(a.adapter).withdraw(amount);
            uint256 got = usdc.balanceOf(address(this)) - before;
            if (got < amount) revert IRobotMoneyFund.DeferredShortfall(index, got, amount);
            usdc.safeTransfer(to, amount);
        } else {
            IERC20(a.token).safeTransfer(to, amount);
        }
        emit IRobotMoneyFund.DeferredClaimed(index, account, to, amount);
    }

    /// @dev Defer `amount` of asset `i` owed to an in-kind exit: the `exitFeeBps` share to `feeRecipient`, the rest
    ///      to `claimant` (the split an unfrozen leg would have paid). Step 3d: Basket legs only; a lending leg that
    ///      cannot pay becomes a position claim (`FundPositionLib`).
    function _deferSplit(FundState storage s, uint256 i, uint256 amount, address claimant) private {
        uint256 feeAmt = amount.mulDiv(s.exitFeeBps, BPS);
        _defer(s, i, claimant, amount - feeAmt);
        _defer(s, i, s.feeRecipient, feeAmt);
    }

    function _defer(FundState storage s, uint256 i, address account, uint256 amount) private {
        if (amount == 0) return;
        s.deferredOf[i][account] += amount;
        s.deferredTotal[i] += amount;
        emit IRobotMoneyFund.InKindDeferred(i, account, amount);
    }

    /// @dev `IERC20.transfer` that reports failure instead of reverting (SafeERC20 semantics: a call that
    ///      reverts, returns false, or targets no code is a failure; empty return data is success).
    function _tryTransfer(address token, address to, uint256 amount) private returns (bool) {
        if (amount == 0) return true;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (data.length == 0) return token.code.length != 0;
        return data.length >= 32 && abi.decode(data, (bool));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  executeStep (§5.3 steps 5-8)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `IRobotMoneyFund.executeStep` (§5.3 steps 5-8; step 3e: proposal §5.10, RB-4 and RB-19 from step
    ///         3e). Since step 3e the step lives in the linked `FundStepLib` (size, §6.1: the step 3e checks would have
    ///         left this library 483 bytes under EIP-170). This forwarder keeps the fund's call site unchanged; the
    ///         nested DELEGATECALL still runs as the fund. See `FundStepLib.executeStep`.
    function executeStep(FundState storage s, StepOrder memory o)
        public
        returns (StepResult memory)
    {
        return FundStepLib.executeStep(s, o);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Emergency unwind (§6: BasketVault.emergencyUnwind + RobotMoneyVault.emergencyWithdraw)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Move every holding to idle USDC. Lending: drain the holders' part of each active adapter, tolerant
    ///         of a failing adapter (`RobotMoneyVaultOps._emergencyPull`), leaving the position claims' part in
    ///         the venue and burning the holders' units (`FundPositionLib.drain`, E9); an adapter under an open
    ///         exclusion record is drained INTO its record, never into idle (exclusion is not confiscation, core
    ///         1820). Basket:
    ///         sell each active balance with floor = TWAP × (1 − maxSlippageBps) (`BasketSwaps.unwindAll`); a
    ///         zero floor is dust and is skipped; a leg whose TWAP read fails is skipped and stays held (there
    ///         is no configured-floor override here, see the fund's NatSpec). A swap below its floor reverts
    ///         the whole unwind, as on BasketVault. Returns the USDC that reached idle.
    /// @notice Consolidated non-reentrant claim / unwind / sweep dispatcher called via one `DELEGATECALL` site.
    function flowAction(
        FundState storage s,
        uint8 op,
        uint256 index,
        address addr,
        address caller
    ) public returns (uint256) {
        if (op == FLOW_CLAIM_DEFERRED) return _claimDeferred(s, index, caller, addr);
        if (op == FLOW_CLAIM_POSITION) return FundPositionLib.claimPosition(s, index, caller, addr);
        if (op == FLOW_SETTLE_CLAIM) return _settleClaim(s, index, addr);
        if (op == FLOW_EMERGENCY_UNWIND) {
            if (!s.depositsPaused) {
                s.depositsPaused = true;
                emit IRobotMoneyFund.DepositsPaused(caller);
            }
            uint256 recovered = _emergencyUnwind(s);
            FundDelistLib.unwindPausePlan(s);
            emit IRobotMoneyFund.EmergencyUnwound(recovered);
            return recovered;
        }
        if (op == FLOW_EMERGENCY_UNWIND_ASSET) {
            uint256 recovered = _emergencyUnwindAsset(s, index);
            emit IRobotMoneyFund.EmergencyUnwound(recovered);
            return recovered;
        }
        if (op == FLOW_SWEEP_FOREIGN) {
            _sweepForeign(s, addr, caller);
            return 0;
        }
        revert IFundEvents.InvalidParam();
    }

    function _emergencyUnwind(FundState storage s) private returns (uint256 recovered) {
        address usdc = s.usdc;
        uint256 before = FundValuationLib.idleUsdc(s);
        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig memory a = s.assets[i];
            if (!a.active) continue;
            if (a.kind == AssetKind.Lending) {
                FundPositionLib.drain(
                    s,
                    i,
                    x.ledger,
                    x.openExclusionOf[i],
                    ExclusionLedger.RecoverySource.EmergencyWithdraw
                );
                continue;
            }
            if (s.inSale[i]) {
                _emergencyUnwindInSale(s, i, a, usdc);
                continue;
            }
            uint256 bal = FundValuationLib.heldBalance(s, i);
            if (bal == 0) continue;
            try IBasketSwapAdapter(a.adapter)
                .twapPrice(a.pool, a.token, usdc, bal, a.twapWindow) returns (
                uint256 v
            ) {
                uint256 floor = _haircut(v, s.maxSlippageBps);
                if (floor != 0) _swap(a, a.token, usdc, bal, floor);
            } catch {}
        }
        uint256 afterBal = FundValuationLib.idleUsdc(s);
        recovered = afterBal > before ? afterBal - before : 0;
    }

    function _emergencyUnwindInSale(
        FundState storage s,
        uint256 i,
        AssetConfig memory a,
        address usdc
    ) private {
        uint256 fundTok = FundValuationLib.heldBalance(s, i);
        uint256 claimTok = s.delistClaimedTokens[i];
        uint256 totalTok = fundTok + claimTok;
        if (totalTok == 0) {
            FundDelistLib.closeDelistSale(s, i);
            return;
        }
        uint256 floor;
        try IBasketSwapAdapter(a.adapter)
            .twapPrice(a.pool, a.token, usdc, totalTok, a.twapWindow) returns (
            uint256 v
        ) {
            floor = _haircut(v, s.maxSlippageBps);
        } catch {}
        if (floor == 0) return;
        (uint256 sold, uint256 usdcGot) = _swapAndMeasureSold(a, usdc, totalTok, floor);
        FundDelistLib.finalizeDelistSale(s, i, sold, usdcGot, 0, fundTok, claimTok, false);
    }

    function _swapAndMeasureSold(
        AssetConfig memory a,
        address usdc,
        uint256 amountIn,
        uint256 minOut
    ) private returns (uint256 sold, uint256 usdcGot) {
        uint256 tokBefore = IERC20(a.token).balanceOf(address(this));
        usdcGot = _swap(a, a.token, usdc, amountIn, minOut);
        uint256 tokAfter = IERC20(a.token).balanceOf(address(this));
        sold = tokBefore > tokAfter ? tokBefore - tokAfter : 0;
    }

    /// @notice Step 3f (`IRobotMoneyFund.executeDelistStep`): execute one bounded delisting swap on `index`.
    function executeDelistStep(FundState storage s, uint256 index, uint256 maxUsdcNotional)
        public
        returns (bool executed, uint256 tokensSold, uint256 usdcReceived)
    {
        (
            bool shouldSell,
            uint256 tokensToSell,
            ,
            uint256 expectedUsdc,
            uint256 fundTokensBefore,
            uint256 claimedBefore
        ) = FundDelistLib.prepareDelistStep(s, index, maxUsdcNotional);
        if (!shouldSell) return (false, 0, 0);

        // Execute with minOut = 0 so `finalizeDelistSale` enforces and emits canonical `DelistBandExceeded`.
        (tokensSold, usdcReceived) = _swapAndMeasureSold(s.assets[index], s.usdc, tokensToSell, 0);

        FundDelistLib.finalizeDelistSale(
            s, index, tokensSold, usdcReceived, expectedUsdc, fundTokensBefore, claimedBefore, true
        );
        FundValuationLib.recordNav(s);
        executed = true;
    }

    /// @notice Step 3f (`IRobotMoneyFund.emergencyUnwind(uint256)`): single-asset unwind without halting other assets.
    function _emergencyUnwindAsset(FundState storage s, uint256 index)
        private
        returns (uint256 recoveredUsdc)
    {
        if (index >= s.assets.length || !s.assets[index].active) {
            revert IFundEvents.InvalidAssetIndex(index);
        }
        s.targetBps[index] = 0;
        Plan storage p = s.plan;
        if (
            (
                p.status == PlanStatus.Open || p.status == PlanStatus.Halted
                    || p.status == PlanStatus.Paused
            ) && index < p.endBps.length
        ) {
            p.endBps[index] = 0;
        }

        uint256 beforeIdle = FundValuationLib.idleUsdc(s);
        AssetConfig memory a = s.assets[index];
        if (a.kind == AssetKind.Lending) {
            RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
            FundPositionLib.drain(
                s,
                index,
                x.ledger,
                x.openExclusionOf[index],
                ExclusionLedger.RecoverySource.EmergencyWithdraw
            );
        } else {
            _emergencyUnwindSingleSwap(s, index, a);
        }
        uint256 afterIdle = FundValuationLib.idleUsdc(s);
        recoveredUsdc = afterIdle > beforeIdle ? afterIdle - beforeIdle : 0;
    }

    function _emergencyUnwindSingleSwap(FundState storage s, uint256 index, AssetConfig memory a)
        private
    {
        uint256 fundTok = FundValuationLib.heldBalance(s, index);
        bool inSaleNow = s.inSale[index];
        uint256 claimTok = inSaleNow ? s.delistClaimedTokens[index] : 0;
        uint256 totalTok = fundTok + claimTok;
        if (totalTok == 0) {
            if (inSaleNow) FundDelistLib.closeDelistSale(s, index);
            return;
        }
        // Floor: the feed price less `delistBandBps` (plan section 3.3). A stale feed leaves no floor, so the unwind
        // can still run when the feeds are what failed.
        uint256 floor;
        (bool feedOk,, uint256 feedPx) = FundValuationLib.feedPricePerToken(s, index);
        if (feedOk) {
            floor = totalTok.mulDiv(feedPx, 10 ** IERC20Metadata(a.token).decimals())
                .mulDiv(BPS - s.delistBandBps, BPS);
        }
        (uint256 sold, uint256 usdcGot) = _swapAndMeasureSold(a, s.usdc, totalTok, floor);
        if (inSaleNow) {
            FundDelistLib.finalizeDelistSale(s, index, sold, usdcGot, 0, fundTok, claimTok, false);
        }
    }

    /// @notice Step 3f (`IRobotMoneyFund.settleClaim`): permissionlessly settle `owner`'s lending or delisting claim.
    function _settleClaim(FundState storage s, uint256 index, address owner)
        private
        returns (uint256 netUsdc)
    {
        if (owner == address(0)) revert IFundEvents.ZeroAddress();
        if (index >= s.assets.length) revert IFundEvents.InvalidAssetIndex(index);

        uint256 feeUsdc;
        bool hasClaim;
        if (s.assets[index].kind == AssetKind.Lending) {
            (netUsdc, feeUsdc, hasClaim) = FundPositionLib.settleLendingClaim(s, index, owner);
            if (!hasClaim) revert IRobotMoneyFund.NoClaimToSettle(index, owner);
            return netUsdc;
        }

        (netUsdc, feeUsdc, hasClaim) = FundDelistLib.consumeDelistClaim(s, index, owner);
        if (!hasClaim) revert IRobotMoneyFund.NoClaimToSettle(index, owner);
        address usdc = s.usdc;
        if (feeUsdc != 0) IERC20(usdc).safeTransfer(s.feeRecipient, feeUsdc);
        if (netUsdc != 0) IERC20(usdc).safeTransfer(owner, netUsdc);
        if (netUsdc != 0 || feeUsdc != 0) {
            emit IRobotMoneyFund.ClaimSettled(index, owner, netUsdc, feeUsdc);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Swap through the asset's adapter (`BasketSwaps.swap`: approve, swap with recipient = the fund,
    ///      clear approval). Returns `tokenOut` received by balance delta.
    function _swap(
        AssetConfig memory a,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut
    ) private returns (uint256 got) {
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        BasketSwaps.swap(
            a.adapter, tokenIn, tokenOut, a.poolFee, amountIn, minOut, ISwapRouter(address(0))
        );
        got = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    /// @dev Pay one in-kind leg: `exitFeeBps` of it to `feeTo`, the rest to `receiver`.
    function _payLeg(address token, address receiver, uint256 amount, uint256 feeBps, address feeTo)
        private
    {
        if (amount == 0) return;
        uint256 fee = amount.mulDiv(feeBps, BPS);
        if (fee != 0) IERC20(token).safeTransfer(feeTo, fee);
        IERC20(token).safeTransfer(receiver, amount - fee);
    }

    /// @dev `value × (1 − bps)`, floored (BasketVault._applySlippage).
    function _haircut(uint256 value, uint256 bps) private pure returns (uint256) {
        return value * (BPS - bps) / BPS;
    }
}
