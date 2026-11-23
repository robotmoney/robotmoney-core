// SPDX-License-Identifier: MIT
// Canonical: docs/code-reviews/20261121-214700-agy/05-meta-review-and-missed-findings.md (MISSED-01, MISSED-05);
//            docs/code-reviews/20261121-214700-agy/02-economic-manipulation-and-asset-safety.md (AGY-01, AGY-03)
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FlowParams, IFlowEvents, MAX_OWNER_OPEN_REQUESTS, Settlement, SettleCheck} from "../../FlowTypes.sol";
import {FlowQueueBase} from "./FlowQueue.t.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {AssetConfig} from "../../FundTypes.sol";
import {ILendingRateAdapter} from "../../interfaces/IFlowAdapters.sol";
import {IRobotMoneyFund} from "../../interfaces/IRobotMoneyFund.sol";
import {BPS, PlanParams, PlanStatus, Roles, SkipReason} from "../../FundTypes.sol";
import {AdminFloorAccessControl} from "../../lib/AdminFloorAccessControl.sol";

/// @notice A contract that answers like a Uniswap V3 pool but was not made by the factory (AGY-13).
interface IWeth9 {
    function deposit() external payable;
}

contract FakeV3Pool {
    address public token0;
    address public token1;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function fee() external pure returns (uint24) {
        return 500;
    }

    function slot0() external pure returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (2 ** 96, 0, 0, 1, 1, 0, true);
    }
}

