// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: V4 venue)
//            docs/technical/smart-contract-invariants.md (ADP-2, ADP-5, ORA-3)
// Covers core issue 1676.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev A token that calls back into the adapter while the adapter pulls it (a reentrancy probe).
contract ReentrantToken is ERC20 {
    UniswapV4SwapAdapter public target;
    bool public armed;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(UniswapV4SwapAdapter t) external {
        target = t;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && to == address(target)) {
            armed = false;
            target.swap(address(this), address(1), 1, 1, 0, address(this), block.timestamp);
        }
    }
}

contract UniswapV4SwapAdapterTest is Test {
    MockV4PoolManager internal pm;
    UniswapV4PriceRecorder internal rec;
    UniswapV4SwapAdapter internal adapter;
    TestERC20 internal usdc;
    TestERC20 internal rm;
    address internal c0;
    address internal c1;
    bytes32 internal poolId;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint24 internal constant FEE = 29100;
    int24 internal constant SPACING = 582;
    int24 internal constant TICK = -100; // 1 RM is a little under 1 USDC raw

    function setUp() public {
        vm.warp(1_700_000_000);
        pm = new MockV4PoolManager();
        usdc = new TestERC20();
        rm = new TestERC20();
        (c0, c1) = address(rm) < address(usdc)
            ? (address(rm), address(usdc))
            : (address(usdc), address(rm));
        poolId = pm.initializePool(_key(), TICK, 1e18);
        rec = new UniswapV4PriceRecorder(address(pm), c0, c1, FEE, SPACING, address(0));
        adapter = new UniswapV4SwapAdapter(address(pm), _key(), address(rec), address(usdc));
        usdc.mint(address(pm), 1e15);
        rm.mint(address(pm), 1e15);
        usdc.mint(alice, 1e12);
        rm.mint(alice, 1e12);
    }

    function _key() internal view returns (IPoolManagerV4.PoolKey memory) {
        return IPoolManagerV4.PoolKey(c0, c1, FEE, SPACING, address(0));
    }

    function _swap(address from, address tin, address tout, uint256 amt, uint256 minOut, address to)
        internal
        returns (uint256)
    {
        vm.startPrank(from);
        IERC20(tin).approve(address(adapter), amt);
        uint256 out = adapter.swap(tin, tout, FEE, amt, minOut, to, block.timestamp);
        vm.stopPrank();
        return out;
    }

    // ─── Constructor binds the explicit PoolKey ──────────────────────

    function test_constructor_bindsTheKeyAndRecorder() public view {
        assertEq(address(adapter.POOL_MANAGER()), address(pm));
        assertEq(address(adapter.RECORDER()), address(rec));
        assertEq(adapter.CURRENCY0(), c0);
        assertEq(adapter.CURRENCY1(), c1);
        assertEq(uint256(adapter.POOL_FEE()), uint256(FEE));
        assertEq(int256(adapter.TICK_SPACING()), int256(SPACING));
        assertEq(adapter.POOL_ID(), poolId);
    }

    function test_constructor_refusesAKeyThatDoesNotPairTheQuoteTokenWithAnother() public {
        // a key whose sides are two unrelated tokens, neither of them USDC
        address a = address(new TestERC20());
        address b = address(new TestERC20());
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        IPoolManagerV4.PoolKey memory k = IPoolManagerV4.PoolKey(lo, hi, FEE, SPACING, address(0));
        pm.initializePool(k, TICK, 1e18);
        UniswapV4PriceRecorder r2 =
            new UniswapV4PriceRecorder(address(pm), lo, hi, FEE, SPACING, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4SwapAdapter.PoolKeyDoesNotPairQuote.selector, address(usdc)
            )
        );
        new UniswapV4SwapAdapter(address(pm), k, address(r2), address(usdc));
    }

    function test_constructor_refusesANonZeroHooksAddress() public {
        IPoolManagerV4.PoolKey memory k = _key();
        k.hooks = address(0xBEEF);
        vm.expectRevert(UniswapV4SwapAdapter.InvalidPoolKey.selector);
        new UniswapV4SwapAdapter(address(pm), k, address(rec), address(usdc));
    }

    function test_constructor_refusesAnUnsortedKey() public {
        IPoolManagerV4.PoolKey memory k = _key();
        (k.currency0, k.currency1) = (k.currency1, k.currency0);
        vm.expectRevert(UniswapV4SwapAdapter.InvalidPoolKey.selector);
        new UniswapV4SwapAdapter(address(pm), k, address(rec), address(usdc));
    }

    /// @notice PoolKey spoofing: a key whose hash differs from the recorder's pool id is refused, field by field.
    function test_constructor_refusesAKeyWhoseHashIsNotTheRecordersPoolId() public {
        IPoolManagerV4.PoolKey memory k = _key();
        k.fee = FEE + 1;
        vm.expectRevert(UniswapV4SwapAdapter.InvalidPoolKey.selector);
        new UniswapV4SwapAdapter(address(pm), k, address(rec), address(usdc));
        k = _key();
        k.tickSpacing = SPACING + 1;
        vm.expectRevert(UniswapV4SwapAdapter.InvalidPoolKey.selector);
        new UniswapV4SwapAdapter(address(pm), k, address(rec), address(usdc));
    }

    function test_constructor_refusesARecorderOnAnotherPoolManager() public {
        MockV4PoolManager pm2 = new MockV4PoolManager();
        pm2.initializePool(_key(), TICK, 1e18);
        UniswapV4PriceRecorder other =
            new UniswapV4PriceRecorder(address(pm2), c0, c1, FEE, SPACING, address(0));
        vm.expectRevert(UniswapV4SwapAdapter.InvalidPoolKey.selector);
        new UniswapV4SwapAdapter(address(pm), _key(), address(other), address(usdc));
    }

    function test_constructor_refusesZeroAddresses() public {
        vm.expectRevert(UniswapV4SwapAdapter.ZeroAddress.selector);
        new UniswapV4SwapAdapter(address(0), _key(), address(rec), address(usdc));
        vm.expectRevert(UniswapV4SwapAdapter.ZeroAddress.selector);
        new UniswapV4SwapAdapter(address(pm), _key(), address(0), address(usdc));
        vm.expectRevert(UniswapV4SwapAdapter.ZeroAddress.selector);
        new UniswapV4SwapAdapter(address(pm), _key(), address(rec), address(0));
    }

    // ─── Swaps through the PoolManager ───────────────────────────────

    function test_swap_usdcToRm_paysTheRecipientAndLeavesNothingBehind() public {
        uint256 amt = 1_000e6;
        uint256 pmUsdc = usdc.balanceOf(address(pm));
        uint256 pmRm = rm.balanceOf(address(pm));
        uint256 out = _swap(alice, address(usdc), address(rm), amt, 1, bob);
        assertGt(out, 0);
        assertEq(rm.balanceOf(bob), out, "recipient paid");
        assertEq(usdc.balanceOf(address(pm)), pmUsdc + amt, "pool manager received the input");
        assertEq(rm.balanceOf(address(pm)), pmRm - out);
        assertEq(usdc.balanceOf(address(adapter)), 0, "no input left in the adapter");
        assertEq(rm.balanceOf(address(adapter)), 0, "no output left in the adapter");
        assertEq(
            usdc.allowance(address(adapter), address(pm)),
            0,
            "no standing approval to the pool manager"
        );
        assertEq(pm.nonzeroDeltas(), 0);
    }

    function test_swap_rmToUsdc_otherDirection() public {
        uint256 amt = 5e9;
        uint256 out = _swap(alice, address(rm), address(usdc), amt, 1, alice);
        assertGt(out, 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(rm.balanceOf(address(adapter)), 0);
    }

    function test_swap_pullsOnlyFromTheCallerAndOnlyTheExactAmount() public {
        uint256 before_ = usdc.balanceOf(alice);
        _swap(alice, address(usdc), address(rm), 123e6, 1, alice);
        assertEq(before_ - usdc.balanceOf(alice), 123e6);
        // bob has no allowance given to the adapter: he cannot spend alice's tokens
        vm.prank(bob);
        vm.expectRevert();
        adapter.swap(address(usdc), address(rm), FEE, 1e6, 0, bob, block.timestamp);
    }

    function test_swap_aStrangerCanOnlySpendTheirOwnTokens() public {
        // bob approves and swaps from his own balance: allowed
        usdc.mint(bob, 10e6);
        uint256 out = _swap(bob, address(usdc), address(rm), 10e6, 1, bob);
        assertGt(out, 0);
    }

    function test_swap_pokesTheRecorderBeforeTheTrade() public {
        rec.grow(10);
        vm.warp(block.timestamp + 10);
        (,, uint16 i0,,) = rec.latest();
        _swap(alice, address(usdc), address(rm), 1e6, 1, alice);
        (int24 lastTick, uint32 at, uint16 i1,,) = rec.latest();
        assertEq(at, uint32(block.timestamp), "snapshot written in the swap");
        assertTrue(i1 != i0, "index advanced");
        // the recorded tick is the PRE-trade tick: the swap moved the pool after the poke
        assertEq(int256(lastTick), int256(TICK));
        assertTrue(pm.tickOf(poolId) != TICK, "the trade moved the pool after the poke");
    }

    function test_swap_aSecondSwapInTheSameBlockWritesNoSecondSnapshot() public {
        rec.grow(10);
        vm.warp(block.timestamp + 10);
        _swap(alice, address(usdc), address(rm), 1e6, 1, alice);
        (,, uint16 i1,,) = rec.latest();
        _swap(alice, address(usdc), address(rm), 1e6, 1, alice);
        (,, uint16 i2,,) = rec.latest();
        assertEq(i1, i2);
    }

    function test_swap_zeroAmountReturnsZeroAndMovesNothing() public {
        vm.prank(alice);
        uint256 out = adapter.swap(address(usdc), address(rm), FEE, 0, 0, alice, block.timestamp);
        assertEq(out, 0);
        assertEq(pm.swapCount(), 0);
    }

    // ─── Refusals ────────────────────────────────────────────────────

    function test_swap_refusesAnExpiredDeadline() public {
        vm.startPrank(alice);
        usdc.approve(address(adapter), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4SwapAdapter.DeadlineExpired.selector, block.timestamp - 1, block.timestamp
            )
        );
        adapter.swap(address(usdc), address(rm), FEE, 1e6, 0, alice, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_swap_acceptsADeadlineEqualToNow() public {
        _swap(alice, address(usdc), address(rm), 1e6, 0, alice);
    }

    function test_swap_refusesAnAmountInAboveUint128() public {
        uint256 big = uint256(type(uint128).max) + 1;
        usdc.mint(alice, big);
        vm.startPrank(alice);
        usdc.approve(address(adapter), big);
        vm.expectRevert(
            abi.encodeWithSelector(
                SafeCast.SafeCastOverflowedUintDowncast.selector, uint8(128), big
            )
        );
        adapter.swap(address(usdc), address(rm), FEE, big, 0, alice, block.timestamp);
        vm.stopPrank();
        assertEq(pm.swapCount(), 0);
    }

    function test_swap_refusesAMinAmountOutAboveUint128() public {
        vm.startPrank(alice);
        usdc.approve(address(adapter), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(
                SafeCast.SafeCastOverflowedUintDowncast.selector,
                uint8(128),
                uint256(type(uint128).max) + 1
            )
        );
        adapter.swap(
            address(usdc),
            address(rm),
            FEE,
            1e6,
            uint256(type(uint128).max) + 1,
            alice,
            block.timestamp
        );
        vm.stopPrank();
    }

    function test_swap_refusesATokenPairThatIsNotThePool() public {
        address other = address(new TestERC20());
        vm.startPrank(alice);
        vm.expectRevert(UniswapV4SwapAdapter.PoolTokenMismatch.selector);
        adapter.swap(address(usdc), other, FEE, 1e6, 0, alice, block.timestamp);
        vm.expectRevert(UniswapV4SwapAdapter.PoolTokenMismatch.selector);
        adapter.swap(address(usdc), address(usdc), FEE, 1e6, 0, alice, block.timestamp);
        vm.expectRevert(UniswapV4SwapAdapter.PoolTokenMismatch.selector);
        adapter.swap(other, address(rm), FEE, 1e6, 0, alice, block.timestamp);
        vm.stopPrank();
    }

    function test_swap_refusesAFeeThatIsNotThePoolFee() public {
        vm.startPrank(alice);
        usdc.approve(address(adapter), 1e6);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV4SwapAdapter.FeeMismatch.selector, uint24(500), FEE)
        );
        adapter.swap(address(usdc), address(rm), 500, 1e6, 0, alice, block.timestamp);
        vm.stopPrank();
    }

    function test_swap_refusesAZeroRecipientAndZeroTokens() public {
        vm.startPrank(alice);
        vm.expectRevert(UniswapV4SwapAdapter.ZeroAddress.selector);
        adapter.swap(address(usdc), address(rm), FEE, 1e6, 0, address(0), block.timestamp);
        vm.expectRevert(UniswapV4SwapAdapter.ZeroAddress.selector);
        adapter.swap(address(0), address(rm), FEE, 1e6, 0, alice, block.timestamp);
        vm.stopPrank();
    }

    /// @notice The slippage floor is enforced and a failed swap leaves no state behind.
    function test_swap_revertsBelowTheFloorAndRollsEverythingBack() public {
        uint256 amt = 1_000e6;
        uint256 quote = _swap(alice, address(usdc), address(rm), amt, 1, alice);
        vm.startPrank(alice);
        usdc.approve(address(adapter), amt);
        uint256 aliceBefore = usdc.balanceOf(alice);
        // the price moved against alice by impactTicks: demanding twice the earlier quote fails
        vm.expectPartialRevert(UniswapV4SwapAdapter.SlippageExceeded.selector);
        adapter.swap(address(usdc), address(rm), FEE, amt, quote * 2, alice, block.timestamp);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), aliceBefore);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function test_swap_floorIsInclusive() public {
        uint256 amt = 1_000e6;
        // quote with a probe: same tick, same math
        uint256 expected = _swap(alice, address(usdc), address(rm), amt, 0, alice);
        // reset the tick so the next swap prices identically, and demand exactly that amount
        pm.setTick(poolId, TICK);
        uint256 out = _swap(alice, address(usdc), address(rm), amt, expected, alice);
        assertEq(out, expected);
    }

    /// @notice A fill that does not consume the whole exact input (a price limit stopped it) is refused, not settled short.
    function test_swap_refusesAPartialFill() public {
        pm.setPartialFill(true);
        vm.startPrank(alice);
        usdc.approve(address(adapter), 1_000e6);
        vm.expectPartialRevert(UniswapV4SwapAdapter.SlippageExceeded.selector);
        adapter.swap(address(usdc), address(rm), FEE, 1_000e6, 0, alice, block.timestamp);
        vm.stopPrank();
    }

    // ─── Callback and reentrancy ─────────────────────────────────────

    function test_unlockCallback_rejectsAnyCallerButThePoolManager() public {
        vm.prank(alice);
        vm.expectRevert(UniswapV4SwapAdapter.NotPoolManager.selector);
        adapter.unlockCallback(
            abi.encode(true, address(rm), address(usdc), uint128(1), uint256(0), alice)
        );
    }

    function test_unlockCallback_rejectsThePoolManagerWhenNoSwapIsOpen() public {
        vm.prank(address(pm));
        vm.expectRevert(UniswapV4SwapAdapter.NotOpen.selector);
        adapter.unlockCallback(
            abi.encode(true, address(rm), address(usdc), uint128(1), uint256(0), alice)
        );
    }

    function test_swap_isNotReentrant() public {
        ReentrantToken bad = new ReentrantToken();
        address a = address(bad);
        (address lo, address hi) = a < address(usdc) ? (a, address(usdc)) : (address(usdc), a);
        IPoolManagerV4.PoolKey memory k = IPoolManagerV4.PoolKey(lo, hi, FEE, SPACING, address(0));
        pm.initializePool(k, TICK, 1e18);
        UniswapV4PriceRecorder r =
            new UniswapV4PriceRecorder(address(pm), lo, hi, FEE, SPACING, address(0));
        UniswapV4SwapAdapter ad =
            new UniswapV4SwapAdapter(address(pm), k, address(r), address(usdc));
        bad.mint(alice, 10e6);
        usdc.mint(address(pm), 1e12);
        bad.arm(ad);
        vm.startPrank(alice);
        bad.approve(address(ad), 10e6);
        vm.expectRevert(UniswapV4SwapAdapter.Reentrant.selector);
        ad.swap(a, address(usdc), FEE, 10e6, 0, alice, block.timestamp);
        vm.stopPrank();
    }

    // ─── twapPrice ───────────────────────────────────────────────────

    function _warm() internal {
        rec.grow(40);
        for (uint256 i = 0; i < 20; i++) {
            vm.warp(block.timestamp + 100);
            rec.record();
        }
    }

    function test_twapPrice_priceIsTheRecordersMeanTick() public {
        _warm();
        // tick -100 constant: the 1800 s mean tick is -100
        uint256 out = adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 1800);
        uint256 viaMath = adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 600);
        assertEq(out, viaMath, "constant tick: any window prices the same");
        assertGt(out, 0);
        uint256 back = adapter.twapPrice(address(rec), address(usdc), address(rm), out, 1800);
        assertApproxEqRel(back, 1e18, 1e12, "round trip within rounding");
    }

    function test_twapPrice_refusesAPoolThatIsNotTheRecorder() public {
        _warm();
        address fake =
            address(new UniswapV4PriceRecorder(address(pm), c0, c1, FEE, SPACING, address(0)));
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4SwapAdapter.PoolIsNotRecorder.selector, fake, address(rec)
            )
        );
        adapter.twapPrice(fake, address(rm), address(usdc), 1e18, 1800);
        vm.expectRevert(
            abi.encodeWithSelector(
                UniswapV4SwapAdapter.PoolIsNotRecorder.selector, address(pm), address(rec)
            )
        );
        adapter.twapPrice(address(pm), address(rm), address(usdc), 1e18, 1800);
    }

    function test_twapPrice_refusesWrongPairAndZeroWindowAndZeroAddress() public {
        _warm();
        vm.expectRevert(UniswapV4SwapAdapter.PoolTokenMismatch.selector);
        adapter.twapPrice(address(rec), address(rm), address(rm), 1e18, 1800);
        vm.expectRevert(UniswapV4SwapAdapter.ZeroWindow.selector);
        adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 0);
        vm.expectRevert(UniswapV4SwapAdapter.ZeroAddress.selector);
        adapter.twapPrice(address(0), address(rm), address(usdc), 1e18, 1800);
        assertEq(adapter.twapPrice(address(rec), address(rm), address(usdc), 0, 1800), 0);
    }

    function test_twapPrice_revertsWhileTheRecorderIsStaleAndWhenHistoryIsShort() public {
        _warm();
        // history is 2000 s: a 2100 s window reaches before the oldest snapshot
        vm.expectRevert(UniswapV4PriceRecorder.ObservationTooOld.selector);
        adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 2100);
        vm.warp(block.timestamp + 1801);
        vm.expectRevert();
        adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 1800);
        rec.record();
        adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 1800);
    }

    function test_twapPrice_ignoresLiveSpot() public {
        _warm();
        uint256 before_ = adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 1800);
        pm.setTick(poolId, TICK + 20_000);
        assertEq(adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 1800), before_);
    }
}
