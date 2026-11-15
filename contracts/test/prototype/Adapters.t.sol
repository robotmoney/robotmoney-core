// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 check 9 (the per-swap limit of the pro-rata
//            purchase), §6 (adapter row: an exact-output swap); docs/technical/one-vault-timed-flows-eng-plan.md E3,
//            E15, §3.2 (adapter copies); one-vault step 3 finish plan §3.3 item 5 (`hardening`, 2026-11-12)
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BaseFixture} from "./BaseFixture.sol";
import {GovernedUUPS} from "../../lib/GovernedUUPS.sol";
import {TickMath} from "../../lib/TickMath.sol";
import {ISwapRouter} from "../../interfaces/ISwapRouter.sol";
import {AerodromeExactOutSwapAdapter} from "./src/adapters/AerodromeExactOutSwapAdapter.sol";
import {
    ISwapRouterExactOut,
    UniswapV3ExactOutSwapAdapter
} from "./src/adapters/UniswapV3ExactOutSwapAdapter.sol";
import {AerodromeSwapAdapter} from "../../adapters/AerodromeSwapAdapter.sol";
import {TwapTickMath} from "../../lib/TwapTickMath.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MechAaveAdapter} from "./mocks/MechAaveAdapter.sol";
import {MechSwapAdapter} from "./mocks/MechSwapAdapter.sol";
import {RobotMoneyFund} from "./src/RobotMoneyFund.sol";
import {IRobotMoneyFund, IRobotMoneyFundFull} from "./src/interfaces/IRobotMoneyFund.sol";
import {FundExclusionLedger} from "./src/FundExclusionLedger.sol";
import {FlowQueue} from "./src/FlowQueue.sol";
import {
    AssetConfig,
    AssetKind,
    FundInitParams,
    PlanParams,
    StepOrder,
    Venue,
    BPS,
    DEFAULT_IN_KIND_PERIOD,
    IDLE_INDEX,
    LENDING_ROUNDING_UNITS
} from "./src/FundTypes.sol";
import {
    FlowParams,
    FlowQueueInit,
    IFlowEvents,
    Quote,
    Request,
    SettleCheck,
    DEFAULT_CANCEL_BUFFER,
    DEFAULT_MAX_PAUSE
} from "./src/FlowTypes.sol";

/// @notice The Slipstream pool and factory reads these tests make.
interface IAeroCLPoolRead {
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IAeroCLFactoryRead {
    function getPool(address tokenA, address tokenB, int24 tickSpacing)
        external
        view
        returns (address);
}

/// @title AdaptersTest
/// @notice The Aerodrome exact-output adapter copy (`AerodromeExactOutSwapAdapter`) deployed and run against a real
///         Aerodrome Slipstream pool at the pin: no harness, no mock, no fund. The Uniswap copy is exercised by every
///         harness flow test; the Aerodrome copy had no test before this file (step 3 plan §3.3 item 5).
///
///         The pool. No Aerodrome account was in the fixture recorded on 2026-11-12, so this file names one and asks
///         `verify` to record it (requests.md, `hardening`): the Slipstream CL factory 0x5e7B…809A, its SwapRouter
///         0xBE6D…18a5 (whose `factory()` is that factory at the pin) and the factory's wETH / USDC pool of tick
///         spacing 100, 0xb2cc…DC59 (at block 55462550: liquidity 1.13e17, fee 150 pips). These three were read with
///         `cast call --block 55462550` against the public node; `setUp` re-reads the pool from the factory.
///         Until the re-record, replay stops in `setUp` with `FixtureAccountMiss` naming the first missing account;
///         the recorder's fork run has them all.
///
///         Every check is a relationship to the pool's own price before and after the swap; nothing hard-codes a
///         market price or an amount out.
contract AdaptersTest is BaseFixture {
    using Math for uint256;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    /// @dev The Uniswap V3 wETH / USDC pool of the harness (in the fixture): a pool the Aerodrome factory did not make.
    address internal constant UNI_WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;

    address internal constant AERO_FACTORY = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;
    address internal constant AERO_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address internal constant AERO_WETH_USDC = 0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59;
    int24 internal constant TICK_SPACING = 100;
    /// @dev The adapter's `fee` argument is the tick spacing (as the production `swap`).
    uint24 internal constant FEE_ARG = 100;
    uint32 internal constant TWAP_WINDOW = 1_800;

    AerodromeExactOutSwapAdapter internal adapter;
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        if (!recording) {
            _requireRecorded(AERO_FACTORY);
            _requireRecorded(AERO_ROUTER);
            _requireRecorded(AERO_WETH_USDC);
        }
        assertEq(
            IAeroCLFactoryRead(AERO_FACTORY).getPool(WETH, USDC, TICK_SPACING),
            AERO_WETH_USDC,
            "the factory's wETH / USDC pool of tick spacing 100"
        );
        adapter = new AerodromeExactOutSwapAdapter(AERO_ROUTER, AERO_FACTORY);
    }

