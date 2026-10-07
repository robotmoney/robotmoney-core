// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S4 (issues 1486, 1490)
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";

import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {BasketDeployFixture, ConstPool} from "./helpers/BasketDeployFixture.sol";

/// @dev Zero-implementation router. Vault constructors only store the router address.
contract StubSwapRouter is ISwapRouter {
    function exactInputSingle(ExactInputSingleParams calldata) external pure returns (uint256) {
        return 0;
    }
}

/// @dev Exposes the manifest writer so a test reads the file back without the process-wide env.
contract ProtocolDeployHarness is DeployProtocolAssetVault {
    function writeManifestTo(string memory path, Deployed memory d, string memory json) external {
        _writeManifestTo(path, d, _parseCfg(json, "assets"));
    }
}

/// @notice rmPROTO script: paused, exactly wETH and cbBTC, config read back equals the file,
///         registered, deployer holds EMERGENCY, and every sheet and venue input is enforced.
contract DeployProtocolAssetVaultTest is BasketDeployFixture {
    using stdJson for string;

    DeployProtocolAssetVault internal script;

    function setUp() public {
        _fixtureSetUp();
        script = new DeployProtocolAssetVault();
    }

    function _run(string memory json) internal returns (BasketVaultDeployBase.Deployed memory) {
        return script.runInProcess(_params(), json);
    }

    function _twoAssets() internal returns (string memory json, address[] memory tokens) {
        tokens = new address[](2);
        address[] memory pools = new address[](2);
        (tokens[0], pools[0]) = _tokenAndPool("weth");
        (tokens[1], pools[1]) = _tokenAndPool("cbbtc");
        json = _json("assets", tokens, pools, 500);
    }

    // ─── Config file: the real config/protocol-assets.json ───────────────────

    function test_deploy_pausedWithExactlyWethAndCbbtc_configReadBackEqualsFile() public {
        string memory json = _etchConfigPools("config/protocol-assets.json", "assets");
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        BasketVaultDeployBase.Deployed memory d = script.runInProcess(p, json);

        ProtocolAssetVault vault = ProtocolAssetVault(d.vault);
        assertTrue(vault.depositsPaused(), "vault must be paused");
        assertTrue(d.paused, "result reports paused");

        address[] memory cfgTokens = new address[](2);
        address[] memory cfgPools = new address[](2);
        uint256[] memory cfgFees = new uint256[](2);
        assertFalse(vm.keyExistsJson(json, ".assets[2]"), "config has exactly two assets");
        for (uint256 i = 0; i < 2; i++) {
            string memory b = string.concat(".assets[", vm.toString(i), "]");
            cfgTokens[i] = json.readAddress(string.concat(b, ".token"));
            cfgPools[i] = json.readAddress(string.concat(b, ".pool"));
            cfgFees[i] = json.readUint(string.concat(b, ".poolFee"));
        }
        assertEq(vault.assetCount(), 2, "vault has exactly two assets");
        for (uint256 i = 0; i < 2; i++) {
            (address token, address pool, uint24 fee, bool active, address adapter,) =
                vault.assets(i);
            assertEq(token, cfgTokens[i], "token equals config");
            assertEq(pool, cfgPools[i], "pool equals config");
            assertEq(uint256(fee), cfgFees[i], "fee equals config");
            assertTrue(active, "asset active");
            assertEq(adapter, address(0), "built-in SwapRouter02 path, no adapter");
        }
        // wETH then cbBTC, no wSOL.
        assertEq(json.readString(".assets[0].symbol"), "wETH");
        assertEq(json.readString(".assets[1].symbol"), "cbBTC");
        assertEq(address(vault.SWAP_ROUTER()), json.readAddress(".swapRouter02"));
    }

    // ─── Roles, registry, state ───────────────────────────────────────────────

    function test_deploy_deployerHoldsAdminAndEmergency() public {
        (string memory json,) = _twoAssets();
        BasketVaultDeployBase.Deployed memory d = _run(json);
        BasketVault v = BasketVault(d.vault);
        assertTrue(v.hasRole(v.ADMIN_ROLE(), deployer), "deployer holds ADMIN");
        assertTrue(v.hasRole(v.EMERGENCY_ROLE(), deployer), "deployer holds EMERGENCY");
        assertFalse(v.hasRole(v.ADMIN_ROLE(), address(script)), "script holds nothing");
    }

    function test_deploy_registersVaultAndDoesNotSetRouterEligible() public {
        (string memory json,) = _twoAssets();
        BasketVaultDeployBase.Deployed memory d = _run(json);
        assertTrue(d.registered, "registered flag");
        address[] memory listed = registry.listVaults();
        assertEq(listed.length, 1);
        assertEq(listed[0], d.vault);
        (VaultRegistry.VaultMetadata memory meta, VaultRegistry.VaultStatus status) =
            registry.getVault(d.vault);
        assertEq(meta.name, "Robot Money Protocol");
        assertEq(meta.asset, address(usdc));
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Active));
        assertFalse(registry.isRouterEligible(d.vault), "eligibility is the govern stage");
    }

    function test_deploy_capsComeFromTheSheetAndNoSeed() public {
        (string memory json,) = _twoAssets();
        BasketVaultDeployBase.Deployed memory d = _run(json);
        ProtocolAssetVault v = ProtocolAssetVault(d.vault);
        assertEq(v.tvlCap(), TVL_CAP);
        assertEq(v.perDepositCap(), PER_DEPOSIT_CAP);
        assertEq(v.totalSupply(), 0, "no seed deposit");
        assertEq(usdc.balanceOf(d.vault), 0, "no USDC in the vault");
    }

    function test_deploy_exactlyTheConfiguredAssets() public {
        (string memory json, address[] memory tokens) = _twoAssets();
        BasketVaultDeployBase.Deployed memory d = _run(json);
        assertEq(d.tokens.length, 2);
        assertEq(d.tokens[0], tokens[0]);
        assertEq(d.tokens[1], tokens[1]);
        (address[] memory listed,,,,) = ProtocolAssetVault(d.vault).shortlist();
        assertEq(listed.length, 2, "shortlist has no extra asset");
    }

    // ─── Reverts ──────────────────────────────────────────────────────────────

    function test_reverts_whenSwapRouterIsNotSwapRouter02() public {
        (string memory json,) = _twoAssets();
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = makeAddr("someOtherRouter");
        vm.expectRevert(bytes("SWAP_ROUTER is not SwapRouter02"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenTvlCapMissing() public {
        (string memory json,) = _twoAssets();
        BasketVaultDeployBase.Params memory p = _params();
        p.tvlCap = 0;
        vm.expectRevert(bytes("TVL_CAP missing from the sheet"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenPerDepositCapMissing() public {
        (string memory json,) = _twoAssets();
        BasketVaultDeployBase.Params memory p = _params();
        p.perDepositCap = 0;
        vm.expectRevert(bytes("PER_DEPOSIT_CAP missing from the sheet"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenFeeRecipientZero() public {
        (string memory json,) = _twoAssets();
        BasketVaultDeployBase.Params memory p = _params();
        p.feeRecipient = address(0);
        vm.expectRevert(bytes("FEE_RECIPIENT=0"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenPoolFeeDiffersFromConfig() public {
        address[] memory tokens = new address[](1);
        address[] memory pools = new address[](1);
        (tokens[0], pools[0]) = _tokenAndPool("weth"); // pool fee() is 500
        string memory json = _json("assets", tokens, pools, 3000); // config says 3000
        vm.expectRevert(bytes("T0: pool fee does not equal config"));
        _run(json);
    }

    function test_reverts_whenPoolHasNoCode() public {
        address[] memory tokens = new address[](1);
        address[] memory pools = new address[](1);
        tokens[0] = makeAddr("tokenA");
        pools[0] = makeAddr("emptyPool");
        string memory json = _json("assets", tokens, pools, 500);
        vm.expectRevert(bytes("T0: pool has no code"));
        _run(json);
    }

    function test_reverts_whenPoolCardinalityTooLow() public {
        address token = makeAddr("tokenB");
        address pool = makeAddr("lowCardPool");
        vm.etch(pool, address(new LowCardinalityPool(token, address(usdc), 500)).code);
        address[] memory tokens = new address[](1);
        address[] memory pools = new address[](1);
        tokens[0] = token;
        pools[0] = pool;
        vm.expectRevert();
        _run(_json("assets", tokens, pools, 500)); // InsufficientPoolCardinality from addAsset
    }

    function test_reverts_whenVenueUnsupported() public {
        (string memory json,) = _twoAssets();
        // Swap the venue string for an unsupported one.
        string memory bad = vm.replace(json, "UniswapV3", "UniswapV4");
        vm.expectRevert(bytes("unsupported venue: only UniswapV3"));
        _run(bad);
    }

    // ─── Manifest ─────────────────────────────────────────────────────────────

    function test_manifest_listsAssetsAndPausedState() public {
        (string memory json, address[] memory tokens) = _twoAssets();
        BasketVaultDeployBase.Deployed memory d = _run(json);
        ProtocolDeployHarness h = new ProtocolDeployHarness();
        string memory path =
            string.concat(vm.projectRoot(), "/deployments/test-protocol-manifest.json");
        h.writeManifestTo(path, d, json);
        string memory out = vm.readFile(path);
        vm.removeFile(path);
        assertEq(out.readAddress(".vault"), d.vault);
        assertEq(out.readAddress(".registry"), address(registry));
        assertTrue(out.readBool(".paused"));
        assertTrue(out.readBool(".registered"));
        assertFalse(vm.keyExistsJson(out, ".assets[2]"));
        assertEq(out.readAddress(".assets[0].token"), tokens[0]);
        assertEq(out.readAddress(".assets[1].token"), tokens[1]);
    }
}

/// @dev Reports observation cardinality 1: `addAsset` must refuse it.
contract LowCardinalityPool is ConstPool {
    constructor(address a, address b, uint24 fee_) ConstPool(a, b, fee_) {}

    function slot0()
        external
        pure
        override
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (uint160(1 << 96), 0, 0, 1, 1, 0, true);
    }
}
