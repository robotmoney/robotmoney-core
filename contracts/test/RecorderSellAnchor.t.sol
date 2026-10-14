// SPDX-License-Identifier: MIT
// Canonical: docs/technical/recorder-manipulation-1793.md
//            docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: the price recorder)
//            docs/adr/ADR-0007-basket-vault-drawdown-redemption-policy.md (core 1665: redeemInKind)
// Covers QA plan v1 task D5 (core 1793, finding E1): a price displacement held on the RM V4 pool drags the 1800 s TWAP sell
// floor onto itself, and the USDC sell anchor on `BasketVault.redeem` refuses that sale. The real-pool companion is
// `RecorderManipulationFork.t.sol::test_recorder_heldDisplacementDragsSellFloorUnderKeeperCadence`.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {BasketViews} from "../lib/BasketViews.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice rmAGENT as deployed: AgentTokenVault, UniswapV4SwapAdapter and UniswapV4PriceRecorder over the mock PoolManager,
///         `maxSlippageBps` 500 and the D10 guard of 400 bps. A keeper records every 300 s. The mock quotes at the live tick
///         less the 2.91 percent fee with no price impact, so every number below is the tick arithmetic alone.
contract RecorderSellAnchorTest is Test {
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

    uint24 internal constant FEE = 29100;
    int24 internal constant SPACING = 582;
    uint256 internal constant DEPOSIT = 100e6;
    /// @dev The rmAGENT sheet guard (QA plan decision D10).
    uint256 internal constant GUARD_BPS = 400;
    /// @dev The keeper cadence from core 1779.
    uint256 internal constant KEEPER_SECS = 300;
    /// @dev One record's clamp: 10 ticks per second for at most 60 s.
    int24 internal constant ONE_RECORD_TICKS = 600;
    /// @dev The recorder stage ring (`DeployUniswapV4PriceRecorder.RING_SLOTS`): the 14_400 s anchor / 2 s + 1.
    uint16 internal constant RING_SLOTS = 7_201;
    uint32 internal constant ANCHOR_SECS = 14_400;
    /// @dev QA plan decision D2: a loss of 5 percent of a redeem within 30 minutes is "high".
    uint256 internal constant HIGH_LOSS_BPS = 500;

    function setUp() public {
        vm.warp(1_700_000_000);
        pm = new MockV4PoolManager();
        pm.setImpactTicks(0);
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
            ISwapRouter(makeAddr("swapRouter02")),
            1_000_000e6,
            10_000e6,
            0,
            makeAddr("fees"),
            admin,
            admin
        );

        // A full anchor window of keeper history (49 records, 14_700 s) before the asset is added.
        rec.grow(RING_SLOTS);
        _keep(49);

        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        vault.setMaxSlippageBps(500);
        vault.setNavDeviationGuardBps(GUARD_BPS);
        vm.stopPrank();

        usdc.mint(alice, DEPOSIT);
        vm.startPrank(alice);
        usdc.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, alice);
        vm.stopPrank();
        _keep(1);
        assertEq(BasketViews.sellAnchorWindow(address(rec)), ANCHOR_SECS, "full anchor history");
    }

    function _key() internal view returns (IPoolManagerV4.PoolKey memory) {
        return IPoolManagerV4.PoolKey(c0, c1, FEE, SPACING, address(0));
    }

    /// @dev `n` keeper records, `KEEPER_SECS` apart.
    function _keep(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            vm.warp(block.timestamp + KEEPER_SECS);
            rec.record();
        }
    }

    /// @dev Records every `every` seconds for `secs` seconds (the keeper, or an attacker who pokes faster).
    function _recordFor(uint256 secs, uint256 every) internal {
        for (uint256 t = every; t <= secs; t += every) {
            vm.warp(block.timestamp + every);
            rec.record();
        }
    }

    /// @dev USDC value of 1e6 RM units at the mean tick of the last `window` seconds.
    function _meanValue(uint32 window) internal view returns (uint256) {
        return TwapTickMath.priceFromTick(
            TwapTickMath.meanTick(address(rec), window), address(rm), address(usdc), 1e6
        );
    }

    /// @dev Basis points by which `afterValue` sits below `beforeValue` (0 when not below).
    function _dropBps(uint256 beforeValue, uint256 afterValue) internal pure returns (uint256) {
        return afterValue >= beforeValue ? 0 : (beforeValue - afterValue) * 10_000 / beforeValue;
    }

    /// @dev What a sale of `rmAmount` would pay at the pre-attack tick 0, after the pool fee.
    function _honestProceeds(uint256 rmAmount) internal view returns (uint256) {
        return TwapTickMath.priceFromTick(0, address(rm), address(usdc), rmAmount)
            * (1_000_000 - FEE) / 1_000_000;
    }

    /// @notice The E1 model on the vault. The attacker holds the pool 600 ticks (6.2 percent) down; the keeper records every
    ///         300 s, so its first record after the push writes the full 600-tick step. After 2100 s the 1800 s NAV TWAP, and
    ///         the sell floor built on it, sits on the held price: a 582 bps drop, above the 5 percent bar. The 4 hour
    ///         anchor has moved 75 ticks, so the held spot is 511 bps below it and the USDC redeem refuses. The lowest
    ///         price at which a USDC redeem could execute is the anchor less the guard: 472 bps under the pre-attack
    ///         anchor, inside the bar. `redeemInKind` still pays the RM.
    function test_sellAnchor_heldDisplacementUnderKeeperCadenceRefusesUsdcRedeem() public {
        uint256 floorBefore = vault.assetUsdcValue(0, 1e6);
        uint256 anchorBefore = _meanValue(ANCHOR_SECS);

        pm.setTick(poolId, -ONE_RECORD_TICKS);
        _keep(7);

        uint256 floorDrop = _dropBps(floorBefore, vault.assetUsdcValue(0, 1e6));
        uint256 anchorAfter = _meanValue(ANCHOR_SECS);
        uint256 anchorDrop = _dropBps(anchorBefore, anchorAfter);
        uint256 below = BasketViews.spotBelowSellAnchorBps(address(rec), address(rm), address(usdc));
        uint256 executableFloorDrop =
            _dropBps(anchorBefore, anchorAfter * (10_000 - GUARD_BPS) / 10_000);
        emit log_named_uint("1800 s sell floor drop bps", floorDrop);
        emit log_named_uint("4 h anchor drop bps", anchorDrop);
        emit log_named_uint("spot below anchor bps", below);
        emit log_named_uint(
            "lowest executable USDC sale, bps under the pre-attack anchor", executableFloorDrop
        );

        assertGe(
            floorDrop,
            HIGH_LOSS_BPS,
            "the 1800 s floor follows the held price past the 5 percent bar"
        );
        assertLe(anchorDrop, 80, "the anchor moves an eighth of the hold, at most");
        assertGt(below, GUARD_BPS, "the held spot sits outside the guard");
        assertLt(executableFloorDrop, HIGH_LOSS_BPS, "the executable floor stays inside the bar");

        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketViews.SpotBelowSellAnchor.selector, address(rm), below, GUARD_BPS
            )
        );
        vault.redeem(shares, alice, alice);

        uint256 rmHeld = rm.balanceOf(address(vault));
        vm.prank(alice);
        vault.redeemInKind(shares, alice, alice);
        assertEq(rm.balanceOf(alice), rmHeld, "the in-kind exit pays all the RM, no price read");
    }

    /// @notice Before D5: with the guard at 0 (which also switches the anchor off) the same hold lets the USDC redeem through.
    ///         It sells at the held price, 5.8 percent under the honest proceeds, against a floor that moved with it.
    function test_sellAnchor_withTheGuardOffTheDraggedFloorPaysTheHeldPrice() public {
        pm.setTick(poolId, -ONE_RECORD_TICKS);
        _keep(7);
        vm.prank(admin);
        vault.setNavDeviationGuardBps(0);

        uint256 rmHeld = rm.balanceOf(address(vault));
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        uint256 loss = _dropBps(_honestProceeds(rmHeld), out);
        emit log_named_uint("USDC redeem loss under the held price, bps", loss);
        assertGe(loss, HIGH_LOSS_BPS, "the redeem loses more than the 5 percent bar");
    }

    /// @notice A hold inside the guard is not refused: 300 ticks (3 percent) held for 2100 s sits 262 ticks (2.6 percent)
    ///         below the anchor, which has moved 38 ticks.
    function test_sellAnchor_holdInsideTheGuardStillRedeemsInUsdc() public {
        pm.setTick(poolId, -300);
        _keep(7);
        uint256 below = BasketViews.spotBelowSellAnchorBps(address(rec), address(rm), address(usdc));
        assertGt(below, 0);
        assertLe(below, GUARD_BPS);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertGt(out, 0, "USDC paid");
        assertEq(rm.balanceOf(address(vault)), 0, "all RM sold");
    }

    /// @notice Only the sell side is gated: a price held ABOVE the anchor pays the redeemer more and is never refused.
    function test_sellAnchor_priceAboveTheAnchorIsNeverRefused() public {
        pm.setTick(poolId, ONE_RECORD_TICKS);
        _keep(7);
        assertEq(BasketViews.spotBelowSellAnchorBps(address(rec), address(rm), address(usdc)), 0);
        uint256 rmHeld = rm.balanceOf(address(vault));
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertGt(out, _honestProceeds(rmHeld), "the redeemer sells at the higher held price");
    }

    /// @notice The D2 bar holds for every hold size and both record cadences. The attacker holds `x` ticks down from the
    ///         keeper's last record and either leaves recording to the 300 s keeper or pokes every 60 s, which drags the
    ///         recorded tick at the clamp's full 10 ticks per second. 30 minutes later a USDC redeem either refuses, or
    ///         executes at a price less than 5 percent under the pre-attack price.
    function testFuzz_sellAnchor_usdcRedeemWithin30MinutesOfAHoldLosesUnderFivePercent(
        uint256 xSeed,
        bool attackerPokes
    ) public {
        int24 x = int24(int256(bound(xSeed, 1, 3_000)));
        pm.setTick(poolId, -x);
        _recordFor(1_800, attackerPokes ? 60 : KEEPER_SECS);

        uint256 rmHeld = rm.balanceOf(address(vault));
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        try vault.redeem(shares, alice, alice) returns (uint256 out) {
            assertLt(
                _dropBps(_honestProceeds(rmHeld), out), HIGH_LOSS_BPS, "executed under the bar"
            );
        } catch {
            // Refused (the anchor or the swap floor): the holder's exit is redeemInKind.
            vm.prank(alice);
            vault.redeemInKind(shares, alice, alice);
            assertEq(rm.balanceOf(alice), rmHeld);
        }
    }

    /// @notice A young recorder anchors on the history it has: the window is its age until 4 hours, never a revert.
    function test_sellAnchor_youngRecorderUsesItsWholeHistory() public {
        UniswapV4PriceRecorder young =
            new UniswapV4PriceRecorder(address(pm), c0, c1, FEE, SPACING, address(0));
        assertEq(BasketViews.sellAnchorWindow(address(young)), 0, "no history in the deploy block");
        young.grow(RING_SLOTS);
        vm.warp(block.timestamp + 100);
        young.record();
        assertEq(BasketViews.sellAnchorWindow(address(young)), 100);
        vm.warp(block.timestamp + 5 hours);
        young.record();
        assertEq(BasketViews.sellAnchorWindow(address(young)), ANCHOR_SECS);
    }

    /// @notice With the guard at 0 the anchor is off: the vault's own switch for fixtures and opted-out vaults.
    function test_sellAnchor_offWhenTheGuardIsZero() public {
        vm.prank(admin);
        vault.setNavDeviationGuardBps(0);
        pm.setTick(poolId, -3_000);
        _keep(7);
        assertGt(
            BasketViews.spotBelowSellAnchorBps(address(rec), address(rm), address(usdc)), GUARD_BPS
        );
        // No SpotBelowSellAnchor: the call reaches the sale, whose own TWAP floor decides.
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        try vault.redeem(shares, alice, alice) {}
        catch (bytes memory reason) {
            assertTrue(
                bytes4(reason) != BasketViews.SpotBelowSellAnchor.selector, "anchor is off at 0"
            );
        }
    }

    /// @notice QA plan D6 (E4): dust gates nothing. After the unwind sold the RM, anyone can send the vault one RM unit.
    ///         The redeem never sells that unit (its sale floor rounds to zero), so the held price below the anchor must
    ///         not refuse the USDC redeem of the idle USDC. A balance above dust still refuses (the tests above).
    function test_sellAnchor_dustLeftAfterAnUnwindDoesNotRefuseUsdcRedeem() public {
        vm.prank(admin);
        vault.emergencyUnwind();
        assertEq(rm.balanceOf(address(vault)), 0, "the unwind sold all the RM");
        rm.mint(address(vault), 1); // anyone can send one unit

        pm.setTick(poolId, -ONE_RECORD_TICKS);
        _keep(7);
        assertGt(
            BasketViews.spotBelowSellAnchorBps(address(rec), address(rm), address(usdc)),
            GUARD_BPS,
            "the held spot sits outside the guard"
        );

        uint256 idle = usdc.balanceOf(address(vault));
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertEq(out, idle, "all the idle USDC is paid");
        assertEq(rm.balanceOf(address(vault)), 1, "the dust is not sold");
    }
}
