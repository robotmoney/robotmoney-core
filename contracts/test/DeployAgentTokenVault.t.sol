// SPDX-License-Identifier: MIT
// Canonical: the one-deployment-scheme plan, core S4 (issues 1486, 1491)
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";

import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
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
}

/// @notice rmAGENT script: empty, paused and registered at launch. The same script adds an asset
///         from one config entry (adapter deployed, code hash allowed, `addAsset` called).
contract DeployAgentTokenVaultTest is BasketDeployFixture {
    using stdJson for string;

    DeployAgentTokenVault internal script;

    function setUp() public {
        _fixtureSetUp();
        script = new DeployAgentTokenVault();
    }

    function _launchConfig() internal view returns (string memory) {
        return vm.readFile("config/agent-token-shortlist.json");
    }

    /// @dev Runs the SHIPPED config file through the script's parser, with no substitute body.
    ///      The test points SWAP_ROUTER at the file's own swapRouter02 value.
    function _runLaunch() internal returns (BasketVaultDeployBase.Deployed memory) {
        string memory json = _launchConfig();
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        return script.runInProcess(p, json);
    }

    /// @notice The shipped rmAGENT config carries swapRouter02 and an empty shortlist, so the
    ///         script's parser accepts it (review defect: it used to revert on a missing key).
    function test_shippedConfig_parsesThroughTheScriptParser() public {
        AgentDeployHarness h = new AgentDeployHarness();
        BasketVaultDeployBase.Cfg memory cfg = h.parse(_launchConfig());
        assertEq(cfg.swapRouter02, 0x2626664c2603336E57B271c5C0b26F421741e481);
        assertEq(cfg.assets.length, 0);
    }

    // ─── Launch path ──────────────────────────────────────────────────────────

    function test_launchConfigShortlistIsEmpty() public view {
        string[] memory symbols;
        string memory j = _launchConfig();
        assertEq(abi.decode(j.parseRaw(".shortlist"), (address[])).length, 0);
        symbols; // silence
    }

    function test_deploy_isRegisteredPausedAndEmpty() public {
        BasketVaultDeployBase.Deployed memory d = _runLaunch();
        AgentTokenVault v = AgentTokenVault(d.vault);
        assertTrue(v.paused(), "paused");
        assertEq(v.assetCount(), 0, "zero assets");
        assertEq(d.tokens.length, 0, "result lists no tokens");
        assertEq(d.adapter, address(0), "no adapter deployed for an empty list");
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

    function test_manifest_hasEmptyAssetList() public {
        BasketVaultDeployBase.Deployed memory d = _runLaunch();
        AgentDeployHarness h = new AgentDeployHarness();
        string memory json = _launchConfig();
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
        assertTrue(v.paused(), "still paused");
    }

    function test_reverts_whenSwapRouterIsNotSwapRouter02() public {
        string memory json =
            string.concat('{"swapRouter02":"', vm.toString(router02), '","shortlist":[]}');
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = makeAddr("other");
        vm.expectRevert(bytes("SWAP_ROUTER is not SwapRouter02"));
        script.runInProcess(p, json);
    }
}
