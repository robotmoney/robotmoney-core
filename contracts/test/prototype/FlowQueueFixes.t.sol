// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.2 step 4 (settle, the cursor, keeper first),
//            §5.9.3 checks 1, 5 and 6 and the per-side calls, §5.9.4 (freeze, release, return), §5.9.5 (parameters),
//            §7 RB-11, RB-12, RB-14, RB-15, RB-18, RB-20; docs/technical/one-vault-timed-flows-eng-plan.md E10, E13,
//            E17, E18, E20, E22; coordinator rulings 1 and 3 (2026-11-11); step 3 finish plan §3.1 items 1 to 9
//            (the review of the step 3d scaffold)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {IAavePool} from "../../interfaces/IAavePool.sol";
import {PrototypeHarness} from "./PrototypeHarness.sol";
import {IDLE_INDEX, PRICE_SCALE} from "./src/FundTypes.sol";
import {
    Claim,
    FlowBooks,
    FlowParams,
    IFlowEvents,
    Quote,
    Request,
    RequestKind,
    RequestStatus,
    Settlement,
    SettleCheck
} from "./src/FlowTypes.sol";
import {ILendingRateAdapter} from "./src/interfaces/IFlowAdapters.sol";
import {IAavePoolRate} from "./src/adapters/AaveV3RateAdapter.sol";

/// @title FixVenue
/// @notice A lending venue that `vm.etch` places over the harness's Aave V3 rate adapter (whose code keeps no storage),
///         after the test allowlists its code hash, so the fund's real aUSDC position on the real Aave pool stays its
///         own and Aave stays counted. It supplies and withdraws like the production adapter. Its knobs model the
///         defects of the step 3 finish plan §3.1:
///         - `burnOnDeploy` / `burnOnWithdraw`: the call burns every unit of gas it is given (the `INVALID` opcode), a
///           venue that fails by gas, not by a reason (item 4).
///         - `rateFailsAfterTrade`: `ratePerUnit` reverts once the fund supplied or withdrew in this venue, so a
///           settlement can read it before its trades and not after (item 5).
///         - `rateBumpBps`: `ratePerUnit` reads the real rate raised by this many bps (a venue rate jump, check 5).
contract FixVenue is ILendingRateAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant RAY_TO_WAD = 1e9;

    address public immutable USDC;
    IERC20 public immutable A_TOKEN;
    address public immutable POOL;
    address public immutable VAULT;

    bool public burnOnDeploy;
    bool public burnOnWithdraw;
    bool public rateFailsAfterTrade;
    bool public traded;
    uint256 public rateBumpBps;

    error OnlyVault();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address pool_, address usdc_, address aToken_, address vault_) {
        POOL = pool_;
        USDC = usdc_;
        A_TOKEN = IERC20(aToken_);
        VAULT = vault_;
    }

    /// @notice Test knobs (no access control: a test mock).
    function setBurn(bool onDeploy, bool onWithdraw) external {
        burnOnDeploy = onDeploy;
        burnOnWithdraw = onWithdraw;
    }

    function setRate(bool failsAfterTrade, uint256 bumpBps) external {
        rateFailsAfterTrade = failsAfterTrade;
        rateBumpBps = bumpBps;
    }

    function setTraded(bool t) external {
        traded = t;
    }

    function deploy(uint256 amount) external onlyVault {
        if (burnOnDeploy) _burnAllGas();
        traded = true;
        _supply(amount);
    }

    function deploy(uint256 usdcIn, uint256) external onlyVault returns (uint256) {
        if (burnOnDeploy) _burnAllGas();
        traded = true;
        _supply(usdcIn);
        return usdcIn;
    }

    function withdraw(uint256 amount) external onlyVault returns (uint256 paid) {
        if (burnOnWithdraw) _burnAllGas();
        traded = true;
        paid = IAavePool(POOL).withdraw(USDC, amount, address(this));
        IERC20(USDC).safeTransfer(VAULT, paid);
    }

    function withdraw(uint256 usdcWanted, uint256) external onlyVault returns (uint256) {
        if (burnOnWithdraw) _burnAllGas();
        traded = true;
        return IAavePool(POOL).withdraw(USDC, usdcWanted, VAULT);
    }

    function totalAssets() external view returns (uint256) {
        return A_TOKEN.balanceOf(address(this));
    }

    function ratePerUnit() external view returns (uint256) {
        if (rateFailsAfterTrade && traded) revert("FixVenue: rate unavailable after a trade");
        uint256 rate = IAavePoolRate(POOL).getReserveNormalizedIncome(USDC) / RAY_TO_WAD;
        return rate + rate * rateBumpBps / 10_000;
    }

    function venueWithdrawable() external pure returns (bool) {
        return true;
    }

    function isExact() external pure returns (bool) {
        return true;
    }

    function sweepForeignToken(address) external pure {
        revert OnlyVault();
    }

    function harvestRewards() external {}

    function _supply(uint256 amount) private {
        IERC20(USDC).forceApprove(POOL, amount);
        IAavePool(POOL).supply(USDC, amount, address(this), 0);
        IERC20(USDC).forceApprove(POOL, 0);
    }

    function _burnAllGas() private pure {
        assembly {
            invalid()
        }
    }
}

