// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (RTR-5, ORA-4)
//            docs/architecture.md §4.2.1 — router deposit availability
// Covers QA plan v1 task D4 (findings CS-4 and E6): the router skips a leg the vault itself cannot take, and the rmAGENT
// guard sits above the RM pool fee band. Security round 1: a basket outside its ORA-4 band is skipped (its `previewDeposit`
// runs the guard), and an rmUSDC leg with a capped Morpho adapter still deposits. Security round 2: an rmUSDC leg whose lending
// venues refuse a supply still deposits, and a leg that turns unavailable after the caller set a floor on it reverts. Security
// round 3: an rmUSDC leg whose lending venue shuts withdrawals (Aave reserve paused) is skipped, not minted at a NAV that counts
// the stuck balance.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {MorphoAdapter} from "../adapters/MorphoAdapter.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {NoYieldTestAdapter} from "./helpers/NoYieldTestAdapter.sol";
import {MockMorphoVault} from "./MorphoAdapter.t.sol";
import {CappedAavePool, CappedMetaMorpho} from "./helpers/RefusingVenues.sol";

/// @dev 1:1 router leg whose `previewDeposit` and `deposit` revert above `ceiling` while `maxDeposit` stays open, so only the
///      router's quote check can drop it. Counts `deposit` calls so a test can prove a dropped leg was never called.
contract QuoteCeilingVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;
    uint256 public ceiling = type(uint256).max;
    uint256 public depositCalls;

    constructor(address asset_) ERC20("Quote Ceiling Vault", "QCV") {
        assetToken = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function setCeiling(uint256 c) external {
        ceiling = c;
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) {
        require(assets <= ceiling, "QuoteCeilingVault: quote above ceiling");
        return assets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        depositCalls++;
        require(assets <= ceiling, "QuoteCeilingVault: deposit above ceiling");
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    function retire() external {}

    function unretire() external {}
}

/// @notice A two-leg router: rmAGENT on the RM/USDC Uniswap V4 pool (50 percent) and a 1:1 vault (50 percent). rmAGENT is the
///         real AgentTokenVault, UniswapV4SwapAdapter and UniswapV4PriceRecorder over the mock PoolManager, so its
///         `maxDeposit`, `previewDeposit` and ORA-4 guard run production code. The guard starts at the D10 sheet value.
contract PortfolioRouterLegAvailabilityTest is Test {
    MockV4PoolManager internal pm;
    UniswapV4PriceRecorder internal rec;
    UniswapV4SwapAdapter internal adapter;
    AgentTokenVault internal agent;
    MockVault internal other;
    TestERC20 internal usdc;
    TestERC20 internal rm;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    address internal c0;
    address internal c1;
    bytes32 internal poolId;

    address internal admin = makeAddr("admin");
    address internal depositor = makeAddr("depositor");

    /// @dev The RM V4 pool fee: 29100 hundredths of a bip, 291 bps (config/agent-token-shortlist.json).
    uint24 internal constant FEE = 29100;
    int24 internal constant SPACING = 582;
    uint256 internal constant LEG = 100e6;
    /// @dev The rmAGENT sheet value before D4 (twin sheet `VAULT_AGENT_NAV_DEVIATION_BPS`): below the fee band.
    uint256 internal constant OLD_SHEET_NAV_DEVIATION_BPS = 100;
    /// @dev The rmAGENT sheet value from D4 (decision D10): the 291 bps fee plus a TWAP lag budget.
    uint256 internal constant SHEET_NAV_DEVIATION_BPS = 400;
    /// @dev An unrecorded drift of 250 ticks (about 2.5 percent) sits inside the 2.91 percent fee band (about 287 ticks), where
    ///      no arbitrage closes it.
    int24 internal constant DRIFT_TICKS = 250;

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
        agent = CoreProxies.agentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(makeAddr("swapRouter02")),
            1_000_000e6,
            10_000e6,
            0,
            makeAddr("fees"),
            admin,
            admin
        );
        other = new MockVault(address(usdc));
        registry = CoreProxies.vaultRegistry(admin);
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), admin);

        // Ring at the 901-slot floor and one full 1800 s window of history before `addAsset`.
        rec.grow(901);
        for (uint256 i = 0; i < 32; i++) {
            vm.warp(block.timestamp + 60);
            rec.record();
        }

        vm.startPrank(admin);
        agent.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        agent.addAsset(address(rm), address(rec), FEE, address(adapter), BasketVault.Venue.V4);
        // The 2.91 percent fee leaves the 300 bps default no room: the deploy script raises it to the 500 bps ceiling.
        agent.setMaxSlippageBps(500);
        agent.setNavDeviationGuardBps(SHEET_NAV_DEVIATION_BPS);

        _register(address(agent), "rmAGENT");
        _register(address(other), "other");
        address[] memory vaults = new address[](2);
        vaults[0] = address(agent);
        vaults[1] = address(other);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 5_000;
        bps[1] = 5_000;
        router.setWeights(vaults, bps);
        vm.stopPrank();

        vm.warp(block.timestamp + 10);
    }

    function _key() internal view returns (IPoolManagerV4.PoolKey memory) {
        return IPoolManagerV4.PoolKey(c0, c1, FEE, SPACING, address(0));
    }

    /// @dev Register `vault` and make it router-eligible. The caller holds the registry's ADMIN_ROLE.
    function _register(address vault, string memory name) internal {
        registry.registerVault(
            vault, VaultRegistry.VaultMetadata({name: name, asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(vault, true);
    }

    function _routerDeposit(uint256 amount) internal returns (uint256[] memory shares) {
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(router), amount);
        shares = router.deposit(amount, new uint256[](0));
        vm.stopPrank();
    }

    // ─── RTR-5: preview and execute skip the same legs ────────────────────────

    /// @notice CS-4. A stale recorder makes every NAV read on rmAGENT revert, `maxDeposit` and `previewDeposit` included, while
    ///         the registry still says Active. The router previews the leg unavailable and the deposit skips it, renormalising
    ///         the whole amount onto the live leg. Before D4 the leg stayed in the set and the routed deposit reverted
    ///         `UsdcLegTransferFailed(rmAGENT)`. One poke restores the leg on the next deposit.
    function test_RTR5_staleRecorderLegIsSkippedNotReverted() public {
        uint256 amount = 2 * LEG;
        uint256[] memory shares = _routerDeposit(amount);
        assertGt(shares[0], 0, "fresh rmAGENT leg is funded");
        assertEq(shares[1], LEG, "the 1:1 leg is funded");

        // Nobody pokes the recorder for more than one window.
        vm.warp(block.timestamp + 1_801);
        assertFalse(rec.isFresh(), "recorder is stale");
        (, VaultRegistry.VaultStatus status) = registry.getVault(address(agent));
        assertEq(
            uint256(status), uint256(VaultRegistry.VaultStatus.Active), "registry still Active"
        );
        vm.expectPartialRevert(UniswapV4PriceRecorder.StaleRecorder.selector);
        agent.previewDeposit(LEG);
        vm.expectPartialRevert(UniswapV4PriceRecorder.StaleRecorder.selector);
        agent.maxDeposit(address(router));

        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "stale leg previews unavailable");
        assertEq(legs[0].legAmount, 0, "stale leg gets no USDC");
        assertEq(legs[0].estShares, 0, "stale leg quotes nothing");
        assertFalse(legs[1].unavailable, "live leg previews available");
        assertEq(legs[1].legAmount, amount, "live leg absorbs the whole amount");
        assertEq(legs[1].estShares, amount, "live leg quotes 1:1");

        uint256 agentSupply = agent.totalSupply();
        uint256 otherBefore = other.balanceOf(depositor);
        uint256 swaps = pm.swapCount();
        shares = _routerDeposit(amount);
        assertEq(shares[0], 0, "stale leg skipped, not reverted");
        assertEq(shares[1], amount, "live leg funded with the renormalised amount");
        assertEq(other.balanceOf(depositor) - otherBefore, amount, "executed as previewed");
        assertEq(agent.totalSupply(), agentSupply, "no rmAGENT shares minted");
        assertEq(pm.swapCount(), swaps, "no swap on the skipped leg");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");

        // One poke makes the recorder fresh, and the next deposit funds both legs again.
        rec.record();
        legs = router.previewDeposit(amount);
        assertFalse(legs[0].unavailable, "fresh leg previews available again");
        shares = _routerDeposit(amount);
        assertGt(shares[0], 0, "rmAGENT leg funded again");
        assertEq(shares[1], LEG);
    }

    /// @notice The vault's own deposit pause (`EMERGENCY_ROLE` `pauseDeposits()`) is outside the registry. `maxDeposit` reads
    ///         0, so the router skips the leg even though the registry still says Active and the vault still quotes.
    function test_RTR5_vaultOwnDepositPauseLegIsSkippedNotReverted() public {
        vm.prank(admin);
        agent.pauseDeposits();
        assertEq(agent.maxDeposit(address(router)), 0, "paused vault: maxDeposit 0");
        assertGt(agent.previewDeposit(LEG), 0, "paused vault still quotes");
        (, VaultRegistry.VaultStatus status) = registry.getVault(address(agent));
        assertEq(
            uint256(status), uint256(VaultRegistry.VaultStatus.Active), "registry still Active"
        );

        uint256 amount = 2 * LEG;
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "paused leg previews unavailable");
        assertEq(legs[1].legAmount, amount, "live leg absorbs the whole amount");

        uint256[] memory shares = _routerDeposit(amount);
        assertEq(shares[0], 0, "paused leg skipped, not reverted");
        assertEq(shares[1], amount, "live leg funded with the renormalised amount");
        assertEq(agent.totalSupply(), 0, "no rmAGENT shares minted");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
    }

    /// @notice A dropped quote changes the split, so the router re-quotes the survivors. Three 1:1 legs at 40/30/30 on
    ///         1,000 USDC: Y never quotes, Z quotes 300 but not the 429 it gets once Y is gone, X takes everything.
    ///         Preview and execute agree on each round's result, and neither dropped leg is ever called.
    function test_RTR5_quoteRevertDropsLegAndResplitsUntilStable() public {
        VaultRegistry reg = CoreProxies.vaultRegistry(admin);
        PortfolioRouter r = CoreProxies.portfolioRouter(address(usdc), address(reg), admin);
        QuoteCeilingVault x = new QuoteCeilingVault(address(usdc));
        QuoteCeilingVault y = new QuoteCeilingVault(address(usdc));
        QuoteCeilingVault z = new QuoteCeilingVault(address(usdc));
        address[] memory vaults = new address[](3);
        vaults[0] = address(x);
        vaults[1] = address(y);
        vaults[2] = address(z);
        uint256[] memory bps = new uint256[](3);
        bps[0] = 4_000;
        bps[1] = 3_000;
        bps[2] = 3_000;
        vm.startPrank(admin);
        for (uint256 i = 0; i < 3; i++) {
            reg.registerVault(
                vaults[i],
                VaultRegistry.VaultMetadata({name: "leg", asset: address(usdc), registeredAt: 0})
            );
            reg.setRouterEligible(vaults[i], true);
        }
        r.setWeights(vaults, bps);
        vm.stopPrank();

        uint256 amount = 1_000e6;
        y.setCeiling(0);
        z.setCeiling(350e6);

        PortfolioRouter.LegPreview[] memory legs = r.previewDeposit(amount);
        assertFalse(legs[0].unavailable, "X stays");
        assertTrue(legs[1].unavailable, "Y never quotes");
        assertTrue(legs[2].unavailable, "Z fails at its renormalised amount");
        assertEq(legs[0].legAmount, amount, "X takes the whole amount");
        assertEq(legs[0].estShares, amount, "X quoted at the amount it receives");
        assertEq(legs[1].legAmount + legs[2].legAmount, 0, "dropped legs get nothing");

        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(r), amount);
        uint256[] memory shares = r.deposit(amount, new uint256[](0));
        vm.stopPrank();
        assertEq(shares[0], amount, "X deposited exactly as previewed");
        assertEq(shares[1] + shares[2], 0);
        assertEq(y.depositCalls() + z.depositCalls(), 0, "dropped legs are never called");
        assertEq(usdc.balanceOf(address(r)), 0, "router holds no USDC");
    }

    // ─── ORA-4: an out-of-band basket is skipped, and the rmAGENT guard sits above the fee band ──

    /// @dev Drift the RM pool's spot `DRIFT_TICKS` from the recorded TWAP on the side where RM is cheaper at spot, and
    ///      return the deviation the ORA-4 guard measures. The recorder stays fresh: this is not a staleness case.
    function _driftSpot() internal returns (uint256 dev) {
        int24 drift = address(rm) == c0 ? -DRIFT_TICKS : DRIFT_TICKS;
        pm.setTick(poolId, drift);
        assertTrue(rec.isFresh(), "recorder fresh: the drift is not a staleness case");
        dev = TwapTickMath.deviationBps(
            address(rec),
            address(rm),
            address(usdc),
            agent.effectiveTwapWindow(address(rm)),
            agent.assetTokenValue(0, 1e6)
        );
    }

    /// @notice Security round 1 (ORA-4 liveness). Spot sits about 2.5 percent from the TWAP and the guard is 100 bps, so
    ///         the basket's own deposit would revert `NavMarketDeviationExceeded`. `BasketVault.previewDeposit` now runs
    ///         the same guard, so the router's quote pass drops the leg: `previewDeposit` reports it unavailable and the
    ///         routed deposit renormalises the whole amount onto the live leg. Before the fix the views passed, the leg
    ///         stayed in the set, and the whole routed deposit reverted `UsdcLegTransferFailed(rmAGENT)`, the 1:1 part
    ///         included. `maxMint` still never reverts (ERC-4626).
    function test_ORA4_outsideBandBasketLegIsSkippedNotReverted() public {
        vm.prank(admin);
        agent.setNavDeviationGuardBps(OLD_SHEET_NAV_DEVIATION_BPS);
        uint256 dev = _driftSpot();
        assertGt(dev, OLD_SHEET_NAV_DEVIATION_BPS, "spot is outside the 100 bps band");
        assertGt(agent.maxDeposit(address(router)), 0, "the vault's own gate is open");
        vm.expectPartialRevert(TwapTickMath.NavMarketDeviationExceeded.selector);
        agent.previewDeposit(LEG);
        assertGt(agent.maxMint(address(router)), 0, "maxMint does not run the guard");

        uint256 amount = 2 * LEG;
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "the out-of-band basket previews unavailable");
        assertEq(legs[0].legAmount, 0, "it gets no USDC");
        assertFalse(legs[1].unavailable, "the 1:1 leg stays");
        assertEq(legs[1].legAmount, amount, "the 1:1 leg absorbs the whole amount");

        uint256 agentSupply = agent.totalSupply();
        uint256 otherBefore = other.balanceOf(depositor);
        uint256 swaps = pm.swapCount();
        uint256[] memory shares = _routerDeposit(amount);
        assertEq(shares[0], 0, "out-of-band leg skipped, not reverted");
        assertEq(shares[1], amount, "the 1:1 leg funded with the renormalised amount");
        assertEq(other.balanceOf(depositor) - otherBefore, amount, "executed as previewed");
        assertEq(agent.totalSupply(), agentSupply, "no rmAGENT shares minted");
        assertEq(pm.swapCount(), swaps, "no swap on the skipped leg");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
    }

    /// @notice E6. Spot drifts about 2.5 percent from the recorded TWAP and nobody trades it back, because the drift is
    ///         inside the 2.91 percent fee band. At the old 100 bps sheet value that drift takes rmAGENT out of every
    ///         routed deposit (`test_ORA4_outsideBandBasketLegIsSkippedNotReverted`; before security round 1 it reverted
    ///         the whole routed deposit). At the D10 value (400 bps) the same routed deposit funds both legs. The drift is
    ///         on the side where RM is cheaper at spot. On the other side the 500 bps swap bound (291 bps fee plus the drift)
    ///         binds before the guard.
    function test_ORA4_idlePoolDriftInsideFeeBandDoesNotRevertRoutedDeposit() public {
        uint256 dev = _driftSpot();
        assertGt(dev, OLD_SHEET_NAV_DEVIATION_BPS, "drift is above the old 100 bps guard");
        assertLt(dev, uint256(FEE) / 100, "drift is inside the pool fee band");

        uint256 amount = 2 * LEG;
        vm.prank(admin);
        agent.setNavDeviationGuardBps(SHEET_NAV_DEVIATION_BPS);
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertFalse(legs[0].unavailable, "inside the 400 bps band the leg stays");
        uint256[] memory shares = _routerDeposit(amount);
        assertGt(shares[0], 0, "rmAGENT leg funded under the drift");
        assertEq(shares[1], LEG, "the 1:1 leg is funded");
        assertGt(rm.balanceOf(address(agent)), 0, "the vault bought RM");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
    }

    // ─── rmUSDC leg with a capped Morpho adapter (security round 1, D8 follow-up) ──────

    /// @notice The production weight vector (rmUSDC 9500, a second leg 500) with a Morpho `maxExposure` below Morpho's
    ///         equal-weight slice of the rmUSDC leg. The routed deposit succeeds: the vault stops Morpho at its cap and
    ///         places the rest in the other adapter. Before the fix rmUSDC's `maxDeposit` and `previewDeposit` passed,
    ///         its deposit reverted inside `MorphoAdapter._deposit` (`ExposureCapExceeded`), and the whole routed deposit
    ///         reverted `UsdcLegTransferFailed(rmUSDC)`.
    function test_RTR5_rmUsdcLegWithCappedMorphoStillDeposits() public {
        VaultRegistry reg = CoreProxies.vaultRegistry(admin);
        PortfolioRouter r = CoreProxies.portfolioRouter(address(usdc), address(reg), admin);
        RobotMoneyVault rmUsdc = CoreProxies.robotMoneyVault(
            IERC20(address(usdc)), 1_000_000e6, 1_000_000e6, 0, makeAddr("fees"), admin, admin
        );
        NoYieldTestAdapter lending = new NoYieldTestAdapter(address(usdc), address(rmUsdc));
        MorphoAdapter morpho = new MorphoAdapter(
            address(new MockMorphoVault(address(usdc))), address(usdc), address(rmUsdc)
        );
        MockVault second = new MockVault(address(usdc));
        uint256 cap = 10e6;

        vm.startPrank(admin);
        rmUsdc.setAdapterAllowed(address(lending), true);
        rmUsdc.setAdapterCodeHashAllowed(address(lending).codehash, true);
        rmUsdc.addAdapter(address(lending), 10_000);
        rmUsdc.setAdapterAllowed(address(morpho), true);
        rmUsdc.setAdapterCodeHashAllowed(address(morpho).codehash, true);
        rmUsdc.addAdapter(address(morpho), 10_000);
        rmUsdc.setAdapterMaxExposure(1, cap);
        address[] memory vaults = new address[](2);
        vaults[0] = address(rmUsdc);
        vaults[1] = address(second);
        for (uint256 i = 0; i < 2; i++) {
            reg.registerVault(
                vaults[i],
                VaultRegistry.VaultMetadata({name: "leg", asset: address(usdc), registeredAt: 0})
            );
            reg.setRouterEligible(vaults[i], true);
        }
        uint256[] memory bps = new uint256[](2);
        bps[0] = 9_500;
        bps[1] = 500;
        r.setWeights(vaults, bps);
        vm.stopPrank();

        uint256 amount = 1_000e6;
        PortfolioRouter.LegPreview[] memory legs = r.previewDeposit(amount);
        assertFalse(legs[0].unavailable, "rmUSDC previews available");
        assertEq(legs[0].legAmount, 950e6, "rmUSDC takes 95 percent");

        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(r), amount);
        uint256[] memory shares = r.deposit(amount, new uint256[](0));
        vm.stopPrank();
        assertGt(shares[0], 0, "the rmUSDC leg deposits");
        assertEq(shares[1], 50e6, "the second leg deposits");
        assertEq(morpho.totalAssets(), cap, "Morpho stops at its exposure cap");
        assertEq(lending.totalAssets(), 950e6 - cap, "the other adapter takes the rest");
        assertEq(rmUsdc.totalAssets(), 950e6, "the whole leg is in rmUSDC NAV");
        assertEq(usdc.balanceOf(address(r)), 0, "router holds no USDC");
    }

    // ─── Security round 2: venue refusal and floors on skipped legs ────────────────────

    /// @dev A two-leg router over `rmUsdc` (9500 bps) and a 1:1 vault (500 bps), the production vector's shape.
    function _rmUsdcLegRouter(RobotMoneyVault rmUsdc)
        internal
        returns (PortfolioRouter r, MockVault second)
    {
        VaultRegistry reg = CoreProxies.vaultRegistry(admin);
        r = CoreProxies.portfolioRouter(address(usdc), address(reg), admin);
        second = new MockVault(address(usdc));
        address[] memory vaults = new address[](2);
        vaults[0] = address(rmUsdc);
        vaults[1] = address(second);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 9_500;
        bps[1] = 500;
        vm.startPrank(admin);
        for (uint256 i = 0; i < 2; i++) {
            reg.registerVault(
                vaults[i],
                VaultRegistry.VaultMetadata({name: "leg", asset: address(usdc), registeredAt: 0})
            );
            reg.setRouterEligible(vaults[i], true);
        }
        r.setWeights(vaults, bps);
        vm.stopPrank();
    }

    /// @dev Allow and add `set` to `rmUsdc`, each at a 100 percent `capBps`.
    function _addAdapters(RobotMoneyVault rmUsdc, address[3] memory set) internal {
        vm.startPrank(admin);
        for (uint256 i = 0; i < set.length; i++) {
            rmUsdc.setAdapterAllowed(set[i], true);
            rmUsdc.setAdapterCodeHashAllowed(set[i].codehash, true);
            rmUsdc.addAdapter(set[i], 10_000);
        }
        vm.stopPrank();
    }

    function _rmUsdc(uint256 tvlCap) internal returns (RobotMoneyVault) {
        return CoreProxies.robotMoneyVault(
            IERC20(address(usdc)), tvlCap, tvlCap, 0, makeAddr("fees"), admin, admin
        );
    }

    /// @notice Security round 2. rmUSDC's Aave reserve sits at its supply cap and every MetaMorpho market cap is full, so
    ///         both venues refuse a supply while rmUSDC's `maxDeposit` and `previewDeposit` stay open. The routed deposit
    ///         succeeds: the Aave and Morpho adapters hand their slices back, and the vault places them in the third adapter.
    ///         Before the fix the Aave adapter's `deploy` reverted "51" (`SUPPLY_CAP_EXCEEDED`), rmUSDC's deposit reverted,
    ///         and the whole routed deposit reverted `UsdcLegTransferFailed(rmUSDC)`, the 500 bps leg included.
    function test_RTR5_rmUsdcLegWithFullLendingVenuesStillDeposits() public {
        RobotMoneyVault rmUsdc = _rmUsdc(1_000_000e6);
        TestERC20 aToken = new TestERC20();
        AaveV3Adapter aave = new AaveV3Adapter(
            address(new CappedAavePool(address(usdc), address(aToken), 0)),
            address(usdc),
            address(aToken),
            address(rmUsdc)
        );
        NoYieldTestAdapter lending = new NoYieldTestAdapter(address(usdc), address(rmUsdc));
        MorphoAdapter morpho = new MorphoAdapter(
            address(new CappedMetaMorpho(address(usdc), 0)), address(usdc), address(rmUsdc)
        );
        _addAdapters(rmUsdc, [address(aave), address(lending), address(morpho)]);
        (PortfolioRouter r,) = _rmUsdcLegRouter(rmUsdc);

        uint256 amount = 1_000e6;
        PortfolioRouter.LegPreview[] memory legs = r.previewDeposit(amount);
        assertFalse(legs[0].unavailable, "rmUSDC previews available");
        assertEq(legs[0].legAmount, 950e6, "rmUSDC takes 95 percent");

        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(r), amount);
        uint256[] memory shares = r.deposit(amount, new uint256[](0));
        vm.stopPrank();
        assertGt(shares[0], 0, "the rmUSDC leg deposits");
        assertEq(shares[1], 50e6, "the second leg deposits");
        assertEq(aave.totalAssets(), 0, "the full Aave reserve took nothing");
        assertEq(morpho.totalAssets(), 0, "the full MetaMorpho took nothing");
        assertEq(lending.totalAssets(), 950e6, "the open venue takes the whole leg");
        assertEq(rmUsdc.totalAssets(), 950e6, "the whole leg is in rmUSDC NAV");
        assertEq(usdc.balanceOf(address(r)), 0, "router holds no USDC");
    }

    /// @notice Security round 3. rmUSDC's Aave reserve is paused: supply and withdraw both revert while the aToken balance
    ///         still counts in rmUSDC NAV. rmUSDC's `maxDeposit` reads 0, so the router previews the leg unavailable and the
    ///         routed deposit puts the whole amount on the live leg. No rmUSDC share is minted at a NAV that counts the stuck
    ///         balance and no USDC lands idle in rmUSDC to pay an exit at par. Before the fix the Aave adapter handed its slice
    ///         back, and rmUSDC minted at that NAV and kept the slice idle.
    function test_RTR5_rmUsdcLegWithPausedLendingVenueIsSkipped() public {
        RobotMoneyVault rmUsdc = _rmUsdc(1_000_000e6);
        TestERC20 aToken = new TestERC20();
        CappedAavePool pool = new CappedAavePool(address(usdc), address(aToken), type(uint128).max);
        AaveV3Adapter aave =
            new AaveV3Adapter(address(pool), address(usdc), address(aToken), address(rmUsdc));
        NoYieldTestAdapter lending = new NoYieldTestAdapter(address(usdc), address(rmUsdc));
        MorphoAdapter morpho = new MorphoAdapter(
            address(new CappedMetaMorpho(address(usdc), type(uint128).max)),
            address(usdc),
            address(rmUsdc)
        );
        _addAdapters(rmUsdc, [address(aave), address(lending), address(morpho)]);
        (PortfolioRouter r,) = _rmUsdcLegRouter(rmUsdc);

        usdc.mint(depositor, 900e6);
        vm.startPrank(depositor);
        usdc.approve(address(rmUsdc), 900e6);
        rmUsdc.deposit(900e6, depositor);
        vm.stopPrank();
        assertGt(aave.totalAssets(), 0, "Aave holds its slice");
        uint256 rmSupply = rmUsdc.totalSupply();

        pool.setPaused(true);
        assertEq(rmUsdc.maxDeposit(address(r)), 0, "rmUSDC closes deposits");
        uint256 amount = 1_000e6;
        PortfolioRouter.LegPreview[] memory legs = r.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "rmUSDC previews unavailable");
        assertEq(legs[1].legAmount, amount, "the live leg takes the whole amount");

        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(r), amount);
        uint256[] memory shares = r.deposit(amount, new uint256[](0));
        vm.stopPrank();
        assertEq(shares[0], 0, "no rmUSDC share is minted");
        assertEq(shares[1], amount, "the live leg is funded with the whole amount");
        assertEq(rmUsdc.totalSupply(), rmSupply, "rmUSDC supply is unchanged");
        assertEq(usdc.balanceOf(address(rmUsdc)), 0, "no USDC lands idle in rmUSDC");
        assertEq(rmUsdc.totalAssets(), 900e6, "rmUSDC NAV is unchanged");
        assertEq(usdc.balanceOf(address(r)), 0, "router holds no USDC");
    }

    /// @notice Security round 2. A depositor previews a 50 USDC routed deposit with both legs available and signs a floor on
    ///         each. Before it lands, another deposit fills rmUSDC to its TVL cap, so rmUSDC's `maxDeposit` reads 0 and the
    ///         router would skip the leg. The deposit reverts `LegSkippedWithFloor(rmUSDC)`: a non-zero floor means "fund
    ///         this leg". Before the fix the router skipped it silently, waived its floor and put all 50 USDC into the 500 bps
    ///         leg, whose floor was sized for 2.5 USDC. A caller who previews again sees the leg unavailable, passes 0 for it,
    ///         and the deposit renormalises onto the live leg.
    function test_RTR5_flooredLegThatTurnsUnavailableReverts() public {
        RobotMoneyVault rmUsdc = _rmUsdc(1_000e6);
        NoYieldTestAdapter lending = new NoYieldTestAdapter(address(usdc), address(rmUsdc));
        vm.startPrank(admin);
        rmUsdc.setAdapterAllowed(address(lending), true);
        rmUsdc.setAdapterCodeHashAllowed(address(lending).codehash, true);
        rmUsdc.addAdapter(address(lending), 10_000);
        vm.stopPrank();
        (PortfolioRouter r,) = _rmUsdcLegRouter(rmUsdc);

        uint256 amount = 50e6;
        PortfolioRouter.LegPreview[] memory legs = r.previewDeposit(amount);
        uint256[] memory floors = new uint256[](2);
        for (uint256 i = 0; i < 2; i++) {
            assertFalse(legs[i].unavailable, "both legs preview available");
            floors[i] = legs[i].estShares;
        }
        assertEq(legs[1].legAmount, 2.5e6, "the second leg is sized for 2.5 USDC");

        // Another deposit fills rmUSDC to its TVL cap before the routed deposit lands.
        address filler = makeAddr("filler");
        usdc.mint(filler, 1_000e6);
        vm.startPrank(filler);
        usdc.approve(address(rmUsdc), 1_000e6);
        rmUsdc.deposit(rmUsdc.maxDeposit(filler), filler);
        vm.stopPrank();
        assertEq(rmUsdc.maxDeposit(address(r)), 0, "rmUSDC is at its TVL cap");

        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(r), amount);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.LegSkippedWithFloor.selector, address(rmUsdc))
        );
        r.deposit(amount, floors);
        vm.stopPrank();

        legs = r.previewDeposit(amount);
        assertTrue(legs[0].unavailable, "a fresh preview shows rmUSDC unavailable");
        assertEq(legs[1].legAmount, amount, "and the live leg taking the whole amount");
        floors[0] = 0;
        floors[1] = legs[1].estShares;
        vm.prank(depositor);
        uint256[] memory shares = r.deposit(amount, floors);
        assertEq(shares[0], 0, "a 0 floor lets the router skip the unavailable leg");
        assertEq(shares[1], amount, "the live leg is funded with the renormalised amount");
        assertEq(usdc.balanceOf(address(r)), 0, "router holds no USDC");
    }
}
