// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 check 9 (the per-swap limit of the pro-rata
//            purchase), §6 (adapter row: an exact-output swap); docs/technical/one-vault-timed-flows-eng-plan.md E3,
//            E15, §3.2 (adapter copies); one-vault step 3 finish plan §3.3 item 5 (`hardening`, 2026-11-12)
// Experiment prototype only (contracts/test/prototype/). Not a production test.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BaseFixture} from "./BaseFixture.sol";
import {AerodromeExactOutSwapAdapter} from "./src/adapters/AerodromeExactOutSwapAdapter.sol";
import {AerodromeSwapAdapter} from "../../adapters/AerodromeSwapAdapter.sol";
import {TwapTickMath} from "../../lib/TwapTickMath.sol";

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
}
