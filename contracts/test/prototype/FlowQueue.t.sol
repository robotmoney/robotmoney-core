// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md §4.2 (FlowQueue.t.sol: the mechanism), E3, E4, E8 to E23;
//            docs/technical/one-vault-rebalancer-proposal.md §5.9.2 (an epoch), §5.9.3 (the twelve steps of one
//            settlement), §5.9.4 (exits and emergency powers), §5.9.5 (defaults), §7 (RB-10 to RB-18, RB-20 to RB-22);
//            coordinator rulings 1 to 10 (2026-11-11); scaffold plan §7.6 (mechanism-tests)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {Vm} from "forge-std/Vm.sol";
import {IAavePool} from "../../interfaces/IAavePool.sol";
import {IObservablePool} from "../../interfaces/IObservablePool.sol";
import {IStrategyAdapter} from "../../interfaces/IStrategyAdapter.sol";
import {AaveV3Adapter} from "../../adapters/AaveV3Adapter.sol";
import {PrototypeHarness, IHarnessV3Pool} from "./PrototypeHarness.sol";
import {
    AssetConfig, BPS, FeedStatus, IDLE_INDEX, IFundEvents, LENDING_ROUNDING_UNITS, PRICE_SCALE, PlanParams, Roles
} from "./src/FundTypes.sol";
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
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {IAavePoolRate} from "./src/adapters/AaveV3RateAdapter.sol";
import {FundExclusionLedger} from "./src/FundExclusionLedger.sol";
import {FundValuationLib} from "./src/lib/FundValuationLib.sol";
import {FeedLib} from "./src/lib/FeedLib.sol";
import {TwapSlicesLib} from "./src/lib/TwapSlicesLib.sol";
import {TwapTickMath} from "../../lib/TwapTickMath.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MechAaveAdapter} from "./mocks/MechAaveAdapter.sol";
import {MechReentry} from "./mocks/MechReentry.sol";
import {MechSwapAdapter} from "./mocks/MechSwapAdapter.sol";

