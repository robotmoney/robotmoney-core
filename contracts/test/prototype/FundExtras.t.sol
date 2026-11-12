// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 (asset admission), §5.9.4 (in-kind exit, allowance,
//            position claims), §5.9.6 (NAV views), §7 RB-13, RB-17, RB-21; docs/technical/one-vault-timed-flows-eng-
//            plan.md E9, E15, E19, E20, E23, §4.2 (RB-17, RB-21, E19, E23 bullets)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
//
// fund-extras' own unit test (scaffold plan §7.4). It cannot extend `PrototypeHarness` yet: the harness adds its
// assets with no feed and with the production lending adapters, which the step 3d admission rule (E15) refuses, and
// `integrate` owns the harness. So this file deploys the fund itself on the recorded Base fixture, the way the
// harness does, with the step 3d asset list: three lending venues through the `queue` agent's rate adapter copies, wETH
// and cbBTC through its exact-output swap adapter copy, and a mock Chainlink aggregator etched at each real feed
// address (E16: "tests move a feed with a mock aggregator placed at the feed's address"). The test contract is the
// fund's admin, its governance and rebalancer (bound once), and plays the FlowQueue (FLOW_ROLE, `queuedSharesOf`,
// `flowParams`, `feeds`).
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BaseFixture} from "./BaseFixture.sol";
import {GovernedUUPS} from "../../lib/GovernedUUPS.sol";
import {AaveV3Adapter} from "../../adapters/AaveV3Adapter.sol";
import {IStrategyAdapter} from "../../interfaces/IStrategyAdapter.sol";
import {IObservablePool} from "../../interfaces/IObservablePool.sol";
import {TwapTickMath} from "../../lib/TwapTickMath.sol";

import {RobotMoneyFund} from "./src/RobotMoneyFund.sol";
import {IRobotMoneyFund, IRobotMoneyFundFull} from "./src/interfaces/IRobotMoneyFund.sol";
import {AaveV3RateAdapter} from "./src/adapters/AaveV3RateAdapter.sol";
import {CompoundV3RateAdapter} from "./src/adapters/CompoundV3RateAdapter.sol";
import {MorphoRateAdapter} from "./src/adapters/MorphoRateAdapter.sol";
import {UniswapV3ExactOutSwapAdapter} from "./src/adapters/UniswapV3ExactOutSwapAdapter.sol";
import {FundValuationLib} from "./src/lib/FundValuationLib.sol";
import {FlowParams} from "./src/FlowTypes.sol";
import {
    AssetConfig,
    AssetKind,
    FeedStatus,
    FundInitParams,
    IFundEvents,
    Plan,
    PlanParams,
    PlanStatus,
    StepOrder,
    Venue,
    BPS,
    IDLE_INDEX,
    LENDING_ROUNDING_UNITS,
    DEFAULT_IN_KIND_BPS,
    DEFAULT_IN_KIND_FLOOR_USDC,
    DEFAULT_IN_KIND_PERIOD,
    MAX_FEED_AGE
} from "./src/FundTypes.sol";

/// @notice A Chainlink aggregator whose answer the test sets, etched at a real feed address.
contract FxMockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;

    function set(uint8 decimals_, int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        decimals = decimals_;
        answer = answer_;
        startedAt = startedAt_;
        updatedAt = updatedAt_;
    }

    function description() external pure returns (string memory) {
        return "fund-extras mock";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, startedAt, updatedAt, 1);
    }
}

interface IFxV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract FundExtrasTest is BaseFixture {
    using Math for uint256;

    // ─── Real Base addresses (as PrototypeHarness) ────────────────────────────────────────────────────────
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address internal constant CBBTC_POOL = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address internal constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address internal constant MOONWELL = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;
    uint24 internal constant POOL_FEE = 500;

    // ─── Chainlink on Base (scaffold plan §4) ────────────────────────────────────────────────────────────
    address internal constant FEED_ETH = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant FEED_CBBTC = 0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D;
    address internal constant FEED_USDC = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant FEED_SEQUENCER = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
    /// @dev Heartbeat + 5 min (§5.9.5): ETH / USD 20 min, cbBTC / USD and USDC / USD 24 h.
    uint32 internal constant ETH_MAX_AGE = 1_500;
    uint32 internal constant DAY_MAX_AGE = 86_700;

    // ─── Fund asset indices ───────────────────────────────────────────────────────────────────────────────
    // The §4.5 list: three lending venues, wETH and cbBTC. Compound V3 is the LAST index, as in the harness, so the
    // other indices never moved. It was left out here until `verify` re-recorded the fixture with Comet's extension
    // contract (0x0d4Bd55A755134950027cE1F43190A354e648e20, which serves `totalsBasic()` to the rate copy);
    // `hardening` (step 3 plan §3.3 item 7, 2026-11-12) lists it. Loops over the lending venues use `_lendingIdx`.
    uint256 internal constant IDX_AAVE = 0;
    uint256 internal constant IDX_MOONWELL = 1;
    uint256 internal constant IDX_WETH = 2;
    uint256 internal constant IDX_CBBTC = 3;
    uint256 internal constant IDX_COMET = 4;
    uint256 internal constant N_ASSETS = 5;
    uint256 internal constant N_LENDING = 3;

    // ─── Parameters (PrototypeHarness values) ────────────────────────────────────────────────────────────
    uint256 internal constant TVL_CAP = 10_000_000e6;
    uint256 internal constant PER_DEPOSIT_CAP = 1_000_000e6;
    uint256 internal constant EXIT_FEE_BPS = 10;
    uint256 internal constant MAX_SLIPPAGE_BPS = 200;
    uint256 internal constant NAV_DEVIATION_BPS = 200;
    uint16 internal constant LENDING_CAP_BPS = 6_000;
    uint32 internal constant TWAP_WINDOW = 1_800;
    uint256 internal constant SEED_USDC = 100_000e6;
    /// @dev Per-leg purchase limit and sale floor around the TWAP the test passes (the queue derives the real ones).
    uint256 internal constant LEG_BAND_BPS = 300;

    address internal emergency = makeAddr("emergency");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    IRobotMoneyFundFull internal fund;
    AaveV3RateAdapter internal aave;
    MorphoRateAdapter internal moonwell;
    UniswapV3ExactOutSwapAdapter internal swapAdapter;
    CompoundV3RateAdapter internal comet;

    /// @dev USD prices (8 decimals) the mock basket feeds report: each pool's own price at the pin (`_etchFeeds`).
    int256 internal ethPrice8;
    int256 internal cbbtcPrice8;

    /// @dev This contract plays the FlowQueue once `bindFlowRole` binds it.
    mapping(address => uint256) internal queued;
    FlowParams internal params;

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  The queue stand-in's surface the fund reads
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function queuedSharesOf(address account) external view returns (uint256) {
        return queued[account];
    }

    function flowParams() external view returns (FlowParams memory) {
        return params;
    }

