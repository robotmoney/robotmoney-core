// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §10 phase 3c (G4 fallback), §12 (auction-based
//            rebalance), §5.3 (one step), §7 RB-2, RB-3, RB-4, RB-5
// Experiment prototype only (contracts/test/prototype/). Phase 3c.
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PrototypeHarness} from "./PrototypeHarness.sol";
import {AssetStepParams, Roles, SkipReason, BPS, IDLE_INDEX, AssetKind} from "./src/FundTypes.sol";
import {AuctionStepExecutor, IAuctionFiller} from "./src/AuctionStepExecutor.sol";

/// @notice Phase 3c: the auction executor behind `executeStep`. The test contract is the filler. It mints what
///         it owes, so these tests check the auction's rules, not a solver's sourcing (the sim models that).
contract AuctionExecutorTest is PrototypeHarness, IAuctionFiller {
    uint32 internal constant DURATION = 300;
    uint16 internal constant PREMIUM_BPS = 50;
    uint256 internal constant ALICE_DEPOSIT = 1_000_000e6;

    address internal alice = makeAddr("alice");
    AuctionStepExecutor internal exec;

    struct Leg {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 owed;
        uint256 q;
        uint256 floor;
        uint256 inReceived;
    }

    Leg[] internal legs;
    bool internal payShort;
    bool internal tryReenter;
    bool internal fillReentryRefused;
    bool internal openReentryRefused;

    function _basketAdapter(address poolAdapter) internal override returns (address) {
        exec = new AuctionStepExecutor(poolAdapter, address(fund), USDC, DURATION, PREMIUM_BPS);
        vm.label(address(exec), "auctionExecutor");
        return address(exec);
    }

    /// @dev The deployer binds the Rebalancer and grants the executor KEEPER_ROLE before the timelock handover.
    function _beforeHandover() internal override {
        exec.bindRebalancer(address(rebalancer));
        rebalancer.grantRole(Roles.KEEPER_ROLE, address(exec));
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Filler
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function onAuctionLeg(address tokenIn, address tokenOut, uint256 amountIn, uint256 owed, uint256 q, uint256 floor)
        external
    {
        require(msg.sender == address(exec), "only the executor");
        legs.push(Leg(tokenIn, tokenOut, amountIn, owed, q, floor, IERC20(tokenIn).balanceOf(address(this))));
        if (tryReenter) {
            try exec.fill() {}
            catch (bytes memory err) {
                fillReentryRefused = bytes4(err) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector;
            }
            try exec.open() {}
            catch (bytes memory err) {
                openReentryRefused = bytes4(err) == ReentrancyGuard.ReentrancyGuardReentrantCall.selector;
            }
        }
        uint256 pay = payShort ? owed - 1 : owed;
        if (tokenOut == USDC) fundUsdc(address(this), pay);
        else deal(tokenOut, address(this), IERC20(tokenOut).balanceOf(address(this)) + pay);
        IERC20(tokenOut).approve(address(exec), pay);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Price curve
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev A fill in the open's block pays the start price: the leg's TWAP quote plus the premium. The fund
    ///      gets the tokens, the filler gets the fund's USDC, and the executor keeps nothing (RB-3).
    function test_fillAtOpen_paysTwapPlusPremium_toTheFund() public fixtureCovered {
        _wethBuyPlan();
        (,,, uint256 notional) = rebalancer.previewStep();
        uint256 q = fund.assetTokenValue(IDX_WETH, notional);
        uint256 floor = q * (BPS - rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps) / BPS;
        uint256 wethBefore = IERC20(WETH).balanceOf(address(fund));
        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));

        exec.open();
        vm.recordLogs();
        uint256 elapsed = exec.fill();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(elapsed, 0, "filled in the open's block");
        assertEq(legs.length, 1, "one basket leg");
        Leg memory l = legs[0];
        assertEq(l.tokenIn, USDC, "fund pays USDC");
        assertEq(l.tokenOut, WETH, "fund buys wETH");
        assertEq(l.amountIn, notional, "leg spends the notional");
        assertEq(l.q, q, "quote is the fund's own TWAP quote");
        assertEq(l.floor, floor, "floor is the swap path's TWAP floor");
        assertEq(l.owed, q * (BPS + PREMIUM_BPS) / BPS, "owed at the open = TWAP + premium");
        assertEq(IERC20(WETH).balanceOf(address(fund)) - wethBefore, l.owed, "the fund received what it was owed");
        assertEq(IERC20(USDC).balanceOf(address(this)) - usdcBefore, notional, "filler received the fund's USDC");
        assertEq(IERC20(USDC).balanceOf(address(exec)), 0, "executor holds no USDC");
        assertEq(IERC20(WETH).balanceOf(address(exec)), 0, "executor holds no wETH");
        assertEq(fund.lastStepAt(), vm.getBlockTimestamp(), "the step was recorded");
        assertEq(exec.openedAt(), 0, "the auction closed");
        assertEq(fund.plan().costSpent, 0, "a fill above TWAP costs the fund nothing");
        assertTrue(_logged(logs, AuctionStepExecutor.AuctionLeg.selector), "AuctionLeg logged");
    }

    /// @dev The owed amount falls linearly from TWAP + premium toward the swap path's TWAP floor. Fills run at
    ///      0, D/4 and D/2 (a wETH fill at the floor costs about `maxStepCostBps`, so RB-4 may refuse it). The
    ///      curve itself reaches the floor at DURATION, stays there, and is never below it.
    function test_owed_decaysLinearly_toTheTwapFloor() public fixtureCovered {
        _wethBuyPlan();
        exec.open();
        uint256 t0 = vm.getBlockTimestamp();
        uint256[3] memory es = [uint256(0), DURATION / 4, DURATION / 2];
        uint256[3] memory ratio;
        Leg memory l;
        for (uint256 k; k < es.length; ++k) {
            uint256 snap = vm.snapshotState();
            vm.warp(t0 + es[k]);
            (,,, uint256 notional) = rebalancer.previewStep();
            uint256 floor = fund.assetTokenValue(IDX_WETH, notional)
                * (BPS - rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps) / BPS;
            exec.fill();
            l = legs[legs.length - 1];
            vm.revertToState(snap);
            assertEq(l.floor, floor, "floor is the swap path's TWAP floor");
            assertEq(l.owed, exec.owedAt(l.q, l.floor, es[k]), "owed follows the curve");
            assertGt(l.owed, l.floor, "above the floor before DURATION");
            ratio[k] = l.owed * 1e18 / l.q;
        }
        assertGt(ratio[0], ratio[1], "falls from the open");
        assertGt(ratio[1], ratio[2], "keeps falling");
        uint256 start = 1e18 * (BPS + PREMIUM_BPS) / BPS;
        uint256 end = 1e18 * (BPS - rebalancer.assetStepParams(IDX_WETH).maxStepSlippageBps) / BPS;
        assertApproxEqAbs(ratio[1], start - (start - end) / 4, 1e12, "a quarter of the way down at D/4");
        assertApproxEqAbs(ratio[2], (start + end) / 2, 1e12, "halfway down at D/2");
        assertEq(exec.owedAt(l.q, l.floor, DURATION), l.floor, "the floor at DURATION");
        assertEq(exec.owedAt(l.q, l.floor, 2 * uint256(DURATION)), l.floor, "the floor after DURATION");
        assertEq(exec.owedAt(l.q, l.q * 2, 0), l.q * 2, "never below a floor above the start");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Settlement and authority
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev A filler that pays one unit short: the leg reverts, so the whole fill reverts. Nothing trades, no
    ///      step is recorded and no asset backs off. A filler cannot book a fake failure.
    function test_underpay_revertsTheWholeFill_withoutBackoff() public fixtureCovered {
        _wethBuyPlan();
        exec.open();
        uint256 opened = exec.openedAt();
        uint256 wethBefore = IERC20(WETH).balanceOf(address(fund));
        uint256 idleBefore = fund.idleUsdc();
        payShort = true;
        vm.expectRevert(abi.encodeWithSelector(AuctionStepExecutor.FillNotExecuted.selector, SkipReason.StepFailed));
        exec.fill();
        assertEq(IERC20(WETH).balanceOf(address(fund)), wethBefore, "no wETH moved");
        assertEq(fund.idleUsdc(), idleBefore, "no USDC moved");
        assertEq(fund.lastStepAt(), 0, "no step recorded");
        assertEq(rebalancer.assetBackoffUntil(IDX_WETH), 0, "no backoff");
        assertEq(exec.openedAt(), opened, "the auction stays live");
    }

    /// @dev Open needs a step the Rebalancer would take now, and one auction at a time. Fill needs a live
    ///      auction. After 2 × DURATION the auction lapses and can be opened again. After a fill the cooldown
    ///      blocks the next open (RB-5).
    function test_openAndFill_lifecycle() public fixtureCovered {
        (SkipReason r,,,) = rebalancer.previewStep();
        vm.expectRevert(abi.encodeWithSelector(AuctionStepExecutor.NotReady.selector, r));
        exec.open();
        vm.expectRevert(AuctionStepExecutor.NoAuction.selector);
        exec.fill();

        _wethBuyPlan();
        exec.open();
        uint256 expires = vm.getBlockTimestamp() + 2 * uint256(DURATION);
        vm.expectRevert(abi.encodeWithSelector(AuctionStepExecutor.AuctionLive.selector, expires));
        exec.open();

        vm.warp(expires + 1);
        vm.expectRevert(abi.encodeWithSelector(AuctionStepExecutor.AuctionExpired.selector, expires));
        exec.fill();
        exec.open();
        exec.fill();

        vm.expectRevert(abi.encodeWithSelector(AuctionStepExecutor.NotReady.selector, SkipReason.Cooldown));
        exec.open();
        vm.expectRevert(AuctionStepExecutor.NoAuction.selector);
        exec.fill();
    }

    /// @dev RB-5: spot pushed past the ORA-4 guard after the open. The fill's step skips with MarketDeviation,
    ///      so the fill reverts and nothing trades.
    function test_marketDeviation_afterOpen_fillReverts() public fixtureCovered {
        _wethBuyPlan();
        exec.open();
        _pushUp(WETH_POOL, IDX_WETH, NAV_DEVIATION_BPS + 1);
        uint256 wethBefore = IERC20(WETH).balanceOf(address(fund));
        vm.expectRevert(
            abi.encodeWithSelector(AuctionStepExecutor.FillNotExecuted.selector, SkipReason.MarketDeviation)
        );
        exec.fill();
        assertEq(IERC20(WETH).balanceOf(address(fund)), wethBefore, "nothing traded");
        assertEq(legs.length, 0, "no leg reached the filler");
    }

    /// @dev RB-4 still binds inside a fill. deSPXA's TWAP floor sits 200 bps under TWAP, past the 50 bps step cost
    ///      cap. A fill at that floor makes the fund revert StepCostExceeded. The whole fill reverts, nothing moves
    ///      and no backoff is booked. A fill early on the curve, above the cap, trades.
    function test_fillAtDespxaFloor_hitsTheStepCostCap() public fixtureCovered {
        deposit(alice, 100_000e6);
        timelockExecute(
            address(rebalancer), abi.encodeCall(rebalancer.setAssetStepParams, (IDX_WETH, AssetStepParams(0, 0)))
        );
        timelockExecute(
            address(rebalancer), abi.encodeCall(rebalancer.setAssetStepParams, (IDX_CBBTC, AssetStepParams(0, 0)))
        );
        recordAndApply(bucketVec(0, 0, 10_000));
        vm.warp(fund.plan().endTime);
        (SkipReason r,, uint256 b,) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "setup: a step is ready");
        assertEq(b, IDX_DESPXA, "setup: buy deSPXA");
        assertGt(
            rebalancer.assetStepParams(IDX_DESPXA).maxStepSlippageBps,
            rebalancer.stepParams().maxStepCostBps,
            "setup: the deSPXA floor is below the cost cap"
        );
        exec.open();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 balBefore = IERC20(DESPXA).balanceOf(address(fund));
        uint256 idleBefore = fund.idleUsdc();

        uint256 snap = vm.snapshotState();
        vm.warp(t0 + DURATION);
        vm.expectRevert(abi.encodeWithSelector(AuctionStepExecutor.FillNotExecuted.selector, SkipReason.StepFailed));
        exec.fill();
        assertEq(IERC20(DESPXA).balanceOf(address(fund)), balBefore, "no deSPXA moved");
        assertEq(fund.idleUsdc(), idleBefore, "no USDC moved");
        assertEq(fund.lastStepAt(), 0, "no step recorded");
        assertEq(rebalancer.assetBackoffUntil(IDX_DESPXA), 0, "no backoff");
        vm.revertToState(snap);

        exec.fill();
        Leg memory l = legs[legs.length - 1];
        assertEq(l.tokenOut, DESPXA, "the early fill bought deSPXA");
        assertGt(IERC20(DESPXA).balanceOf(address(fund)), balBefore, "the fund received deSPXA");
    }

    /// @dev The filler's callback cannot re-enter `fill` or `open`.
    function test_fillerCannotReenter() public fixtureCovered {
        _wethBuyPlan();
        exec.open();
        tryReenter = true;
        exec.fill();
        assertTrue(fillReentryRefused, "fill re-entry refused");
        assertTrue(openReentryRefused, "open re-entry refused");
    }

    /// @dev Outside a fill every swap passes through to the pool: a routed deposit and a direct keeper step
    ///      both trade in the pool, no auction leg is logged, and the executor keeps nothing.
    function test_outsideAFill_swapsPassThroughToThePool() public fixtureCovered {
        _wethBuyPlan();
        uint256 wethBefore = IERC20(WETH).balanceOf(address(fund));
        vm.recordLogs();
        (bool did,) = keeperStep();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertTrue(did, "keeper step traded");
        assertGt(IERC20(WETH).balanceOf(address(fund)), wethBefore, "bought wETH in the pool");
        assertFalse(_logged(logs, AuctionStepExecutor.AuctionLeg.selector), "no auction leg");
        assertEq(legs.length, 0, "the filler was never called");
        assertEq(IERC20(USDC).balanceOf(address(exec)), 0, "executor holds no USDC");
        assertEq(IERC20(WETH).balanceOf(address(exec)), 0, "executor holds no wETH");
    }

    /// @dev A basket sell leg: the fund's tokens go to the filler and the fund is owed USDC at TWAP + premium,
    ///      floored at the step's `minSellUsdcOut`.
    function test_sellLeg_owedUsdc_atTwapPlusPremium() public fixtureCovered {
        recordAndApply(bucketVec(6_000, 3_000, 1_000));
        deposit(alice, 100_000e6);
        recordAndApply(bucketVec(10_000, 0, 0));
        vm.warp(fund.plan().endTime);
        (SkipReason r, uint256 sell,, uint256 notional) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "a step is ready");
        assertTrue(sell != IDLE_INDEX && fund.assetConfig(sell).kind == AssetKind.Basket, "sells a basket asset");
        address token = fund.assetConfig(sell).token;
        uint256 amt = fund.assetTokenValue(sell, notional);
        uint256 q = fund.assetUsdcValue(sell, amt);
        uint256 balBefore = IERC20(token).balanceOf(address(fund));

        exec.open();
        exec.fill();

        Leg memory l = legs[0];
        assertEq(l.tokenIn, token, "fund sells the basket token");
        assertEq(l.tokenOut, USDC, "for USDC");
        assertEq(l.amountIn, amt, "the TWAP token amount for the notional");
        assertEq(l.q, q, "quote is the fund's TWAP value");
        assertEq(l.owed, q * (BPS + PREMIUM_BPS) / BPS, "owed at the open = TWAP + premium");
        assertGe(l.inReceived, amt, "filler received the fund's tokens");
        assertEq(balBefore - IERC20(token).balanceOf(address(fund)), amt, "fund paid exactly the leg");
        assertEq(IERC20(token).balanceOf(address(exec)), 0, "executor holds no token");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Adversarial's wETH-only plan: 1M idle, cbBTC not traded, a receipt to (stable 0, protocol 100%),
    ///      warped to the path end. The next step sells idle and buys wETH.
    function _wethBuyPlan() internal {
        deposit(alice, ALICE_DEPOSIT);
        timelockExecute(
            address(rebalancer), abi.encodeCall(rebalancer.setAssetStepParams, (IDX_CBBTC, AssetStepParams(0, 0)))
        );
        recordAndApply(bucketVec(0, 10_000, 0));
        vm.warp(fund.plan().endTime);
        (SkipReason r, uint256 s, uint256 b,) = rebalancer.previewStep();
        assertEq(uint8(r), uint8(SkipReason.None), "setup: a step is ready");
        assertEq(s, IDLE_INDEX, "setup: sell idle");
        assertEq(b, IDX_WETH, "setup: buy weth");
    }

    function _pushUp(address pool, uint256 idx, uint256 minDev) internal {
        uint256 chunk = 25_000e6;
        (, uint256 dev) = fund.marketCheck(idx);
        for (uint256 k; k < 60 && dev < minDev; ++k) {
            movePrice(pool, chunk, true);
            (, dev) = fund.marketCheck(idx);
            if (dev * 2 < minDev) chunk *= 2;
        }
        assertGe(dev, minDev, "push reached its goal");
    }

    function _logged(Vm.Log[] memory logs, bytes32 topic) internal view returns (bool) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(exec) && logs[i].topics[0] == topic) return true;
        }
        return false;
    }
}