/// @notice Shared state and helpers of the mechanism tests. Everything runs on the harness deployment (real Base
///         pools and venues from the replay fixture, mock aggregators at the real feed addresses, the FlowQueue with
///         the §5.9.5 defaults, the fund seeded with `SEED_USDC`).
///
///         House rules of this file:
///         - Every test carries `fixtureCovered`. Until the fixture is re-recorded every test that moves USDC into the
///           queue stops at `FixtureSlotMiss` on the queue's USDC balance slot (integrate's note): a provenance miss,
///           not a logic failure. The recorder runs this file on the fork, so the re-record covers it. Nothing here
///           is skipped for a fixture miss, because a skipped test would leave its slots out of the re-record.
///         - No market price, amount out or block number is hard-coded: every check is a relationship.
///         - A check is tripped with the mock aggregators, a pool trade by the test, a mocked venue call or a `Mech*`
///           venue mock. None of them makes a check pass.
abstract contract FlowQueueBase is PrototypeHarness {
    using Math for uint256;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal erin = makeAddr("erin");
    address internal stranger = makeAddr("stranger");

    /// @dev Chunk of USDC per pool trade when a test pushes a pool to a target move.
    uint256 internal constant PUSH_CHUNK_USDC = 200_000e6;

    uint256 private _mechSalt;

    // Two-sided setup state (`_twoSidedSetup`): a pending deposit (alice) and a pending redemption (bob, half his
    // shares) in the same epoch, at the end of that epoch's window.
    uint256 internal _depId;
    uint256 internal _redId;
    uint256 internal _bobShares;

    /// @dev Queue-side state compared before and after an action.
    struct QueueSnap {
        uint256 usdc;
        uint256 shares;
        FlowBooks books;
        uint256 settlements;
        uint256 claims;
        uint256 requests;
    }

    /// @dev Fund-side state compared before and after an action in the same block.
    struct FundSnap {
        uint256 supply;
        uint256 idle;
        uint256[] held;
        uint256 feeUsdc;
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Settling
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice `settle` as the keeper now, with the feeds as they are (a test that broke a feed must not refresh).
    function _keeperSettle() internal returns (uint256) {
        vm.prank(keeper);
        return queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
    }

    /// @notice The keeper settles once per block (a block every 2 s, as on Base) until request `id` is filled: the
    ///         per-call basket cap (`FlowLevers.basketCallBps`, 5 bps of each pool's depth by default since 2026-11-12)
    ///         is a budget per block, so it splits a large flow over blocks. Every part keeps every amount per share.
    function _settleOverBlocks(uint256 id, string memory label) internal {
        uint256 settled;
        for (uint256 k; k < 64 && !queue.getRequest(id).closed; ++k) {
            vm.roll(block.number + 1);
            if (k != 0) vm.warp(block.timestamp + 2);
            // The fixture coverage check per few parts: one state diff over many parts overruns forge's memory.
            if (k % 4 == 3) coverageCheckpoint();
            FundSnap memory part = _fundSnap();
            if (_keeperSettle() != 0) {
                ++settled;
                _assertPerShareNotLower(part, string.concat(label, ": each part"));
            }
        }
        assertGt(settled, 0, label);
    }

    /// @notice Refresh the feeds, then `settle` as the keeper.
    function _settleNow() internal returns (uint256) {
        refreshFeeds();
        return _keeperSettle();
    }

    /// @notice A low-level `settle` by `caller`, so a test can read the revert data.
    function _trySettle(address caller, uint256 maxRequests, uint256 maxUsdc)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(caller);
        (ok, ret) = address(queue).call(abi.encodeCall(queue.settle, (maxRequests, maxUsdc)));
    }

    /// @notice `settle` by `caller` must revert `SettleBlocked(check, index, ·)`. Returns the detail.
    function _expectBlocked(address caller, SettleCheck check, uint256 index) internal returns (uint256 detail) {
        (bool ok, bytes memory ret) = _trySettle(caller, SETTLE_MAX_REQUESTS, type(uint256).max);
        assertFalse(ok, "settle must revert");
        SettleCheck got;
        uint256 i;
        (got, i, detail) = _decodeBlocked(ret);
        assertEq(uint8(got), uint8(check), "the failing check");
        assertEq(i, index, "the failing asset index");
    }

    /// @notice Decode `SettleBlocked(check, index, detail)` revert data.
    function _decodeBlocked(bytes memory ret) internal pure returns (SettleCheck check, uint256 index, uint256 detail) {
        require(ret.length == 100 && _selector(ret) == IFlowEvents.SettleBlocked.selector, "not SettleBlocked");
        (check, index, detail) = abi.decode(_args(ret), (SettleCheck, uint256, uint256));
    }

    /// @notice The first four bytes of `data` (0 when shorter).
    function _selector(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return bytes4(0);
        assembly {
            sel := and(mload(add(data, 32)), shl(224, 0xffffffff))
        }
    }

    /// @notice `data` without its selector.
    function _args(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 k; k < out.length; ++k) {
            out[k] = data[k + 4];
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Users
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice `user` deposits `usdc` through the whole timed path (request, settle, hold, delivery) and takes its
    ///         credit, so it ends as a plain holder of the returned shares.
    function _holder(address user, uint256 usdc) internal returns (uint256 shares) {
        shares = deposit(user, usdc);
        (uint256 credit,) = queue.creditOf(user);
        if (credit != 0) {
            vm.prank(user);
            queue.withdrawCredit();
        }
    }

    /// @notice The default invested fund: a 1-day plan to stable 65 % / protocol 35 %, so every flow trades every
    ///         listed asset.
    function _invest() internal {
        investFund(bucketVec(6_500, 3_500));
    }

    /// @notice The fund holds a non-zero amount of every active asset (`hardening`, 2026-11-12): a test whose
    ///         subject is a trade of every asset asserts its own precondition, so a plan that stepped nothing (every
    ///         step skipped) fails here instead of passing on an idle-only fund.
    function _assertInvested(string memory label) internal view {
        (, uint256[] memory held) = fund.heldBalances();
        for (uint256 i; i < held.length; ++i) {
            if (!fund.assetConfig(i).active) continue;
            assertGt(held[i], 0, string.concat(label, ": the plan invested in every active asset"));
        }
    }

    /// @notice An invested fund (vector `v`), bob holding shares, then in one epoch alice's deposit request (any
    ///         price) and bob's redemption request for half his shares (any price); warp to the end of that
    ///         epoch's window and refresh the feeds.
    function _twoSidedSetup(uint16[5] memory v) internal {
        investFund(v);
        _bobShares = _holder(bob, 50_000e6);
        coverageCheckpoint();
        _redId = openRedeemRequest(bob, _bobShares / 2, 0);
        _depId = openDepositRequest(alice, 20_000e6, type(uint256).max);
        warpToSettleable(_depId);
        refreshFeeds();
    }

    /// @notice A pending deposit request of alice at the end of its window, feeds fresh.
    function _pendingAtWindow() internal returns (uint256 id) {
        id = openDepositRequest(alice, 5_000e6, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Snapshots and invariants
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _queueSnap() internal view returns (QueueSnap memory s) {
        s.usdc = IERC20(USDC).balanceOf(address(queue));
        s.shares = fund.balanceOf(address(queue));
        s.books = queue.books();
        s.settlements = queue.settlementCount();
        s.claims = queue.claimCount();
        s.requests = queue.requestCount();
    }

    function _fundSnap() internal view returns (FundSnap memory s) {
        s.supply = fund.totalSupply();
        (s.idle, s.held) = fund.heldBalances();
        s.feeUsdc = IERC20(USDC).balanceOf(feeRecipient);
    }

    function _assertQueueSame(QueueSnap memory a, QueueSnap memory b, string memory label) internal pure {
        assertEq(b.usdc, a.usdc, string.concat(label, ": queue USDC"));
        assertEq(b.shares, a.shares, string.concat(label, ": queue shares"));
        assertEq(b.books.pendingUsdc, a.books.pendingUsdc, string.concat(label, ": pending USDC"));
        assertEq(b.books.owedUsdc, a.books.owedUsdc, string.concat(label, ": owed USDC"));
        assertEq(b.books.creditUsdc, a.books.creditUsdc, string.concat(label, ": credit USDC"));
        assertEq(b.books.dustUsdc, a.books.dustUsdc, string.concat(label, ": dust USDC"));
        assertEq(b.books.escrowShares, a.books.escrowShares, string.concat(label, ": escrow shares"));
        assertEq(b.books.heldShares, a.books.heldShares, string.concat(label, ": held shares"));
        assertEq(b.books.creditShares, a.books.creditShares, string.concat(label, ": credit shares"));
        assertEq(b.books.dustShares, a.books.dustShares, string.concat(label, ": dust shares"));
        assertEq(b.settlements, a.settlements, string.concat(label, ": settlements"));
        assertEq(b.claims, a.claims, string.concat(label, ": claims"));
        assertEq(b.requests, a.requests, string.concat(label, ": requests"));
    }

    function _assertFundSame(FundSnap memory a, FundSnap memory b, string memory label) internal pure {
        assertEq(b.supply, a.supply, string.concat(label, ": supply"));
        assertEq(b.idle, a.idle, string.concat(label, ": idle"));
        assertEq(b.held.length, a.held.length, string.concat(label, ": asset count"));
        for (uint256 i; i < a.held.length; ++i) {
            assertEq(b.held[i], a.held[i], string.concat(label, ": held"));
        }
        assertEq(b.feeUsdc, a.feeUsdc, string.concat(label, ": fee recipient"));
    }

    /// @notice Check 10 seen from outside: no held amount per share (idle and every asset) fell since `s`.
    function _assertPerShareNotLower(FundSnap memory s, string memory label) internal view {
        (uint256 idle1, uint256[] memory held1) = fund.heldBalances();
        uint256 supply1 = fund.totalSupply();
        assertGe(idle1 * s.supply, s.idle * supply1, string.concat(label, ": idle per share"));
        for (uint256 i; i < s.held.length; ++i) {
            assertGe(held1[i] * s.supply, s.held[i] * supply1, string.concat(label, ": asset per share"));
        }
    }

    /// @notice The queue's books (eng plan §4.3): with no gift, its USDC and share balances equal the sums.
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

    /// @notice RB-14 from the claims: every claim with id above `afterClaimId` is inside its request's limit.
    function _assertClaimsInsideLimits(uint256 afterClaimId) internal view {
        uint256 n = queue.claimCount();
        for (uint256 c = afterClaimId + 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            Request memory r = queue.getRequest(cl.requestId);
            if (cl.kind == RequestKind.Deposit) {
                assertLe(cl.usdc.mulDiv(PRICE_SCALE, cl.shares, Math.Rounding.Ceil), r.limit, "RB-14: deposit fill");
            } else {
                assertGe(cl.usdc.mulDiv(PRICE_SCALE, cl.shares), r.limit, "RB-14: redemption fill");
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Logs
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice How many `SideFailed` logs of side `kind` are in `logs`, and the revert selector of the last one.
    function _sideFailed(Vm.Log[] memory logs, RequestKind kind) internal view returns (uint256 n, bytes4 reason) {
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter != address(queue) || logs[k].topics[0] != IFlowEvents.SideFailed.selector) continue;
            (RequestKind got, bytes memory why) = abi.decode(logs[k].data, (RequestKind, bytes));
            if (got != kind) continue;
            ++n;
            reason = _selector(why);
        }
    }

    /// @notice The revert data inside the last `SideFailed` log of side `kind`.
    function _sideFailedData(Vm.Log[] memory logs, RequestKind kind) internal view returns (bytes memory why) {
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter != address(queue) || logs[k].topics[0] != IFlowEvents.SideFailed.selector) continue;
            (RequestKind got, bytes memory w) = abi.decode(logs[k].data, (RequestKind, bytes));
            if (got == kind) why = w;
        }
    }

    /// @notice Whether `logs` holds a `RequestSkipped` for `requestId`.
    function _skipped(Vm.Log[] memory logs, uint256 requestId) internal view returns (bool) {
        for (uint256 k; k < logs.length; ++k) {
            if (
                logs[k].emitter == address(queue) && logs[k].topics[0] == IFlowEvents.RequestSkipped.selector
                    && uint256(logs[k].topics[1]) == requestId
            ) return true;
        }
        return false;
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Market, venues, governance
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Trade `pool` in chunks until `token`'s price moved at least `bps` up or down. Returns the move.
    function _pushPool(address pool, address token, uint256 bps, bool up) internal returns (uint256 movedBps) {
        uint256 p0 = poolPrice8(pool, token);
        for (uint256 k; k < 100; ++k) {
            movePrice(pool, PUSH_CHUNK_USDC, up);
            uint256 p = poolPrice8(pool, token);
            movedBps = (p > p0 ? p - p0 : p0 - p) * BPS / p0;
            if (movedBps >= bps) return movedBps;
        }
        revert("pushPool: the pool did not move far enough");
    }

    /// @notice Place a `MechSwapAdapter` (honest mode) over the harness's exact-output swap adapter. The basket
    ///         assets are counted whatever their adapter's code hash, so nothing else changes.
    function _etchSwapMech() internal returns (MechSwapAdapter m) {
        MechSwapAdapter impl = new MechSwapAdapter(ROUTER);
        vm.etch(address(swapAdapter), address(impl).code);
        m = MechSwapAdapter(address(swapAdapter));
    }

    /// @notice Place a `MechAaveAdapter` (honest mode) over the harness's Aave rate adapter, after allowlisting its
    ///         code hash through the timelock so Aave stays counted (ADP-2). Warps `TIMELOCK_DELAY`.
    function _etchAaveMech() internal returns (MechAaveAdapter m) {
        MechAaveAdapter impl = new MechAaveAdapter(AAVE_POOL, USDC, AAVE_A_USDC, address(fund));
        timelockExecute(address(fund), abi.encodeCall(fund.setAdapterCodeHashAllowed, (address(impl).codehash, true)));
        vm.etch(address(aaveAdapter), address(impl).code);
        m = MechAaveAdapter(address(aaveAdapter));
        assertEq(fund.openExclusionOf(IDX_AAVE), 0, "the mock venue is still counted");
    }

    /// @notice Schedule `data` on `target` in the timelock, warp the delay, and expect `execute` to revert `err`.
    function _timelockExpectRevert(address target, bytes memory data, bytes memory err) internal {
        bytes32 salt = keccak256(abi.encode("mechanism-tests", ++_mechSalt));
        timelock.schedule(target, 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        vm.expectRevert(err);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    /// @notice The per-leg limits and the USDC a FLOW_ROLE caller hands `mintInKind` for `n` new shares: each
    ///         basket leg at twice its TWAP value plus one USDC, lending and idle at their exact parts plus the margin.
    function _buyLimits(uint256 n) internal view returns (uint256[] memory legs, uint256 maxUsdc) {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        uint256 supply = fund.totalSupply();
        legs = new uint256[](held.length);
        maxUsdc = idle.mulDiv(n, supply, Math.Rounding.Ceil);
        for (uint256 i; i < held.length; ++i) {
            uint256 want = held[i].mulDiv(n, supply, Math.Rounding.Ceil);
            if (isBasketIndex(i)) {
                legs[i] = fund.assetUsdcValue(i, want) * 2 + 1e6;
                maxUsdc += legs[i];
            } else {
                maxUsdc += want + LENDING_ROUNDING_UNITS;
            }
        }
    }

    /// @notice Pays the pool for a test-minted Uniswap V3 position (RB-17 liquidity test).
    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes calldata) external {
        IHarnessV3Pool pool = IHarnessV3Pool(msg.sender);
        _payPool(pool.token0(), amount0);
        _payPool(pool.token1(), amount1);
    }

    function _payPool(address token, uint256 amount) private {
        if (amount == 0) return;
        if (token == USDC) fundUsdc(msg.sender, amount);
        else deal(token, msg.sender, IERC20(token).balanceOf(msg.sender) + amount);
    }
}

/// @title FlowQueueTest
/// @notice Eng plan §4.2, bullet by bullet, against the wired harness. Each section names its bullet. Proposal
///         §5.9.3 checks 1 to 6 have one test per way to trip them, each tripping that check alone (the checks before
///         it pass, and the test shows nothing settles). Check 10 is tested under RB-13; steps 7 and 12 are actions
///         that cannot fail on their own (eng plan §4.2).
contract FlowQueueTest is FlowQueueBase {
    using Math for uint256;

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-10 and RB-11
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-10: before the epoch's window ends nothing leaves the queue: no settlement, no claim, no expiry
    ///         withdrawal, at the epoch's close or one second before the window ends. At the window's end the keeper
    ///         settles.
    function test_RB10_nothingLeavesTheQueueBeforeTheWindowEnds() public fixtureCovered {
        uint256 bobShares = _holder(bob, 20_000e6);
        uint256 dep = openDepositRequest(alice, 5_000e6, type(uint256).max);
        uint256 red = openRedeemRequest(bob, bobShares, 0);
        Request memory r = queue.getRequest(dep);
        uint256 windowEnd = queue.settleableAt(r.epoch);
        uint256 epochEnd = (uint256(r.epoch) + 1) * queue.flowParams().epochLength;
        QueueSnap memory s0 = _queueSnap();
        uint256[3] memory times = [block.timestamp, epochEnd, windowEnd - 1];
        for (uint256 k; k < times.length; ++k) {
            warpForward(times[k]);
            refreshFeeds();
            _expectBlocked(keeper, SettleCheck.Window, IDLE_INDEX);
            _expectBlocked(stranger, SettleCheck.Window, IDLE_INDEX);
            vm.prank(stranger);
            vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
            queue.mint(1, alice);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
            queue.deposit(1, alice);
            vm.prank(bob);
            vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
            queue.redeem(1, bob, bob);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestNotExpired.selector, dep));
            queue.withdrawExpired(dep);
            vm.prank(bob);
            vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestNotExpired.selector, red));
            queue.withdrawExpired(red);
            _assertQueueSame(s0, _queueSnap(), "before the window ends");
        }
        vm.warp(windowEnd);
        uint256 sid = _settleNow();
        assertEq(sid, 1 + s0.settlements, "the keeper settles at the window's end");
        assertEq(queue.getSettlement(sid).time, windowEnd, "settled exactly at the window's end");
        _assertBooks("RB-10");
    }

    /// @notice RB-10: the three exceptions (cancel, in-kind exit, withdrawal of expired escrow) each pay only the
    ///         request's owner, and only what that request held.
    function test_RB10_theExceptionsPayOnlyThatUser() public fixtureCovered {
        uint256 bobShares = _holder(bob, 20_000e6);
        uint256 carolShares = _holder(carol, 20_000e6);
        uint256 dep = openDepositRequest(alice, 5_000e6, type(uint256).max);
        uint256 red = openRedeemRequest(bob, bobShares / 2, 0);
        uint256 never = openRedeemRequest(carol, carolShares / 2, type(uint256).max);

        // Cancel: the escrow becomes alice's credit; only alice pulls it.
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotRequestOwner.selector, dep, dave));
        queue.cancel(dep);
        uint256 queueUsdc = IERC20(USDC).balanceOf(address(queue));
        vm.prank(alice);
        queue.cancel(dep);
        assertEq(IERC20(USDC).balanceOf(address(queue)), queueUsdc, "cancel pays nothing out: a credit");
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NothingToWithdraw.selector, dave));
        queue.withdrawCredit();
        vm.prank(alice);
        (uint256 u,) = queue.withdrawCredit();
        assertEq(u, 5_000e6, "alice pulls exactly her escrow");
        assertEq(IERC20(USDC).balanceOf(alice), 5_000e6, "to alice");
        assertEq(IERC20(USDC).balanceOf(address(queue)), queueUsdc - 5_000e6, "nothing else left the queue");

        // In-kind exit: bob's escrowed shares leave through the fund, every leg to bob.
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotRequestOwner.selector, red, dave));
        queue.exitInKind(red);
        uint256 queueShares = fund.balanceOf(address(queue));
        uint256 bobUsdc = IERC20(USDC).balanceOf(bob);
        uint256 others = IERC20(USDC).balanceOf(alice) + IERC20(USDC).balanceOf(carol) + IERC20(USDC).balanceOf(dave);
        vm.prank(bob);
        queue.exitInKind(red);
        assertEq(fund.balanceOf(address(queue)), queueShares - bobShares / 2, "only bob's escrow left");
        assertGt(IERC20(USDC).balanceOf(bob), bobUsdc, "bob got his slice");
        assertEq(
            IERC20(USDC).balanceOf(alice) + IERC20(USDC).balanceOf(carol) + IERC20(USDC).balanceOf(dave),
            others,
            "nobody else was paid"
        );

        // Expired escrow: carol's after maxRoll epochs, to carol only.
        Request memory r = queue.getRequest(never);
        FlowParams memory p = queue.flowParams();
        vm.warp((uint256(r.epoch) + p.maxRoll + 1) * p.epochLength);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotRequestOwner.selector, never, dave));
        queue.withdrawExpired(never);
        uint256 carolBefore = fund.balanceOf(carol);
        vm.prank(carol);
        uint256 got = queue.withdrawExpired(never);
        assertEq(got, carolShares / 2, "exactly the escrow");
        assertEq(fund.balanceOf(carol), carolBefore + carolShares / 2, "to carol");
        assertEq(fund.balanceOf(dave), 0, "nobody else");
        _assertBooks("RB-10 exceptions");
    }

    /// @notice RB-11: shares from a deposit stay in the queue until `settle time + minHold` (no delivery, cancel or
    ///         return in the hold), then anyone may trigger their delivery, and they go only to the request's owner.
    function test_RB11_depositSharesStayForMinHoldAndGoOnlyToTheOwner() public fixtureCovered {
        uint256 id = _pendingAtWindow();
        uint256 sid = _keeperSettle();
        uint256 claimId = queue.claimCount();
        Claim memory c = queue.getClaim(claimId);
        assertEq(c.owner, alice, "claim owner");
        assertEq(uint256(c.unlockAt), block.timestamp + queue.flowParams().minHold, "unlock at settle + minHold");

        vm.warp(uint256(c.unlockAt) - 1);
        refreshFeeds();
        assertEq(queue.maxMint(alice), 0, "nothing deliverable in the hold");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
        queue.mint(1, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, c.usdc, 0));
        queue.deposit(c.usdc, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestNotPending.selector, id));
        queue.cancel(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.ReturnNotAllowed.selector, sid));
        queue.takeReturn(claimId);
        assertEq(fund.balanceOf(alice), 0, "no share left the queue in the hold");

        vm.warp(c.unlockAt);
        refreshFeeds();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, c.shares, 0));
        queue.mint(c.shares, stranger);
        vm.prank(stranger);
        uint256 got = queue.deposit(c.usdc, alice);
        assertEq(got, c.shares, "every share of the claim");
        assertEq(fund.balanceOf(alice), c.shares, "delivered to the owner");
        assertEq(fund.balanceOf(stranger), 0, "the caller receives nothing");
        _assertBooks("RB-11");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-12
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-12: a blocked settlement trades nothing, and no role can settle past the failed check: the keeper,
    ///         a stranger after `keeperGrace`, the emergency key, the fund, and the admin through the timelock all get
    ///         the same `SettleBlocked`. Restoring the one broken input is all the keeper then needs.
    function test_RB12_aBlockedSettlementTradesNothingAndNoRoleSettlesPastIt() public fixtureCovered {
        _invest();
        uint256 bobShares = _holder(bob, 20_000e6);
        uint256 dep = openDepositRequest(alice, 5_000e6, type(uint256).max);
        openRedeemRequest(bob, bobShares / 2, 0);
        warpForward(queue.settleableAt(queue.getRequest(dep).epoch) + queue.flowParams().keeperGrace);
        refreshFeeds();
        setUsdcFeedPrice(0.99e8); // check 2: USDC 100 bps off its peg

        QueueSnap memory q0 = _queueSnap();
        FundSnap memory f0 = _fundSnap();
        address[5] memory callers = [keeper, stranger, emergency, address(fund), address(timelock)];
        for (uint256 k; k < callers.length; ++k) {
            uint256 detail = _expectBlocked(callers[k], SettleCheck.UsdcPeg, IDLE_INDEX);
            assertEq(detail, 0.99e8, "the USDC price that blocked");
        }
        _assertFundSame(f0, _fundSnap(), "blocked: fund");
        _timelockExpectRevert(
            address(queue),
            abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max)),
            abi.encodeWithSelector(IFlowEvents.SettleBlocked.selector, SettleCheck.UsdcPeg, IDLE_INDEX, 0.99e8)
        );
        _assertQueueSame(q0, _queueSnap(), "blocked: queue");

        setUsdcFeedPrice(1e8);
        refreshFeeds();
        uint256 sid = _keeperSettle();
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.sharesMinted, 0, "deposits settle once the peg is back");
        assertGt(st.sharesBurned, 0, "redemptions settle once the peg is back");
    }

    /// @notice RB-12: cancel and expiry return exactly the escrow not yet filled, also after a partial fill.
    function test_RB12_cancelAndExpiryReturnExactlyTheUnfilledEscrow() public fixtureCovered {
        // A request the period cap fills in part (E20), then cancelled: the credit grows by exactly what is left.
        uint256 a = openDepositRequest(alice, 400_000e6, type(uint256).max);
        warpToSettleable(a);
        _settleNow();
        Request memory ra = queue.getRequest(a);
        assertGt(ra.remaining, 0, "a part is left");
        assertLt(ra.remaining, ra.amount, "a part filled");
        (uint256 credit0,) = queue.creditOf(alice);
        vm.prank(alice);
        queue.cancel(a);
        (uint256 credit1,) = queue.creditOf(alice);
        assertEq(credit1 - credit0, ra.remaining, "cancel: exactly the unfilled USDC");
        vm.prank(alice);
        (uint256 u,) = queue.withdrawCredit();
        assertEq(u, credit1, "pulled");

        // Another one filled in part, then left to expire: withdrawExpired pays exactly what is left.
        uint256 b = openDepositRequest(bob, 400_000e6, type(uint256).max);
        warpToSettleable(b);
        _settleNow();
        Request memory rb = queue.getRequest(b);
        assertGt(rb.remaining, 0, "b: a part is left");
        assertLt(rb.remaining, rb.amount, "b: a part filled");
        FlowParams memory p = queue.flowParams();
        vm.warp((uint256(rb.epoch) + p.maxRoll + 1) * p.epochLength);
        refreshFeeds();
        assertEq(uint8(queue.requestStatus(b)), uint8(RequestStatus.Expired), "expired");
        assertEq(queue.pendingDepositRequest(b, bob), 0, "no longer pending");
        _expectBlocked(keeper, SettleCheck.Window, IDLE_INDEX); // an expired request cannot fill
        uint256 before = IERC20(USDC).balanceOf(bob);
        vm.prank(bob);
        uint256 got = queue.withdrawExpired(b);
        assertEq(got, rb.remaining, "expiry: exactly the unfilled USDC");
        assertEq(IERC20(USDC).balanceOf(bob) - before, rb.remaining, "to bob");

        // A redemption request that never filled: exactly its escrowed shares.
        uint256 bobShares = deliverAfterHold(bob);
        uint256 c = openRedeemRequest(bob, bobShares, type(uint256).max);
        Request memory rc = queue.getRequest(c);
        vm.warp((uint256(rc.epoch) + p.maxRoll + 1) * p.epochLength);
        vm.prank(bob);
        assertEq(queue.withdrawExpired(c), bobShares, "expiry: exactly the escrowed shares");
        assertEq(fund.balanceOf(bob), bobShares, "bob has them back");
        _assertBooks("RB-12");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-13 (and check 10)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-13: after a settlement of both sides, the amount of idle USDC and of every active asset per share
    ///         is at least what it was before.
    function test_RB13_aSettlementKeepsEveryAmountPerShare() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        FundSnap memory f0 = _fundSnap();
        uint256 sid = _keeperSettle();
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.sharesMinted, 0, "deposit side traded");
        assertGt(st.sharesBurned, 0, "redemption side traded");
        _assertPerShareNotLower(f0, "both sides");
        _assertBooks("RB-13");
    }

    /// @notice RB-13 as a fuzz test over the ratio (the deposit's and the redemption's size against the fund) and
    ///         the holdings (the plan's stable/protocol split). Each run invests, settles a deposit, then a redemption,
    ///         and checks every amount per share after each settlement.
    ///         The seed is fixed so the recorder's fork run and every replay draw the same inputs: a replay with other
    ///         inputs could touch pool slots the re-recorded fixture never saw. The dictionary is off for the same
    ///         reason (`verify`): forge seeds it from the state loaded at setUp, which is the whole fixture in replay
    ///         and only the fetched slots on the fork, so with it on the two modes would draw different inputs.
    ///         `hardening` (step 3 plan §3.3 item 3): 256 runs (was 6). The variant with an unfixed seed is
    ///         `FlowQueueRandomSeedFuzzTest.testFuzz_RB13_unfixedSeed_depositThenRedeemKeepsEveryAmountPerShare`.
    /// forge-config: default.fuzz.runs = 256
    /// forge-config: default.fuzz.seed = "0x6d656368616e69736d"
    /// forge-config: default.fuzz.dictionary-weight = 0
    function testFuzz_RB13_everySettlementKeepsEveryAmountPerShare(uint16 stableBps, uint256 usdc, uint256 redeemBps)
        public
        fixtureCovered
    {
        stableBps = uint16(bound(stableBps, 2_000, 9_000));
        usdc = bound(usdc, 100e6, 250_000e6);
        redeemBps = bound(redeemBps, 1, BPS);
        investFund(bucketVec(stableBps, uint16(BPS) - stableBps));
        _assertInvested("fuzz");
        // A heavy basket target makes the fund's own plan move its pools (70 bps on wETH at stable 20 %), past
        // check 4's band from the feeds held at the pin price (integrate's G9 note). Check 4 is not this test's
        // subject: model an outside market that caught up with the pools.
        alignFeedsToPools();
        coverageCheckpoint();

        uint256 id = openDepositRequest(alice, usdc, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
        FundSnap memory f0 = _fundSnap();
        _settleOverBlocks(id, "fuzz: the deposit settled");
        assertTrue(queue.getRequest(id).closed, "deposit filled");
        _assertPerShareNotLower(f0, "fuzz deposit");
        coverageCheckpoint();
        // The same market model after the deposit (`hardening`, 2026-11-12): at 256 runs the fuzz draws a 250,000
        // USDC deposit into an 80 % basket fund, whose own purchase moves the wETH pool 57 bps from a feed that did
        // not move, and check 4 then blocks the redemption (`SettleBlocked(TwapVsFeed, wETH, 57)`; a G9 data point,
        // not this test's subject). The outside market catches up before the redemption.
        alignFeedsToPools();

        uint256 shares = deliverAfterHold(alice);
        uint256 x = shares.mulDiv(redeemBps, BPS);
        (uint256 nav,) = fund.lastGoodNav();
        if (x == 0 || x.mulDiv(nav, fund.totalSupply()) < queue.flowParams().minRequestUsdc) x = shares;
        uint256 r = openRedeemRequest(alice, x, 0);
        warpToSettleable(r);
        refreshFeeds();
        f0 = _fundSnap();
        _settleOverBlocks(r, "fuzz: the redemption settled");
        assertTrue(queue.getRequest(r).closed, "redemption filled");
        _assertPerShareNotLower(f0, "fuzz redemption");
        _assertBooks("fuzz");
    }

    /// @notice RB-13: a purchase of the wrong amount is refused inside the fund. The venue under-delivers 1 % of each
    ///         basket purchase (`MechSwapAdapter.UNDER_DELIVER`), which is what a fund copy buying the wrong amount
    ///         looks like from the fund's books. A direct `mintInKind` reverts `ProportionViolated`; through the queue
    ///         the deposit side fails, changes nothing and stays pending.
    function test_RB13_aWrongPurchaseAmountRevertsInsideTheFund() public fixtureCovered {
        _invest();
        MechSwapAdapter mech = _etchSwapMech();
        mech.setMode(mech.UNDER_DELIVER(), 100);

        address rogue = makeAddr("rogue");
        vm.prank(address(queue));
        IAccessControl(address(fund)).grantRole(Roles.FLOW_ROLE, rogue);
        uint256 n = fund.totalSupply() / 100;
        (uint256[] memory legs, uint256 maxUsdc) = _buyLimits(n);
        fundUsdc(rogue, maxUsdc);
        vm.prank(rogue);
        IERC20(USDC).approve(address(fund), maxUsdc);
        FundSnap memory f0 = _fundSnap();
        vm.prank(rogue);
        (bool ok, bytes memory ret) = address(fund).call(abi.encodeCall(fund.mintInKind, (n, maxUsdc, legs)));
        assertFalse(ok, "a short purchase cannot mint");
        assertEq(_selector(ret), IRobotMoneyFund.ProportionViolated.selector, "refused by check 10 inside the fund");
        (uint256 index,,,,) = abi.decode(_args(ret), (uint256, uint256, uint256, uint256, uint256));
        assertEq(index, IDX_WETH, "the first basket leg that came up short");
        _assertFundSame(f0, _fundSnap(), "nothing changed");

        uint256 id = openDepositRequest(alice, 20_000e6, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
        f0 = _fundSnap();
        QueueSnap memory q0 = _queueSnap();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        (uint256 fails, bytes4 why) = _sideFailed(vm.getRecordedLogs(), RequestKind.Deposit);
        assertEq(sid, 0, "nothing traded, nothing recorded");
        assertEq(fails, 1, "the deposit side failed");
        assertEq(why, IRobotMoneyFund.ProportionViolated.selector, "inside the fund");
        _assertFundSame(f0, _fundSnap(), "through the queue: fund unchanged");
        _assertQueueSame(q0, _queueSnap(), "through the queue: queue unchanged");
        assertEq(queue.getRequest(id).remaining, 20_000e6, "the deposit stays pending");
    }

    /// @notice RB-13: a caller holding FLOW_ROLE that skips every queue check (no bound price, wide-open or zero leg
    ///         limits, any size) still cannot lower any amount per share: the fund buys or sells the exact slice
    ///         itself and asserts check 10, or the call reverts and changes nothing.
    function test_RB13_aFlowRoleCallerThatSkipsItsChecksCannotBreakTheProportion() public fixtureCovered {
        _invest();
        address rogue = makeAddr("rogue");
        vm.prank(address(queue));
        IAccessControl(address(fund)).grantRole(Roles.FLOW_ROLE, rogue);

        // An odd-sized mint with every leg limit wide open.
        uint256 n = fund.totalSupply() / 7 + 12_345;
        (uint256[] memory legs, uint256 maxUsdc) = _buyLimits(n);
        fundUsdc(rogue, maxUsdc);
        vm.startPrank(rogue);
        IERC20(USDC).approve(address(fund), maxUsdc);
        FundSnap memory f0 = _fundSnap();
        fund.mintInKind(n, maxUsdc, legs);
        _assertPerShareNotLower(f0, "rogue mint");

        // Too little USDC for the slice: refused, nothing moves.
        f0 = _fundSnap();
        IERC20(USDC).approve(address(fund), 1e6);
        vm.expectRevert();
        fund.mintInKind(n, 1e6, legs);
        _assertFundSame(f0, _fundSnap(), "underpaid mint");

        // Zero leg limits: the purchase cannot happen, nothing moves.
        uint256[] memory zero = new uint256[](legs.length);
        IERC20(USDC).approve(address(fund), maxUsdc);
        vm.expectRevert();
        fund.mintInKind(n, maxUsdc, zero);
        _assertFundSame(f0, _fundSnap(), "zero-limit mint");

        // A sale with every floor at 0, then an in-kind exit: the holders keep their per-share amounts.
        fund.sellForFlow(n / 2, zero);
        _assertPerShareNotLower(f0, "rogue sale");
        f0 = _fundSnap();
        fund.redeemInKind(fund.balanceOf(rogue), rogue, rogue);
        _assertPerShareNotLower(f0, "rogue in-kind exit");
        vm.stopPrank();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-14
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-14: a request whose limit does not admit the bound price is skipped (`RequestSkipped`) and stays
    ///         pending in full; the settlement still succeeds for the others; no fill is outside its limit.
    function test_RB14_aRequestOutsideTheBoundIsSkippedAndStaysPending() public fixtureCovered {
        _invest();
        uint256 carolShares = _holder(carol, 20_000e6);
        Quote memory qd = queue.quoteDeposit(5_000e6);
        Quote memory qr = queue.quoteRedeem(carolShares / 4);
        uint256 lowDep = openDepositRequest(alice, 5_000e6, qd.boundPrice / 2);
        uint256 okDep = openDepositRequest(bob, 5_000e6, qd.boundPrice * 2);
        uint256 highRed = openRedeemRequest(carol, carolShares / 4, qr.boundPrice * 2);
        uint256 okRed = openRedeemRequest(carol, carolShares / 4, qr.boundPrice / 2);
        warpToSettleable(lowDep);
        refreshFeeds();
        uint256 claims0 = queue.claimCount();

        vm.recordLogs();
        uint256 sid = _keeperSettle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(sid, 0, "the settlement succeeds");
        assertTrue(_skipped(logs, lowDep), "low deposit limit: skipped");
        assertTrue(_skipped(logs, highRed), "high redemption limit: skipped");
        assertFalse(_skipped(logs, okDep), "admitted deposit not skipped");
        assertFalse(_skipped(logs, okRed), "admitted redemption not skipped");

        Settlement memory st = queue.getSettlement(sid);
        assertLt(queue.getRequest(lowDep).limit, st.depositBoundPrice, "its limit is below the bound");
        assertGt(queue.getRequest(highRed).limit, st.redeemBoundPrice, "its limit is above the bound");
        assertEq(queue.getRequest(lowDep).remaining, 5_000e6, "skipped deposit: untouched");
        assertEq(queue.getRequest(highRed).remaining, carolShares / 4, "skipped redemption: untouched");
        assertEq(uint8(queue.requestStatus(lowDep)), uint8(RequestStatus.Pending), "still pending");
        assertEq(uint8(queue.requestStatus(highRed)), uint8(RequestStatus.Pending), "still pending");
        assertTrue(queue.getRequest(okDep).closed, "admitted deposit filled");
        assertTrue(queue.getRequest(okRed).closed, "admitted redemption filled");
        _assertClaimsInsideLimits(claims0);
        _assertBooks("RB-14");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-15
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-15: a reverted `settle` leaves every balance and flag unchanged (checked on the queue's balances,
    ///         books, counters, every request and both users' credits and queued shares, and on the fund).
    function test_RB15_aRevertedSettleLeavesEveryBalanceAndFlag() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        setFeedPrice(IDX_CBBTC, poolPrice8(CBBTC_POOL, CBBTC) * 101 / 100); // check 4 on cbBTC
        QueueSnap memory q0 = _queueSnap();
        FundSnap memory f0 = _fundSnap();
        Request memory d0 = queue.getRequest(_depId);
        Request memory r0 = queue.getRequest(_redId);
        uint256 qa = queue.queuedSharesOf(alice);
        uint256 qb = queue.queuedSharesOf(bob);

        _expectBlocked(keeper, SettleCheck.TwapVsFeed, IDX_CBBTC);
        vm.prank(keeper);
        (SettleCheck check, uint256 index) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.TwapVsFeed), "checkSettle names it");
        assertEq(index, IDX_CBBTC, "and the asset");

        _assertQueueSame(q0, _queueSnap(), "reverted settle");
        _assertFundSame(f0, _fundSnap(), "reverted settle");
        Request memory d1 = queue.getRequest(_depId);
        Request memory r1 = queue.getRequest(_redId);
        assertEq(d1.remaining, d0.remaining, "deposit remaining");
        assertEq(r1.remaining, r0.remaining, "redemption remaining");
        assertEq(d1.closed, d0.closed, "deposit flag");
        assertEq(r1.closed, r0.closed, "redemption flag");
        assertEq(queue.queuedSharesOf(alice), qa, "alice queued");
        assertEq(queue.queuedSharesOf(bob), qb, "bob queued");
    }

    /// @notice RB-15: while the queue is paused, requests and settlement stop, and cancel, in-kind exit, credit
    ///         withdrawal and delivery stay open. Only the emergency key pauses; only the admin unpauses.
    function test_RB15_cancelAndExitInKindWorkWhilePaused() public fixtureCovered {
        _invest();
        uint256 bobShares = _holder(bob, 20_000e6);
        uint256 carolDep = openDepositRequest(carol, 5_000e6, type(uint256).max);
        warpToSettleable(carolDep);
        _settleNow(); // carol's shares now sit in their hold
        uint256 dep = openDepositRequest(alice, 5_000e6, type(uint256).max);
        uint256 red = openRedeemRequest(bob, bobShares / 2, 0);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.EMERGENCY_ROLE)
        );
        queue.pause();
        vm.prank(emergency);
        queue.pause();
        assertTrue(queue.paused(), "paused");

        fundUsdc(dave, 1_000e6);
        vm.startPrank(dave);
        IERC20(USDC).approve(address(queue), 1_000e6);
        vm.expectRevert(IFlowEvents.QueueIsPaused.selector);
        queue.requestDeposit(1_000e6, type(uint256).max, dave);
        vm.stopPrank();
        warpToSettleable(dep);
        refreshFeeds();
        _expectBlocked(keeper, SettleCheck.Paused, IDLE_INDEX);

        vm.prank(alice);
        queue.cancel(dep);
        vm.prank(alice);
        (uint256 u,) = queue.withdrawCredit();
        assertEq(u, 5_000e6, "cancel and credit while paused");
        uint256 bobUsdc = IERC20(USDC).balanceOf(bob);
        vm.prank(bob);
        queue.exitInKind(red);
        assertGt(IERC20(USDC).balanceOf(bob), bobUsdc, "in-kind exit while paused");
        Claim memory c = queue.getClaim(queue.claimCount());
        warpForward(c.unlockAt);
        refreshFeeds();
        vm.prank(stranger);
        queue.mint(c.shares, carol);
        assertEq(fund.balanceOf(carol), c.shares, "delivery while paused");

        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, emergency, Roles.ADMIN_ROLE)
        );
        queue.unpause();
        timelockExecute(address(queue), abi.encodeCall(queue.unpause, ()));
        assertFalse(queue.paused(), "the admin unpaused");
        _assertBooks("RB-15 paused");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-16, pre-trade checks: one test per way to trip each, nothing settles
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Check 1: a non-keeper before `keeperGrace` is refused (up to the last second); from the grace on,
    ///         anyone settles.
    function test_check1_aNonKeeperBeforeKeeperGrace() public fixtureCovered {
        uint256 id = _pendingAtWindow();
        uint256 windowEnd = block.timestamp;
        uint256 grace = queue.flowParams().keeperGrace;
        assertEq(_expectBlocked(stranger, SettleCheck.Caller, IDLE_INDEX), windowEnd + grace, "names the grace end");
        vm.warp(windowEnd + grace - 1);
        refreshFeeds();
        _expectBlocked(stranger, SettleCheck.Caller, IDLE_INDEX);
        assertEq(queue.settlementCount(), 0, "nothing settled");
        assertEq(queue.getRequest(id).remaining, 5_000e6, "pending");
        vm.warp(windowEnd + grace);
        refreshFeeds();
        vm.prank(stranger);
        uint256 sid = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
        assertEq(queue.getSettlement(sid).settler, stranger, "anyone after the grace");
    }

    /// @notice Check 1: a paused queue settles nothing, for the keeper and for anyone after the grace.
    function test_check1_aPausedQueue() public fixtureCovered {
        uint256 id = _pendingAtWindow();
        vm.prank(emergency);
        queue.pause();
        _expectBlocked(keeper, SettleCheck.Paused, IDLE_INDEX);
        vm.warp(block.timestamp + queue.flowParams().keeperGrace);
        refreshFeeds();
        _expectBlocked(stranger, SettleCheck.Paused, IDLE_INDEX);
        assertEq(queue.settlementCount(), 0, "nothing settled");
        assertEq(queue.getRequest(id).remaining, 5_000e6, "pending");
    }

    /// @notice Check 2: a basket feed older than its `maxFeedAge` (wETH, 1 500 s) blocks with its index.
    function test_check2_aStaleFeed() public fixtureCovered {
        _pendingAtWindow();
        uint256 t = block.timestamp - ETH_FEED_MAX_AGE - 1;
        MockAggregator(FEED_ETH).setRound(8, int256(poolPrice8(WETH_POOL, WETH)), t, t);
        assertEq(_expectBlocked(keeper, SettleCheck.Feed, IDX_WETH), uint256(FeedStatus.Stale), "stale");
        assertEq(queue.settlementCount(), 0, "nothing settled");
        // One second younger is healthy.
        t += 1;
        MockAggregator(FEED_ETH).setRound(8, int256(poolPrice8(WETH_POOL, WETH)), t, t);
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "at maxFeedAge it passes");
    }

    /// @notice Check 2: a basket feed that answers zero or a negative price blocks with its index.
    function test_check2_aNonPositiveFeed() public fixtureCovered {
        _pendingAtWindow();
        MockAggregator(FEED_CBBTC).setRound(8, 0, block.timestamp, block.timestamp);
        assertEq(_expectBlocked(keeper, SettleCheck.Feed, IDX_CBBTC), uint256(FeedStatus.NonPositive), "zero");
        MockAggregator(FEED_CBBTC).setRound(8, -1, block.timestamp, block.timestamp);
        assertEq(_expectBlocked(keeper, SettleCheck.Feed, IDX_CBBTC), uint256(FeedStatus.NonPositive), "negative");
        MockAggregator(FEED_CBBTC).setRound(8, int256(poolPrice8(CBBTC_POOL, CBBTC)), block.timestamp, block.timestamp);
        MockAggregator(FEED_CBBTC).setIncomplete();
        assertEq(
            _expectBlocked(keeper, SettleCheck.Feed, IDX_CBBTC), uint256(FeedStatus.RoundIncomplete), "incomplete"
        );
        assertEq(queue.settlementCount(), 0, "nothing settled");
    }

    /// @notice Check 2: a sequencer that reports down, or came up less than `sequencerGrace` ago, blocks.
    function test_check2_aDownSequencer() public fixtureCovered {
        _pendingAtWindow();
        MockAggregator(FEED_SEQUENCER).setRound(0, 1, block.timestamp, block.timestamp);
        assertEq(_expectBlocked(keeper, SettleCheck.Sequencer, IDLE_INDEX), uint256(FeedStatus.SequencerDown), "down");
        uint256 upAt = block.timestamp - queue.flowParams().sequencerGrace + 1;
        MockAggregator(FEED_SEQUENCER).setRound(0, 0, upAt, block.timestamp);
        assertEq(
            _expectBlocked(keeper, SettleCheck.Sequencer, IDLE_INDEX), uint256(FeedStatus.SequencerGrace), "in grace"
        );
        assertEq(queue.settlementCount(), 0, "nothing settled");
        MockAggregator(FEED_SEQUENCER).setRound(0, 0, upAt - 1, block.timestamp);
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "up for the whole grace");
    }

    /// @notice Check 2: USDC outside `usdcPegBandBps` (50) of 1 blocks; inside it passes.
    function test_check2_usdcOffItsPeg() public fixtureCovered {
        _pendingAtWindow();
        setUsdcFeedPrice(0.994e8);
        assertEq(_expectBlocked(keeper, SettleCheck.UsdcPeg, IDLE_INDEX), 0.994e8, "60 bps below");
        setUsdcFeedPrice(1.006e8);
        assertEq(_expectBlocked(keeper, SettleCheck.UsdcPeg, IDLE_INDEX), 1.006e8, "60 bps above");
        assertEq(queue.settlementCount(), 0, "nothing settled");
        setUsdcFeedPrice(0.996e8);
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "40 bps passes");
    }

    /// @notice Check 3: a pool pushed 25 minutes before the settlement leaves 5 of the 12 five-minute slices far
    ///         from the median. The median stays at the old price (so check 4 would pass), but fewer than `quorum`
    ///         (9) slices sit inside `dispersionBps`: the TWAP quorum blocks alone.
    function test_check3_fewerThanQuorumSlicesInTheBand() public fixtureCovered {
        uint256 id = openDepositRequest(alice, 5_000e6, type(uint256).max);
        uint256 t = queue.settleableAt(queue.getRequest(id).epoch);
        warpForward(t - 25 minutes);
        uint256 moved = _pushPool(WETH_POOL, WETH, 200, true);
        emit log_named_uint("wETH pool pushed (bps)", moved);
        vm.warp(t);
        refreshFeeds();
        uint256 inBand = _expectBlocked(keeper, SettleCheck.TwapQuorum, IDX_WETH);
        FlowParams memory p = queue.flowParams();
        assertLt(inBand, p.quorum, "fewer slices than quorum in the band");
        emit log_named_uint("slices in the band", inBand);
        assertEq(queue.settlementCount(), 0, "nothing settled");
        // Check 3 alone: the slice median did not follow the push, so it still sits inside check 4's band.
        (bool ok, int24 med,) = TwapSlicesLib.median(WETH_POOL, p.settleWindow, p.slices, p.dispersionBps);
        assertTrue(ok, "the slices read");
        uint256 twap6 = TwapTickMath.priceFromTick(med, WETH, USDC, 1e18);
        uint256 feed6 = uint256(feedPrice8[FEED_ETH]) / 100;
        uint256 dev = (twap6 > feed6 ? twap6 - feed6 : feed6 - twap6) * BPS / feed6;
        assertLe(dev, p.refBandBps, "the median is still within refBandBps of the feed");
    }

    /// @notice Check 4: a TWAP more than `refBandBps` (90 by default) from its feed blocks with the asset and the
    ///         deviation; 10 bps inside the band passes. Sized from the band in force, so it holds at any default.
    function test_check4_aTwapOffItsFeed() public fixtureCovered {
        _pendingAtWindow();
        uint256 band = queue.flowParams().refBandBps;
        uint256 p = poolPrice8(WETH_POOL, WETH);
        setFeedPrice(IDX_WETH, p * (BPS + band + 10) / BPS);
        uint256 dev = _expectBlocked(keeper, SettleCheck.TwapVsFeed, IDX_WETH);
        assertGt(dev, band, "deviation above the band");
        assertLe(dev, band + 12, "about band + 10 bps");
        assertEq(queue.settlementCount(), 0, "nothing settled");
        setFeedPrice(IDX_WETH, p * (BPS + band - 10) / BPS);
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "band - 10 bps passes");
    }

    /// @notice Check 5: once a settlement recorded the venues' rates, a step into the venues and a gift to the
    ///         Aave adapter (USDC and aUSDC) do not trip the check, because the venue's own rate does not move. A
    ///         jump of the venue's own rate over `maxLendRateGrowthBps` per day blocks with the venue's index.
    function test_check5_aVenueRateOverTheBound_aGiftOrAStepDoesNot() public fixtureCovered {
        uint256 first = _pendingAtWindow();
        _keeperSettle();
        assertTrue(queue.getRequest(first).closed, "the first settlement records the rates");

        _invest(); // steps into Aave and Moonwell
        fundUsdc(address(aaveAdapter), 1_000e6); // a USDC gift to the adapter
        fundUsdc(dave, 1_000e6); // an aUSDC gift: dave supplies on behalf of the adapter
        vm.startPrank(dave);
        IERC20(USDC).approve(AAVE_POOL, 1_000e6);
        IAavePool(AAVE_POOL).supply(USDC, 1_000e6, address(aaveAdapter), 0);
        vm.stopPrank();
        uint256 second = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpToSettleable(second);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "a step and a gift do not trip check 5");
        _keeperSettle();
        assertTrue(queue.getRequest(second).closed, "settled");

        uint256 third = openDepositRequest(carol, 5_000e6, type(uint256).max);
        warpToSettleable(third);
        refreshFeeds();
        uint256 index = IAavePoolRate(AAVE_POOL).getReserveNormalizedIncome(USDC);
        vm.mockCall(
            AAVE_POOL,
            abi.encodeCall(IAavePoolRate.getReserveNormalizedIncome, (USDC)),
            abi.encode(index * 10_100 / BPS)
        );
        uint256 growth = _expectBlocked(keeper, SettleCheck.LendRate, IDX_AAVE);
        assertGe(growth, 100, "about 100 bps");
        vm.clearMockedCalls();
        assertEq(queue.getRequest(third).remaining, 5_000e6, "nothing settled");
    }

    /// @notice Check 6: NAV per share at the feeds moving more than `maxSharePriceMoveBps` (1 000) in one epoch
    ///         blocks (a 15 % gift to the fund); two epochs after the last settlement the allowance is 2 000 bps and
    ///         the same move passes.
    function test_check6_aSharePriceMoveOverTheBreaker_andTheLargerAllowanceAfterEpochs() public fixtureCovered {
        uint256 first = _pendingAtWindow();
        _keeperSettle();
        assertTrue(queue.getRequest(first).closed, "the first settlement records the share price");
        uint256 t1 = block.timestamp;
        (uint256 nav,,) = fund.portfolioValues();
        fundUsdc(address(fund), nav * 15 / 100);

        uint256 second = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpToSettleable(second);
        refreshFeeds();
        uint256 epochLength = queue.flowParams().epochLength;
        assertEq(block.timestamp / epochLength - t1 / epochLength, 1, "one epoch since the last settlement");
        uint256 moveBps = _expectBlocked(keeper, SettleCheck.SharePrice, IDLE_INDEX);
        assertApproxEqAbs(moveBps, 1_500, 2, "a 15 % move");
        assertEq(queue.getRequest(second).remaining, 5_000e6, "nothing settled");

        vm.warp(block.timestamp + epochLength);
        refreshFeeds();
        assertEq(block.timestamp / epochLength - t1 / epochLength, 2, "two epochs since the last settlement");
        _keeperSettle();
        assertTrue(queue.getRequest(second).closed, "the larger allowance admits the move");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-16, one side only: each leaves one side pending while the other settles
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Redemptions settled, the deposit request untouched and not attempted.
    function _assertRedeemedAlone(uint256 sid, Vm.Log[] memory logs, string memory label) internal view {
        Settlement memory st = queue.getSettlement(sid);
        assertEq(st.sharesBurned, _bobShares / 2, string.concat(label, ": redemption settled"));
        assertEq(st.sharesMinted, 0, string.concat(label, ": no deposit minted"));
        Request memory d = queue.getRequest(_depId);
        assertEq(d.remaining, d.amount, string.concat(label, ": deposit untouched"));
        assertFalse(d.closed, string.concat(label, ": deposit open"));
        assertEq(queue.books().pendingUsdc, d.amount, string.concat(label, ": deposit escrow in the books"));
        (uint256 fails,) = _sideFailed(logs, RequestKind.Deposit);
        assertEq(fails, 0, string.concat(label, ": deposits not processed at all"));
        _assertBooks(label);
    }

    /// @dev Deposits settled, the redemption request untouched: escrow, queued shares, books.
    function _assertDepositedAlone(uint256 sid, string memory label) internal view {
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.sharesMinted, 0, string.concat(label, ": deposit settled"));
        assertEq(st.sharesBurned, 0, string.concat(label, ": nothing burned"));
        Request memory r = queue.getRequest(_redId);
        assertEq(r.remaining, _bobShares / 2, string.concat(label, ": redemption untouched"));
        assertFalse(r.closed, string.concat(label, ": redemption open"));
        assertEq(queue.queuedSharesOf(bob), _bobShares / 2, string.concat(label, ": bob's queued shares"));
        assertEq(queue.books().escrowShares, _bobShares / 2, string.concat(label, ": escrow in the books"));
        _assertBooks(label);
    }

    /// @notice Check 1: an excluded lending asset leaves deposits unprocessed; redemptions settle alone. (Moonwell
    ///         holds 5 % here, so the exclusion moves NAV per share by less than check 6's breaker.)
    function test_check1_anExcludedLendingAsset_redemptionsSettleAlone() public fixtureCovered {
        _twoSidedSetup(assetVec(6_000, 500, 1_750, 1_750, 0));
        timelockExecute(
            address(fund), abi.encodeCall(fund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false))
        );
        assertGt(fund.openExclusionOf(IDX_MOONWELL), 0, "Moonwell excluded");
        refreshFeeds();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        _assertRedeemedAlone(sid, vm.getRecordedLogs(), "excluded lending");
    }

    /// @notice Check 1: paused deposits leave deposits unprocessed; redemptions settle alone.
    function test_check1_pausedDeposits_redemptionsSettleAlone() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        vm.prank(emergency);
        fund.pauseDeposits();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        _assertRedeemedAlone(sid, vm.getRecordedLogs(), "paused deposits");
    }

    /// @notice Check 1: a shut-down fund leaves deposits unprocessed; redemptions settle alone.
    function test_check1_aShutDownFund_redemptionsSettleAlone() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        vm.prank(emergency);
        fund.shutdown();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        _assertRedeemedAlone(sid, vm.getRecordedLogs(), "shut down");
    }

    /// @notice Check 8: a sale under its limit. The wETH pool is pushed 3 % down in the settlement's block (a push
    ///         inside one block leaves the slice median where it was, so checks 3 and 4 pass). The redemption side
    ///         fails its per-sale limit and stays pending; the deposit side buys cheaper and settles.
    function test_check8_aSaleUnderItsLimit_depositsStillSettle() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        uint256 moved = _pushPool(WETH_POOL, WETH, 300, false);
        emit log_named_uint("wETH pool pushed down (bps)", moved);
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 fails, bytes4 why) = _sideFailed(logs, RequestKind.Redeem);
        assertEq(fails, 1, "the redemption side failed");
        emit log_named_bytes("redemption side revert data", _sideFailedData(logs, RequestKind.Redeem));
        assertTrue(
            why == IRobotMoneyFund.FlowLegLimit.selector || why == bytes4(keccak256("Error(string)")),
            "on the per-sale limit (the fund's FlowLegLimit or the router's minimum out)"
        );
        _assertDepositedAlone(sid, "sale under its limit");
    }

    /// @notice Check 8: a venue that cannot pay (Aave refuses every withdrawal). Timed redemptions wait; deposits
    ///         still settle (they only supply).
    function test_check8_aVenueThatCannotPay_depositsStillSettle() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        vm.mockCallRevert(
            AAVE_POOL, abi.encodeWithSelector(IAavePool.withdraw.selector), abi.encodeWithSignature("Error(string)", "32")
        );
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        vm.clearMockedCalls();
        (uint256 fails,) = _sideFailed(vm.getRecordedLogs(), RequestKind.Redeem);
        assertEq(fails, 1, "the redemption side failed");
        _assertDepositedAlone(sid, "venue cannot pay");
    }

    /// @notice Check 9: a purchase over its limit. The wETH pool is pushed 3 % up in the settlement's block. The
    ///         deposit side fails its per-purchase limit and stays pending; the redemption side sells dearer and
    ///         settles.
    function test_check9_aPurchaseOverItsLimit_redemptionsStillSettle() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        uint256 moved = _pushPool(WETH_POOL, WETH, 300, true);
        emit log_named_uint("wETH pool pushed up (bps)", moved);
        QueueSnap memory q0 = _queueSnap();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 fails, bytes4 why) = _sideFailed(logs, RequestKind.Deposit);
        assertEq(fails, 1, "the deposit side failed");
        emit log_named_bytes("deposit side revert data", _sideFailedData(logs, RequestKind.Deposit));
        assertTrue(
            why == IRobotMoneyFund.FlowLegLimit.selector || why == bytes4(keccak256("Error(string)")),
            "on the per-purchase limit (the router cannot take more than the limit, or the fund's FlowLegLimit)"
        );
        _assertDepositPendingAfterRedemption(sid, q0, "purchase over its limit");
    }

    /// @notice Check 9: a venue at its supply cap (Aave refuses the supply; the adapter hands the USDC back and the
    ///         fund reverts `LendingSupplyRefused`). Deposits wait; redemptions still settle.
    function test_check9_aVenueAtItsSupplyCap_redemptionsStillSettle() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        vm.mockCallRevert(
            AAVE_POOL, abi.encodeWithSelector(IAavePool.supply.selector), abi.encodeWithSignature("Error(string)", "51")
        );
        QueueSnap memory q0 = _queueSnap();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        vm.clearMockedCalls();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 fails, bytes4 why) = _sideFailed(logs, RequestKind.Deposit);
        assertEq(fails, 1, "the deposit side failed");
        assertEq(why, IRobotMoneyFund.LendingSupplyRefused.selector, "the venue kept nothing");
        _assertDepositPendingAfterRedemption(sid, q0, "supply cap");
    }

    /// @dev Redemptions settled; the deposit request and its escrow untouched.
    function _assertDepositPendingAfterRedemption(uint256 sid, QueueSnap memory q0, string memory label)
        internal
        view
    {
        Settlement memory st = queue.getSettlement(sid);
        assertEq(st.sharesBurned, _bobShares / 2, string.concat(label, ": redemption settled"));
        assertEq(st.sharesMinted, 0, string.concat(label, ": nothing minted"));
        Request memory d = queue.getRequest(_depId);
        assertEq(d.remaining, d.amount, string.concat(label, ": deposit untouched"));
        assertEq(queue.books().pendingUsdc, q0.books.pendingUsdc, string.concat(label, ": deposit escrow"));
        assertEq(queue.queuedSharesOf(alice), 0, string.concat(label, ": alice holds nothing"));
        _assertBooks(label);
    }

    /// @notice Check 11 on the redemption side, forced with a mock venue: Aave pays half of each withdrawal and
    ///         keeps the rest (`MechAaveAdapter.SHORT_PAY`). Every per-sale limit and the fund's proportion check pass
    ///         (the position fell by exactly what the fund asked), so only the realized-price check sees the
    ///         shortfall. The redemption side reverts `SettleBlocked(RealizedPrice)` and stays pending; deposits settle.
    function test_check11_aRealizedPriceOutsideTheBound_forcedWithAMockVenue() public fixtureCovered {
        investFund(bucketVec(6_500, 3_500));
        _bobShares = _holder(bob, 50_000e6);
        MechAaveAdapter mech = _etchAaveMech();
        mech.setMode(mech.SHORT_PAY(), 5_000);
        _redId = openRedeemRequest(bob, _bobShares / 2, 0);
        _depId = openDepositRequest(alice, 20_000e6, type(uint256).max);
        warpToSettleable(_depId);
        refreshFeeds();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        bytes memory why = _sideFailedData(vm.getRecordedLogs(), RequestKind.Redeem);
        (SettleCheck check,,) = _decodeBlocked(why);
        assertEq(uint8(check), uint8(SettleCheck.RealizedPrice), "check 11 refused the short proceeds");
        _assertDepositedAlone(sid, "realized price");
    }

    /// @notice Check 11 on the deposit side restates check 9: even a venue that charges exactly its per-purchase
    ///         limit on every basket leg (`MechSwapAdapter.CHARGE_MAX`, the worst case) settles at or under the bound,
    ///         because the queue sizes `sharesOut` from that bound. Both sides settle; holders lose nothing.
    function test_check11_aDepositAtEveryLegLimitStaysInsideTheBound() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        MechSwapAdapter mech = _etchSwapMech();
        mech.setMode(mech.CHARGE_MAX(), 0);
        FundSnap memory f0 = _fundSnap();
        uint256 claims0 = queue.claimCount();
        uint256 sid = _keeperSettle();
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.sharesMinted, 0, "deposit settled at the worst case");
        assertGt(st.sharesBurned, 0, "redemption settled");
        assertLe(st.usdcIn * PRICE_SCALE, st.depositBoundPrice * st.sharesMinted, "realized at or under the bound");
        _assertClaimsInsideLimits(claims0);
        _assertPerShareNotLower(f0, "worst-case purchase");
        emit log_named_uint("deposit at every leg limit: realized price", st.usdcIn.mulDiv(PRICE_SCALE, st.sharesMinted));
        emit log_named_uint("deposit bound price", st.depositBoundPrice);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-16, caps
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice A deposit over its period cap fills up to the cap (the floor, 250 000 USDC, on a small fund), the
    ///         rest stays pending, and nothing reverts; the next period fills the rest.
    function test_caps_aDepositOverItsCapFillsToTheCapAndTheRestWaits() public fixtureCovered {
        uint256 a = openDepositRequest(alice, 400_000e6, type(uint256).max);
        warpToSettleable(a);
        _settleNow();
        uint256 period = block.timestamp / queue.flowParams().epochLength;
        (uint256 dep,) = queue.periodFlow(period);
        FlowParams memory p = queue.flowParams();
        assertEq(dep, p.epochFlowFloorUsdc, "filled to the cap");
        assertEq(queue.getRequest(a).remaining, 400_000e6 - dep, "the rest waits");
        assertEq(_keeperSettle(), 0, "a second call in the period fills nothing and does not revert");
        vm.warp(block.timestamp + p.epochLength);
        _settleNow();
        assertTrue(queue.getRequest(a).closed, "the next period fills the rest");
        _assertBooks("deposit cap");
    }

    /// @notice A redemption over its period cap fills up to the cap at its value at the feeds; the rest waits.
    function test_caps_aRedemptionOverItsCapFillsToTheCap() public fixtureCovered {
        uint256 shares = _holder(bob, 600_000e6);
        uint256 r = openRedeemRequest(bob, shares, 0);
        warpToSettleable(r);
        _settleNow();
        uint256 period = block.timestamp / queue.flowParams().epochLength;
        (, uint256 red) = queue.periodFlow(period);
        assertGt(red, 0, "a part filled");
        assertLe(red, queue.flowParams().epochFlowFloorUsdc, "no more than the cap");
        Request memory rq = queue.getRequest(r);
        assertGt(rq.remaining, 0, "the rest waits");
        assertEq(queue.getSettlement(queue.settlementCount()).sharesBurned, shares - rq.remaining, "burned = filled");
        _assertBooks("redemption cap");
    }

    /// @notice A deposit over the TVL cap fills only up to the cap (NAV at the feeds); the rest waits and nothing
    ///         reverts.
    function test_caps_aDepositOverTheTvlCapFillsToTheTvlCap() public fixtureCovered {
        timelockExecute(address(fund), abi.encodeCall(fund.setTvlCap, (SEED_USDC + 50_000e6)));
        uint256 a = openDepositRequest(alice, 120_000e6, type(uint256).max);
        warpToSettleable(a);
        _settleNow();
        uint256 period = block.timestamp / queue.flowParams().epochLength;
        (uint256 dep,) = queue.periodFlow(period);
        assertEq(dep, 50_000e6, "filled to the TVL room");
        (uint256 nav,,) = fund.portfolioValues();
        assertLe(nav, SEED_USDC + 50_000e6, "NAV at or under the TVL cap");
        assertEq(queue.getRequest(a).remaining, 70_000e6, "the rest waits");
        vm.warp(block.timestamp + queue.flowParams().epochLength);
        refreshFeeds();
        assertEq(_keeperSettle(), 0, "no room: nothing fills, nothing reverts");
        _assertBooks("TVL cap");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-17 (through the timelock, on the wired fund)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-17: `addAsset` of a basket asset without a feed, without a feed age, or with a stale feed reverts.
    function test_RB17_aBasketAssetWithoutAFeedIsRefused() public fixtureCovered {
        uint256 index = fund.assetCount();
        AssetConfig memory c = basketConfig(WETH, WETH_POOL, address(0), ETH_FEED_MAX_AGE);
        _timelockExpectRevert(
            address(fund),
            abi.encodeCall(fund.addAsset, (c)),
            abi.encodeWithSelector(IRobotMoneyFund.MissingFeed.selector, index)
        );
        c.feed = FEED_ETH;
        c.maxFeedAge = 0;
        _timelockExpectRevert(
            address(fund),
            abi.encodeCall(fund.addAsset, (c)),
            abi.encodeWithSelector(IRobotMoneyFund.MissingFeed.selector, index)
        );
        c.maxFeedAge = ETH_FEED_MAX_AGE;
        uint256 t = block.timestamp - ETH_FEED_MAX_AGE - 1 + TIMELOCK_DELAY;
        MockAggregator(FEED_ETH).setRound(8, int256(poolPrice8(WETH_POOL, WETH)), t - TIMELOCK_DELAY, t - TIMELOCK_DELAY);
        _timelockExpectRevert(
            address(fund),
            abi.encodeCall(fund.addAsset, (c)),
            abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, index, FeedStatus.Stale)
        );
        assertEq(fund.assetCount(), index, "nothing listed");
    }

    /// @notice RB-17: `addAsset` of a basket asset whose pool cannot answer one settlement window of history
    ///         reverts `PoolHistoryTooShort` (the pool's `observe` over the queue's 1 h window is made to fail).
    function test_RB17_aBasketAssetWithoutPoolHistoryIsRefused() public fixtureCovered {
        uint256 index = fund.assetCount();
        uint32 w = queue.flowParams().settleWindow;
        uint32[] memory ago = new uint32[](2);
        ago[0] = w;
        vm.mockCallRevert(WETH_POOL, abi.encodeCall(IObservablePool.observe, (ago)), "OLD");
        AssetConfig memory c = basketConfig(WETH, WETH_POOL, FEED_ETH, ETH_FEED_MAX_AGE);
        // The feed must read healthy at execution, after the timelock's delay.
        refreshFeeds();
        _timelockExpectRevert(
            address(fund),
            abi.encodeCall(fund.addAsset, (c)),
            abi.encodeWithSelector(IRobotMoneyFund.PoolHistoryTooShort.selector, index, w)
        );
        vm.clearMockedCalls();
        assertEq(fund.assetCount(), index, "nothing listed");
    }

    /// @notice RB-17: a lending asset whose adapter does not expose the venue's rate (the production Aave adapter,
    ///         allowlisted) is refused.
    function test_RB17_aLendingVenueWithoutItsRateIsRefused() public fixtureCovered {
        AaveV3Adapter plain = new AaveV3Adapter(AAVE_POOL, USDC, AAVE_A_USDC, address(fund));
        timelockExecute(address(fund), abi.encodeCall(fund.setAdapterCodeHashAllowed, (address(plain).codehash, true)));
        _timelockExpectRevert(
            address(fund),
            abi.encodeCall(fund.addAsset, (lendingConfig(address(plain)))),
            abi.encodeWithSelector(IRobotMoneyFund.LendingRateUnavailable.selector, address(plain))
        );
    }

    /// @notice RB-17: a target over the pool-share limit is refused through governance; liquidity minted into the
    ///         pool in the same block as the call does not raise the limit; at the limit the target is accepted.
    function test_RB17_aTargetOverThePoolShareLimitIsRefused_andSameBlockLiquidityDoesNotHelp() public fixtureCovered {
        uint32 w = queue.flowParams().settleWindow;
        (bool ok, uint256 depth) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, w);
        assertTrue(ok, "depth read");
        emit log_named_uint("wETH pool time-weighted USDC depth", depth);
        // A TVL cap that puts the 10 % wETH target 5 % over the limit (the depth drifts as the window slides).
        uint256 cap = depth.mulDiv(fund.poolShareBps(), BPS) * 10 * 105 / 100;
        timelockExecute(address(fund), abi.encodeCall(fund.setTvlCap, (cap)));

        bytes memory call = _poolShareTargetCall();
        bytes32 salt = keccak256("mechanism-tests: pool share");
        timelock.schedule(address(governance), 0, call, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        refreshFeeds();
        uint256 limitNow = _mintLiquidityNow(w);
        uint256 targetUsdc = cap.mulDiv(1_000, BPS, Math.Rounding.Ceil);
        assertGt(targetUsdc, limitNow, "the target is over the limit");
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.PoolShareExceeded.selector, IDX_WETH, targetUsdc, limitNow)
        );
        timelock.execute(address(governance), 0, call, bytes32(0), salt);

        // Under the limit it is accepted.
        (, depth) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, w);
        timelockExecute(address(fund), abi.encodeCall(fund.setTvlCap, (depth.mulDiv(fund.poolShareBps(), BPS) * 9)));
        refreshFeeds();
        setTargetViaTimelock(_poolShareVector(), PlanParams(1 days, COST_BUDGET_BPS));
        assertEq(fund.targetBps()[IDX_WETH], 1_000, "accepted under the limit");
    }

    /// @dev wETH at 10 %.
    function _poolShareVector() private pure returns (uint16[5] memory) {
        return [uint16(5_000), 4_000, 1_000, 0, 0];
    }

    function _poolShareTargetCall() private view returns (bytes memory) {
        (address[] memory ids, uint256[] memory weights) = assetArrays(_poolShareVector());
        return abi.encodeCall(governance.setTarget, (ids, weights, PlanParams(1 days, COST_BUDGET_BPS)));
    }

    /// @dev Mint a large position around the wETH pool's tick now, in the call's own block: it holds no seconds of
    ///      the window, so the time-weighted depth must not change. Returns the pool-share limit of this block.
    function _mintLiquidityNow(uint32 w) private returns (uint256 limitUsdc) {
        (, uint256 depthBefore) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, w);
        (, int24 tick,,,,,) = IHarnessV3Pool(WETH_POOL).slot0();
        int24 lower = (tick / 10 - 50) * 10;
        int24 upper = (tick / 10 + 50) * 10;
        IUniswapV3PoolMint(WETH_POOL).mint(address(this), lower, upper, 1e19, "");
        (, uint256 depthNow) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, w);
        assertEq(depthNow, depthBefore, "same-block liquidity does not count");
        limitUsdc = depthNow.mulDiv(fund.poolShareBps(), BPS);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-18
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Alice's deposit settled and in its hold. Returns the settlement and the claim.
    function _heldDeposit() internal returns (uint256 sid, uint256 claimId) {
        _invest();
        _pendingAtWindow();
        sid = _keeperSettle();
        claimId = queue.claimCount();
    }

    /// @notice RB-18: frozen shares cannot be delivered after their unlock; only the emergency key freezes, only
    ///         inside the hold, and not twice.
    function test_RB18_frozenSharesCannotBeDelivered() public fixtureCovered {
        (uint256 sid, uint256 claimId) = _heldDeposit();
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, keeper, Roles.EMERGENCY_ROLE)
        );
        queue.freezeSettlement(sid);
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        vm.prank(emergency);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.SettlementAlreadyFrozen.selector, sid));
        queue.freezeSettlement(sid);

        Claim memory c = queue.getClaim(claimId);
        vm.warp(c.unlockAt);
        refreshFeeds();
        assertEq(queue.maxMint(alice), 0, "nothing deliverable while frozen");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, c.shares, 0));
        queue.mint(c.shares, alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, c.usdc, 0));
        queue.deposit(c.usdc, alice);
        assertEq(fund.balanceOf(alice), 0, "no share left the queue");
    }

    /// @notice RB-18: the admin's release lets the shares go, but only to their depositor.
    function test_RB18_releaseGoesOnlyToTheDepositors() public fixtureCovered {
        (uint256 sid, uint256 claimId) = _heldDeposit();
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        vm.prank(emergency);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, emergency, Roles.ADMIN_ROLE)
        );
        queue.releaseSettlement(sid);
        timelockExecute(address(queue), abi.encodeCall(queue.releaseSettlement, (sid)));
        Claim memory c = queue.getClaim(claimId);
        vm.warp(c.unlockAt);
        refreshFeeds();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, c.shares, 0));
        queue.mint(c.shares, stranger);
        vm.prank(stranger);
        queue.mint(c.shares, alice);
        assertEq(fund.balanceOf(alice), c.shares, "released to the depositor");
        assertEq(fund.balanceOf(stranger), 0, "nobody else");
    }

    /// @notice RB-18: after `allowReturn`, each depositor alone pulls its slice back in kind; the shares are
    ///         burned, the assets go to the depositor, and the keeper, the emergency key and strangers cannot take it.
    function test_RB18_returnInKindOnlyByTheDepositor() public fixtureCovered {
        (uint256 sid, uint256 claimId) = _heldDeposit();
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.ReturnNotAllowed.selector, sid));
        queue.takeReturn(claimId);
        timelockExecute(address(queue), abi.encodeCall(queue.allowReturn, (sid)));
        Claim memory c = queue.getClaim(claimId);
        address[3] memory others = [stranger, emergency, keeper];
        for (uint256 k; k < others.length; ++k) {
            vm.prank(others[k]);
            vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotRequestOwner.selector, c.requestId, others[k]));
            queue.takeReturn(claimId);
        }
        uint256 supply0 = fund.totalSupply();
        vm.prank(alice);
        queue.takeReturn(claimId);
        assertEq(fund.totalSupply(), supply0 - c.shares, "the held shares were burned");
        assertGt(IERC20(USDC).balanceOf(alice), 0, "USDC leg to the depositor");
        assertGt(IERC20(WETH).balanceOf(alice), 0, "wETH leg to the depositor");
        assertGt(IERC20(CBBTC).balanceOf(alice), 0, "cbBTC leg to the depositor");
        assertEq(IERC20(WETH).balanceOf(stranger) + IERC20(WETH).balanceOf(emergency), 0, "nobody else");
        assertEq(queue.queuedSharesOf(alice), 0, "nothing held for alice");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NothingToWithdraw.selector, alice));
        queue.takeReturn(claimId);
        _assertBooks("RB-18 return");
    }

    /// @notice RB-18: a freeze ends by itself `maxFreeze` after the freeze call (not after the settlement), and a
    ///         new freeze is impossible once the hold is over, so a depositor waits at most `minHold + maxFreeze`.
    function test_RB18_aFreezeEndsByItselfMaxFreezeAfterTheFreezeCall() public fixtureCovered {
        (uint256 sid, uint256 claimId) = _heldDeposit();
        vm.warp(block.timestamp + 10 hours);
        uint256 frozenAt = block.timestamp;
        vm.prank(emergency);
        queue.freezeSettlement(sid);
        uint256 until = frozenAt + queue.flowParams().maxFreeze;
        assertEq(queue.getSettlement(sid).frozenUntil, until, "maxFreeze after the call");
        Claim memory c = queue.getClaim(claimId);
        vm.warp(until - 1);
        refreshFeeds();
        assertEq(queue.maxMint(alice), 0, "still frozen one second before");
        vm.prank(emergency);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.FreezeOutsideHold.selector, sid));
        queue.freezeSettlement(sid);
        vm.warp(until);
        refreshFeeds();
        assertEq(queue.maxMint(alice), c.shares, "deliverable when the freeze ends");
        vm.prank(stranger);
        queue.mint(c.shares, alice);
        assertEq(fund.balanceOf(alice), c.shares, "delivered");
        assertLe(block.timestamp - queue.getSettlement(sid).time, queue.flowParams().minHold + queue.flowParams().maxFreeze, "bounded wait");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-20
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-20: two settlers with different inputs (the keeper with the queue's maximum and any USDC; a
    ///         stranger after the grace with 10 requests and 1 000 000 USDC) fill the same requests, the same
    ///         amounts, at the same bound prices, from the same state.
    function test_RB20_twoSettlersWithDifferentInputsFillTheSameRequestsAtTheSameBoundPrices() public fixtureCovered {
        _invest();
        uint256 bobShares = _holder(bob, 30_000e6);
        uint256 a = openDepositRequest(alice, 10_000e6, type(uint256).max);
        openDepositRequest(carol, 7_000e6, type(uint256).max);
        openRedeemRequest(bob, bobShares / 3, 0);
        warpForward(queue.settleableAt(queue.getRequest(a).epoch) + queue.flowParams().keeperGrace);
        refreshFeeds();

        uint256 snap = vm.snapshotState();
        uint256 claims0 = queue.claimCount();
        uint256 sidA = _keeperSettle();
        Settlement memory stA = queue.getSettlement(sidA);
        uint256 nA = queue.claimCount() - claims0;
        Claim[] memory cA = new Claim[](nA);
        for (uint256 k; k < nA; ++k) {
            cA[k] = queue.getClaim(claims0 + 1 + k);
        }
        vm.revertToState(snap);

        vm.prank(stranger);
        uint256 sidB = queue.settle(10, 1_000_000e6);
        Settlement memory stB = queue.getSettlement(sidB);
        assertEq(stB.depositBoundPrice, stA.depositBoundPrice, "same deposit bound");
        assertEq(stB.redeemBoundPrice, stA.redeemBoundPrice, "same redemption bound");
        assertEq(stB.sharesMinted, stA.sharesMinted, "same shares minted");
        assertEq(stB.sharesBurned, stA.sharesBurned, "same shares burned");
        assertEq(queue.claimCount() - claims0, nA, "same number of fills");
        for (uint256 k; k < nA; ++k) {
            Claim memory cb = queue.getClaim(claims0 + 1 + k);
            assertEq(cb.requestId, cA[k].requestId, "same request, same order");
            assertEq(cb.shares, cA[k].shares, "same shares");
            assertEq(cb.usdc, cA[k].usdc, "same USDC");
        }
    }

    /// @notice RB-20: a call with small inputs is continued by the next: four requests settled one per call fill in
    ///         the order they were made; a call limited by `maxUsdc` fills part, and the next pass fills the rest
    ///         before anything newer.
    function test_RB20_aSmallCallIsContinuedByTheNext() public fixtureCovered {
        address[4] memory users = [alice, bob, carol, dave];
        uint256[4] memory ids;
        for (uint256 k; k < 4; ++k) {
            ids[k] = openDepositRequest(users[k], 1_000e6, type(uint256).max);
        }
        warpToSettleable(ids[0]);
        refreshFeeds();
        for (uint256 k; k < 4; ++k) {
            vm.prank(keeper);
            queue.settle(1, type(uint256).max);
            for (uint256 j; j < 4; ++j) {
                assertEq(queue.getRequest(ids[j]).closed, j <= k, "one more request per call, oldest first");
            }
        }
        for (uint256 k; k < 4; ++k) {
            assertEq(queue.getClaim(k + 1).requestId, ids[k], "fills in creation order");
        }

        // A call limited to 1 500 USDC fills the first request and part of the second, and leaves the third. It
        // reached the end of the settleable requests, so the next call starts a fresh pass oldest first: the rest of
        // the second fills before the third.
        uint256[3] memory more;
        for (uint256 k; k < 3; ++k) {
            more[k] = openDepositRequest(users[k], 1_000e6, type(uint256).max);
        }
        warpToSettleable(more[0]);
        refreshFeeds();
        vm.prank(keeper);
        queue.settle(SETTLE_MAX_REQUESTS, 1_500e6);
        assertTrue(queue.getRequest(more[0]).closed, "first filled");
        assertEq(queue.getRequest(more[1]).remaining, 500e6, "second filled in part");
        assertEq(queue.getRequest(more[2]).remaining, 1_000e6, "third untouched");
        uint256 claims0 = queue.claimCount();
        _keeperSettle();
        assertTrue(queue.getRequest(more[1]).closed, "the next call filled the rest of the second");
        assertTrue(queue.getRequest(more[2]).closed, "and the third");
        assertEq(queue.getClaim(claims0 + 1).requestId, more[1], "the older request's rest first");
        assertEq(queue.getClaim(claims0 + 2).requestId, more[2], "then the newer");
        _assertBooks("RB-20 small calls");
    }

    /// @notice RB-20 (A13 shape): a flood of 260 requests whose limits never admit the bound does not hold back
    ///         the honest request behind it: the first call looks at 256 and skips them all, the next continues
    ///         at the cursor and fills the honest one. Gas of both calls is logged.
    function test_RB20_aFloodOfSkippedRequestsDoesNotHoldBackTheOnesBehind() public fixtureCovered {
        address flooder = makeAddr("flooder");
        uint256 n = 260;
        fundUsdc(flooder, n * 100e6);
        vm.startPrank(flooder);
        IERC20(USDC).approve(address(queue), n * 100e6);
        for (uint256 k; k < n; ++k) {
            queue.requestDeposit(100e6, 1, flooder);
        }
        vm.stopPrank();
        uint256 honest = openDepositRequest(alice, 5_000e6, type(uint256).max);
        coverageCheckpoint();
        warpToSettleable(honest);
        refreshFeeds();

        uint256 g0 = gasleft();
        uint256 first = _keeperSettle();
        uint256 g1 = gasleft();
        assertEq(first, 0, "the first call only skipped");
        assertEq(queue.getRequest(honest).remaining, 5_000e6, "not reached yet");
        _keeperSettle();
        uint256 g2 = gasleft();
        assertTrue(queue.getRequest(honest).closed, "the next call fills the honest request");
        emit log_named_uint("gas, call 1 (256 skipped)", g0 - g1);
        emit log_named_uint("gas, call 2 (4 skipped, 1 filled)", g1 - g2);
        assertEq(queue.getRequest(1).remaining, 100e6, "the flood is untouched");
    }

    /// @notice RB-20: the gas a caller sends cannot choose which side settles. Over gas limits from 160 % down to
    ///         42 % of a full settlement's measured use, a call either settles both sides or reverts whole (the queue's
    ///         `SettleSideOutOfGas` guard, or an out-of-gas elsewhere); it never records a settlement with one side
    ///         missing. Every outcome is counted and logged before the assertion.
    ///         Was skipped for defects.md mechanism-tests 1 (a nested out-of-gas in the sale escaped the 1/64 guard);
    ///         `verify` fixed `FlowSettleLib._sideFailed` and removed the skip. `verify` also added a fine sweep (0.4 %
    ///         steps from 104 % down to 40.4 %) after the coarse one (2 % steps), so a narrow window where a deep
    ///         frame's out-of-gas comes back as a reason string ("STF", "TF") is also probed.
    ///         `hardening` (2026-11-12): every successful call must have recorded exactly one new settlement and
    ///         returned its id (a success that recorded nothing is counted and fails the test), and at least one
    ///         limit must settle both sides.
    ///         `verify` (2026-11-12, step 3 finish plan §3.1 item 4): each side's call into the fund now gets a fixed gas
    ///         budget (`FlowSettleLib.sideGas`), and `settle` reverts `SettleSideOutOfGas` before a side whose whole
    ///         budget it cannot hand over, so a two-sided settle needs a gas LIMIT of about 2.5x what it uses. The coarse
    ///         sweep now runs from 600 % of use down to 45 % (about 9.4 % steps), and the fine sweep (0.4 % steps, 160
    ///         limits) starts 10 % above the lowest coarse limit that settled both sides, so it straddles the new
    ///         boundary, including the window where the first side fits and the second does not. Assertions unchanged.
    function test_RB20_theGasACallerSendsCannotChooseASide() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        _assertInvested("RB-20 gas sweep"); // the sale and the purchase trade every asset, down to the pools
        bytes memory data = abi.encodeCall(queue.settle, (SETTLE_MAX_REQUESTS, type(uint256).max));
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 g0 = gasleft();
        (bool ok,) = address(queue).call(data);
        uint256 used = g0 - gasleft();
        assertTrue(ok, "a full call settles");
        vm.revertToState(snap);
        emit log_named_uint("gas used by a full settle", used);
        // Coverage after every attempt (`verify`): the state diff of 20 two-sided settles in one checkpoint needs
        // more memory than the checkpoint's call has gas for (MemoryOOG with the check on). Same accesses checked.
        coverageCheckpoint();

        uint256 settled0 = queue.settlementCount();
        // both sides, deposit only, redemption only, guard, other revert, success that recorded no new settlement
        uint256[6] memory n;
        // The lowest coarse limit (per mille of `used`) that settled both sides; the fine sweep starts 10 % above it.
        uint256 lowestBoth = 6_000;
        for (uint256 k; k < 220; ++k) {
            // k < 60: 600 % down to 45.4 % in 9.4 % steps; then from lowestBoth + 10 % down in 0.4 % steps (never
            // starting under 70 %, so the 160 fine limits stay positive).
            uint256 fineTop = lowestBoth + 100 < 700 ? 700 : lowestBoth + 100;
            uint256 g = k < 60 ? used * (6_000 - 94 * k) / 1_000 : used * (fineTop - 4 * (k - 60)) / 1_000;
            if (k != 0) coverageCheckpoint();
            uint256 s = vm.snapshotState();
            vm.prank(keeper);
            (bool success, bytes memory ret) = address(queue).call{gas: g}(data);
            // `hardening` (step 3 plan §3.3 item 2): a successful call must have recorded exactly one new settlement
            // and returned its id. Before, the success branch read whatever settlement was last, so a call that
            // returned 0 (no side traded) was counted from an older settlement's numbers.
            if (success && (queue.settlementCount() != settled0 + 1 || abi.decode(ret, (uint256)) != settled0 + 1)) {
                ++n[5];
                emit log_named_uint("success with no new settlement, at gas limit", g);
            } else if (success) {
                Settlement memory st = queue.getSettlement(settled0 + 1);
                if (st.sharesMinted != 0 && st.sharesBurned != 0) {
                    ++n[0];
                    if (k < 60) lowestBoth = 6_000 - 94 * k;
                } else if (st.sharesMinted != 0) {
                    ++n[1];
                    emit log_named_uint("deposit side only, at gas limit", g);
                } else {
                    ++n[2];
                    emit log_named_uint("redemption side only, at gas limit", g);
                }
            } else {
                assertEq(queue.settlementCount(), settled0, "a failed call records nothing");
                assertEq(queue.getRequest(_depId).remaining, 20_000e6, "deposit untouched");
                assertEq(queue.getRequest(_redId).remaining, _bobShares / 2, "redemption untouched");
                if (_selector(ret) == IFlowEvents.SettleSideOutOfGas.selector) {
                    ++n[3];
                } else {
                    if (n[4] == 0) emit log_named_bytes("first other revert data", ret);
                    ++n[4];
                }
            }
            vm.revertToState(s);
        }
        emit log_named_uint("lowest coarse limit that settled both sides, per mille of use", lowestBoth);
        emit log_named_uint("limits that settled both sides", n[0]);
        emit log_named_uint("limits that settled the deposit side only", n[1]);
        emit log_named_uint("limits that settled the redemption side only", n[2]);
        emit log_named_uint("limits stopped by SettleSideOutOfGas", n[3]);
        emit log_named_uint("limits that ran out elsewhere", n[4]);
        emit log_named_uint("limits that succeeded with no new settlement", n[5]);
        assertEq(n[5], 0, "every successful call recorded one new settlement and returned its id");
        assertGt(n[0], 0, "some gas limit settled both sides (the sweep is not vacuous)");
        assertEq(n[1] + n[2], 0, "no gas limit settles one side only");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-21
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Bob exits his escrowed shares in kind with no in-kind allowance, so each lending leg becomes a claim on
    ///      a share of the position (E9), keyed to bob.
    function _bobPositionClaims() internal {
        _invest();
        _bobShares = _holder(bob, 30_000e6);
        timelockExecute(address(fund), abi.encodeCall(fund.setInKindAllowance, (0, 0, 6 hours)));
        uint256 id = openRedeemRequest(bob, _bobShares, 0);
        vm.prank(bob);
        queue.exitInKind(id);
        (uint256 units,) = fund.positionClaimOf(IDX_AAVE, bob);
        assertGt(units, 0, "bob holds a share of the Aave position");
        refreshFeeds();
    }

    /// @notice RB-21: the claim gains with the venue's interest and loses with a venue loss, pro rata with the
    ///         holders' part of the same position.
    function test_RB21_aPositionClaimGainsAndLosesWithTheVenueProRata() public fixtureCovered {
        _bobPositionClaims();
        (, uint256 claim0) = fund.positionClaimOf(IDX_AAVE, bob);
        (, uint256[] memory held0) = fund.heldBalances();
        vm.warp(block.timestamp + 30 days);
        refreshFeeds();
        (, uint256 claim1) = fund.positionClaimOf(IDX_AAVE, bob);
        (, uint256[] memory held1) = fund.heldBalances();
        assertGt(held1[IDX_AAVE], held0[IDX_AAVE], "the venue paid interest");
        assertGt(claim1, claim0, "the claim earned it too");
        assertApproxEqAbs(
            claim1 * held0[IDX_AAVE], claim0 * held1[IDX_AAVE], held0[IDX_AAVE] + held1[IDX_AAVE], "gain pro rata"
        );

        uint256 p = aaveAdapter.totalAssets();
        vm.mockCall(address(aaveAdapter), abi.encodeCall(IStrategyAdapter.totalAssets, ()), abi.encode(p * 9 / 10));
        (, uint256 claim2) = fund.positionClaimOf(IDX_AAVE, bob);
        (, uint256[] memory held2) = fund.heldBalances();
        vm.clearMockedCalls();
        assertApproxEqAbs(claim2, claim1 * 9 / 10, 2, "the claim lost 10 %");
        assertApproxEqAbs(held2[IDX_AAVE], held1[IDX_AAVE] * 9 / 10, 2, "the holders lost 10 %");
    }

    /// @notice RB-21: a deposit through the queue (which supplies Aave) and a rebalance step into Aave leave the
    ///         claim's units unchanged, and its value moves only with the venue's own rate.
    function test_RB21_aDepositOrAStepIntoTheVenueKeepsTheClaimsShare() public fixtureCovered {
        _bobPositionClaims();
        (uint256 units0, uint256 v0) = fund.positionClaimOf(IDX_AAVE, bob);
        uint256 rate0 = aaveAdapter.ratePerUnit();

        uint256 id = openDepositRequest(alice, 20_000e6, type(uint256).max);
        warpToSettleable(id);
        _settleNow();
        assertTrue(queue.getRequest(id).closed, "the deposit supplied Aave");
        (uint256 units1, uint256 v1) = fund.positionClaimOf(IDX_AAVE, bob);
        assertEq(units1, units0, "a deposit leaves the claim's units");
        assertApproxEqAbs(v1 * rate0, v0 * aaveAdapter.ratePerUnit(), rate0 * 2, "value moves only with the venue rate");

        uint256 rate1 = aaveAdapter.ratePerUnit();
        investFund(bucketVec(8_000, 2_000)); // a new plan steps more into Aave
        (uint256 units2, uint256 v2) = fund.positionClaimOf(IDX_AAVE, bob);
        assertEq(units2, units0, "a step leaves the claim's units");
        assertApproxEqAbs(v2 * rate1, v1 * aaveAdapter.ratePerUnit(), rate1 * 3, "value moves only with the venue rate");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-22 (and A19)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Moonwell at 5 % so its exclusion stays inside check 6's breaker.
    function _ledgerVector() internal pure returns (uint16[5] memory) {
        return [uint16(6_000), 500, 1_750, 1_750, 0];
    }

    /// @notice RB-22: when a record opens, every queued share counts for its owner: a redeemer whose escrowed
    ///         shares are burned afterwards keeps its claim; a depositor whose shares were in their hold keeps it; a
    ///         holder who transfers wallet shares while others are queued keeps the balance of the record; the fresh
    ///         address that received them gets nothing; the queue itself has no entitlement.
    function test_RB22_queuedSharesCountForTheirOwnerWhenARecordOpens() public fixtureCovered {
        investFund(_ledgerVector());
        uint256 aliceShares = _holder(alice, 30_000e6);
        uint256 bobShares = _holder(bob, 30_000e6);
        uint256 carolDep = openDepositRequest(carol, 10_000e6, type(uint256).max);
        warpToSettleable(carolDep);
        _settleNow();
        uint256 carolHeld = queue.queuedSharesOf(carol);
        assertGt(carolHeld, 0, "carol's shares are in their hold");
        coverageCheckpoint();
        uint256 ra = openRedeemRequest(alice, aliceShares, 0);
        openRedeemRequest(bob, bobShares / 2, 0);

        timelockExecute(
            address(fund), abi.encodeCall(fund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false))
        );
        uint256 id = fund.openExclusionOf(IDX_MOONWELL);
        assertGt(id, 0, "a record opened");
        FundExclusionLedger ledger = FundExclusionLedger(fund.exclusionLedger());

        // A transfer of wallet shares while other shares are queued.
        vm.prank(bob);
        fund.transfer(dave, bobShares - bobShares / 2);
        assertEq(ledger.balanceAt(bob, id), bobShares, "bob: wallet plus queued at the record");
        assertEq(ledger.balanceAt(dave, id), 0, "the fresh address: nothing");

        // The redemptions settle (deposits wait during the exclusion); the burned shares keep their claim.
        warpToSettleable(ra);
        _settleNow();
        assertTrue(queue.getRequest(ra).closed, "alice's shares burned");
        assertEq(ledger.balanceAt(alice, id), aliceShares, "the redeemer keeps its claim");
        assertEq(ledger.balanceAt(bob, id), bobShares, "bob keeps his");

        // Carol's held shares are delivered after the record: same entitlement.
        deliverAfterHold(carol);
        assertEq(ledger.balanceAt(carol, id), carolHeld, "the held depositor keeps its claim");
        assertEq(ledger.balanceAt(address(queue), id), 0, "the queue has no entitlement");
    }

    /// @notice RB-22 (A19): an address whose deposit fills after the record opened gets nothing from it, while the
    ///         holders of the record's moment can claim what the restore recovered.
    function test_RB22_anAddressFilledAfterARecordOpenedGetsNothing() public fixtureCovered {
        investFund(_ledgerVector());
        uint256 aliceShares = _holder(alice, 30_000e6);
        timelockExecute(
            address(fund), abi.encodeCall(fund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, false))
        );
        uint256 id = fund.openExclusionOf(IDX_MOONWELL);
        assertGt(id, 0, "a record opened");
        uint256 dep = openDepositRequest(erin, 10_000e6, type(uint256).max);
        warpToSettleable(dep);
        refreshFeeds();
        vm.prank(keeper);
        (SettleCheck check,) = queue.checkSettle();
        assertEq(uint8(check), uint8(SettleCheck.Ok), "the checks pass");
        assertEq(_keeperSettle(), 0, "deposits wait while Moonwell is excluded");

        // The admin restores Moonwell: the position drains into the record, which closes.
        timelockExecute(
            address(fund), abi.encodeCall(fund.setAdapterCodeHashAllowed, (address(moonwellAdapter).codehash, true))
        );
        assertEq(fund.openExclusionOf(IDX_MOONWELL), 0, "restored");
        _settleNow();
        assertTrue(queue.getRequest(dep).closed, "erin filled after the record");
        FundExclusionLedger ledger = FundExclusionLedger(fund.exclusionLedger());
        assertEq(ledger.balanceAt(erin, id), 0, "erin had nothing at the record");
        assertEq(ledger.claimable(id, erin), 0, "and can claim nothing");
        assertEq(ledger.balanceAt(alice, id), aliceShares, "alice held her shares at the record");
        assertGt(ledger.claimable(id, alice), 0, "alice claims her part of the recovery");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E8, E11, E18, E19, E20, E21, E22, E23
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice E8: a request filled in two settlements has two claims with two unlock times; the first delivers
    ///         while the second is still in its hold.
    function test_E8_aRequestFilledInTwoSettlementsHasTwoClaims() public fixtureCovered {
        uint256 a = openDepositRequest(alice, 400_000e6, type(uint256).max);
        warpToSettleable(a);
        _settleNow();
        uint256 epochLength = queue.flowParams().epochLength;
        vm.warp(block.timestamp + epochLength);
        _settleNow();
        assertTrue(queue.getRequest(a).closed, "filled in two settlements");
        assertEq(queue.claimCount(), 2, "two claims");
        Claim memory c1 = queue.getClaim(1);
        Claim memory c2 = queue.getClaim(2);
        assertEq(c1.requestId, a, "claim 1 of the request");
        assertEq(c2.requestId, a, "claim 2 of the request");
        assertTrue(c1.settlementId != c2.settlementId, "two settlements");
        assertEq(uint256(c2.unlockAt) - c1.unlockAt, epochLength, "two unlock times");

        vm.warp(c1.unlockAt);
        refreshFeeds();
        assertEq(queue.maxMint(alice), c1.shares, "only the first is deliverable");
        queue.mint(c1.shares, alice);
        assertEq(fund.balanceOf(alice), c1.shares, "first delivered");
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 1, 0));
        queue.mint(1, alice);
        vm.warp(c2.unlockAt);
        refreshFeeds();
        queue.mint(c2.shares, alice);
        assertEq(fund.balanceOf(alice), c1.shares + c2.shares, "second delivered at its own time");
    }

    /// @notice E11: a request under `minRequestUsdc` reverts; a deposit over the per-deposit cap reverts; both
    ///         edges are accepted; a redemption under the minimum (valued at the last good NAV) reverts unless it is
    ///         the caller's whole balance.
    function test_E11_requestSizes() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        (, uint256 perDepositCap,,) = fund.config();
        fundUsdc(alice, perDepositCap + p.minRequestUsdc + 1);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(queue), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(IFlowEvents.BelowMinRequest.selector, p.minRequestUsdc - 1, p.minRequestUsdc)
        );
        queue.requestDeposit(p.minRequestUsdc - 1, type(uint256).max, alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.AbovePerDepositCap.selector, perDepositCap + 1, perDepositCap));
        queue.requestDeposit(perDepositCap + 1, type(uint256).max, alice);
        queue.requestDeposit(p.minRequestUsdc, type(uint256).max, alice);
        queue.requestDeposit(perDepositCap, type(uint256).max, alice);
        vm.stopPrank();
        assertEq(queue.requestCount(), 2, "both edges accepted");

        uint256 shares = _holder(bob, 150e6);
        uint256 half = shares / 2;
        (uint256 nav,) = fund.lastGoodNav();
        uint256 value = half.mulDiv(nav, fund.totalSupply());
        assertLt(value, p.minRequestUsdc, "half is under the minimum");
        vm.startPrank(bob);
        fund.approve(address(queue), shares);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.BelowMinRequest.selector, value, p.minRequestUsdc));
        queue.requestRedeem(half, 0, bob);
        uint256 id = queue.requestRedeem(shares, 0, bob);
        vm.stopPrank();
        assertEq(queue.getRequest(id).amount, shares, "the whole balance is accepted");
    }

    /// @notice E18: an expired request cannot fill (a live request of a later epoch fills beside it), and only its
    ///         owner withdraws its escrow, once.
    function test_E18_anExpiredRequestCannotFillAndOnlyItsOwnerWithdrawsIt() public fixtureCovered {
        uint256 a = openDepositRequest(alice, 5_000e6, type(uint256).max);
        FlowParams memory p = queue.flowParams();
        vm.warp((uint256(queue.getRequest(a).epoch) + p.maxRoll + 1) * p.epochLength);
        assertEq(uint8(queue.requestStatus(a)), uint8(RequestStatus.Expired), "expired");
        uint256 b = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpToSettleable(b);
        _settleNow();
        assertTrue(queue.getRequest(b).closed, "the live request fills");
        assertEq(queue.getRequest(a).remaining, 5_000e6, "the expired one does not");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.NotRequestOwner.selector, a, bob));
        queue.withdrawExpired(a);
        vm.prank(alice);
        assertEq(queue.withdrawExpired(a), 5_000e6, "the owner withdraws the escrow");
        assertEq(IERC20(USDC).balanceOf(alice), 5_000e6, "to the owner");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.RequestNotPending.selector, a));
        queue.withdrawExpired(a);
        _assertBooks("E18");
    }

    /// @notice E19: after a warp with no feed update, `totalAssets` and both convert views revert with the stale
    ///         feed; `lastGoodNav` returns the NAV of the last flow and its time; `checkSettle` names the first failing
    ///         check in §5.9.3 order as the inputs are repaired one by one, and judges the caller.
    function test_E19_navViewsRevertOnAnUnhealthyFeed_lastGoodNav_checkSettle() public fixtureCovered {
        _pendingAtWindow();
        _keeperSettle();
        uint256 navAtFlow = fund.totalAssets();
        uint256 flowAt = block.timestamp;
        vm.warp(block.timestamp + ETH_FEED_MAX_AGE + 1);
        bytes memory stale = abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, IDX_WETH, FeedStatus.Stale);
        vm.expectRevert(stale);
        fund.totalAssets();
        vm.expectRevert(stale);
        fund.convertToShares(1e6);
        vm.expectRevert(stale);
        fund.convertToAssets(1e24);
        (uint256 nav, uint64 at) = fund.lastGoodNav();
        assertEq(nav, navAtFlow, "the NAV recorded at the last flow");
        assertEq(at, flowAt, "with its time");

        uint256 id = openDepositRequest(bob, 5_000e6, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
        uint256 t = block.timestamp;
        MockAggregator(FEED_SEQUENCER).setRound(0, 1, t, t);
        MockAggregator(FEED_ETH).setRound(8, int256(poolPrice8(WETH_POOL, WETH)), t - 2 * ETH_FEED_MAX_AGE, t - 2 * ETH_FEED_MAX_AGE);
        setUsdcFeedPrice(0.98e8);
        SettleCheck[4] memory order = [SettleCheck.Sequencer, SettleCheck.Feed, SettleCheck.UsdcPeg, SettleCheck.Ok];
        for (uint256 k; k < order.length; ++k) {
            vm.prank(keeper);
            (SettleCheck check, uint256 index) = queue.checkSettle();
            assertEq(uint8(check), uint8(order[k]), "the first failing check, in order");
            if (order[k] == SettleCheck.Feed) assertEq(index, IDX_WETH, "the stale asset");
            if (k == 0) MockAggregator(FEED_SEQUENCER).setRound(0, 0, sequencerUpSince, t);
            if (k == 1) MockAggregator(FEED_ETH).setRound(8, int256(poolPrice8(WETH_POOL, WETH)), t, t);
            if (k == 2) setUsdcFeedPrice(1e8);
        }
        vm.prank(stranger);
        (SettleCheck forStranger,) = queue.checkSettle();
        assertEq(uint8(forStranger), uint8(SettleCheck.Caller), "judged for the caller");
        assertGt(fund.totalAssets(), 0, "healthy again");
    }

    /// @notice E20: requests from three epochs left unsettled settle under one period's cap, oldest first; a second
    ///         call in that period fills nothing more; the next period continues.
    function test_E20_aBacklogOfThreeEpochsSettlesUnderOnePeriodsCap() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        uint256[3] memory ids;
        address[3] memory users = [alice, bob, carol];
        for (uint256 k; k < 3; ++k) {
            ids[k] = openDepositRequest(users[k], 150_000e6, type(uint256).max);
            vm.warp(block.timestamp + p.epochLength);
        }
        warpToSettleable(ids[2]);
        _settleNow();
        uint256 period = block.timestamp / p.epochLength;
        (uint256 dep,) = queue.periodFlow(period);
        assertEq(dep, p.epochFlowFloorUsdc, "one period's cap, not three");
        assertTrue(queue.getRequest(ids[0]).closed, "oldest filled first");
        assertEq(queue.getRequest(ids[1]).remaining, 450_000e6 - 150_000e6 - dep, "then the next, in part");
        assertEq(queue.getRequest(ids[2]).remaining, 150_000e6, "the newest waits");
        assertEq(_keeperSettle(), 0, "no more in this period");
        vm.warp(block.timestamp + p.epochLength);
        _settleNow();
        assertTrue(queue.getRequest(ids[1]).closed, "next period: the second");
        assertTrue(queue.getRequest(ids[2]).closed, "and the third");
    }

    /// @notice E20: a seeded fund (NAV 100 000 USDC, 5 % = 5 000) takes a deposit up to the floor in one settlement.
    function test_E20_aSeededFundTakesADepositUpToTheFloor() public fixtureCovered {
        FlowParams memory p = queue.flowParams();
        (uint256 nav,,) = fund.portfolioValues();
        assertLt(nav.mulDiv(p.maxEpochFlowBps, BPS), p.epochFlowFloorUsdc, "the floor is the cap here");
        uint256 a = openDepositRequest(alice, p.epochFlowFloorUsdc, type(uint256).max);
        warpToSettleable(a);
        _settleNow();
        assertTrue(queue.getRequest(a).closed, "filled in one settlement");
    }

    /// @notice E21: a quote is never better than what a settlement in the same block allows: the deposit quote's
    ///         price is at or above the settlement's bound and the realized cost per share; the redemption quote's
    ///         price is at or below the bound and the realized proceeds per share; the worst amounts hold.
    function test_E21_aQuoteIsNeverBetterThanASettlementInTheSameBlock() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        uint256 u = queue.getRequest(_depId).amount;
        uint256 x = queue.getRequest(_redId).amount;
        Quote memory qd = queue.quoteDeposit(u);
        Quote memory qr = queue.quoteRedeem(x);
        uint256 claims0 = queue.claimCount();
        uint256 sid = _keeperSettle();
        Settlement memory st = queue.getSettlement(sid);
        assertGe(qd.boundPrice, st.depositBoundPrice, "deposit quote at or above the bound");
        assertLe(qr.boundPrice, st.redeemBoundPrice, "redemption quote at or below the bound");
        for (uint256 c = claims0 + 1; c <= queue.claimCount(); ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.kind == RequestKind.Deposit) {
                assertLe(cl.usdc.mulDiv(PRICE_SCALE, cl.shares, Math.Rounding.Ceil), qd.boundPrice, "cost per share");
                assertGe(cl.shares, qd.worstAmount, "at least the quoted shares");
            } else {
                assertGe(cl.usdc.mulDiv(PRICE_SCALE, cl.shares), qr.boundPrice, "proceeds per share");
                assertGe(cl.usdc, qr.worstAmount, "at least the quoted USDC");
            }
        }
        assertEq(qd.feeBps, 0, "no deposit fee class");
        assertEq(qr.feeBps, EXIT_FEE_BPS, "the exit fee");
    }

    /// @notice E2 / proposal §5.9.6 (`hardening`, step 3 plan §3.3 item 6): the queue's four ERC-4626 previews revert
    ///         `PreviewNotSupported` for every amount and every caller, before and after a settlement, so no
    ///         integrator can read a synchronous price from the asynchronous queue. The quotes (E21) are the only
    ///         price views.
    function test_E2_theQueuesFourPreviewsRevert() public fixtureCovered {
        uint256[4] memory amounts = [uint256(0), 1, 5_000e6, type(uint256).max];
        address[2] memory callers = [stranger, alice];
        for (uint256 round; round < 2; ++round) {
            if (round == 1) {
                // A settlement exists and alice holds a claim: the previews still say nothing.
                _pendingAtWindow();
                assertGt(_keeperSettle(), 0, "a settlement was recorded");
            }
            for (uint256 c; c < callers.length; ++c) {
                for (uint256 k; k < amounts.length; ++k) {
                    _assertPreviewReverts(callers[c], abi.encodeCall(queue.previewDeposit, (amounts[k])), "deposit");
                    _assertPreviewReverts(callers[c], abi.encodeCall(queue.previewMint, (amounts[k])), "mint");
                    _assertPreviewReverts(callers[c], abi.encodeCall(queue.previewRedeem, (amounts[k])), "redeem");
                    _assertPreviewReverts(callers[c], abi.encodeCall(queue.previewWithdraw, (amounts[k])), "withdraw");
                }
            }
        }
    }

    /// @dev `data` (a preview call) by `caller` must revert with exactly `PreviewNotSupported()`.
    function _assertPreviewReverts(address caller, bytes memory data, string memory which) internal {
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(queue).call(data);
        assertFalse(ok, string.concat("preview", which, " must revert"));
        assertEq(ret, abi.encodeWithSelector(IFlowEvents.PreviewNotSupported.selector), string.concat("preview", which));
    }

    /// @notice E22: an owner that cannot receive USDC (blacklisted by USDC) blocks nobody else: requests owned by it
    ///         settle beside the others, its refunds and proceeds wait as credit and claims it pulls, others withdraw
    ///         theirs, and it can still take its USDC to a receiver it names.
    function test_E22_anOwnerThatCannotReceiveUsdcBlocksNobodyElse() public fixtureCovered {
        address mallory = makeAddr("mallory");
        // FiatToken keeps the blacklist flag in the top bit of the balance slot (mapping at slot 9). Read the slot
        // through the token first, so the recorder fetches it and the replay's coverage check finds it.
        assertEq(IERC20(USDC).balanceOf(mallory), 0, "a fresh address");
        vm.store(USDC, keccak256(abi.encode(mallory, uint256(9))), bytes32(uint256(1) << 255));
        fundUsdc(dave, 1e6);
        vm.prank(dave);
        vm.expectRevert();
        IERC20(USDC).transfer(mallory, 1e6);

        _invest();
        // Dave pays for a deposit mallory owns; alice deposits for herself.
        fundUsdc(dave, 10_000e6);
        vm.startPrank(dave);
        IERC20(USDC).approve(address(queue), 10_000e6);
        uint256 m = queue.requestDeposit(10_000e6, type(uint256).max, mallory);
        vm.stopPrank();
        uint256 a = openDepositRequest(alice, 10_000e6, type(uint256).max);
        warpToSettleable(a);
        _settleNow();
        assertTrue(queue.getRequest(m).closed, "mallory's request settled");
        assertTrue(queue.getRequest(a).closed, "alice's request settled");
        (uint256 aliceCredit,) = queue.creditOf(alice);
        if (aliceCredit != 0) {
            vm.prank(alice);
            queue.withdrawCredit();
        }
        (uint256 malloryCredit,) = queue.creditOf(mallory);
        if (malloryCredit != 0) {
            vm.prank(mallory);
            vm.expectRevert();
            queue.withdrawCredit();
        }
        uint256 malloryShares = deliverAfterHold(mallory);
        assertGt(malloryShares, 0, "shares delivered to mallory");
        uint256 aliceShares = deliverAfterHold(alice);

        // Both redeem; mallory's USDC waits as her claim; alice takes hers; mallory sends hers to a receiver.
        uint256 rm = openRedeemRequest(mallory, malloryShares, 0);
        openRedeemRequest(alice, aliceShares, 0);
        warpToSettleable(rm);
        _settleNow();
        uint256 aliceUsdc = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        uint256 paid = queue.redeem(aliceShares, alice, alice);
        assertEq(IERC20(USDC).balanceOf(alice), aliceUsdc + paid, "alice paid");
        vm.prank(mallory);
        vm.expectRevert();
        queue.redeem(malloryShares, mallory, mallory);
        vm.prank(mallory);
        uint256 got = queue.redeem(malloryShares, erin, mallory);
        assertEq(IERC20(USDC).balanceOf(erin), got, "mallory pulls to a receiver she names");
        _assertBooks("E22");
    }

    /// @notice E23: an in-kind exit through the queue still works when one venue's value read reverts (that leg
    ///         becomes a claim on bob's units; the others pay), and a zero receiver is refused.
    function test_E23_inKindExitSurvivesARevertingVenueRead_andRefusesAZeroReceiver() public fixtureCovered {
        _invest();
        uint256 shares = _holder(bob, 30_000e6);
        uint256 id = openRedeemRequest(bob, shares / 2, 0);
        vm.mockCallRevert(address(aaveAdapter), abi.encodeCall(IStrategyAdapter.totalAssets, ()), "venue down");
        uint256 usdc0 = IERC20(USDC).balanceOf(bob);
        vm.prank(bob);
        queue.exitInKind(id);
        vm.clearMockedCalls();
        (uint256 units,) = fund.positionClaimOf(IDX_AAVE, bob);
        assertGt(units, 0, "the unreadable leg became bob's claim");
        (uint256 moonwellUnits,) = fund.positionClaimOf(IDX_MOONWELL, bob);
        assertEq(moonwellUnits, 0, "a readable venue paid in USDC");
        assertGt(IERC20(USDC).balanceOf(bob), usdc0, "the USDC leg paid");
        assertGt(IERC20(WETH).balanceOf(bob), 0, "wETH paid");
        assertTrue(queue.getRequest(id).closed, "exited");

        uint256 rest = fund.balanceOf(bob);
        vm.prank(bob);
        vm.expectRevert(IFundEvents.ZeroAddress.selector);
        fund.redeemInKind(rest, address(0), bob);
        _assertBooks("E23");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Rounding
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Rounding: twenty minimum-size deposits in one epoch, then twenty whole-balance redemptions: every
    ///         fill pays at least the batch's average price per share and receives at most it, the fills never sum
    ///         above what the fund minted or paid, and no amount per share falls.
    function test_rounding_manyMinimumSizeRequestsNeverFavourTheFlow() public fixtureCovered {
        _invest();
        uint256 n = 20;
        address[] memory users = new address[](n);
        uint256 minUsdc = queue.flowParams().minRequestUsdc;
        uint256 first;
        for (uint256 k; k < n; ++k) {
            users[k] = makeAddr(string.concat("min-user-", vm.toString(k)));
            uint256 id = openDepositRequest(users[k], minUsdc, type(uint256).max);
            if (k == 0) first = id;
        }
        warpToSettleable(first);
        refreshFeeds();
        FundSnap memory f0 = _fundSnap();
        uint256 claims0 = queue.claimCount();
        uint256 sid = _keeperSettle();
        _assertBatchRounding(sid, claims0, true);
        _assertPerShareNotLower(f0, "min-size deposits");
        coverageCheckpoint();

        uint256 latest = queue.getClaim(queue.claimCount()).unlockAt;
        warpForward(latest);
        refreshFeeds();
        for (uint256 k; k < n; ++k) {
            uint256 x = queue.maxMint(users[k]);
            queue.mint(x, users[k]);
            uint256 id = openRedeemRequest(users[k], x, 0);
            if (k == 0) first = id;
        }
        warpToSettleable(first);
        refreshFeeds();
        f0 = _fundSnap();
        claims0 = queue.claimCount();
        sid = _keeperSettle();
        _assertBatchRounding(sid, claims0, false);
        _assertPerShareNotLower(f0, "min-size redemptions");
        _assertBooks("rounding");
    }

    /// @dev Every fill of settlement `sid` against the batch: a deposit pays at least `usdcIn / sharesMinted` per
    ///      share, a redemption receives at most `usdcOut / sharesBurned`, and the fills sum to no more than the batch.
    function _assertBatchRounding(uint256 sid, uint256 claims0, bool isDeposit) internal view {
        Settlement memory st = queue.getSettlement(sid);
        uint256 sumShares;
        uint256 sumUsdc;
        uint256 fills = queue.claimCount() - claims0;
        for (uint256 c = claims0 + 1; c <= queue.claimCount(); ++c) {
            Claim memory cl = queue.getClaim(c);
            sumShares += cl.shares;
            sumUsdc += cl.usdc;
            if (isDeposit) {
                assertGe(cl.usdc * st.sharesMinted, st.usdcIn * cl.shares, "a depositor pays at least the average");
            } else {
                assertLe(cl.usdc * st.sharesBurned, st.usdcOut * cl.shares, "a redeemer gets at most the average");
            }
        }
        if (isDeposit) {
            assertLe(sumShares, st.sharesMinted, "deposit fills never sum above the mint");
            assertLe(sumUsdc, st.usdcIn + fills, "deposit costs exceed the spend by at most one unit per fill");
            assertGe(sumUsdc, st.usdcIn, "deposit costs never sum below the spend");
        } else {
            assertEq(sumShares, st.sharesBurned, "every burned share is someone's");
            assertLe(sumUsdc, st.usdcOut, "redemption fills never sum above the proceeds");
        }
    }

    /// @notice Rounding: a lending venue that rounds two units against the fund on every supply and withdrawal
    ///         (`MechAaveAdapter.ROUND_AGAINST`, on top of Aave's own rounding) never fails the proportion check:
    ///         both sides settle and no amount per share falls.
    function test_rounding_venueRoundingOfTwoUnitsNeverFailsTheProportionCheck() public fixtureCovered {
        investFund(bucketVec(6_500, 3_500));
        _bobShares = _holder(bob, 50_000e6);
        MechAaveAdapter mech = _etchAaveMech();
        mech.setMode(mech.ROUND_AGAINST(), LENDING_ROUNDING_UNITS);
        _redId = openRedeemRequest(bob, _bobShares / 2, 0);
        _depId = openDepositRequest(alice, 20_000e6, type(uint256).max);
        warpToSettleable(_depId);
        refreshFeeds();
        FundSnap memory f0 = _fundSnap();
        vm.recordLogs();
        uint256 sid = _keeperSettle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 depFails,) = _sideFailed(logs, RequestKind.Deposit);
        (uint256 redFails,) = _sideFailed(logs, RequestKind.Redeem);
        assertEq(depFails, 0, "deposit side settled");
        assertEq(redFails, 0, "redemption side settled");
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.sharesMinted, 0, "minted");
        assertGt(st.sharesBurned, 0, "burned");
        uint256 shortBy = mech.lastSupplyAsked() - mech.lastSupplyCredited();
        emit log_named_uint("units the venue kept on the supply", shortBy);
        assertGe(shortBy, 1, "the venue rounded against the fund");
        assertLe(shortBy, LENDING_ROUNDING_UNITS, "by at most two units");
        _assertPerShareNotLower(f0, "venue rounding");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Reentrancy
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Every recorded re-entry attempt failed: into the queue on its one lock (or its self-call guard), into
    ///      the fund on its lock or its role check.
    function _assertEveryReentryFailed(MechReentry probe, string memory label) internal view {
        uint256 n = probe.attemptCount();
        assertGt(n, 0, string.concat(label, ": the venue tried to re-enter"));
        for (uint256 k; k < n; ++k) {
            MechReentry.Attempt memory at = probe.attemptAt(k);
            assertFalse(at.ok, string.concat(label, ": a re-entry succeeded"));
            bool guarded = at.err == ReentrancyGuardUpgradeable.ReentrancyGuardReentrantCall.selector
                || (at.target == address(fund) && at.err == IAccessControl.AccessControlUnauthorizedAccount.selector);
            assertTrue(guarded, string.concat(label, ": refused by a lock or a role"));
        }
    }

    /// @notice Reentrancy: a hostile venue callback during `mintInKind` (exact-output purchases) and during the
    ///         sale (exact-input sales) tries every queue entry point and the fund's flow functions: each is refused,
    ///         the settlement completes once, and the books match.
    function test_reentrancy_aHostileCallbackDuringMintInKindOrTheSaleCannotReenter() public fixtureCovered {
        _twoSidedSetup(bucketVec(6_500, 3_500));
        MechSwapAdapter mech = _etchSwapMech();
        mech.arm(address(queue), address(fund), alice, _depId);
        uint256 supply0 = fund.totalSupply();
        uint256 sid = _keeperSettle();
        Settlement memory st = queue.getSettlement(sid);
        assertGt(st.sharesMinted, 0, "the deposit side settled once");
        assertGt(st.sharesBurned, 0, "the redemption side settled once");
        assertEq(fund.totalSupply(), supply0 + st.sharesMinted - st.sharesBurned, "minted and burned once");
        assertEq(queue.settlementCount(), 1 + sid - 1, "one settlement");
        _assertEveryReentryFailed(mech, "swap venue");
        _assertBooks("reentrancy: settle");
    }

    /// @notice Reentrancy: a hostile lending venue called during an in-kind exit from the queue (the claim path
    ///         that hands control to outside code: the fund withdraws the lending leg) cannot re-enter the queue or
    ///         the fund; the owner is paid once. The other claim paths (`deposit`, `mint`, `redeem`,
    ///         `withdrawCredit`, `withdrawExpired`) move only USDC and the fund's own shares, which call no outside code.
    function test_reentrancy_aHostileVenueDuringAClaimCannotReenter() public fixtureCovered {
        _invest();
        uint256 shares = _holder(bob, 30_000e6);
        MechAaveAdapter mech = _etchAaveMech();
        uint256 id = openRedeemRequest(bob, shares / 2, 0);
        mech.arm(address(queue), address(fund), bob, id);
        uint256 supply0 = fund.totalSupply();
        uint256 queueShares = fund.balanceOf(address(queue));
        vm.prank(bob);
        queue.exitInKind(id);
        assertEq(fund.totalSupply(), supply0 - shares / 2, "burned once");
        assertEq(fund.balanceOf(address(queue)), queueShares - shares / 2, "the escrow left once");
        assertTrue(queue.getRequest(id).closed, "closed");
        _assertEveryReentryFailed(mech, "lending venue");
        _assertBooks("reentrancy: exitInKind");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Queue additions the queue agent asked to cover (notes/queue.md §4 item 9)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice `setFlowParams` refuses a window plus grace that reaches the expiry of a request (`maxRoll ×
    ///         epochLength`), which would let every request expire before anyone may settle it (field 7).
    function test_setFlowParams_refusesAWindowAndGraceThatOutlastExpiry() public fixtureCovered {
        FlowParams memory p = defaultFlowParams();
        p.maxRoll = 1; // 1 h window + 6 h grace >= 1 × 6 h
        _timelockExpectRevert(
            address(queue),
            abi.encodeCall(queue.setFlowParams, (p)),
            abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 7)
        );
        p.maxRoll = 2; // 7 h < 12 h
        timelockExecute(address(queue), abi.encodeCall(queue.setFlowParams, (p)));
        assertEq(queue.flowParams().maxRoll, 2, "accepted");
    }
}

