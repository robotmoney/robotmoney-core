// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contracts.md §9.1.3 (redeem floor)
//            docs/technical/multi-vault-dapp-decisions.md — single-vault exit through the router
// Covers QA plan v1 task D9 (finding E8, SR-M16, core 1795 contract side): a single-vault exit through
// `PortfolioRouter.redeemFor` carries the holder's floor, which a direct `vault.redeem` has no argument for.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {BasketViews} from "../lib/BasketViews.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice rmAGENT as a registered router leg: the real AgentTokenVault, UniswapV4SwapAdapter and UniswapV4PriceRecorder
///         over the mock PoolManager (the PortfolioRouterLegAvailability setup), so `previewRedeem`, the TWAP sale floor
///         and the D5 sell anchor run production code. The holder deposits into the vault directly and exits it alone.
contract PortfolioRouterRedeemFloorTest is Test {
    MockV4PoolManager internal pm;
    UniswapV4PriceRecorder internal rec;
    UniswapV4SwapAdapter internal adapter;
    AgentTokenVault internal agent;
    TestERC20 internal usdc;
    TestERC20 internal rm;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    address internal c0;
    address internal c1;
    bytes32 internal poolId;

    address internal admin = makeAddr("admin");
    address internal holder = makeAddr("holder");

    /// @dev The RM V4 pool fee: 29100 hundredths of a bip, 291 bps (config/agent-token-shortlist.json).
    uint24 internal constant FEE = 29100;
    int24 internal constant SPACING = 582;
    /// @dev The rmAGENT sheet value (decision D10). It is also the D5 sell anchor threshold.
    uint256 internal constant SHEET_NAV_DEVIATION_BPS = 400;
    uint256 internal constant DEPOSIT = 1_000e6;
    /// @dev The client tolerance under `previewRedeem` (dapp `ROUTER_SLIPPAGE_TOLERANCE_BPS`, QA plan U9).
    uint256 internal constant TOLERANCE_BPS = 50;
    /// @dev A held fall of 350 ticks (about 3.4 percent). The vault's own sale floor follows a dragged TWAP, and the D5
    ///      anchor allows up to 4 percent under the 4 hour mean, so neither refuses it.
    int24 internal constant HOLD_TICKS = 350;
    /// @dev The keeper cadence and the number of records: one 1800 s NAV window.
    uint256 internal constant KEEPER_INTERVAL = 60;
    uint256 internal constant HOLD_RECORDS = 30;

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
        agent = new AgentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(makeAddr("swapRouter02")),
            1_000_000e6,
            10_000e6,
            0,
            makeAddr("fees"),
            admin,
            admin
        );
        registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);

        // Ring at the 901-slot floor and one full 1800 s window of history before `addAsset`.
        rec.grow(901);
        for (uint256 i = 0; i < 32; i++) {
            vm.warp(vm.getBlockTimestamp() + KEEPER_INTERVAL);
            rec.record();
        }

        vm.startPrank(admin);
        agent.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        agent.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        agent.setMaxSlippageBps(500);
        agent.setNavDeviationGuardBps(SHEET_NAV_DEVIATION_BPS);
        // `redeemFor` needs a registered vault (any status). Router weights and eligibility are deposit-side only.
        registry.registerVault(
            address(agent),
            VaultRegistry.VaultMetadata({name: "rmAGENT", asset: address(usdc), registeredAt: 0})
        );
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 10);
    }

    function _key() internal view returns (IPoolManagerV4.PoolKey memory) {
        return IPoolManagerV4.PoolKey(c0, c1, FEE, SPACING, address(0));
    }

    function _deposit(uint256 amount) internal returns (uint256 shares) {
        usdc.mint(holder, amount);
        vm.startPrank(holder);
        usdc.approve(address(agent), amount);
        shares = agent.deposit(amount, holder);
        vm.stopPrank();
    }

    /// @dev The client's floor: `previewRedeem(shares)` less `TOLERANCE_BPS`, rounded down.
    function _floor(uint256 shares) internal view returns (uint256) {
        uint256 preview = agent.previewRedeem(shares);
        return preview - preview * TOLERANCE_BPS / 10_000;
    }

    /// @dev The one-leg exit the dapp signs: `redeemFor(holder, holder, [rmAGENT], [shares], [floor], deadline)`.
    function _oneLeg(uint256 shares, uint256 minAssets)
        internal
        view
        returns (address[] memory vaults, uint256[] memory sharesPerLeg, uint256[] memory floors)
    {
        vaults = new address[](1);
        vaults[0] = address(agent);
        sharesPerLeg = new uint256[](1);
        sharesPerLeg[0] = shares;
        floors = new uint256[](1);
        floors[0] = minAssets;
    }

    function _redeemFor(uint256 shares, uint256 minAssets) internal returns (uint256 paid) {
        (address[] memory vaults, uint256[] memory sharesPerLeg, uint256[] memory floors) =
            _oneLeg(shares, minAssets);
        uint256 deadline = vm.getBlockTimestamp() + 1_800;
        vm.prank(holder);
        uint256[] memory assetsPerLeg =
            router.redeemFor(holder, holder, vaults, sharesPerLeg, floors, deadline);
        paid = assetsPerLeg[0];
    }

    /// @notice E8 / SR-M16. ERC-4626 `redeem` takes no minimum out. A BasketVault's own sale floor is the TWAP value less
    ///         `maxSlippageBps`, read at inclusion, and a held RM fall drags that TWAP with it (core 1793). So a direct
    ///         redeem settles under what the holder was quoted and never reverts. The same exit as a one-leg `redeemFor`
    ///         carries the quote-time floor (`previewRedeem` less 0.50 percent) and reverts `SlippageExceeded`, leaving
    ///         the shares with the holder. Undisturbed, the same call pays above the floor and spends the exact router
    ///         approval to zero. After the refusal, a fresh quote exits at the new price through the same route.
    function test_redeemFor_singleLegFloorBindsOnBasketVault() public {
        uint256 shares = _deposit(DEPOSIT);
        uint256 quoted = agent.previewRedeem(shares);
        uint256 floor = _floor(shares);
        assertGt(floor, 0, "quote-time floor is set");
        // The holder approves the router for exactly the shares of the one call it sends next.
        vm.prank(holder);
        agent.approve(address(router), shares);

        // 1. Undisturbed: the one-leg redeem clears the floor and spends the exact approval.
        uint256 snap = vm.snapshotState();
        uint256 paid = _redeemFor(shares, floor);
        assertGe(paid, floor, "undisturbed redeem clears the floor");
        assertEq(usdc.balanceOf(holder), paid, "USDC lands with the holder");
        assertEq(agent.balanceOf(holder), 0, "every share burned");
        assertEq(agent.allowance(holder, address(router)), 0, "exact approval spent to zero");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
        vm.revertToState(snap);

        // 2. RM falls HOLD_TICKS and a keeper records the held price every 60 s for one NAV window.
        pm.setTick(poolId, address(rm) == c0 ? -HOLD_TICKS : HOLD_TICKS);
        for (uint256 i = 0; i < HOLD_RECORDS; i++) {
            vm.warp(vm.getBlockTimestamp() + KEEPER_INTERVAL);
            rec.record();
        }
        assertTrue(rec.isFresh(), "recorder fresh: not a staleness case");
        assertLt(
            BasketViews.spotBelowSellAnchorBps(address(rec), address(rm), address(usdc)),
            SHEET_NAV_DEVIATION_BPS,
            "the hold stays under the D5 sell anchor"
        );

        // A direct redeem has no caller floor. The vault's own floor moved with the TWAP, so it pays under the quote.
        // It also proves the vault does not revert in this state: the revert below is the router's floor.
        snap = vm.snapshotState();
        uint256 preview = agent.previewRedeem(shares);
        vm.prank(holder);
        uint256 direct = agent.redeem(shares, holder, holder);
        assertGe(direct, preview, "the vault keeps its own ERC-4626 promise at inclusion");
        assertLt(direct, quoted, "the held fall cost the holder against the quote");
        assertLt(direct, floor, "a direct redeem settles under the holder's quote-time floor");
        vm.revertToState(snap);

        // The one-leg router redeem with the quote-time floor refuses the same exit.
        (address[] memory vaults, uint256[] memory sharesPerLeg, uint256[] memory floors) =
            _oneLeg(shares, floor);
        uint256 deadline = vm.getBlockTimestamp() + 1_800;
        vm.prank(holder);
        vm.expectRevert(PortfolioRouter.SlippageExceeded.selector);
        router.redeemFor(holder, holder, vaults, sharesPerLeg, floors, deadline);
        assertEq(agent.balanceOf(holder), shares, "shares stay with the holder");
        assertEq(usdc.balanceOf(holder), 0, "no USDC paid");
        assertEq(
            agent.allowance(holder, address(router)),
            shares,
            "the unspent approval is left for the holder to clear"
        );

        // 3. A fresh quote at the new price exits through the same route and pays what the direct redeem paid.
        uint256 newFloor = _floor(shares);
        assertLt(newFloor, floor, "the fresh quote shows the fall");
        paid = _redeemFor(shares, newFloor);
        assertEq(paid, direct, "re-quoted exit pays the same fill");
        assertGe(paid, newFloor, "re-quoted exit clears its floor");
        assertEq(agent.balanceOf(holder), 0, "every share burned");
        assertEq(agent.allowance(holder, address(router)), 0, "exact approval spent to zero");
    }
}
