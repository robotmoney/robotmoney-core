// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0002-router-default-weights-on-chain.md — demo seed
//            populates a non-empty defaultWeights vector so the allocation
//            surface renders with no governance activity.
//            docs/adr/ADR-0006-despxa-rwa-vault-design.md — deSPXA RWA vault;
//            issue #559 — rmPROTO router-eligible in demo seed.
//            issue #562 — register deSPXA RWA vault Active, direct-seed-only.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployDemoExtraVaults} from "../script/DeployDemoExtraVaults.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {RwaVault} from "../vaults/RwaVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";
import {AdapterBytecodeGuard} from "../script/AdapterBytecodeGuard.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice Minimal ERC-4626 view surface shared by every PRD §11 vault
///         (RobotMoneyVault + BasketVault subclasses) used to read TVL in a
///         vault-type-agnostic way for the four-vault real-TVL assertion.
interface IERC4626Min {
    function totalAssets() external view returns (uint256);
}

/// @notice Integration test for the demo seed path: after `DeployDemoExtraVaults`
///         runs, rmPROTO (issue #559), rmAGENT (issue #560), and rmRWA (issue #621)
///         are all router-eligible, the router carries a four-vault default weight
///         vector (primary 8500 bps + rmRWA/rmPROTO/rmAGENT at 500 bps each), and
///         a routed deposit reaches all four vaults.
///         ADR-0002; issues #559, #560, #621. Also: deSPXA RWA vault is registered
///         Active and router-eligible at 500 bps (ADR-0006 §1 amended 2026-06-05).
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
            IERC20(address(usdc)), 10_000_000 * 1e6, 1_000_000 * 1e6, 0, admin, admin, admin
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

    /// @notice After the demo seed runs, rmPROTO, rmAGENT, and rmRWA are all
    ///         router-eligible and the router default vector is a four-leg
    ///         8500/500/500/500 bps split (primary + rmRWA + rmPROTO + rmAGENT).
    ///         Registry router-eligible count = 4. Issue #621.
    function test_demo_seed_populates_defaultWeights() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();

        // Default vector spans all four router-eligible vaults.
        (address[] memory dV, uint256[] memory dB) = router.getDefaultWeights();
        assertEq(dV.length, 4, "default vector must span primary + rmRWA + rmPROTO + rmAGENT");
        assertEq(dB[0] + dB[1] + dB[2] + dB[3], 10_000, "weights must sum to 10 000 bps");

        // Find per-vault bps by address.
        uint256 primaryBps;
        uint256 rwaBps;
        uint256 protoBps;
        uint256 agentBps;
        bool foundPrimary;
        bool foundRwa;
        bool foundProto;
        bool foundAgent;
        for (uint256 i = 0; i < dV.length; i++) {
            if (dV[i] == address(primaryVault)) {
                foundPrimary = true;
                primaryBps = dB[i];
            } else if (dV[i] == d.rwaVault) {
                foundRwa = true;
                rwaBps = dB[i];
            } else if (dV[i] == d.protocolVault) {
                foundProto = true;
                protoBps = dB[i];
            } else if (dV[i] == d.agentTokenVault) {
                foundAgent = true;
                agentBps = dB[i];
            }
        }
        assertTrue(foundPrimary, "primary vault must be in default vector");
        assertTrue(foundRwa, "rmRWA must be in default vector");
        assertTrue(foundProto, "rmPROTO must be in default vector");
        assertTrue(foundAgent, "rmAGENT must be in default vector");

        // Assert the exact 8500/500/500/500 bps split (issue #621).
        assertEq(primaryBps, 8_500, "primary must hold 8500 bps");
        assertEq(rwaBps, 500, "rmRWA must hold 500 bps");
        assertEq(protoBps, 500, "rmPROTO must hold 500 bps");
        assertEq(agentBps, 500, "rmAGENT must hold 500 bps");

        // Registry router-eligible count matches the default vector length.
        assertEq(registry.routerEligibleCount(), 4, "four router-eligible vaults");

        // Represent the "no governance activity" (below-quorum) state: the
        // voted vector is not in effect. The demo also seeds a voted vector
        // for the legacy AC3 smoke test, so clear it to observe the fallback.
        router.clearVotedWeights();
        assertFalse(router.votedWeightsActive());

        // previewDeposit routes across all four vaults.
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(1_000e6);
        assertEq(legs.length, 4, "preview must have four legs");
        uint256 totalBps;
        uint256 totalAmt;
        for (uint256 i = 0; i < legs.length; i++) {
            totalBps += legs[i].weightBps;
            totalAmt += legs[i].legAmount;
        }
        assertEq(totalBps, 10_000, "preview weights must sum to 10 000 bps");
        assertEq(totalAmt, 1_000e6, "preview amounts must sum to deposit");
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

    // ─── rmPROTO router-eligibility (issue #559) ─────────────────────────────

    /// @notice AC#1 (issue #559): rmPROTO is router-eligible after the demo seed.
    function test_rmPROTO_is_router_eligible() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        assertTrue(
            registry.isRouterEligible(d.protocolVault), "registry must mark rmPROTO router-eligible"
        );
    }

    /// @notice AC#2 (issue #559): rmPROTO appears in the router defaultWeights vector.
    function test_rmPROTO_in_defaultWeights() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        (address[] memory dV,) = router.getDefaultWeights();
        bool found;
        for (uint256 i = 0; i < dV.length; i++) {
            if (dV[i] == d.protocolVault) {
                found = true;
                break;
            }
        }
        assertTrue(found, "rmPROTO must appear in defaultWeights");
    }

    /// @notice AC#3 (issue #559): a router deposit succeeds end-to-end with
    ///         rmPROTO eligible — the DemoV3SwapRouter stub handles the V3 path.
    function test_rmPROTO_router_deposit_succeeds() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();

        uint256 depositAmt = 300e6;
        usdc.mint(address(this), depositAmt);
        usdc.approve(address(router), depositAmt);

        uint256 sharesBefore = primaryVault.balanceOf(address(this));
        router.deposit(depositAmt, new uint256[](0));
        assertGt(
            primaryVault.balanceOf(address(this)), sharesBefore, "primary shares must increase"
        );
    }

    // ─── deSPXA RWA vault tests (issue #562) ─────────────────────────────────

    /// @notice The deSPXA RWA vault (PRD §11.4) is registered Active after the
    ///         demo seed — no Paused placeholder remains (issue #562 AC1).
    function test_rwaVault_is_Active_after_demo_seed() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        (, VaultRegistry.VaultStatus status) = registry.getVault(d.rwaVault);
        assertEq(
            uint256(status),
            uint256(VaultRegistry.VaultStatus.Active),
            "rmRWA must be registered Active (no Paused placeholder)"
        );
    }

    /// @notice The deSPXA RWA vault IS router-eligible at 500 bps per issue #621
    ///         (ADR-0006 §1 amended 2026-06-05 — product owner confirmed).
    function test_rwaVault_is_router_eligible() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        assertTrue(
            registry.isRouterEligible(d.rwaVault),
            "rmRWA must be router-eligible at 500 bps (ADR-0006 S1 amended, issue #621)"
        );
    }

    /// @notice The rmRWA vault IS included in the router defaultWeights vector at
    ///         500 bps (issue #621, ADR-0006 §1 amended 2026-06-05).
    function test_rwaVault_in_defaultWeights() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        (address[] memory dV, uint256[] memory dB) = router.getDefaultWeights();
        bool found = false;
        uint256 rwaBps;
        for (uint256 i = 0; i < dV.length; i++) {
            if (dV[i] == d.rwaVault) {
                found = true;
                rwaBps = dB[i];
                break;
            }
        }
        assertTrue(found, "rmRWA must appear in defaultWeights (issue #621)");
        assertEq(rwaBps, 500, "rmRWA must carry exactly 500 bps");
    }

    // ─── Four-vault real-TVL end state (issue #592) ─────────────────────────

    /// @notice The full four-vault PRD §11 end state: after the demo seed, all
    ///         four vaults are registered Active, all four are router-eligible
    ///         (issue #621 — rmRWA is now router-eligible at 500 bps per ADR-0006
    ///         §1 amended 2026-06-05), and a single routed deposit via the default
    ///         8500/500/500/500 bps vector funds all four vaults. Every vault
    ///         reports non-zero `totalAssets`. This is the forge-layer mirror of
    ///         the smoke-test four-vault TVL invariant the dapp tiles depend on
    ///         (issues #592, #621).
    function test_four_vaults_all_active_with_nonzero_totalAssets() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();

        address[4] memory vaults =
            [address(primaryVault), d.protocolVault, d.agentTokenVault, d.rwaVault];

        // 1) All four vaults are registered Active.
        for (uint256 i = 0; i < 4; i++) {
            (, VaultRegistry.VaultStatus status) = registry.getVault(vaults[i]);
            assertEq(
                uint256(status),
                uint256(VaultRegistry.VaultStatus.Active),
                "every PRD section-11 vault must be registered Active"
            );
        }

        // 2) All four vaults are router-eligible (issue #621 — rmRWA added at 500 bps).
        assertEq(registry.routerEligibleCount(), 4, "four router-eligible vaults");
        assertTrue(registry.isRouterEligible(d.protocolVault), "rmPROTO router-eligible");
        assertTrue(registry.isRouterEligible(d.agentTokenVault), "rmAGENT router-eligible");
        assertTrue(registry.isRouterEligible(address(primaryVault)), "primary router-eligible");
        assertTrue(registry.isRouterEligible(d.rwaVault), "rmRWA router-eligible at 500 bps");

        // 3) A single routed deposit funds all four router-eligible vaults via
        //    the 8500/500/500/500 bps default vector (issue #621).
        router.clearVotedWeights();
        uint256 routedAmount = 10_000e6; // 10000 USDC — large enough to split meaningfully
        usdc.mint(address(this), routedAmount);
        usdc.approve(address(router), routedAmount);
        router.deposit(routedAmount, new uint256[](0));

        // 4) Every one of the four vaults now reports non-zero totalAssets.
        for (uint256 i = 0; i < 4; i++) {
            assertGt(
                IERC4626Min(vaults[i]).totalAssets(),
                0,
                "every PRD section-11 vault must hold non-zero totalAssets after seeding"
            );
        }
    }

    /// @notice The rmRWA vault holds exactly one basket asset (deSPXA stub),
    ///         wired with Venue.Aerodrome and a ChronicleOracleAdapter. Issue #562 AC1.
    function test_rwaVault_holds_deSPXA_asset_Aerodrome_venue() public {
        DeployDemoExtraVaults.Deployed memory d = _runScript();
        RwaVault rwaVault = RwaVault(d.rwaVault);

        // maxAssets() == 1 enforced by RwaVault.
        assertEq(rwaVault.maxAssets(), 1, "RwaVault.maxAssets() must be 1");

        // Exactly one asset is seeded.
        (address token, address pool,, bool active, address adapter, BasketVault.Venue venue) =
            rwaVault.assets(0);
        assertTrue(token != address(0), "deSPXA stub token must be set");
        assertTrue(pool != address(0), "deSPXA pool stub must be set");
        assertTrue(active, "deSPXA asset must be active");
        assertNotEq(adapter, address(0), "deSPXA must use ChronicleOracleAdapter (not built-in V3)");
        assertEq(
            uint256(venue), uint256(BasketVault.Venue.Aerodrome), "deSPXA venue must be Aerodrome"
        );
    }
}
