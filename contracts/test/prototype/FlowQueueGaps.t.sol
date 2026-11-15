// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §8.1 (E28, E36, E40, E51, E52), §8.3 (FlowQueue tests);
//            docs/technical/one-vault-rebalancer-proposal.md §22
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {Roles} from "./src/FundTypes.sol";
import {Vm} from "forge-std/Vm.sol";
import {
    FlowParams,
    IFlowEvents,
    QueueLiveness,
    Request,
    RequestStatus,
    Settlement,
    SettleCheck,
    TIMELOCK_DELAY_REFERENCE
} from "./src/FlowTypes.sol";
import {FlowQueueBase} from "./FlowQueue.t.sol";

/// @title FlowQueueGapsTest
/// @notice Step 3f audit gaps in the queue, one dedicated test each: `queuedSharesOfAt` at stored indexes (E52), the
///         stop that `expiresAt` puts on a deposit (E40), matched volume outside the TVL cap (E28), the `liveness()`
///         view (E31, E34, E38, E39), the `slices` divides `settleWindow` bound (field 10) and the two bounds built on
///         the timelock reference delay (E51, fields 7 and 19).
contract FlowQueueGapsTest is FlowQueueBase {
    function test_checkSettle_emptyPoolInLaterRoundIsNotWork() public fixtureCovered {
        _invest();
        uint256 id = openDepositRequest(alice, 1_000e6);
        warpToSettleable(id);
        settleAll();
        assertEq(queue.pendingDepositRequest(id, alice), 0, "deposit filled");
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Window), "empty later round has no work");
    }

    // ───────────────────────────── E52 ─────────────────────────────

    /// @notice `queuedSharesOfAt(owner, depIdx, redIdx)` reads an owner's queued shares at the indexes it is given, not
    ///         at the current ones. The exclusion ledger stores the indexes when a record opens and reads them later,
    ///         so this is what keeps a recovery with the owners who held the shares at that time (RB-22).
    ///         A match moves both indexes: the redeemer's escrow falls and the depositor's held shares rise.
    function test_E52_queuedSharesOfAtReadsAtTheGivenIndexes() public fixtureCovered {
        _invest();
        uint256 bobShares = _holder(bob, 50_000e6);
        coverageCheckpoint();

        (uint256[2] memory dep0, uint256[2] memory red0) = queue.currentMatchIndexes();
        openRedeemRequest(bob, bobShares / 2);
        uint256 d = openDepositRequest(alice, 20_000e6);
        warpToSettleable(d);
        uint256 bobBefore = queue.queuedSharesOf(bob);
        assertEq(bobBefore, bobShares / 2, "before the match bob has his half in escrow");
        assertEq(queue.queuedSharesOf(alice), 0, "before the match alice has no shares");
        assertEq(
            queue.queuedSharesOfAt(bob, dep0, red0),
            bobBefore,
            "before the round: the unenrolled escrow counts at any index"
        );

        uint256 sid = _settleNow();
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.matchedShares, 0, "a match was booked");
        (uint256[2] memory dep1, uint256[2] memory red1) = queue.currentMatchIndexes();
        assertGt(dep1[0], dep0[0], "the deposit side's match count moved");
        assertTrue(red1[0] != red0[0] || red1[1] != red0[1], "the redemption side's index moved");

        uint256 aliceNow = queue.queuedSharesOf(alice);
        uint256 bobNow = queue.queuedSharesOf(bob);
        assertGt(aliceNow, 0, "after the match alice holds the matched shares");
        assertLt(bobNow, bobBefore, "after the match bob's escrow fell by the matched shares");

        // At the new indexes the view equals the current one. At the old indexes it still reads the time before.
        assertEq(queue.queuedSharesOfAt(alice, dep1, red1), aliceNow, "alice at the new index");
        assertEq(queue.queuedSharesOfAt(bob, dep1, red1), bobNow, "bob at the new index");
        assertEq(
            queue.queuedSharesOfAt(alice, dep0, red0), 0, "alice at the old index: nothing yet"
        );
        // The match moved exactly the booked shares to alice. Bob's side at the old index is not asserted here: his
        // request was not yet enrolled in a round at that index.
        assertApproxEqAbs(aliceNow, st.matchedShares, 2, "alice holds the shares the match booked");
        assertLe(
            st.matchedShares,
            bobBefore - bobNow,
            "and they left bob's escrow (a match moves, it does not mint)"
        );
    }

    // ───────────────────────────── E40 ─────────────────────────────

    /// @notice A deposit request's `expiresAt` is the end of its expiry epoch, a redemption's is never. A round that
    ///         settles one second before it fills the deposit and matches it. A round at `expiresAt` leaves the deposit
    ///         unfilled and unmatched, and a live redemption of a later epoch is then sold net, not matched.
    function test_E40_expiresAtStopsADepositsParticipationAtTheSecond() public fixtureCovered {
        _invest();
        uint256 bobShares = _holder(bob, 50_000e6);
        uint256 daveShares = _holder(dave, 50_000e6);
        coverageCheckpoint();
        openRedeemRequest(bob, bobShares / 2);
        uint256 d = openDepositRequest(alice, 20_000e6);
        FlowParams memory p = queue.flowParams();
        Request memory dr = queue.getRequest(d);
        assertEq(
            uint256(dr.expiresAt),
            (uint256(dr.epoch) + p.maxRoll + 1) * p.epochLength,
            "a deposit expires at the end of epoch + maxRoll"
        );
        // Dave's redemption sits in the next epoch, so it is still live when alice's deposit expires.
        warpForward((uint256(dr.epoch) + 1) * p.epochLength + 1);
        uint256 dRed = openRedeemRequest(dave, daveShares / 2);
        assertEq(
            uint256(queue.getRequest(dRed).expiresAt),
            type(uint64).max,
            "a redemption never expires"
        );
        uint256 snap = vm.snapshotState();

        // One second before: the deposit still takes part and is matched against bob's redemption.
        vm.warp(uint256(dr.expiresAt) - 1);
        assertEq(
            uint8(queue.requestStatus(d)),
            uint8(RequestStatus.Pending),
            "still pending one second before"
        );
        uint256 sid = _settleNow();
        assertGt(sid, 0, "a round ran");
        assertGt(queue.getSettlement(sid).matchedUsdc, 0, "the live deposit was matched");
        assertEq(queue.pendingDepositRequest(d, alice), 0, "and filled");

        // At expiresAt: expired at the second. The first round that can run after it (a round is blocked for
        // `settleWindow` after an epoch closes) does not touch the deposit.
        vm.revertToState(snap);
        vm.warp(uint256(dr.expiresAt));
        assertEq(
            uint8(queue.requestStatus(d)), uint8(RequestStatus.Expired), "expired at the second"
        );
        vm.warp(uint256(dr.expiresAt) + p.settleWindow);
        sid = _settleNow();
        assertGt(sid, 0, "dave's live redemption settles");
        assertEq(queue.getSettlement(sid).matchedUsdc, 0, "nothing is matched: the deposit is out");
        assertEq(queue.getRequest(d).remaining, 20_000e6, "the deposit is untouched");
        vm.prank(alice);
        assertEq(queue.withdrawExpired(d), 20_000e6, "its owner takes the whole escrow back");
    }

    // ───────────────────────────── E28 ─────────────────────────────

    /// @notice The TVL cap counts the net deposit only. With the fund at its TVL cap a deposit is matched against a
    ///         redemption of equal value in full, because a match leaves the NAV where it was. The same deposit with no
    ///         redeemer finds no room and waits.
    function test_E28_matchedVolumeIsNotCountedAgainstTheTvlCap() public fixtureCovered {
        _invest();
        uint256 bobShares = _holder(bob, 50_000e6);
        (uint256 nav,,) = fund.portfolioValues();
        (, uint256 perDepositCap,,) = fund.config();
        // The cap sits exactly at the NAV: no room for a net deposit.
        if (perDepositCap > nav) {
            timelockExecute(address(fund), abi.encodeCall(fund.setPerDepositCap, (nav)));
        }
        timelockExecute(address(fund), abi.encodeCall(fund.setTvlCap, (nav)));
        coverageCheckpoint();
        uint256 snap = vm.snapshotState();

        // With a redeemer: the deposit matches in full though NAV + deposit is above the cap.
        {
            openRedeemRequest(bob, bobShares / 2);
            uint256 d = openDepositRequest(alice, 20_000e6);
            warpToSettleable(d);
            uint256 sid = _settleNow();
            Settlement memory st = queue.getSettlement(sid);
            assertApproxEqAbs(st.matchedUsdc, 20_000e6, 2, "the whole deposit is matched");
            assertEq(queue.pendingDepositRequest(d, alice), 0, "the deposit is filled");
            (uint256 navAfter,,) = fund.portfolioValues();
            assertLe(navAfter, nav, "the NAV did not rise: the cap holds");
            _assertBooks("E28 matched");
        }

        // Without a redeemer: nothing is matched, and there is no room for the net deposit.
        vm.revertToState(snap);
        {
            uint256 d = openDepositRequest(alice, 20_000e6);
            warpToSettleable(d);
            _settleNow();
            assertEq(
                queue.pendingDepositRequest(d, alice),
                20_000e6,
                "no room at the cap: the deposit waits"
            );
            _assertBooks("E28 net");
        }
    }

    // ───────────────────────────── liveness ─────────────────────────────

    /// @notice `liveness()` reports each disclosure the terms promise, and each field moves on its own cause.
    function test_liveness_eachFieldFollowsItsOwnCause() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        QueueLiveness memory l = queue.liveness();
        assertTrue(l.keeperConfigured, "the keeper is configured");
        assertFalse(l.queuePausedNow, "the queue runs");
        assertEq(l.queuePausedUntil, 0, "no pause end");
        assertFalse(l.depositsStoppedNow, "deposits are open");
        assertFalse(l.windDownActive, "no wind-down");
        assertEq(l.cancelBuffer, p.cancelBuffer, "cancel buffer is the parameter");
        assertEq(l.maxPause, p.maxPause, "max pause is the parameter");
        uint256 snap = vm.snapshotState();

        // The queue pause: paused now, with an end time of now + maxPause, and nothing else changes.
        vm.prank(emergency);
        queue.pauseQueue();
        l = queue.liveness();
        assertTrue(l.queuePausedNow, "paused");
        assertEq(
            uint256(l.queuePausedUntil), block.timestamp + p.maxPause, "ends maxPause from now"
        );
        assertFalse(l.depositsStoppedNow, "deposits were not stopped by it");
        assertFalse(l.windDownActive, "not a wind-down");
        vm.warp(uint256(l.queuePausedUntil));
        assertFalse(queue.liveness().queuePausedNow, "the pause ends by itself at its end time");

        // The deposit pause stops deposits and nothing else.
        vm.revertToState(snap);
        vm.prank(emergency);
        fund.pauseDeposits();
        l = queue.liveness();
        assertTrue(l.depositsStoppedNow, "deposits stopped");
        assertFalse(l.queuePausedNow, "the queue runs");
        assertFalse(l.windDownActive, "not a wind-down");

        // The wind-down.
        vm.revertToState(snap);
        timelockExecute(address(fund), abi.encodeCall(fund.shutdown, ()));
        l = queue.liveness();
        assertTrue(l.windDownActive, "wind-down active");

        // No keeper.
        vm.revertToState(snap);
        timelockExecute(
            address(queue), abi.encodeCall(queue.revokeRole, (Roles.KEEPER_ROLE, keeper))
        );
        l = queue.liveness();
        assertFalse(l.keeperConfigured, "no keeper account holds the role");
        assertFalse(l.queuePausedNow, "and the queue is not paused by it");

        // The two parameters follow a change.
        vm.revertToState(snap);
        p.cancelBuffer = 30 minutes;
        p.maxPause = 4 days;
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
        l = queue.liveness();
        assertEq(l.cancelBuffer, 30 minutes, "cancel buffer follows");
        assertEq(l.maxPause, 4 days, "max pause follows");
    }

    // ───────────────────────────── field 10 ─────────────────────────────

    /// @notice `slices` must divide `settleWindow` into whole slices of at least `MIN_SLICE_SECONDS` (field 10): the
    ///         settlement has no other TWAP window (E51).
    function test_field10_slicesMustDivideTheSettleWindow() public fixtureCovered {
        FlowParams memory p = defaultFlowParams();
        p.slices = 7; // 3600 % 7 != 0
        p.quorum = 5;
        _timelockExpectRevert(
            address(queue),
            abi.encodeCall(queue.setFlowParams, (p)),
            abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 10)
        );
        p = defaultFlowParams();
        p.settleWindow = 600; // 600 / 12 = 50 s, under MIN_SLICE_SECONDS (60), and 600 % 12 == 0
        _timelockExpectRevert(
            address(queue),
            abi.encodeCall(queue.setFlowParams, (p)),
            abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 10)
        );
        p = defaultFlowParams();
        p.slices = 10; // 3600 / 10 = 360 s, divides
        p.quorum = 8;
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
        assertEq(queue.flowParams().slices, 10, "a dividing slice count is accepted");
    }

    // ───────────────────────────── match band (plan 8.5) ─────────────────────────────

    /// @notice `matchBandBps` is at least 1 and at most `refBandBps` (field 20): a match band wider than the net
    ///         trade's band would defeat its purpose.
    function test_matchBand_boundsAreExact() public fixtureCovered {
        FlowParams memory p = defaultFlowParams();
        p.matchBandBps = 0;
        _timelockExpectRevert(
            address(queue),
            abi.encodeCall(queue.setFlowParams, (p)),
            abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 20)
        );
        p.matchBandBps = p.refBandBps + 1;
        _timelockExpectRevert(
            address(queue),
            abi.encodeCall(queue.setFlowParams, (p)),
            abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 20)
        );
        p.matchBandBps = p.refBandBps;
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
        assertEq(queue.flowParams().matchBandBps, p.refBandBps, "the edge is accepted");
    }

    /// @notice A deposit and a redemption in one round match at the TWAP only while TWAP NAV is within `matchBandBps`
    ///         of feed NAV. With the feed 60 bps above the pools the round still settles (inside `refBandBps`), the
    ///         match is skipped with `MatchSkipped`, and the round nets at the feed price. With the feeds at the pools
    ///         the same round books the match.
    function test_matchBand_skipsTheMatchWhenTwapLagsTheFeed() public fixtureCovered {
        investFund(bucketVec(6_500, 3_500));
        uint256 bobShares = _holder(bob, 120_000e6);
        coverageCheckpoint();
        uint256 snap = vm.snapshotState();

        // The feed leads the pools by 60 bps on both basket assets.
        uint256 d1 = openDepositRequest(alice, 20_000e6);
        openRedeemRequest(bob, bobShares / 6);
        warpToSettleable(d1);
        alignFeedsToPools();
        setFeedPrice(IDX_WETH, poolPrice8(WETH_POOL, WETH) * 10_060 / 10_000);
        setFeedPrice(IDX_CBBTC, poolPrice8(CBBTC_POOL, CBBTC) * 10_060 / 10_000);
        refreshFeeds();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool skipped;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IFlowEvents.MatchSkipped.selector) {
                skipped = true;
                (uint256 dev) = abi.decode(logs[i].data, (uint256));
                assertGt(
                    dev, queue.flowParams().matchBandBps, "the skip names a deviation past the band"
                );
            }
        }
        assertTrue(skipped, "MatchSkipped is emitted");
        assertEq(queue.getSettlement(sid).matchedShares, 0, "no match books past the band");

        // Same round, feeds at the pools: the match books.
        vm.revertToState(snap);
        uint256 d2 = openDepositRequest(alice, 20_000e6);
        openRedeemRequest(bob, bobShares / 6);
        warpToSettleable(d2);
        alignFeedsToPools();
        refreshFeeds();
        sid = _keeperSettle();
        assertGt(queue.getSettlement(sid).matchedShares, 0, "the match books inside the band");
    }

    // ───────────────────────────── E51 reference ─────────────────────────────

    /// @notice The queue does not read the timelock. Its bounds on `maxRoll * epochLength` and on `maxPause` use the
    ///         reference constant, and both edges are exact: at the bound it is accepted, one unit over it is refused.
    function test_E51_theReferenceDelayBoundsHaveExactEdges() public fixtureCovered {
        assertEq(uint256(TIMELOCK_DELAY_REFERENCE), 48 hours, "the reference is 48 hours");

        // maxRoll * epochLength: 4 h epochs, 12 rounds is exactly 48 h.
        FlowParams memory p = defaultFlowParams();
        p.epochLength = 4 hours;
        p.maxRoll = 13; // 52 h
        _timelockExpectRevert(
            address(queue),
            abi.encodeCall(queue.setFlowParams, (p)),
            abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 7)
        );
        p.maxRoll = 12; // 48 h
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
        assertEq(queue.flowParams().maxRoll, 12, "48 hours is accepted");

        // maxPause >= reference + epochLength: with 4 h epochs the floor is 52 h.
        p = defaultFlowParams();
        p.epochLength = 4 hours;
        p.maxRoll = 12;
        p.maxPause = 52 hours - 1;
        _timelockExpectRevert(
            address(queue),
            abi.encodeCall(queue.setFlowParams, (p)),
            abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 19)
        );
        p.maxPause = 52 hours;
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
        assertEq(queue.flowParams().maxPause, 52 hours, "reference plus one epoch is accepted");
    }
}
