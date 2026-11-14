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
import {FundState} from "./FundStorage.sol";
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
        (ok, got) = _tryTake(s, i, bal - reserved, p0);
        if (!ok || id == 0 || got == 0) return ok;
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
        if (units == 0) return;
        uint256 feeUnits = units.mulDiv(s.exitFeeBps, BPS);
        s.positionClaimTotal[i] += units;
        _credit(s, i, claimant, units - feeUnits);
        _credit(s, i, s.feeRecipient, feeUnits);
    }

    function _credit(FundState storage s, uint256 i, address account, uint256 units) private {
        if (units == 0) return;
        s.positionClaimOf[i][account] += units;
        emit IRobotMoneyFund.PositionClaimRecorded(i, account, units);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Position claims (E9, RB-21)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Body of `IRobotMoneyFund.claimPosition`: pay `account`'s whole claim on lending position `i` at
    ///         today's value, less `LENDING_ROUNDING_UNITS` (venue rounding falls on the claim, never on the holders),
    ///         to `to`, and burn its units. Works whatever the asset's status (inactive, excluded): the claim is a
    ///         share of what is in the venue. Reverts `ZeroAddress`, `NoPositionClaim`, or `DeferredShortfall` while
    ///         the venue cannot pay; the claim then stays whole. A value read that reverts reverts the call.
    /// @return usdc USDC paid to `to`.
    function claimPosition(FundState storage s, uint256 i, address account, address to)
        public
        returns (uint256 usdc)
    {
        if (to == address(0)) revert IFundEvents.ZeroAddress();
        uint256 units = s.positionClaimOf[i][account];
        if (units == 0) revert IRobotMoneyFund.NoPositionClaim(i, account);
        uint256 total = s.positionUnits[i];
        uint256 value = FundValuationLib.positionValue(s, i).mulDiv(units, total);
        s.positionClaimOf[i][account] = 0;
        s.positionClaimTotal[i] -= units;
        s.positionUnits[i] = total - units;
        usdc = value > LENDING_ROUNDING_UNITS ? value - LENDING_ROUNDING_UNITS : 0;
        if (usdc != 0) {
            IERC20 t = IERC20(s.usdc);
            uint256 before = t.balanceOf(address(this));
            IStrategyAdapter(s.assets[i].adapter).withdraw(usdc);
            uint256 got = t.balanceOf(address(this)) - before;
            if (got < usdc) revert IRobotMoneyFund.DeferredShortfall(i, got, usdc);
            t.safeTransfer(to, usdc);
        }
        emit IRobotMoneyFund.PositionClaimed(i, account, to, units, usdc);
    }

    /// @notice Body of `IRobotMoneyFund.positionClaimOf`: `account`'s claim units on lending position `i` and their
    ///         value today, `units × positionValue / positionUnits`, rounded DOWN.
    function claimOf(FundState storage s, uint256 i, address account)
        public
        view
        returns (uint256 units, uint256 usdcValue)
    {
        units = s.positionClaimOf[i][account];
        uint256 total = s.positionUnits[i];
        if (units == 0 || total == 0) return (units, 0);
        usdcValue = FundValuationLib.positionValue(s, i).mulDiv(units, total);
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
