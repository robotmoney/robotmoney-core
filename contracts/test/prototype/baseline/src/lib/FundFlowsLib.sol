// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.3 (deficit-first deposits), §4.4 (redemptions),
//            §5.3 steps 5-8 (executeStep), §5.8 (threats), §6 (emergency unwind), §7 RB-3, RB-4, RB-6, RB-7
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IStrategyAdapter} from "../../../../../interfaces/IStrategyAdapter.sol";
import {IBasketSwapAdapter} from "../../../../../interfaces/IBasketSwapAdapter.sol";
import {ISwapRouter} from "../../../../../interfaces/ISwapRouter.sol";
import {BasketSwaps} from "../../../../../lib/BasketSwaps.sol";
import {RobotMoneyVaultOps} from "../../../../../lib/RobotMoneyVaultOps.sol";
import {ExclusionLedger} from "../../../../../ExclusionLedger.sol";
import {ForeignTokenQuarantine} from "../../../../../lib/ForeignTokenQuarantine.sol";
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
    MAX_STEP_COST_BPS
} from "../FundTypes.sol";
import {PlanMath} from "../PlanMath.sol";
import {IRobotMoneyFund} from "../interfaces/IRobotMoneyFund.sol";
import {FundState} from "./FundStorage.sol";
import {FundValuationLib} from "./FundValuationLib.sol";