/// @title SafetyReview090Test
/// @notice Proof tests for the agy safety review of 0.9.0. Each test states the failure the review claims as a
///         property that must hold. A test that failed before its fix is the proof the finding was real.
contract SafetyReview090Test is FlowQueueBase {
    /// @dev EIP-7825 per-transaction gas cap (2^24). A keeper call above it cannot be included at all.
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    /// @dev `settle(maxRequests)` a keeper sends under a 2^24 per-tx gas cap: the side call reserves 450 000 gas a fill.
    uint256 internal constant KEEPER_MAX_REQUESTS = 16;

    /// @dev Dust requests the attack test opens in one epoch.
    uint256 internal constant SPAM_REQUESTS = 300;

    address internal attacker = makeAddr("attacker");

    // ───────────────────────────── MISSED-01 ─────────────────────────────

    /// @notice Many holders each open a one-wei whole-balance redemption in one epoch. Every keeper settle call must
    ///         fit under the per-tx gas cap, and repeated calls must finish the round.
    function test_MISSED01_dustRedeemFloodCannotBrickSettle() public fixtureCovered {
        _invest();
        uint256 shares = _holder(attacker, 1_000e6);
        assertGt(shares, SPAM_REQUESTS, "attacker holds enough wei of shares");

        uint256 lastId;
        for (uint256 k; k < SPAM_REQUESTS; ++k) {
            address sybil = address(uint160(0xD05E0000 + k));
            vm.prank(attacker);
            IERC20(address(fund)).transfer(sybil, 1);
            vm.startPrank(sybil);
            IERC20(address(fund)).approve(address(queue), 1);
            lastId = queue.requestRedeem(1, sybil);
            vm.stopPrank();
            if (k % 20 == 19) coverageCheckpoint();
        }
        coverageCheckpoint();

        warpToSettleable(lastId);
        refreshFeeds();
        uint256 worst;
        bool finished;
        for (uint256 k; k < 32; ++k) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 2);
            uint256 g = gasleft();
            vm.prank(keeper);
            (bool ok, bytes memory ret) = address(queue).call{gas: TX_GAS_CAP}(
                abi.encodeCall(queue.settle, (KEEPER_MAX_REQUESTS, type(uint256).max))
            );
            uint256 used = g - gasleft();
            if (used > worst) worst = used;
            console2.log("settle call", k, used, ok);
            assertTrue(ok || _selector(ret) == IFlowEvents.SettleBlocked.selector, "settle fits in one tx");
            vm.prank(keeper);
            (SettleCheck check,) = queue.checkSettle();
            if (k % 2 == 1) coverageCheckpoint();
            if (check == SettleCheck.Window) {
                finished = true;
                break;
            }
        }
        console2.log("worst settle gas", worst);
        assertLt(worst, TX_GAS_CAP / 2, "every settle call stays well under the per-tx gas cap");
        assertTrue(finished, "repeated keeper calls finish the round");
        assertTrue(queue.getRequest(lastId).closed, "the last dust request settled");
    }

    /// @notice One owner holds at most `MAX_OWNER_OPEN_REQUESTS` open redemptions, and a request naming another owner
    ///         must meet the minimum: dust cannot fill a victim's slots.
    function test_MISSED01_ownerOpenRequestCapAndNoThirdPartyDust() public fixtureCovered {
        _invest();
        uint256 held = _holder(attacker, 20_000e6);
        uint256 minUsdc = queue.flowParams().minRequestUsdc;
        // About 1 000 USDC each: above the minimum, and 16 of them fit in the holding.
        uint256 minShares = held / 20;

        vm.startPrank(attacker);
        IERC20(address(fund)).approve(address(queue), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(IFlowEvents.BelowMinRequest.selector, uint256(0), minUsdc)
        );
        queue.requestRedeem(1, bob);
        for (uint256 k; k < MAX_OWNER_OPEN_REQUESTS; ++k) {
            queue.requestRedeem(minShares, attacker);
        }
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.TooManyOpenRequests.selector, attacker));
        queue.requestRedeem(minShares, attacker);
        vm.stopPrank();
    }

    // ───────────────────────────── MISSED-05 ─────────────────────────────

    /// @notice A delisting asset whose feed died must not block the rebalancer from stepping the healthy assets. The
    ///         fund's own step already masks in-sale assets out of the feed check. The rebalancer's decision must too.
    function test_MISSED05_deadFeedOfInSaleAssetDoesNotBlockRebalance() public fixtureCovered {
        investFund(assetVec(1_500, 1_500, 5_000, 2_000, 0));
        coverageCheckpoint();
        // A live plan with work: move 10 % from Moonwell to Aave.
        setTargetViaTimelock(assetVec(2_500, 500, 5_000, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.delistAsset, (IDX_CBBTC)));
        assertTrue(fund.isAssetInSale(IDX_CBBTC), "cbBTC is in sale");

        vm.warp(block.timestamp + rebalancer.effectiveStepInterval() + 2);
        refreshFeeds();
        // cbBTC's feed stops: its last round is two days old, past its 24 h max age.
        uint256 old = block.timestamp - 2 days;
        MockAggregator(FEED_CBBTC).setRound(8, feedPrice8[FEED_CBBTC], old, old);

        (SkipReason reason,,,) = rebalancer.previewStep();
        assertTrue(reason != SkipReason.FeedCheck, "the in-sale asset's dead feed does not block the step");
    }

    // ───────────────────────────── AGY-01, AGY-03 ─────────────────────────────

    /// @notice With wETH's feed dead, a single-asset unwind must name a floor (AGY-01). With one it sells the whole
    ///         leg, and the emptied asset leaves the active set even while a plan is live, so the dead feed no longer
    ///         blocks the fund's NAV or the queue (AGY-03).
    function test_AGY01_AGY03_deadFeedUnwindNeedsAFloorAndFreesTheFund() public fixtureCovered {
        _invest();
        setTargetViaTimelock(bucketVec(6_000, 4_000), PlanParams(1 days, COST_BUDGET_BPS));
        uint256 held = IERC20(WETH).balanceOf(address(fund));
        assertGt(held, 0, "weth held");
        // 95 % of the leg's value at the pool's price (USD 8 decimals a whole token, USDC 6 decimals).
        uint256 minOut = held * poolPrice8(WETH_POOL, WETH) / 1e18 / 100 * 95 / 100;

        bytes memory noFloor =
            abi.encodeWithSignature("emergencyUnwind(uint256,uint256)", IDX_WETH, uint256(0));
        bytes memory floored =
            abi.encodeWithSignature("emergencyUnwind(uint256,uint256)", IDX_WETH, minOut);
        timelock.schedule(address(fund), 0, noFloor, bytes32(0), bytes32("a"), TIMELOCK_DELAY);
        timelock.schedule(address(fund), 0, floored, bytes32(0), bytes32("b"), TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        refreshFeeds();
        uint256 old = block.timestamp - 1 days;
        MockAggregator(FEED_ETH).setRound(8, feedPrice8[FEED_ETH], old, old);

        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.EmergencyFloorRequired.selector, IDX_WETH));
        timelock.execute(address(fund), 0, noFloor, bytes32(0), bytes32("a"));
        assertEq(IERC20(WETH).balanceOf(address(fund)), held, "no floor: nothing sold");

        uint256 idleBefore = fund.idleUsdc();
        timelock.execute(address(fund), 0, floored, bytes32(0), bytes32("b"));
        assertEq(IERC20(WETH).balanceOf(address(fund)), 0, "the whole leg sold");
        assertGe(fund.idleUsdc() - idleBefore, minOut, "at or above the floor");
        assertFalse(fund.assetConfig(IDX_WETH).active, "the emptied asset is deactivated");

        // The dead feed is still dead. The fund values, and the queue's feed check passes.
        assertGt(fund.totalAssets(), 0, "NAV reads");
        openDepositRequest(alice, 1_000e6);
        uint256 id = queue.requestCount();
        warpToSettleable(id);
        refreshFeeds();
        MockAggregator(FEED_ETH).setRound(8, feedPrice8[FEED_ETH], old, old);
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertTrue(check != SettleCheck.Feed, "the dead feed does not block settlement");
    }

    // ───────────────────────────── AGY-08 ─────────────────────────────

    /// @notice The last `TARGET_SETTER_ROLE` holder cannot renounce or be revoked: the role is self-administered, so
    ///         zero holders would end target setting for good. A second holder lets the first one go.
    function test_AGY08_targetSetterRoleHasALastHolderFloor() public fixtureCovered {
        bytes32 role = Roles.TARGET_SETTER_ROLE;
        assertEq(governance.getRoleMemberCount(role), 1, "the timelock is the only target setter");
        vm.prank(address(timelock));
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        governance.renounceRole(role, address(timelock));
        vm.prank(address(timelock));
        vm.expectRevert(AdminFloorAccessControl.LastAdminFloor.selector);
        governance.revokeRole(role, address(timelock));

        address next = makeAddr("nextTimelock");
        vm.startPrank(address(timelock));
        governance.grantRole(role, next);
        governance.renounceRole(role, address(timelock));
        vm.stopPrank();
        assertTrue(governance.hasRole(role, next), "the new holder took over");
    }

    // ───────────────────────────── MISSED-04 ─────────────────────────────

    /// @notice Blacklist `who` on the real FiatToken (v2.2 keeps the flag in bit 255 of the balance slot, mapping slot 9).
    function _blacklistUsdc(address who) internal {
        bytes32 slot = keccak256(abi.encode(who, uint256(9)));
        uint256 bal = IERC20(USDC).balanceOf(who);
        vm.store(USDC, slot, bytes32((uint256(1) << 255) | bal));
        vm.expectRevert();
        vm.prank(alice);
        IERC20(USDC).transfer(who, 0);
    }

    /// @notice A fee recipient that USDC refuses (Circle blacklist) must not stop a redemption from settling and paying
    ///         out. The fee stays with the holders instead.
    function test_MISSED04_blacklistedFeeRecipientDoesNotBlockExits() public fixtureCovered {
        _invest();
        uint256 shares = _holder(bob, 20_000e6);
        _blacklistUsdc(feeRecipient);
        uint256 got = redeem(bob, shares / 2);
        assertGt(got, 0, "the redemption settled and paid out");
    }

    // ───────────────────────────── AGY-05 ─────────────────────────────

    /// @notice An asset unwound during a live plan leaves its end weight in idle USDC. The plan must still converge
    ///         (idle's end target is the freed weight), not stall until it expires.
    function test_AGY05_planConvergesAfterAnAssetLeavesIt() public fixtureCovered {
        investFund(assetVec(1_500, 1_500, 5_000, 2_000, 0));
        coverageCheckpoint();
        setTargetViaTimelock(assetVec(2_500, 500, 5_000, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        timelockExecute(
            address(fund),
            abi.encodeWithSignature("emergencyUnwind(uint256,uint256)", IDX_WETH, uint256(0))
        );
        (,, PlanStatus status) = stepUntilDone(400);
        assertEq(uint8(status), uint8(PlanStatus.Converged), "the plan converged");
        (uint256 nav, uint256 idle,) = fund.portfolioValues();
        assertApproxEqAbs(idle * BPS / nav, 5_000, 60, "the freed 50 % waits in idle USDC");
    }

    // ───────────────────────────── MISSED-03 ─────────────────────────────

    /// @notice A redemption left partly unmatched by a shutdown must not be counted again after a restore. Bob's
    ///         queued shares (what the exclusion ledger pays recoveries on) must equal what he really has queued.
    function test_MISSED03_shutdownRestoreLeavesNoPhantomQueuedShares() public fixtureCovered {
        _invest();
        uint256 shares = _holder(bob, 600_000e6);
        coverageCheckpoint();

        // Half his shares: over the 250 000 USDC flow cap, so one settlement fills only part of it.
        uint256 oldId = openRedeemRequest(bob, shares / 2);
        warpToSettleable(oldId);
        _settleNow();
        uint256 oldLeft = queue.pendingRedeemRequest(oldId, bob);
        assertGt(oldLeft, 0, "part of the old redemption waits, enrolled");
        coverageCheckpoint();

        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.restore, (TVL_CAP)));
        refreshFeeds();

        uint256 newId = openRedeemRequest(bob, fund.balanceOf(bob) / 4);
        warpToSettleable(newId);
        _settleNow();
        coverageCheckpoint();

        // Anyone may release a wind-down escrow at any time: the old remainder moves to Bob's share credit.
        queue.releaseWindDown(bob);
        (, uint256 creditShares) = queue.creditOf(bob);
        assertGe(creditShares, oldLeft, "the old remainder is now credit");
        uint256 truth = creditShares + queue.pendingRedeemRequest(oldId, bob)
            + queue.pendingRedeemRequest(newId, bob);
        assertApproxEqAbs(queue.queuedSharesOf(bob), truth, 2, "no phantom queued shares");
    }

    /// @notice A restore raises the TVL cap from 0, so it must pass the pool-share check a higher cap passes.
    function test_MISSED03_restoreRunsThePoolShareCheck() public fixtureCovered {
        _invest();
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        refreshFeeds();
        vm.prank(address(timelock));
        vm.expectPartialRevert(IRobotMoneyFund.PoolShareExceeded.selector);
        fund.restore(1e15 * 1e6);
        vm.prank(address(timelock));
        fund.restore(TVL_CAP);
        assertFalse(fund.isShutdown(), "a cap the pools carry restores");
    }

    // ───────────────────────────── MISSED-06 ─────────────────────────────

    /// @notice A deposit the match fills down to less than `minRequestUsdc` must not sit in the pool as work the keeper
    ///         sees but can never do. The remainder returns to its owner as USDC credit (RB-14 keeps it out of
    ///         `mintInKind`).
    function test_MISSED06_subMinimumDepositRemainderSettles() public fixtureCovered {
        _invest();
        uint256 shares = _holder(bob, 20_000e6);
        uint256 minUsdc = queue.flowParams().minRequestUsdc;
        // Bob redeems about 150 USDC; Alice deposits 200: the match fills about 150 of hers, leaving about 50.
        uint256 redShares = shares * 150e6 / 20_000e6;
        uint256 dep = openDepositRequest(alice, 200e6);
        openRedeemRequest(bob, redShares);
        warpToSettleable(dep);
        alignFeedsToPools();
        settleAll();
        assertLt(200e6 - 150e6, minUsdc, "the remainder is below the minimum");
        assertTrue(queue.getRequest(dep).closed, "the sub-minimum remainder left the pool in the round");
        (uint256 credit,) = queue.creditOf(alice);
        assertGt(credit, 0, "it returned to Alice as USDC credit");
        assertLt(credit, minUsdc, "and it is the sub-minimum remainder");
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Window), "no phantom work left for the keeper");
    }

    // ───────────────────────────── AGY-09 ─────────────────────────────

    /// @notice Revoking a direct swap adapter's code hash stops new exposure through it (a rebalance step buying wETH)
    ///         while valuation and the exits keep working. A proxy hash the fund still allows cannot be un-marked.
    function test_AGY09_revokedDirectAdapterStopsNewExposureNotExits() public fixtureCovered {
        investFund(assetVec(1_500, 1_500, 5_000, 2_000, 0));
        coverageCheckpoint();
        bytes32 h = address(swapAdapter).codehash;
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.setAdapterCodeHashAllowed, (h, false)));

        // A plan that buys wETH: the step through the revoked adapter fails.
        setTargetViaTimelock(assetVec(500, 500, 7_000, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        bool sawWethLeg;
        for (uint256 k; k < 8 && !sawWethLeg; ++k) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            refreshFeeds();
            (SkipReason r, uint256 sIdx, uint256 bIdx,) = rebalancer.previewStep();
            bool wethLeg = r == SkipReason.None && (sIdx == IDX_WETH || bIdx == IDX_WETH);
            vm.prank(keeper);
            (bool traded, SkipReason why) = rebalancer.step();
            if (wethLeg) {
                sawWethLeg = true;
                assertFalse(traded, "no trade through the revoked adapter");
                assertEq(uint8(why), uint8(SkipReason.StepFailed), "the fund refused the step");
            }
        }
        assertTrue(sawWethLeg, "the plan reached a wETH leg");

        // Valuation and the single-asset exit still work through it.
        assertGt(fund.totalAssets(), 0, "NAV reads");
        timelockExecute(
            address(fund),
            abi.encodeWithSignature("emergencyUnwind(uint256,uint256)", IDX_WETH, uint256(0))
        );
        assertEq(IERC20(WETH).balanceOf(address(fund)), 0, "the exit sold wETH");
    }

    function test_AGY09_allowedProxyHashCannotBeUnmarked() public fixtureCovered {
        bytes32 h = keccak256("some proxy code");
        vm.startPrank(address(timelock));
        fund.setAdapterCodeHashAllowed(h, true);
        fund.setAdapterProxyCodeHash(h, true);
        vm.expectRevert();
        fund.setAdapterProxyCodeHash(h, false);
        fund.setAdapterCodeHashAllowed(h, false);
        fund.setAdapterProxyCodeHash(h, false);
        vm.stopPrank();
    }

    // ───────────────────────────── AGY-11 ─────────────────────────────

    /// @dev `FlowState.lastAssetPerShare` (ERC-7201 namespace robotmoney.storage.FlowQueue, member slot 59).
    bytes32 internal constant FLOW_STATE_BASE =
        0x5ca698e4220eb646640b8313725773ea79d9bb0180fc107a75b91aa030545000;
    /// @dev `FlowState.depPoolUsdc` member slot.
    uint256 internal constant DEP_POOL_SLOT = 67;

    /// @notice The first settlement after the in-place upgrade has no record of an asset's value. A delisting then must
    ///         not trip the share-price check (Check 6): the asset stays on both sides of it.
    function test_AGY11_delistBeforeFirstRecordedValueDoesNotTripCheck6() public fixtureCovered {
        investFund(assetVec(1_500, 1_500, 5_000, 2_000, 0));
        _holder(bob, 5_000e6);
        coverageCheckpoint();
        // The state a v0.8.0 queue left: no per-asset value recorded for wETH.
        bytes32 slot = keccak256(abi.encode(IDX_WETH, uint256(FLOW_STATE_BASE) + 59));
        vm.store(address(queue), slot, bytes32(0));
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.delistAsset, (IDX_WETH)));

        uint256 id = openRedeemRequest(bob, fund.balanceOf(bob) / 2);
        warpToSettleable(id);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertTrue(check != SettleCheck.SharePrice, "the delisted asset does not trip Check 6");
    }

    // ───────────────────────────── AGY-12 ─────────────────────────────

    /// @notice A fully filled deposit leaves its bucket listed with no basis until it expires. With only rounding dust
    ///         left in the pool, the keeper must see no work in the next round.
    function test_AGY12_emptyDepositBucketIsNotWork() public fixtureCovered {
        _invest();
        uint256 id = openDepositRequest(alice, 1_000e6);
        warpToSettleable(id);
        settleAll();
        assertTrue(queue.getRequest(id).closed, "the deposit filled");
        // Rounding dust in the pool (FlowState.depPoolUsdc, member slot DEP_POOL_SLOT).
        vm.store(address(queue), bytes32(uint256(FLOW_STATE_BASE) + DEP_POOL_SLOT), bytes32(uint256(1)));
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Window), "an empty bucket with dust is not work");
    }

    // ───────────────────────────── AGY-13 ─────────────────────────────

    /// @notice The swap adapter accepts only the factory's own pool: a look-alike with the same tokens and fee fails.
    function test_AGY13_adapterRefusesANonCanonicalPool() public fixtureCovered {
        assertTrue(swapAdapter.isFixedFeePool(WETH_POOL), "the real wETH / USDC pool passes");
        FakeV3Pool fake = new FakeV3Pool(WETH, USDC);
        assertFalse(swapAdapter.isFixedFeePool(address(fake)), "a look-alike pool fails");
    }

    // ───────────────────────────── AGY-10 ─────────────────────────────

    function _setMinHold(uint32 h) internal {
        FlowParams memory p = queue.flowParams();
        p.minHold = h;
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
    }

    /// @notice After `minHold` was raised once and lowered again, a later match's hold must follow the deposits it
    ///         filled: a freeze two hours later, when every share of it is unlocked, is refused.
    function test_AGY10_matchHoldFollowsItsOwnDeposits() public fixtureCovered {
        _invest();
        uint256 shares = _holder(bob, 5_000e6);
        _setMinHold(2 days);
        deposit(alice, 1_000e6);
        _setMinHold(1 hours);
        coverageCheckpoint();

        uint256 dep = openDepositRequest(carol, 500e6);
        openRedeemRequest(bob, shares / 5);
        warpToSettleable(dep);
        alignFeedsToPools();
        settleAll();
        uint256 sid;
        for (uint256 k = queue.settlementCount(); k != 0; --k) {
            if (queue.getSettlement(k).matchedShares != 0) {
                sid = k;
                break;
            }
        }
        assertGt(sid, 0, "a match was booked");
        vm.warp(block.timestamp + 2 hours);
        vm.prank(emergency);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.FreezeOutsideHold.selector, sid));
        queue.freezeSettlement(sid);
    }

    // ───────────────────────────── AGY-07 ─────────────────────────────

    /// @notice wETH that reaches the fund after its asset was removed is not stranded: the foreign sweep still refuses
    ///         it, and `reabsorbRemovedAsset` sells it into idle USDC. Re-listing wETH then reuses its old slot.
    function test_AGY07_removedAssetTokensAreReabsorbedAndTheSlotReused() public fixtureCovered {
        _invest();
        AssetConfig memory wethCfg = fund.assetConfig(IDX_WETH);
        uint256 count = fund.assetCount();
        timelockExecute(
            address(fund),
            abi.encodeWithSignature("emergencyUnwind(uint256,uint256)", IDX_WETH, uint256(0))
        );
        assertFalse(fund.assetConfig(IDX_WETH).active, "wETH removed");

        // 0.5 wETH arrives later.
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        IWeth9(WETH).deposit{value: 0.5 ether}();
        IERC20(WETH).transfer(address(fund), 0.5 ether);
        vm.stopPrank();
        vm.expectRevert();
        fund.sweepForeignToken(WETH);

        refreshFeeds();
        uint256 idle0 = fund.idleUsdc();
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.reabsorbRemovedAsset, (IDX_WETH, 0)));
        assertEq(IERC20(WETH).balanceOf(address(fund)), 0, "the stray wETH was sold");
        assertGt(fund.idleUsdc(), idle0, "into idle USDC, so NAV holds it");

        // Re-listing wETH takes its old slot back.
        refreshFeeds();
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.addAsset, (wethCfg)));
        assertEq(fund.assetCount(), count, "no new slot spent");
        assertTrue(fund.assetConfig(IDX_WETH).active, "wETH is back at its index");

        // With the slot active again, nothing reabsorbs it.
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.AssetNotRemoved.selector, IDX_WETH));
        fund.reabsorbRemovedAsset(IDX_WETH, 0);
    }

    // ───────────────────────────── MISSED-08 ─────────────────────────────

    /// @dev `FundState` base (ERC-7201 robotmoney.storage.RobotMoneyFund) and the `saleStartValue` member slot.
    bytes32 internal constant FUND_STATE_BASE =
        0x1f474ae58db9fb6ccfa907fed2f1bf5577ac55e97dddcd5c18f25868bd856c00;
    uint256 internal constant SALE_START_VALUE_SLOT = 39;

    /// @notice After shutdown no sale step runs. A redeemer with a delisting claim takes its tokens in kind.
    function test_MISSED08_delistClaimLeavesInKindAfterShutdown() public fixtureCovered {
        investFund(assetVec(1_500, 1_500, 5_000, 2_000, 0));
        uint256 shares = _holder(bob, 5_000e6);
        coverageCheckpoint();
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.delistAsset, (IDX_WETH)));
        redeem(bob, shares / 2);
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        uint256 before = IERC20(WETH).balanceOf(bob);
        fund.settleClaim(IDX_WETH, bob);
        assertGt(IERC20(WETH).balanceOf(bob), before, "bob took his slice of wETH in kind");
    }

    /// @notice A sale opened with no price (start value 0) must still sell once a price returns.
    function test_MISSED08_zeroStartValueSaleStillSells() public fixtureCovered {
        investFund(assetVec(1_500, 1_500, 5_000, 2_000, 0));
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.delistAsset, (IDX_WETH)));
        bytes32 slot = keccak256(abi.encode(IDX_WETH, uint256(FUND_STATE_BASE) + SALE_START_VALUE_SLOT));
        vm.store(address(fund), slot, bytes32(0));
        uint256 wethBefore = IERC20(WETH).balanceOf(address(fund));
        vm.warp(block.timestamp + rebalancer.effectiveStepInterval() + 2);
        refreshFeeds();
        // The feed 1 % above the pool: the step loses about 1 % against it, inside the 3 % band.
        setFeedPrice(IDX_WETH, poolPrice8(WETH_POOL, WETH) * 101 / 100);
        vm.prank(keeper);
        assertTrue(rebalancer.stepDelisted(IDX_WETH), "a sale step ran");
        assertLt(IERC20(WETH).balanceOf(address(fund)), wethBefore, "it sold wETH");
    }

    /// @notice An in-sale asset holding only dust worth nothing closes on `deactivateAsset`, as a non-sale one does.
    function test_MISSED08_dustInSaleClosesOnDeactivate() public fixtureCovered {
        investFund(assetVec(3_000, 3_000, 0, 4_000, 0));
        assertEq(IERC20(WETH).balanceOf(address(fund)), 0, "no wETH held");
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        IWeth9(WETH).deposit{value: 1}();
        IERC20(WETH).transfer(address(fund), 1);
        vm.stopPrank();
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.delistAsset, (IDX_WETH)));
        refreshFeeds();
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.deactivateAsset, (IDX_WETH)));
        assertFalse(fund.isAssetInSale(IDX_WETH), "the sale closed");
        assertFalse(fund.assetConfig(IDX_WETH).active, "the asset left");
    }

    // ───────────────────────────── MISSED-09 (liquidity clamp) ─────────────────────────────

    /// @notice A lending sell leg takes no more than the venue can pay out now.
    function test_MISSED09_lendingSellLegIsClampedToVenueLiquidity() public fixtureCovered {
        investFund(assetVec(1_500, 3_500, 3_000, 2_000, 0));
        coverageCheckpoint();
        setTargetViaTimelock(assetVec(3_500, 1_500, 3_000, 2_000, 0), PlanParams(1 days, COST_BUDGET_BPS));
        vm.mockCall(
            address(moonwellAdapter),
            abi.encodeWithSelector(ILendingRateAdapter.availableLiquidity.selector),
            abi.encode(uint256(1_000e6))
        );
        vm.warp(fund.plan().endTime);
        refreshFeeds();
        (SkipReason r, uint256 sIdx,, uint256 notional) = rebalancer.previewStep();
        assertEq(sIdx, IDX_MOONWELL, "Moonwell is the sell leg");
        assertTrue(r == SkipReason.None || r == SkipReason.BelowMinStep, "a step or a dust skip");
        assertLe(notional, 1_000e6, "no more than the venue can pay out");
    }

    // ───────────────────────────── MISSED-09 (TestMachine #16, #17) ─────────────────────────────

    /// @notice An in-kind exit pays a non-zero fee on any non-zero leg, so splitting an exit into small calls cannot
    ///         round the fee away (TestMachine #16).
    function test_TM16_smallInKindExitStillPaysTheFee() public fixtureCovered {
        _invest();
        uint256 shares = _holder(bob, 5_000e6);
        timelockExecute(address(fund), abi.encodeCall(IRobotMoneyFund.shutdown, ()));
        refreshFeeds();
        // About 100 USDC units of the whole fund: a 10 bps fee on the USDC leg floors to 0 and rounds up to 1.
        uint256 tiny = fund.totalSupply() * 100 / fund.totalAssets();
        assertLt(tiny, shares, "bob holds enough");
        uint256 fee0 = IERC20(USDC).balanceOf(feeRecipient);
        vm.prank(bob);
        fund.redeemInKind(tiny, bob, bob);
        assertGt(IERC20(USDC).balanceOf(feeRecipient), fee0, "the fee is not rounded to zero");
    }

    /// @notice Two receipts recorded in the same block both stay applicable, in either order (TestMachine #17).
    function test_TM17_sameBlockReceiptsBothApply() public fixtureCovered {
        uint16[5] memory v1 = bucketVec(6_500, 3_500);
        uint16[5] memory v2 = bucketVec(7_000, 3_000);
        (bytes32 id1, bytes32 d1) = recordReceipt(v1);
        // A second receipt in the same second.
        bytes32 id2 = receipts.computeReceiptId("same-second", "rmFUND");
        bytes32 d2 = keccak256("same-second payload");
        vm.prank(submitter);
        receipts.recordReceipt(id2, d2, "https://example.invalid/receipts/same-second");
        assertEq(receipts.getReceiptById(id2).recordedAt, receipts.getReceiptById(id1).recordedAt, "same second");

        applyReceiptViaTimelock(id1, d1, v1);
        applyReceiptViaTimelock(id2, d2, v2);
        assertTrue(receipts.isReleased(id2), "the second same-second receipt applied");
    }
}
