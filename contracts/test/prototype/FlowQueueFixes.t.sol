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
    SettleCheck,
    TIMELOCK_DELAY_REFERENCE
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

    function availableLiquidity() external view returns (uint256) {
        uint256 cash = IERC20(USDC).balanceOf(address(A_TOKEN));
        uint256 bal = A_TOKEN.balanceOf(address(this));
        return cash < bal ? cash : bal;
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
        uint256 first = openDepositRequest(carol, 1_000e6);
        vm.warp(block.timestamp + p.epochLength);
        uint256 second = openDepositRequest(alice, 5_000e6);
        uint64 e1 = queue.getRequest(first).epoch;
        uint64 e2 = queue.getRequest(second).epoch;
        assertEq(e2, e1 + 1, "consecutive epochs");
        warpForward(uint256(queue.settleableAt(e2)) + p.keeperGrace);
        refreshFeeds();

        // Step 3f (E34): permissionless settlement is retired; a non-keeper cannot settle even past keeperGrace.
        _expectBlocked(stranger, SettleCheck.Caller, IDLE_INDEX);
        assertEq(queue.settlementCount(), 0, "nothing settled by stranger");
        assertEq(queue.getRequest(first).remaining, 1_000e6, "first waits");
        assertEq(queue.getRequest(second).remaining, 5_000e6, "second waits");

        _keeperSettle();
        assertTrue(queue.getRequest(first).closed, "keeper settles first");
        assertTrue(queue.getRequest(second).closed, "keeper settles second");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 2: the cursor (D-AT-3, RB-20, RB-14; ruling 3)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice D-AT-3: a call with no room (`maxUsdc` 0) fills nothing and must move no cursor, so the next call
    ///         starts at the oldest request.
    function test_fix2_aCallWithNoRoomPassesNothing() public fixtureCovered {
        uint256 oldest = openDepositRequest(alice, 5_000e6);
        uint256 newer = openDepositRequest(bob, 5_000e6);
        warpToSettleable(oldest);
        refreshFeeds();
        (, uint64 e0, uint256 i0) = _cursor(true, RequestKind.Deposit);
        vm.prank(keeper);
        assertEq(queue.settle(1, 0), 0, "a call with no room fills nothing");
        (bool viewOk, uint64 e1, uint256 i1) = _cursor(true, RequestKind.Deposit);
        if (viewOk) {
            assertEq(e1, e0, "the cursor epoch did not move");
            assertEq(i1, i0, "the cursor index did not move");
        }
        vm.prank(keeper);
        queue.settle(1, type(uint256).max);
        assertTrue(queue.getRequest(oldest).closed, "fix 2: the next call fills the oldest request");
        assertFalse(queue.getRequest(newer).closed, "and only that one");

        // Another no-room call moves nothing before the rest fills.
        vm.prank(keeper);
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

    /// @notice A stranger's reverted call never touches the keeper's pass: the keeper settles the oldest request first.
    function test_fix2_aStrangerCannotMoveTheKeepersPass() public fixtureCovered {
        _invest();
        uint256 r1 = openDepositRequest(alice, 5_000e6);
        uint256 r2 = openDepositRequest(bob, 5_000e6);
        warpToSettleable(r1);
        refreshFeeds();
        (, uint64 e0, uint256 i0) = _cursor(true, RequestKind.Deposit);
        _expectBlocked(stranger, SettleCheck.Caller, IDLE_INDEX);
        (, uint64 e1, uint256 i1) = _cursor(true, RequestKind.Deposit);
        assertEq(e1, e0, "stranger call did not move keeper cursor epoch");
        assertEq(i1, i0, "stranger call did not move keeper cursor index");

        vm.prank(keeper);
        queue.settle(1, type(uint256).max);
        assertTrue(queue.getRequest(r1).closed, "keeper fills oldest request first");
        assertFalse(queue.getRequest(r2).closed, "newer request still waits");
        _keeperSettle();
        assertTrue(queue.getRequest(r2).closed, "keeper fills remaining request");
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
            queue.requestDeposit(100e6, flooder);
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
        // E51: maxRoll * epochLength <= TIMELOCK_DELAY_REFERENCE (48 hours).
        uint256 maxAllowedRoll = uint256(TIMELOCK_DELAY_REFERENCE) / len;
        if (p.maxRoll > maxAllowedRoll) p.maxRoll = uint16(maxAllowedRoll);
    }

    /// @notice Longer epochs, with a request pending: it settles at the end of its own window (its epoch keeps the
    ///         length it was opened with), and a request made after the change settles on the new schedule.
    function test_fix3_longerEpochsWithAPendingRequest() public fixtureCovered {
        uint256 r1 = openDepositRequest(alice, 5_000e6);
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

        uint256 r2 = openDepositRequest(bob, 5_000e6);
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
        uint256 r0 = openDepositRequest(alice, 5_000e6);
        warpToSettleable(r0);
        refreshFeeds();
        _keeperSettle();
        assertTrue(queue.getRequest(r0).closed, "settled before the change");

        _setParams(_withEpochLength(12 hours));
        uint256 r2 = openDepositRequest(bob, 5_000e6);
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

    /// @notice Step 3f (RB-31, E41): parameter changes reset walk cursors without orphaning waiting requests, while
    ///         snapshotted `maxRoll` / `expiryEpoch` on earlier requests never expand retroactively.
    function test_fix3_aLargerMaxRollDoesNotOrphanARevivedRequest() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        p.maxRoll = 4; // 4 * 6h = 24h; later raised to 8 (8 * 6h = 48h <= TIMELOCK_DELAY_REFERENCE)
        _setParams(p);

        uint256 old = openDepositRequest(alice, 5_000e6);
        // Nobody settles for maxRoll + 1 epochs: `old` expires with its locked `maxRoll = 4`.
        vm.warp(block.timestamp + (uint256(p.maxRoll) + 1) * p.epochLength);
        assertEq(uint8(queue.requestStatus(old)), uint8(RequestStatus.Expired), "expired");
        uint256 fresh = openDepositRequest(bob, 5_000e6);
        uint256 marker = openDepositRequest(carol, 5_000e6);
        warpToSettleable(fresh);
        refreshFeeds();
        // Settle 2 look slots: skip expired `old` and fill `fresh`, leaving `marker` waiting behind cursor.
        vm.prank(keeper);
        queue.settle(2, type(uint256).max);
        assertTrue(queue.getRequest(fresh).closed, "a fresh request settles");
        assertEq(queue.getRequest(marker).remaining, 5_000e6, "the marker waits");

        p.maxRoll = 8;
        _setParams(p);
        assertEq(
            uint8(queue.requestStatus(old)),
            uint8(RequestStatus.Expired),
            "RB-31: snapshotted maxRoll never expands for locked requests"
        );
        uint256 underNewMaxRoll = openDepositRequest(bob, 5_000e6);
        assertEq(queue.getRequest(underNewMaxRoll).maxRoll, 8, "new requests get maxRoll 8");
        refreshFeeds();
        (bool ok,) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        assertTrue(ok, "a settle runs");
        assertTrue(queue.getRequest(marker).closed, "fix 3: waiting marker is not orphaned");
        vm.prank(alice);
        assertEq(queue.withdrawExpired(old), 5_000e6, "expired locked request returns full escrow");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 4: a venue that burns all its gas fails its own side alone (ruling 1, RB-15, RB-20)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice With net deposits (D > R), the deposit venue burns every unit of gas it gets. Whole match still settles
    ///         the paired redemptions (`Match` first, §5.11.4), while the net deposit side fails alone (`SideFailed`).
    function test_fix4_aVenueThatBurnsItsGasOnSupplyFailsTheDepositSideAlone()
        public
        fixtureCovered
    {
        _invest();
        _bobShares = _holder(bob, 50_000e6);
        coverageCheckpoint();
        _redId = openRedeemRequest(bob, _bobShares / 2);
        _depId = openDepositRequest(alice, 20_000e6);
        uint256 extraDep = openDepositRequest(dave, 20_000e6); // D = 40k > R (~25k), so net side is Deposit
        warpToSettleable(_depId);
        refreshFeeds();

        FixVenue v = _etchVenue();
        v.setBurn(true, false);
        vm.recordLogs();
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok, "fix 4: the settle succeeds");
        Settlement memory st = queue.getSettlement(queue.settlementCount());
        assertEq(st.matchedShares, _bobShares / 2, "matched redemptions still settled");
        assertEq(st.sharesMinted, 0, "the net deposit side did not");
        assertEq(_sideFailures(logs, RequestKind.Deposit), 1, "the deposit side failed");
        assertGt(queue.pendingDepositRequest(extraDep, dave), 0, "unmatched net deposits wait");
        _assertBooks("burning supply");
    }

    /// @notice With net redemptions (R > D), the redemption venue burns every unit of gas it gets: whole match still
    ///         settles paired flow while the net redemption side fails alone.
    function test_fix4_aVenueThatBurnsItsGasOnWithdrawFailsTheRedemptionSideAlone()
        public
        fixtureCovered
    {
        _twoSided(); // R (~25k) > D (20k)
        FixVenue v = _etchVenue();
        v.setBurn(false, true);
        vm.recordLogs();
        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) emit log_named_bytes("settle reverted with", ret);
        assertTrue(ok, "fix 4: the settle succeeds");
        Settlement memory st = queue.getSettlement(queue.settlementCount());
        assertGt(st.matchedShares, 0, "matched volume still settled");
        assertEq(st.sharesBurned, 0, "the net redemption side did not settle");
        assertEq(_sideFailures(logs, RequestKind.Redeem), 1, "the redemption side failed");
        assertGt(queue.pendingRedeemRequest(_redId, bob), 0, "the unmatched redemption waits");
        _assertBooks("burning withdraw");
    }

    /// @notice The out-of-gas protection stays (RB-20): under Step 3f (Match + at most one net side), an honest
    ///         net-deposit round (`D > R`) either settles both match and the net deposit side or reverts whole; with a
    ///         burning deposit venue it settles only the match (`sharesMinted == 0`) or reverts whole. No gas limit
    ///         makes an honest net side fail while leaving match alone.
    function test_fix4_theGasACallerSendsStillCannotChooseASide() public fixtureCovered {
        _invest();
        _bobShares = _holder(bob, 50_000e6);
        coverageCheckpoint();
        _redId = openRedeemRequest(bob, _bobShares / 2);
        _depId = openDepositRequest(alice, 40_000e6); // D = 40k > R (~25k): Match + net Deposit
        warpToSettleable(_depId);
        refreshFeeds();

        bytes memory data = abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max));
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 g0 = gasleft();
        (bool ok,) = address(queue).call(data);
        uint256 used = g0 - gasleft();
        assertTrue(ok, "a full call settles");
        vm.revertToState(snap);
        emit log_named_uint("gas used by a full match + net deposit settle", used);
        coverageCheckpoint();

        uint256[4] memory n = _gasSweep(data, used, false); // match+net, partial/other, guard, other revert
        emit log_named_uint("honest: limits that settled match and net side", n[0]);
        emit log_named_uint("honest: limits with partial outcome", n[1]);
        emit log_named_uint("honest: limits stopped by SettleSideOutOfGas", n[2]);
        emit log_named_uint("honest: limits that ran out elsewhere", n[3]);
        assertEq(n[1], 0, "no gas limit silently drops the net side of an honest round");
        assertGt(n[0], 0, "enough gas settles both match and net side");

        FixVenue v = _etchVenue();
        v.setBurn(true, false);
        coverageCheckpoint();
        uint256[4] memory m = _gasSweep(data, used, true); // match only, other success, guard, other revert
        emit log_named_uint("burning: limits that settled match alone", m[0]);
        emit log_named_uint("burning: limits that settled otherwise", m[1]);
        emit log_named_uint("burning: limits stopped by SettleSideOutOfGas", m[2]);
        emit log_named_uint("burning: limits that ran out elsewhere", m[3]);
        assertEq(m[1], 0, "with a burning deposit venue a success settles only the match");
        assertGt(m[0], 0, "fix 4: enough gas settles match");
    }

    /// @notice Control and measurement for the fixed side budgets under Step 3f: 24 cold deposits fit in one
    ///         call (`first`), then 24 smaller cold deposits match O(1) against 24 cold redemptions (`R*S > D`),
    ///         leaving all 24 net redemption fills inside their side budget in one keeper call.
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
                makeAddr(string.concat("depositor", vm.toString(k))), 500e6, type(uint256).max
            );
        }
        coverageCheckpoint();
        warpToSettleable(lastRed);
        refreshFeeds();
        uint256 claims0 = queue.claimCount();
        vm.recordLogs();
        uint256 g0 = gasleft();
        uint256 sid = _keeperSettle();
        uint256 used = g0 - gasleft();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(
            _sideFailures(logs, RequestKind.Redeem) + _sideFailures(logs, RequestKind.Deposit),
            0,
            "no side failed"
        );
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.matchedShares, 0, "all 24 deposits matched O(1)");
        assertGt(st.sharesBurned, 0, "net redemptions settled in the same call");
        assertEq(
            queue.claimCount() - claims0, 2 * n, "24 synced match claims + 24 net redemption fills"
        );
        emit log_named_uint(
            "gas of one keeper settle with 24 matched deposits + 24 net redemptions", used
        );
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
                bool both = st.matchedShares == _bobShares / 2 && st.sharesMinted > 0;
                bool matchOnly = st.matchedShares == _bobShares / 2 && st.sharesMinted == 0;
                if (!burning && both) ++n[0];
                else if (burning && matchOnly) ++n[0];
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

    /// @notice The first settlement reads Aave's rate before its trades and records the post-trade rate. When a
    ///         subsequent 5 % rate jump causes check 5 (`LendRate`) to trip, Step 3f (E36) stops deposits for the
    ///         round (`DepositStoppedForRound` with cause 2) while `checkSettle()` stays `Ok` so redemptions settle alone.
    function test_fix5_aRateReadThatFailsAfterTheTradeStillLeavesAReference()
        public
        fixtureCovered
    {
        _invest();
        uint256 bobShares = _holder(bob, 20_000e6);
        FixVenue v = _etchVenue();
        v.setRate(true, 0);
        uint256 a = openDepositRequest(alice, 5_000e6);
        warpToSettleable(a);
        refreshFeeds();
        uint256 sid = _keeperSettle();
        assertGt(sid, 0, "the first settlement");
        assertTrue(queue.getRequest(a).closed, "it filled");
        assertTrue(v.traded(), "the deposit supplied to the venue");

        v.setRate(false, 500);
        v.setTraded(false);
        uint256 b = openDepositRequest(alice, 5_000e6);
        uint256 r = openRedeemRequest(bob, bobShares / 2);
        warpToSettleable(b);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck chk,) = queue.checkSettle();
        assertEq(
            uint8(chk),
            uint8(SettleCheck.Ok),
            "checkSettle stays Ok so redemptions settle during rate stop"
        );

        vm.expectEmit(true, false, false, true, address(queue));
        emit IFlowEvents.DepositStoppedForRound(queue.getRequest(b).epoch, 2);
        uint256 sid2 = _keeperSettle();
        assertGt(sid2, sid, "redemptions settle alone despite LendRate");
        assertTrue(queue.getRequest(r).closed, "redemption settled");
        assertEq(queue.getRequest(b).remaining, 5_000e6, "deposit blocked for round");
    }

    /// @notice Control: a second settle in the same block, after the first supplied to every lending venue, passes
    ///         check 5. With no time elapsed check 5 allows no growth, and the fund's own supply can move a venue's
    ///         rate by a rounding unit, so the reference must be the rate read after the trades.
    function test_fix5_aSecondSettleInTheSameBlockPassesCheck5_control() public fixtureCovered {
        _invest();
        uint256 a = openDepositRequest(alice, 20_000e6);
        uint256 second = openDepositRequest(carol, 5_000e6);
        warpToSettleable(a);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(1, type(uint256).max);
        assertTrue(queue.getRequest(a).closed, "the first settle supplied to the venues");
        assertEq(queue.getRequest(second).remaining, 5_000e6, "second waits for the next call");

        (bool ok, bytes memory ret) = _trySettle(keeper, SETTLE_MAX_REQUESTS, type(uint256).max);
        if (!ok) emit log_named_bytes("the second settle reverted with", ret);
        assertTrue(ok, "check 5 passes a second settle in the same block");
        assertTrue(queue.getRequest(second).closed, "the second settle fills it in the same block");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Item 6: Freeze release and cooldown (E49, RB-18)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _heldDeposit() internal returns (uint256 sid, uint256 claimId) {
        uint256 id = openDepositRequest(alice, 5_000e6);
        warpToSettleable(id);
        refreshFeeds();
        sid = _keeperSettle();
        claimId = queue.claimCount();
        assertEq(queue.getClaim(claimId).requestId, id, "alice's claim");
    }

    /// @notice After `freezeSettlement`, the Safe releases instead (`releaseSettlement`). Release lifts the freeze
    ///         without lifting the regular hold (no early return path exists in Step 3f); shares deliver at `holdEndsAt`.
    function test_fix6_releaseClearsTheReturn() public fixtureCovered {
        (uint256 sid,) = _heldDeposit();
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        assertGt(queue.getSettlement(sid).frozenUntil, block.timestamp, "frozen");

        timelockExecute(address(queue), abi.encodeCall(queue.releaseSettlement, (sid)));
        assertLe(queue.getSettlement(sid).frozenUntil, block.timestamp, "release clears the freeze");
        assertEq(queue.maxMint(alice), 0, "still in hold before holdEndsAt");

        warpForward(queue.getSettlement(sid).holdEndsAt);
        assertGt(queue.maxMint(alice), 0, "shares deliver once hold ends");
        vm.prank(alice);
        queue.mint(queue.maxMint(alice), alice);
        assertGt(fund.balanceOf(alice), 0, "alice receives her shares");
    }

    /// @notice Step 3f (E49): once a settlement is frozen at `t0`, re-freezing within `[t0, t0 + maxFreeze)` reverts
    ///         `FreezeOnCooldown` even after early release or self-expiry; a new freeze succeeds only once the
    ///         cooldown expires inside an extended hold.
    function test_fix6_aNewFreezeStartsWithReturnsDisallowed() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        p.minHold = 6 hours;
        p.maxFreeze = 2 hours;
        _setParams(p);

        (uint256 sid,) = _heldDeposit();
        uint64 t0 = uint64(block.timestamp);
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        assertEq(queue.getSettlement(sid).frozenUntil, t0 + p.maxFreeze, "frozen for maxFreeze");

        // Release early inside hold: re-freezing immediately is blocked by cooldown (E49).
        timelockExecute(address(queue), abi.encodeCall(queue.releaseSettlement, (sid)));
        uint64 cooldownEnd = t0 + p.maxFreeze;
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.FreezeOnCooldown.selector, cooldownEnd));
        vm.prank(emergency);
        queue.freezeSettlement(sid);

        // Once cooldown passes while still inside the 6h hold, a fresh freeze succeeds.
        vm.warp(cooldownEnd);
        refreshFeeds();
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        assertEq(
            queue.getSettlement(sid).frozenUntil, cooldownEnd + p.maxFreeze, "second freeze granted"
        );
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
            queue.getRequest(c).closed && queue.requestStatus(d) == RequestStatus.Closed,
            "carol and dave settled"
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

    /// @dev Every owner takes what the queue owes it, whatever settled meanwhile: pending requests before
    ///      `cancelBuffer` are cancelled, post-cutoff remainders (e.g. match dust below `minRequestUsdc`) exit after
    ///      `maxRoll` via `withdrawExpired` / `giveRedemptionNotice`, each settled redemption's USDC is taken, each held
    ///      deposit delivered after its hold, and each credit withdrawn.
    function _everyoneTakesAll(uint256, uint256) internal {
        address[5] memory owners = [alice, bob, carol, dave, erin];
        uint256 n = queue.requestCount();
        uint64 maxExp;
        for (uint256 id = 1; id <= n; ++id) {
            RequestStatus st = queue.requestStatus(id);
            if (st != RequestStatus.Pending && st != RequestStatus.Expired) continue;
            Request memory r = queue.getRequest(id);
            if (st == RequestStatus.Pending) {
                vm.prank(r.owner);
                try queue.cancel(id) {
                    continue;
                } catch {}
            }
            if (r.expiryEpoch > maxExp) maxExp = r.expiryEpoch;
        }
        if (maxExp != 0) {
            FlowParams memory p = queue.flowParams();
            uint64 cur = queue.currentEpoch();
            if (cur <= maxExp) {
                vm.warp(block.timestamp + (uint256(maxExp - cur) + 1) * p.epochLength);
                refreshFeeds();
            }
            bool noticed;
            for (uint256 id = 1; id <= n; ++id) {
                RequestStatus st = queue.requestStatus(id);
                Request memory r = queue.getRequest(id);
                if (st == RequestStatus.Expired) {
                    vm.prank(r.owner);
                    queue.withdrawExpired(id);
                } else if (
                    st == RequestStatus.Pending && r.kind == RequestKind.Redeem
                        && r.noticeRound == 0
                ) {
                    vm.prank(r.owner);
                    queue.giveRedemptionNotice(id);
                    noticed = true;
                }
            }
            if (noticed) {
                vm.warp(block.timestamp + 2 * uint256(p.epochLength) + p.settleWindow);
                refreshFeeds();
                for (uint256 id = 1; id <= n; ++id) {
                    Request memory r = queue.getRequest(id);
                    if (!r.closed && r.kind == RequestKind.Redeem && r.noticeRound != 0) {
                        queue.claimNoticeReturn(id);
                    }
                }
            }
        }
        FlowParams memory fp = queue.flowParams();
        warpForward(block.timestamp + uint256(fp.minHold) + 1);
        refreshFeeds();
        for (uint256 k; k < owners.length; ++k) {
            address u = owners[k];
            uint256 owed = queue.maxRedeem(u);
            if (owed != 0) {
                vm.prank(u);
                queue.redeem(owed, u, u);
            }
            deliverAfterHold(u);
            uint256 mintable = queue.maxMint(u);
            if (mintable != 0) queue.mint(mintable, u);
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

    /// @notice A forward-priced deposit of 200 to 2 000 USDC.
    function act_requestDeposit(uint256 who, uint256 size, uint256) public {
        address u = users[who % users.length];
        size = bound(size, 200e6, 2_000e6);
        refreshFeeds();
        openDepositRequest(u, size);
        coverageCheckpoint();
    }

    /// @notice A forward-priced redemption of 1 % to 5 % of a holder's shares.
    function act_requestRedeem(uint256 who, uint256 bps, bool) public {
        address u = users[who % users.length];
        uint256 shares = fund.balanceOf(u) * bound(bps, 100, 500) / 10_000;
        if (shares == 0) return;
        refreshFeeds();
        openRedeemRequest(u, shares);
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
            if (queue.requestStatus(id) != RequestStatus.Pending) continue;
            Request memory r = queue.getRequest(id);
            vm.prank(r.owner);
            try queue.cancel(id) {
                break;
            } catch {}
        }
        coverageCheckpoint();
    }

    struct Pre {
        uint256[] ids;
        uint256[] remaining;
        bool[] inRange;
        bool[] enrolled;
        uint256 claimCount0;
        uint256 settlementCount0;
        bool keeperCursorOk;
        uint64 kDepE;
        uint256 kDepI;
        uint64 kRedE;
        uint256 kRedI;
    }

    /// @notice `settle` by the keeper (whole budget or 1..8 when `maxReq` small) or a stranger (must revert E34).
    ///         With `wait`, time first passes to the end of the oldest open request's window.
    function act_settle(uint256 callerSeed, uint256 maxReq, bool noRoom, bool wait) public {
        bool isKeeper = callerSeed % 2 == 0;
        address c = isKeeper ? keeper : stranger;
        if (wait) _waitForOldestWindow(false);
        refreshFeeds();
        uint256 maxRequests = isKeeper
            ? (maxReq != 0 && maxReq <= 8 ? maxReq : SETTLE_MAX_REQUESTS)
            : bound(maxReq, 1, 8);
        uint256 maxUsdc = noRoom ? 0 : type(uint256).max;
        Pre memory pre = _pre();
        vm.recordLogs();
        vm.prank(c);
        try queue.settle(maxRequests, maxUsdc) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            if (isKeeper) ++callsSettleKeeper;
            else ++callsSettleStranger;
            _post(pre, isKeeper, maxRequests, noRoom, logs);
        } catch {
            vm.getRecordedLogs();
        }
        coverageCheckpoint();
    }

    /// @notice `act_settle` after waiting for the oldest open request's window.
    function act_settleAfterWindow(uint256 callerSeed, uint256 maxReq, bool noRoom) public {
        act_settle(callerSeed, maxReq, noRoom, true);
    }

    function _waitForOldestWindow(bool) internal {
        uint256 n = queue.requestCount();
        uint64 oldest = type(uint64).max;
        for (uint256 id = 1; id <= n; ++id) {
            if (queue.requestStatus(id) != RequestStatus.Pending) continue;
            Request memory r = queue.getRequest(id);
            if (r.epoch < oldest) oldest = r.epoch;
        }
        if (oldest == type(uint64).max) return;
        warpForward(uint256(queue.settleableAt(oldest)));
    }

    function _liveRem(uint256 id, Request memory r) internal view returns (uint256) {
        if (r.closed) return 0;
        return r.kind == RequestKind.Deposit
            ? queue.pendingDepositRequest(id, r.owner)
            : queue.pendingRedeemRequest(id, r.owner);
    }

    function _pre() internal view returns (Pre memory pre) {
        uint256 n = queue.requestCount();
        pre.ids = new uint256[](n);
        pre.remaining = new uint256[](n);
        pre.inRange = new bool[](n);
        pre.enrolled = new bool[](n);
        pre.claimCount0 = queue.claimCount();
        pre.settlementCount0 = queue.settlementCount();
        for (uint256 k; k < n; ++k) {
            uint256 id = k + 1;
            Request memory r = queue.getRequest(id);
            pre.ids[k] = id;
            pre.enrolled[k] = r.enrolled;
            uint256 rem = _liveRem(id, r);
            pre.remaining[k] = rem;
            if (rem == 0 || queue.requestStatus(id) != RequestStatus.Pending) continue;
            pre.inRange[k] = block.timestamp >= queue.settleableAt(r.epoch);
        }
        (pre.keeperCursorOk, pre.kDepE, pre.kDepI) = _cursor(true, RequestKind.Deposit);
        (, pre.kRedE, pre.kRedI) = _cursor(true, RequestKind.Redeem);
    }

    struct PostFlags {
        bool depFailed;
        bool redFailed;
        bool matched;
        bool depStopped;
        bool newSettlement;
        uint256 minSh;
        uint256 minUsdc;
    }

    function _post(
        Pre memory pre,
        bool isKeeper,
        uint256 maxRequests,
        bool noRoom,
        Vm.Log[] memory logs
    ) internal {
        if (!isKeeper) _violation("E34: non-keeper settled");
        PostFlags memory f;
        f.depFailed = _sideFailures(logs, RequestKind.Deposit) != 0;
        f.redFailed = _sideFailures(logs, RequestKind.Redeem) != 0;
        f.matched = _matchedNow(logs);
        f.depStopped = _depStoppedNow(logs);
        f.newSettlement = queue.settlementCount() > pre.settlementCount0;
        f.minUsdc = queue.flowParams().minRequestUsdc;
        f.minSh = _minShareAmount(f.minUsdc);

        if (noRoom && !f.matched && f.newSettlement) {
            _violation("no room: a call with maxUsdc 0 created a settlement");
        }

        for (uint256 k; k < pre.ids.length; ++k) {
            _checkPostRequest(pre, k, f, maxRequests, noRoom, logs);
        }

        _checkClaimOrder(pre, f.minUsdc, f.minSh);
        keeperMidPass = f.depFailed || f.redFailed;
        if (noRoom) {
            ++callsNoRoom;
            _sameCursor(pre);
        }
    }

    function _minShareAmount(uint256 minUsdc) internal view returns (uint256) {
        uint256 price = 1e18;
        uint256 supply = fund.totalSupply();
        if (supply != 0) {
            try fund.totalAssets() returns (uint256 nav) {
                if (nav != 0) price = nav.mulDiv(1e18, supply);
            } catch {}
        }
        return minUsdc.mulDiv(1e18, price, Math.Rounding.Ceil) + 1;
    }

    function _checkPostRequest(
        Pre memory pre,
        uint256 k,
        PostFlags memory f,
        uint256 maxRequests,
        bool noRoom,
        Vm.Log[] memory logs
    ) internal {
        uint256 id = pre.ids[k];
        Request memory r = queue.getRequest(id);
        uint256 rem = _liveRem(id, r);
        bool enrollDustOnly = !pre.enrolled[k] && r.enrolled && !f.newSettlement
            && rem < pre.remaining[k] && pre.remaining[k] - rem <= 1;
        bool realFill =
            rem < pre.remaining[k] && !(r.closed && _cancelledNow(logs, id)) && !enrollDustOnly;
        if (realFill) {
            ++fillsChecked;
            if (noRoom && !f.matched) {
                _violation("no room: a one-sided call with maxUsdc 0 filled a request");
            }
        } else if (
            !noRoom && maxRequests == SETTLE_MAX_REQUESTS && pre.inRange[k] && pre.remaining[k] != 0
        ) {
            bool isDep = r.kind == RequestKind.Deposit;
            bool failed = isDep ? (f.depFailed || f.depStopped) : f.redFailed;
            if (!failed && !keeperMidPass && (isDep ? rem >= f.minUsdc : rem >= f.minSh)) {
                _violation("oldest first: the keeper left a fillable request pending");
            }
        }
        if (pre.inRange[k] && pre.remaining[k] != 0) ++admissibleChecked;
    }

    function _checkClaimOrder(Pre memory pre, uint256 minUsdc, uint256 minSh) internal {
        uint256 cNow = queue.claimCount();
        for (uint256 cid = pre.claimCount0 + 1; cid <= cNow; ++cid) {
            Claim memory cl = queue.getClaim(cid);
            // Lazy sync on enqueue/enroll can emit a Claim belonging to an earlier match settlement.
            if (cl.settlementId <= pre.settlementCount0) continue;
            Request memory filledReq = queue.getRequest(cl.requestId);
            bool isDep = filledReq.kind == RequestKind.Deposit;
            for (uint256 k; k < pre.ids.length; ++k) {
                uint256 olderId = pre.ids[k];
                if (olderId >= cl.requestId) break;
                if (!pre.inRange[k] || pre.remaining[k] == 0) continue;
                Request memory olderReq = queue.getRequest(olderId);
                if (olderReq.kind != filledReq.kind) continue;
                uint256 olderRem = _liveRem(olderId, olderReq);
                if (isDep ? olderRem >= minUsdc : olderRem >= minSh) {
                    _violation("oldest first: newer request filled ahead of older unfilled request");
                    break;
                }
            }
        }
    }

    function _sameCursor(Pre memory pre) internal {
        if (!pre.keeperCursorOk) return;
        (, uint64 e1, uint256 i1) = _cursor(true, RequestKind.Deposit);
        (, uint64 e2, uint256 i2) = _cursor(true, RequestKind.Redeem);
        if (e1 != pre.kDepE || i1 != pre.kDepI || e2 != pre.kRedE || i2 != pre.kRedI) {
            _violation("no room: a call with maxUsdc 0 moved a cursor");
        }
    }

    function _matchedNow(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 k; k < logs.length; ++k) {
            if (
                logs[k].emitter == address(queue)
                    && logs[k].topics[0] == IFlowEvents.Matched.selector
            ) {
                return true;
            }
        }
        return false;
    }

    function _depStoppedNow(Vm.Log[] memory logs) internal view returns (bool) {
        for (uint256 k; k < logs.length; ++k) {
            if (
                logs[k].emitter == address(queue)
                    && logs[k].topics[0] == IFlowEvents.DepositStoppedForRound.selector
            ) {
                return true;
            }
        }
        return false;
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

    /// @notice The scripted run: FIFO net fills under partial budget, keeper-only enforcement (E34), `maxUsdc = 0`
    ///         leaving cursors unmoved, and `cancel` respecting `cancelBuffer` (E26).
    function test_script_oldestFillableFillsFirst() public fixtureCovered {
        act_requestDeposit(0, 1_000e6, 0); // alice (oldest)
        act_requestDeposit(1, 1_000e6, 0); // bob
        act_requestRedeem(2, 200, false); // carol (~200 shares < 2_000 USDC -> net Deposit)
        act_cancel(1); // bob cancels before cancelBuffer
        uint256 bId = openDepositRequest(bob, 1_000e6);
        vm.warp(block.timestamp + 13 hours); // past window & cancelBuffer
        refreshFeeds();
        act_settle(1, 1, false, false); // stranger: reverts E34 (0 calls)
        assertEq(callsSettleStranger, 0, "E34: stranger never settles");
        act_settle(0, 1, true, false); // keeper, maxUsdc = 0: matches carol only, leaves net & cursor unmoved
        act_settle(0, 1, false, false); // keeper, maxRequests = 1: fills alice (oldest) before bob
        assertTrue(queue.getRequest(1).closed, "oldest deposit fills first");
        assertGt(queue.pendingDepositRequest(bId, bob), 0, "newer deposit waits behind budget=1");
        act_settle(0, 0, false, false); // keeper, full budget: fills bob
        assertTrue(queue.getRequest(bId).closed, "bob fills next");
        act_requestDeposit(3, 1_000e6, 0); // open deposit before cancelBuffer
        act_cancel(0); // cancels open request before cutoff
        _assertNoViolation();
    }
}
