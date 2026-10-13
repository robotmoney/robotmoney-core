// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S4 (issues 1486, 1491)
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";

import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {UniswapV3SwapAdapter} from "../adapters/UniswapV3SwapAdapter.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";
import {BasketDeployFixture} from "./helpers/BasketDeployFixture.sol";
import {MockV4PoolManager} from "./helpers/MockV4PoolManager.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {claimTmpPath, releaseTmpPath} from "./helpers/TmpPaths.sol";

contract AgentDeployHarness is DeployAgentTokenVault {
    function writeManifestTo(string memory path, Deployed memory d, string memory json) external {
        _writeManifestTo(path, d, _parseCfg(json, "shortlist"));
    }

    function parse(string memory json) external view returns (Cfg memory) {
        return _parseCfg(json, "shortlist");
    }

    function manifestPath() external view returns (string memory) {
        return _manifestPath();
    }

    function readPrefixed(string memory prefix) external view returns (Params memory) {
        return _readParamsFrom(prefix);
    }
}

/// @notice rmAGENT script: paused and registered at launch, holding RM on the shipped config
///         (an empty list is also supported). The same script adds an asset
///         from one config entry (adapter deployed, code hash allowed, `addAsset` called).
contract DeployAgentTokenVaultTest is BasketDeployFixture {
    using stdJson for string;

    DeployAgentTokenVault internal script;
    address internal constant RM_TOKEN = 0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3;

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant PM_ADDR = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    bytes32 internal constant RM_POOL_ID =
        0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391;
    string internal constant SHIPPED = "config/agent-token-shortlist.json";

    UniswapV4PriceRecorder internal recorder;

    function setUp() public {
        _fixtureSetUp();
        script = new DeployAgentTokenVault();
        // The shipped RM pool key pairs RM with the real Base USDC address, so the test USDC lives there.
        vm.etch(BASE_USDC, address(new TestERC20()).code);
        usdc = TestERC20(BASE_USDC);
    }

    /// @dev The V4 world the shipped config names: a PoolManager double etched at the real PoolManager address with the RM/USDC pool
    ///      initialised (liquidity 1e18, tick -100), RM and USDC code at their real addresses, and a recorder for the shipped key
    ///      warmed to a full 1800 s window (901 slots, 32 records a minute apart) so `addAsset` accepts it.
    function _v4World() internal {
        vm.warp(1_700_000_000);
        vm.etch(PM_ADDR, address(new MockV4PoolManager()).code);
        vm.etch(RM_TOKEN, address(new TestERC20()).code);
        IPoolManagerV4.PoolKey memory k =
            IPoolManagerV4.PoolKey(RM_TOKEN, BASE_USDC, 29100, 582, address(0));
        MockV4PoolManager(PM_ADDR).initializePool(k, -100, 1e18);
        recorder = new UniswapV4PriceRecorder(PM_ADDR, RM_TOKEN, BASE_USDC, 29100, 582, address(0));
        _warm(recorder);
    }

    function _warm(UniswapV4PriceRecorder r) internal {
        r.grow(901);
        for (uint256 i = 0; i < 32; i++) {
            vm.warp(block.timestamp + 60);
            r.record();
        }
    }

    function _launchConfig() internal view returns (string memory) {
        return vm.readFile("config/agent-token-shortlist.json");
    }

    /// @dev The shipped file's router with no assets, for the paused-and-empty deploy path.
    function _runEmpty() internal returns (BasketVaultDeployBase.Deployed memory) {
        string memory json = _emptyConfig();
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        return script.runInProcess(p, json);
    }

    function _emptyConfig() internal view returns (string memory) {
        return string.concat(
            '{"swapRouter02":"', vm.toString(_configRouter(_launchConfig())), '","shortlist":[]}'
        );
    }

    /// @dev Runs the SHIPPED config (RM on the V4 pool) through the script with the recorder from `_v4World`.
    function _runLaunch() internal returns (BasketVaultDeployBase.Deployed memory) {
        _v4World();
        string memory json = vm.readFile(SHIPPED);
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        p.recorder = address(recorder);
        return script.runInProcess(p, json);
    }

    /// @notice The shipped rmAGENT config parses: RM on UniswapV4 with the full PoolKey (fee 29100, tickSpacing 582, hooks 0x0).
    function test_shippedConfig_parsesThroughTheScriptParser() public {
        AgentDeployHarness h = new AgentDeployHarness();
        BasketVaultDeployBase.Cfg memory cfg = h.parse(_launchConfig());
        assertEq(cfg.swapRouter02, 0x2626664c2603336E57B271c5C0b26F421741e481);
        assertEq(cfg.maxSlippageBps, 500, "the V4 pool fee needs the 500 bps ceiling");
        assertEq(cfg.assets.length, 1);
        BasketVaultDeployBase.AssetCfg memory a = cfg.assets[0];
        assertEq(a.symbol, "RM");
        assertEq(a.token, RM_TOKEN);
        assertTrue(a.isV4, "RM is a UniswapV4 asset");
        assertEq(a.pool, address(0), "no V3 pool");
        assertEq(a.poolFee, 29100);
        assertEq(a.poolManager, PM_ADDR);
        assertEq(a.poolId, RM_POOL_ID);
        assertEq(a.key.currency0, RM_TOKEN);
        assertEq(a.key.currency1, BASE_USDC);
        assertEq(a.key.fee, 29100);
        assertEq(int256(a.key.tickSpacing), int256(582));
        assertEq(a.key.hooks, address(0));
        assertEq(keccak256(abi.encode(a.key)), RM_POOL_ID, "the key hashes to the pool id");
    }

    /// @notice Owner decision 2026-10-08: RM on the V3 pool is refused.
    function test_config_rmOnUniswapV3IsRefused() public {
        AgentDeployHarness h = new AgentDeployHarness();
        string memory v3 = string.concat(
            '{"swapRouter02":"0x2626664c2603336E57B271c5C0b26F421741e481","shortlist":[{"symbol":"RM","token":"',
            vm.toString(RM_TOKEN),
            '","venue":"UniswapV3","pool":"0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882","poolFee":10000}]}'
        );
        vm.expectRevert(bytes("RM: venue must be UniswapV4"));
        h.parse(v3);
    }

    /// @notice A V3 entry for a token other than RM still parses (adding a token later is one config entry).
    function test_config_aV3EntryForAnotherTokenStillParses() public {
        AgentDeployHarness h = new AgentDeployHarness();
        string memory v3 = string.concat(
            '{"swapRouter02":"0x2626664c2603336E57B271c5C0b26F421741e481","shortlist":[{"symbol":"X","token":"',
            vm.toString(address(0xBEEF)),
            '","venue":"UniswapV3","pool":"0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882","poolFee":500}]}'
        );
        BasketVaultDeployBase.Cfg memory cfg = h.parse(v3);
        assertFalse(cfg.assets[0].isV4);
        assertEq(cfg.assets[0].poolFee, 500);
    }

    function _shippedWith(string memory from, string memory to)
        internal
        view
        returns (string memory)
    {
        return vm.replace(_launchConfig(), from, to);
    }

    function test_config_aPoolIdThatTheKeyDoesNotHashToIsRefused() public {
        AgentDeployHarness h = new AgentDeployHarness();
        string memory bad = _shippedWith(
            "0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391",
            "0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252392"
        );
        vm.expectRevert(bytes("config poolKey does not hash to poolId"));
        h.parse(bad);
    }

    function test_config_aTickSpacingFromAStandardTableIsRefusedByTheHash() public {
        AgentDeployHarness h = new AgentDeployHarness();
        // the V3-style standard spacing for a 1 percent tier would be 200, not this pool's 582
        string memory bad = _shippedWith('"tickSpacing": 582', '"tickSpacing": 200');
        vm.expectRevert(bytes("config poolKey does not hash to poolId"));
        h.parse(bad);
    }

    function test_config_aNonZeroHooksAddressIsRefused() public {
        AgentDeployHarness h = new AgentDeployHarness();
        string memory bad = _shippedWith(
            '"hooks": "0x0000000000000000000000000000000000000000"',
            '"hooks": "0x0000000000000000000000000000000000000001"'
        );
        vm.expectRevert(bytes("config poolKey hooks must be zero"));
        h.parse(bad);
    }

    function test_config_aFeeThatDiffersFromPoolFeeIsRefused() public {
        AgentDeployHarness h = new AgentDeployHarness();
        string memory bad = _shippedWith('"poolFee": 29100', '"poolFee": 10000');
        vm.expectRevert(bytes("config poolKey fee does not equal poolFee"));
        h.parse(bad);
    }

    function test_config_anUnknownVenueIsRefused() public {
        AgentDeployHarness h = new AgentDeployHarness();
        string memory bad = _shippedWith('"venue": "UniswapV4"', '"venue": "Curve"');
        vm.expectRevert(bytes("RM: venue must be UniswapV4"));
        h.parse(bad);
    }

    // ─── Launch path ──────────────────────────────────────────────────────────

    function test_launchConfigShortlistIsRmOnly() public view {
        string memory j = _launchConfig();
        assertEq(j.readString(".shortlist[0].symbol"), "RM");
        assertFalse(vm.keyExistsJson(j, ".shortlist[1]"), "RM only");
    }

    /// @notice The shipped launch config deploys rmAGENT holding RM, registered and paused.
    function test_deploy_addsRmAndRegistersPaused() public {
        BasketVaultDeployBase.Deployed memory d = _runLaunch();
        AgentTokenVault v = AgentTokenVault(d.vault);
        assertTrue(v.depositsPaused(), "paused");
        assertEq(v.assetCount(), 1, "RM is the one asset");
        (
            address t,
            address pool,
            uint24 fee,
            bool active,
            address adapter,
            BasketVault.Venue venue
        ) = v.assets(0);
        assertEq(t, RM_TOKEN, "asset is RM");
        assertEq(pool, address(recorder), "the registered pool is the price recorder");
        assertEq(uint256(fee), 29100, "fee 29100");
        assertTrue(active, "active");
        assertEq(uint256(venue), uint256(BasketVault.Venue.V4), "venue V4");
        assertTrue(adapter != address(0), "adapter deployed");
        assertEq(adapter, d.adapterV4, "the V4 adapter is the asset adapter");
        assertEq(d.adapter, address(0), "a vault whose assets are all V4 deploys no V3 adapter");
        assertEq(d.recorder, address(recorder));
        assertEq(address(UniswapV4SwapAdapter(adapter).RECORDER()), address(recorder));
        assertEq(address(UniswapV4SwapAdapter(adapter).POOL_MANAGER()), PM_ADDR);
        assertEq(UniswapV4SwapAdapter(adapter).POOL_ID(), RM_POOL_ID);
        assertTrue(v.adapterCodeHashAllowed(adapter.codehash), "codehash allowlisted by the script");
        assertEq(v.maxSlippageBps(), 500, "slippage bound raised for the 2.91 percent pool");
        assertEq(d.tokens.length, 1, "result lists RM");
        address[] memory listed = registry.listVaults();
        assertEq(listed.length, 1, "registered once");
        assertEq(listed[0], d.vault);
        (VaultRegistry.VaultMetadata memory meta,) = registry.getVault(d.vault);
        assertEq(meta.name, "Robot Money Agent Tokens");
        assertFalse(registry.isRouterEligible(d.vault));
    }

    function test_deploy_depositRevertsWhilePaused() public {
        BasketVaultDeployBase.Deployed memory d = _runLaunch();
        AgentTokenVault v = AgentTokenVault(d.vault);
        address alice = makeAddr("alice");
        usdc.mint(alice, 100e6);
        vm.startPrank(alice);
        usdc.approve(d.vault, 100e6);
        vm.expectRevert();
        v.deposit(100e6, alice);
        vm.stopPrank();
    }

    function test_deploy_deployerHoldsEmergencyUntilHandover() public {
        BasketVaultDeployBase.Deployed memory d = _runLaunch();
        AgentTokenVault v = AgentTokenVault(d.vault);
        assertTrue(v.hasRole(v.EMERGENCY_ROLE(), deployer));
        assertTrue(v.hasRole(v.ADMIN_ROLE(), deployer));
    }

    /// @notice An empty shortlist still deploys a paused, empty vault.
    function test_emptyShortlist_deploysPausedAndEmpty() public {
        BasketVaultDeployBase.Deployed memory d = _runEmpty();
        AgentTokenVault v = AgentTokenVault(d.vault);
        assertTrue(v.depositsPaused(), "paused");
        assertEq(v.assetCount(), 0, "zero assets");
        assertEq(d.recorder, address(0), "no recorder for an empty list");
        assertEq(d.adapter, address(0), "no adapter for an empty list");
    }

    function test_manifest_hasEmptyAssetList() public {
        BasketVaultDeployBase.Deployed memory d = _runEmpty();
        AgentDeployHarness h = new AgentDeployHarness();
        string memory json = _emptyConfig();
        string memory path = claimTmpPath(vm, "agent-vault-manifest");
        h.writeManifestTo(path, d, json);
        string memory out = vm.readFile(path);
        releaseTmpPath(vm, path);
        assertEq(out.readAddress(".vault"), d.vault);
        assertTrue(out.readBool(".paused"));
        assertTrue(vm.keyExistsJson(out, ".assets"), "assets key present");
        assertFalse(vm.keyExistsJson(out, ".assets[0]"), "empty asset list");
    }

    /// @notice DEPLOYMENT_OUT is required: an unset variable reverts, there is no default path.
    function test_manifest_deploymentOutIsRequired() public {
        AgentDeployHarness h = new AgentDeployHarness();
        vm.expectRevert(bytes("DEPLOYMENT_OUT must be set"));
        h.manifestPath();
    }

    // ─── Adding an asset later is one config entry ────────────────────────────

    function test_oneConfigEntryAddsAnAssetThroughTheAdapterPath() public {
        (address token, address pool) = _tokenAndPool("agentToken");
        address[] memory tokens = new address[](1);
        address[] memory pools = new address[](1);
        tokens[0] = token;
        pools[0] = pool;
        BasketVaultDeployBase.Deployed memory d =
            script.runInProcess(_params(), _json("shortlist", tokens, pools, 500));

        AgentTokenVault v = AgentTokenVault(d.vault);
        assertEq(v.assetCount(), 1);
        (address t,, uint24 fee, bool active, address adapter,) = v.assets(0);
        assertEq(t, token);
        assertEq(uint256(fee), 500);
        assertTrue(active);
        assertTrue(adapter != address(0), "adapter deployed");
        assertEq(adapter, d.adapter);
        assertTrue(v.adapterCodeHashAllowed(adapter.codehash), "code hash allowed");
        assertEq(address(UniswapV3SwapAdapter(adapter).ROUTER()), router02);
        assertTrue(v.depositsPaused(), "still paused");
    }

    function test_reverts_whenSwapRouterIsNotSwapRouter02() public {
        string memory json =
            string.concat('{"swapRouter02":"', vm.toString(router02), '","shortlist":[]}');
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = makeAddr("other");
        vm.expectRevert(bytes("SWAP_ROUTER is not SwapRouter02"));
        script.runInProcess(p, json);
    }

    // ─── Issue 1666: the NAV deviation guard and the pool floor come from the sheet ──

    function _prepare(BasketVaultDeployBase.Params memory p) internal returns (string memory json) {
        _v4World();
        json = vm.readFile(SHIPPED);
        p.swapRouter = _configRouter(json);
        p.recorder = address(recorder);
    }

    function _deployWith(BasketVaultDeployBase.Params memory p)
        internal
        returns (BasketVaultDeployBase.Deployed memory)
    {
        return script.runInProcess(p, _prepare(p));
    }

    /// @notice The vault ships with the sheet guard, not the vault default of 0 (which disables ORA-4).
    function test_guard_navDeviationGuardBpsEqualsTheSheetValue() public {
        BasketVaultDeployBase.Deployed memory d = _deployWith(_params());
        assertEq(
            BasketVault(d.vault).navDeviationGuardBps(), NAV_DEVIATION_BPS, "guard from the sheet"
        );
        assertGt(BasketVault(d.vault).navDeviationGuardBps(), 0, "guard above zero");
    }

    function test_guard_acceptsTheCeiling() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.navDeviationGuardBps = 2000;
        BasketVaultDeployBase.Deployed memory d = _deployWith(p);
        assertEq(BasketVault(d.vault).navDeviationGuardBps(), 2000);
    }

    function test_reverts_whenNavDeviationBpsUnset() public {
        string memory prefix = "D1666AGENT_";
        AgentDeployHarness h = new AgentDeployHarness();
        _setSheetEnv(prefix, "NAV_DEVIATION_BPS");
        vm.expectRevert(bytes(string.concat(prefix, "NAV_DEVIATION_BPS must be set")));
        h.readPrefixed(prefix);
    }

    function test_reverts_whenNavDeviationBpsZero() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.navDeviationGuardBps = 0;
        string memory json = _prepare(p);
        vm.expectRevert(bytes("NAV_DEVIATION_BPS must be 1..2000"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenNavDeviationBpsAboveCeiling() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.navDeviationGuardBps = 2001;
        string memory json = _prepare(p);
        vm.expectRevert(bytes("NAV_DEVIATION_BPS must be 1..2000"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenMinPoolLiquidityUnset() public {
        string memory prefix = "D1666LAGENT_";
        AgentDeployHarness h = new AgentDeployHarness();
        _setSheetEnv(prefix, "MIN_POOL_LIQUIDITY");
        vm.expectRevert(bytes(string.concat(prefix, "MIN_POOL_LIQUIDITY must be set")));
        h.readPrefixed(prefix);
    }

    function test_reverts_whenMinPoolLiquidityZero() public {
        BasketVaultDeployBase.Params memory p = _params();
        p.minPoolLiquidity = 0;
        string memory json = _prepare(p);
        vm.expectRevert(bytes("MIN_POOL_LIQUIDITY missing from the sheet"));
        script.runInProcess(p, json);
    }

    // ─── Issue 1676: the V4 asset path ──────────────────────────────────────

    function test_v4_reverts_whenRecorderAddressIsMissing() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        p.recorder = address(0);
        vm.expectRevert(bytes("RECORDER_ADDRESS is required for a UniswapV4 asset"));
        script.runInProcess(p, json);
    }

    function test_v4_reverts_whenTheRecorderIsForAnotherPool() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        // a recorder for the same tokens at another fee reads another pool id
        IPoolManagerV4.PoolKey memory k =
            IPoolManagerV4.PoolKey(RM_TOKEN, BASE_USDC, 10_000, 200, address(0));
        MockV4PoolManager(PM_ADDR).initializePool(k, -100, 1e18);
        UniswapV4PriceRecorder other =
            new UniswapV4PriceRecorder(PM_ADDR, RM_TOKEN, BASE_USDC, 10_000, 200, address(0));
        p.recorder = address(other);
        vm.expectRevert(bytes("RM: recorder pool id differs from config"));
        script.runInProcess(p, json);
    }

    function test_v4_reverts_whenTheRecorderIsOnAnotherPoolManager() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        MockV4PoolManager pm2 = new MockV4PoolManager();
        pm2.initializePool(
            IPoolManagerV4.PoolKey(RM_TOKEN, BASE_USDC, 29100, 582, address(0)), -100, 1e18
        );
        UniswapV4PriceRecorder other =
            new UniswapV4PriceRecorder(address(pm2), RM_TOKEN, BASE_USDC, 29100, 582, address(0));
        p.recorder = address(other);
        vm.expectRevert(bytes("RM: recorder PoolManager differs from config"));
        script.runInProcess(p, json);
    }

    function test_v4_reverts_whenPoolLiquidityIsBelowTheSheetFloor() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        MockV4PoolManager(PM_ADDR).setLiquidity(RM_POOL_ID, uint128(p.minPoolLiquidity - 1));
        vm.expectRevert(bytes("RM: pool liquidity is below MIN_POOL_LIQUIDITY"));
        script.runInProcess(p, json);
    }

    function test_v4_succeeds_whenPoolLiquidityEqualsTheSheetFloor() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        MockV4PoolManager(PM_ADDR).setLiquidity(RM_POOL_ID, uint128(p.minPoolLiquidity));
        BasketVaultDeployBase.Deployed memory d = script.runInProcess(p, json);
        assertEq(d.tokens.length, 1);
    }

    function test_v4_reverts_whenThePoolIsNotInitialised() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        // clear slot0 of the pool state
        vm.store(PM_ADDR, keccak256(abi.encode(RM_POOL_ID, uint256(6))), bytes32(0));
        vm.expectRevert(bytes("RM: V4 pool is not initialized"));
        script.runInProcess(p, json);
    }

    /// @notice A cold recorder (fewer than 901 slots or under 1800 s of history) fails `addAsset`; the script does not mask it.
    function test_v4_reverts_whenTheRecorderRingIsTooSmall() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        UniswapV4PriceRecorder cold =
            new UniswapV4PriceRecorder(PM_ADDR, RM_TOKEN, BASE_USDC, 29100, 582, address(0));
        p.recorder = address(cold);
        vm.expectPartialRevert(BasketAssetConfigGuard.InsufficientPoolCardinality.selector);
        script.runInProcess(p, json);
    }

    function test_v4_reverts_whenTheRecorderHoldsLessThanOneWindowOfHistory() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        UniswapV4PriceRecorder young =
            new UniswapV4PriceRecorder(PM_ADDR, RM_TOKEN, BASE_USDC, 29100, 582, address(0));
        young.grow(901);
        vm.warp(block.timestamp + 60);
        young.record();
        p.recorder = address(young);
        vm.expectPartialRevert(BasketAssetConfigGuard.InsufficientObservationHistory.selector);
        script.runInProcess(p, json);
    }

    function test_v4_reverts_whenAPoolInTheConfigPairsNoUsdc() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        p.usdc = address(0xCAFE);
        vm.expectPartialRevert(UniswapV4SwapAdapter.PoolKeyDoesNotPairQuote.selector);
        script.runInProcess(p, json);
    }

    /// @notice The script pokes the recorder itself: a recorder nobody has recorded on for over one window (stale) still lets the stage run.
    function test_v4_theScriptPokesAStaleRecorderBeforeAddAsset() public {
        BasketVaultDeployBase.Params memory p = _params();
        string memory json = _prepare(p);
        vm.warp(block.timestamp + 5_000); // the warmed recorder is now stale
        assertFalse(recorder.isFresh());
        BasketVaultDeployBase.Deployed memory d = script.runInProcess(p, json);
        assertEq(d.tokens.length, 1);
        assertTrue(recorder.isFresh(), "the script recorded");
    }

    function test_v4_manifestNamesTheRecorderAndTheV4Adapter() public {
        BasketVaultDeployBase.Deployed memory d = _runLaunch();
        AgentDeployHarness h = new AgentDeployHarness();
        string memory path = claimTmpPath(vm, "agent-vault-v4-manifest");
        h.writeManifestTo(path, d, _launchConfig());
        string memory out = vm.readFile(path);
        releaseTmpPath(vm, path);
        assertEq(out.readAddress(".recorder"), address(recorder));
        assertEq(out.readAddress(".adapter_v4"), d.adapterV4);
        assertEq(out.readString(".assets[0].venue"), "UniswapV4");
        assertEq(
            out.readAddress(".assets[0].pool"),
            address(recorder),
            "the registered pool is the recorder"
        );
        assertEq(out.readBytes32(".assets[0].pool_id"), RM_POOL_ID);
    }
}
