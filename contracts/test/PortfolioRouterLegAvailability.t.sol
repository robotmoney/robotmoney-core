// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (RTR-5, ORA-4)
//            docs/architecture.md §4.2.1 — router deposit availability
// Covers QA plan v1 task D4 (findings CS-4 and E6): the router skips a leg the vault itself cannot take, and the rmAGENT
// guard sits above the RM pool fee band.
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
import {Proxied} from "./helpers/Proxied.sol";

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
        agent = Proxied.agentTokenVault(
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
        registry = Proxied.vaultRegistry(admin);
        router = Proxied.portfolioRouter(address(usdc), address(registry), admin);

        // Ring at the 901-slot floor and one full 1800 s window of history before `addAsset`.
        rec.grow(901);
        for (uint256 i = 0; i < 32; i++) {
            vm.warp(block.timestamp + 60);
            rec.record();
        }

        vm.startPrank(admin);
        agent.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        agent.addAsset(
            address(rm), address(rec), FEE, address(adapter), BasketAssetConfigGuard.Venue.V4
        );
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
        VaultRegistry reg = Proxied.vaultRegistry(admin);
        PortfolioRouter r = Proxied.portfolioRouter(address(usdc), address(reg), admin);
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

    // ─── ORA-4: the rmAGENT guard sits above the pool fee band ─────────────────

    /// @notice E6. Spot drifts about 2.5 percent from the recorded TWAP and nobody trades it back, because the drift is
    ///         inside the 2.91 percent fee band. At the old 100 bps sheet value the rmAGENT deposit reverts on ORA-4 and the
    ///         whole routed deposit reverts with it: ORA-4 is not an availability signal, since `previewDeposit` does not run
    ///         it. At the D10 value (400 bps) the same routed deposit funds both legs. The drift is on the side where RM is
    ///         cheaper at spot. On the other side the 500 bps swap bound (291 bps fee plus the drift) binds before the guard.
    function test_ORA4_idlePoolDriftInsideFeeBandDoesNotRevertRoutedDeposit() public {
        int24 drift = address(rm) == c0 ? -DRIFT_TICKS : DRIFT_TICKS;
        pm.setTick(poolId, drift);
        assertTrue(rec.isFresh(), "recorder fresh: the drift is not a staleness case");
        uint256 dev = TwapTickMath.deviationBps(
            address(rec),
            address(rm),
            address(usdc),
            agent.effectiveTwapWindow(address(rm)),
            agent.assetTokenValue(0, 1e6)
        );
        assertGt(dev, OLD_SHEET_NAV_DEVIATION_BPS, "drift is above the old 100 bps guard");
        assertLt(dev, uint256(FEE) / 100, "drift is inside the pool fee band");

        uint256 amount = 2 * LEG;
        vm.prank(admin);
        agent.setNavDeviationGuardBps(OLD_SHEET_NAV_DEVIATION_BPS);
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(amount);
        assertFalse(legs[0].unavailable, "ORA-4 is not an availability signal");
        usdc.mint(depositor, amount);
        vm.startPrank(depositor);
        usdc.approve(address(router), amount);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.UsdcLegTransferFailed.selector, address(agent))
        );
        router.deposit(amount, new uint256[](0));
        vm.stopPrank();
        usdc.burn(depositor, amount);

        vm.prank(admin);
        agent.setNavDeviationGuardBps(SHEET_NAV_DEVIATION_BPS);
        uint256[] memory shares = _routerDeposit(amount);
        assertGt(shares[0], 0, "rmAGENT leg funded under the drift");
        assertEq(shares[1], LEG, "the 1:1 leg is funded");
        assertGt(rm.balanceOf(address(agent)), 0, "the vault bought RM");
        assertEq(usdc.balanceOf(address(router)), 0, "router holds no USDC");
    }
}
