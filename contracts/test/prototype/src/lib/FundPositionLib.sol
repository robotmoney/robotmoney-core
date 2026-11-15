// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.4 and §5.9.4 (in-kind exit: the per-period lending
//            allowance and claims on a share of a lending position), §7 RB-13 and RB-21;
//            docs/technical/one-vault-timed-flows-eng-plan.md E9, E20, E23, §3.2 ("units per lending position")
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "../../../../interfaces/IStrategyAdapter.sol";
import {ILendingRateAdapter} from "../interfaces/IFlowAdapters.sol";
import {ExclusionLedger} from "../../../../ExclusionLedger.sol";
import {
    AssetKind,
    IFundEvents,
    BPS,
    LENDING_ROUNDING_UNITS,
    POSITION_UNITS_PER_USDC,
    MAX_IN_KIND_FLOOR_USDC,
    MIN_IN_KIND_PERIOD,
    MAX_IN_KIND_PERIOD
} from "../FundTypes.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {FundState, FundStorage, LendingClaimAccount, LendingClaimEpoch} from "./FundStorage.sol";
import {FundValuationLib} from "./FundValuationLib.sol";

/// @title FundPositionLib
/// @notice Units per lending position (E9, RB-21), as an externally linked library (DELEGATECALL as the fund).
///
///         Each lending asset `i` has `positionUnits[i]` units. They are shares of the position's value
///         `P = adapter.totalAssets() − deferredTotal[i]` (`FundValuationLib.positionValue`). Claims of past in-kind
///         exits hold `positionClaimTotal[i]` of them (`positionClaimOf[i][account]` each); the holders own the rest.
///         Every path that supplies to or withdraws from a lending venue goes through this library and keeps the
///         units right, so one unit is always the same fraction of the position:
///         - a supply for the holders (`supply`: `mintInKind`, a rebalance step's buy leg) mints units for the
///           value the position gained, at the unit's value before it;
///         - a withdrawal for the holders (`take`: `sellForFlow`, a step's sell leg; `drain`: the emergency unwind
///           and an exclusion restore; the paid part of an in-kind lending leg) burns holders' units for the value
///           the position lost;
///         - an in-kind exit beyond the period's allowance, or one a venue cannot pay, moves the exiter's units from
///           the holders to a claim (`inKindLending`); `claimPosition` later pays the claim and burns its units.
///         A claim's value therefore moves with the venue: interest and losses are shared pro rata with the holders,
///         and a deposit or a step into the venue does not change the claim's value (RB-21).
///
///         Rounding (holders first, then the claim holders, never the other way): units minted for a supply round
///         DOWN and units burned for a withdrawal round UP, so the value of one unit never falls through rounding;
///         an exiter's slice in units rounds DOWN; a claim is paid `LENDING_ROUNDING_UNITS` short of its value, so
///         venue rounding falls on it, not on the holders. Units start at `POSITION_UNITS_PER_USDC` per USDC unit, a
///         fine scale, so each rounding is far below one USDC unit.
library FundPositionLib {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @dev `pos0` marker of the in-kind snapshot: this lending venue's value read reverted (E23).
    uint256 internal constant UNREADABLE = type(uint256).max;

    // ═════════════════════════════════════════════════════════════════════════
    //  Tracked supply and withdrawal (every lending path of the fund)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Move `amount` USDC into lending asset `i`'s adapter and deploy it for the holders. Returns what the
    ///         adapter kept (the fund's balance delta, `RobotMoneyVaultOps._allocate`: a refused supply comes straight
    ///         back and stays idle). Mints holders' units for the value the position gained. Reverts if the venue's
    ///         value read reverts (callers: `mintInKind`, a step's buy leg; both trade only counted assets).
    function supply(FundState storage s, uint256 i, uint256 amount)
        public
        returns (uint256 placed)
    {
        address adapter = s.assets[i].adapter;
        IERC20 usdc = IERC20(s.usdc);
        uint256 p0 = FundValuationLib.positionValue(s, i);
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransfer(adapter, amount);
        IStrategyAdapter(adapter).deploy(amount);
        uint256 handedBack = usdc.balanceOf(address(this)) + amount - before;
        placed = handedBack >= amount ? 0 : amount - handedBack;
        _mintUnits(s, i, p0, FundValuationLib.positionValue(s, i));
    }

    /// @notice `withdraw(amount)` from lending asset `i` for the holders. Returns the USDC that arrived (the fund's
    ///         balance delta). Burns holders' units for the value the position lost. A venue that cannot pay reverts
    ///         (callers: `sellForFlow`, a step's sell leg).
    function take(FundState storage s, uint256 i, uint256 amount) public returns (uint256 got) {
        IERC20 usdc = IERC20(s.usdc);
        uint256 p0 = FundValuationLib.positionValue(s, i);
        uint256 before = usdc.balanceOf(address(this));
        IStrategyAdapter(s.assets[i].adapter).withdraw(amount);
        got = usdc.balanceOf(address(this)) - before;
        _burnUnits(s, i, p0, FundValuationLib.positionValue(s, i));
    }

    /// @notice Step 3f (E37, E44, E54): withdraw `holderSliceUsdc` (less `LENDING_ROUNDING_UNITS`) from lending
    ///         asset `i` for a net redemption (`shares / supplyBefore`), withdrawing pro rata for any outstanding
    ///         claims (`positionClaimTotal[i]`) in the same call. On shortfall, mints claim units for `claimant`
    ///         with exit fee `claimFeeBps` (linked when `linkedFee`, else credited directly to `feeRecipient`).
    struct TakeClaimCtx {
        uint256 shares;
        uint256 supplyBefore;
        address claimant;
        uint256 claimFeeBps;
        bool linkedFee;
        bool batch;
        address[] owners;
        uint256[] ownerShares;
        uint16[] ownerFeeBps;
    }

    function takeForFlow(
        FundState storage s,
        uint256 i,
        uint256 holderSliceUsdc,
        uint256 shares,
        uint256 supplyBefore,
        address claimant,
        uint256 claimFeeBps,
        bool linkedFee
    ) public returns (uint256) {
        address[] memory emptyOwners;
        uint256[] memory emptyShares;
        uint16[] memory emptyFees;
        return _takeForFlow(
            s,
            i,
            holderSliceUsdc,
            TakeClaimCtx({
                shares: shares,
                supplyBefore: supplyBefore,
                claimant: claimant,
                claimFeeBps: claimFeeBps,
                linkedFee: linkedFee,
                batch: false,
                owners: emptyOwners,
                ownerShares: emptyShares,
                ownerFeeBps: emptyFees
            })
        );
    }

    /// @notice Step 3f (RB-35): batch variant of `takeForFlow` distributing any shortfall claim units pro rata across
    ///         `owners` with exact zero-dust conservation and linked fees at each owner's `ownerFeeBps[k]`.
    function takeForFlowBatch(
        FundState storage s,
        uint256 i,
        uint256 holderSliceUsdc,
        uint256 shares,
        uint256 supplyBefore,
        address[] memory owners,
        uint256[] memory ownerShares,
        uint16[] memory ownerFeeBps
    ) public returns (uint256) {
        return _takeForFlow(
            s,
            i,
            holderSliceUsdc,
            TakeClaimCtx({
                shares: shares,
                supplyBefore: supplyBefore,
                claimant: address(0),
                claimFeeBps: 0,
                linkedFee: true,
                batch: true,
                owners: owners,
                ownerShares: ownerShares,
                ownerFeeBps: ownerFeeBps
            })
        );
    }

    function _takeForFlow(
        FundState storage s,
        uint256 i,
        uint256 holderSliceUsdc,
        TakeClaimCtx memory ctx
    ) private returns (uint256 gotHolder) {
        if (holderSliceUsdc <= LENDING_ROUNDING_UNITS) return 0;
        uint256 wantHolder = holderSliceUsdc - LENDING_ROUNDING_UNITS;
        uint256 u0 = s.positionUnits[i];
        uint256 p0 = _readTakeValue(s, i);
        if (p0 == 0) {
            if (u0 != 0) {
                uint256 failUnits =
                    (u0 - s.positionClaimTotal[i]).mulDiv(ctx.shares, ctx.supplyBefore);
                _claimShortfall(s, i, failUnits, ctx);
            }
            return 0;
        }
        if (u0 == 0) {
            u0 = p0 * POSITION_UNITS_PER_USDC;
            s.positionUnits[i] = u0;
        }
        uint256 holdersBurned;
        uint256 h0;
        (gotHolder, holdersBurned, h0) = _takeWithdrawAndApply(s, i, wantHolder, u0, p0, ctx.batch);
        if (h0 != 0 && gotHolder < wantHolder) {
            uint256 targetBurned = wantHolder.mulDiv(u0, p0);
            uint256 shortfallUnits = targetBurned > holdersBurned ? targetBurned - holdersBurned : 0;
            _claimShortfall(s, i, shortfallUnits, ctx);
        }
    }

    function _claimShortfall(FundState storage s, uint256 i, uint256 units, TakeClaimCtx memory ctx)
        private
    {
        if (units == 0) return;
        if (!ctx.batch) {
            _claimWithFee(s, i, ctx.claimant, units, ctx.claimFeeBps, ctx.linkedFee);
            return;
        }
        uint256 remUnits = units;
        uint256 remShares = ctx.shares;
        for (uint256 k; k < ctx.owners.length && remUnits != 0; ++k) {
            uint256 os = ctx.ownerShares[k];
            if (os == 0) continue;
            uint256 slice = remShares == os ? remUnits : remUnits.mulDiv(os, remShares);
            remUnits -= slice;
            remShares -= os;
            if (slice != 0) {
                _claimWithFee(s, i, ctx.owners[k], slice, ctx.ownerFeeBps[k], true);
            }
        }
    }

    function _readTakeValue(FundState storage s, uint256 i) private view returns (uint256 p0) {
        try IStrategyAdapter(s.assets[i].adapter).totalAssets() returns (uint256 bal) {
            uint256 owed = s.deferredTotal[i];
            p0 = bal > owed ? bal - owed : 0;
        } catch {}
    }

    function _takeWithdrawAndApply(
        FundState storage s,
        uint256 i,
        uint256 wantHolder,
        uint256 u0,
        uint256 p0,
        bool strict
    ) private returns (uint256 gotHolder, uint256 holdersBurned, uint256 h0) {
        uint256 c0 = s.positionClaimTotal[i];
        h0 = u0 - c0;
        if (h0 == 0) return (0, 0, 0);
        uint256 got;
        {
            uint256 wantClaims = c0 == 0 ? 0 : wantHolder.mulDiv(c0, h0);
            uint256 wantTotal = wantHolder + wantClaims;
            if (wantTotal > p0) wantTotal = p0;
            got = _tryWithdrawAvailable(s, i, wantTotal);
        }
        uint256 p1 = _valueAfter(s, i, p0, got);
        // RB-34 / A34, queue path only: one price covers many owners, so a venue that removes more from the position
        // than it pays (a short pay without a revert) cannot be charged to anyone fairly. Refuse it, so the net side
        // fails and the round stays open. A single direct seller (`sellForFlow`) books the USDC it received and
        // carries the venue's shortfall itself: the stayers' units are untouched either way. The margin is the two
        // units a venue may round against the fund plus the one unit Aave's own rounding adds on a withdrawal.
        if (strict && p0 > p1 && p0 - p1 > got + LENDING_ROUNDING_UNITS + 1) {
            revert IRobotMoneyFund.ProportionViolated(i, p0, p1 + got, 1, 1);
        }
        {
            uint256 gotClaims = c0 == 0 ? 0 : got.mulDiv(c0, u0);
            gotHolder = got - gotClaims;
            if (gotClaims != 0) _creditLendingPot(s, i, gotClaims);
        }
        holdersBurned = _applyTakeUnits(s, i, p0, p1, u0, c0, h0);
    }

    function _applyTakeUnits(
        FundState storage s,
        uint256 i,
        uint256 p0,
        uint256 p1,
        uint256 u0,
        uint256 c0,
        uint256 h0
    ) private returns (uint256 holdersBurned) {
        uint256 totalBurned = p1 >= p0 ? 0 : (p0 - p1).mulDiv(u0, p0, Math.Rounding.Ceil);
        if (totalBurned > u0) totalBurned = u0;
        uint256 claimsBurned = c0 == 0 ? 0 : totalBurned.mulDiv(c0, u0, Math.Rounding.Ceil);
        if (claimsBurned > c0) claimsBurned = c0;
        holdersBurned = totalBurned - claimsBurned;
        if (holdersBurned > h0) {
            holdersBurned = h0;
            claimsBurned = totalBurned - h0;
        }
        s.positionUnits[i] = u0 - totalBurned;
        uint256 c1 = c0 - claimsBurned;
        s.positionClaimTotal[i] = c1;
        if (c0 != 0 && c1 == 0) _rollLendingEpoch(s, i);
    }

    function _tryWithdrawAvailable(FundState storage s, uint256 i, uint256 wantTotal)
        private
        returns (uint256 got)
    {
        if (wantTotal == 0) return 0;
        address adapter = s.assets[i].adapter;
        IERC20 usdc = IERC20(s.usdc);
        uint256 before = usdc.balanceOf(address(this));
        try IStrategyAdapter(adapter).withdraw(wantTotal) returns (uint256) {
            return usdc.balanceOf(address(this)) - before;
        } catch {}
        uint256 avail;
        try ILendingRateAdapter(adapter).availableLiquidity() returns (uint256 a) {
            avail = a;
        } catch {
            return 0;
        }
        if (avail == 0) return 0;
        uint256 ask = avail < wantTotal ? avail : wantTotal;
        before = usdc.balanceOf(address(this));
        try IStrategyAdapter(adapter).withdraw(ask) returns (uint256) {
            got = usdc.balanceOf(address(this)) - before;
        } catch {}
    }

    /// @notice Withdraw the holders' whole part of lending asset `i`, tolerant of a failing adapter. What stays in
    ///         the adapter is reserved: the step 3c `deferredTotal[i]` and the position claims' value (rounded UP), so
    ///         an emergency never takes what claim holders own. With `id != 0` the USDC that arrived (balance delta,
    ///         never the adapter's return value) moves into exclusion record `id` of `ledger`
    ///         (`RobotMoneyVaultOps._drain` + `_credit`). Burns the holders' units for what left. `ok` is false when
    ///         `totalAssets` or `withdraw` reverted. Callers: `emergencyUnwind`, the restore branch of
    ///         `syncExclusions`.
    function drain(
        FundState storage s,
        uint256 i,
        ExclusionLedger ledger,
        uint256 id,
        ExclusionLedger.RecoverySource source
    ) public returns (bool ok) {
        uint256 bal;
        try IStrategyAdapter(s.assets[i].adapter).totalAssets() returns (uint256 reported) {
            bal = reported;
        } catch {
            return false;
        }
        uint256 owed = s.deferredTotal[i];
        uint256 p0 = bal > owed ? bal - owed : 0;
        // Two units more stay in the venue, so its rounding falls on the holders' leftover, never on the claims.
        uint256 reserved = owed + claimsPart(s, i, p0) + LENDING_ROUNDING_UNITS;
        if (bal <= reserved) return true;
        uint256 got;
        uint256 asked = bal - reserved;
        (ok, got) = _tryTake(s, i, asked, p0);
        // RB-34 / A34: a venue that pays less than it was asked for, without reverting, has not drained. Report it,
        // so a restore reverts and the record stays open. What did arrive is still credited when `id != 0`.
        if (ok && got + LENDING_ROUNDING_UNITS < asked) ok = false;
        if (id == 0 || got == 0) return ok;
        IERC20(s.usdc).safeTransfer(address(ledger), got);
        ledger.credit(id, got, source);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  In-kind exit: the lending legs (E9, E20, E23)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice The lending legs of `redeemInKind` for `shares` of `supplyBefore`, from the check 7 snapshot
    ///         (`held0`: holders' part per index; `pos0`: position value per index, 0 when not counted or empty,
    ///         `UNREADABLE` when the venue's value read reverted). Returns the USDC that arrived, which the caller pays
    ///         as part of the USDC leg (exit fee included there).
    ///         1. Each readable leg's slice: `want = floor(held0 × shares / supplyBefore) − LENDING_ROUNDING_UNITS`.
    ///         2. The period's allowance left (E20): `max(inKindBps × Σ held0 of readable legs / 10 000,
    ///            inKindFloorUsdc) − inKindUsed[period]`. It reads no price: the amounts are the venues' own USDC.
    ///         3. Each leg withdraws `want` in USDC when the total fits the allowance, else `want × left / total`
    ///            (pro rata over the venues, so no venue is drained first), under try/catch.
    ///         4. Whatever of `want` did not arrive (beyond the allowance, a revert, a short fill) becomes a claim
    ///            on the position: the exiter's slice in units less the units its USDC part burned. A leg paid in
    ///            full leaves no claim (its rounding margin stays with the holders).
    ///         5. A leg whose value read reverted (E23) becomes a claim on the exiter's units of it, with no read and
    ///            no withdrawal.
    ///         Claims are keyed to `claimant`; the exit fee's share of each claim goes to the fee recipient as its
    ///         own claim (every leg pays the fee, coordinator ruling 7). Adds the USDC that arrived to
    ///         `inKindUsed[period]`.
    function inKindLending(
        FundState storage s,
        uint256[] memory held0,
        uint256[] memory pos0,
        address claimant,
        uint256 shares,
        uint256 supplyBefore
    ) public returns (uint256 usdcGot) {
        (uint256[] memory want, uint256[] memory paid) =
            _wants(s, held0, pos0, shares, supplyBefore);
        uint256 n = held0.length;
        for (uint256 i; i < n; ++i) {
            if (s.assets[i].kind != AssetKind.Lending) continue;
            if (pos0[i] == UNREADABLE) {
                _claimUnread(s, i, claimant, shares, supplyBefore);
            } else if (want[i] != 0) {
                usdcGot += _leg(s, i, pos0[i], want[i], paid[i], claimant);
            }
        }
        uint32 period = s.inKindPeriod;
        if (usdcGot != 0 && period != 0) s.inKindUsed[block.timestamp / period] += usdcGot;
    }

    /// @dev Steps 1 to 3 of `inKindLending` (own frame for stack depth): each readable leg's `want`, and the USDC
    ///      part it asks for (`paid`): all of `want` when the total fits the allowance left this period, else
    ///      `want × left / total`, rounded DOWN.
    function _wants(
        FundState storage s,
        uint256[] memory held0,
        uint256[] memory pos0,
        uint256 shares,
        uint256 supplyBefore
    ) private view returns (uint256[] memory want, uint256[] memory paid) {
        uint256 n = held0.length;
        want = new uint256[](n);
        paid = new uint256[](n);
        uint256 holdings;
        uint256 total;
        for (uint256 i; i < n; ++i) {
            uint256 p = pos0[i];
            if (p == 0 || p == UNREADABLE || s.assets[i].kind != AssetKind.Lending) continue;
            holdings += held0[i];
            uint256 w = held0[i].mulDiv(shares, supplyBefore);
            if (w <= LENDING_ROUNDING_UNITS) continue;
            want[i] = w - LENDING_ROUNDING_UNITS;
            total += want[i];
        }
        uint256 room = allowanceLeft(s, holdings);
        for (uint256 i; i < n; ++i) {
            paid[i] = total <= room ? want[i] : want[i].mulDiv(room, total);
        }
    }

    /// @notice Lending USDC in-kind exits may still take this period (E20): `max(inKindBps × holdings / 10 000,
    ///         inKindFloorUsdc) − inKindUsed[now / inKindPeriod]`, floored at 0. 0 while no period is set.
    function allowanceLeft(FundState storage s, uint256 holdings) public view returns (uint256) {
        uint32 period = s.inKindPeriod;
        if (period == 0) return 0;
        uint256 cap = holdings.mulDiv(s.inKindBps, BPS);
        uint256 floorUsdc = s.inKindFloorUsdc;
        if (floorUsdc > cap) cap = floorUsdc;
        uint256 used = s.inKindUsed[block.timestamp / period];
        return cap > used ? cap - used : 0;
    }

    /// @notice Body of `IRobotMoneyFund.setInKindAllowance` (the fund checks ADMIN_ROLE). Bounds: `bps ≤ 10 000`,
    ///         `floorUsdc ≤ MAX_IN_KIND_FLOOR_USDC`, `period` in [MIN_IN_KIND_PERIOD, MAX_IN_KIND_PERIOD]
    ///         (`InvalidParam`). A new period length re-keys `inKindUsed`, so it takes effect from the next exit.
    function setInKindAllowance(FundState storage s, uint16 bps, uint128 floorUsdc, uint32 period)
        public
    {
        if (
            bps > BPS || floorUsdc > MAX_IN_KIND_FLOOR_USDC || period < MIN_IN_KIND_PERIOD
                || period > MAX_IN_KIND_PERIOD
        ) {
            revert IFundEvents.InvalidParam();
        }
        s.inKindBps = bps;
        s.inKindFloorUsdc = floorUsdc;
        s.inKindPeriod = period;
        emit IRobotMoneyFund.InKindAllowanceSet(bps, floorUsdc, period);
    }

    /// @notice Body of `IRobotMoneyFund.inKindAllowance`.
    function inKindAllowance(FundState storage s)
        public
        view
        returns (uint16 bps, uint128 floorUsdc, uint32 period, uint256 usedNow)
    {
        period = s.inKindPeriod;
        usedNow = period == 0 ? 0 : s.inKindUsed[block.timestamp / period];
        return (s.inKindBps, s.inKindFloorUsdc, period, usedNow);
    }

    /// @dev One readable in-kind lending leg: withdraw `x` (≤ `want`) under try/catch, burn the holders' units for
    ///      what left, and turn the unpaid part of the exiter's slice into a claim. Returns the USDC that arrived.
    function _leg(
        FundState storage s,
        uint256 i,
        uint256 p0,
        uint256 want,
        uint256 x,
        address claimant
    ) private returns (uint256 got) {
        uint256 u0 = s.positionUnits[i];
        if (u0 == 0) {
            // First units of a position that only ever received gifts: the holders own all of it (no claim exists).
            u0 = p0 * POSITION_UNITS_PER_USDC;
            s.positionUnits[i] = u0;
        }
        if (x != 0) (, got) = _tryTake(s, i, x, p0);
        if (got >= want) return got;
        uint256 slice = want.mulDiv(u0, p0);
        uint256 burned = u0 - s.positionUnits[i];
        if (slice > burned) _claim(s, i, claimant, slice - burned);
    }

    /// @dev E23: a lending leg whose value read reverted. No read and no withdrawal: the exiter's units of the
    ///      position, `floor(holders' units × shares / supplyBefore)`, become its claim.
    function _claimUnread(
        FundState storage s,
        uint256 i,
        address claimant,
        uint256 shares,
        uint256 supplyBefore
    ) private {
        uint256 holders = s.positionUnits[i] - s.positionClaimTotal[i];
        _claim(s, i, claimant, holders.mulDiv(shares, supplyBefore));
    }

    /// @dev Move `units` of lending position `i` from the holders to claims: the exit fee's share to the fee
    ///      recipient, the rest to `claimant`.
    function _claim(FundState storage s, uint256 i, address claimant, uint256 units) private {
        _claimWithFee(s, i, claimant, units, s.exitFeeBps, false);
    }

    function _claimWithFee(
        FundState storage s,
        uint256 i,
        address claimant,
        uint256 units,
        uint256 feeBps,
        bool linkedFee
    ) private {
        if (units == 0) return;
        uint256 feeUnits = units.mulDiv(feeBps, BPS);
        uint256 addScaled = _allocateLendingEpochScaled(s, i, units);
        uint256 feeScaled = addScaled.mulDiv(feeUnits, units);
        uint256 netScaled = addScaled - feeScaled;
        uint256 netUnits = units - feeUnits;
        if (netScaled != 0) {
            _addLendingScaled(
                s, i, s.lendingClaims[i][claimant], claimant, netScaled, netUnits, true
            );
        } else if (netUnits != 0) {
            emit IRobotMoneyFund.PositionClaimRecorded(i, claimant, netUnits);
        }
        if (feeScaled != 0) {
            address rec = s.feeRecipient;
            LendingClaimAccount storage feeAccount =
                linkedFee ? s.lendingFeeLinked[i][claimant] : s.lendingClaims[i][rec];
            _addLendingScaled(s, i, feeAccount, rec, feeScaled, feeUnits, !linkedFee);
        }
    }

    function _allocateLendingEpochScaled(FundState storage s, uint256 i, uint256 units)
        private
        returns (uint256 addScaled)
    {
        uint256 claimTotalBefore = s.positionClaimTotal[i];
        s.positionClaimTotal[i] = claimTotalBefore + units;

        LendingClaimEpoch storage ep = s.lendingEpochs[i][s.lendingClaimEpoch[i]];
        uint256 totalScaledBefore = ep.totalScaled;
        if (totalScaledBefore == 0) {
            addScaled = claimTotalBefore == 0 ? FundStorage.LENDING_ACC_NORM : units;
            if (claimTotalBefore != 0) ep.totalScaled = claimTotalBefore;
            ep.totalScaled += addScaled;
        } else {
            addScaled = units.mulDiv(totalScaledBefore, claimTotalBefore);
            ep.totalScaled = totalScaledBefore + addScaled;
        }
    }

    function _addLendingScaled(
        FundState storage s,
        uint256 i,
        LendingClaimAccount storage entry,
        address account,
        uint256 addScaled,
        uint256 emitUnits,
        bool emitEvent
    ) private {
        _harvestLendingEntry(s, i, entry);
        entry.scaled += addScaled;
        if (emitEvent && emitUnits != 0) {
            emit IRobotMoneyFund.PositionClaimRecorded(i, account, emitUnits);
        }
    }

    function _harvestLendingEntry(FundState storage s, uint256 i, LendingClaimAccount storage entry)
        private
    {
        uint256 cur = s.lendingClaimEpoch[i];
        if (entry.scaled != 0) {
            LendingClaimEpoch storage ep = s.lendingEpochs[i][entry.epoch];
            uint256 delta = ep.usdcPerScaled - entry.usdcDebt;
            if (delta != 0) {
                entry.pendingUsdc += entry.scaled.mulDiv(delta, FundStorage.LENDING_ACC_SCALE);
            }
            if (entry.epoch != cur) {
                entry.scaled = 0;
            }
        }
        entry.epoch = cur;
        entry.usdcDebt = s.lendingEpochs[i][cur].usdcPerScaled;
    }

    function _migrateLegacyLending(FundState storage s, uint256 i, address account) private {
        uint256 leg = s.positionClaimOf[i][account];
        if (leg == 0) return;
        s.positionClaimOf[i][account] = 0;
        uint256 cur = s.lendingClaimEpoch[i];
        LendingClaimEpoch storage ep = s.lendingEpochs[i][cur];
        uint256 c0 = s.positionClaimTotal[i];
        uint256 addScaled;
        if (ep.totalScaled == 0) {
            ep.totalScaled = c0;
            addScaled = leg;
        } else {
            addScaled = leg.mulDiv(ep.totalScaled, c0);
        }
        _harvestLendingEntry(s, i, s.lendingClaims[i][account]);
        s.lendingClaims[i][account].scaled += addScaled;
    }

    function _creditLendingPot(FundState storage s, uint256 i, uint256 gotClaims) private {
        uint256 cur = s.lendingClaimEpoch[i];
        LendingClaimEpoch storage ep = s.lendingEpochs[i][cur];
        if (ep.totalScaled == 0) {
            // Legacy storage path before accumulator existed: fall back to 1:1 on remaining claims.
            if (s.positionClaimTotal[i] == 0) return;
            ep.totalScaled = s.positionClaimTotal[i];
        }
        ep.usdcPerScaled += gotClaims.mulDiv(FundStorage.LENDING_ACC_SCALE, ep.totalScaled);
        s.lendingUsdcPot[i] += gotClaims;
        s.reservedClaimUsdc += gotClaims;
    }

    function _rollLendingEpoch(FundState storage s, uint256 i) private {
        uint256 next = s.lendingClaimEpoch[i] + 1;
        s.lendingClaimEpoch[i] = next;
    }

    function _lendingEntryUnits(FundState storage s, uint256 i, LendingClaimAccount storage entry)
        private
        view
        returns (uint256 units, uint256 pending)
    {
        uint256 cur = s.lendingClaimEpoch[i];
        uint256 c0 = s.positionClaimTotal[i];
        pending = entry.pendingUsdc;
        if (entry.scaled != 0) {
            LendingClaimEpoch storage ep = s.lendingEpochs[i][entry.epoch];
            uint256 delta = ep.usdcPerScaled - entry.usdcDebt;
            if (delta != 0) {
                pending += entry.scaled.mulDiv(delta, FundStorage.LENDING_ACC_SCALE);
            }
            if (entry.epoch == cur && c0 != 0 && ep.totalScaled != 0) {
                units = entry.scaled.mulDiv(c0, ep.totalScaled);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Position claims (E9, E54, RB-21, RB-35)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `IRobotMoneyFund.claimPosition`: pay `account`'s whole claim on lending position `i` at
    ///         today's value (plus any accrued pot USDC), less `LENDING_ROUNDING_UNITS`, to `to`. Reverts
    ///         `ZeroAddress`, `NoPositionClaim`, or `DeferredShortfall` while the venue cannot pay.
    function claimPosition(FundState storage s, uint256 i, address account, address to)
        public
        returns (uint256 usdc)
    {
        if (to == address(0)) revert IFundEvents.ZeroAddress();
        _migrateLegacyLending(s, i, account);
        LendingClaimAccount storage entry = s.lendingClaims[i][account];
        _harvestLendingEntry(s, i, entry);
        uint256 cur = s.lendingClaimEpoch[i];
        uint256 c0 = s.positionClaimTotal[i];
        LendingClaimEpoch storage ep = s.lendingEpochs[i][cur];
        uint256 units = (entry.epoch == cur && c0 != 0 && ep.totalScaled != 0)
            ? entry.scaled.mulDiv(c0, ep.totalScaled)
            : 0;
        uint256 potOwed = entry.pendingUsdc;
        if (units == 0 && potOwed == 0) revert IRobotMoneyFund.NoPositionClaim(i, account);

        uint256 adapterUsdc = units != 0 ? _withdrawClaimUnits(s, i, entry, cur, c0, units) : 0;
        uint256 potPaid = _takeLendingPot(s, i, potOwed);
        entry.pendingUsdc = 0;
        usdc = adapterUsdc + potPaid;
        if (usdc != 0) IERC20(s.usdc).safeTransfer(to, usdc);
        emit IRobotMoneyFund.PositionClaimed(i, account, to, units, usdc);
    }

    function _withdrawClaimUnits(
        FundState storage s,
        uint256 i,
        LendingClaimAccount storage entry,
        uint256 cur,
        uint256 c0,
        uint256 units
    ) private returns (uint256 adapterUsdc) {
        LendingClaimEpoch storage ep = s.lendingEpochs[i][cur];
        uint256 total = s.positionUnits[i];
        uint256 value = FundValuationLib.positionValue(s, i).mulDiv(units, total);
        ep.totalScaled -= entry.scaled;
        entry.scaled = 0;
        s.positionClaimTotal[i] = c0 - units;
        s.positionUnits[i] = total - units;
        if (s.positionClaimTotal[i] == 0) _rollLendingEpoch(s, i);
        adapterUsdc = value > LENDING_ROUNDING_UNITS ? value - LENDING_ROUNDING_UNITS : 0;
        if (adapterUsdc != 0) {
            IERC20 t = IERC20(s.usdc);
            uint256 before = t.balanceOf(address(this));
            IStrategyAdapter(s.assets[i].adapter).withdraw(adapterUsdc);
            uint256 got = t.balanceOf(address(this)) - before;
            if (got < adapterUsdc) revert IRobotMoneyFund.DeferredShortfall(i, got, adapterUsdc);
        }
    }

    struct SettleBurnCtx {
        address owner;
        uint256 cur;
        uint256 c0;
        uint256 u0;
        uint256 combUnits;
        uint256 burned;
        uint256 ownerScaled;
        uint256 feeScaled;
        uint256 totalScaled;
        uint256 got;
    }

    /// @notice Step 3f (E54, RB-35, A45): permissionless settlement of `owner`'s lending position claim (and any
    ///         linked exit fee) on asset `i`. Withdraws whatever the venue can pay without reverting on partial
    ///         liquidity, pays any accrued pot USDC, transfers `feeUsdc` to `feeRecipient` and `netUsdc` to `owner`.
    function settleLendingClaim(FundState storage s, uint256 i, address owner)
        public
        returns (uint256 netUsdc, uint256 feeUsdc, bool hasClaim)
    {
        if (owner == address(0)) revert IFundEvents.ZeroAddress();
        _migrateLegacyLending(s, i, owner);
        LendingClaimAccount storage ownerEntry = s.lendingClaims[i][owner];
        LendingClaimAccount storage feeEntry = s.lendingFeeLinked[i][owner];
        _harvestLendingEntry(s, i, ownerEntry);
        _harvestLendingEntry(s, i, feeEntry);

        {
            uint256 cur = s.lendingClaimEpoch[i];
            uint256 c0 = s.positionClaimTotal[i];
            uint256 ownerScaled = (ownerEntry.epoch == cur && c0 != 0) ? ownerEntry.scaled : 0;
            uint256 feeScaled = (feeEntry.epoch == cur && c0 != 0) ? feeEntry.scaled : 0;
            if (
                ownerScaled == 0 && feeScaled == 0 && ownerEntry.pendingUsdc == 0
                    && feeEntry.pendingUsdc == 0
            ) {
                return (0, 0, false);
            }
            hasClaim = true;
            SettleBurnCtx memory b;
            b.owner = owner;
            b.cur = cur;
            b.c0 = c0;
            b.ownerScaled = ownerScaled;
            b.feeScaled = feeScaled;
            (netUsdc, feeUsdc) = _settleClaimUnits(s, i, b);
        }

        netUsdc += _takeLendingPot(s, i, ownerEntry.pendingUsdc);
        feeUsdc += _takeLendingPot(s, i, feeEntry.pendingUsdc);
        ownerEntry.pendingUsdc = 0;
        feeEntry.pendingUsdc = 0;

        if (feeUsdc != 0) IERC20(s.usdc).safeTransfer(s.feeRecipient, feeUsdc);
        if (netUsdc != 0) IERC20(s.usdc).safeTransfer(owner, netUsdc);
        if (netUsdc != 0 || feeUsdc != 0) {
            emit IRobotMoneyFund.ClaimSettled(i, owner, netUsdc, feeUsdc);
        }
    }

    function _settleClaimUnits(FundState storage s, uint256 i, SettleBurnCtx memory b)
        private
        returns (uint256 gotOwner, uint256 gotFee)
    {
        b.totalScaled = s.lendingEpochs[i][b.cur].totalScaled;
        uint256 combScaled = b.ownerScaled + b.feeScaled;
        if (combScaled == 0 || b.totalScaled == 0) return (0, 0);
        b.combUnits = combScaled.mulDiv(b.c0, b.totalScaled);
        b.u0 = s.positionUnits[i];
        if (b.combUnits == 0 || b.u0 == 0) return (0, 0);
        (b.got, b.burned) = _withdrawForSettle(s, i, b.combUnits, b.u0, b.c0);
        if (b.burned != 0) _applySettleBurn(s, i, b);
        gotFee = b.got.mulDiv(b.feeScaled, combScaled);
        gotOwner = b.got - gotFee;
    }

    function _applySettleBurn(FundState storage s, uint256 i, SettleBurnCtx memory b) private {
        uint256 oBurn = b.ownerScaled.mulDiv(b.burned, b.combUnits);
        if (oBurn > b.ownerScaled) oBurn = b.ownerScaled;
        uint256 fBurn = b.feeScaled.mulDiv(b.burned, b.combUnits);
        if (fBurn > b.feeScaled) fBurn = b.feeScaled;
        if (b.burned == b.combUnits) {
            oBurn = b.ownerScaled;
            fBurn = b.feeScaled;
        }
        s.lendingClaims[i][b.owner].scaled = b.ownerScaled - oBurn;
        s.lendingFeeLinked[i][b.owner].scaled = b.feeScaled - fBurn;
        s.lendingEpochs[i][b.cur].totalScaled = b.totalScaled - (oBurn + fBurn);
        uint256 c1 = b.c0 - b.burned;
        s.positionClaimTotal[i] = c1;
        s.positionUnits[i] = b.u0 - b.burned;
        if (c1 == 0) _rollLendingEpoch(s, i);
        uint256 ownerUnitsBurn = b.burned.mulDiv(b.ownerScaled, b.ownerScaled + b.feeScaled);
        emit IRobotMoneyFund.PositionClaimed(i, b.owner, b.owner, ownerUnitsBurn, b.got);
    }

    function _withdrawForSettle(
        FundState storage s,
        uint256 i,
        uint256 combUnits,
        uint256 u0,
        uint256 c0
    ) private returns (uint256 got, uint256 burned) {
        uint256 p0;
        try IStrategyAdapter(s.assets[i].adapter).totalAssets() returns (uint256 bal) {
            uint256 owed = s.deferredTotal[i];
            p0 = bal > owed ? bal - owed : 0;
        } catch {
            return (0, 0);
        }
        if (p0 == 0) return (0, 0);
        uint256 claimVal = p0.mulDiv(combUnits, u0);
        uint256 fullAsk = claimVal > LENDING_ROUNDING_UNITS ? claimVal - LENDING_ROUNDING_UNITS : 0;
        if (fullAsk == 0) return (0, 0);
        uint256 want = fullAsk;
        try ILendingRateAdapter(s.assets[i].adapter).availableLiquidity() returns (uint256 avail) {
            if (avail < want) want = avail;
        } catch {}
        if (want == 0) return (0, 0);
        got = _tryWithdrawAvailable(s, i, want);
        if (got == 0) return (0, 0);
        if (got >= fullAsk) {
            burned = combUnits <= c0 ? combUnits : c0;
        } else {
            uint256 p1 = _valueAfter(s, i, p0, got);
            // RB-34 / A34: the position may fall only by what arrived (plus venue rounding). A venue that takes more
            // than it pays would book the exiter's slice as paid; refuse it so the net side fails (check 10).
            if (p0 > p1 && p0 - p1 > got + LENDING_ROUNDING_UNITS) {
                revert IRobotMoneyFund.ProportionViolated(i, p0, p1 + got, 1, 1);
            }
            burned = p1 >= p0 ? 0 : (p0 - p1).mulDiv(u0, p0, Math.Rounding.Ceil);
            if (burned > combUnits) burned = combUnits;
        }
    }

    function _takeLendingPot(FundState storage s, uint256 i, uint256 amount)
        private
        returns (uint256 paid)
    {
        if (amount == 0) return 0;
        uint256 pot = s.lendingUsdcPot[i];
        paid = amount <= pot ? amount : pot;
        s.lendingUsdcPot[i] = pot - paid;
        s.reservedClaimUsdc -= paid;
    }

    /// @notice Body of `IRobotMoneyFund.positionClaimOf`: `account`'s claim units on lending position `i` and their
    ///         value today (`units × positionValue / positionUnits` + any already-withdrawn pot USDC), rounded DOWN.
    function claimOf(FundState storage s, uint256 i, address account)
        public
        view
        returns (uint256 units, uint256 usdcValue)
    {
        uint256 legacy = s.positionClaimOf[i][account];
        (uint256 accUnits, uint256 pending) = _lendingEntryUnits(s, i, s.lendingClaims[i][account]);
        units = legacy + accUnits;
        uint256 total = s.positionUnits[i];
        if (units != 0 && total != 0) {
            usdcValue = FundValuationLib.positionValue(s, i).mulDiv(units, total);
        }
        usdcValue += pending;
    }

    /// @notice The claims' part of lending position `i` worth `p`, rounded UP (what an emergency must leave).
    function claimsPart(FundState storage s, uint256 i, uint256 p) internal view returns (uint256) {
        uint256 total = s.positionUnits[i];
        if (total == 0) return 0;
        return p.mulDiv(s.positionClaimTotal[i], total, Math.Rounding.Ceil);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Unit arithmetic
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev The position grew from `p0` to `p1` for the holders: mint `(p1 − p0) × units / p0` holders' units,
    ///      rounded DOWN. The first units of a position: `p1 × POSITION_UNITS_PER_USDC`, all the holders'. A
    ///      position worth 0 that still has units (a venue lost everything): every old unit is worth nothing, so the
    ///      new value goes to the holders by minting `units × p1 × POSITION_UNITS_PER_USDC`, which leaves any old
    ///      claim less than 1 / (1 + p1 × POSITION_UNITS_PER_USDC) of it (below one USDC unit).
    function _mintUnits(FundState storage s, uint256 i, uint256 p0, uint256 p1) private {
        if (p1 <= p0) return;
        uint256 units = s.positionUnits[i];
        if (units == 0 || (p0 == 0 && s.positionClaimTotal[i] == 0)) {
            s.positionUnits[i] = p1 * POSITION_UNITS_PER_USDC;
        } else if (p0 == 0) {
            s.positionUnits[i] = units + units * p1 * POSITION_UNITS_PER_USDC;
        } else {
            s.positionUnits[i] = units + (p1 - p0).mulDiv(units, p0);
        }
    }

    /// @dev The position fell from `p0` to `p1` by a withdrawal for the holders: burn `(p0 − p1) × units / p0`
    ///      holders' units, rounded UP, at most every holders' unit (beyond that a misbehaving venue's loss is shared
    ///      by the claims; check 10 still guards the holders on the flow paths).
    function _burnUnits(FundState storage s, uint256 i, uint256 p0, uint256 p1) private {
        if (p1 >= p0) return;
        uint256 units = s.positionUnits[i];
        if (units == 0) return;
        uint256 b = (p0 - p1).mulDiv(units, p0, Math.Rounding.Ceil);
        uint256 holders = units - s.positionClaimTotal[i];
        if (b > holders) b = holders;
        s.positionUnits[i] = units - b;
    }

    /// @dev `withdraw(amount)` from lending asset `i` (worth `p0` before) under try/catch, for the holders: `ok` false
    ///      when it reverted (nothing moved), `got` the fund's USDC delta, and the holders' units burned for what the
    ///      position lost.
    function _tryTake(FundState storage s, uint256 i, uint256 amount, uint256 p0)
        private
        returns (bool ok, uint256 got)
    {
        IERC20 usdc = IERC20(s.usdc);
        uint256 before = usdc.balanceOf(address(this));
        try IStrategyAdapter(s.assets[i].adapter).withdraw(amount) returns (uint256) {
            ok = true;
        } catch {
            return (false, 0);
        }
        got = usdc.balanceOf(address(this)) - before;
        _burnUnits(s, i, p0, _valueAfter(s, i, p0, got));
    }

    /// @dev Position value after a withdrawal that delivered `got`: the venue's own read, or `p0 − got` when the
    ///      read reverts after the withdrawal.
    function _valueAfter(FundState storage s, uint256 i, uint256 p0, uint256 got)
        private
        view
        returns (uint256)
    {
        try IStrategyAdapter(s.assets[i].adapter).totalAssets() returns (uint256 bal) {
            uint256 owed = s.deferredTotal[i];
            return bal > owed ? bal - owed : 0;
        } catch {
            return p0 > got ? p0 - got : 0;
        }
    }
}