/// @notice The Uniswap V3 pool's `mint` (RB-17 liquidity test).
interface IUniswapV3PoolMint {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
}

/// @title FlowQueueSeedTest
/// @notice E14 on a fund the harness does not seed.
contract FlowQueueSeedTest is FlowQueueBase {
    function _seedUsdc() internal pure override returns (uint256) {
        return 0;
    }

    /// @dev Seed `usdc` through the timelock (the admin), expecting `err` when non-empty.
    function _timelockSeed(uint256 usdc, bytes memory err) internal {
        fundUsdc(address(timelock), usdc);
        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        targets[0] = USDC;
        targets[1] = address(fund);
        payloads[0] = abi.encodeCall(IERC20.approve, (address(fund), usdc));
        payloads[1] = abi.encodeCall(fund.seed, (usdc));
        if (err.length == 0) {
            timelockExecuteBatch(targets, values, payloads);
            return;
        }
        bytes32 salt = keccak256(abi.encode("mechanism-tests seed", usdc, block.timestamp));
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        vm.expectRevert(err);
        timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
    }

    /// @notice E14: an unseeded fund cannot mint in kind and cannot settle; `seed` is ADMIN only, at least
    ///         `minSeedUsdc`, once; its shares belong to the fund and never move, also after flows.
    function test_E14_seedOnceAtZeroSupplyAtOrAboveTheMinimum_andItsSharesNeverMove() public fixtureCovered {
        assertEq(fund.totalSupply(), 0, "unseeded");
        uint256 n = fund.assetCount();
        vm.prank(address(queue));
        vm.expectRevert(IRobotMoneyFund.NotSeeded.selector);
        fund.mintInKind(1, 0, new uint256[](n));

        uint256 id = openDepositRequest(alice, 1_000e6, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
        _expectBlocked(keeper, SettleCheck.SharePrice, IDLE_INDEX); // check 7 has no supply to bound with

        uint256 minSeed = fund.minSeedUsdc();
        fundUsdc(stranger, minSeed);
        vm.startPrank(stranger);
        IERC20(USDC).approve(address(fund), minSeed);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.ADMIN_ROLE)
        );
        fund.seed(minSeed);
        vm.stopPrank();
        _timelockSeed(minSeed - 1, abi.encodeWithSelector(IRobotMoneyFund.SeedBelowMinimum.selector, minSeed - 1, minSeed));
        _timelockSeed(minSeed, "");
        assertEq(fund.totalSupply(), minSeed * 1e18, "minted at the share scale");
        assertEq(fund.balanceOf(address(fund)), minSeed * 1e18, "to the fund itself");
        _timelockSeed(minSeed, abi.encodeWithSelector(IRobotMoneyFund.AlreadySeeded.selector));

        vm.prank(address(fund));
        vm.expectRevert(IRobotMoneyFund.SeedSharesLocked.selector);
        fund.transfer(alice, 1);
        vm.prank(address(fund));
        vm.expectRevert(IRobotMoneyFund.SeedSharesLocked.selector);
        fund.redeemInKind(1, alice, address(fund));

        // Flows after the seed leave the fund's own shares where they are.
        refreshFeeds();
        _keeperSettle();
        assertTrue(queue.getRequest(id).closed, "the waiting deposit settles once seeded");
        assertEq(fund.balanceOf(address(fund)), minSeed * 1e18, "seed shares unchanged");
    }
}