/// @notice Shared helpers of the fix tests. Everything runs on the harness deployment (real Base pools and venues
///         from the replay fixture, mock aggregators at the real feed addresses, the FlowQueue with the §5.9.5
///         defaults, the fund seeded with `SEED_USDC`).
///
///         These tests were written against the queue of the step 3d scaffold first, where each one fails (the
///         run's notes keep that log), and then against the fixed queue, where each one passes. Functions the fix
///         adds (`sweep`, `settleCursor`) are reached with low-level calls, so this file compiles against both.
abstract contract FlowQueueFixesBase is PrototypeHarness {
    using Math for uint256;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal erin = makeAddr("erin");
    address internal stranger = makeAddr("stranger");

    // Two-sided setup (`_twoSided`): bob's pending redemption of half his shares and alice's pending deposit, in one
    // epoch, at the end of its window.
    uint256 internal _depId;
    uint256 internal _redId;
    uint256 internal _bobShares;

    // ─── Settling ────────────────────────────────────────────────────────────────────────────────────────

    function _keeperSettle() internal returns (uint256) {
        vm.prank(keeper);
        return queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
    }

    function _trySettle(address caller, uint256 maxRequests, uint256 maxUsdc)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(caller);
        (ok, ret) = address(queue).call(abi.encodeCall(queue.settle, (maxRequests, maxUsdc)));
    }

    function _expectBlocked(address caller, SettleCheck check, uint256 index)
        internal
        returns (uint256 detail)
    {
        (bool ok, bytes memory ret) = _trySettle(caller, SETTLE_MAX_REQUESTS, type(uint256).max);
        assertFalse(ok, "settle must revert");
        SettleCheck got;
        uint256 i;
        (got, i, detail) = _decodeBlocked(ret);
        assertEq(uint8(got), uint8(check), "the failing check");
        assertEq(i, index, "the failing asset index");
    }

    function _decodeBlocked(bytes memory ret)
        internal
        pure
        returns (SettleCheck check, uint256 index, uint256 detail)
    {
        require(
            ret.length == 100 && _selector(ret) == IFlowEvents.SettleBlocked.selector,
            "not SettleBlocked"
        );
        (check, index, detail) = abi.decode(_args(ret), (SettleCheck, uint256, uint256));
    }

    function _selector(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return bytes4(0);
        assembly {
            sel := and(mload(add(data, 32)), shl(224, 0xffffffff))
        }
    }

    function _args(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 k; k < out.length; ++k) {
            out[k] = data[k + 4];
        }
    }

    /// @notice How many `SideFailed` logs of side `kind` the queue emitted in `logs`.
    function _sideFailures(Vm.Log[] memory logs, RequestKind kind)
        internal
        view
        returns (uint256 n)
    {
        for (uint256 k; k < logs.length; ++k) {
            if (
                logs[k].emitter != address(queue)
                    || logs[k].topics[0] != IFlowEvents.SideFailed.selector
            ) continue;
            (RequestKind got,) = abi.decode(logs[k].data, (RequestKind, bytes));
            if (got == kind) ++n;
        }
    }

    // ─── Users and the fund ────────────────────────────────────────────────────────────────────────────

    /// @notice `user` deposits `usdc` through the whole timed path and takes its credit: a plain holder.
    function _holder(address user, uint256 usdc) internal returns (uint256 shares) {
        shares = deposit(user, usdc);
        (uint256 credit,) = queue.creditOf(user);
        if (credit != 0) {
            vm.prank(user);
            queue.withdrawCredit();
        }
    }

    /// @notice The default invested fund (stable 65 %, protocol 35 %), then the outside market catches up with the
    ///         fund's own trades, so feed and pool agree (check 4).
    function _invest() internal {
        investFund(bucketVec(6_500, 3_500));
        alignFeedsToPools();
        refreshFeeds();
    }

    /// @notice An invested fund, bob a holder, then in one epoch bob's redemption of half his shares (any price)
    ///         and alice's deposit (any price); warp to the end of that epoch's window.
    function _twoSided() internal {
        _invest();
        _bobShares = _holder(bob, 50_000e6);
        coverageCheckpoint();
        _redId = openRedeemRequest(bob, _bobShares / 2, 0);
        _depId = openDepositRequest(alice, 20_000e6, type(uint256).max);
        warpToSettleable(_depId);
        refreshFeeds();
    }

    /// @notice The queue's books: with no gift, its balances equal the sums (eng plan §4.3).
    function _assertBooks(string memory label) internal view {
        FlowBooks memory b = queue.books();
        assertEq(
            IERC20(USDC).balanceOf(address(queue)),
            b.pendingUsdc + b.owedUsdc + b.creditUsdc + b.dustUsdc,
            string.concat(label, ": queue USDC = books")
        );
        assertEq(
            fund.balanceOf(address(queue)),
            b.escrowShares + b.heldShares + b.creditShares + b.dustShares,
            string.concat(label, ": queue shares = books")
        );
    }

    /// @notice Set the queue's parameters through the timelock (warps its delay).
    function _setParams(FlowParams memory p) internal {
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
    }

    /// @notice Place a `FixVenue` over the harness's Aave adapter, after allowlisting its code hash, so Aave stays
    ///         counted. Warps the timelock delay; refreshes the feeds.
    function _etchVenue() internal returns (FixVenue v) {
        FixVenue impl = new FixVenue(AAVE_POOL, USDC, AAVE_A_USDC, address(fund));
        timelockExecute(
            address(fund),
            abi.encodeCall(fund.setAdapterCodeHashAllowed, (address(impl).codehash, true))
        );
        vm.etch(address(aaveAdapter), address(impl).code);
        v = FixVenue(address(aaveAdapter));
        assertEq(fund.openExclusionOf(IDX_AAVE), 0, "the mock venue is still counted");
        refreshFeeds();
    }

    /// @notice The walk cursor of `settle` for the keeper's calls or everyone else's, on one side
    ///         (`FlowQueue.settleCursor`, added by the fix). `ok` false where the queue has no such view.
    function _cursor(bool keeperClass, RequestKind kind)
        internal
        view
        returns (bool ok, uint64 epoch, uint256 index)
    {
        bytes memory ret;
        (ok, ret) = address(queue)
            .staticcall(
                abi.encodeWithSignature("settleCursor(bool,uint8)", keeperClass, uint8(kind))
            );
        if (ok && ret.length == 64) (epoch, index) = abi.decode(ret, (uint64, uint256));
        else ok = false;
    }

    /// @notice Low-level `sweep()` (added by the fix) by `caller`.
    function _sweep(address caller) internal returns (bool ok, uint256 usdc, uint256 shares) {
        vm.prank(caller);
        (bool success, bytes memory ret) = address(queue).call(abi.encodeWithSignature("sweep()"));
        ok = success && ret.length == 64;
        if (ok) (usdc, shares) = abi.decode(ret, (uint256, uint256));
    }

    /// @notice Whether `hay` contains `needle`.
    function _contains(bytes memory hay, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || hay.length < needle.length) return false;
        for (uint256 i; i + needle.length <= hay.length; ++i) {
            bool hit = true;
            for (uint256 j; j < needle.length; ++j) {
                if (hay[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}

/// @title FlowQueueFixesTest
/// @notice One section per item of the step 3 finish plan §3.1. Each test fails on the scaffold's queue and passes on
///         the fixed one, except the tests named "control", which pin behaviour the fix must keep.
contract FlowQueueFixesTest is FlowQueueFixesBase {
    using Math for uint256;

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 1: keeper first, per epoch (E10, RB-20)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice A never-fillable 100 USDC request opens an epoch; a fillable one opens the next. At the second's
    ///         window end the first is past its keeper grace and the second is not. A stranger's call may walk the
    ///         first epoch only: it fills nothing. The keeper fills the second at once, and a stranger may fill a
    ///         request of that epoch once its own grace has passed.
    function test_fix1_aNonKeeperSettlesOnlyEpochsPastTheirOwnGrace() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        uint256 stuck = openDepositRequest(carol, 100e6, 1);
        vm.warp(block.timestamp + p.epochLength);
        uint256 honest = openDepositRequest(alice, 5_000e6, type(uint256).max);
        uint64 e1 = queue.getRequest(stuck).epoch;
        uint64 e2 = queue.getRequest(honest).epoch;
        assertEq(e2, e1 + 1, "consecutive epochs");
        warpForward(queue.settleableAt(e2));
        refreshFeeds();
        assertGe(
            block.timestamp,
            uint256(queue.settleableAt(e1)) + p.keeperGrace,
            "the first epoch is past its grace"
        );
        assertLt(
            block.timestamp, uint256(queue.settleableAt(e2)) + p.keeperGrace, "the second is not"
        );

        uint256 snap = vm.snapshotState();
        (bool ok,) = _trySettle(stranger, SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(ok, "the stranger may settle the first epoch");
        assertEq(
            queue.getRequest(honest).remaining,
            5_000e6,
            "fix 1: a stranger cannot settle an epoch inside its grace"
        );
        assertEq(queue.settlementCount(), 0, "nothing settled");
        assertEq(
            queue.getRequest(stuck).remaining,
            100e6,
            "the stuck request is skipped by its own limit"
        );
        _keeperSettle();
        assertTrue(queue.getRequest(honest).closed, "the keeper settles it at once");

        vm.revertToState(snap);
        warpForward(uint256(queue.settleableAt(e2)) + p.keeperGrace);
        refreshFeeds();
        vm.prank(stranger);
        queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(queue.getRequest(honest).closed, "past its own grace, anyone settles it");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 2: the cursor (D-AT-3, RB-20, RB-14; ruling 3)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice D-AT-3: a call with no room (`maxUsdc` 0) fills nothing and must move no cursor, so the next call,
    ///         whoever makes it, starts at the oldest request.
    function test_fix2_aCallWithNoRoomPassesNothing() public fixtureCovered {
        uint256 oldest = openDepositRequest(alice, 5_000e6, type(uint256).max);
        uint256 newer = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpForward(
            uint256(queue.settleableAt(queue.getRequest(oldest).epoch))
                + queue.flowParams().keeperGrace
        );
        refreshFeeds();
        (, uint64 e0, uint256 i0) = _cursor(false, RequestKind.Deposit);
        vm.prank(stranger);
        assertEq(queue.settle(1, 0), 0, "a call with no room fills nothing");
        (bool viewOk, uint64 e1, uint256 i1) = _cursor(false, RequestKind.Deposit);
        if (viewOk) {
            assertEq(e1, e0, "the cursor epoch did not move");
            assertEq(i1, i0, "the cursor index did not move");
        }
        vm.prank(stranger);
        queue.settle(1, type(uint256).max);
        assertTrue(queue.getRequest(oldest).closed, "fix 2: the next call fills the oldest request");
        assertFalse(queue.getRequest(newer).closed, "and only that one");

        // The keeper's call is not moved either.
        vm.prank(stranger);
        assertEq(queue.settle(1, 0), 0, "no room again");
        _keeperSettle();
        assertTrue(queue.getRequest(newer).closed, "the keeper fills the rest");
    }

    /// @notice A period's spent cap is no room either: the call that spent it must not pass the requests behind,
    ///         so the next period's first call starts at the oldest one still waiting.
    function test_fix2_spentCapsPassNothing_theNextPeriodStartsAtTheOldestWaiting()
        public
        fixtureCovered
    {
        FlowParams memory p = queue.flowParams();
        uint256 big = openDepositRequest(alice, p.epochFlowFloorUsdc, type(uint256).max);
        uint256 older = openDepositRequest(bob, 1_000e6, type(uint256).max);
        uint256 newer = openDepositRequest(carol, 1_000e6, type(uint256).max);
        warpToSettleable(big);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(2, type(uint256).max);
        assertTrue(queue.getRequest(big).closed, "the big request takes the whole period's cap");
        assertEq(queue.getRequest(older).remaining, 1_000e6, "no room left this period");

        vm.warp(block.timestamp + p.epochLength);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(1, type(uint256).max);
        assertTrue(
            queue.getRequest(older).closed, "fix 2: the request the cap left waiting fills first"
        );
        assertEq(queue.getRequest(newer).remaining, 1_000e6, "before the newer one");
    }

    /// @notice A stranger's call passes a request its own limit refuses (correct at that bound). The bound then
    ///         falls (the basket feeds move 30 bps down, inside `refBandBps`), so the request is admissible. The
    ///         keeper's pass starts at the oldest epoch and is moved only by the keeper's calls, so it fills that
    ///         request; the scaffold's shared cursor made the keeper continue past it.
    function test_fix2_aStrangerCannotMoveTheKeepersPass() public fixtureCovered {
        _invest();
        vm.warp(block.timestamp + 2 hours); // the TWAP window now lies after the plan's trades
        refreshFeeds();
        Quote memory q = queue.quoteDeposit(5_000e6);
        uint256 tight = openDepositRequest(alice, 5_000e6, q.boundPrice - 1);
        uint256 newer = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpForward(
            uint256(queue.settleableAt(queue.getRequest(tight).epoch))
                + queue.flowParams().keeperGrace
        );
        refreshFeeds();
        assertGt(
            queue.quoteDeposit(5_000e6).boundPrice, queue.getRequest(tight).limit, "refused now"
        );

        vm.prank(stranger);
        assertEq(
            queue.settle(1, type(uint256).max),
            0,
            "the stranger looks at the tight request only and skips it"
        );
        assertEq(queue.getRequest(tight).remaining, 5_000e6, "skipped by its own limit");

        uint256 eth8 = poolPrice8(WETH_POOL, WETH);
        uint256 btc8 = poolPrice8(CBBTC_POOL, CBBTC);
        setFeedPrice(IDX_WETH, eth8 - eth8 * 30 / 10_000);
        setFeedPrice(IDX_CBBTC, btc8 - btc8 * 30 / 10_000);
        assertLe(
            queue.quoteDeposit(5_000e6).boundPrice, queue.getRequest(tight).limit, "admissible now"
        );

        _keeperSettle();
        assertTrue(
            queue.getRequest(tight).closed, "fix 2: the keeper's pass starts at the oldest request"
        );
        assertTrue(queue.getRequest(newer).closed, "and fills the newer one too");
    }

    /// @notice A flood of deposit requests that cannot fill (deposits paused) must not hold back a redemption behind
    ///         it: each side walks its own requests. On the scaffold the flood took the first call's whole budget.
    function test_fix2_aFloodOfOneSideDoesNotHoldBackTheOther() public fixtureCovered {
        uint256 bobShares = _holder(bob, 20_000e6);
        address flooder = makeAddr("flooder");
        uint256 n = 260;
        fundUsdc(flooder, n * 100e6);
        vm.startPrank(flooder);
        IERC20(USDC).approve(address(queue), n * 100e6);
        for (uint256 k; k < n; ++k) {
            queue.requestDeposit(100e6, type(uint256).max, flooder);
        }
        vm.stopPrank();
        uint256 red = openRedeemRequest(bob, bobShares / 2, 0);
        coverageCheckpoint();
        vm.prank(emergency);
        fund.pauseDeposits();
        warpToSettleable(red);
        refreshFeeds();
        _keeperSettle();
        assertTrue(queue.getRequest(red).closed, "fix 2: the redemption fills in the first call");
        assertEq(
            queue.getRequest(1 + queue.requestCount() - n - 1).remaining, 100e6, "the flood waits"
        );
        _assertBooks("flood of one side");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 3: a change of epochLength never stalls settlement or orphans a request (E18, §5.9.5)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _withEpochLength(uint32 len) internal view returns (FlowParams memory p) {
        p = queue.flowParams();
        p.epochLength = len;
    }

    /// @notice Longer epochs, with a request pending: it settles at the end of its own window (its epoch keeps the
    ///         length it was opened with), and a request made after the change settles on the new schedule.
    function test_fix3_longerEpochsWithAPendingRequest() public fixtureCovered {
        uint256 r1 = openDepositRequest(alice, 5_000e6, type(uint256).max);
        Request memory q1 = queue.getRequest(r1);
        FlowParams memory p0 = queue.flowParams();
        uint256 window1 = (uint256(q1.epoch) + 1) * p0.epochLength + p0.settleWindow;
        _setParams(_withEpochLength(12 hours));
        assertEq(
            uint256(queue.settleableAt(q1.epoch)), window1, "fix 3: the open epoch keeps its end"
        );
        warpForward(window1);
        refreshFeeds();
        _keeperSettle();
        assertTrue(
            queue.getRequest(r1).closed, "fix 3: the pending request settles after the change"
        );

        uint256 r2 = openDepositRequest(bob, 5_000e6, type(uint256).max);
        Request memory q2 = queue.getRequest(r2);
        assertGt(q2.epoch, q1.epoch, "epoch indices only grow");
        uint256 window2 = queue.settleableAt(q2.epoch);
        assertLe(window2, block.timestamp + 12 hours + p0.settleWindow, "the new length applies");
        warpForward(window2);
        refreshFeeds();
        _keeperSettle();
        assertTrue(queue.getRequest(r2).closed, "a new request settles on the new schedule");
        _assertBooks("longer epochs");
    }

    /// @notice Longer epochs after a settlement, nothing pending: the scaffold's stored oldest epoch then lay above
    ///         every new epoch index and every settle reverted `Window`.
    function test_fix3_longerEpochsAfterASettlement() public fixtureCovered {
        uint256 r0 = openDepositRequest(alice, 5_000e6, type(uint256).max);
        uint256 marker = openDepositRequest(carol, 100e6, 1); // stays open, so the walk records its epoch
        warpToSettleable(r0);
        refreshFeeds();
        _keeperSettle();
        assertTrue(queue.getRequest(r0).closed, "settled before the change");
        vm.prank(carol);
        queue.cancel(marker);

        _setParams(_withEpochLength(12 hours));
        uint256 r2 = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpToSettleable(r2);
        refreshFeeds();
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        if (!ok) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok, "fix 3: settlement does not stall after a longer epoch");
        assertTrue(queue.getRequest(r2).closed, "the new request settles");
    }

    /// @notice Shorter epochs, with a request pending: on the scaffold its epoch index fell below the walkable range
    ///         at once (it looked expired, and no settle could reach it). Now it settles at its own window's end.
    function test_fix3_shorterEpochsWithAPendingRequest() public fixtureCovered {
        uint256 r1 = openDepositRequest(alice, 5_000e6, type(uint256).max);
        Request memory q1 = queue.getRequest(r1);
        FlowParams memory p0 = queue.flowParams();
        uint256 window1 = (uint256(q1.epoch) + 1) * p0.epochLength + p0.settleWindow;
        _setParams(_withEpochLength(3 hours));
        assertEq(
            uint8(queue.requestStatus(r1)),
            uint8(RequestStatus.Pending),
            "fix 3: still pending, not expired"
        );
        assertEq(
            uint256(queue.settleableAt(q1.epoch)), window1, "fix 3: the open epoch keeps its end"
        );
        warpForward(window1);
        refreshFeeds();
        (bool ok,) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(ok, "a settle runs");
        assertTrue(
            queue.getRequest(r1).closed, "fix 3: the pending request settles after the change"
        );
    }

    /// @notice Control: shorter epochs with nothing pending: requests made once the new length applies (from the end
    ///         of the epoch in progress at the change) settle on the new schedule. (This worked on the scaffold too,
    ///         where the new length applied at once.)
    function test_fix3_shorterEpochsNothingPending_control() public fixtureCovered {
        uint256 r0 = openDepositRequest(alice, 5_000e6, type(uint256).max);
        warpToSettleable(r0);
        refreshFeeds();
        _keeperSettle();
        _setParams(_withEpochLength(3 hours));
        // The epoch in progress keeps its end; the new length starts there.
        warpForward(
            uint256(queue.settleableAt(queue.currentEpoch())) - queue.flowParams().settleWindow
        );
        uint256 r2 = openDepositRequest(bob, 5_000e6, type(uint256).max);
        uint256 window2 = queue.settleableAt(queue.getRequest(r2).epoch);
        assertLe(
            window2,
            block.timestamp + 3 hours + queue.flowParams().settleWindow,
            "the new length applies"
        );
        warpForward(window2);
        refreshFeeds();
        _keeperSettle();
        assertTrue(queue.getRequest(r2).closed, "settles on the new schedule");
    }

    /// @notice A larger `maxRoll` makes an expired request live again. The scaffold's stored oldest epoch lay above
    ///         it, so it read Pending and no settle could reach it (an orphan). Now any parameter change resets the
    ///         walk, and it fills.
    function test_fix3_aLargerMaxRollDoesNotOrphanARevivedRequest() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        uint256 old = openDepositRequest(alice, 5_000e6, type(uint256).max);
        // Nobody settles for maxRoll + 1 epochs: the request expires.
        vm.warp(block.timestamp + (uint256(p.maxRoll) + 1) * p.epochLength);
        assertEq(uint8(queue.requestStatus(old)), uint8(RequestStatus.Expired), "expired");
        uint256 marker = openDepositRequest(carol, 100e6, 1); // never fills; keeps its epoch open
        uint256 fresh = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpToSettleable(fresh);
        refreshFeeds();
        _keeperSettle();
        assertTrue(queue.getRequest(fresh).closed, "a fresh request settles");
        assertEq(queue.getRequest(marker).remaining, 100e6, "the marker waits");

        p.maxRoll = 16;
        _setParams(p);
        assertEq(
            uint8(queue.requestStatus(old)),
            uint8(RequestStatus.Pending),
            "live again under maxRoll 16"
        );
        refreshFeeds();
        (bool ok,) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(ok, "a settle runs");
        assertTrue(queue.getRequest(old).closed, "fix 3: the revived request is walked and fills");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 4: a venue that burns all its gas fails its own side alone (ruling 1, RB-15, RB-20)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice The deposit side's venue burns every unit of gas it gets. The redemption side still settles and the
    ///         deposit side fails alone (on the scaffold the burn tripped the out-of-gas guard and reverted both).
    function test_fix4_aVenueThatBurnsItsGasOnSupplyFailsTheDepositSideAlone()
        public
        fixtureCovered
    {
        _twoSided();
        FixVenue v = _etchVenue();
        v.setBurn(true, false);
        vm.recordLogs();
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok, "fix 4: the settle succeeds");
        Settlement memory st = queue.getSettlement(queue.settlementCount());
        assertEq(st.sharesBurned, _bobShares / 2, "the redemption side settled");
        assertEq(st.sharesMinted, 0, "the deposit side did not");
        assertEq(_sideFailures(logs, RequestKind.Deposit), 1, "the deposit side failed");
        assertEq(queue.getRequest(_depId).remaining, 20_000e6, "the deposit waits");
        _assertBooks("burning supply");
    }

    /// @notice The redemption side's venue burns every unit of gas it gets: deposits still settle.
    function test_fix4_aVenueThatBurnsItsGasOnWithdrawFailsTheRedemptionSideAlone()
        public
        fixtureCovered
    {
        _twoSided();
        FixVenue v = _etchVenue();
        v.setBurn(false, true);
        vm.recordLogs();
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok, "fix 4: the settle succeeds");
        Settlement memory st = queue.getSettlement(queue.settlementCount());
        assertEq(st.sharesBurned, 0, "the redemption side did not settle");
        assertGt(st.sharesMinted, 0, "the deposit side did");
        assertEq(_sideFailures(logs, RequestKind.Redeem), 1, "the redemption side failed");
        assertEq(queue.getRequest(_redId).remaining, _bobShares / 2, "the redemption waits");
        _assertBooks("burning withdraw");
    }

    /// @notice The out-of-gas protection stays (RB-20): over gas limits from 600 % down to 35 % of a full
    ///         settlement's use, an honest call settles both sides or reverts whole; with the deposit venue burning
    ///         its gas, a call settles the redemption side (the deposit side failing alone) or reverts whole. No gas
    ///         limit makes the redemption side fail or settles one side of the honest pair.
    function test_fix4_theGasACallerSendsStillCannotChooseASide() public fixtureCovered {
        _twoSided();
        bytes memory data = abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max));
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 g0 = gasleft();
        (bool ok,) = address(queue).call(data);
        uint256 used = g0 - gasleft();
        assertTrue(ok, "a full call settles");
        vm.revertToState(snap);
        emit log_named_uint("gas used by a full two-sided settle", used);
        coverageCheckpoint();

        uint256[4] memory n = _gasSweep(data, used, false); // both, one side, revert(guard), revert(other)
        emit log_named_uint("honest: limits that settled both sides", n[0]);
        emit log_named_uint("honest: limits that settled one side", n[1]);
        emit log_named_uint("honest: limits stopped by SettleSideOutOfGas", n[2]);
        emit log_named_uint("honest: limits that ran out elsewhere", n[3]);
        assertEq(n[1], 0, "no gas limit settles one side of an honest pair");
        assertGt(n[0], 0, "enough gas settles both");

        FixVenue v = _etchVenue();
        v.setBurn(true, false);
        coverageCheckpoint();
        uint256[4] memory m = _gasSweep(data, used, true); // redemption only, other success, guard, other revert
        emit log_named_uint("burning: limits that settled the redemption side", m[0]);
        emit log_named_uint("burning: limits that settled otherwise", m[1]);
        emit log_named_uint("burning: limits stopped by SettleSideOutOfGas", m[2]);
        emit log_named_uint("burning: limits that ran out elsewhere", m[3]);
        assertEq(m[1], 0, "with a burning deposit venue a success is always the redemption side");
        assertGt(m[0], 0, "fix 4: enough gas settles the redemption side");
    }

    /// @notice Control and measurement for the fixed side budgets: 24 deposits and 24 redemptions, each from its own
    ///         fresh owner (cold storage everywhere), settle in one keeper call on the five-asset fund, both sides
    ///         inside their budgets. Run with -vvvv to read each side's gas in the trace (fix-queue notes). 24, so
    ///         the call's gas limit stays under the 40M per call of the fixture recorder's fork.
    function test_fix4_aBatchOf24FillsPerSideFitsItsBudget_control() public fixtureCovered {
        _invest();
        uint256 n = 24;
        address[] memory who = new address[](n);
        uint256 last;
        for (uint256 k; k < n; ++k) {
            who[k] = makeAddr(string.concat("redeemer", vm.toString(k)));
            last = openDepositRequest(who[k], 1_000e6, type(uint256).max);
        }
        settleUntilFilled(last);
        Settlement memory first = queue.getSettlement(queue.settlementCount());
        assertGt(first.sharesMinted, 0, "the 24-fill deposit batch settled");
        vm.warp(block.timestamp + queue.flowParams().minHold);
        refreshFeeds();
        uint256 lastRed;
        for (uint256 k; k < n; ++k) {
            uint256 sh = queue.maxMint(who[k]);
            queue.mint(sh, who[k]);
            lastRed = openRedeemRequest(who[k], fund.balanceOf(who[k]), 0);
            openDepositRequest(
                makeAddr(string.concat("depositor", vm.toString(k))), 1_000e6, type(uint256).max
            );
        }
        coverageCheckpoint();
        warpToSettleable(lastRed);
        refreshFeeds();
        uint256 claims0 = queue.claimCount();
        vm.recordLogs();
        uint256 g0 = gasleft();
        _keeperSettle();
        uint256 used = g0 - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(
            _sideFailures(logs, RequestKind.Redeem) + _sideFailures(logs, RequestKind.Deposit),
            0,
            "no side failed"
        );
        assertEq(queue.claimCount() - claims0, 2 * n, "48 fills in one call");
        emit log_named_uint("gas of one keeper settle with 24 fills per side", used);
    }

    function _gasSweep(bytes memory data, uint256 used, bool burning)
        internal
        returns (uint256[4] memory n)
    {
        uint256 settled0 = queue.settlementCount();
        for (uint256 k; k < 40; ++k) {
            uint256 g = used * (6_000 - 145 * k) / 1_000; // 600 % down to 35 %
            uint256 s = vm.snapshotState();
            vm.prank(keeper);
            (bool success, bytes memory ret) = address(queue).call{gas: g}(data);
            if (success) {
                Settlement memory st = queue.getSettlement(queue.settlementCount());
                bool both = st.sharesMinted != 0 && st.sharesBurned != 0;
                bool redOnly = st.sharesMinted == 0 && st.sharesBurned == _bobShares / 2;
                if (!burning && both) ++n[0];
                else if (burning && redOnly) ++n[0];
                else ++n[1];
            } else {
                assertEq(queue.settlementCount(), settled0, "a failed call records nothing");
                if (_selector(ret) == IFlowEvents.SettleSideOutOfGas.selector) ++n[2];
                else ++n[3];
            }
            vm.revertToState(s);
            coverageCheckpoint();
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 5: a lending-rate read that fails is never skipped (check 5 fails closed)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice The first settlement reads Aave's rate before its trades (check 5) and not after (the venue's read
    ///         fails once it traded). The scaffold then skipped the record, left no reference, and a later 5 % jump
    ///         of the rate passed check 5. Now the reference is the rate check 5 read, and the jump is caught.
    function test_fix5_aRateReadThatFailsAfterTheTradeStillLeavesAReference()
        public
        fixtureCovered
    {
        _invest();
        FixVenue v = _etchVenue();
        v.setRate(true, 0);
        uint256 a = openDepositRequest(alice, 5_000e6, type(uint256).max);
        warpToSettleable(a);
        refreshFeeds();
        uint256 sid = _keeperSettle();
        assertGt(sid, 0, "the first settlement");
        assertTrue(queue.getRequest(a).closed, "it filled");
        assertTrue(v.traded(), "the deposit supplied to the venue");

        v.setRate(false, 500);
        v.setTraded(false);
        uint256 b = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpToSettleable(b);
        refreshFeeds();
        uint256 growth = _expectBlocked(keeper, SettleCheck.LendRate, IDX_AAVE);
        assertGe(growth, 499, "fix 5: the 5 % jump is measured against the recorded rate");
    }

    /// @notice Control: a second settle in the same block, after the first supplied to every lending venue, passes
    ///         check 5. With no time elapsed check 5 allows no growth, and the fund's own supply can move a venue's
    ///         rate by a rounding unit, so the reference must be the rate read after the trades (a first version of
    ///         this fix recorded the rate read before them, and `Attacks.t.sol` A19 then stopped at `LendRate` on
    ///         Compound).
    function test_fix5_aSecondSettleInTheSameBlockPassesCheck5_control() public fixtureCovered {
        _invest();
        uint256 a = openDepositRequest(alice, 20_000e6, type(uint256).max);
        uint256 stuck = openDepositRequest(carol, 100e6, 1); // keeps the epoch in range for the second call
        warpToSettleable(a);
        refreshFeeds();
        _keeperSettle();
        assertTrue(queue.getRequest(a).closed, "the first settle supplied to the venues");
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        if (!ok) emit log_named_bytes("the second settle reverted with", ret);
        assertTrue(ok, "check 5 passes a second settle in the same block");
        assertEq(queue.getRequest(stuck).remaining, 100e6, "nothing else to fill");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 6: `returnAllowed` is cleared (E17, RB-11, RB-18)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _heldDeposit() internal returns (uint256 sid, uint256 claimId) {
        uint256 id = openDepositRequest(alice, 5_000e6, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
        sid = _keeperSettle();
        claimId = queue.claimCount();
        assertEq(queue.getClaim(claimId).requestId, id, "alice's claim");
    }

    /// @notice After `allowReturn` the Safe releases instead. Release ends the return: the depositor can no longer
    ///         take its held shares out early (RB-11); they deliver after the hold.
    function test_fix6_releaseClearsTheReturn() public fixtureCovered {
        (uint256 sid, uint256 claimId) = _heldDeposit();
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        timelockExecute(address(queue), abi.encodeCall(queue.allowReturn, (sid)));
        assertTrue(queue.getSettlement(sid).returnAllowed, "return allowed");
        timelockExecute(address(queue), abi.encodeCall(queue.releaseSettlement, (sid)));
        assertFalse(queue.getSettlement(sid).returnAllowed, "fix 6: release clears it");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.ReturnNotAllowed.selector, sid));
        queue.takeReturn(claimId);

        Claim memory c = queue.getClaim(claimId);
        vm.warp(c.unlockAt);
        refreshFeeds();
        queue.mint(c.shares, alice);
        assertEq(fund.balanceOf(alice), c.shares, "delivered after the hold");
    }

    /// @notice A freeze that ended by itself inside the hold, then a new freeze: the new freeze starts with returns
    ///         disallowed, so only the Safe's new decision allows one.
    function test_fix6_aNewFreezeStartsWithReturnsDisallowed() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        p.maxFreeze = 1 hours;
        // The freeze must run out INSIDE the hold, after the timelock's allowReturn: a hold longer than maxFreeze plus
        // the timelock delay (the 1 h default of decision D4-11 is not; 24 h is inside the hold bounds).
        p.minHold = 24 hours;
        _setParams(p);
        (uint256 sid, uint256 claimId) = _heldDeposit();
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        timelockExecute(address(queue), abi.encodeCall(queue.allowReturn, (sid)));
        vm.warp(queue.getSettlement(sid).frozenUntil);
        assertLt(block.timestamp, queue.getSettlement(sid).holdEndsAt, "still inside the hold");
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        assertFalse(
            queue.getSettlement(sid).returnAllowed, "fix 6: a new freeze clears the old return"
        );
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.ReturnNotAllowed.selector, sid));
        queue.takeReturn(claimId);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 7: a sweep of what lies above the books (D-AT-5)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev A queue holding every kind of booked value: pending deposit escrow (bob), deposit shares in their hold
    ///      (carol), settled redemption USDC not yet taken (dave), pending redemption escrow (erin), a USDC credit
    ///      (bob's cancelled second deposit) and a share credit (erin's cancelled second redemption), and dust.
    function _bookedQueue() internal returns (uint256 bobPending, uint256 erinPending) {
        uint256 daveShares = _holder(dave, 20_000e6);
        uint256 erinShares = _holder(erin, 20_000e6);
        uint256 c = openDepositRequest(carol, 7_000e6, type(uint256).max);
        uint256 d = openRedeemRequest(dave, daveShares / 3, 0);
        warpToSettleable(c);
        settleAll();
        assertTrue(
            queue.getRequest(c).closed && queue.getRequest(d).closed, "carol and dave settled"
        );
        bobPending = openDepositRequest(bob, 3_000e6, type(uint256).max);
        uint256 bobCancel = openDepositRequest(bob, 1_000e6, type(uint256).max);
        erinPending = openRedeemRequest(erin, erinShares / 4, 0);
        uint256 erinCancel = openRedeemRequest(erin, erinShares / 5, 0);
        vm.prank(bob);
        queue.cancel(bobCancel);
        vm.prank(erin);
        queue.cancel(erinCancel);
        FlowBooks memory b = queue.books();
        assertGt(b.pendingUsdc, 0, "pending USDC");
        assertGt(b.owedUsdc, 0, "owed USDC");
        assertGt(b.creditUsdc, 0, "USDC credit");
        assertGt(b.escrowShares, 0, "escrowed shares");
        assertGt(b.heldShares, 0, "held shares");
        assertGt(b.creditShares, 0, "share credit");
    }

    /// @notice A stranger sweeps gifts and dust to the fund; nothing booked moves, and afterwards every owner still
    ///         takes all it is owed and the queue ends empty.
    function test_fix7_aSweepSendsOnlyWhatLiesAboveTheBooks() public fixtureCovered {
        (uint256 bobPending, uint256 erinPending) = _bookedQueue();
        uint256 giftUsdc = 1_234e6;
        fundUsdc(address(queue), giftUsdc);
        uint256 giftShares = fund.balanceOf(dave) / 10;
        vm.prank(dave);
        fund.transfer(address(queue), giftShares);
        FlowBooks memory b0 = queue.books();
        uint256 idle0 = fund.idleUsdc();
        uint256 fundShares0 = fund.balanceOf(address(fund));

        (bool ok, uint256 usdc, uint256 shares) = _sweep(stranger);
        assertTrue(ok, "fix 7: anyone may sweep");
        assertEq(usdc, giftUsdc + b0.dustUsdc, "the USDC gift and the USDC dust");
        assertEq(shares, giftShares + b0.dustShares, "the share gift and the share dust");
        assertEq(fund.idleUsdc(), idle0 + usdc, "to the fund's idle USDC");
        assertEq(
            fund.balanceOf(address(fund)),
            fundShares0 + shares,
            "shares to the fund, beside its seed"
        );
        FlowBooks memory b1 = queue.books();
        assertEq(b1.pendingUsdc, b0.pendingUsdc, "pending untouched");
        assertEq(b1.owedUsdc, b0.owedUsdc, "owed untouched");
        assertEq(b1.creditUsdc, b0.creditUsdc, "USDC credit untouched");
        assertEq(b1.escrowShares, b0.escrowShares, "escrow untouched");
        assertEq(b1.heldShares, b0.heldShares, "held untouched");
        assertEq(b1.creditShares, b0.creditShares, "share credit untouched");
        assertEq(b1.dustUsdc + b1.dustShares, 0, "dust swept");
        _assertBooks("after the sweep");
        (bool again, uint256 u2, uint256 s2) = _sweep(stranger);
        assertTrue(again && u2 == 0 && s2 == 0, "a second sweep moves nothing");

        _everyoneTakesAll(bobPending, erinPending);
        assertEq(
            IERC20(USDC).balanceOf(address(queue)),
            queue.books().dustUsdc,
            "the queue holds only new dust"
        );
        assertEq(fund.balanceOf(address(queue)), queue.books().dustShares, "and no share");
    }

    /// @dev Every owner takes what the queue owes it, whatever settled meanwhile: each open request is cancelled,
    ///      each settled redemption's USDC taken, each held deposit delivered after its hold, each credit withdrawn.
    function _everyoneTakesAll(uint256, uint256) internal {
        address[5] memory owners = [alice, bob, carol, dave, erin];
        uint256 n = queue.requestCount();
        for (uint256 id = 1; id <= n; ++id) {
            Request memory r = queue.getRequest(id);
            if (r.closed || r.remaining == 0) continue;
            vm.prank(r.owner);
            queue.cancel(id);
        }
        for (uint256 k; k < owners.length; ++k) {
            address u = owners[k];
            uint256 owed = queue.maxRedeem(u);
            if (owed != 0) {
                vm.prank(u);
                queue.redeem(owed, u, u);
            }
            deliverAfterHold(u);
            (uint256 cu, uint256 cs) = queue.creditOf(u);
            if (cu != 0 || cs != 0) {
                vm.prank(u);
                queue.withdrawCredit();
            }
        }
        FlowBooks memory b = queue.books();
        assertEq(b.pendingUsdc + b.owedUsdc + b.creditUsdc, 0, "every USDC obligation paid");
        assertEq(b.escrowShares + b.heldShares + b.creditShares, 0, "every share obligation paid");
    }

    /// forge-config: default.fuzz.runs = 8
    /// @notice Any gift, swept at any point between flows, never takes booked escrow: after each sweep the queue's
    ///         balances equal its obligations exactly, and at the end every owner is paid in full.
    function testFuzz_fix7_aSweepNeverTakesBookedEscrow(
        uint64 giftUsdc,
        uint64 giftShareBps,
        uint8 when
    ) public fixtureCovered {
        // Up to 5,000 USDC, about 3.5 % of this fund's NAV: a larger gift swept into the fund moves NAV per share past
        // the share-price breaker (check 6 holds the next settlement, as for any gift to the fund), which is not
        // what this test is about.
        giftUsdc = uint64(bound(giftUsdc, 0, 5_000e6));
        giftShareBps = uint64(bound(giftShareBps, 0, 5_000));
        (uint256 bobPending, uint256 erinPending) = _bookedQueue();
        if (giftUsdc != 0) fundUsdc(address(queue), giftUsdc);
        uint256 giftShares = fund.balanceOf(dave) * giftShareBps / 10_000;
        if (giftShares != 0) {
            vm.prank(dave);
            fund.transfer(address(queue), giftShares);
        }
        if (when % 2 == 0) _sweepAndCheck();
        if (when % 3 == 0) {
            // More flow between the gift and the sweep: alice deposits and settles.
            uint256 a = openDepositRequest(alice, 2_000e6, type(uint256).max);
            warpToSettleable(a);
            settleAll();
        }
        _sweepAndCheck();
        _everyoneTakesAll(bobPending, erinPending);
    }

    function _sweepAndCheck() internal {
        (bool ok,,) = _sweep(stranger);
        assertTrue(ok, "fix 7: anyone may sweep");
        FlowBooks memory b = queue.books();
        assertEq(
            IERC20(USDC).balanceOf(address(queue)),
            b.pendingUsdc + b.owedUsdc + b.creditUsdc,
            "USDC = obligations"
        );
        assertEq(
            fund.balanceOf(address(queue)),
            b.escrowShares + b.heldShares + b.creditShares,
            "shares = obligations"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 8: no stale "stub" comment in the queue
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice The queue has no stub left (scaffold report §8.1), so its comments must not say it has.
    function test_fix8_theQueueSourceCallsNothingAStub() public view {
        bytes memory src = bytes(vm.readFile("contracts/test/prototype/src/FlowQueue.sol"));
        assertFalse(_contains(src, bytes("stub")), "fix 8: no 'stub' in FlowQueue.sol");
        assertFalse(_contains(src, bytes("Stub")), "fix 8: no 'Stub' in FlowQueue.sol");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 9: an exclusion does not trip the share-price breaker (D-AT-4, E13, check 6)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev An invested fund, bob a holder, carol's deposit settled just now (the breaker's reference), bob's
    ///      redemption request, then Moonwell (about a fifth of NAV) excluded; warp to the request's window, one
    ///      epoch after the reference.
    function _excludedMoonwell() internal returns (uint256 red) {
        _invest();
        uint256 bobShares = _holder(bob, 50_000e6);
        uint256 c = openDepositRequest(carol, 1_000e6, type(uint256).max);
        settleUntilFilled(c);
        red = openRedeemRequest(bob, bobShares / 2, 0);
        timelockExecute(
            address(fund),
            abi.encodeCall(
                fund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false)
            )
        );
        assertGt(fund.openExclusionOf(IDX_MOONWELL), 0, "Moonwell excluded");
        warpToSettleable(red);
        refreshFeeds();
        FlowParams memory p = queue.flowParams();
        uint256 lastAt = queue.getSettlement(queue.settlementCount()).time;
        assertEq(
            block.timestamp / p.epochLength - lastAt / p.epochLength,
            1,
            "one epoch after the reference"
        );
    }

    /// @notice Excluding Moonwell drops NAV per share at the feeds by its share (about 20 %, over the 10 % breaker
    ///         for one epoch). The breaker measures market moves, not the governed exclusion, so redemptions settle
    ///         at once, alone, as E13 says. The scaffold held them for an epoch.
    function test_fix9_anExclusionDoesNotHoldRedemptionsAtTheBreaker() public fixtureCovered {
        uint256 red = _excludedMoonwell();
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        if (!ok) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok, "fix 9: check 6 does not hold the settlement");
        assertTrue(queue.getRequest(red).closed, "the redemption settled");
        assertEq(
            queue.getSettlement(queue.settlementCount()).sharesMinted,
            0,
            "alone: deposits stay closed"
        );
    }

    /// @notice The breaker still measures the market after an exclusion: a 15 % gift to the fund in the same epoch
    ///         trips it. On the scaffold the exclusion's drop hid the gift (the net move was under the breaker).
    function test_fix9_theBreakerStillCatchesAMarketMoveAfterAnExclusion() public fixtureCovered {
        _excludedMoonwell();
        (uint256 nav,,) = fund.portfolioValues();
        fundUsdc(address(fund), nav * 15 / 100);
        refreshFeeds();
        uint256 moveBps = _expectBlocked(keeper, SettleCheck.SharePrice, IDLE_INDEX);
        emit log_named_uint("move the breaker measured (bps)", moveBps);
        assertGt(moveBps, 1_000, "fix 9: the gift alone is over the breaker");
    }

    /// @notice Control: a restore after the exclusion does not trip the breaker either; deposits settle again.
    function test_fix9_aRestoreDoesNotTripTheBreaker_control() public fixtureCovered {
        uint256 red = _excludedMoonwell();
        (bool ok,) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        if (!ok) {
            // The scaffold holds every settlement for an epoch here; wait it out so the restore can be checked.
            vm.warp(block.timestamp + queue.flowParams().epochLength);
            refreshFeeds();
            _keeperSettle();
        }
        assertTrue(queue.getRequest(red).closed, "the redemption settled");
        timelockExecute(
            address(fund),
            abi.encodeCall(
                fund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, true)
            )
        );
        uint256 d = openDepositRequest(dave, 5_000e6, type(uint256).max);
        warpToSettleable(d);
        refreshFeeds();
        (bool ok2, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        if (!ok2) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok2, "the restore does not trip the breaker");
        assertTrue(queue.getRequest(d).closed, "deposits settle again");
    }
}

