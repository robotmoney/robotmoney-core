// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0002-router-default-weights-on-chain.md — demo seed
//            populates a non-empty defaultWeights vector so the allocation
//            surface renders with no governance activity.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployDemoExtraVaults} from "../script/DeployDemoExtraVaults.s.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";
import {AdapterBytecodeGuard} from "../script/AdapterBytecodeGuard.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice Integration test for the demo seed path: after `DeployDemoExtraVaults`
///         runs, the router carries a non-empty default (below-quorum fallback)
///         weight vector spanning the three demo vaults, and `previewDeposit`
///         routes by that vector with no governance activity. ADR-0002.
contract DeployDemoExtraVaultsTest is Test {
    DeployDemoExtraVaults internal script;
    TestERC20 internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RobotMoneyVault internal primaryVault;

    // The test contract is the broadcaster/admin (mirrors Deploy.t.sol's
    // in-process pattern), so it must hold ADMIN_ROLE on registry + router.
    address internal admin = address(this);

    uint256 constant W_PRIMARY = 5_000;
    uint256 constant W_EXTRA1 = 3_000;
    uint256 constant W_EXTRA2 = 2_000;

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

    /// @notice After the demo seed runs, the router's default weight vector is
    ///         the non-empty three-way split, and `previewDeposit` with no
    ///         governance activity (voted vector inactive) routes by it.
    function test_demo_seed_populates_defaultWeights() public {
        // The script is the in-process broadcaster, so it must be admin on the
        // vaults it deploys + wires (addAdapter etc.). In the real broadcast
        // flow the broadcaster key IS p.admin; in-process we mirror that by
        // making the script the admin.
        DeployDemoExtraVaults.Params memory p = DeployDemoExtraVaults.Params({
            admin: address(script),
            registry: address(registry),
            router: address(router),
            primaryVault: address(primaryVault),
            usdc: address(usdc),
            swapRouter: 0x2626664c2603336E57B271c5C0b26F421741e481,
            wPrimary: W_PRIMARY,
            wExtra1: W_EXTRA1,
            wExtra2: W_EXTRA2,
            name1: "Robot Money Demo Vault A",
            name2: "Robot Money Demo Vault B",
            rwaName: "Robot Money RWA / Thematic"
        });

        DeployDemoExtraVaults.Deployed memory d = script.runInProcess(p);

        // Default vector is non-empty and spans all three demo vaults.
        (address[] memory dV, uint256[] memory dB) = router.getDefaultWeights();
        assertEq(dV.length, 3, "default vector must span three vaults");
        assertEq(dV[0], address(primaryVault), "leg 0 = primary vault");
        assertEq(dV[1], d.vault1, "leg 1 = extra vault A");
        assertEq(dV[2], d.vault2, "leg 2 = extra vault B");
        assertEq(dB[0], W_PRIMARY);
        assertEq(dB[1], W_EXTRA1);
        assertEq(dB[2], W_EXTRA2);
        uint256 sum = dB[0] + dB[1] + dB[2];
        assertEq(sum, 10_000, "default weights must sum to 10000 bps");

        // Registry router-eligible count matches the default vector length, so
        // the stale-length guard is satisfied.
        assertEq(registry.routerEligibleCount(), 3);

        // Represent the "no governance activity" (below-quorum) state: the
        // voted vector is not in effect. The demo also seeds a voted vector for
        // the legacy AC3 smoke test, so clear it to observe the fallback.
        router.clearVotedWeights();
        assertFalse(router.votedWeightsActive());

        // previewDeposit now routes by the default vector and is non-empty.
        PortfolioRouter.LegPreview[] memory legs = router.previewDeposit(1_000e6);
        assertEq(legs.length, 3, "preview must have three legs");
        assertEq(legs[0].weightBps, W_PRIMARY);
        assertEq(legs[1].weightBps, W_EXTRA1);
        assertEq(legs[2].weightBps, W_EXTRA2);
        assertEq(legs[0].legAmount, 500e6);
        assertEq(legs[1].legAmount, 300e6);
        assertEq(legs[2].legAmount, 200e6);
    }
}
