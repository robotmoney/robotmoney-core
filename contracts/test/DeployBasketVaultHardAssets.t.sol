// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §11.5 — Hard Assets Vault (rmHARD)
//            docs/adr/ADR-0018-hard-assets-vault-fourth-router-vault.md (core 2008)
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";

import {DeployHardAssetsVault} from "../script/DeployHardAssetsVault.s.sol";
import {BasketVaultDeployBase} from "../script/BasketVaultDeployBase.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {HardAssetsVault} from "../vaults/HardAssetsVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {AerodromeSwapAdapter} from "../adapters/AerodromeSwapAdapter.sol";
import {BasketDeployFixture, ConstPool} from "./helpers/BasketDeployFixture.sol";

/// @dev Aero (Aerodrome Slipstream) CL pool double: the `ConstPool` TWAP and liquidity surface, the pool's live fee in pips,
///      plus `tickSpacing()` and `factory()`. Every field is an immutable, so the code can be etched at the real pool address.
contract ConstAeroPool is ConstPool {
    int24 private immutable _tickSpacing;
    address public immutable factory;

    constructor(address a, address b, uint24 livePips, int24 tickSpacing_, address factory_)
        ConstPool(a, b, livePips)
    {
        _tickSpacing = tickSpacing_;
        factory = factory_;
    }

    function tickSpacing() external view returns (int24) {
        return _tickSpacing;
    }
}

/// @dev Aero CL factory double: `getPool` returns the one configured pool for the configured pair and spacing, else zero.
contract ConstAeroFactory {
    address internal immutable _pool;
    address internal immutable _a;
    address internal immutable _b;
    int24 internal immutable _tickSpacing;

    constructor(address pool_, address a, address b, int24 tickSpacing_) {
        _pool = pool_;
        (_a, _b) = a < b ? (a, b) : (b, a);
        _tickSpacing = tickSpacing_;
    }

    function getPool(address x, address y, int24 ts) external view returns (address) {
        (address lo, address hi) = x < y ? (x, y) : (y, x);
        return (lo == _a && hi == _b && ts == _tickSpacing) ? _pool : address(0);
    }
}

contract HardAssetsDeployHarness is DeployHardAssetsVault {
    function readPrefixed(string memory prefix) external view returns (Params memory) {
        return _readParamsFrom(prefix);
    }
}

