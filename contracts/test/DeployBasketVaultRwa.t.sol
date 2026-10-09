// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S4 (issue 1486), core 1492
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {UniswapV3SwapAdapter} from "../adapters/UniswapV3SwapAdapter.sol";
import {BasketDeployFixture} from "./helpers/BasketDeployFixture.sol";

contract RwaDeployHarness is DeployRwaBasketVault {
    function readPrefixed(string memory prefix) external view returns (Params memory) {
        return _readParamsFrom(prefix);
    }
}

/// @notice rmRWA script: a plain BasketVault row for deSPXA through the existing
///         `UniswapV3SwapAdapter` on the fee 500 pool, priced from the pool TWAP. No oracle.
contract DeployBasketVaultRwaTest is BasketDeployFixture {
    using stdJson for string;

    DeployRwaBasketVault internal script;

    function setUp() public {
        _fixtureSetUp();
        script = new DeployRwaBasketVault();
    }

    function test_deploy_isBasketVaultRowForDespxaWithV3AdapterFee500() public {
        string memory json = _etchConfigPools("config/rwa-assets.json", "assets");
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        BasketVaultDeployBase.Deployed memory d = script.runInProcess(p, json);

        RwaBasketVault v = RwaBasketVault(d.vault);
        assertEq(v.symbol(), "rmRWA");
        assertTrue(v.depositsPaused(), "paused");
        assertEq(v.assetCount(), 1, "one row");
        (
            address token,
            address pool,
            uint24 fee,
            bool active,
            address adapter,
            BasketVault.Venue venue
        ) = v.assets(0);
        assertEq(token, json.readAddress(".assets[0].token"), "deSPXA token from config");
        assertEq(json.readString(".assets[0].symbol"), "deSPXA");
        assertEq(pool, json.readAddress(".assets[0].pool"), "pool from config");
        assertEq(uint256(fee), 500, "fee 500");
        assertTrue(active);
        assertEq(uint256(venue), uint256(BasketVault.Venue.V3));
        assertEq(adapter, d.adapter);
        assertEq(address(UniswapV3SwapAdapter(adapter).ROUTER()), p.swapRouter, "router02");
        assertTrue(v.adapterCodeHashAllowed(adapter.codehash), "code hash allowed");

        // A successful TWAP quote through the adapter: 1 deSPXA (18 dec) at tick 0 is a
        // non-zero USDC amount, and `totalAssets()` reads without reverting.
        uint256 quote =
            UniswapV3SwapAdapter(adapter).twapPrice(pool, token, address(usdc), 1e18, 1800);
        assertGt(quote, 0, "TWAP quote succeeds");
        assertEq(v.totalAssets(), 0, "empty vault NAV");
    }

    function test_deploy_registersAsBasketVault() public {
        string memory json = _etchConfigPools("config/rwa-assets.json", "assets");
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        BasketVaultDeployBase.Deployed memory d = script.runInProcess(p, json);
        address[] memory listed = registry.listVaults();
        assertEq(listed.length, 1);
        assertEq(listed[0], d.vault);
        (VaultRegistry.VaultMetadata memory meta,) = registry.getVault(d.vault);
        assertEq(meta.name, "Robot Money RWA");
        // Resolves to a BasketVault: the BasketVault ABI answers.
        assertEq(BasketVault(d.vault).assetCount(), 1);
        assertFalse(registry.isRouterEligible(d.vault));
        assertTrue(BasketVault(d.vault).hasRole(BasketVault(d.vault).EMERGENCY_ROLE(), deployer));
    }

    function test_reverts_whenPoolFeeIsNot500() public {
        string memory json = _etchConfigPools("config/rwa-assets.json", "assets");
        // Same config, but the pool at that address reports fee 100: the old wrong value.
        address pool = json.readAddress(".assets[0].pool");
        address token = json.readAddress(".assets[0].token");
        vm.etch(pool, address(new ConstPoolFee100(token, address(usdc))).code);
        BasketVaultDeployBase.Params memory p = _params();
        p.swapRouter = _configRouter(json);
        vm.expectRevert(bytes("deSPXA: pool fee does not equal config"));
        script.runInProcess(p, json);
    }

    function test_noRwaVaultOrChronicleArtifactsRemain() public view {
        string[4] memory gone = [
            "contracts/vaults/RwaVault.sol",
            "contracts/adapters/ChronicleOracleAdapter.sol",
            "contracts/adapters/DeSpxaAssetPositionAdapter.sol",
            "contracts/interfaces/IChronicleOracle.sol"
        ];
        for (uint256 i = 0; i < gone.length; i++) {
            try vm.readFile(gone[i]) returns (string memory) {
                revert(string.concat("deleted source still present: ", gone[i]));
            } catch {}
        }
    }

    // ─── Issue 1666: the NAV deviation guard and the pool floor come from the sheet ──

    function _prepare(BasketVaultDeployBase.Params memory p) internal returns (string memory json) {
        json = _etchConfigPools("config/rwa-assets.json", "assets");
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
        string memory prefix = "D1666RWA_";
        RwaDeployHarness h = new RwaDeployHarness();
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
        string memory prefix = "D1666LRWA_";
        RwaDeployHarness h = new RwaDeployHarness();
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

import {ConstPool} from "./helpers/BasketDeployFixture.sol";

contract ConstPoolFee100 is ConstPool {
    constructor(address a, address b) ConstPool(a, b, 100) {}
}
