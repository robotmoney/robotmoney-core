// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: V4 venue)
//            docs/adr/ADR-0007-basket-vault-drawdown-redemption-policy.md (core 1665: redeemInKind)
//            docs/technical/smart-contract-invariants.md (ADP-2, ORA-1, ORA-3, ORA-4)
// Covers core issue 1676: AgentTokenVault wired to a V4 pool through UniswapV4SwapAdapter and UniswapV4PriceRecorder.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

contract BasketVaultV4VenueTest is Test {
    MockV4PoolManager internal pm;
    UniswapV4PriceRecorder internal rec;
    UniswapV4SwapAdapter internal adapter;
    AgentTokenVault internal vault;
    TestERC20 internal usdc;
    TestERC20 internal rm;
    address internal c0;
    address internal c1;
    bytes32 internal poolId;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal attacker = makeAddr("attacker");

    uint24 internal constant FEE = 29100;
    int24 internal constant SPACING = 582;
    uint256 internal constant DEPOSIT = 100e6;

    function setUp() public {
        vm.warp(1_700_000_000);
        pm = new MockV4PoolManager();
        usdc = new TestERC20();
        rm = new TestERC20();
        (c0, c1) = address(rm) < address(usdc)
            ? (address(rm), address(usdc))
            : (address(usdc), address(rm));
        poolId = pm.initializePool(_key(), 0, 1e18);
        rec = new UniswapV4PriceRecorder(address(pm), c0, c1, FEE, SPACING, address(0));
        adapter = new UniswapV4SwapAdapter(address(pm), _key(), address(rec), address(usdc));
        usdc.mint(address(pm), 1e15);
        rm.mint(address(pm), 1e15);
        vault = new AgentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(makeAddr("router")),
            1_000_000e6,
            10_000e6,
            0,
            makeAddr("fees"),
            admin,
            admin
        );
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(attacker, 1_000_000e6);
        rm.mint(attacker, 1e15);
    }

    function _key() internal view returns (IPoolManagerV4.PoolKey memory) {
        return IPoolManagerV4.PoolKey(c0, c1, FEE, SPACING, address(0));
    }

    /// @dev Grow the ring to the 1800 s window floor and record for just over one window.
    function _warmRecorder() internal {
        rec.grow(901);
        for (uint256 i = 0; i < 32; i++) {
            vm.warp(block.timestamp + 60);
            rec.record();
        }
    }

    function _addRm() internal {
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        // the 2.91 percent pool fee leaves the vault default 300 bps no room: raise to the 500 bps ceiling
        vault.setMaxSlippageBps(500);
        vm.stopPrank();
    }

    function _readyVault() internal {
        _warmRecorder();
        _addRm();
    }

    function _deposit(uint256 amt) internal returns (uint256 shares) {
        vm.startPrank(alice);
        usdc.approve(address(vault), amt);
        shares = vault.deposit(amt, alice);
        vm.stopPrank();
    }

    // ─── addAsset gating ─────────────────────────────────────────────

    function test_addAsset_revertsUntilTheAdapterCodehashIsAllowed() public {
        _warmRecorder();
        vm.prank(admin);
        vm.expectRevert(BasketAssetConfigGuard.AdapterCodeHashNotAllowed.selector);
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);

        vm.prank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vm.prank(admin);
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        (address t, address p, uint24 f, bool active, address a, BasketVault.Venue v) =
            vault.assets(0);
        assertEq(t, address(rm));
        assertEq(p, address(rec), "the registered pool is the recorder");
        assertEq(uint256(f), uint256(FEE));
        assertTrue(active);
        assertEq(a, address(adapter));
        assertEq(uint256(v), uint256(BasketVault.Venue.V4));
    }

    function test_addAsset_revertsWhileTheRecorderRingIsBelow901Slots() public {
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        // fresh recorder: cardinality 1
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketAssetConfigGuard.InsufficientPoolCardinality.selector,
                address(rec),
                uint16(901),
                uint16(1)
            )
        );
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        vm.stopPrank();

        // grown to 900 and recorded: cardinality 900, still one short
        rec.grow(900);
        vm.warp(block.timestamp + 2);
        rec.record();
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketAssetConfigGuard.InsufficientPoolCardinality.selector,
                address(rec),
                uint16(901),
                uint16(900)
            )
        );
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
    }

    function test_addAsset_revertsWhileTheRecorderHoldsLessThan1800sOfHistory() public {
        rec.grow(901);
        vm.warp(block.timestamp + 2);
        rec.record(); // cardinality 901, history 2 s
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketAssetConfigGuard.InsufficientObservationHistory.selector,
                address(rec),
                uint32(1800)
            )
        );
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        vm.stopPrank();
        // 1790 s of history is still short, 1800 s is enough
        for (uint256 i = 0; i < 29; i++) {
            vm.warp(block.timestamp + 60);
            rec.record();
        }
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketAssetConfigGuard.InsufficientObservationHistory.selector,
                address(rec),
                uint32(1800)
            )
        );
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        vm.warp(block.timestamp + 60);
        rec.record();
        vm.prank(admin);
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
    }

    function test_addAsset_revertsWhenTheRegisteredFeeIsNotThePoolFee() public {
        _warmRecorder();
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vm.expectRevert(BasketAssetConfigGuard.ExecutionPoolMismatch.selector);
        vault.addAsset(address(rm), address(rec), 10_000, address(adapter), BasketVault.Venue.V4);
        vm.stopPrank();
    }

    function test_addAsset_revertsWhenTheRecorderPoolDoesNotPairTheTokenWithUsdc() public {
        _warmRecorder();
        address other = address(new TestERC20());
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vm.expectRevert(BasketAssetConfigGuard.PoolTokenMismatch.selector);
        vault.addAsset(other, address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        vm.stopPrank();
    }

    function test_addAsset_revertsWhilePoolLiquidityIsBelowTheVaultFloor() public {
        _warmRecorder();
        pm.setLiquidity(poolId, 10);
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketAssetConfigGuard.InsufficientPoolLiquidity.selector,
                address(rec),
                uint128(1e6),
                uint128(10)
            )
        );
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        vm.stopPrank();
    }

    // ─── Deposit and redeem through the pool manager ────────────────

    function test_deposit_buysRmThroughThePoolManagerAndPokesTheRecorder() public {
        _readyVault();
        vm.prank(admin);
        vault.setNavDeviationGuardBps(100);
        vm.warp(block.timestamp + 10);
        (, uint32 lastBefore,,,) = rec.latest();
        uint256 swaps = pm.swapCount();
        uint256 shares = _deposit(DEPOSIT);
        assertGt(shares, 0);
        assertEq(pm.swapCount(), swaps + 1, "one swap through the PoolManager");
        assertGt(rm.balanceOf(address(vault)), 0, "the vault holds RM");
        assertEq(usdc.balanceOf(address(adapter)), 0);
        (, uint32 lastAfter,,,) = rec.latest();
        assertGt(lastAfter, lastBefore, "the deposit's swap poked the recorder");
        // NAV is priced from the recorder TWAP: about the deposit less the 2.91 percent pool fee
        uint256 nav = vault.totalAssets();
        assertApproxEqRel(nav, DEPOSIT * (1_000_000 - FEE) / 1_000_000, 0.001e18);
    }

    function test_redeem_sellsRmBackThroughTheSamePoolWhileFresh() public {
        _readyVault();
        vm.warp(block.timestamp + 10);
        uint256 shares = _deposit(DEPOSIT);
        vm.warp(block.timestamp + 10);
        rec.record();
        uint256 before_ = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertGt(usdc.balanceOf(alice), before_, "USDC came back");
        assertEq(rm.balanceOf(address(vault)), 0, "all RM sold");
    }

    // ─── Stale recorder: deposits fail closed, redeemInKind still works ──

    function test_stale_depositAndUsdcRedeemRevertAndRedeemInKindStillPays() public {
        _readyVault();
        vm.warp(block.timestamp + 10);
        uint256 shares = _deposit(DEPOSIT);
        uint256 rmHeld = rm.balanceOf(address(vault));

        vm.warp(block.timestamp + 1_801); // nobody pokes for more than one window
        assertFalse(rec.isFresh());

        vm.startPrank(alice);
        usdc.approve(address(vault), DEPOSIT);
        vm.expectPartialRevert(UniswapV4PriceRecorder.StaleRecorder.selector);
        vault.deposit(DEPOSIT, alice);
        vm.expectPartialRevert(UniswapV4PriceRecorder.StaleRecorder.selector);
        vault.redeem(shares / 2, alice, alice);
        vm.expectPartialRevert(UniswapV4PriceRecorder.StaleRecorder.selector);
        vault.totalAssets();

        uint256 rmBefore = rm.balanceOf(alice);
        vault.redeemInKind(shares / 2, alice, alice);
        vm.stopPrank();
        assertApproxEqAbs(
            rm.balanceOf(alice) - rmBefore, rmHeld / 2, 1, "half the RM, no oracle read"
        );
        assertEq(pm.swapCount(), 1, "no swap on the in-kind exit");
    }

    function test_stale_aPokeRestoresDepositsAndRedeems() public {
        _readyVault();
        vm.warp(block.timestamp + 10);
        _deposit(DEPOSIT);
        vm.warp(block.timestamp + 5_000);
        rec.record();
        // fresh again, but only one fresh snapshot after the gap: the 1800 s window now spans the stale gap
        // (the gap is priced at the last recorded tick, which is the honest one)
        vault.totalAssets();
    }

    // ─── Manipulation ────────────────────────────────────────────────

    /// @notice A flash swap that moves spot, then a poke, then a deposit in the same block: the ORA-4 guard sees spot far from
    ///         the TWAP (the record moved at most 20 ticks), so the deposit reverts. The vault is never minted shares at the mark.
    function test_manipulation_flashSwapPokeDepositRevertsOnTheDeviationGuard() public {
        _readyVault();
        vm.prank(admin);
        vault.setNavDeviationGuardBps(100);
        vm.warp(block.timestamp + 2);
        pm.setTick(poolId, 3_000); // +35 percent
        rec.record(); // attacker pokes the manipulated tick
        (int24 t,,,,) = rec.latest();
        assertEq(int256(t), 20, "recorded tick moved by the clamp only");
        vm.startPrank(alice);
        usdc.approve(address(vault), DEPOSIT);
        vm.expectPartialRevert(TwapTickMath.NavMarketDeviationExceeded.selector);
        vault.deposit(DEPOSIT, alice);
        vm.stopPrank();
    }

    function test_manipulation_theTwapPriceBarelyMovesInTheBlockOfTheAttack() public {
        _readyVault();
        uint256 before_ = vault.totalAssets();
        vm.warp(block.timestamp + 2);
        pm.setTick(poolId, 5_000);
        rec.record();
        uint256 after_ = adapter.twapPrice(address(rec), address(rm), address(usdc), 1e18, 1800);
        uint256 honest = TwapTickMath.priceFromTick(0, address(rm), address(usdc), 1e18);
        assertApproxEqRel(after_, honest, 0.0005e18, "30 min mean moved by well under 5 bps");
        assertEq(before_, 0);
    }

    /// @notice The pool charges 2.91 percent. The AgentTokenVault default slippage of 300 bps leaves 9 bps for price impact,
    ///         so a deposit that moves the price 10 bps reverts. The deploy script raises the bound to the 500 bps ceiling.
    function test_slippage_theDefault300bpsCannotCoverThePoolFeeAndImpact() public {
        _warmRecorder();
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        vm.stopPrank();
        assertEq(vault.maxSlippageBps(), 300);
        pm.setImpactTicks(0); // quote at the TWAP price: the fee alone fits inside 300 bps
        pm.setTick(poolId, -10); // the pool trades 10 ticks (about 10 bps) below the 30 min mean
        vm.startPrank(alice);
        usdc.approve(address(vault), DEPOSIT);
        vm.expectRevert();
        vault.deposit(DEPOSIT, alice);
        vm.stopPrank();
        vm.prank(admin);
        vault.setMaxSlippageBps(500);
        _deposit(DEPOSIT);
        assertGt(rm.balanceOf(address(vault)), 0);
    }
}