    function feeds() external pure returns (address, uint32, address) {
        return (FEED_USDC, DAY_MAX_AGE, FEED_SEQUENCER);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Deploy
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function setUp() public override {
        super.setUp();
        params = FlowParams({
            epochLength: 6 hours,
            settleWindow: 1 hours,
            minHold: 24 hours,
            keeperGrace: 6 hours,
            maxEpochFlowBps: 500,
            epochFlowFloorUsdc: 250_000e6,
            maxSharePriceMoveBps: 1_000,
            maxRoll: 8,
            minRequestUsdc: 100e6,
            maxFreeze: 7 days,
            slices: 12,
            quorum: 9,
            dispersionBps: 100,
            refBandBps: 90,
            legBandBps: 100,
            sequencerGrace: 1 hours,
            usdcPegBandBps: 50,
            maxLendRateGrowthBps: 10
        });
        _etchFeeds();
        fund = _deployFund();
        aave = new AaveV3RateAdapter(AAVE_POOL, USDC, AAVE_A_USDC, address(fund));
        moonwell = new MorphoRateAdapter(MOONWELL, USDC, address(fund));
        swapAdapter = new UniswapV3ExactOutSwapAdapter(ROUTER);
        // Created right after the other adapters, so their addresses (the fixture's venue slots are keyed by them)
        // do not move.
        comet = new CompoundV3RateAdapter(COMET, USDC, address(fund));
        fund.setAdapterCodeHashAllowed(address(aave).codehash, true);
        fund.setAdapterCodeHashAllowed(address(moonwell).codehash, true);
        fund.setAdapterCodeHashAllowed(address(swapAdapter).codehash, true);
        fund.setAdapterCodeHashAllowed(address(comet).codehash, true);
        assertEq(fund.addAsset(_lending(address(aave))), IDX_AAVE, "aave");
        assertEq(fund.addAsset(_lending(address(moonwell))), IDX_MOONWELL, "moonwell");
        assertEq(fund.addAsset(_basket(WETH, WETH_POOL, FEED_ETH, ETH_MAX_AGE)), IDX_WETH, "weth");
        assertEq(fund.addAsset(_basket(CBBTC, CBBTC_POOL, FEED_CBBTC, DAY_MAX_AGE)), IDX_CBBTC, "cbbtc");
        assertEq(fund.addAsset(_lending(address(comet))), IDX_COMET, "comet");
        RobotMoneyFund(address(fund)).bindRebalanceRoles(address(this), address(this));
        fund.bindFlowRole(address(this));
    }

    function _deployFund() internal returns (IRobotMoneyFundFull f) {
        FundInitParams memory p = FundInitParams({
            usdc: USDC,
            name: "Robot Money Fund",
            symbol: "rmFUND",
            tvlCap: TVL_CAP,
            perDepositCap: PER_DEPOSIT_CAP,
            exitFeeBps: EXIT_FEE_BPS,
            feeRecipient: feeRecipient,
            maxSlippageBps: MAX_SLIPPAGE_BPS,
            navDeviationGuardBps: NAV_DEVIATION_BPS,
            admin: address(this),
            emergency: emergency
        });
        address impl = address(new RobotMoneyFund());
        f = IRobotMoneyFundFull(
            address(
                new ERC1967Proxy(
                    impl,
                    abi.encodeCall(RobotMoneyFund.initialize, (p, address(this), GovernedUUPS.UpgradeMode.Upgradeable))
                )
            )
        );
    }

    function _lending(address adapter) internal pure returns (AssetConfig memory) {
        return AssetConfig({
            kind: AssetKind.Lending,
            active: true,
            capBps: LENDING_CAP_BPS,
            adapter: adapter,
            token: address(0),
            pool: address(0),
            poolFee: 0,
            twapWindow: 0,
            venue: Venue.V3,
            feed: address(0),
            maxFeedAge: 0
        });
    }

    function _basket(address token, address pool, address feed, uint32 maxAge)
        internal
        view
        returns (AssetConfig memory)
    {
        return AssetConfig({
            kind: AssetKind.Basket,
            active: true,
            capBps: 0,
            adapter: address(swapAdapter),
            token: token,
            pool: pool,
            poolFee: POOL_FEE,
            twapWindow: TWAP_WINDOW,
            venue: Venue.V3,
            feed: feed,
            maxFeedAge: maxAge
        });
    }

    /// @dev A mock aggregator at each real feed address, fresh now. Each basket feed reports its pool's own price at
    ///      the pin (as the harness's feeds do), USDC 1.
    ///      `hardening` (2026-11-12): the prices were round numbers (3 000 and 90 000 USD) while the fund's views read
    ///      only feed health. Step 3e (proposal §5.10, RB-19) makes every rebalance step compare each TWAP with its
    ///      feed (check 4), so a feed 30 % off its pool made every `executeStep` here revert `StepFeedCheckFailed`.
    ///      A feed at the market price models a live market; no test here is about a feed's value.
    function _etchFeeds() internal {
        address code = address(new FxMockAggregator());
        vm.etch(FEED_ETH, code.code);
        vm.etch(FEED_CBBTC, code.code);
        vm.etch(FEED_USDC, code.code);
        vm.etch(FEED_SEQUENCER, code.code);
        ethPrice8 = int256(_poolPrice8(WETH_POOL, WETH, 1e18));
        cbbtcPrice8 = int256(_poolPrice8(CBBTC_POOL, CBBTC, 1e8));
        _refreshFeeds();
    }

    /// @dev USD price (8 decimals, USDC at 1) of one whole `token` at `pool`'s current tick.
    function _poolPrice8(address pool, address token, uint256 unit) internal view returns (uint256) {
        (, int24 tick,,,,,) = IFxV3Pool(pool).slot0();
        return TwapTickMath.priceFromTick(tick, token, USDC, unit) * 100;
    }

    /// @dev Every feed fresh at `block.timestamp`, USDC at par, the sequencer up for a day.
    function _refreshFeeds() internal {
        FxMockAggregator(FEED_ETH).set(8, ethPrice8, block.timestamp, block.timestamp);
        FxMockAggregator(FEED_CBBTC).set(8, cbbtcPrice8, block.timestamp, block.timestamp);
        FxMockAggregator(FEED_USDC).set(8, 1e8, block.timestamp, block.timestamp);
        FxMockAggregator(FEED_SEQUENCER).set(0, 0, block.timestamp - 1 days, block.timestamp);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function fundUsdc(address to, uint256 amount) internal {
        uint256 before = IERC20(USDC).balanceOf(to);
        vm.store(USDC, keccak256(abi.encode(to, uint256(9))), bytes32(before + amount));
        assertEq(IERC20(USDC).balanceOf(to), before + amount, "fundUsdc");
    }

    function _seed() internal {
        fundUsdc(address(this), SEED_USDC);
        IERC20(USDC).approve(address(fund), SEED_USDC);
        fund.seed(SEED_USDC);
    }

    /// @dev The invested weights of `_seedAndInvest`, index-aligned: aave 25 %, moonwell 20 %, wETH 17.5 %, cbBTC
    ///      17.5 %, Compound 20 % (lending 65 % over three venues, as the harness's default plan; was aave 35 %,
    ///      moonwell 30 % before Compound was listed).
    function _weights() internal pure returns (uint256[N_ASSETS] memory) {
        return [uint256(2_500), 2_000, 1_750, 1_750, 2_000];
    }

    /// @dev The asset index of lending venue `k` (0 to N_LENDING − 1): aave, moonwell, Compound.
    function _lendingIdx(uint256 k) internal pure returns (uint256) {
        return [IDX_AAVE, IDX_MOONWELL, IDX_COMET][k];
    }

    /// @dev Seed, then invest the seed with the fund's own `executeStep` (this contract holds REBALANCER_ROLE): a
    ///      1-day plan to `_weights()`, then one step from idle into each asset after the path's end. Every lending
    ///      step goes through `FundPositionLib.supply`, so the positions get their units here.
    function _seedAndInvest() internal {
        _seed();
        uint256[N_ASSETS] memory w = _weights();
        uint256[] memory bps = new uint256[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            bps[i] = w[i];
        }
        fund.setTargetAndOpenPlan(_ids(), bps, PlanParams(1 days, 500), bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);
        _refreshFeeds();
        for (uint256 i; i < N_ASSETS; ++i) {
            (uint256 nav,,) = fund.portfolioValues();
            _step(i, nav.mulDiv(w[i] * 99, BPS * 100));
        }
    }

    function _ids() internal view returns (address[] memory ids) {
        ids = new address[](N_ASSETS);
        ids[IDX_AAVE] = address(aave);
        ids[IDX_MOONWELL] = address(moonwell);
        ids[IDX_WETH] = WETH;
        ids[IDX_CBBTC] = CBBTC;
        ids[IDX_COMET] = address(comet);
    }

    /// @dev One `executeStep` from idle into asset `i` for `notional` USDC.
    function _step(uint256 i, uint256 notional) internal {
        uint256 minOut =
            fund.assetConfig(i).kind == AssetKind.Basket ? fund.assetTokenValue(i, notional).mulDiv(98, 100) : 0;
        fund.executeStep(StepOrder(IDLE_INDEX, i, notional, 0, minOut, notional.mulDiv(100, BPS)));
    }

    /// @dev Per-leg purchase limits for `sharesOut` around the TWAP (as FundCore.t.sol).
    function _buyLimits(uint256 sharesOut) internal view returns (uint256[] memory limits, uint256 maxUsdc) {
        (uint256 idle, uint256[] memory held) = fund.heldBalances();
        uint256 supply = fund.totalSupply();
        limits = new uint256[](held.length);
        maxUsdc = idle.mulDiv(sharesOut, supply, Math.Rounding.Ceil);
        for (uint256 i; i < held.length; ++i) {
            uint256 want = held[i].mulDiv(sharesOut, supply, Math.Rounding.Ceil);
            if (want == 0) continue;
            if (fund.assetConfig(i).kind == AssetKind.Lending) {
                maxUsdc += want + LENDING_ROUNDING_UNITS;
            } else {
                limits[i] = fund.assetUsdcValue(i, want).mulDiv(BPS + LEG_BAND_BPS, BPS) + 1;
                maxUsdc += limits[i];
            }
        }
    }

    function _sellFloors(uint256 shares) internal view returns (uint256[] memory floors) {
        (, uint256[] memory held) = fund.heldBalances();
        uint256 supply = fund.totalSupply();
        floors = new uint256[](held.length);
        for (uint256 i; i < held.length; ++i) {
            if (fund.assetConfig(i).kind != AssetKind.Basket) continue;
            uint256 amt = held[i].mulDiv(shares, supply);
            if (amt != 0) floors[i] = fund.assetUsdcValue(i, amt).mulDiv(BPS - LEG_BAND_BPS, BPS);
        }
    }

    /// @dev Mint `sharesOut` through `mintInKind` (this contract is the queue) and return the USDC spent.
    function _mintInKind(uint256 sharesOut) internal returns (uint256 spent) {
        (uint256[] memory limits, uint256 maxUsdc) = _buyLimits(sharesOut);
        fundUsdc(address(this), maxUsdc);
        IERC20(USDC).approve(address(fund), maxUsdc);
        spent = fund.mintInKind(sharesOut, maxUsdc, limits);
    }

    /// @dev Give `who` `shares` new shares (bought pro rata through `mintInKind`, then transferred).
    function _giveShares(address who, uint256 shares) internal {
        _mintInKind(shares);
        fund.transfer(who, shares);
    }

    function _setAllowance(uint16 bps, uint128 floorUsdc) internal {
        fund.setInKindAllowance(bps, floorUsdc, DEFAULT_IN_KIND_PERIOD);
    }

    function _units(uint256 i) internal view returns (uint256 total, uint256 claims) {
        return fund.positionUnits(i);
    }

    /// @dev Check 10 restated from outside: every held amount per share is at least what it was.
    function _assertPerShareNotLower(uint256 idle0, uint256[] memory held0, uint256 supply0, string memory label)
        internal
        view
    {
        (uint256 idle1, uint256[] memory held1) = fund.heldBalances();
        uint256 supply1 = fund.totalSupply();
        assertGe(idle1 * supply0, idle0 * supply1, string.concat(label, ": idle per share"));
        for (uint256 i; i < held0.length; ++i) {
            assertGe(held1[i] * supply0, held0[i] * supply1, string.concat(label, ": asset per share"));
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E9 / RB-21: units per lending position
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Units start with the first supply, every holders' supply and withdrawal mints or burns them at the
    ///         unit's value, and without a claim the holders own the whole position.
    function test_E9_unitsFollowEverySupplyAndWithdrawal() public fixtureCovered {
        _seedAndInvest();
        for (uint256 k; k < N_LENDING; ++k) {
            uint256 i = _lendingIdx(k);
            (uint256 u, uint256 c) = _units(i);
            assertGt(u, 0, "units started at the first supply");
            assertEq(c, 0, "no claim yet");
            (, uint256[] memory held) = fund.heldBalances();
            assertEq(held[i], IStrategyAdapter(fund.assetConfig(i).adapter).totalAssets(), "holders own it all");
        }
        // A pro-rata purchase and sale move units by the value moved: the value of one unit never falls.
        uint256[N_LENDING] memory val0;
        uint256[N_LENDING] memory u0;
        for (uint256 k; k < N_LENDING; ++k) {
            (u0[k],) = _units(_lendingIdx(k));
            val0[k] = IStrategyAdapter(fund.assetConfig(_lendingIdx(k)).adapter).totalAssets();
        }
        uint256 sharesOut = fund.totalSupply() / 20;
        _mintInKind(sharesOut);
        for (uint256 k; k < N_LENDING; ++k) {
            (uint256 u1,) = _units(_lendingIdx(k));
            uint256 val1 = IStrategyAdapter(fund.assetConfig(_lendingIdx(k)).adapter).totalAssets();
            assertGt(u1, u0[k], "supply minted units");
            // val1 / u1 >= val0 / u0
            assertGe(val1 * u0[k], val0[k] * u1, "unit value not lowered by a supply");
            (u0[k], val0[k]) = (u1, val1);
        }
        fund.sellForFlow(sharesOut, _sellFloors(sharesOut));
        for (uint256 k; k < N_LENDING; ++k) {
            (uint256 u1,) = _units(_lendingIdx(k));
            uint256 val1 = IStrategyAdapter(fund.assetConfig(_lendingIdx(k)).adapter).totalAssets();
            assertLt(u1, u0[k], "withdrawal burned units");
            assertGe(val1 * u0[k], val0[k] * u1, "unit value not lowered by a withdrawal");
        }
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E20: the in-kind allowance
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_E20_defaultsAndSetterBounds() public fixtureCovered {
        (uint16 bps, uint128 floorUsdc, uint32 period, uint256 used) = fund.inKindAllowance();
        assertEq(bps, DEFAULT_IN_KIND_BPS, "default bps");
        assertEq(floorUsdc, DEFAULT_IN_KIND_FLOOR_USDC, "default floor");
        assertEq(period, DEFAULT_IN_KIND_PERIOD, "default period");
        assertEq(used, 0, "nothing used");
        vm.expectRevert(IFundEvents.InvalidParam.selector);
        fund.setInKindAllowance(10_001, 0, 6 hours);
        vm.expectRevert(IFundEvents.InvalidParam.selector);
        fund.setInKindAllowance(500, 0, 59 minutes);
        vm.expectRevert(IFundEvents.InvalidParam.selector);
        fund.setInKindAllowance(500, 0, 7 days + 1);
        vm.prank(alice);
        vm.expectRevert();
        fund.setInKindAllowance(500, 0, 6 hours);
    }

    /// @notice Inside the allowance an in-kind exit is paid in USDC and leaves no claim; the period's use grows by
    ///         the lending USDC that left the venues.
    function test_E20_inKindInsideAllowancePaysUsdcNoClaim() public fixtureCovered {
        _seedAndInvest();
        _giveShares(alice, fund.totalSupply() / 10);
        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        uint256 shares = fund.balanceOf(alice);
        vm.prank(alice);
        fund.redeemInKind(shares, alice, alice);
        _assertPerShareNotLower(idle0, held0, supply0, "inside allowance");
        uint256 lendingWant;
        for (uint256 k; k < N_LENDING; ++k) {
            uint256 i = _lendingIdx(k);
            (uint256 units,) = fund.positionClaimOf(i, alice);
            assertEq(units, 0, "no claim inside the allowance");
            (, uint256 c) = _units(i);
            assertEq(c, 0, "no claim units");
            lendingWant += held0[i].mulDiv(shares, supply0) - LENDING_ROUNDING_UNITS;
        }
        (,,, uint256 used) = fund.inKindAllowance();
        assertApproxEqAbs(used, lendingWant, 3 * LENDING_ROUNDING_UNITS, "use = lending USDC paid");
        assertGt(IERC20(WETH).balanceOf(alice), 0, "wETH in kind");
    }

    /// @notice With no allowance every lending leg becomes a claim on a share of its position (RB-21), keyed to the
    ///         owner, with the exit fee's share as the fee recipient's own claim. Check 10 holds.
    function test_E20_beyondAllowanceLendingBecomesPositionClaims() public fixtureCovered {
        _seedAndInvest();
        _setAllowance(0, 0);
        _giveShares(alice, fund.totalSupply() / 10);
        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        uint256 shares = fund.balanceOf(alice);
        uint256 usdcBefore = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        fund.redeemInKind(shares, alice, alice);
        _assertPerShareNotLower(idle0, held0, supply0, "beyond allowance");
        uint256 idlePart = idle0.mulDiv(shares, supply0);
        assertEq(IERC20(USDC).balanceOf(alice) - usdcBefore, idlePart - idlePart.mulDiv(EXIT_FEE_BPS, BPS), "only idle");
        for (uint256 k; k < N_LENDING; ++k) {
            uint256 i = _lendingIdx(k);
            uint256 want = held0[i].mulDiv(shares, supply0) - LENDING_ROUNDING_UNITS;
            (uint256 units, uint256 value) = fund.positionClaimOf(i, alice);
            (uint256 feeUnits, uint256 feeValue) = fund.positionClaimOf(i, feeRecipient);
            assertGt(units, 0, "claim recorded");
            assertEq(feeUnits, (units + feeUnits).mulDiv(EXIT_FEE_BPS, BPS), "fee share as its own claim");
            assertApproxEqAbs(value + feeValue, want, 2, "claim worth the slice");
            (, uint256 c) = _units(i);
            assertEq(c, units + feeUnits, "claim units total");
        }
        (,,, uint256 used) = fund.inKindAllowance();
        assertEq(used, 0, "nothing paid in USDC");
    }

    /// @notice A total over the allowance is paid pro rata over the venues up to it; the rest becomes claims; the
    ///         period's allowance is then spent, and a new period pays again.
    function test_E20_allowanceIsProRataAndPerPeriod() public fixtureCovered {
        _seedAndInvest();
        uint128 floorUsdc = 1_000e6;
        _setAllowance(0, floorUsdc);
        _giveShares(alice, fund.totalSupply() / 10);
        (, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        uint256 half = fund.balanceOf(alice) / 2;
        vm.prank(alice);
        fund.redeemInKind(half, alice, alice);
        (,,, uint256 used) = fund.inKindAllowance();
        assertLe(used, floorUsdc, "never above the allowance");
        assertGe(used, floorUsdc - 3 * LENDING_ROUNDING_UNITS, "the allowance is used");
        uint256 total;
        for (uint256 k; k < N_LENDING; ++k) {
            total += held0[_lendingIdx(k)].mulDiv(half, supply0) - LENDING_ROUNDING_UNITS;
        }
        for (uint256 k; k < N_LENDING; ++k) {
            uint256 i = _lendingIdx(k);
            uint256 want = held0[i].mulDiv(half, supply0) - LENDING_ROUNDING_UNITS;
            (, uint256 value) = fund.positionClaimOf(i, alice);
            (, uint256 feeValue) = fund.positionClaimOf(i, feeRecipient);
            uint256 paid = want.mulDiv(floorUsdc, total);
            assertApproxEqAbs(value + feeValue, want - paid, 5, "each venue paid its pro-rata part");
        }
        // Same period: nothing left, so the second half is all claims.
        (uint256 aliceUnits0,) = fund.positionClaimOf(IDX_AAVE, alice);
        vm.prank(alice);
        fund.redeemInKind(half, alice, alice);
        (,,, uint256 used2) = fund.inKindAllowance();
        assertEq(used2, used, "no USDC once the period's allowance is spent");
        (uint256 aliceUnits1,) = fund.positionClaimOf(IDX_AAVE, alice);
        assertGt(aliceUnits1, aliceUnits0, "the rest is claims");
        // Next period: USDC again.
        vm.warp(block.timestamp + DEFAULT_IN_KIND_PERIOD);
        _refreshFeeds();
        _giveShares(bob, supply0 / 100);
        uint256 b = fund.balanceOf(bob);
        vm.prank(bob);
        fund.redeemInKind(b, bob, bob);
        (,,, uint256 used3) = fund.inKindAllowance();
        assertGt(used3, 0, "a new period has a new allowance");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  RB-21: a claim is a share of the position
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Alice exits in kind with no allowance, so she holds a claim on every lending position.
    function _aliceClaims() internal {
        _seedAndInvest();
        _setAllowance(0, 0);
        _giveShares(alice, fund.totalSupply() / 10);
        uint256 shares = fund.balanceOf(alice);
        vm.prank(alice);
        fund.redeemInKind(shares, alice, alice);
        _setAllowance(DEFAULT_IN_KIND_BPS, DEFAULT_IN_KIND_FLOOR_USDC);
    }

    /// @notice A deposit (mintInKind) or a rebalance step into a venue does not change a claim's value.
    function test_RB21_depositOrStepIntoVenueKeepsClaimValue() public fixtureCovered {
        _aliceClaims();
        uint256[N_LENDING] memory v0;
        for (uint256 k; k < N_LENDING; ++k) {
            (, v0[k]) = fund.positionClaimOf(_lendingIdx(k), alice);
        }
        _mintInKind(fund.totalSupply() / 10);
        for (uint256 k; k < N_LENDING; ++k) {
            (, uint256 v1) = fund.positionClaimOf(_lendingIdx(k), alice);
            assertGe(v1, v0[k], "a supply never lowers a claim");
            assertLe(v1, v0[k] + 1, "a supply never raises a claim beyond rounding");
        }
        // A step from idle into Aave (the plan is past its end, so the path allows a buy up to the target).
        (uint256 nav, uint256 idle, uint256[] memory values) = fund.portfolioValues();
        uint256 room = nav.mulDiv(_weights()[IDX_AAVE], BPS) - values[IDX_AAVE];
        uint256 n = Math.min(room, idle) / 2;
        assertGt(n, 10e6, "room for a step");
        (uint256 u0,) = _units(IDX_AAVE);
        _step(IDX_AAVE, n);
        (uint256 u1,) = _units(IDX_AAVE);
        assertGt(u1, u0, "the step minted holders' units");
        (, uint256 v2) = fund.positionClaimOf(IDX_AAVE, alice);
        assertGe(v2, v0[IDX_AAVE], "a step never lowers a claim");
        assertLe(v2, v0[IDX_AAVE] + 2, "a step never raises a claim beyond rounding");
    }

    /// @notice A rebalance step OUT of a venue burns only holders' units: the claim's value is unchanged.
    function test_RB21_stepOutOfVenueKeepsClaimValue() public fixtureCovered {
        _aliceClaims();
        // A new plan moves 10 % of NAV out of Aave into Moonwell; after its end, step Aave -> idle.
        uint256[N_ASSETS] memory w = _weights();
        uint256[] memory bps = new uint256[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            bps[i] = w[i];
        }
        bps[IDX_AAVE] -= 1_000;
        bps[IDX_MOONWELL] += 1_000;
        fund.setTargetAndOpenPlan(_ids(), bps, PlanParams(1 days, 500), bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);
        _refreshFeeds();
        // Measured after the warp: a day of venue interest is the claim's to keep (test_RB21_claimGains...).
        (, uint256 v0) = fund.positionClaimOf(IDX_AAVE, alice);
        (uint256 u0, uint256 c0) = _units(IDX_AAVE);
        (uint256 nav,,) = fund.portfolioValues();
        uint256 n = nav / 20;
        fund.executeStep(StepOrder(IDX_AAVE, IDLE_INDEX, n, n - 1, 0, n.mulDiv(100, BPS)));
        (uint256 u1, uint256 c1) = _units(IDX_AAVE);
        assertLt(u1, u0, "the step burned units");
        assertEq(c1, c0, "only holders' units");
        (, uint256 v1) = fund.positionClaimOf(IDX_AAVE, alice);
        assertGe(v1, v0, "a step out never lowers a claim");
        assertLe(v1, v0 + 2, "a step out never raises a claim beyond rounding");
    }

    /// @notice The claim gains with the venue pro rata with the holders (interest accrual over 30 days).
    function test_RB21_claimGainsWithTheVenueProRata() public fixtureCovered {
        _aliceClaims();
        (, uint256 claim0) = fund.positionClaimOf(IDX_AAVE, alice);
        (, uint256[] memory held0) = fund.heldBalances();
        vm.warp(block.timestamp + 30 days);
        _refreshFeeds();
        (, uint256 claim1) = fund.positionClaimOf(IDX_AAVE, alice);
        (, uint256[] memory held1) = fund.heldBalances();
        assertGt(held1[IDX_AAVE], held0[IDX_AAVE], "the venue paid interest");
        assertGt(claim1, claim0, "the claim earned it too");
        // claim1 / claim0 == held1 / held0, up to one unit of rounding on each side.
        assertApproxEqAbs(claim1 * held0[IDX_AAVE], claim0 * held1[IDX_AAVE], held0[IDX_AAVE] + held1[IDX_AAVE], "pro rata");
    }

    /// @notice The claim loses with the venue pro rata with the holders (a 10 % venue loss, mocked).
    function test_RB21_claimLosesWithTheVenueProRata() public fixtureCovered {
        _aliceClaims();
        (, uint256 claim0) = fund.positionClaimOf(IDX_MOONWELL, alice);
        (, uint256[] memory held0) = fund.heldBalances();
        uint256 p = IStrategyAdapter(address(moonwell)).totalAssets();
        vm.mockCall(address(moonwell), abi.encodeCall(IStrategyAdapter.totalAssets, ()), abi.encode(p * 9 / 10));
        (, uint256 claim1) = fund.positionClaimOf(IDX_MOONWELL, alice);
        (, uint256[] memory held1) = fund.heldBalances();
        assertApproxEqAbs(claim1, claim0 * 9 / 10, 2, "claim lost 10 %");
        assertApproxEqAbs(held1[IDX_MOONWELL], held0[IDX_MOONWELL] * 9 / 10, 2, "holders lost 10 %");
    }

    /// @notice `claimPosition` pays today's value less the rounding margin to the address the owner names, burns the
    ///         claim's units and leaves the holders' part whole.
    function test_E9_claimPositionPaysTodayValueAndBurnsUnits() public fixtureCovered {
        _aliceClaims();
        (uint256 units, uint256 value) = fund.positionClaimOf(IDX_MOONWELL, alice);
        (uint256 u0, uint256 c0) = _units(IDX_MOONWELL);
        (, uint256[] memory held0) = fund.heldBalances();

        vm.prank(alice);
        vm.expectRevert(IFundEvents.ZeroAddress.selector);
        fund.claimPosition(IDX_MOONWELL, address(0));

        vm.prank(alice);
        uint256 paid = fund.claimPosition(IDX_MOONWELL, bob);
        assertEq(paid, value - LENDING_ROUNDING_UNITS, "today's value less the margin");
        assertEq(IERC20(USDC).balanceOf(bob), paid, "paid to the named address");
        (uint256 u1, uint256 c1) = _units(IDX_MOONWELL);
        assertEq(u1, u0 - units, "claim units burned");
        assertEq(c1, c0 - units, "claim total down");
        (, uint256[] memory held1) = fund.heldBalances();
        assertGe(held1[IDX_MOONWELL], held0[IDX_MOONWELL], "holders' part not lowered");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.NoPositionClaim.selector, IDX_MOONWELL, alice));
        fund.claimPosition(IDX_MOONWELL, alice);
    }

    /// @notice A venue that cannot pay leaves the claim whole (`DeferredShortfall` on a short fill).
    function test_E9_claimPositionShortFillKeepsTheClaim() public fixtureCovered {
        _aliceClaims();
        (uint256 units, uint256 value) = fund.positionClaimOf(IDX_AAVE, alice);
        uint256 ask = value - LENDING_ROUNDING_UNITS;
        vm.mockCall(address(aave), abi.encodeCall(IStrategyAdapter.withdraw, (ask)), abi.encode(uint256(0)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.DeferredShortfall.selector, IDX_AAVE, 0, ask));
        fund.claimPosition(IDX_AAVE, alice);
        (uint256 after_,) = fund.positionClaimOf(IDX_AAVE, alice);
        assertEq(after_, units, "claim whole");
    }

    /// @notice The emergency unwind drains the holders' part and leaves the claims' part in the venue.
    function test_E9_emergencyUnwindLeavesClaimsInTheVenue() public fixtureCovered {
        _aliceClaims();
        (, uint256 value) = fund.positionClaimOf(IDX_AAVE, alice);
        (, uint256 feeValue) = fund.positionClaimOf(IDX_AAVE, feeRecipient);
        vm.prank(emergency);
        fund.emergencyUnwind();
        (, uint256[] memory held) = fund.heldBalances();
        assertLe(held[IDX_AAVE], 2 * LENDING_ROUNDING_UNITS, "holders' part drained to idle, less the margin");
        assertGe(aave.totalAssets(), value + feeValue, "claims' part left in the venue");
        (, uint256 after_) = fund.positionClaimOf(IDX_AAVE, alice);
        assertGe(after_, value, "claim not lowered");
        vm.prank(alice);
        uint256 paid = fund.claimPosition(IDX_AAVE, alice);
        assertGe(paid + LENDING_ROUNDING_UNITS, value, "claim still pays in full");
    }

    /// @notice Check 10 still holds for every flow while claims exist (holders' part = units, not the raw venue).
    function test_RB13_flowsKeepTheProportionWhileClaimsExist() public fixtureCovered {
        _aliceClaims();
        (uint256 idle0, uint256[] memory held0) = fund.heldBalances();
        uint256 supply0 = fund.totalSupply();
        uint256 n = supply0 / 20;
        _mintInKind(n);
        _assertPerShareNotLower(idle0, held0, supply0, "mintInKind");
        (idle0, held0) = fund.heldBalances();
        supply0 = fund.totalSupply();
        fund.sellForFlow(n / 2, _sellFloors(n / 2));
        _assertPerShareNotLower(idle0, held0, supply0, "sellForFlow");
        fund.transfer(bob, n / 2);
        (idle0, held0) = fund.heldBalances();
        supply0 = fund.totalSupply();
        vm.prank(bob);
        fund.redeemInKind(n / 2, bob, bob);
        _assertPerShareNotLower(idle0, held0, supply0, "redeemInKind");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E23: the two fixes
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice An in-kind exit still works when one venue's value read reverts: that leg becomes a claim on the
    ///         exiter's units with no read and no withdrawal; the other legs pay.
    function test_E23_inKindExitSurvivesARevertingVenueRead() public fixtureCovered {
        _seedAndInvest();
        _giveShares(alice, fund.totalSupply() / 10);
        (uint256 u0, uint256 c0) = _units(IDX_MOONWELL);
        uint256 shares = fund.balanceOf(alice);
        uint256 supply0 = fund.totalSupply();
        vm.mockCallRevert(address(moonwell), abi.encodeCall(IStrategyAdapter.totalAssets, ()), "venue down");
        vm.prank(alice);
        fund.redeemInKind(shares, alice, alice);
        vm.clearMockedCalls();
        (uint256 units,) = fund.positionClaimOf(IDX_MOONWELL, alice);
        (uint256 feeUnits,) = fund.positionClaimOf(IDX_MOONWELL, feeRecipient);
        assertEq(units + feeUnits, (u0 - c0).mulDiv(shares, supply0), "the exiter's units became its claim");
        (uint256 u1,) = _units(IDX_MOONWELL);
        assertEq(u1, u0, "nothing withdrawn from the unreadable venue");
        (uint256 aaveUnits,) = fund.positionClaimOf(IDX_AAVE, alice);
        assertEq(aaveUnits, 0, "readable venues paid in USDC");
        assertGt(IERC20(USDC).balanceOf(alice), 0, "USDC leg paid");
    }

    function test_E23_zeroReceiverRejected() public fixtureCovered {
        _seedAndInvest();
        _giveShares(alice, fund.totalSupply() / 100);
        uint256 shares = fund.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(IFundEvents.ZeroAddress.selector);
        fund.redeemInKind(shares, address(0), alice);
    }

    /// @notice Claims are keyed to the owner, not the receiver; for shares the queue escrows (`owner == queue`) they
    ///         are keyed to the receiver, the request's owner.
    function test_E23_claimsKeyedToTheOwner() public fixtureCovered {
        _seedAndInvest();
        _setAllowance(0, 0);
        _giveShares(alice, fund.totalSupply() / 100);
        uint256 shares = fund.balanceOf(alice);
        vm.prank(alice);
        fund.redeemInKind(shares, bob, alice);
        (uint256 aliceUnits,) = fund.positionClaimOf(IDX_AAVE, alice);
        (uint256 bobUnits,) = fund.positionClaimOf(IDX_AAVE, bob);
        assertGt(aliceUnits, 0, "keyed to the owner");
        assertEq(bobUnits, 0, "not to the receiver");

        // The queue's escrow path: this contract is the bound queue and holds the shares for bob.
        _mintInKind(shares);
        fund.redeemInKind(shares, bob, address(this));
        (bobUnits,) = fund.positionClaimOf(IDX_AAVE, bob);
        (uint256 queueUnits,) = fund.positionClaimOf(IDX_AAVE, address(this));
        assertGt(bobUnits, 0, "escrowed shares: keyed to the request's owner");
        assertEq(queueUnits, 0, "never to the queue");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E19: NAV views and the last good NAV
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function test_E19_lastGoodNavIsNowWhileHealthy() public fixtureCovered {
        _seedAndInvest();
        (uint256 nav, uint64 at) = fund.lastGoodNav();
        assertEq(nav, fund.totalAssets(), "the NAV now");
        assertEq(at, block.timestamp, "now");
    }

    /// @notice A stale basket feed reverts `totalAssets` and the convert views; `lastGoodNav` returns the value the
    ///         fund recorded at its last flow, with that time.
    function test_E19_staleFeedRevertsNavViewsAndKeepsLastGoodNav() public fixtureCovered {
        _seedAndInvest();
        _mintInKind(fund.totalSupply() / 50);
        uint256 navAtFlow = fund.totalAssets();
        uint256 flowAt = block.timestamp;
        vm.warp(block.timestamp + ETH_MAX_AGE + 1);
        bytes memory stale =
            abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, IDX_WETH, FeedStatus.Stale);
        vm.expectRevert(stale);
        fund.totalAssets();
        vm.expectRevert(stale);
        fund.convertToAssets(1e24);
        vm.expectRevert(stale);
        fund.convertToShares(1e6);
        (uint256 nav, uint64 at) = fund.lastGoodNav();
        assertEq(nav, navAtFlow, "the NAV recorded at the last flow");
        assertEq(at, flowAt, "with its time");
        _refreshFeeds();
        assertGt(fund.totalAssets(), 0, "healthy again");
    }

    /// @notice Once a queue is bound, the sequencer and the USDC peg gate the views too (check 2).
    function test_E19_sequencerDownAndUsdcOffPegRevert() public fixtureCovered {
        _seed();
        FxMockAggregator(FEED_SEQUENCER).set(0, 1, block.timestamp, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, IDLE_INDEX, FeedStatus.SequencerDown)
        );
        fund.totalAssets();
        FxMockAggregator(FEED_SEQUENCER).set(0, 0, block.timestamp - 10 minutes, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, IDLE_INDEX, FeedStatus.SequencerGrace)
        );
        fund.totalAssets();
        _refreshFeeds();
        FxMockAggregator(FEED_USDC).set(8, 0.98e8, block.timestamp, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, IDLE_INDEX, FeedStatus.OffPeg));
        fund.totalAssets();
        FxMockAggregator(FEED_CBBTC).set(8, 0, block.timestamp, block.timestamp);
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, IDX_CBBTC, FeedStatus.NonPositive)
        );
        fund.totalAssets();
        (uint256 nav, uint64 at) = fund.lastGoodNav();
        assertEq(nav, SEED_USDC, "recorded at seed");
        assertEq(at, block.timestamp, "seed time");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  E15 / RB-17: asset admission
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _freshFundWithAdapters() internal returns (IRobotMoneyFundFull f, address rate, address exactOut) {
        f = _deployFund();
        rate = address(new AaveV3RateAdapter(AAVE_POOL, USDC, AAVE_A_USDC, address(f)));
        exactOut = address(new UniswapV3ExactOutSwapAdapter(ROUTER));
        f.setAdapterCodeHashAllowed(rate.codehash, true);
        f.setAdapterCodeHashAllowed(exactOut.codehash, true);
    }

    function test_RB17_basketWithoutAFeedIsRefused() public fixtureCovered {
        (IRobotMoneyFundFull f,, address ex) = _freshFundWithAdapters();
        AssetConfig memory c = _basket(WETH, WETH_POOL, address(0), ETH_MAX_AGE);
        c.adapter = ex;
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.MissingFeed.selector, 0));
        f.addAsset(c);
        c.feed = FEED_ETH;
        c.maxFeedAge = 0;
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.MissingFeed.selector, 0));
        f.addAsset(c);
        c.maxFeedAge = MAX_FEED_AGE + 1;
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.MissingFeed.selector, 0));
        f.addAsset(c);
        // A feed that is not live (stale) is refused too.
        c.maxFeedAge = ETH_MAX_AGE;
        FxMockAggregator(FEED_ETH).set(8, 3_000e8, block.timestamp, block.timestamp - ETH_MAX_AGE - 1);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.FeedUnhealthy.selector, 0, FeedStatus.Stale));
        f.addAsset(c);
        _refreshFeeds();
        assertEq(f.addAsset(c), 0, "a live feed is admitted");
    }

    function test_RB17_basketWithoutPoolHistoryIsRefused() public fixtureCovered {
        (IRobotMoneyFundFull f,, address ex) = _freshFundWithAdapters();
        AssetConfig memory c = _basket(WETH, WETH_POOL, FEED_ETH, ETH_MAX_AGE);
        c.adapter = ex;
        uint32[] memory ago = new uint32[](2);
        ago[0] = 1 hours;
        vm.mockCallRevert(WETH_POOL, abi.encodeCall(IObservablePool.observe, (ago)), "OLD");
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.PoolHistoryTooShort.selector, 0, uint32(1 hours)));
        f.addAsset(c);
    }

    function test_RB17_lendingWithoutVenueRateIsRefused() public fixtureCovered {
        (IRobotMoneyFundFull f, address rate,) = _freshFundWithAdapters();
        AaveV3Adapter plain = new AaveV3Adapter(AAVE_POOL, USDC, AAVE_A_USDC, address(f));
        f.setAdapterCodeHashAllowed(address(plain).codehash, true);
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.LendingRateUnavailable.selector, address(plain)));
        f.addAsset(_lending(address(plain)));
        AssetConfig memory c = _lending(rate);
        c.feed = FEED_ETH;
        vm.expectRevert(IFundEvents.InvalidParam.selector);
        f.addAsset(c);
    }

    /// @notice The pool-share rule: a basket target times the TVL cap above `poolShareBps` of the pool's
    ///         time-weighted USDC depth is refused; one at or under it is accepted.
    function test_RB17_poolShareRuleRefusesATargetOverTheLimit() public fixtureCovered {
        (bool ok, uint256 depth) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, 1 hours);
        assertTrue(ok, "depth read");
        assertGt(depth, 0, "depth");
        uint256 limit = depth.mulDiv(fund.poolShareBps(), BPS);
        emit log_named_uint("wETH pool USDC depth (1 h, USDC units)", depth);
        (bool ok2, uint256 depth2) = FundValuationLib.poolUsdcDepth(CBBTC_POOL, USDC, 1 hours);
        assertTrue(ok2, "cbBTC depth read");
        emit log_named_uint("cbBTC pool USDC depth (1 h, USDC units)", depth2);

        address[] memory ids = _ids();
        uint256[] memory bps = new uint256[](N_ASSETS);
        bps[IDX_AAVE] = 5_000;
        bps[IDX_MOONWELL] = 4_000;
        bps[IDX_WETH] = 1_000;
        // A TVL cap whose 10 % is one USDC unit over the limit.
        uint256 cap = (limit + 1) * 10;
        fund.setTvlCap(cap);
        vm.expectRevert(
            abi.encodeWithSelector(IRobotMoneyFund.PoolShareExceeded.selector, IDX_WETH, limit + 1, limit)
        );
        fund.setTargetAndOpenPlan(ids, bps, PlanParams(1 days, 30), bytes32(0));
        fund.setTvlCap(limit * 10);
        fund.setTargetAndOpenPlan(ids, bps, PlanParams(1 days, 30), bytes32(0));
    }

    /// @notice Liquidity added in the same transaction does not raise the limit; held for part of the window it
    ///         counts only by its time-weighted share.
    function test_RB17_liquidityAddedNowDoesNotRaiseTheLimit() public fixtureCovered {
        (, uint256 depth0) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, 1 hours);
        // The control: the same pool and the same moments without the new liquidity. The window moves with time, so
        // the slices it drops and adds change the depth a little on their own; the mint is measured against that.
        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + 10 minutes);
        _refreshFeeds();
        (, uint256 ctl2) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, 1 hours);
        vm.warp(block.timestamp + 45 minutes);
        _refreshFeeds();
        (, uint256 ctl3) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, 1 hours);
        vm.revertToState(snap);
        IFxV3Pool pool = IFxV3Pool(WETH_POOL);
        (, int24 tick,,,,,) = pool.slot0();
        int24 lower = (tick / 10 - 50) * 10;
        int24 upper = (tick / 10 + 50) * 10;
        pool.mint(address(this), lower, upper, 1e19, "");
        (, uint256 depth1) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, 1 hours);
        assertEq(depth1, depth0, "same-transaction liquidity does not count");
        // Since the review fix R-F2 the depth is the third-thinnest of twelve five-minute slices: liquidity counts only
        // once it is held through ten of them.
        vm.warp(block.timestamp + 10 minutes);
        _refreshFeeds();
        (, uint256 depth2) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, 1 hours);
        assertEq(depth2, ctl2, "held through two slices: not counted yet");
        vm.warp(block.timestamp + 45 minutes);
        _refreshFeeds();
        (, uint256 depth3) = FundValuationLib.poolUsdcDepth(WETH_POOL, USDC, 1 hours);
        assertGt(depth3, ctl3, "held through eleven slices: counted");
    }

    /// @dev Pays the pool for `test_RB17_liquidityAddedNowDoesNotRaiseTheLimit`.
    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes calldata) external {
        IFxV3Pool pool = IFxV3Pool(msg.sender);
        _pay(pool.token0(), amount0);
        _pay(pool.token1(), amount1);
    }

    function _pay(address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == USDC) fundUsdc(msg.sender, amount);
        else deal(token, msg.sender, IERC20(token).balanceOf(msg.sender) + amount);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Fixture gap found by this file
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Compound V3's venue rate (`CompoundV3RateAdapter.ratePerUnit`) at the pin. Comet serves
    ///         `totalsBasic()` from its extension contract, which the fixture recorded on 2026-11-11 lacked (the
    ///         call returned no data and the rate read reverted). `verify` re-recorded the fixture with that account
    ///         and removed this test's skip; the name keeps the history. Since `hardening` (2026-11-12) this file's
    ///         own fund lists Compound too (index 4), and the listed copy's rate is the same index.
    function test_fixtureMiss_cometRateAtThePin() public fixtureCovered {
        CompoundV3RateAdapter fresh = new CompoundV3RateAdapter(COMET, USDC, address(fund));
        assertGt(fresh.ratePerUnit(), 1e18, "Comet's supply index at the pin");
        assertEq(comet.ratePerUnit(), fresh.ratePerUnit(), "the listed copy reads the same index");
        assertEq(fund.assetConfig(IDX_COMET).adapter, address(comet), "Compound is listed in this file's fund");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Adversarial code review of 2026-11-12 (proposal §14): the fund's errors, each failing before its fix
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice B-F1: an excluded lending venue holding only the fund's own rounding dust can be removed, so deposits
    ///         reopen. Before the fix `deactivateAsset` needed `totalAssets() == 0` exactly.
    function test_BF1_anExcludedVenueWithDustCanBeRemoved() public fixtureCovered {
        _seed();
        fund.setAdapterCodeHashAllowed(address(moonwell).codehash, false);
        assertGt(fund.openExclusionOf(IDX_MOONWELL), 0, "excluded");
        vm.mockCall(
            address(moonwell), abi.encodeCall(IStrategyAdapter.totalAssets, ()), abi.encode(LENDING_ROUNDING_UNITS)
        );
        fund.deactivateAsset(IDX_MOONWELL);
        assertEq(fund.openExclusionOf(IDX_MOONWELL), 0, "the record closed: deposits reopen");
    }

    /// @notice B-F1: an excluded venue whose `totalAssets()` read fails can be removed too (its value is in the
    ///         ledger already).
    function test_BF1_anExcludedVenueWhoseReadFailsCanBeRemoved() public fixtureCovered {
        _seed();
        fund.setAdapterCodeHashAllowed(address(moonwell).codehash, false);
        vm.mockCallRevert(address(moonwell), abi.encodeCall(IStrategyAdapter.totalAssets, ()), "broken");
        fund.deactivateAsset(IDX_MOONWELL);
        assertEq(fund.openExclusionOf(IDX_MOONWELL), 0, "the record closed");
    }

    /// @notice B-F1 control: a counted venue whose read fails, or that holds more than dust, is never removed.
    function test_BF1_aCountedVenueCannotBeRemovedUnread_control() public fixtureCovered {
        _seed();
        vm.mockCallRevert(address(moonwell), abi.encodeCall(IStrategyAdapter.totalAssets, ()), "broken");
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.AssetStillHeld.selector, IDX_MOONWELL));
        fund.deactivateAsset(IDX_MOONWELL);
        vm.clearMockedCalls();
        vm.mockCall(
            address(moonwell), abi.encodeCall(IStrategyAdapter.totalAssets, ()), abi.encode(LENDING_ROUNDING_UNITS + 1)
        );
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.AssetStillHeld.selector, IDX_MOONWELL));
        fund.deactivateAsset(IDX_MOONWELL);
    }

    /// @notice B-F3: a lending adapter whose inactive entry still has open position claims cannot be listed again,
    ///         or those claims would be paid from new holders' money.
    function test_BF3_anAdapterWithOpenClaimsCannotBeListedAgain() public fixtureCovered {
        _aliceClaims();
        (uint256 units,) = fund.positionClaimOf(IDX_MOONWELL, alice);
        assertGt(units, 0, "alice holds Moonwell claims");
        uint256[N_ASSETS] memory w = _weights();
        uint256[] memory bps = new uint256[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            bps[i] = w[i];
        }
        bps[IDX_COMET] += bps[IDX_MOONWELL];
        bps[IDX_MOONWELL] = 0;
        fund.setTargetAndOpenPlan(_ids(), bps, PlanParams(1 days, 500), bytes32(0));
        vm.warp(uint256(fund.plan().endTime) + 1);
        _refreshFeeds();
        fund.concludePlan(PlanStatus.Expired);
        vm.mockCall(
            address(moonwell), abi.encodeCall(IStrategyAdapter.totalAssets, ()), abi.encode(LENDING_ROUNDING_UNITS)
        );
        fund.deactivateAsset(IDX_MOONWELL);
        vm.clearMockedCalls();
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.DuplicateAsset.selector, IDX_MOONWELL));
        fund.addAsset(_lending(address(moonwell)));
    }

    /// @notice B-F4: §4.5 rule 3 holds after a TVL cap rise: a cap that puts a live target over its pool share is
    ///         refused. A lower cap is never refused.
    function test_BF4_aHigherTvlCapIsCheckedAgainstThePoolShare() public fixtureCovered {
        _seedAndInvest();
        vm.expectPartialRevert(IRobotMoneyFund.PoolShareExceeded.selector);
        fund.setTvlCap(1e30);
        fund.setTvlCap(TVL_CAP / 2);
    }

    /// @notice B-F5: a plan never spends more than its budget (RB-4): a last step whose cost would pass the budget is
    ///         refused. Before the fix the step booked its cost and only then halted, past the budget.
    function test_BF5_noStepOvershootsThePlanBudget() public fixtureCovered {
        _seed();
        uint256[N_ASSETS] memory w = _weights();
        uint256[] memory bps = new uint256[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            bps[i] = w[i];
        }
        fund.setTargetAndOpenPlan(_ids(), bps, PlanParams(1 days, 1), bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);
        _refreshFeeds();
        for (uint256 i; i < N_ASSETS; ++i) {
            (uint256 nav,,) = fund.portfolioValues();
            uint256 notional = nav.mulDiv(w[i] * 99, BPS * 100);
            uint256 minOut =
                fund.assetConfig(i).kind == AssetKind.Basket ? fund.assetTokenValue(i, notional).mulDiv(98, 100) : 0;
            try fund.executeStep(StepOrder(IDLE_INDEX, i, notional, 0, minOut, notional.mulDiv(100, BPS))) {} catch {}
            Plan memory p = fund.plan();
            assertLe(p.costSpent, p.costBudget, "RB-4: never past the budget");
            if (p.status != PlanStatus.Open) break;
        }
    }
}