/// @title FlowQueueRandomSeedFuzzTest
/// @notice RB-13 with an UNFIXED fuzz seed (`hardening`, step 3 plan §3.3 item 3): every `forge test` draws new
///         deposit sizes and redemption fractions, unlike `FlowQueueTest.testFuzz_RB13_*`, whose fixed seed replays the
///         inputs the recorder drew.
///
///         Why the holdings are fixed here (setUp invests once, the default 65 / 35 plan). Replay serves only the
///         state the fixture recorded, and a random input must not wander onto state it never saw. With the plan
///         fixed, every input reads a subset of what the largest input reads: the deposit's exact-output purchases
///         and the redemption's sales stay inside the tick range the largest deposit crosses from the same start,
///         Morpho's supply and withdraw queues visit a prefix of the markets the largest amounts visit, and Aave and
///         Comet read the same slots at any size. The number of pool trades, so the oracle's write positions and
///         every time warp, is the same for every input. `test_RB13_unfixedSeedCorners_*` runs the largest and the
///         smallest inputs, so the recorder's fork run puts both ends in the fixture. A slot outside them still
///         fails with `FixtureSlotMiss` naming it: that is a recording gap to report, never a skip.
///         The fixed-seed variant keeps the holdings as a fuzz input (the plan's stable / protocol split).
contract FlowQueueRandomSeedFuzzTest is FlowQueueBase {
    using Math for uint256;

    /// @dev The default `minRequestUsdc`.
    uint256 internal constant MIN_DEPOSIT = 100e6;
    /// @dev The default `epochFlowFloorUsdc`: the cap of one period at this NAV, so one settlement fills it.
    uint256 internal constant MAX_DEPOSIT = 250_000e6;

    function setUp() public override {
        super.setUp();
        _invest();
        _assertInvested("unfixed-seed setUp");
        // The plan's own trades moved the pools; model an outside market that caught up (as the fixed-seed variant
        // does). Check 4 is not this test's subject.
        alignFeedsToPools();
        refreshFeeds();
    }

    /// @notice The two ends of the unfixed-seed variant's input range: the largest deposit redeemed in full, then
    ///         (from the same state) the smallest deposit with the smallest fraction. Both keep every amount per share.
    function test_RB13_unfixedSeedCorners_largestAndSmallestFlows() public fixtureCovered {
        uint256 snap = vm.snapshotState();
        _depositThenRedeem(MAX_DEPOSIT, BPS, "largest");
        vm.revertToState(snap);
        _depositThenRedeem(MIN_DEPOSIT, 1, "smallest");
    }

    /// @notice RB-13 over a random deposit size (100 to 250 000 USDC) and a random fraction of the delivered shares
    ///         redeemed, with a fresh seed on every run (no `fuzz.seed` in the inline config or the profile).
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_RB13_unfixedSeed_depositThenRedeemKeepsEveryAmountPerShare(uint256 usdc, uint256 redeemBps)
        public
        fixtureCovered
    {
        usdc = bound(usdc, MIN_DEPOSIT, MAX_DEPOSIT);
        redeemBps = bound(redeemBps, 1, BPS);
        _depositThenRedeem(usdc, redeemBps, "random");
    }

    /// @dev Alice deposits `usdc` (any price), takes her shares after the hold, redeems `redeemBps` of them (her
    ///      whole balance when that slice is under the minimum request), and every settlement keeps every amount
    ///      per share, fills inside its limit and leaves the queue's books equal to its balances.
    function _depositThenRedeem(uint256 usdc, uint256 redeemBps, string memory label) internal {
        coverageCheckpoint();
        uint256 claims0 = queue.claimCount();
        uint256 id = openDepositRequest(alice, usdc, type(uint256).max);
        warpToSettleable(id);
        refreshFeeds();
        FundSnap memory f0 = _fundSnap();
        _settleOverBlocks(id, string.concat(label, ": the deposit settled"));
        assertTrue(queue.getRequest(id).closed, string.concat(label, ": deposit filled"));
        _assertPerShareNotLower(f0, string.concat(label, ": deposit"));
        _assertClaimsInsideLimits(claims0);
        // The fixed-seed variant's market model after the deposit: the outside market catches up with the pools.
        alignFeedsToPools();

        uint256 shares = deliverAfterHold(alice);
        assertGt(shares, 0, string.concat(label, ": shares delivered"));
        uint256 x = shares.mulDiv(redeemBps, BPS);
        (uint256 nav,) = fund.lastGoodNav();
        if (x == 0 || x.mulDiv(nav, fund.totalSupply()) < queue.flowParams().minRequestUsdc) x = shares;
        claims0 = queue.claimCount();
        uint256 r = openRedeemRequest(alice, x, 0);
        warpToSettleable(r);
        refreshFeeds();
        f0 = _fundSnap();
        _settleOverBlocks(r, string.concat(label, ": the redemption settled"));
        assertTrue(queue.getRequest(r).closed, string.concat(label, ": redemption filled"));
        _assertPerShareNotLower(f0, string.concat(label, ": redemption"));
        _assertClaimsInsideLimits(claims0);
        _assertBooks(label);
    }
}

