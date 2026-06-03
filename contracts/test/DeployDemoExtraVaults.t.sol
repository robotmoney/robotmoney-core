// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0002-router-default-weights-on-chain.md — demo seed
//            populates a non-empty defaultWeights vector so the allocation
//            surface renders with no governance activity.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployDemoExtraVaults} from "../script/DeployDemoExtraVaults.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";
import {AdapterBytecodeGuard} from "../script/AdapterBytecodeGuard.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice Integration test for the demo seed path: after `DeployDemoExtraVaults`
///         runs, rmAGENT is router-eligible with BNKR/JUNO/ROBOTMONEY basket,
///         the router carries a two-vault default weight vector (primary + rmAGENT),
///         and a routed deposit reaches both vaults. ADR-0002; issue #560.
contract DeployDemoExtraVaultsTest is Test {
    DeployDemoExtraVaults internal script;
    TestERC20 internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RobotMoneyVault internal primaryVault;

    // The test contract is the broadcaster/admin (mirrors Deploy.t.sol's
    // in-process pattern), so it must hold ADMIN_ROLE on registry + router.
    address internal admin = address(this);

    function setUp() public {
        script = new DeployDemoExtraVaults();
        usdc = new TestERC20();
        registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);

        // Deploy + wire the primary vault the same way Deploy.s.sol does on
        // the devnet (passthrough adapter), register it, and opt it in.
        primaryVault = new RobotMoneyVault(
            IERC20(address(usdc)), 10_000_000 * 1e6, 1_000_000 * 1e6, 0, admin, admin
        );
        PassthroughAdapter adapter = new PassthroughAdapter(address(usdc), address(primaryVault));
        AdapterBytecodeGuard.requireNoDelegatecall(address(adapter));
        primaryVault.setAdapterAllowed(address(adapter), true);
        primaryVault.setAdapterCodeHashAllowed(address(adapter).codehash, true);
        primaryVault.addAdapter(address(adapter), 10_000);

        registry.registerVault(
            address(primaryVault),
            VaultRegistry.VaultMetadata({
                name: "Robot Money USDC", asset: address(usdc), registeredAt: 0
            })
        );
        registry.setRouterEligible(address(primaryVault), true);

        // The script contract is the broadcaster for `runInProcess` (it makes
        // the registry/router calls), so grant it ADMIN_ROLE on both. Mirrors
        // the production Safe -> Timelock -> ADMIN_ROLE wiring where the caller
        // already holds the role.
        registry.grantRole(registry.ADMIN_ROLE(), address(script));
        router.grantRole(router.ADMIN_ROLE(), address(script));
    }

    function _runScript() internal returns (DeployDemoExtraVaults.Deployed memory d) {
        DeployDemoExtraVaults.Params memory p = DeployDemoExtraVaults.Params({
            admin: address(script),
            // Use admin as emergencyResponder for the demo seed test (allowed to be equal).
            emergencyResponder: address(script),
            registry: address(registry),
            router: address(router),
            primaryVault: address(primaryVault),
            usdc: address(usdc),
            swapRouter: 0x2626664c2603336E57B271c5C0b26F421741e481,
            rwaName: "Robot Money RWA / Thematic"
        });
        d = script.runInProcess(p);
    }

    /// @notice After the demo seed runs, rmAGENT is router-eligible and the
    ///         router default vector is a two-leg 50/50 split between primary and
    ///         rmAGENT. Registry router-eligible count = 2.
    function test_demo_seed_populates_defaultWeights() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();

        // Default vector spans both router-eligible vaults: primary + rmAGENT.
        (address[] memory dV, uint256[] memory dB) = router.getDefaultWeights();
        assertEq(dV.length, 2, "default vector must span primary + rmAGENT");
        assertEq(dV[0], address(primaryVault), "leg 0 = primary vault");
        assertEq(dV[1], d.agentTokenVault, "leg 1 = rmAGENT");
        assertEq(dB[0], 5_000, "primary weight must be 5000 bps (50%)");
        assertEq(dB[1], 5_000, "rmAGENT weight must be 5000 bps (50%)");

        // Registry router-eligible count matches the default vector length.
        assertEq(registry.routerEligibleCount(), 2, "two router-eligible vaults");

        // Represent the "no governance activity" (below-quorum) state: the
        // voted vector is not in effect. The demo also seeds a voted vector
        // for the legacy AC3 smoke test, so clear it to observe the fallback.
        router.clearVotedWeights();
        assertFalse(router.votedWeightsActive());

        // previewDeposit routes 50/50 across both vaults.
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(1_000e6);
        assertEq(legs.length, 2, "preview must have two legs");
        assertEq(legs[0].weightBps, 5_000, "primary leg weight 5000 bps");
        assertEq(legs[1].weightBps, 5_000, "rmAGENT leg weight 5000 bps");
        assertEq(legs[0].legAmount, 500e6, "primary receives half the deposit");
        assertEq(legs[1].legAmount, 500e6, "rmAGENT receives half the deposit");
    }

    /// @notice rmAGENT is router-eligible after the demo seed (issue #560 AC1).
    function test_rmAGENT_is_router_eligible() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        assertTrue(
            registry.isRouterEligible(d.agentTokenVault),
            "rmAGENT must be router-eligible after demo seed"
        );
    }

    /// @notice rmAGENT holds exactly BNKR/JUNO/ROBOTMONEY — the three-token
    ///         real-asset basket (issue #560 AC1).
    function test_rmAGENT_holds_three_token_basket() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        AgentTokenVault agentVault = AgentTokenVault(d.agentTokenVault);
        (address[] memory tokens,,,,) = agentVault.shortlist();
        assertEq(tokens.length, 3, "shortlist holds exactly three tokens");
        assertEq(d.agentTokens.length, 3, "three agent tokens deployed");
        for (uint256 i = 0; i < 3; i++) {
            assertEq(tokens[i], d.agentTokens[i], "shortlist token matches deployed stub");
        }
    }

    /// @notice rmAGENT appears in defaultWeights (issue #560 AC2).
    function test_rmAGENT_in_defaultWeights() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        (address[] memory dV,) = router.getDefaultWeights();
        bool found = false;
        for (uint256 i = 0; i < dV.length; i++) {
            if (dV[i] == d.agentTokenVault) {
                found = true;
                break;
            }
        }
        assertTrue(found, "rmAGENT must appear in defaultWeights");
    }

    /// @notice The three basket tokens use the correct per-asset venues:
    ///         BNKR → V3, JUNO → V4, ROBOTMONEY → Aerodrome (issue #560 AC1).
    function test_rmAGENT_basket_tokens_have_correct_venues() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        AgentTokenVault agentVault = AgentTokenVault(d.agentTokenVault);

        // Read and assert per-asset (stack-split to avoid stack-too-deep).
        _assertBnkrAsset(agentVault, d);
        _assertJunoAsset(agentVault, d);
        _assertRobotmoneyAsset(agentVault, d);
    }

    /// @notice A direct deposit to rmAGENT after the demo seed increases
    ///         totalAssets via multi-DEX swaps across V3/V4/Aerodrome stubs
    ///         (issue #560 AC2 — routed deposit increases totalAssets).
    ///
    ///         The demo stub routers mint output tokens 1:1, so totalAssets
    ///         after deposit equals the deposited USDC (minus any USDC that
    ///         remains idle before the TWAP NAV read — here zero because all
    ///         USDC is swapped into basket tokens). The TWAP price from the
    ///         demo pool's MockPool-style stub returns a 1:1 price (tick=0),
    ///         so the share conversion is exact.
    function test_rmAGENT_deposit_increases_totalAssets_via_multi_dex() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        AgentTokenVault agentVault = AgentTokenVault(d.agentTokenVault);

        uint256 depositAmount = 300e6; // 300 USDC — divisible by 3 for equal split
        usdc.mint(address(this), depositAmount);
        usdc.approve(address(agentVault), depositAmount);

        uint256 totalAssetsBefore = agentVault.totalAssets();

        // deposit() routes USDC into BNKR (V3), JUNO (V4), ROBOTMONEY (Aerodrome).
        // Each demo stub router performs a 1:1 swap, so each token balance
        // increases by depositAmount/3 = 100 USDC.
        agentVault.deposit(depositAmount, address(this));

        // totalAssets() reads TWAP-priced token balances. Demo pool stubs return
        // observationCardinality >= 2 and tick=0 (1:1 USDC price), so the NAV
        // equals the sum of token balances in USDC units.
        uint256 totalAssetsAfter = agentVault.totalAssets();
        assertGt(totalAssetsAfter, totalAssetsBefore, "totalAssets must increase after deposit");
    }

    // ─── Per-asset venue helpers ──────────────────────────────────────────────

    function _assertBnkrAsset(AgentTokenVault vault, DeployDemoExtraVaults.Deployed memory d)
        internal
        view
    {
        (address token, address pool,, bool active, address adapter, BasketVault.Venue venue) =
            vault.assets(0);
        assertEq(token, d.agentTokens[0], "BNKR token address");
        assertTrue(active, "BNKR active");
        assertTrue(pool != address(0), "BNKR pool set");
        assertEq(uint256(venue), uint256(BasketVault.Venue.V3), "BNKR venue = V3");
        assertEq(adapter, address(0), "BNKR uses built-in V3 router (no per-asset adapter)");
    }

    function _assertJunoAsset(AgentTokenVault vault, DeployDemoExtraVaults.Deployed memory d)
        internal
        view
    {
        (address token, address pool,, bool active, address adapter, BasketVault.Venue venue) =
            vault.assets(1);
        assertEq(token, d.agentTokens[1], "JUNO token address");
        assertTrue(active, "JUNO active");
        assertTrue(pool != address(0), "JUNO pool set");
        assertEq(uint256(venue), uint256(BasketVault.Venue.V4), "JUNO venue = V4");
        assertNotEq(adapter, address(0), "JUNO uses V4 adapter");
        assertEq(adapter, d.v4Adapter, "JUNO adapter = deployed v4Adapter");
    }

    function _assertRobotmoneyAsset(AgentTokenVault vault, DeployDemoExtraVaults.Deployed memory d)
        internal
        view
    {
        (address token, address pool,, bool active, address adapter, BasketVault.Venue venue) =
            vault.assets(2);
        assertEq(token, d.agentTokens[2], "ROBOTMONEY token address");
        assertTrue(active, "ROBOTMONEY active");
        assertTrue(pool != address(0), "ROBOTMONEY pool set");
        assertEq(
            uint256(venue), uint256(BasketVault.Venue.Aerodrome), "ROBOTMONEY venue = Aerodrome"
        );
        assertNotEq(adapter, address(0), "ROBOTMONEY uses Aerodrome adapter");
        assertEq(adapter, d.aeroAdapter, "ROBOTMONEY adapter = deployed aeroAdapter");
    }
}