/// @title FundFlowsLib
/// @notice Every value-moving path of `RobotMoneyFund` except the share mint/burn and the final payouts, as an
///         externally linked library (DELEGATECALL: `address(this)` is the fund, approvals and balances are
///         the fund's). Every swap goes through `BasketSwaps.swap` with the asset's allowlisted
///         `IBasketSwapAdapter` and pays the fund itself. Every USDC that leaves the fund here goes to an
///         allowlisted Lending adapter, a Basket swap adapter, or the fund's `ExclusionLedger` (RB-3, INV-1).
///         No function here takes a recipient.
library FundFlowsLib {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ═════════════════════════════════════════════════════════════════════════
    //  Deposit (§4.3)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice The deposit path up to the mint (§4.3), ported from `BasketVault._deposit`. The fund holds
    ///         `nonReentrant`, mints the returned shares and emits `Deposit`.
    ///         1. Gates: `DepositsArePaused`, `FundIsShutdown`, `PerDepositCapExceeded`,
    ///            `DepositsClosedDuringExclusion` while a Lending asset is excluded (core 1788), ORA-4 on every active Basket asset
    ///            (`NavMarketDeviationExceeded`), `TVLCapExceeded` against the pre-deposit NAV.
    ///         2. Pull `assets` USDC from `caller`; route deficit-first against `currentTargetBps()`.
    ///         3. `delta = navAfter − navBefore` at TWAP; `DepositBelowSlippageFloor` when
    ///            `delta < assets × (1 − maxSlippageBps)`; shares `= delta × (supplyBefore + 10^18) /
    ///            (navBefore + 1)`, floored (AZ-BSK-1/-3: realized delta over the FULL pre-deposit NAV).
    function deposit(FundState storage s, address caller, uint256 assets, uint256 supplyBefore)
        public
        returns (uint256 shares)
    {
        if (s.depositsPaused) revert IRobotMoneyFund.DepositsArePaused();
        if (s.shutdown) revert IRobotMoneyFund.FundIsShutdown();
        if (assets > s.perDepositCap) revert IRobotMoneyFund.PerDepositCapExceeded();
        FundValuationLib.requireDepositable(s);
        (uint256 navBefore,, uint256[] memory values) = FundValuationLib.portfolio(s);
        if (navBefore + assets > s.tvlCap) revert IRobotMoneyFund.TVLCapExceeded();
        uint256[] memory curBps = FundValuationLib.currentTargetBps(s);
        IERC20(s.usdc).safeTransferFrom(caller, address(this), assets);
        routeDeposit(s, assets, navBefore, values, curBps);
        uint256 navAfter = FundValuationLib.nav(s);
        uint256 delta = navAfter > navBefore ? navAfter - navBefore : 0;
        uint256 floor = assets.mulDiv(BPS - s.maxSlippageBps, BPS);
        if (delta < floor) revert IRobotMoneyFund.DepositBelowSlippageFloor(delta, floor);
        shares = delta.mulDiv(supplyBefore + 1e18, navBefore + 1, Math.Rounding.Floor);
    }

    /// @notice Route `amount` USDC (already idle in the fund) deficit-first (§4.3, D7): `PlanMath.deficitSplit`
    ///         against `curBps` (the current plan target), measured at `navBefore` with per-asset `values`.
    ///         - Lending legs are clipped at the asset's `capBps` headroom of the post-deposit NAV (the
    ///           ported `RobotMoneyVault` cap allocator), and a venue that refuses the supply hands the USDC
    ///           back (security round 2); both stay idle.
    ///         - Basket legs buy through the asset's swap adapter with `minOut = TWAP × (1 − maxSlippageBps)`
    ///           (the `BasketVault._routeDeposit` floor). A leg whose floor rounds to 0 stays idle (dust).
    ///         Excluded or inactive assets get nothing. The caller mints on the realized NAV delta.
    function routeDeposit(
        FundState storage s,
        uint256 amount,
        uint256 navBefore,
        uint256[] memory values,
        uint256[] memory curBps
    ) public {
        uint256[] memory alloc = PlanMath.deficitSplit(values, navBefore, amount, curBps);
        uint256 navAfter = navBefore + amount;
        uint256 n = alloc.length;
        for (uint256 i; i < n; ++i) {
            uint256 amt = alloc[i];
            if (amt == 0 || !FundValuationLib.isCounted(s, i)) continue;
            AssetConfig memory a = s.assets[i];
            if (a.kind == AssetKind.Lending) {
                uint256 cap = navAfter.mulDiv(a.capBps, BPS);
                uint256 room = cap > values[i] ? cap - values[i] : 0;
                if (amt > room) amt = room;
                if (amt != 0) _deploy(s.usdc, a.adapter, amt);
            } else {
                uint256 minOut = _haircut(FundValuationLib.tokenValue(s, i, amt), s.maxSlippageBps);
                if (minOut != 0) _swap(a, s.usdc, a.token, amt, minOut);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Redeem (§4.4)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Realize `shares / supplyBefore` of every holding into USDC (§4.4): the pro-rata idle, a
    ///         pro-rata `withdraw` from each counted Lending adapter, and a pro-rata sale of each active
    ///         Basket token (`BasketVault._sellProportional`, unchanged: floor = TWAP of one unit less ×
    ///         (1 − maxSlippageBps), a zero floor is dust and is skipped). Returns the realized gross.
    /// @dev Short fills never revert here: a Lending leg pays what the adapter actually delivered (balance
    ///      delta), never the asked amount. Each leg floors, so rounding favours the holders who stay.
    ///      Called after the shares burned (nonReentrant fund entry). Never reads plan state (RB-6).
    ///      Strict by design: a frozen venue (a Lending `withdraw` or a Basket swap that reverts) reverts the
    ///      redeem, as on `BasketVault.redeem` and `RobotMoneyVault.redeem`. The design promises only that
    ///      `redeemInKind` stays open under a venue freeze (§5.8 row 7); see `payInKind`. Every leg is taken
    ///      from `heldBalance`, so value owed to past in-kind exits is never sold or paid twice.
    function sellProportional(FundState storage s, uint256 shares, uint256 supplyBefore)
        public
        returns (uint256 usdcOut)
    {
        address usdc = s.usdc;
        usdcOut = IERC20(usdc).balanceOf(address(this)).mulDiv(shares, supplyBefore);
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            if (s.assets[i].kind != AssetKind.Lending || !FundValuationLib.isCounted(s, i)) continue;
            uint256 want = FundValuationLib.heldBalance(s, i).mulDiv(shares, supplyBefore);
            if (want == 0) continue;
            uint256 before = IERC20(usdc).balanceOf(address(this));
            IStrategyAdapter(s.assets[i].adapter).withdraw(want);
            usdcOut += IERC20(usdc).balanceOf(address(this)) - before;
        }
        for (uint256 i; i < n; ++i) {
            AssetConfig memory a = s.assets[i];
            if (!a.active || a.kind != AssetKind.Basket) continue;
            uint256 sellAmount = FundValuationLib.heldBalance(s, i).mulDiv(shares, supplyBefore);
            if (sellAmount == 0) continue;
            // Core 1778: price one input unit less (a V3 pool rounds the fee-adjusted input down by one).
            uint256 minOut = _haircut(FundValuationLib.usdcValue(s, i, sellAmount - 1), s.maxSlippageBps);
            if (minOut == 0) continue;
            usdcOut += _swap(a, a.token, usdc, sellAmount, minOut);
        }
    }

    /// @notice Realize the redeemed shares (`sellProportional`), charge `exitFeeBps` on the REALIZED gross only
    ///         (FEE-2 / NC-11), pay the fee to `feeRecipient` and the rest to `receiver` (the caller's own
    ///         ERC-4626 receiver). Emits `ExitFeeCharged`. Returns the USDC paid to `receiver`.
    function redeemPayout(FundState storage s, address owner, address receiver, uint256 shares, uint256 supplyBefore)
        public
        returns (uint256 net)
    {
        uint256 gross = sellProportional(s, shares, supplyBefore);
        uint256 fee = gross.mulDiv(s.exitFeeBps, BPS);
        net = gross - fee;
        IERC20 usdc = IERC20(s.usdc);
        if (fee != 0) usdc.safeTransfer(s.feeRecipient, fee);
        usdc.safeTransfer(receiver, net);
        emit IRobotMoneyFund.ExitFeeCharged(owner, gross, fee);
    }

    /// @notice Permissionless foreign-token sweep to the fixed quarantine address (INV-1/INV-2). Reverts
    ///         `ProtectedToken` for USDC, the share token, every asset token (active or not) and every Lending
    ///         adapter address. Emits `ForeignTokenSwept`.
    function sweepForeign(FundState storage s, address token, address caller) public {
        if (token == s.usdc || token == address(this)) revert IRobotMoneyFund.ProtectedToken(token);
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
    function payInKind(FundState storage s, address receiver, uint256 shares, uint256 supplyBefore) public {
        address usdc = s.usdc;
        uint256 fee = s.exitFeeBps;
        address feeTo = s.feeRecipient;
        uint256 usdcLeg = IERC20(usdc).balanceOf(address(this)).mulDiv(shares, supplyBefore);
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            if (s.assets[i].kind != AssetKind.Lending || !FundValuationLib.isCounted(s, i)) continue;
            uint256 want = FundValuationLib.heldBalance(s, i).mulDiv(shares, supplyBefore);
            if (want == 0) continue;
            uint256 before = IERC20(usdc).balanceOf(address(this));
            try IStrategyAdapter(s.assets[i].adapter).withdraw(want) returns (uint256) {} catch {}
            uint256 got = IERC20(usdc).balanceOf(address(this)) - before;
            usdcLeg += got;
            if (got < want) _deferSplit(s, i, want - got, receiver, fee, feeTo);
        }
        _payLeg(usdc, receiver, usdcLeg, fee, feeTo);
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (!a.active || a.kind != AssetKind.Basket) continue;
            uint256 amount = FundValuationLib.heldBalance(s, i).mulDiv(shares, supplyBefore);
            if (amount == 0) continue;
            uint256 feeAmt = amount.mulDiv(fee, BPS);
            if (!_tryTransfer(a.token, receiver, amount - feeAmt)) {
                _deferSplit(s, i, amount, receiver, fee, feeTo);
            } else if (feeAmt != 0 && !_tryTransfer(a.token, feeTo, feeAmt)) {
                _defer(s, i, feeTo, feeAmt);
            }
        }
    }

    /// @notice Pay `account` everything it is owed from asset `index` (`IRobotMoneyFund.claimDeferred`), to
    ///         `to` (the account's own choice, as an ERC-4626 receiver). Basket: transfer the tokens. Lending:
    ///         `withdraw` exactly the owed USDC from the adapter (`DeferredShortfall` when it delivers less, so
    ///         the claim stays whole) and transfer it. Works whatever the asset's status (inactive, excluded):
    ///         the claim was fixed at exit time. Reverts `NothingDeferred` when nothing is owed.
    function claimDeferred(FundState storage s, uint256 index, address account, address to)
        public
        returns (uint256 amount)
    {
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

    /// @dev Defer `amount` of asset `i` owed to an in-kind exit: the `feeBps` share to `feeTo`, the rest to
    ///      `receiver` (the split an unfrozen leg would have paid).
    function _deferSplit(
        FundState storage s,
        uint256 i,
        uint256 amount,
        address receiver,
        uint256 feeBps,
        address feeTo
    ) private {
        uint256 feeAmt = amount.mulDiv(feeBps, BPS);
        _defer(s, i, receiver, amount - feeAmt);
        _defer(s, i, feeTo, feeAmt);
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

    /// @notice The legs of one rebalance step (`IRobotMoneyFund.executeStep`). The fund checks the role and
    ///         holds `nonReentrant`. Order: plan Open → legs valid and counted, ORA-4 on Basket legs (RB-5)
    ///         → RB-7 path guard at `navBefore` → sell leg → buy leg → `navAfter` and the cost cap (RB-4)
    ///         → plan accounting and the budget halt → `StepExecuted`.
    function executeStep(FundState storage s, StepOrder memory o) public returns (StepResult memory r) {
        Plan storage p = s.plan;
        if (p.status != PlanStatus.Open) {
            revert IRobotMoneyFund.InvalidPlanTransition(p.id, p.status, PlanStatus.Open);
        }
        // RB-4 defence in depth: whatever the caller asks, a step may never accept a loss above the global
        // `MAX_STEP_COST_BPS` ceiling of its notional (the Rebalancer's governed cap sits at or below it).
        if (o.notionalUsdc == 0 || o.maxCostUsdc > o.notionalUsdc.mulDiv(MAX_STEP_COST_BPS, BPS)) {
            revert IFundEvents.InvalidParam();
        }
        if (o.sellIndex == o.buyIndex) revert IFundEvents.InvalidAssetIndex(o.buyIndex);
        _checkLeg(s, o.sellIndex);
        _checkLeg(s, o.buyIndex);
        r.navBefore = _pathGuard(s, o);
        _sellLeg(s, o, r);
        _buyLeg(s, o, r);
        r.navAfter = FundValuationLib.nav(s);
        r.cost = r.navBefore > r.navAfter ? r.navBefore - r.navAfter : 0;
        if (r.cost > o.maxCostUsdc) revert IRobotMoneyFund.StepCostExceeded(r.cost, o.maxCostUsdc);
        p.costSpent += r.cost;
        p.stepCount += 1;
        s.lastStepAt = uint64(block.timestamp);
        if (p.costSpent > p.costBudget) {
            p.status = PlanStatus.Halted;
            emit IFundEvents.PlanStatusChanged(p.id, PlanStatus.Open, PlanStatus.Halted);
        }
        _emitStep(p.id, o, r);
    }

    /// @dev A non-idle leg must name a counted (active, not excluded) asset, and a Basket leg must pass ORA-4
    ///      (RB-5 defence in depth: the Rebalancer already masks failing assets).
    function _checkLeg(FundState storage s, uint256 i) private view {
        if (i == IDLE_INDEX) return;
        if (i >= s.assets.length || !FundValuationLib.isCounted(s, i)) revert IFundEvents.InvalidAssetIndex(i);
        if (s.assets[i].kind == AssetKind.Basket) FundValuationLib.requireMarket(s, i);
    }

    /// @dev RB-7 guard: at `navBefore` and `now`, the sell leg sits over its `pathTarget` value by at least the
    ///      notional and a non-idle buy leg sits under it by at least the notional (`PlanMath.pathTargetValue`,
    ///      the same function the Rebalancer sizes with). Returns `navBefore`.
    function _pathGuard(FundState storage s, StepOrder memory o) private view returns (uint256 navBefore) {
        uint256 idle;
        uint256[] memory values;
        (navBefore, idle, values) = FundValuationLib.portfolio(s);
        Plan memory pm = s.plan;
        uint256 n = o.notionalUsdc;
        uint256 v = o.sellIndex == IDLE_INDEX ? idle : values[o.sellIndex];
        uint256 t = PlanMath.pathTargetValue(pm, o.sellIndex, block.timestamp, navBefore);
        if (v < t + n) revert IRobotMoneyFund.StepExceedsPath(o.sellIndex, n, v > t ? v - t : 0);
        if (o.buyIndex == IDLE_INDEX) return navBefore;
        v = values[o.buyIndex];
        t = PlanMath.pathTargetValue(pm, o.buyIndex, block.timestamp, navBefore);
        if (t < v + n) revert IRobotMoneyFund.StepExceedsPath(o.buyIndex, n, t > v ? t - v : 0);
    }

    /// @dev Sell leg → USDC (§5.3 step 6). Idle: take `notional` of idle (`InsufficientIdle`). Lending:
    ///      `withdraw(notional)`, measured by the fund's balance delta. Basket: sell
    ///      `min(balance, TWAP tokens for notional)` with floor `minSellUsdcOut`. Then require the USDC
    ///      received ≥ `minSellUsdcOut` (`StepBelowMinOut`).
    function _sellLeg(FundState storage s, StepOrder memory o, StepResult memory r) private {
        address usdc = s.usdc;
        uint256 n = o.notionalUsdc;
        uint256 got;
        if (o.sellIndex == IDLE_INDEX) {
            uint256 idle = IERC20(usdc).balanceOf(address(this));
            if (idle < n) revert IRobotMoneyFund.InsufficientIdle(n, idle);
            r.amountIn = n;
            got = n;
        } else {
            AssetConfig memory a = s.assets[o.sellIndex];
            if (a.kind == AssetKind.Lending) {
                uint256 before = IERC20(usdc).balanceOf(address(this));
                IStrategyAdapter(a.adapter).withdraw(n);
                got = IERC20(usdc).balanceOf(address(this)) - before;
                r.amountIn = got;
            } else {
                uint256 amt = FundValuationLib.tokenValue(s, o.sellIndex, n);
                uint256 bal = FundValuationLib.heldBalance(s, o.sellIndex);
                if (amt > bal) amt = bal;
                r.amountIn = amt;
                got = _swap(a, a.token, usdc, amt, o.minSellUsdcOut);
            }
        }
        if (got < o.minSellUsdcOut) revert IRobotMoneyFund.StepBelowMinOut(o.sellIndex, got, o.minSellUsdcOut);
        r.usdcMoved = got;
    }

    /// @dev Buy leg (§5.3 step 6) with `spend = min(received, notional)`: idle keeps it; Lending deploys it
    ///      (USDC the venue hands back stays idle; `amountOut` is what the adapter kept); Basket buys with floor
    ///      `minBuyOut × spend / notional` (`StepBelowMinOut`). USDC received beyond the notional stays idle.
    function _buyLeg(FundState storage s, StepOrder memory o, StepResult memory r) private {
        uint256 spend = r.usdcMoved < o.notionalUsdc ? r.usdcMoved : o.notionalUsdc;
        if (o.buyIndex == IDLE_INDEX) {
            r.amountOut = spend;
            return;
        }
        AssetConfig memory a = s.assets[o.buyIndex];
        if (a.kind == AssetKind.Lending) {
            r.amountOut = _deploy(s.usdc, a.adapter, spend);
            return;
        }
        uint256 minOut = o.minBuyOut.mulDiv(spend, o.notionalUsdc);
        uint256 got = _swap(a, s.usdc, a.token, spend, minOut);
        if (got < minOut) revert IRobotMoneyFund.StepBelowMinOut(o.buyIndex, got, minOut);
        r.amountOut = got;
    }

    /// @dev `StepExecuted` in its own frame (stack depth without viaIR).
    function _emitStep(uint256 planId, StepOrder memory o, StepResult memory r) private {
        emit IFundEvents.StepExecuted(
            planId,
            o.sellIndex,
            o.buyIndex,
            o.notionalUsdc,
            r.amountIn,
            r.usdcMoved,
            r.amountOut,
            r.navBefore,
            r.navAfter,
            r.cost
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Emergency unwind (§6: BasketVault.emergencyUnwind + RobotMoneyVault.emergencyWithdraw)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Move every holding to idle USDC. Lending: drain each active adapter, tolerant of a failing
    ///         adapter (`RobotMoneyVaultOps._emergencyPull`); an adapter under an open exclusion record is
    ///         drained INTO its record, never into idle (exclusion is not confiscation, core 1820). Basket:
    ///         sell each active balance with floor = TWAP × (1 − maxSlippageBps) (`BasketSwaps.unwindAll`); a
    ///         zero floor is dust and is skipped; a leg whose TWAP read fails is skipped and stays held (there
    ///         is no configured-floor override here, see the fund's NatSpec). A swap below its floor reverts
    ///         the whole unwind, as on BasketVault. Returns the USDC that reached idle.
    function emergencyUnwind(FundState storage s) public returns (uint256 recovered) {
        address usdc = s.usdc;
        uint256 before = IERC20(usdc).balanceOf(address(this));
        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig memory a = s.assets[i];
            if (!a.active) continue;
            if (a.kind == AssetKind.Lending) {
                drain(
                    usdc,
                    a.adapter,
                    x.ledger,
                    x.openExclusionOf[i],
                    ExclusionLedger.RecoverySource.EmergencyWithdraw,
                    s.deferredTotal[i]
                );
                continue;
            }
            uint256 bal = FundValuationLib.heldBalance(s, i);
            if (bal == 0) continue;
            try IBasketSwapAdapter(a.adapter).twapPrice(a.pool, a.token, usdc, bal, a.twapWindow) returns (
                uint256 v
            ) {
                uint256 floor = _haircut(v, s.maxSlippageBps);
                if (floor != 0) _swap(a, a.token, usdc, bal, floor);
            } catch {}
        }
        uint256 afterBal = IERC20(usdc).balanceOf(address(this));
        recovered = afterBal > before ? afterBal - before : 0;
    }

    /// @notice Withdraw `adapter`'s whole reported balance, tolerant of a failing adapter. With `id != 0` the
    ///         USDC that arrived (balance delta, never the adapter's return value) moves into exclusion
    ///         record `id` of `ledger` (`RobotMoneyVaultOps._drain` + `_credit`). `ok` is false when
    ///         `totalAssets` or `withdraw` reverted. The `reserved` USDC (owed to in-kind exits, `deferredTotal`)
    ///         is left in the adapter for `claimDeferred`: it belongs neither to idle nor to an exclusion record.
    function drain(
        address usdc,
        address adapter,
        ExclusionLedger ledger,
        uint256 id,
        ExclusionLedger.RecoverySource source,
        uint256 reserved
    ) public returns (bool ok) {
        uint256 balance;
        try IStrategyAdapter(adapter).totalAssets() returns (uint256 reported) {
            balance = reported;
        } catch {
            return false;
        }
        if (balance <= reserved) return true;
        balance -= reserved;
        uint256 before = IERC20(usdc).balanceOf(address(this));
        try IStrategyAdapter(adapter).withdraw(balance) returns (uint256) {}
        catch {
            return false;
        }
        if (id == 0) return true;
        uint256 got = IERC20(usdc).balanceOf(address(this)) - before;
        if (got == 0) return true;
        IERC20(usdc).safeTransfer(address(ledger), got);
        ledger.credit(id, got, source);
        return true;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Move `amount` USDC into Lending `adapter` and deploy it; return what the adapter kept (the fund's
    ///      balance delta, `RobotMoneyVaultOps._allocate`). A refused supply comes straight back and stays idle.
    function _deploy(address usdc, address adapter, uint256 amount) private returns (uint256 placed) {
        uint256 before = IERC20(usdc).balanceOf(address(this));
        IERC20(usdc).safeTransfer(adapter, amount);
        IStrategyAdapter(adapter).deploy(amount);
        uint256 handedBack = IERC20(usdc).balanceOf(address(this)) + amount - before;
        placed = handedBack >= amount ? 0 : amount - handedBack;
    }

    /// @dev Swap through the asset's adapter (`BasketSwaps.swap`: approve, swap with recipient = the fund,
    ///      clear approval). Returns `tokenOut` received by balance delta.
    function _swap(AssetConfig memory a, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        private
        returns (uint256 got)
    {
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        BasketSwaps.swap(a.adapter, tokenIn, tokenOut, a.poolFee, amountIn, minOut, ISwapRouter(address(0)));
        got = IERC20(tokenOut).balanceOf(address(this)) - before;
    }

    /// @dev Pay one in-kind leg: `exitFeeBps` of it to `feeTo`, the rest to `receiver`.
    function _payLeg(address token, address receiver, uint256 amount, uint256 feeBps, address feeTo) private {
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