/// @notice rmHARD script (core 2008, ADR-0018): a plain BasketVault row for PAXG through the existing `AerodromeSwapAdapter` on its
///         Aero CL USDC pool, priced from the pool TWAP. No oracle. The script reads the real `config/hard-assets.json`; the pool and
///         factory doubles are etched at the configured addresses.
contract DeployBasketVaultHardAssetsTest is BasketDeployFixture {
    using stdJson for string;

    string internal constant CONFIG = "config/hard-assets.json";
    uint256 internal constant SHEET_EXIT_FEE_BPS = 50;
    /// @dev The live Aero pool fee in pips at the config block (5 bps).
    uint24 internal constant LIVE_FEE_PIPS = 500;

    DeployHardAssetsVault internal script;

    function setUp() public {
        _fixtureSetUp();
        script = new DeployHardAssetsVault();
    }

    /// @dev Etch the Aero pool, factory and (if absent) token doubles at the config addresses, paired with this test's USDC.
    function _etchAero(uint24 livePips, int24 poolTickSpacing)
        internal
        returns (string memory json)
    {
        json = vm.readFile(CONFIG);
        address token = json.readAddress(".assets[0].token");
        address pool = json.readAddress(".assets[0].pool");
        address factory = json.readAddress(".aerodromeSlipstreamFactory");
        int24 ts = int24(int256(json.readUint(".assets[0].poolFee")));
        vm.etch(
            pool,
            address(new ConstAeroPool(token, address(usdc), livePips, poolTickSpacing, factory))
            .code
        );
        vm.etch(factory, address(new ConstAeroFactory(pool, token, address(usdc), ts)).code);
        if (token.code.length == 0) vm.etch(token, address(usdc).code);
    }

    function _deploy(BasketVaultDeployBase.Params memory p, string memory json)
        internal
        returns (BasketVaultDeployBase.Deployed memory d)
    {
        p.swapRouter = _configRouter(json);
        return script.runInProcess(p, json);
    }

    function _sheet() internal view returns (BasketVaultDeployBase.Params memory p) {
        p = _params();
        p.exitFeeBps = SHEET_EXIT_FEE_BPS;
    }

    function test_deploy_pausedActiveNamedAndOnePaxgRowThroughAerodrome() public {
        string memory json = _etchAero(LIVE_FEE_PIPS, 10);
        BasketVaultDeployBase.Deployed memory d = _deploy(_sheet(), json);
        HardAssetsVault v = HardAssetsVault(d.vault);

        assertTrue(v.depositsPaused(), "deploys paused");
        (VaultRegistry.VaultMetadata memory meta, VaultRegistry.VaultStatus status) =
            registry.getVault(d.vault);
        assertEq(
            uint256(status), uint256(VaultRegistry.VaultStatus.Active), "registry lists it Active"
        );
        assertEq(meta.name, "Robot Money Hard Assets", "registry name");
        assertEq(v.name(), "Robot Money Hard Assets", "PRD 11.5 name");
        assertEq(v.symbol(), "rmHARD", "PRD 11.5 symbol");
        assertEq(v.exitFeeBps(), SHEET_EXIT_FEE_BPS, "exit fee from the sheet");
        assertFalse(registry.isRouterEligible(d.vault), "ineligible until the stage sets weights");

        (
            address[] memory tokens,
            address[] memory pools,
            uint24[] memory fees,
            bool[] memory active,
        ) = v.shortlist();
        assertEq(tokens.length, 1, "exactly one row");
        assertEq(json.readString(".assets[0].symbol"), "PAXG");
        assertEq(tokens[0], json.readAddress(".assets[0].token"), "PAXG token from config");
        assertEq(pools[0], json.readAddress(".assets[0].pool"), "Aero pool from config");
        assertEq(uint256(fees[0]), 10, "swap fee is the tick spacing");
        assertTrue(active[0]);

        (,,,, address adapter, BasketVault.Venue venue) = v.assets(0);
        assertEq(uint256(venue), uint256(BasketVault.Venue.Aerodrome), "venue Aerodrome");
        assertEq(adapter, d.adapter, "the deployed adapter");
        assertEq(
            address(AerodromeSwapAdapter(adapter).ROUTER()),
            json.readAddress(".aerodromeSlipstreamRouter"),
            "Aero router from config"
        );
        assertEq(
            address(AerodromeSwapAdapter(adapter).FACTORY()),
            json.readAddress(".aerodromeSlipstreamFactory"),
            "Aero factory from config"
        );
        assertTrue(v.adapterCodeHashAllowed(adapter.codehash), "code hash allowed");

        // A TWAP quote through the adapter: 1 PAXG (18 decimals) at tick 0 is a non-zero USDC amount, and NAV reads.
        uint256 quote = AerodromeSwapAdapter(adapter)
            .twapPrice(pools[0], tokens[0], address(usdc), 1e18, v.DEFAULT_TWAP_WINDOW());
        assertGt(quote, 0, "TWAP quote succeeds");
        assertEq(v.totalAssets(), 0, "empty vault NAV");
    }

    function test_reverts_whenPoolTickSpacingDiffersFromConfig() public {
        string memory json = _etchAero(LIVE_FEE_PIPS, 50);
        BasketVaultDeployBase.Params memory p = _sheet();
        p.swapRouter = _configRouter(json);
        vm.expectRevert(bytes("PAXG: pool tick spacing does not equal config"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenPoolIsNotTheFactoryPool() public {
        string memory json = _etchAero(LIVE_FEE_PIPS, 10);
        // The factory knows a different pool for the pair.
        address factory = json.readAddress(".aerodromeSlipstreamFactory");
        vm.etch(
            factory,
            address(
                new ConstAeroFactory(
                    makeAddr("otherPool"), json.readAddress(".assets[0].token"), address(usdc), 10
                )
            )
            .code
        );
        BasketVaultDeployBase.Params memory p = _sheet();
        p.swapRouter = _configRouter(json);
        vm.expectRevert(bytes("PAXG: pool is not the factory's canonical pool"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenGuardIsNotAboveTheLivePoolFee() public {
        // A dynamic fee of 5 percent (50_000 pips) is above the 400 bps sheet guard.
        string memory json = _etchAero(50_000, 10);
        BasketVaultDeployBase.Params memory p = _sheet();
        p.swapRouter = _configRouter(json);
        vm.expectRevert(bytes("PAXG: NAV_DEVIATION_BPS must be above the pool fee in bps"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenAerodromeRouterUnset() public {
        string memory json = vm.readFile(CONFIG);
        json = vm.replace(json, '"aerodromeSlipstreamRouter"', '"aerodromeSlipstreamRouterRemoved"');
        BasketVaultDeployBase.Params memory p = _sheet();
        p.swapRouter = _configRouter(json);
        vm.expectRevert(bytes("config aerodromeSlipstreamRouter unset"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenConfigMixesAerodromeAndV3Rows() public {
        string memory json = _etchAero(LIVE_FEE_PIPS, 10);
        (address t, address pool) = _tokenAndPool("V3TOKEN");
        string memory v3Row = string.concat(
            ',{"symbol":"V3TOKEN","token":"',
            vm.toString(t),
            '","tokenDecimals":18,"venue":"UniswapV3","pool":"',
            vm.toString(pool),
            '","poolFee":500}]'
        );
        json = vm.replace(json, "}\n  ]", string.concat("}", v3Row));
        BasketVaultDeployBase.Params memory p = _sheet();
        p.swapRouter = _configRouter(json);
        vm.expectRevert(bytes("config mixes Aerodrome and UniswapV3 rows"));
        script.runInProcess(p, json);
    }

    function test_reverts_whenNavDeviationBpsUnset() public {
        string memory prefix = "D2008HARD_";
        HardAssetsDeployHarness h = new HardAssetsDeployHarness();
        _setSheetEnv(prefix, "NAV_DEVIATION_BPS");
        vm.expectRevert(bytes(string.concat(prefix, "NAV_DEVIATION_BPS must be set")));
        h.readPrefixed(prefix);
    }
}