/// @title FlowQueueOldestFirstInvariant
/// @notice Step 3 finish plan §3.1 item 2: "the oldest fillable request always fills first", as invariants over
///         random sequences of requests (both sides, admissible and tight limits), cancels, feed moves inside
///         `refBandBps`, time, and settle calls by the keeper (whole budget) and by a stranger (small budgets, and
///         `maxUsdc` 0). Request sizes keep every cap far away, so a fill never waits for room.
///         - Keeper: a keeper call that succeeds fills every pending request in its range whose own limit admits
///           that call's bound price (read with the quotes in the same state just before the call), so none waits
///           behind a newer one. (A side that failed is exempt for that call.)
///         - No room: a call with `maxUsdc` 0 fills nothing and moves no cursor.
///         - Keeper first per epoch: a stranger never fills a request whose epoch's window end plus `keeperGrace`
///           is still ahead.
///         - A stranger's call never moves the keeper's cursor.
/// forge-config: default.invariant.runs = 16
/// forge-config: default.invariant.depth = 32
/// forge-config: default.invariant.fail-on-revert = false
/// forge-config: default.invariant.dictionary-weight = 0
/// forge-config: default.invariant.shrink-run-limit = 0
contract FlowQueueOldestFirstInvariant is FlowQueueFixesBase {
    using Math for uint256;

    address[4] internal users;
    uint256 public ghostViolations;
    string internal lastViolation;
    uint256 public callsSettleKeeper;
    uint256 public callsSettleStranger;
    uint256 public callsNoRoom;
    uint256 public fillsChecked;
    uint256 public admissibleChecked;
    bool internal keeperMidPass;

    function setUp() public override {
        super.setUp();
        users = [alice, bob, carol, dave];
        _invest();
        uint256 last;
        for (uint256 k; k < users.length; ++k) {
            last = openDepositRequest(users[k], 20_000e6, type(uint256).max);
        }
        settleUntilFilled(last);
        for (uint256 k; k < users.length; ++k) {
            deliverAfterHold(users[k]);
            (uint256 u,) = queue.creditOf(users[k]);
            if (u != 0) {
                vm.prank(users[k]);
                queue.withdrawCredit();
            }
        }
        alignFeedsToPools();
        refreshFeeds();
        // `act_settleAfterWindow` is listed three times: most settle calls then find requests in range.
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = this.act_requestDeposit.selector;
        selectors[1] = this.act_requestRedeem.selector;
        selectors[2] = this.act_settle.selector;
        selectors[3] = this.act_wait.selector;
        selectors[4] = this.act_moveFeeds.selector;
        selectors[5] = this.act_cancel.selector;
        selectors[6] = this.act_settleAfterWindow.selector;
        selectors[7] = this.act_settleAfterWindow.selector;
        selectors[8] = this.act_settleAfterWindow.selector;
        targetContract(address(this));
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));
        // Coverage is checked after setUp and after every action, so no single check decodes the state diff of a
        // whole run (MemoryOOG otherwise, as the scaffold's verify-T1 and T2 found).
        coverageCheckpoint();
    }

    function _violation(string memory why) internal {
        ++ghostViolations;
        lastViolation = why;
    }

    // ─── Actions ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice A deposit of 200 to 2 000 USDC with a limit at the quote (admissible now), one unit under it (tight:
    ///         refused now, maybe admissible after a feed move), or 1 (never).
    function act_requestDeposit(uint256 who, uint256 size, uint256 kindOfLimit) public {
        address u = users[who % users.length];
        size = bound(size, 200e6, 2_000e6);
        refreshFeeds();
        uint256 limit = type(uint256).max;
        uint256 k = kindOfLimit % 3;
        if (k != 2) {
            try queue.quoteDeposit(size) returns (Quote memory q) {
                limit = k == 0 ? q.boundPrice - 1 : q.boundPrice;
            } catch {}
        } else {
            limit = 1;
        }
        openDepositRequest(u, size, limit);
        coverageCheckpoint();
    }

    /// @notice A redemption of 1 % to 5 % of a holder's shares, any price or tight (one unit over the quote).
    function act_requestRedeem(uint256 who, uint256 bps, bool tight) public {
        address u = users[who % users.length];
        uint256 shares = fund.balanceOf(u) * bound(bps, 100, 500) / 10_000;
        if (shares == 0) return;
        refreshFeeds();
        uint256 limit;
        if (tight) {
            try queue.quoteRedeem(shares) returns (Quote memory q) {
                limit = q.boundPrice + 1;
            } catch {}
        }
        openRedeemRequest(u, shares, limit);
        coverageCheckpoint();
    }

    function act_wait(uint256 secs) public {
        vm.warp(block.timestamp + bound(secs, 10 minutes, 8 hours));
        refreshFeeds();
        coverageCheckpoint();
    }

    /// @notice Both basket feeds move up to 25 bps around their pools (inside `refBandBps`).
    function act_moveFeeds(uint256 bps, bool down) public {
        bps = bound(bps, 0, 25);
        uint256 eth8 = poolPrice8(WETH_POOL, WETH);
        uint256 btc8 = poolPrice8(CBBTC_POOL, CBBTC);
        setFeedPrice(IDX_WETH, down ? eth8 - eth8 * bps / 10_000 : eth8 + eth8 * bps / 10_000);
        setFeedPrice(IDX_CBBTC, down ? btc8 - btc8 * bps / 10_000 : btc8 + btc8 * bps / 10_000);
        coverageCheckpoint();
    }

    function act_cancel(uint256 seed) public {
        uint256 n = queue.requestCount();
        for (uint256 k; k < n; ++k) {
            uint256 id = 1 + (seed + k) % n;
            Request memory r = queue.getRequest(id);
            if (r.closed || r.remaining == 0) continue;
            vm.prank(r.owner);
            queue.cancel(id);
            break;
        }
        coverageCheckpoint();
    }

    struct Pre {
        uint256[] ids;
        uint256[] remaining;
        bool[] admissible;
        bool[] inRange;
        bool keeperCursorOk;
        uint64 kDepE;
        uint256 kDepI;
        uint64 kRedE;
        uint256 kRedI;
        uint64 pDepE;
        uint256 pDepI;
        uint64 pRedE;
        uint256 pRedI;
    }

    /// @notice `settle` by the keeper (whole budget, any USDC) or a stranger (1 to 8 requests; any USDC or none).
    ///         With `wait`, time first passes to the end of the oldest open request's window (and its keeper grace
    ///         for a stranger), as a settler that waits for the window would.
    function act_settle(uint256 callerSeed, uint256 maxReq, bool noRoom, bool wait) public {
        bool isKeeper = callerSeed % 2 == 0;
        address c = isKeeper ? keeper : stranger;
        if (wait) _waitForOldestWindow(!isKeeper);
        refreshFeeds();
        uint256 maxRequests = isKeeper ? SETTLE_MAX_REQUESTS : bound(maxReq, 1, 8);
        uint256 maxUsdc = noRoom ? 0 : type(uint256).max;
        Pre memory pre = _pre(isKeeper);
        vm.recordLogs();
        vm.prank(c);
        try queue.settle(maxRequests, maxUsdc) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (isKeeper) ++callsSettleKeeper;
            else ++callsSettleStranger;
            _post(pre, isKeeper, noRoom, logs);
        } catch {
            vm.getRecordedLogs();
        }
        coverageCheckpoint();
    }

    /// @notice `act_settle` after waiting for the oldest open request's window (and grace, for a stranger).
    function act_settleAfterWindow(uint256 callerSeed, uint256 maxReq, bool noRoom) public {
        act_settle(callerSeed, maxReq, noRoom, true);
    }

    function _waitForOldestWindow(bool plusGrace) internal {
        uint256 n = queue.requestCount();
        uint64 oldest = type(uint64).max;
        for (uint256 id = 1; id <= n; ++id) {
            Request memory r = queue.getRequest(id);
            if (r.closed || r.remaining == 0 || queue.requestStatus(id) != RequestStatus.Pending) {
                continue;
            }
            if (r.epoch < oldest) oldest = r.epoch;
        }
        if (oldest == type(uint64).max) return;
        warpForward(
            uint256(queue.settleableAt(oldest)) + (plusGrace ? queue.flowParams().keeperGrace : 0)
        );
    }

    function _pre(bool isKeeper) internal view returns (Pre memory pre) {
        uint256 n = queue.requestCount();
        pre.ids = new uint256[](n);
        pre.remaining = new uint256[](n);
        pre.admissible = new bool[](n);
        pre.inRange = new bool[](n);
        FlowParams memory p = queue.flowParams();
        uint64 cur = queue.currentEpoch();
        for (uint256 k; k < n; ++k) {
            uint256 id = k + 1;
            Request memory r = queue.getRequest(id);
            pre.ids[k] = id;
            pre.remaining[k] = r.closed ? 0 : r.remaining;
            if (r.closed || r.remaining == 0 || uint256(cur) > uint256(r.epoch) + p.maxRoll) {
                continue;
            }
            uint256 ends = queue.settleableAt(r.epoch);
            pre.inRange[k] = block.timestamp >= ends + (isKeeper ? 0 : p.keeperGrace);
            if (r.kind == RequestKind.Deposit) {
                try queue.quoteDeposit(r.remaining) returns (Quote memory q) {
                    pre.admissible[k] = r.limit >= q.boundPrice;
                } catch {}
            } else {
                try queue.quoteRedeem(r.remaining) returns (Quote memory q) {
                    pre.admissible[k] = r.limit <= q.boundPrice;
                } catch {}
            }
        }
        (pre.keeperCursorOk, pre.kDepE, pre.kDepI) = _cursor(true, RequestKind.Deposit);
        (, pre.kRedE, pre.kRedI) = _cursor(true, RequestKind.Redeem);
        (, pre.pDepE, pre.pDepI) = _cursor(false, RequestKind.Deposit);
        (, pre.pRedE, pre.pRedI) = _cursor(false, RequestKind.Redeem);
    }

    function _post(Pre memory pre, bool isKeeper, bool noRoom, Vm.Log[] memory logs) internal {
        FlowParams memory p = queue.flowParams();
        bool depFailed = _sideFailures(logs, RequestKind.Deposit) != 0;
        bool redFailed = _sideFailures(logs, RequestKind.Redeem) != 0;
        for (uint256 k; k < pre.ids.length; ++k) {
            Request memory r = queue.getRequest(pre.ids[k]);
            uint256 rem = r.closed ? 0 : r.remaining;
            bool filled = rem < pre.remaining[k] && !(r.closed && _cancelledNow(logs, pre.ids[k]));
            if (filled) {
                ++fillsChecked;
                if (noRoom) _violation("no room: a call with maxUsdc 0 filled a request");
                if (
                    !isKeeper
                        && block.timestamp < uint256(queue.settleableAt(r.epoch)) + p.keeperGrace
                ) {
                    _violation("keeper first: a stranger filled an epoch inside its grace");
                }
            } else if (
                isKeeper && !noRoom && pre.inRange[k] && pre.admissible[k] && pre.remaining[k] != 0
            ) {
                bool failed = r.kind == RequestKind.Deposit ? depFailed : redFailed;
                if (!failed && !keeperMidPass) {
                    _violation("oldest first: the keeper left an admissible request pending");
                }
            }
            if (isKeeper && pre.inRange[k] && pre.admissible[k]) ++admissibleChecked;
        }
        if (isKeeper) keeperMidPass = depFailed || redFailed;
        if (noRoom) {
            ++callsNoRoom;
            _sameCursor(pre, isKeeper);
        }
        if (!isKeeper && pre.keeperCursorOk) {
            (, uint64 e1, uint256 i1) = _cursor(true, RequestKind.Deposit);
            (, uint64 e2, uint256 i2) = _cursor(true, RequestKind.Redeem);
            if (e1 != pre.kDepE || i1 != pre.kDepI || e2 != pre.kRedE || i2 != pre.kRedI) {
                _violation("a stranger's call moved the keeper's cursor");
            }
        }
    }

    function _sameCursor(Pre memory pre, bool isKeeper) internal {
        if (!pre.keeperCursorOk) return;
        (, uint64 e1, uint256 i1) = _cursor(isKeeper, RequestKind.Deposit);
        (, uint64 e2, uint256 i2) = _cursor(isKeeper, RequestKind.Redeem);
        bool same = isKeeper
            ? (e1 == pre.kDepE && i1 == pre.kDepI && e2 == pre.kRedE && i2 == pre.kRedI)
            : (e1 == pre.pDepE && i1 == pre.pDepI && e2 == pre.pRedE && i2 == pre.pRedI);
        if (!same) _violation("no room: a call with maxUsdc 0 moved a cursor");
    }

    function _cancelledNow(Vm.Log[] memory logs, uint256 id) internal view returns (bool) {
        for (uint256 k; k < logs.length; ++k) {
            if (
                logs[k].emitter == address(queue)
                    && logs[k].topics[0] == IFlowEvents.RequestCancelled.selector
                    && uint256(logs[k].topics[1]) == id
            ) return true;
        }
        return false;
    }

    // ─── Invariants ──────────────────────────────────────────────────────────────────────────────────────

    function invariant_oldestFillableFillsFirst() public fixtureCovered {
        _assertNoViolation();
    }

    function _assertNoViolation() internal {
        if (ghostViolations != 0) emit log_named_string("last violation", lastViolation);
        assertEq(ghostViolations, 0, "the oldest fillable request always fills first");
    }

    function afterInvariant() public {
        emit log_named_uint("keeper settles", callsSettleKeeper);
        emit log_named_uint("stranger settles", callsSettleStranger);
        emit log_named_uint("no-room settles", callsNoRoom);
        emit log_named_uint("fills checked", fillsChecked);
        emit log_named_uint("admissible requests checked at keeper calls", admissibleChecked);
    }

    /// @notice The scripted run: the D-AT-3 pattern and the moved-bound pattern in a fixed order, then the checks.
    ///         It runs every action once outside the random campaign, so the property is exercised whatever the
    ///         campaign draws.
    function test_script_oldestFillableFillsFirst() public fixtureCovered {
        act_requestDeposit(0, 1_000e6, 1); // alice, admissible
        act_requestDeposit(1, 1_000e6, 1); // bob, admissible
        act_requestRedeem(2, 200, false); // carol
        vm.warp(block.timestamp + 13 hours); // past the window and the grace
        refreshFeeds();
        act_settle(1, 1, true, false); // a stranger, no room: must pass nothing
        act_settle(1, 1, false, false); // a stranger, one request: the oldest of each side
        act_settle(0, 0, false, false); // the keeper: everything admissible
        act_requestDeposit(3, 1_000e6, 0); // dave, tight
        act_requestDeposit(0, 1_000e6, 1); // alice, admissible
        vm.warp(block.timestamp + 13 hours);
        refreshFeeds();
        act_settle(1, 1, false, false); // a stranger passes dave's tight request
        act_moveFeeds(25, true); // the bound falls: dave's request is admissible now
        act_settle(0, 0, false, false); // the keeper's pass starts at the oldest
        act_cancel(0);
        emit log_named_uint("keeper settles", callsSettleKeeper);
        emit log_named_uint("stranger settles", callsSettleStranger);
        emit log_named_uint("admissible requests checked at keeper calls", admissibleChecked);
        _assertNoViolation();
    }
}
