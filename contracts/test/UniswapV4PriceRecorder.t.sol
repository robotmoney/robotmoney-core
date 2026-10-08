// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: V4 venue and price recorder)
//            docs/technical/smart-contract-invariants.md (ORA-1, ORA-3)
// Covers core issue 1676.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

contract UniswapV4PriceRecorderTest is Test {
    MockV4PoolManager internal pm;
    UniswapV4PriceRecorder internal rec;
    address internal c0;
    address internal c1;
    bytes32 internal poolId;

    uint24 internal constant FEE = 29100;
    int24 internal constant SPACING = 582;
    int24 internal constant START_TICK = -403009;

    function setUp() public {
        vm.warp(1_700_000_000);
        pm = new MockV4PoolManager();
        address a = address(new TestERC20());
        address b = address(new TestERC20());
        (c0, c1) = a < b ? (a, b) : (b, a);
        poolId = pm.initializePool(_key(), START_TICK, 1e18);
        rec = new UniswapV4PriceRecorder(address(pm), c0, c1, FEE, SPACING, address(0));
    }

    function _key() internal view returns (IPoolManagerV4.PoolKey memory) {
        return IPoolManagerV4.PoolKey(c0, c1, FEE, SPACING, address(0));
    }

    function _obs(uint32 s) internal view returns (int56) {
        uint32[] memory a = new uint32[](1);
        a[0] = s;
        (int56[] memory t,) = rec.observe(a);
        return t[0];
    }

    function _advance(uint256 s) internal {
        vm.warp(block.timestamp + s);
    }

    // ─── Construction and first record ───────────────────────────────

    function test_constructor_firstRecordHoldsTheLiveTickWithCumulativeZero() public view {
        (int24 lastTick, uint32 at, uint16 index, uint16 card, uint16 next) = rec.latest();
        assertEq(int256(lastTick), int256(START_TICK));
        assertEq(at, uint32(block.timestamp));
        assertEq(index, 0);
        assertEq(card, 1);
        assertEq(next, 1);
        assertEq(_obs(0), 0, "cumulative starts at 0");
    }

    function test_constructor_bindsThePoolIdToTheFullKey() public view {
        assertEq(rec.POOL_ID(), keccak256(abi.encode(c0, c1, FEE, SPACING, address(0))));
        assertEq(rec.POOL_ID(), poolId);
        assertEq(rec.token0(), c0);
        assertEq(rec.token1(), c1);
        assertEq(uint256(rec.fee()), uint256(FEE));
        assertEq(int256(rec.tickSpacing()), int256(SPACING));
        assertEq(rec.hooks(), address(0));
    }

    function test_constructor_revertsOnAnUninitialisedPool() public {
        vm.expectRevert(UniswapV4PriceRecorder.PoolNotInitialized.selector);
        new UniswapV4PriceRecorder(address(pm), c0, c1, FEE, SPACING + 1, address(0));
    }

    function test_constructor_revertsOnAHookAddress() public {
        vm.expectRevert(UniswapV4PriceRecorder.InvalidPoolKey.selector);
        new UniswapV4PriceRecorder(address(pm), c0, c1, FEE, SPACING, address(0xBEEF));
    }

    function test_constructor_revertsOnUnsortedOrZeroCurrencies() public {
        vm.expectRevert(UniswapV4PriceRecorder.InvalidPoolKey.selector);
        new UniswapV4PriceRecorder(address(pm), c1, c0, FEE, SPACING, address(0));
        vm.expectRevert(UniswapV4PriceRecorder.InvalidPoolKey.selector);
        new UniswapV4PriceRecorder(address(pm), address(0), c1, FEE, SPACING, address(0));
    }

    function test_constructor_revertsOnAPoolManagerWithoutCode() public {
        vm.expectRevert(UniswapV4PriceRecorder.InvalidPoolKey.selector);
        new UniswapV4PriceRecorder(makeAddr("eoa"), c0, c1, FEE, SPACING, address(0));
    }

    /// @notice A recorder built for a different fee reads a different pool id: it cannot be pointed at this pool.
    function test_constructor_aWrongFeeReadsADifferentPoolAndReverts() public {
        vm.expectRevert(UniswapV4PriceRecorder.PoolNotInitialized.selector);
        new UniswapV4PriceRecorder(address(pm), c0, c1, FEE + 1, SPACING, address(0));
    }

    // ─── One snapshot per block ──────────────────────────────────────

    function test_record_aSecondPokeInTheSameBlockWritesNoSnapshot() public {
        _advance(2);
        assertTrue(rec.record(), "first poke writes");
        (int24 t1, uint32 at1, uint16 i1,,) = rec.latest();
        (uint32 ts1, int56 cum1,) = rec.observations(i1);

        pm.setTick(poolId, START_TICK + 5); // spot moves inside the same block
        assertFalse(rec.record(), "second poke in the same block is a no-op");
        (int24 t2, uint32 at2, uint16 i2,,) = rec.latest();
        (uint32 ts2, int56 cum2,) = rec.observations(i2);
        assertEq(int256(t2), int256(t1), "recorded tick unchanged");
        assertEq(at2, at1);
        assertEq(i2, i1, "index did not advance");
        assertEq(ts2, ts1);
        assertEq(cum2, cum1, "cumulative unchanged");
    }

    // ─── Cumulative equals the V3 reference ──────────────────────────

    /// @notice Reference model: a V3 oracle extends each interval with the tick recorded at the interval's start.
    function test_record_cumulativeEqualsTheV3ReferenceAfterAPokeSequence() public {
        rec.grow(50);
        int256[6] memory live = [int256(-403009), -403004, -402990, -402985, -402990, -402999];
        uint256[6] memory gap = [uint256(0), 2, 6, 4, 10, 2];
        int256 refTick = START_TICK;
        int256 refCum = 0;
        for (uint256 i = 1; i < live.length; i++) {
            _advance(gap[i]);
            pm.setTick(poolId, int24(live[i]));
            rec.record();
            refCum += refTick * int256(gap[i]); // interval weighted by the PREVIOUS recorded tick
            // all moves here are below the clamp (10 per second), so the recorded tick is the live tick
            refTick = live[i];
            assertEq(int256(_obs(0)), refCum, "cumulative equals the reference");
        }
        (int24 lastTick,,,,) = rec.latest();
        assertEq(int256(lastTick), refTick);
    }

    function test_observe_interpolatesLikeV3BetweenSnapshots() public {
        rec.grow(10);
        _advance(10);
        pm.setTick(poolId, START_TICK + 50); // clamped to +50 (<= 100)
        rec.record(); // cum = START * 10
        _advance(10);
        pm.setTick(poolId, START_TICK + 50);
        rec.record(); // cum += (START+50) * 10
        int256 c10 = int256(START_TICK) * 10;
        int256 c20 = c10 + int256(START_TICK + 50) * 10;
        assertEq(int256(_obs(0)), c20);
        assertEq(int256(_obs(10)), c10);
        // 5 s ago sits midway in the second interval: V3 linear interpolation on the cumulative
        assertEq(int256(_obs(5)), c10 + ((c20 - c10) / 10) * 5);
        // 15 s ago sits midway in the first interval
        assertEq(int256(_obs(15)), (c10 / 10) * 5);
    }

    function test_observe_meanTickMatchesTheRecordedPathThroughTwapTickMath() public {
        rec.grow(10);
        for (uint256 i = 0; i < 5; i++) {
            _advance(2);
            pm.setTick(poolId, START_TICK + int24(int256(i)));
            rec.record();
        }
        // window 8 spans four 2 s intervals weighted by the ticks recorded at their starts: START, START+1, START+2, START+3.
        // The mean is START + 1.5, which the V3 rounding takes toward -infinity.
        int24 mean = TwapTickMath.meanTick(address(rec), 8);
        assertEq(
            int256(mean), int256(START_TICK) + 1, "mean over the last 8 s (rounded toward -inf)"
        );
    }

    // ─── observe never reads live spot ───────────────────────────────

    function test_observe_zeroAfterSpotMovesWithoutAPokeReturnsTheLastRecordedTickNotSpot() public {
        _advance(2);
        rec.record();
        (int24 lastTick,,,,) = rec.latest();
        int56 before_ = _obs(0);

        pm.setTick(poolId, START_TICK + 3000); // live spot jumps; nobody pokes
        assertEq(_obs(0), before_, "same block: unchanged");

        _advance(30);
        // extrapolated with the LAST RECORDED tick for 30 s, not with the live tick
        assertEq(int256(_obs(0)), int256(before_) + int256(lastTick) * 30);
        (, int24 liveTick,,) = rec.slot0();
        assertEq(
            int256(liveTick),
            int256(START_TICK) + 3000,
            "slot0 exposes live spot for the ORA-4 guard only"
        );
        assertTrue(int256(liveTick) != int256(lastTick));
    }

    function test_observe_beyondTheOldestSnapshotReverts() public {
        rec.grow(10);
        _advance(100);
        rec.record();
        // oldest snapshot is the constructor's, 100 s ago
        _obs(100);
        vm.expectRevert(UniswapV4PriceRecorder.ObservationTooOld.selector);
        this.obsExternal(101);
    }

    function test_observe_afterTheRingWrapsTheOldestSnapshotMovesForward() public {
        rec.grow(4);
        for (uint256 i = 0; i < 10; i++) {
            _advance(10);
            rec.record();
        }
        // ring of 4 holds the newest 4 snapshots: 30 s of history
        _obs(30);
        vm.expectRevert(UniswapV4PriceRecorder.ObservationTooOld.selector);
        this.obsExternal(31);
    }

    function test_observe_secondsAgoLargerThanTheClockReverts() public {
        vm.expectRevert(UniswapV4PriceRecorder.ObservationTooOld.selector);
        this.obsExternal(type(uint32).max);
    }

    function obsExternal(uint32 s) external view returns (int56) {
        return _obs(s);
    }

    function test_oldestObservation_isTheConstructorSnapshotUntilTheRingWraps() public {
        uint32 t0 = uint32(block.timestamp);
        assertEq(rec.oldestObservation(), t0);
        rec.grow(4);
        for (uint256 i = 0; i < 3; i++) {
            _advance(10);
            rec.record();
        }
        assertEq(
            rec.oldestObservation(), t0, "ring of 4 holds the constructor snapshot and three more"
        );
        _advance(10);
        rec.record();
        assertEq(
            rec.oldestObservation(),
            t0 + 10,
            "the fifth snapshot overwrote the constructor snapshot"
        );
    }

    /// @notice The ring is not full yet: the slot after the newest is a placeholder, so the oldest snapshot is slot 0, not that slot.
    function test_oldestObservation_fallsBackToSlotZeroWhileTheRingIsStillFilling() public {
        uint32 t0 = uint32(block.timestamp);
        rec.grow(10);
        for (uint256 i = 0; i < 3; i++) {
            _advance(10);
            rec.record();
        }
        (,, uint16 index, uint16 card,) = rec.latest();
        assertEq(card, 10, "the ring widened to 10 slots");
        assertEq(index, 3);
        (uint32 nextSlotTs,, bool nextInit) = rec.observations(4);
        assertEq(nextSlotTs, 1, "the next slot is the grow placeholder");
        assertFalse(nextInit);
        assertEq(rec.oldestObservation(), t0, "the oldest snapshot is slot 0");
    }

    // ─── grow ────────────────────────────────────────────────────────

    function test_grow_raisesCardinalityNextThenTheRingWidensAtTheNextRecord() public {
        assertEq(rec.grow(901), 901);
        (,,, uint16 card, uint16 next) = rec.latest();
        assertEq(card, 1, "ring widens at the next record");
        assertEq(next, 901);
        (,,, uint16 liveCard) = rec.slot0();
        assertEq(liveCard, 1, "slot0 reports the live ring, not the grown target");
        _advance(2);
        rec.record();
        (,,, card, next) = rec.latest();
        assertEq(card, 901, "cardinality raised");
        (,,, uint16 slotCard) = rec.slot0();
        assertEq(slotCard, 901, "slot0 reports the cardinality the guard reads");
    }

    function test_grow_isPermissionlessAndNeverShrinks() public {
        vm.prank(makeAddr("anyone"));
        rec.grow(20);
        vm.prank(makeAddr("someoneElse"));
        assertEq(rec.grow(5), 20, "a smaller request is a no-op");
        (,,,, uint16 next) = rec.latest();
        assertEq(next, 20);
    }

    // ─── Clamp, lag and flash manipulation ───────────────────────────

    function test_clamp_oneRecordMovesTheTickByAtMostTenPerSecond() public {
        _advance(2);
        pm.setTick(poolId, START_TICK + 100_000);
        rec.record();
        (int24 t,,,,) = rec.latest();
        assertEq(int256(t), int256(START_TICK) + 20, "2 s moves at most 20 ticks");
    }

    function test_clamp_aLongGapDoesNotWidenTheStepBeyond600Ticks() public {
        _advance(1_700);
        pm.setTick(poolId, START_TICK - 100_000);
        rec.record();
        (int24 t,,,,) = rec.latest();
        assertEq(int256(t), int256(START_TICK) - 600);
    }

    function test_clamp_aSmallMoveIsRecordedExactly() public {
        _advance(10);
        pm.setTick(poolId, START_TICK - 37);
        rec.record();
        (int24 t,,,,) = rec.latest();
        assertEq(int256(t), int256(START_TICK) - 37);
    }

    /// @notice Flash loan then poke: the pool is pushed 50_000 ticks and recorded in block N. The interval ending at
    ///         block N is weighted by the PREVIOUS tick (lag), and the recorded tick moves by at most 20.
    function test_flashManipulation_swapThenPokeCannotPoisonTheInterval() public {
        rec.grow(20);
        for (uint256 i = 0; i < 5; i++) {
            _advance(2);
            rec.record();
        }
        int56 cumBefore = _obs(0);
        _advance(2);
        pm.setTick(poolId, START_TICK + 50_000); // flash swap
        rec.record(); // attacker pokes
        // interval [t-2, t] is weighted with the honest previous tick
        assertEq(int256(_obs(0)), int256(cumBefore) + int256(START_TICK) * 2);
        (int24 t,,,,) = rec.latest();
        assertEq(int256(t), int256(START_TICK) + 20);
        pm.setTick(poolId, START_TICK); // swaps back in the same block
        // a 30 min mean after the attack differs from the honest mean by far less than the manipulation
        _advance(2);
        rec.record();
        (int24 t2,,,,) = rec.latest();
        assertEq(int256(t2), int256(START_TICK), "recorded tick returns once spot returns");
    }

    /// @notice Holding a manipulated tick across blocks drags the record at 10 ticks per second, no faster.
    function test_clamp_aHeldManipulationMovesTheRecordAtTheClampRate() public {
        rec.grow(20);
        pm.setTick(poolId, START_TICK + 10_000);
        for (uint256 i = 0; i < 10; i++) {
            _advance(2);
            rec.record();
        }
        (int24 t,,,,) = rec.latest();
        assertEq(int256(t), int256(START_TICK) + 200, "10 blocks of 2 s: 200 ticks");
    }

    // ─── Stale recorder fails closed ─────────────────────────────────

    function test_stale_observeRevertsBeyondOneWindowAndRecoversOnRecord() public {
        _advance(1_800);
        assertTrue(rec.isFresh(), "1800 s is still fresh");
        _obs(0);
        _advance(1);
        assertFalse(rec.isFresh());
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4PriceRecorder.StaleRecorder.selector,
                uint32(1_700_000_000),
                uint32(1_700_001_801)
            )
        );
        this.obsExternal(0);
        assertTrue(rec.record(), "anyone can poke a stale recorder back to life");
        assertTrue(rec.isFresh());
        _obs(0);
    }

    // ─── Live reads through the PoolManager ──────────────────────────

    function test_slot0_andLiquidityReadTheLivePoolThroughExtsload() public {
        (uint160 sqrtP, int24 tick,,) = rec.slot0();
        assertTrue(sqrtP != 0);
        assertEq(int256(tick), int256(START_TICK), "negative tick decodes");
        assertEq(rec.liquidity(), 1e18);
        pm.setLiquidity(poolId, 12345);
        assertEq(rec.liquidity(), 12345);
    }

    // ─── No owner, role or setter ────────────────────────────────────

    function test_noOwnerRoleOrSetter() public {
        string[14] memory sigs = [
            "owner()",
            "admin()",
            "pendingOwner()",
            "transferOwnership(address)",
            "renounceOwnership()",
            "hasRole(bytes32,address)",
            "grantRole(bytes32,address)",
            "revokeRole(bytes32,address)",
            "DEFAULT_ADMIN_ROLE()",
            "setPool(bytes32)",
            "setTick(int24)",
            "setPoolManager(address)",
            "setMaxStaleness(uint32)",
            "pauseDeposits()"
        ];
        for (uint256 i = 0; i < sigs.length; i++) {
            (bool ok,) = address(rec).call(abi.encodeWithSignature(sigs[i]));
            assertFalse(ok, sigs[i]);
        }
    }

    function testFuzz_cumulativeMatchesReferenceUnderRandomMoves(uint8 n, uint256 seed) public {
        n = uint8(bound(n, 1, 40));
        rec.grow(60);
        int256 refTick = START_TICK;
        int256 refCum;
        for (uint256 i = 0; i < n; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 gap = 2 + seed % 120;
            int256 live =
                int256(START_TICK) + int256(uint256(keccak256(abi.encode(seed))) % 4000) - 2000;
            _advance(gap);
            pm.setTick(poolId, int24(live));
            rec.record();
            refCum += refTick * int256(gap);
            uint256 e = gap > 60 ? 60 : gap;
            int256 lo = refTick - int256(10 * e);
            int256 hi = refTick + int256(10 * e);
            refTick = live < lo ? lo : (live > hi ? hi : live);
        }
        assertEq(int256(_obs(0)), refCum);
        (int24 t,,,,) = rec.latest();
        assertEq(int256(t), refTick);
    }
}
