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
import {BasketDeployFixture} from "./helpers/BasketDeployFixture.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

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

    function setUp() public {
        _fixtureSetUp();
        script = new DeployAgentTokenVault();
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

    /// @dev Runs the SHIPPED config (RM) through the script. A mock pool paired with this test's
    ///      USDC is etched at the shipped RM pool address, as the live pool is on Base.
    function _runLaunch() internal returns (BasketVaultDeployBase.Deployed memory) {
        string memory json = _etchConfigPools("config/agent-token-shortlist.json", "shortlist");
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        return script.runInProcess(p, json);
    }

    /// @notice The shipped rmAGENT config carries swapRouter02 and the RM entry, so the
    ///         script's parser accepts it (review defect: it used to revert on a missing key).
    function test_shippedConfig_parsesThroughTheScriptParser() public {
        AgentDeployHarness h = new AgentDeployHarness();
        BasketVaultDeployBase.Cfg memory cfg = h.parse(_launchConfig());
        assertEq(cfg.swapRouter02, 0x2626664c2603336E57B271c5C0b26F421741e481);
        assertEq(cfg.assets.length, 1);
        assertEq(cfg.assets[0].symbol, "RM");
        assertEq(cfg.assets[0].token, 0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3);
        assertEq(cfg.assets[0].pool, 0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882);
        assertEq(cfg.assets[0].poolFee, 10000);
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
        (address t,, uint24 fee, bool active, address adapter,) = v.assets(0);
        assertEq(t, 0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3, "asset is RM");
        assertEq(uint256(fee), 10000, "fee 10000");
        assertTrue(active, "active");
        assertTrue(adapter != address(0), "adapter deployed");
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
        assertEq(d.adapter, address(0), "no adapter for an empty list");
    }

    function test_manifest_hasEmptyAssetList() public {
        BasketVaultDeployBase.Deployed memory d = _runEmpty();
        AgentDeployHarness h = new AgentDeployHarness();
        string memory json = _emptyConfig();
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/test-agent-manifest.json");
        h.writeManifestTo(path, d, json);
        string memory out = vm.readFile(path);
        vm.removeFile(path);
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
        json = _etchConfigPools("config/agent-token-shortlist.json", "shortlist");
        p.swapRouter = _configRouter(json);
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
}
