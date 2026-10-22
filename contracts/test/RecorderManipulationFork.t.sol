// SPDX-License-Identifier: MIT
// Canonical: docs/technical/recorder-manipulation-1793.md
//            docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: the price recorder)
//            docs/operations/contract-release-runbooks.md (Recorder keeper, core 1779)
// Covers QA plan v1 task D5 (core 1793, finding E1) against the REAL Base Uniswap V4 PoolManager and the live RM/USDC pool.
// The mock-pool companion with exact tick arithmetic and the fuzzed bound is `RecorderSellAnchor.t.sol`.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {BasketViews} from "../lib/BasketViews.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {DeployUniswapV4PriceRecorder} from "../script/DeployUniswapV4PriceRecorder.s.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @notice Runs on the Twin chain (a pinned lazy anvil fork of real Base). With FORK_RPC_URL unset the test skips with a
///         named reason (ForkSelect). Production configuration throughout: the shipped PoolKey, the recorder stage's
///         7_201-slot ring, AgentTokenVault with `maxSlippageBps` 500 and the D10 guard of 400 bps, and the core 1779 keeper
///         cadence of 300 s. Every transaction stays on the local fork.
contract RecorderManipulationForkTest is Test {
    using stdJson for string;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// @dev The keeper cadence from core 1779.
    uint256 internal constant KEEPER_SECS = 300;
    /// @dev The held displacement: one record's full clamp (10 ticks per second for 60 s), about 6.2 percent.
    int24 internal constant HOLD_TICKS = 600;
    /// @dev The attacker's RM inventory is bought first, before the honest history, so the later sale can push this far
    ///      below the honest price after the pool fee on both legs.
    int24 internal constant INVENTORY_TICKS = 680;
    /// @dev Swap size of each inventory step. About 0.3 percent of the 1,750 USDC virtual reserve ADR-0005 measured.
    uint256 internal constant STEP_USDC = 5e6;
    /// @dev rmAGENT sheet guard (QA plan decision D10).
    uint256 internal constant GUARD_BPS = 400;
    /// @dev QA plan decision D2: 5 percent of a redeem within 30 minutes is "high".
    uint256 internal constant HIGH_LOSS_BPS = 500;
    uint32 internal constant ANCHOR_SECS = 14_400;

    string internal cfg;
    IPoolManagerV4.PoolKey internal key;
    address internal poolManager;
    address internal rmToken;
    address internal swapRouter02;
    UniswapV4PriceRecorder internal rec;
    UniswapV4SwapAdapter internal adapter;
    AgentTokenVault internal vault;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;

        cfg = vm.readFile("config/agent-token-shortlist.json");
        // RM_PARKED (core issue 1903, ADR-0015): RM sits under parked.entries while it is parked.
        string memory b =
            vm.keyExistsJson(cfg, ".shortlist[0]") ? ".shortlist[0]" : ".parked.entries[0]";
        rmToken = cfg.readAddress(string.concat(b, ".token"));
        poolManager = cfg.readAddress(string.concat(b, ".poolManager"));
        swapRouter02 = cfg.readAddress(".swapRouter02");
        key = IPoolManagerV4.PoolKey({
            currency0: cfg.readAddress(string.concat(b, ".poolKey.currency0")),
            currency1: cfg.readAddress(string.concat(b, ".poolKey.currency1")),
            fee: uint24(cfg.readUint(string.concat(b, ".poolKey.fee"))),
            tickSpacing: int24(int256(cfg.readUint(string.concat(b, ".poolKey.tickSpacing")))),
            hooks: cfg.readAddress(string.concat(b, ".poolKey.hooks"))
        });
        // The recorder stage exactly as shipped (ring of RING_SLOTS).
        DeployUniswapV4PriceRecorder stage = new DeployUniswapV4PriceRecorder();
        rec = UniswapV4PriceRecorder(stage.runInProcess(cfg).recorder);
        adapter = new UniswapV4SwapAdapter(poolManager, key, address(rec), USDC);

        deal(USDC, attacker, 10_000e6);
        deal(USDC, alice, 100e6);
        vm.startPrank(attacker);
        IERC20(USDC).approve(address(adapter), type(uint256).max);
        IERC20(rmToken).approve(address(adapter), type(uint256).max);
        vm.stopPrank();
    }

    function _liveTick() internal view returns (int24 tick) {
        (, tick,,) = rec.slot0();
    }

    /// @dev `n` keeper records, `KEEPER_SECS` apart.
    function _keep(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            vm.warp(block.timestamp + KEEPER_SECS);
            rec.record();
        }
    }

    function _dropBps(uint256 beforeValue, uint256 afterValue) internal pure returns (uint256) {
        return afterValue >= beforeValue ? 0 : (beforeValue - afterValue) * 10_000 / beforeValue;
    }

    function _anchorValue(uint256 rmAmount) internal view returns (uint256) {
        return TwapTickMath.priceFromTick(
            TwapTickMath.meanTick(address(rec), ANCHOR_SECS), rmToken, USDC, rmAmount
        );
    }

    /// @dev rmAGENT as the agent stage builds it, on the recorder above, with a 2 USDC deposit from alice.
    function _deployVaultAndDeposit() internal {
        vault = CoreProxies.agentTokenVault(
            IERC20(USDC),
            ISwapRouter(swapRouter02),
            1_000e6,
            18e6, // the ADR-0005 single-swap limit at the 2026-10-08 depth
            0,
            makeAddr("fees"),
            admin,
            admin
        );
        vm.startPrank(admin);
        vault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        vault.addAsset(rmToken, address(rec), key.fee, address(adapter), BasketVault.Venue.V4);
        vault.setMaxSlippageBps(500);
        vault.setNavDeviationGuardBps(GUARD_BPS);
        vm.stopPrank();
        vm.startPrank(alice);
        IERC20(USDC).approve(address(vault), 2e6);
        vault.deposit(2e6, alice);
        vm.stopPrank();
    }

    // ─── Run state, kept in storage so each phase stays a shallow frame ──

    uint256 internal inventory;
    uint256 internal inventoryCost;
    int24 internal honestTick;
    uint256 internal probeRm;
    uint256 internal floorBefore;
    uint256 internal anchorBefore;
    uint256 internal rmSold;
    uint256 internal pushProceeds;

    /// @notice The E1 model on the real pool. The attacker sells RM until the pool sits at least 600 ticks under the honest
    ///         price and holds it there. The keeper records every 300 s, so it records the held price (it is not a defence).
    ///         After 2100 s the 1800 s NAV TWAP, and the TWAP sell floor of every USDC redeem, has followed the hold by
    ///         more than the 5 percent bar. The 4 hour sell anchor has moved about an eighth as far, so the USDC redeem
    ///         refuses with `SpotBelowSellAnchor` and the lowest price a USDC redeem could execute at stays inside the bar.
    ///         `redeemInKind` still pays the RM. The logs carry the pool depth and the attack's cost for the report.
    function test_recorder_heldDisplacementDragsSellFloorUnderKeeperCadence() public {
        _buyInventory();
        _honestHistory();
        _push();
        // The hold: nobody trades, the keeper records every 300 s for 2100 s.
        _keep(7);
        (int24 recorded,,,,) = rec.latest();
        assertEq(int256(recorded), int256(_liveTick()), "the keeper recorded the held price");
        _measureAndAssertBound();
        _usdcRedeemRefusesAndInKindPays();
        _unwindAndLogCost();
    }

    /// @dev Attacker inventory, bought before the honest history. Each step pokes the recorder (a no-op in this block).
    function _buyInventory() internal {
        int24 start = _liveTick();
        vm.startPrank(attacker);
        for (uint256 i = 0; i < 200 && _liveTick() < start + INVENTORY_TICKS; i++) {
            inventory += adapter.swap(
                USDC, rmToken, key.fee, STEP_USDC, 1, attacker, block.timestamp
            );
            inventoryCost += STEP_USDC;
        }
        vm.stopPrank();
        assertGe(_liveTick(), start + INVENTORY_TICKS, "inventory bought");
    }

    /// @dev Honest history: 2100 s, the vault and a deposit, then a full 4 hour anchor window of keeper records.
    function _honestHistory() internal {
        _keep(7);
        _deployVaultAndDeposit();
        _keep(49);
        assertEq(BasketViews.sellAnchorWindow(address(rec)), ANCHOR_SECS, "full anchor history");
        honestTick = _liveTick();
        (uint160 sqrtP,,,) = rec.slot0();
        // Virtual USDC reserve at spot: L x sqrtP (token1 is USDC), in raw USDC units.
        emit log_named_decimal_uint(
            "virtual USDC reserve at spot", Math.mulDiv(rec.liquidity(), sqrtP, 1 << 96), 6
        );
        probeRm = TwapTickMath.priceFromTick(honestTick, USDC, rmToken, 1e12);
        floorBefore = vault.assetUsdcValue(0, probeRm);
        anchorBefore = _anchorValue(probeRm);
        assertEq(
            BasketViews.spotBelowSellAnchorBps(address(rec), rmToken, USDC), 0, "honest: no gap"
        );
    }

    /// @dev The push: sell inventory in 1/40 steps until the pool is at least HOLD_TICKS under the honest price.
    function _push() internal {
        uint256 step = inventory / 40;
        vm.startPrank(attacker);
        while (_liveTick() > honestTick - HOLD_TICKS && rmSold + step <= inventory) {
            pushProceeds += adapter.swap(rmToken, USDC, key.fee, step, 1, attacker, block.timestamp);
            rmSold += step;
        }
        vm.stopPrank();
        int256 displacement = int256(honestTick) - int256(_liveTick());
        emit log_named_int("held displacement, ticks", displacement);
        emit log_named_decimal_uint(
            "push size, USDC at the honest price",
            TwapTickMath.priceFromTick(honestTick, rmToken, USDC, rmSold),
            6
        );
        assertGe(displacement, int256(HOLD_TICKS), "pool held at least 600 ticks down");
    }

    /// @dev The drag of the 1800 s floor (E1) and the bound the anchor puts on the executable floor (D5).
    function _measureAndAssertBound() internal {
        uint256 floorDrop = _dropBps(floorBefore, vault.assetUsdcValue(0, probeRm));
        uint256 anchorAfter = _anchorValue(probeRm);
        uint256 anchorDrop = _dropBps(anchorBefore, anchorAfter);
        uint256 below = BasketViews.spotBelowSellAnchorBps(address(rec), rmToken, USDC);
        uint256 executableFloorDrop =
            _dropBps(anchorBefore, anchorAfter * (10_000 - GUARD_BPS) / 10_000);
        emit log_named_uint("1800 s sell floor drop after 2100 s, bps", floorDrop);
        emit log_named_uint("4 h anchor drop after 2100 s, bps", anchorDrop);
        emit log_named_uint("spot below anchor, bps", below);
        emit log_named_uint(
            "lowest executable USDC sale under the honest anchor, bps", executableFloorDrop
        );
        assertGe(
            floorDrop,
            HIGH_LOSS_BPS,
            "the 1800 s floor follows the held price past the 5 percent bar"
        );
        assertLe(anchorDrop, 100, "the anchor moves about an eighth of the hold");
        assertGt(below, GUARD_BPS, "the held spot sits outside the guard");
        assertLt(
            executableFloorDrop,
            HIGH_LOSS_BPS,
            "the executable floor drop is bounded inside the bar"
        );
    }

    /// @dev The fix: the USDC redeem refuses, the in-kind exit pays.
    function _usdcRedeemRefusesAndInKindPays() internal {
        uint256 shares = vault.balanceOf(alice);
        uint256 rmHeld = IERC20(rmToken).balanceOf(address(vault));
        vm.prank(alice);
        vm.expectPartialRevert(BasketViews.SpotBelowSellAnchor.selector);
        vault.redeem(shares, alice, alice);
        uint256 rmBefore = IERC20(rmToken).balanceOf(alice);
        vm.prank(alice);
        vault.redeemInKind(shares, alice, alice);
        assertEq(IERC20(rmToken).balanceOf(alice) - rmBefore, rmHeld, "in-kind exit pays the RM");
    }

    /// @dev The attacker unwinds with the push proceeds. The RM not bought back is the cost of the push and the hold.
    function _unwindAndLogCost() internal {
        vm.prank(attacker);
        uint256 rmBack =
            adapter.swap(USDC, rmToken, key.fee, pushProceeds, 1, attacker, block.timestamp);
        uint256 holdCost = rmBack >= rmSold
            ? 0
            : TwapTickMath.priceFromTick(honestTick, rmToken, USDC, rmSold - rmBack);
        emit log_named_decimal_uint("push and unwind cost, USDC at the honest price", holdCost, 6);
        emit log_named_decimal_uint("attacker inventory bought for, USDC", inventoryCost, 6);
    }
}