    /// @dev In replay, an account the fixture does not hold has no code: fail naming it (the fix is a re-record).
    function _requireRecorded(address a) internal view {
        if (a.code.length == 0) revert FixtureAccountMiss(a);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Real FiatToken balance slot (mapping at slot 9), as the harness writes it.
    function _fundUsdc(address to, uint256 amount) internal {
        uint256 before = IERC20(USDC).balanceOf(to);
        vm.store(USDC, keccak256(abi.encode(to, uint256(9))), bytes32(before + amount));
        assertEq(IERC20(USDC).balanceOf(to), before + amount, "fund usdc");
    }

    /// @dev USDC units for `weth` wETH units at the pool's exact spot (sqrtPriceX96), rounded down. wETH is token0.
    function _usdcFor(uint256 weth) internal view returns (uint256) {
        (uint160 sqrtP,,,,,) = IAeroCLPoolRead(AERO_WETH_USDC).slot0();
        return weth.mulDiv(sqrtP, 1 << 96).mulDiv(sqrtP, 1 << 96);
    }

    /// @dev wETH units for `usdc` USDC units at the pool's exact spot, rounded down.
    function _wethFor(uint256 usdc) internal view returns (uint256) {
        (uint160 sqrtP,,,,,) = IAeroCLPoolRead(AERO_WETH_USDC).slot0();
        return usdc.mulDiv(1 << 96, sqrtP).mulDiv(1 << 96, sqrtP);
    }

    /// @dev `x / (1 − fee)`, rounded up: the input a swap whose net input is `x` pays with the pool's fee on top.
    function _withFee(uint256 x) internal view returns (uint256) {
        uint256 fee = IAeroCLPoolRead(AERO_WETH_USDC).fee();
        return x.mulDiv(1e6, 1e6 - fee, Math.Rounding.Ceil);
    }

    function _assertAdapterHoldsNothing() internal view {
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0, "adapter holds no USDC");
        assertEq(IERC20(WETH).balanceOf(address(adapter)), 0, "adapter holds no wETH");
        assertEq(
            IERC20(USDC).allowance(address(adapter), AERO_ROUTER),
            0,
            "USDC allowance to the router reset"
        );
        assertEq(
            IERC20(WETH).allowance(address(adapter), AERO_ROUTER),
            0,
            "wETH allowance to the router reset"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Tests
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice A purchase of exactly 1 wETH with USDC, then a sale of wETH for exactly 1 000 USDC: the recipient
    ///         gets exactly the amount out, the caller pays exactly `amountIn` (the unused input comes back in the same
    ///         call), the cost lies between the pool's spot before the swap and its spot after it plus the pool fee,
    ///         and the adapter keeps no balance and no allowance.
    function test_aerodromeExactOut_deliversExactlyAmountOut_returnsTheRest_resetsTheAllowance()
        public
        fixtureCovered
    {
        // USDC -> wETH, exactly 1 wETH.
        uint256 out = 1e18;
        uint256 spot0 = _usdcFor(out);
        uint256 maxIn = spot0.mulDiv(10_100, 10_000) + 1; // 1 % of room over the spot value
        // `verify` 2026-11-12: the test contract's address (forge's default) holds 0.02 USDC of real USDC on Base at the
        // pin, seen on the recorder's fork; every USDC balance check below counts from that real starting balance.
        uint256 usdc0 = IERC20(USDC).balanceOf(address(this));
        _fundUsdc(address(this), maxIn);
        IERC20(USDC).approve(address(adapter), maxIn);
        uint256 bobWeth0 = IERC20(WETH).balanceOf(bob);
        uint256 spent = adapter.swapExactOut(USDC, WETH, FEE_ARG, out, maxIn, bob, block.timestamp);
        uint256 spot1 = _usdcFor(out);
        emit log_named_decimal_uint("USDC for 1 wETH at the spot before", spot0, 6);
        emit log_named_decimal_uint("USDC paid for exactly 1 wETH", spent, 6);
        emit log_named_decimal_uint("USDC for 1 wETH at the spot after", spot1, 6);
        assertEq(IERC20(WETH).balanceOf(bob) - bobWeth0, out, "exactly amountOut to the recipient");
        assertEq(
            IERC20(USDC).balanceOf(address(this)),
            usdc0 + maxIn - spent,
            "the caller paid exactly amountIn"
        );
        assertLe(spent, maxIn, "within maxAmountIn");
        assertGt(spot1, spot0, "the purchase moved the price up");
        assertGe(spent, spot0, "no better than the spot before");
        assertLe(spent, _withFee(spot1) + 1, "no worse than the spot after plus the fee");
        _assertAdapterHoldsNothing();

        // wETH -> USDC, exactly 1 000 USDC.
        uint256 usdcOut = 1_000e6;
        uint256 wSpot0 = _wethFor(usdcOut);
        uint256 maxWeth = wSpot0.mulDiv(10_100, 10_000) + 1;
        deal(WETH, address(this), maxWeth);
        IERC20(WETH).approve(address(adapter), maxWeth);
        uint256 bobUsdc0 = IERC20(USDC).balanceOf(bob);
        uint256 wethSpent =
            adapter.swapExactOut(WETH, USDC, FEE_ARG, usdcOut, maxWeth, bob, block.timestamp);
        uint256 wSpot1 = _wethFor(usdcOut);
        assertEq(
            IERC20(USDC).balanceOf(bob) - bobUsdc0, usdcOut, "exactly amountOut to the recipient"
        );
        assertEq(
            IERC20(WETH).balanceOf(address(this)),
            maxWeth - wethSpent,
            "the caller paid exactly amountIn"
        );
        assertGt(wSpot1, wSpot0, "the sale moved the wETH price down");
        assertGe(wethSpent, wSpot0, "no better than the spot before");
        assertLe(wethSpent, _withFee(wSpot1) + 1, "no worse than the spot after plus the fee");
        _assertAdapterHoldsNothing();
    }

    /// @notice A `maxAmountIn` under the cost (check 9's per-swap limit, set below the spot value) reverts the whole
    ///         swap: nothing is pulled, nothing reaches the recipient, the pool does not move.
    function test_aerodromeExactOut_aLimitUnderTheCostRevertsAndMovesNothing()
        public
        fixtureCovered
    {
        uint256 out = 1e18;
        uint256 maxIn = _usdcFor(out).mulDiv(9_990, 10_000); // 10 bps under the spot value
        uint256 usdc0 = IERC20(USDC).balanceOf(address(this)); // real dust at the pin (see the first test)
        _fundUsdc(address(this), maxIn);
        IERC20(USDC).approve(address(adapter), maxIn);
        (uint160 sqrt0,,,,,) = IAeroCLPoolRead(AERO_WETH_USDC).slot0();
        (bool ok, bytes memory ret) = address(adapter)
            .call(
                abi.encodeCall(
                    adapter.swapExactOut, (USDC, WETH, FEE_ARG, out, maxIn, bob, block.timestamp)
                )
            );
        assertFalse(ok, "a limit under the cost reverts");
        emit log_named_bytes("revert data", ret);
        (uint160 sqrt1,,,,,) = IAeroCLPoolRead(AERO_WETH_USDC).slot0();
        assertEq(sqrt1, sqrt0, "the pool did not move");
        assertEq(IERC20(USDC).balanceOf(address(this)), usdc0 + maxIn, "nothing pulled");
        assertEq(IERC20(WETH).balanceOf(bob), 0, "nothing delivered");
        _assertAdapterHoldsNothing();
    }

    /// @notice What the adapter refuses before it touches the router: a tick spacing the factory has no pool for, a
    ///         zero tick spacing, a zero token or recipient; a zero amount out pulls nothing; an expired deadline is
    ///         refused by the router and moves nothing.
    function test_aerodromeExactOut_refusesWhatItCannotRoute() public fixtureCovered {
        uint256 usdc0 = IERC20(USDC).balanceOf(address(this)); // real dust at the pin (see the first test)
        _fundUsdc(address(this), 10_000e6);
        IERC20(USDC).approve(address(adapter), type(uint256).max);
        assertEq(
            IAeroCLFactoryRead(AERO_FACTORY).getPool(USDC, WETH, 7),
            address(0),
            "no pool of tick spacing 7"
        );
        vm.expectRevert(
            abi.encodeWithSelector(AerodromeSwapAdapter.PoolNotFound.selector, USDC, WETH, int24(7))
        );
        adapter.swapExactOut(USDC, WETH, 7, 1e15, 10_000e6, bob, block.timestamp);
        vm.expectRevert(AerodromeSwapAdapter.InvalidTickSpacing.selector);
        adapter.swapExactOut(USDC, WETH, 0, 1e15, 10_000e6, bob, block.timestamp);
        vm.expectRevert(AerodromeSwapAdapter.ZeroAddress.selector);
        adapter.swapExactOut(address(0), WETH, FEE_ARG, 1e15, 10_000e6, bob, block.timestamp);
        vm.expectRevert(AerodromeSwapAdapter.ZeroAddress.selector);
        adapter.swapExactOut(USDC, WETH, FEE_ARG, 1e15, 10_000e6, address(0), block.timestamp);
        assertEq(
            adapter.swapExactOut(USDC, WETH, FEE_ARG, 0, 10_000e6, bob, block.timestamp),
            0,
            "zero out"
        );
        assertEq(
            IERC20(USDC).balanceOf(address(this)),
            usdc0 + 10_000e6,
            "a zero amount out pulls nothing"
        );
        (bool ok,) = address(adapter)
            .call(
                abi.encodeCall(
                    adapter.swapExactOut,
                    (USDC, WETH, FEE_ARG, 1e15, 10_000e6, bob, block.timestamp - 1)
                )
            );
        assertFalse(ok, "an expired deadline is refused");
        assertEq(IERC20(USDC).balanceOf(address(this)), usdc0 + 10_000e6, "nothing pulled");
        _assertAdapterHoldsNothing();
    }

    /// @notice The inherited production `twapPrice` reads the Slipstream pool's mean tick (the same TickMath path the
    ///         fund's TWAP uses), lands near the pool's spot, and refuses a pool the Aerodrome factory did not make.
    function test_aerodromeExactOut_inheritedTwapPriceReadsThePool() public fixtureCovered {
        uint256 twap = adapter.twapPrice(AERO_WETH_USDC, WETH, USDC, 1e18, TWAP_WINDOW);
        int24 meanTick = TwapTickMath.meanTick(AERO_WETH_USDC, TWAP_WINDOW);
        assertEq(
            twap, TwapTickMath.priceFromTick(meanTick, WETH, USDC, 1e18), "the pool's mean tick"
        );
        uint256 spot = _usdcFor(1e18);
        emit log_named_decimal_uint("Aerodrome wETH / USDC 30-minute TWAP, USDC per wETH", twap, 6);
        emit log_named_decimal_uint("Aerodrome wETH / USDC spot, USDC per wETH", spot, 6);
        assertApproxEqRel(twap, spot, 0.02e18, "the TWAP is near the spot in a quiet pool");
        int24 uniSpacing = IAeroCLPoolRead(UNI_WETH_POOL).tickSpacing();
        address canonical = IAeroCLFactoryRead(AERO_FACTORY).getPool(WETH, USDC, uniSpacing);
        vm.expectRevert(
            abi.encodeWithSelector(
                AerodromeSwapAdapter.PoolFactoryMismatch.selector, UNI_WETH_POOL, canonical
            )
        );
        adapter.twapPrice(UNI_WETH_POOL, WETH, USDC, 1e18, TWAP_WINDOW);
    }

    /// @notice Step 3f (E43, §4.5 rule 6): `isFixedFeePool` distinguishes immutable Uniswap V3 pools from
    ///         mutable-fee Aerodrome Slipstream pools, and `poolFeeBps` reports fee in bps rounded up.
    function test_e43_feeClassification_uniFixedAndAeroMutable() public fixtureCovered {
        UniswapV3ExactOutSwapAdapter uni =
            new UniswapV3ExactOutSwapAdapter(0x2626664c2603336E57B271c5C0b26F421741e481);

        assertFalse(adapter.isFixedFeePool(AERO_WETH_USDC), "Slipstream fees are mutable");
        uint24 aeroPips = IAeroCLPoolRead(AERO_WETH_USDC).fee();
        assertEq(
            adapter.poolFeeBps(AERO_WETH_USDC),
            uint24((uint256(aeroPips) + 99) / 100),
            "Slipstream fee rounded up to bps"
        );
        vm.expectRevert(AerodromeSwapAdapter.ZeroAddress.selector);
        adapter.poolFeeBps(address(0));
        vm.expectRevert(
            abi.encodeWithSelector(AerodromeExactOutSwapAdapter.InvalidPoolFee.selector, bob)
        );
        adapter.poolFeeBps(bob);

        assertTrue(uni.isFixedFeePool(UNI_WETH_POOL), "Uniswap V3 pool has fixed fee + 7-word slot0");
        assertFalse(uni.isFixedFeePool(AERO_WETH_USDC), "Uni adapter rejects 6-word Slipstream pool");
        assertFalse(uni.isFixedFeePool(bob), "Uni adapter rejects EOA");
        assertFalse(uni.isFixedFeePool(address(0)), "Uni adapter rejects zero address");
        uint24 uniPips = IAeroCLPoolRead(UNI_WETH_POOL).fee();
        assertEq(
            uni.poolFeeBps(UNI_WETH_POOL),
            uint24((uint256(uniPips) + 99) / 100),
            "Uni fee rounded up to bps"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Step 3f (RB-34, A34): Self-contained short-paying lending & swap adapter rejection under fixtureCovered
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    struct ShortPaySandbox {
        LocalMintableErc20 mUsdc;
        LocalMintableErc20 mWeth;
        LocalAavePool pool;
        LocalUniV3Pool v3Pool;
        LocalSwapRouter router;
        MockAggregator usdcFeed;
        MockAggregator ethFeed;
        MockAggregator seqFeed;
        int256 ethPrice8;
        uint256 seqStartedAt;
        IRobotMoneyFundFull fund;
        FlowQueue queue;
        MechAaveAdapter mechAave;
        MechSwapAdapter mechSwap;
    }

    function _refreshSandboxFeeds(ShortPaySandbox memory sb) private {
        sb.usdcFeed.setRound(8, 1e8, block.timestamp, block.timestamp);
        sb.ethFeed.setRound(8, sb.ethPrice8, block.timestamp, block.timestamp);
        sb.seqFeed.setRound(0, 0, sb.seqStartedAt, block.timestamp);
    }

    function _deployShortPaySandbox()
        private
        returns (ShortPaySandbox memory sb)
    {
        sb.mUsdc = new LocalMintableErc20("Mock USDC", "mUSDC", 6);
        sb.mWeth = new LocalMintableErc20("Mock WETH", "mWETH", 18);
        sb.pool = new LocalAavePool(sb.mUsdc);
        sb.v3Pool = new LocalUniV3Pool(address(sb.mWeth), address(sb.mUsdc));
        uint256 px6 = TwapTickMath.priceFromTick(
            sb.v3Pool.fixedTick(), address(sb.mWeth), address(sb.mUsdc), 1e18
        );
        sb.router = new LocalSwapRouter(address(sb.mWeth), address(sb.mUsdc), px6);
        sb.mUsdc.mint(address(sb.router), 10_000_000e6);
        sb.mWeth.mint(address(sb.router), 10_000e18);

        sb.usdcFeed = new MockAggregator();
        sb.ethFeed = new MockAggregator();
        sb.seqFeed = new MockAggregator();
        sb.ethPrice8 = int256(px6 * 100);
        sb.seqStartedAt = block.timestamp - 1 days;
        _refreshSandboxFeeds(sb);

        address fundImpl = address(new RobotMoneyFund());
        sb.fund = IRobotMoneyFundFull(
            address(
                new ERC1967Proxy(
                    fundImpl,
                    abi.encodeCall(
                        RobotMoneyFund.initialize,
                        (
                            FundInitParams({
                                usdc: address(sb.mUsdc),
                                name: "Mock Fund",
                                symbol: "mFUND",
                                tvlCap: 10_000_000e6,
                                perDepositCap: 1_000_000e6,
                                exitFeeBps: 10,
                                feeRecipient: makeAddr("sbFee"),
                                maxSlippageBps: 200,
                                navDeviationGuardBps: 200,
                                admin: address(this),
                                emergency: address(this)
                            }),
                            address(this),
                            GovernedUUPS.UpgradeMode.Upgradeable
                        )
                    )
                )
            )
        );

        sb.mechAave = new MechAaveAdapter(
            address(sb.pool), address(sb.mUsdc), address(sb.pool.aToken()), address(sb.fund)
        );
        sb.mechSwap = new MechSwapAdapter(address(sb.router));
        sb.fund.setAdapterCodeHashAllowed(address(sb.mechAave).codehash, true);
        sb.fund.setAdapterCodeHashAllowed(address(sb.mechSwap).codehash, true);
        sb.fund.addAsset(
            AssetConfig({
                kind: AssetKind.Lending,
                active: true,
                capBps: 6_000,
                adapter: address(sb.mechAave),
                token: address(0),
                pool: address(0),
                poolFee: 0,
                twapWindow: 0,
                venue: Venue.V3,
                feed: address(0),
                maxFeedAge: 0
            })
        );
        sb.fund.addAsset(
            AssetConfig({
                kind: AssetKind.Basket,
                active: true,
                capBps: 0,
                adapter: address(sb.mechSwap),
                token: address(sb.mWeth),
                pool: address(sb.v3Pool),
                poolFee: 500,
                twapWindow: 1_800,
                venue: Venue.V3,
                feed: address(sb.ethFeed),
                maxFeedAge: 1_500
            })
        );
        RobotMoneyFund(address(sb.fund)).bindRebalanceRoles(address(this), address(this));

        address qImpl = address(new FlowQueue());
        sb.queue = FlowQueue(
            address(
                new ERC1967Proxy(
                    qImpl,
                    abi.encodeCall(
                        FlowQueue.initialize,
                        (
                            FlowQueueInit({
                                fund: address(sb.fund),
                                usdc: address(sb.mUsdc),
                                admin: address(this),
                                emergency: address(this),
                                keeper: address(this),
                                usdcFeed: address(sb.usdcFeed),
                                usdcFeedMaxAge: 86_700,
                                sequencerFeed: address(sb.seqFeed),
                                params: FlowParams({
                                    epochLength: 6 hours,
                                    settleWindow: 1 hours,
                                    minHold: 1 hours,
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
                                    maxLendRateGrowthBps: 10,
                                    cancelBuffer: DEFAULT_CANCEL_BUFFER,
                                    maxPause: DEFAULT_MAX_PAUSE
                                })
                            }),
                            address(this),
                            GovernedUUPS.UpgradeMode.Upgradeable
                        )
                    )
                )
            )
        );
        sb.fund.bindFlowRole(address(sb.queue));

        sb.mUsdc.mint(address(this), 100_000e6);
        sb.mUsdc.approve(address(sb.fund), 100_000e6);
        sb.fund.seed(100_000e6);

        address[] memory ids = new address[](2);
        ids[0] = address(sb.mechAave);
        ids[1] = address(sb.mWeth);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 5_000;
        bps[1] = 5_000;
        sb.fund.setTargetAndOpenPlan(ids, bps, PlanParams(1 days, 500), bytes32(0));
        vm.warp(block.timestamp + 1 days + 1);
        _refreshSandboxFeeds(sb);

        for (uint256 i; i < 2; ++i) {
            (uint256 nav,,) = sb.fund.portfolioValues();
            uint256 notional = nav.mulDiv(4_500, BPS);
            uint256 minOut = i == 1 ? sb.fund.assetTokenValue(1, notional).mulDiv(98, 100) : 0;
            sb.fund.executeStep(StepOrder(IDLE_INDEX, i, notional, 0, minOut, notional.mulDiv(100, BPS)));
        }
    }

    function _sbBuyLimits(ShortPaySandbox memory sb, uint256 sharesOut)
        private
        view
        returns (uint256[] memory lims, uint256 maxUsdc)
    {
        (uint256 idle0, uint256[] memory held0) = sb.fund.heldBalances();
        uint256 sup0 = sb.fund.totalSupply();
        lims = new uint256[](2);
        uint256 wantWeth = held0[1].mulDiv(sharesOut, sup0, Math.Rounding.Ceil);
        lims[1] = sb.fund.assetUsdcValue(1, wantWeth).mulDiv(BPS + 100, BPS) + 1;
        maxUsdc = idle0.mulDiv(sharesOut, sup0, Math.Rounding.Ceil)
            + held0[0].mulDiv(sharesOut, sup0, Math.Rounding.Ceil) + LENDING_ROUNDING_UNITS + lims[1];
    }

    function _sbMintAsQueue(
        ShortPaySandbox memory sb,
        uint256 sharesOut,
        uint256 maxU,
        uint256[] memory lims
    ) private returns (uint256 spent) {
        sb.mUsdc.mint(address(sb.queue), maxU);
        vm.startPrank(address(sb.queue));
        sb.mUsdc.approve(address(sb.fund), maxU);
        spent = sb.fund.mintInKind(sharesOut, maxU, lims);
        vm.stopPrank();
    }

    /// @notice Step 3f (RB-34, RB-13): `RobotMoneyFund.mintInKind` rejects an under-delivering `MechSwapAdapter`
    ///         via Check 10 (`ProportionViolated`) even while reporting honest spent USDC, under `fixtureCovered`.
    function test_step3f_rb34_mechSwapUnderDeliverRejectedByFund() public fixtureCovered {
        ShortPaySandbox memory sb = _deployShortPaySandbox();
        uint256 sharesOut = sb.fund.totalSupply() / 10;
        (uint256[] memory lims, uint256 maxU) = _sbBuyLimits(sb, sharesOut);

        sb.mechSwap.setMode(sb.mechSwap.UNDER_DELIVER(), 500);
        sb.mUsdc.mint(address(sb.queue), maxU);
        vm.startPrank(address(sb.queue));
        sb.mUsdc.approve(address(sb.fund), maxU);
        vm.expectPartialRevert(IRobotMoneyFund.ProportionViolated.selector);
        sb.fund.mintInKind(sharesOut, maxU, lims);
        vm.stopPrank();

        sb.mechSwap.setMode(sb.mechSwap.HONEST(), 0);
        uint256 spent = _sbMintAsQueue(sb, sharesOut, maxU, lims);
        assertGt(spent, 0, "honest swap adapter mint succeeds");
        assertEq(sb.fund.balanceOf(address(sb.queue)), sharesOut, "minted exact shares");
    }

    function lastBasketStepAt() external pure returns (uint64) {
        return 0;
    }

    function _sbMintSupplyMultiple(ShortPaySandbox memory sb, uint256 div)
        private
        returns (uint256 lot)
    {
        lot = sb.fund.totalSupply() / div;
        (uint256[] memory lims, uint256 maxU) = _sbBuyLimits(sb, lot);
        _sbMintAsQueue(sb, lot, maxU, lims);
    }

    function _checkShortPaySellAndClaim(ShortPaySandbox memory sb)
        private
        returns (uint256 claimUnits)
    {
        // Mint exact current supply so held lending units become even and half-redemptions divide cleanly.
        {
            uint256 lot1 = _sbMintSupplyMultiple(sb, 1);
            // Short-pay adapter pockets 20% while burning pool shares: fund settles real delta and never drains idle.
            sb.mechAave.setMode(sb.mechAave.SHORT_PAY(), 2_000);
            uint256 idleBefore = sb.mUsdc.balanceOf(address(sb.fund));
            uint256 supBefore = sb.fund.totalSupply();
            vm.prank(address(sb.queue));
            uint256 paid = sb.fund.sellForFlow(lot1, new uint256[](2));
            uint256 idleAfter = sb.mUsdc.balanceOf(address(sb.fund));
            assertGt(paid, 0, "short-paying sell settles actual received USDC");
            assertLe(
                idleBefore - idleAfter,
                idleBefore.mulDiv(lot1, supBefore) + 2,
                "RB-34: short-pay never drains stayers' idle USDC"
            );
        }

        // Partial pool payout leaves unwithdrawn shares in venue -> mints `positionClaimOf` units.
        sb.mechAave.setMode(sb.mechAave.HONEST(), 0);
        uint256 lot2 = _sbMintSupplyMultiple(sb, 1);
        sb.pool.setPartialWithdrawBps(5_000);
        vm.prank(address(sb.queue));
        sb.fund.sellForFlow(lot2, new uint256[](2));
        (claimUnits,) = sb.fund.positionClaimOf(0, address(sb.queue));
        assertGt(claimUnits, 100e6, "partial payout books shortfall into positionClaimOf");

        // Zero liquidity leaves `settleClaim` returning 0 without shrinking `positionClaimOf`.
        sb.mechAave.setAvailableLiquidity(0);
        assertEq(sb.fund.settleClaim(0, address(sb.queue)), 0, "zero liquidity pays 0");
        (uint256 unitsStill,) = sb.fund.positionClaimOf(0, address(sb.queue));
        assertEq(unitsStill, claimUnits, "zero-pay leaves claim units intact");
        sb.mechAave.clearAvailableLiquidity();

        // Mint final shares for the exclusion + shutdown in-kind leg.
        _sbMintSupplyMultiple(sb, 10);
    }

    function _checkShortPayExclusionAndDeferred(ShortPaySandbox memory sb) private {
        sb.fund.closePlan();

        // Pre-exclusion single-asset `emergencyUnwind(0)` under partial + short pay credits only real USDC delta to fund.
        sb.pool.setPartialWithdrawBps(5_000);
        sb.mechAave.setMode(sb.mechAave.SHORT_PAY(), 2_000);
        uint256 fundBal0 = sb.mUsdc.balanceOf(address(sb.fund));
        uint256 unwound = sb.fund.emergencyUnwind(0);
        assertGt(unwound, 0, "partial short-paying emergencyUnwind recovered real USDC");
        assertEq(
            sb.mUsdc.balanceOf(address(sb.fund)) - fundBal0,
            unwound,
            "RB-34: returned recovery matches actual USDC delta"
        );

        // Disallow adapter codehash -> opens exclusion; initial `rec` is 0 until unwind/restore drains.
        address ledgerAddr = sb.fund.exclusionLedger();
        uint256 ledgerBal0 = sb.mUsdc.balanceOf(ledgerAddr);
        sb.fund.setAdapterCodeHashAllowed(address(sb.mechAave).codehash, false);
        uint256 exclId = sb.fund.openExclusionOf(0);
        assertGt(exclId, 0, "exclusion opened");
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.AssetStillHeld.selector, 0));
        sb.fund.deactivateAsset(0);

        // `emergencyUnwind(0)` while excluded credits ONLY actual recovered USDC into ExclusionLedger.
        sb.fund.emergencyUnwind(0);
        uint256 ledgerBal1 = sb.mUsdc.balanceOf(ledgerAddr);
        (,,,,,,, uint256 rec1,) = FundExclusionLedger(ledgerAddr).exclusions(exclId);
        assertGt(rec1, 0, "excluded unwind recovered partial USDC");
        assertEq(rec1, ledgerBal1 - ledgerBal0, "RB-34: ledger credits only actual USDC delta");
        assertGt(sb.mechAave.totalAssets(), 0, "venue still holds remaining trapped position");
        vm.expectRevert(abi.encodeWithSelector(IRobotMoneyFund.AssetStillHeld.selector, 0));
        sb.fund.deactivateAsset(0);
        assertEq(sb.fund.openExclusionOf(0), exclId, "exclusion cannot close while collateral trapped");

        // Shutdown in-kind + `claimPosition` under SHORT_PAY rejects with `DeferredShortfall`.
        sb.pool.setPartialWithdrawBps(0);
        sb.fund.setInKindAllowance(0, 0, DEFAULT_IN_KIND_PERIOD);
        uint256 remShares = sb.fund.balanceOf(address(sb.queue));
        vm.prank(address(sb.queue));
        sb.fund.transfer(address(this), remShares);
        sb.fund.shutdown();
        sb.fund.redeemInKind(remShares / 2, address(this), address(this));
        vm.prank(address(sb.queue));
        vm.expectPartialRevert(IRobotMoneyFund.DeferredShortfall.selector);
        sb.fund.claimPosition(0, address(this));
    }

    /// @notice Step 3f (RB-34, A34): fund-level custody checks under `MechAaveAdapter` short-pay and partial pool
    ///         payout: `sellForFlow` never drains stayers' idle, `claimPosition` reverts `DeferredShortfall`,
    ///         zero-liquidity `settleClaim` leaves claim units intact, and exclusion recovery only books actual
    ///         USDC delta while refusing closure (`AssetStillHeld`) until the venue releases trapped collateral.
    function test_step3f_rb34_a34_mechAaveShortPayClaimAndExclusionRecovery()
        public
        fixtureCovered
    {
        ShortPaySandbox memory sb = _deployShortPaySandbox();
        _checkShortPaySellAndClaim(sb);
        _checkShortPayExclusionAndDeferred(sb);
    }

    /// @notice Step 3f (A34, E36): `FlowQueue.settle()` blocks deposits for the round (`DepositStoppedForRound(..., 3)`)
    ///         when a lending venue reports insufficient `availableLiquidity()`, while redemptions still settle.
    function test_step3f_a34_queueVenueLiquidityStopsDepositsWithoutBlockingRedemptions()
        public
        fixtureCovered
    {
        ShortPaySandbox memory sb = _deployShortPaySandbox();
        address redUser = makeAddr("redUser");
        address depUser = makeAddr("depUser");

        // Initial deposit to give redUser fund shares while liquidity is healthy.
        sb.mUsdc.mint(redUser, 30_000e6);
        vm.startPrank(redUser);
        sb.mUsdc.approve(address(sb.queue), 30_000e6);
        uint256 seedDepId = sb.queue.requestDeposit(30_000e6, redUser);
        vm.stopPrank();
        Request memory seedReq = sb.queue.getRequest(seedDepId);
        vm.warp(sb.queue.settleableAt(seedReq.epoch) + 1);
        _refreshSandboxFeeds(sb);
        sb.queue.settle(256, type(uint256).max);
        vm.warp(block.timestamp + 1 hours + 1);
        _refreshSandboxFeeds(sb);
        sb.queue.mint(sb.queue.maxMint(redUser), redUser);
        uint256 redShares = sb.fund.balanceOf(redUser);
        assertGt(redShares, 0, "redUser holds shares");

        // Queue a redemption + deposit while MechAaveAdapter reports 0 liquidity.
        vm.startPrank(redUser);
        sb.fund.approve(address(sb.queue), redShares / 2);
        uint256 redId = sb.queue.requestRedeem(redShares / 2, redUser);
        vm.stopPrank();
        sb.mUsdc.mint(depUser, 10_000e6);
        vm.startPrank(depUser);
        sb.mUsdc.approve(address(sb.queue), 10_000e6);
        sb.queue.requestDeposit(10_000e6, depUser);
        vm.stopPrank();

        sb.mechAave.setAvailableLiquidity(0);
        Request memory rReq = sb.queue.getRequest(redId);
        vm.warp(sb.queue.settleableAt(rReq.epoch) + 1);
        _refreshSandboxFeeds(sb);

        vm.expectEmit(false, false, false, true, address(sb.queue));
        emit IFlowEvents.DepositStoppedForRound(0, 3);
        sb.queue.settle(256, type(uint256).max);

        assertTrue(sb.queue.getRequest(redId).closed, "E36/A34: redemption settled despite low liquidity");
        assertGt(sb.queue.maxRedeem(redUser), 0, "redUser has claimable USDC");
        assertEq(sb.fund.balanceOf(depUser), 0, "A34: deposit blocked by liquidity stop");
        assertEq(sb.queue.maxMint(depUser), 0, "A34: no deposit shares minted");
    }
}

contract LocalMintableErc20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory name_, string memory symbol_, uint8 dec_) ERC20(name_, symbol_) {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract LocalAToken is LocalMintableErc20 {
    address public immutable pool;

    constructor() LocalMintableErc20("Mock aUSDC", "maUSDC", 6) {
        pool = msg.sender;
    }

    function releaseUnderlying(IERC20 usdc, address to, uint256 amount) external {
        require(msg.sender == pool, "only pool");
        usdc.transfer(to, amount);
    }
}

contract LocalAavePool {
    IERC20 public immutable usdc;
    LocalAToken public immutable aToken;
    uint16 public partialWithdrawBps;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
        aToken = new LocalAToken();
    }

    function setPartialWithdrawBps(uint16 bps) external {
        partialWithdrawBps = bps;
    }

    function supply(address, uint256 amount, address onBehalfOf, uint16) external {
        usdc.transferFrom(msg.sender, address(aToken), amount);
        aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address, uint256 amount, address to) external returns (uint256) {
        uint256 bal = aToken.balanceOf(msg.sender);
        uint256 out = amount > bal ? bal : amount;
        if (partialWithdrawBps != 0) out = out * partialWithdrawBps / 10_000;
        aToken.burn(msg.sender, out);
        aToken.releaseUnderlying(usdc, to, out);
        return out;
    }

    function getReserveNormalizedIncome(address) external pure returns (uint256) {
        return 1e27;
    }

    function getConfiguration(address) external pure returns (uint256) {
        return uint256(1) << 56;
    }
}

contract LocalUniV3Pool {
    address public immutable token0;
    address public immutable token1;
    int24 public immutable fixedTick;
    uint160 public immutable initialSqrtPriceX96;

    constructor(address weth, address usdc) {
        (token0, token1) = weth < usdc ? (weth, usdc) : (usdc, weth);
        fixedTick = weth < usdc ? int24(-200311) : int24(200311);
        initialSqrtPriceX96 = TickMath.getSqrtRatioAtTick(fixedTick);
    }

    function fee() external pure returns (uint24) {
        return 500;
    }

    function tickSpacing() external pure returns (int24) {
        return 10;
    }

    function liquidity() external pure returns (uint128) {
        return 1e22;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (initialSqrtPriceX96, fixedTick, 0, 1024, 1024, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        uint256 len = secondsAgos.length;
        tickCumulatives = new int56[](len);
        secondsPerLiquidityCumulativeX128s = new uint160[](len);
        for (uint256 j; j < len; ++j) {
            uint256 ts = block.timestamp - secondsAgos[j];
            tickCumulatives[j] = int56(int256(ts)) * int56(fixedTick);
            secondsPerLiquidityCumulativeX128s[j] = uint160((ts << 128) / uint256(1e22));
        }
    }
}

contract LocalSwapRouter {
    address public immutable weth;
    address public immutable usdc;
    uint256 public immutable price6;

    constructor(address weth_, address usdc_, uint256 price6_) {
        weth = weth_;
        usdc = usdc_;
        price6 = price6_;
    }

    function exactOutputSingle(ISwapRouterExactOut.ExactOutputSingleParams calldata p)
        external
        returns (uint256 amountIn)
    {
        amountIn = p.tokenOut == weth
            ? Math.mulDiv(p.amountOut, price6, 1e18, Math.Rounding.Ceil) * 10_005 / 10_000
            : Math.mulDiv(p.amountOut, 1e18, price6, Math.Rounding.Ceil) * 10_005 / 10_000;
        require(amountIn <= p.amountInMaximum, "maxIn");
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(p.tokenOut).transfer(p.recipient, p.amountOut);
    }

    function exactInputSingle(ISwapRouter.ExactInputSingleParams calldata p)
        external
        returns (uint256 amountOut)
    {
        amountOut = p.tokenIn == weth
            ? Math.mulDiv(p.amountIn, price6, 1e18) * 9_995 / 10_000
            : Math.mulDiv(p.amountIn, 1e18, price6) * 9_995 / 10_000;
        require(amountOut >= p.amountOutMinimum, "minOut");
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        IERC20(p.tokenOut).transfer(p.recipient, amountOut);
    }
}
