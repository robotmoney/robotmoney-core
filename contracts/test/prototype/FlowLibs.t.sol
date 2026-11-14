// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 checks 2 and 3; docs/technical/one-vault-timed-
//            flows-eng-plan.md E6, E16; scaffold plan §7.3 ("unit tests only for FeedLib and TwapSlicesLib, using a
//            mock aggregator placed at the feed address")
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BaseFixture} from "./BaseFixture.sol";
import {TickMath} from "../../lib/TickMath.sol";
import {FeedStatus} from "./src/FundTypes.sol";
import {FeedLib} from "./src/lib/FeedLib.sol";
import {TwapSlicesLib} from "./src/lib/TwapSlicesLib.sol";
import {ILendingRateAdapter} from "./src/interfaces/IFlowAdapters.sol";
import {AaveV3RateAdapter} from "./src/adapters/AaveV3RateAdapter.sol";
import {CompoundV3RateAdapter} from "./src/adapters/CompoundV3RateAdapter.sol";
import {MorphoRateAdapter} from "./src/adapters/MorphoRateAdapter.sol";

/// @notice A Chainlink aggregator whose answer the test sets. Etched at a real feed address (E16: "tests move a feed
///         with a mock aggregator placed at the feed's address").
contract QueueMockAggregator {
    uint8 public decimals = 8;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;
    bool public reverts;
    bool public shortData;

    function set(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
    }

    function setRound(uint80 roundId_, uint80 answeredInRound_) external {
        roundId = roundId_;
        answeredInRound = answeredInRound_;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function setShortData(bool s) external {
        shortData = s;
    }

    function description() external pure returns (string memory) {
        return "mock";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverts, "feed down");
        if (shortData) {
            assembly {
                mstore(0, 1)
                return(0, 32)
            }
        }
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}

/// @notice An `observe` pool whose tick is constant inside each of `ticks.length` slices of `sliceLen` seconds ending
///         now. `observe` answers only at slice boundaries (what TwapSlicesLib asks for).
contract QueueMockObservablePool {
    int24[] internal ticks;
    uint32 internal sliceLen;
    bool public reverts;
    uint256 public dropPoints;

    function setSlices(int24[] memory ticks_, uint32 sliceLen_) external {
        delete ticks;
        for (uint256 i; i < ticks_.length; ++i) {
            ticks.push(ticks_[i]);
        }
        sliceLen = sliceLen_;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function setDropPoints(uint256 n) external {
        dropPoints = n;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory cum, uint160[] memory spl)
    {
        require(!reverts, "OLD");
        uint256 n = secondsAgos.length - dropPoints;
        cum = new int56[](n);
        spl = new uint160[](n);
        uint256 window = ticks.length * sliceLen;
        for (uint256 k; k < n; ++k) {
            uint256 ago = secondsAgos[k];
            require(ago <= window && (window - ago) % sliceLen == 0, "unaligned");
            uint256 j = (window - ago) / sliceLen; // slices completed at that point
            int56 c = 1_000_000; // arbitrary base cumulative
            for (uint256 m; m < j; ++m) {
                c += int56(ticks[m]) * int56(uint56(sliceLen));
            }
            cum[k] = c;
        }
    }
}

/// @notice Exposes the internal library functions to the tests.
contract FlowLibsHarness {
    function read(address feed, uint32 maxAge) external view returns (FeedStatus, uint256) {
        return FeedLib.read(feed, maxAge);
    }

    function sequencerUp(address feed, uint32 grace) external view returns (bool, FeedStatus) {
        return FeedLib.sequencerUp(feed, grace);
    }

    function usdcPeg(address feed, uint32 maxAge, uint16 bandBps)
        external
        view
        returns (bool, FeedStatus, uint256)
    {
        return FeedLib.usdcPeg(feed, maxAge, bandBps);
    }

    function median(address pool, uint32 window, uint8 slices, uint16 dispersionBps)
        external
        view
        returns (bool, int24, uint8)
    {
        return TwapSlicesLib.median(pool, window, slices, dispersionBps);
    }

    function bandTicks(uint16 bps) external pure returns (uint24) {
        return TwapSlicesLib.bandTicks(bps);
    }
}

/// @title FlowLibsTest
/// @notice FeedLib (E16, check 2) and TwapSlicesLib (E6, check 3) against mocks. No fork and no fixture: the mocks
///         are etched at the real Base feed addresses, which the replay fixture does not hold yet.
contract FlowLibsTest is Test {
    // Base feeds at the fixture pin (scaffold plan §4).
    address internal constant ETH_USD = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant USDC_USD = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant SEQUENCER = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;

    uint32 internal constant MAX_AGE = 1 hours;
    uint256 internal constant T0 = 1_760_000_000;

    FlowLibsHarness internal h;
    QueueMockAggregator internal eth;
    QueueMockAggregator internal usdc;
    QueueMockAggregator internal seq;
    QueueMockObservablePool internal pool;

    function setUp() public {
        vm.warp(T0);
        h = new FlowLibsHarness();
        eth = QueueMockAggregator(_etchAggregator(ETH_USD));
        usdc = QueueMockAggregator(_etchAggregator(USDC_USD));
        seq = QueueMockAggregator(_etchAggregator(SEQUENCER));
        pool = new QueueMockObservablePool();
    }

    function _etchAggregator(address at) internal returns (address) {
        QueueMockAggregator m = new QueueMockAggregator();
        vm.etch(at, address(m).code);
        // Storage is not copied by etch: set the defaults again at the feed address.
        QueueMockAggregator(at).setDecimals(8);
        QueueMockAggregator(at).setRound(1, 1);
        return at;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  FeedLib.read
    // ═════════════════════════════════════════════════════════════════════════

    function test_read_ok_atFeedAddress() public {
        eth.set(3_000e8, T0 - 10, T0 - 10);
        (FeedStatus st, uint256 px) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.Ok), "status");
        assertEq(px, 3_000e8, "price");
    }

    function test_read_scalesDecimalsTo8() public {
        eth.setDecimals(18);
        eth.set(3_000e18 + 123, T0, T0);
        (FeedStatus st, uint256 px) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.Ok));
        assertEq(px, 3_000e8, "18 -> 8 decimals rounds down");
        eth.setDecimals(6);
        eth.set(3_000e6, T0, T0);
        (, px) = h.read(ETH_USD, MAX_AGE);
        assertEq(px, 3_000e8, "6 -> 8 decimals");
    }

    function test_read_answerThatScalesToZero_isNonPositive() public {
        eth.setDecimals(18);
        eth.set(1, T0, T0);
        (FeedStatus st, uint256 px) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.NonPositive));
        assertEq(px, 0);
    }

    function test_read_staleBoundary() public {
        eth.set(3_000e8, T0 - MAX_AGE, T0 - MAX_AGE);
        (FeedStatus st,) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.Ok), "exactly maxAge is fresh");
        eth.set(3_000e8, T0 - MAX_AGE - 1, T0 - MAX_AGE - 1);
        uint256 px;
        (st, px) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.Stale), "one second over");
        assertEq(px, 0, "no price when not Ok");
    }

    function test_read_nonPositive() public {
        eth.set(0, T0, T0);
        (FeedStatus st,) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.NonPositive), "zero");
        eth.set(-1, T0, T0);
        (st,) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.NonPositive), "negative");
    }

    function test_read_roundIncomplete() public {
        eth.set(3_000e8, T0, 0);
        (FeedStatus st,) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.RoundIncomplete), "updatedAt 0");
        eth.set(3_000e8, T0, T0);
        eth.setRound(5, 4);
        (st,) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.RoundIncomplete), "answeredInRound < roundId");
    }

    function test_read_failures_neverRevert() public {
        (FeedStatus st,) = h.read(address(0), MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.NoFeed), "no feed");
        (st,) = h.read(address(0xBEEF), MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.ReadFailed), "no code");
        eth.set(3_000e8, T0, T0);
        eth.setReverts(true);
        (st,) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.ReadFailed), "reverting feed");
        eth.setReverts(false);
        eth.setShortData(true);
        (st,) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.ReadFailed), "short data");
        eth.setShortData(false);
        eth.set(3_000e8, T0 + 1, T0 + 1);
        (st,) = h.read(ETH_USD, MAX_AGE);
        assertEq(uint256(st), uint256(FeedStatus.ReadFailed), "updatedAt in the future");
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  FeedLib.sequencerUp
    // ═════════════════════════════════════════════════════════════════════════

    function test_sequencer_upPastGrace() public {
        seq.set(0, T0 - 1 hours, T0 - 1 hours);
        (bool ok, FeedStatus st) = h.sequencerUp(SEQUENCER, 1 hours);
        assertTrue(ok, "up exactly grace ago");
        assertEq(uint256(st), uint256(FeedStatus.Ok));
    }

    function test_sequencer_insideGrace() public {
        seq.set(0, T0 - 1 hours + 1, T0);
        (bool ok, FeedStatus st) = h.sequencerUp(SEQUENCER, 1 hours);
        assertFalse(ok);
        assertEq(uint256(st), uint256(FeedStatus.SequencerGrace));
    }

    function test_sequencer_down() public {
        seq.set(1, T0 - 2 days, T0);
        (bool ok, FeedStatus st) = h.sequencerUp(SEQUENCER, 1 hours);
        assertFalse(ok);
        assertEq(uint256(st), uint256(FeedStatus.SequencerDown));
    }

    function test_sequencer_failures() public {
        (bool ok, FeedStatus st) = h.sequencerUp(address(0), 1 hours);
        assertFalse(ok);
        assertEq(uint256(st), uint256(FeedStatus.NoFeed));
        seq.set(0, 0, T0);
        (ok, st) = h.sequencerUp(SEQUENCER, 1 hours);
        assertFalse(ok);
        assertEq(uint256(st), uint256(FeedStatus.RoundIncomplete), "startedAt 0");
        seq.setReverts(true);
        (ok, st) = h.sequencerUp(SEQUENCER, 1 hours);
        assertFalse(ok);
        assertEq(uint256(st), uint256(FeedStatus.ReadFailed));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  FeedLib.usdcPeg
    // ═════════════════════════════════════════════════════════════════════════

    function test_usdcPeg_bandEdges() public {
        usdc.set(1e8, T0, T0);
        (bool ok, FeedStatus st, uint256 px) = h.usdcPeg(USDC_USD, MAX_AGE, 50);
        assertTrue(ok);
        assertEq(px, 1e8);
        usdc.set(0.995e8, T0, T0);
        (ok, st,) = h.usdcPeg(USDC_USD, MAX_AGE, 50);
        assertTrue(ok, "exactly 50 bps below is inside");
        usdc.set(1.005e8, T0, T0);
        (ok,,) = h.usdcPeg(USDC_USD, MAX_AGE, 50);
        assertTrue(ok, "exactly 50 bps above is inside");
        usdc.set(0.995e8 - 1, T0, T0);
        (ok, st, px) = h.usdcPeg(USDC_USD, MAX_AGE, 50);
        assertFalse(ok, "past the band");
        assertEq(uint256(st), uint256(FeedStatus.OffPeg));
        assertEq(px, 0.995e8 - 1, "price still reported");
    }

    function test_usdcPeg_staleFeed() public {
        usdc.set(1e8, T0 - MAX_AGE - 1, T0 - MAX_AGE - 1);
        (bool ok, FeedStatus st, uint256 px) = h.usdcPeg(USDC_USD, MAX_AGE, 50);
        assertFalse(ok);
        assertEq(uint256(st), uint256(FeedStatus.Stale));
        assertEq(px, 0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  TwapSlicesLib
    // ═════════════════════════════════════════════════════════════════════════

    function _flat(uint256 n, int24 tick) internal pure returns (int24[] memory t) {
        t = new int24[](n);
        for (uint256 i; i < n; ++i) {
            t[i] = tick;
        }
    }

    function test_bandTicks_isTheLargestTickInsideTheBand() public view {
        assertEq(h.bandTicks(0), 0);
        assertEq(h.bandTicks(100), 99, "ln(1.01)/ln(1.0001) = 99.5");
        assertEq(h.bandTicks(50), 49);
        uint16[4] memory bps = [uint16(1), 10, 100, 2_000];
        for (uint256 k; k < bps.length; ++k) {
            uint24 t = h.bandTicks(bps[k]);
            uint256 rhs = (10_000 + uint256(bps[k])) << 192;
            uint256 sp = TickMath.getSqrtRatioAtTick(int24(uint24(t)));
            assertLe(sp * sp * 10_000, rhs, "t inside");
            sp = TickMath.getSqrtRatioAtTick(int24(uint24(t)) + 1);
            assertGt(sp * sp * 10_000, rhs, "t + 1 outside");
        }
    }

    function test_median_flat() public {
        pool.setSlices(_flat(12, -195_000), 300);
        (bool ok, int24 med, uint8 inBand) = h.median(address(pool), 3_600, 12, 100);
        assertTrue(ok);
        assertEq(med, -195_000);
        assertEq(inBand, 12);
    }

    function test_median_ignoresAShortPush_andCountsIt() public {
        int24[] memory t = _flat(12, 200_000);
        t[11] = 200_000 + 2_000; // the last 5 minutes pushed ~22%
        t[10] = 200_000 + 2_000;
        t[3] = 200_000 - 99; // inside the band (edge)
        t[4] = 200_000 - 100; // just outside (99 ticks is the 100 bps band)
        pool.setSlices(t, 300);
        (bool ok, int24 med, uint8 inBand) = h.median(address(pool), 3_600, 12, 100);
        assertTrue(ok);
        assertEq(med, 200_000, "median not moved by two pushed slices");
        assertEq(inBand, 9, "12 - 2 pushed - 1 just outside");
    }

    function test_median_evenCount_isLowerMedian() public {
        int24[] memory t = new int24[](4);
        t[0] = 10;
        t[1] = 40;
        t[2] = 20;
        t[3] = 30;
        pool.setSlices(t, 300);
        (bool ok, int24 med,) = h.median(address(pool), 1_200, 4, 100);
        assertTrue(ok);
        assertEq(med, 20, "lower of 20 and 30");
    }

    function test_median_oddDelta_roundsTowardNegativeInfinity() public {
        OddDeltaPool p3 = new OddDeltaPool();
        (bool ok, int24 med, uint8 inBand) = h.median(address(p3), 4, 2, 100);
        assertTrue(ok);
        // Slice deltas -21 and -21 over 2 seconds: -10.5 -> -11 each.
        assertEq(med, -11);
        assertEq(inBand, 2);
    }

    function test_median_failuresReturnNotOk() public {
        pool.setSlices(_flat(12, 1), 300);
        (bool ok,,) = h.median(address(pool), 3_600, 12, 100);
        assertTrue(ok, "sanity");
        (ok,,) = h.median(address(0xBEEF), 3_600, 12, 100);
        assertFalse(ok, "no code");
        (ok,,) = h.median(address(pool), 3_601, 12, 100);
        assertFalse(ok, "window not a multiple of slices");
        (ok,,) = h.median(address(pool), 3_600, 0, 100);
        assertFalse(ok, "zero slices");
        pool.setDropPoints(1);
        (ok,,) = h.median(address(pool), 3_600, 12, 100);
        assertFalse(ok, "wrong number of points");
        pool.setDropPoints(0);
        pool.setReverts(true);
        (ok,,) = h.median(address(pool), 3_600, 12, 100);
        assertFalse(ok, "observe reverts (too little history)");
    }
}

/// @notice Two slices of 2 seconds whose cumulative deltas are -21 each (mean -10.5).
contract OddDeltaPool {
    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory cum, uint160[] memory spl)
    {
        cum = new int56[](secondsAgos.length);
        spl = new uint160[](secondsAgos.length);
        for (uint256 k; k < secondsAgos.length; ++k) {
            // ago 4 -> 0, ago 2 -> -21, ago 0 -> -42
            cum[k] = -int56(uint56((4 - secondsAgos[k]) / 2)) * 21;
        }
    }
}

/// @title FlowLibsPinTest
/// @notice TwapSlicesLib on the real Base pools at the fixture pin, without moving time (plan §9 "pool history").
///         Uses the replay fixture and its coverage check.
contract FlowLibsPinTest is BaseFixture {
    address internal constant WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address internal constant CBBTC_POOL = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;

    FlowLibsHarness internal h;

    function setUp() public override {
        super.setUp();
        h = new FlowLibsHarness();
        _created[address(h)] = true;
    }

    /// @dev The §5.9.5 defaults: a 1 h window, 12 slices, quorum 9, 100 bps.
    function test_pin_sliceMedian_realPools() public fixtureCovered {
        address[2] memory pools = [WETH_POOL, CBBTC_POOL];
        for (uint256 k; k < pools.length; ++k) {
            (bool ok, int24 med, uint8 inBand) = h.median(pools[k], 3_600, 12, 100);
            assertTrue(ok, "observe over 1 h");
            assertGe(inBand, 9, "quorum at the pin");
            emit log_named_int("median tick", med);
        }
    }
}

/// @notice Comet's immutable pointer to its extension delegate (CometExt), which serves `totalsBasic()`. An immutable
///         read touches no storage.
interface ICometExtensionDelegate {
    function extensionDelegate() external view returns (address);
}

/// @title FlowRateAdaptersPinTest
/// @notice The lending adapter test copies (E15, check 5, plan §8.3 "the venue's own exchange rate, scaled by 1e18;
///         a gift to the adapter does not move it") on the real Base venues at the fixture pin. Replay fixture and
///         its coverage check, as every prototype test. One test per venue; each checks, in order:
///         1. the rate reads at the pin and sits above 1e18 (interest accrued since the venue opened) and below 2e18;
///         2. a USDC gift to the adapter leaves it exactly where it was;
///         3. one day of the venue's own accrual raises it, by less than the default check 5 bound (10 bps per day),
///            so normal interest never blocks a settlement.
contract FlowRateAdaptersPinTest is BaseFixture {
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address internal constant MOONWELL = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;
    /// @dev Proposal §5.9.5 default of `maxLendRateGrowthBps` (10 bps per day).
    uint256 internal constant DEFAULT_MAX_GROWTH_BPS = 10;

    function test_pin_ratePerUnit_aaveV3() public fixtureCovered {
        _checkVenue(new AaveV3RateAdapter(AAVE_POOL, USDC, AAVE_A_USDC, address(this)), "Aave V3");
    }

    /// @dev Comet serves `totalsBasic()` from its extension delegate. The replay fixture recorded on 2026-11-11 has
    ///      no code for that account (a delegatecall to it returns empty data, so the read reverts). Skipped only
    ///      while that is so; the recorder's fork has the code, so the re-record (requests.md, verify) captures it
    ///      and the test then runs in replay.
    function test_pin_ratePerUnit_compoundV3() public fixtureCovered {
        address ext = ICometExtensionDelegate(COMET).extensionDelegate();
        if (ext.code.length == 0) {
            _skipCovered(
                "fixture lacks Comet's extension delegate (totalsBasic); re-record, see requests.md"
            );
        }
        _checkVenue(new CompoundV3RateAdapter(COMET, USDC, address(this)), "Compound V3");
    }

    function test_pin_ratePerUnit_moonwellMorpho() public fixtureCovered {
        _checkVenue(new MorphoRateAdapter(MOONWELL, USDC, address(this)), "Moonwell (Morpho)");
    }

    function _checkVenue(ILendingRateAdapter adapter, string memory name) internal {
        _created[address(adapter)] = true;
        // 1. Reads at the pin, 1e18 scale.
        uint256 r0 = adapter.ratePerUnit();
        emit log_named_uint(name, r0);
        assertGt(r0, 1e18, "interest accrued since the venue opened");
        assertLt(r0, 2e18, "1e18 scale");
        // 2. A gift to the adapter. The adapter is fresh and holds no USDC, so the balance is written, not read.
        vm.store(
            USDC, keccak256(abi.encode(address(adapter), uint256(9))), bytes32(uint256(1_000_000e6))
        );
        assertEq(adapter.ratePerUnit(), r0, "a gift to the adapter does not move the venue rate");
        // 3. One day of the venue's own accrual.
        vm.warp(block.timestamp + 1 days);
        uint256 r1 = adapter.ratePerUnit();
        assertGt(r1, r0, "interest accrues");
        emit log_named_uint("growth over one day, 1e8 = 100%", (r1 - r0) * 1e8 / r0);
        assertLe(
            (r1 - r0) * 10_000,
            r0 * DEFAULT_MAX_GROWTH_BPS,
            "normal accrual stays under the check 5 default"
        );
    }
}