/// @title FlowQueueRealFeedsTest
/// @notice Checks 2 and 4 of proposal §5.9.3 against the REAL Chainlink feeds at the pin, with no mock (`hardening`,
///         step 3 plan §3.3 item 1).
///
///         The harness places a `MockAggregator` at every feed address in its setUp. This contract reads each feed
///         proxy's real code and the six storage words the mock overwrites (slots 0 to 5; the fixture holds all six)
///         before the harness runs, and puts them back after it. From then on every feed read goes through the real
///         `EACAggregatorProxy` to its real aggregator, at the pin, exactly as the fixture recorded it.
///
///         Time. A request can settle only once its epoch's window has ended (7 h at the defaults), while the ETH /
///         USD feed has a 25-minute `maxFeedAge`. So the one deposit request is placed with time moved back by one
///         epoch plus the window, and time then returns to where setUp left it: the pin plus setUp's timelock delays
///         (logged). Placing a request touches no feed, pool or venue (it escrows USDC and records its epoch), so the
///         settlement reads the chain exactly as it stood at the pin. No test here calls `refreshFeeds`, `settleAll`
///         or any other mock helper.
contract FlowQueueRealFeedsTest is FlowQueueBase {
    using Math for uint256;

    /// @dev The storage words `MockAggregator.setRound` writes (slots 0 to 5).
    uint256 private constant MOCK_WORDS = 6;

    /// @dev The pin's timestamp (fixture meta, or the fork's block on the recorder's run).
    uint256 internal pinTime;

    /// @dev The independent reading of checks 2 to 4 for one basket asset.
    struct AssetReading {
        uint256 feed8;
        uint256 feedAge;
        uint256 feedUsdcPerToken;
        uint256 spotUsdcPerToken;
        uint256 twapUsdcPerToken;
        uint256 spotGapBps;
        uint256 twapGapBps;
        uint8 inBand;
        bool twapOk;
    }

    function setUp() public override {
        address[4] memory feeds = [FEED_ETH, FEED_CBBTC, FEED_USDC, FEED_SEQUENCER];
        (bytes[4] memory code, bytes32[MOCK_WORDS][4] memory words, uint256 pin) = _captureRealFeeds(feeds);
        super.setUp();
        pinTime = pin;
        for (uint256 i; i < feeds.length; ++i) {
            vm.etch(feeds[i], code[i]);
            for (uint256 j; j < MOCK_WORDS; ++j) {
                vm.store(feeds[i], bytes32(j), words[i][j]);
            }
        }
    }

    /// @dev Load the pin's state the way `BaseFixture.setUp` will (the fixture in replay, a fork of the pin on the
    ///      recorder's run) and read each feed's code and its first six storage words.
    function _captureRealFeeds(address[4] memory feeds)
        private
        returns (bytes[4] memory code, bytes32[MOCK_WORDS][4] memory words, uint256 pin)
    {
        string memory rpc = vm.envOr("PROTO_RECORD_RPC", string(""));
        if (bytes(rpc).length != 0) {
            vm.createSelectFork(rpc, vm.envUint("PROTO_PIN"));
            pin = block.timestamp;
        } else {
            vm.loadAllocs(ALLOC_PATH);
            pin = vm.parseJsonUint(vm.readFile(META_PATH), ".timestamp");
        }
        for (uint256 i; i < feeds.length; ++i) {
            code[i] = feeds[i].code;
            require(code[i].length != 0, "real feed: no code at the pin");
            for (uint256 j; j < MOCK_WORDS; ++j) {
                words[i][j] = vm.load(feeds[i], bytes32(j));
            }
        }
    }

    /// @dev One deposit request placed one epoch plus the window before now, so its window has ended now.
    function _requestEndedByNow(uint256 usdc) internal returns (uint256 id) {
        uint256 t0 = block.timestamp;
        FlowParams memory p = queue.flowParams();
        vm.warp(t0 - p.epochLength - p.settleWindow);
        id = openDepositRequest(alice, usdc, type(uint256).max);
        vm.warp(t0);
        assertLe(queue.settleableAt(queue.getRequest(id).epoch), t0, "the request's window has ended");
    }

    /// @dev Checks 2 to 4 for basket asset `i`, read here from the same feeds and pool, with the queue's parameters.
    function _read(uint256 i, uint256 usdc8, FlowParams memory p) internal returns (AssetReading memory a) {
        AssetConfig memory cfg = fund.assetConfig(i);
        (, int256 answer,, uint256 updatedAt,) = IRealAggregator(cfg.feed).latestRoundData();
        a.feedAge = block.timestamp - updatedAt;
        FeedStatus st;
        (st, a.feed8) = FeedLib.read(cfg.feed, cfg.maxFeedAge);
        assertEq(uint8(st), uint8(FeedStatus.Ok), "check 2: the real basket feed is healthy at the pin");
        assertEq(a.feed8, uint256(answer), "an 8-decimal feed");
        uint256 unit = 10 ** IERC20Metadata(cfg.token).decimals();
        a.feedUsdcPerToken = a.feed8.mulDiv(1e6, usdc8);
        (, int24 spot,,,,,) = IHarnessV3Pool(cfg.pool).slot0();
        a.spotUsdcPerToken = TwapTickMath.priceFromTick(spot, cfg.token, USDC, unit);
        int24 med;
        (a.twapOk, med, a.inBand) = TwapSlicesLib.median(cfg.pool, p.settleWindow, p.slices, p.dispersionBps);
        a.twapUsdcPerToken = TwapTickMath.priceFromTick(med, cfg.token, USDC, unit);
        a.spotGapBps = _gapBps(a.spotUsdcPerToken, a.feedUsdcPerToken);
        a.twapGapBps = _gapBps(a.twapUsdcPerToken, a.feedUsdcPerToken);
        string memory name = i == IDX_WETH ? "wETH" : "cbBTC";
        emit log_named_uint(string.concat(name, ": feed age at the settlement (s)"), a.feedAge);
        emit log_named_decimal_uint(string.concat(name, ": feed, USD per token"), a.feed8, 8);
        emit log_named_decimal_uint(string.concat(name, ": feed, USDC per token"), a.feedUsdcPerToken, 6);
        emit log_named_decimal_uint(string.concat(name, ": pool spot (slot0), USDC per token"), a.spotUsdcPerToken, 6);
        emit log_named_decimal_uint(string.concat(name, ": slice-median TWAP, USDC per token"), a.twapUsdcPerToken, 6);
        emit log_named_uint(string.concat(name, ": gap spot vs feed (bps, rounded up)"), a.spotGapBps);
        emit log_named_uint(string.concat(name, ": gap TWAP vs feed (bps, rounded up; check 4 compares it)"), a.twapGapBps);
        emit log_named_uint(string.concat(name, ": slices inside the dispersion band (check 3)"), a.inBand);
    }

    /// @dev `|x − ref| / ref` in bps, rounded up (check 4's own rounding).
    function _gapBps(uint256 x, uint256 ref) internal pure returns (uint256) {
        return (x > ref ? x - ref : ref - x).mulDiv(BPS, ref, Math.Rounding.Ceil);
    }

    /// @dev Check 2 read through FeedLib with the queue's own feeds and limits (asserted healthy at the pin), then
    ///      checks 3 and 4 for each basket asset in the queue's order. Returns the first failing check this reading
    ///      predicts, with its asset and detail, or Ok.
    function _independentChecks2To4() internal returns (SettleCheck expected, uint256 index, uint256 detail) {
        FlowParams memory p = queue.flowParams();
        uint256 usdc8 = _readCheck2(p);
        expected = SettleCheck.Ok;
        index = IDLE_INDEX;
        AssetReading[2] memory r = [_read(IDX_WETH, usdc8, p), _read(IDX_CBBTC, usdc8, p)];
        uint256[2] memory idx = [IDX_WETH, IDX_CBBTC];
        for (uint256 k; k < 2; ++k) {
            if (!r[k].twapOk || r[k].inBand < p.quorum) return (SettleCheck.TwapQuorum, idx[k], r[k].inBand);
        }
        for (uint256 k; k < 2; ++k) {
            if (r[k].twapGapBps > p.refBandBps) return (SettleCheck.TwapVsFeed, idx[k], r[k].twapGapBps);
        }
        emit log_named_uint("check 4 band refBandBps", p.refBandBps);
    }

    /// @dev Check 2's sequencer and USDC parts through FeedLib; returns the USDC / USD price (8 decimals).
    function _readCheck2(FlowParams memory p) internal returns (uint256 usdc8) {
        (address usdcFeed, uint32 usdcMaxAge, address seqFeed) = queue.feeds();
        assertEq(usdcFeed, FEED_USDC, "the queue reads the real USDC feed address");
        assertEq(seqFeed, FEED_SEQUENCER, "and the real sequencer feed address");
        (bool up, FeedStatus seqSt) = FeedLib.sequencerUp(seqFeed, p.sequencerGrace);
        assertTrue(up, "check 2: the real sequencer feed reports up past its grace");
        assertEq(uint8(seqSt), uint8(FeedStatus.Ok), "sequencer status");
        bool pegOk;
        FeedStatus pegSt;
        (pegOk, pegSt, usdc8) = FeedLib.usdcPeg(usdcFeed, usdcMaxAge, p.usdcPegBandBps);
        assertTrue(pegOk, "check 2: the real USDC feed is fresh and on its peg");
        assertEq(uint8(pegSt), uint8(FeedStatus.Ok), "USDC status");
        (,,, uint256 usdcUpdated,) = IRealAggregator(usdcFeed).latestRoundData();
        emit log_named_decimal_uint("USDC / USD feed at the pin", usdc8, 8);
        emit log_named_uint("USDC / USD feed age at the settlement (s)", block.timestamp - usdcUpdated);
    }

    /// @notice At the pin, with the real feeds: check 2 (sequencer, both basket feeds, the USDC peg) and check 4
    ///         (each slice-median TWAP within `refBandBps` of its feed) give the result an independent reading of the
    ///         same feeds and pools predicts, the quote and the keeper's settlement agree with it, and the real gap
    ///         between each feed and its pool is logged. If a real gap is over the band, the test asserts the
    ///         settlement is blocked by check 4 for that asset with that gap; nothing is forced to pass.
    function test_checks2And4_realChainlinkFeedsAtThePin() public fixtureCovered {
        uint256 id = _requestEndedByNow(5_000e6);
        emit log_named_uint("seconds from the pin to the settlement (setUp's timelock delays)", block.timestamp - pinTime);
        (SettleCheck expected, uint256 expIndex, uint256 expDetail) = _independentChecks2To4();

        // The queue's own verdict for the keeper now.
        vm.prank(keeper);
        (SettleCheck got, uint256 gotIndex) = queue.checkSettle();
        assertEq(uint8(got), uint8(expected), "checkSettle agrees with the independent reading");
        if (expected != SettleCheck.Ok) {
            assertEq(gotIndex, expIndex, "the same asset");
            assertEq(_expectBlocked(keeper, expected, expIndex), expDetail, "blocked with the same detail");
            assertEq(queue.getRequest(id).remaining, 5_000e6, "nothing filled");
            return;
        }

        // Every check passes at the pin: the quote and the settlement run on the real feeds.
        Quote memory q = queue.quoteDeposit(5_000e6);
        FundSnap memory f0 = _fundSnap();
        uint256 sid = _keeperSettle();
        assertGt(sid, 0, "the keeper settles at the pin on the real feeds");
        Settlement memory st = queue.getSettlement(sid);
        assertTrue(queue.getRequest(id).closed, "the deposit filled");
        assertGe(q.boundPrice, st.depositBoundPrice, "E21: the quote is no better than the settlement");
        _assertPerShareNotLower(f0, "real feeds");
        _assertClaimsInsideLimits(0);
        _assertBooks("real feeds");
    }

    /// @notice Check 2 against the real feeds as time passes with no new round (replay has none): once the real
    ///         ETH / USD answer is older than its `maxFeedAge`, the keeper's settlement is blocked naming wETH as
    ///         stale, and the fund's NAV view reverts with the same reason (E19).
    function test_check2_realEthFeedGoesStaleWithNoNewRound() public fixtureCovered {
        _requestEndedByNow(5_000e6);
        (,,, uint256 updatedAt,) = IRealAggregator(FEED_ETH).latestRoundData();
        uint32 maxAge = fund.assetConfig(IDX_WETH).maxFeedAge;
        emit log_named_uint("ETH / USD feed age now (s)", block.timestamp - updatedAt);
        emit log_named_uint("ETH / USD maxFeedAge (s)", maxAge);
        vm.prank(keeper);
        (SettleCheck fresh,) = queue.checkSettle();
        assertTrue(fresh != SettleCheck.Feed, "not stale while the real answer is younger than maxFeedAge");
        vm.warp(updatedAt + maxAge + 1);
        assertEq(_expectBlocked(keeper, SettleCheck.Feed, IDX_WETH), uint256(FeedStatus.Stale), "stale real feed");
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, IDX_WETH, FeedStatus.Stale));
        fund.totalAssets();
    }
}

/// @notice The two reads the real-feed tests make on a Chainlink proxy beside FeedLib's.
interface IRealAggregator {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
