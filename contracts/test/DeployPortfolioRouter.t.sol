// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for contracts/script/DeployPortfolioRouter.s.sol
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {DeployPortfolioRouter} from "../script/DeployPortfolioRouter.s.sol";
import {DeployVaultRegistry} from "../script/DeployVaultRegistry.s.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice Minimal ERC-4626-shaped mock vault for router weight tests.
///         Implements `asset()` because PortfolioRouter.setDefaultWeights validates
///         router eligibility by checking `IERC4626(vault).asset() == usdc`.
contract MockVaultForRouter {
    address public immutable asset;

    constructor(address asset_) {
        asset = asset_;
    }
}

/// @dev Exercises DeployPortfolioRouter in-process and asserts post-deploy
///      invariants the smoke-test and downstream tooling rely on.
contract DeployPortfolioRouterTest is Test {
    DeployPortfolioRouter internal script;
    DeployVaultRegistry internal registryScript;
    TestERC20 internal usdc;
    VaultRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal vault;

    function setUp() public {
        script = new DeployPortfolioRouter();
        registryScript = new DeployVaultRegistry();
        usdc = new TestERC20();

        // Deploy a USDC-backed mock vault so PortfolioRouter.setDefaultWeights can
        // validate router eligibility via `IERC4626(vault).asset()`.
        vault = address(new MockVaultForRouter(address(usdc)));

        // Deploy a real VaultRegistry and register the vault so setDefaultWeights
        // can validate via registry.getVault.
        DeployVaultRegistry.Deployed memory reg =
            registryScript.runInProcessWith(admin, vault, address(usdc), "Robot Money USDC");
        registry = reg.registry;
    }

    // ─── Happy path ───────────────────────────────────────────────────────────

    /// @notice Deploy deploys a router with the correct constructor args.
    function test_deploy_routerDeployed() public {
        DeployPortfolioRouter.Deployed memory d =
            script.runInProcessWith(admin, address(registry), vault, address(usdc));

        assertTrue(address(d.router) != address(0), "router not deployed");
        assertEq(address(d.router.usdc()), address(usdc), "usdc mismatch");
        assertEq(address(d.router.registry()), address(registry), "registry mismatch");
    }

    /// @notice Admin holds ADMIN_ROLE on the newly deployed router.
    function test_deploy_adminHasRole() public {
        DeployPortfolioRouter.Deployed memory d =
            script.runInProcessWith(admin, address(registry), vault, address(usdc));

        assertTrue(
            d.router.hasRole(d.router.ADMIN_ROLE(), admin), "admin missing ADMIN_ROLE on router"
        );
    }

    /// @notice Initial weights are 10 000 bps to RobotMoneyVault on the DEFAULT vector, the voted
    ///         vector stays empty and inactive, and the EFFECTIVE routing equals the default (issue 1743).
    function test_deploy_initialWeightsSet() public {
        DeployPortfolioRouter.Deployed memory d =
            script.runInProcessWith(admin, address(registry), vault, address(usdc));

        assertFalse(d.router.votedWeightsActive(), "deploy must not activate a voted vector");
        (address[] memory voted,) = d.router.getWeights();
        assertEq(voted.length, 0, "voted vector must be empty after the router stage");

        (address[] memory vaults, uint256[] memory bps) = d.router.getDefaultWeights();
        assertEq(vaults.length, 1, "expected one vault in the default vector");
        assertEq(vaults[0], vault, "wrong vault in the default vector");
        assertEq(bps.length, 1, "bps length mismatch");
        assertEq(bps[0], 10_000, "expected 10 000 bps to RobotMoneyVault");

        (address[] memory effV, uint256[] memory effB) = d.router.getEffectiveWeights();
        assertEq(effV.length, 1, "effective vector length");
        assertEq(effV[0], vault, "effective vault");
        assertEq(effB[0], 10_000, "effective bps");
    }

    /// @notice setDefaultWeights emits DefaultWeightsSet, and no WeightsSet fires (no voted vector).
    function test_deploy_emitsDefaultWeightsSetAndNoWeightsSet() public {
        address[] memory expectedVaults = new address[](1);
        expectedVaults[0] = vault;
        uint256[] memory expectedBps = new uint256[](1);
        expectedBps[0] = 10_000;

        vm.recordLogs();
        script.runInProcessWith(admin, address(registry), vault, address(usdc));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 defaults;
        for (uint256 i = 0; i < logs.length; i++) {
            require(
                logs[i].topics[0] != PortfolioRouter.WeightsSet.selector,
                "router stage must not emit WeightsSet"
            );
            if (logs[i].topics[0] == PortfolioRouter.DefaultWeightsSet.selector) defaults++;
        }
        assertEq(defaults, 1, "DefaultWeightsSet must fire exactly once");
    }

    /// @notice Issue 1988: no role can clear a voted vector. The deployed router has no `clearVotedWeights()`, so a call
    ///         from ADMIN_ROLE (the timelock), from a WEIGHT_SETTER_ROLE holder or from a stranger reverts, and the vector stays
    ///         active until a newer one replaces it.
    function test_noRoleCanClearTheVotedVector() public {
        DeployPortfolioRouter.Deployed memory d =
            script.runInProcessWith(admin, address(registry), vault, address(usdc));
        address[] memory vs = new address[](1);
        vs[0] = vault;
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        vm.prank(admin);
        d.router.setWeights(vs, bps);
        assertTrue(d.router.votedWeightsActive(), "setWeights activates the voted vector");

        address setterOnly = makeAddr("setterOnly");
        bytes32 setterRole = d.router.WEIGHT_SETTER_ROLE();
        vm.prank(admin);
        d.router.grantRole(setterRole, setterOnly);
        address[3] memory callers = [admin, setterOnly, makeAddr("stranger")];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            (bool ok,) = address(d.router).call(abi.encodeWithSignature("clearVotedWeights()"));
            assertFalse(ok, "no clearVotedWeights selector");
        }
        assertTrue(d.router.votedWeightsActive(), "nothing cleared the voted vector");
        (address[] memory effV, uint256[] memory effB) = d.router.getEffectiveWeights();
        assertEq(effV, vs, "effective vaults are still the applied vector");
        assertEq(effB, bps, "effective bps are still the applied vector");
    }

    /// @notice The ceremony order (issue 1743): the router stage writes the DEFAULT [rmUSDC]/[10000], then a basket stage flips a basket eligible with
    ///         one atomic `migrateEligibility` that re-sets the default to the sheet's launch vector. Effective routing equals that vector and no
    ///         voted vector exists at any point, so a later receipt-driven `setDefaultWeights` changes what deposits route by.
    function test_ceremony_basketFlipAfterRouterStageLeavesEffectiveEqualToTheLaunchVector()
        public
    {
        DeployPortfolioRouter.Deployed memory d =
            script.runInProcessWith(admin, address(registry), vault, address(usdc));
        address basket = address(new MockVaultForRouter(address(usdc)));
        vm.startPrank(admin);
        registry.registerVault(
            basket,
            VaultRegistry.VaultMetadata({
                name: "Robot Money PROTO", asset: address(usdc), registeredAt: 0
            })
        );
        address[] memory vs = new address[](2);
        vs[0] = vault;
        vs[1] = basket;
        uint256[] memory bps = new uint256[](2);
        bps[0] = 9500;
        bps[1] = 500;
        registry.migrateEligibility(basket, true, vs, bps);
        vm.stopPrank();

        assertFalse(d.router.votedWeightsActive(), "no voted vector after the basket stage");
        (address[] memory effV, uint256[] memory effB) = d.router.getEffectiveWeights();
        assertEq(effV, vs, "effective vaults are the launch vector's");
        assertEq(effB, bps, "effective bps are the launch vector 9500/500");

        // the receipt path: setDefaultWeights is what apply-receipt sends; it now changes the effective routing
        uint256[] memory next = new uint256[](2);
        next[0] = 6000;
        next[1] = 4000;
        vm.prank(admin);
        d.router.setDefaultWeights(vs, next);
        (, uint256[] memory afterB) = d.router.getEffectiveWeights();
        assertEq(afterB, next, "a default-weights change moves the effective routing");
    }

    /// @notice The router stage links the registry to the router (core S3): `registry.router()`
    ///         equals the deployed router, and the link event fires exactly once.
    function test_deploy_linksRegistryToRouterExactlyOnce() public {
        vm.recordLogs();
        DeployPortfolioRouter.Deployed memory d =
            script.runInProcessWith(admin, address(registry), vault, address(usdc));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 linked;
        for (uint256 i = 0; i < logs.length; i++) {
            if (
                logs[i].emitter == address(registry)
                    && logs[i].topics[0] == VaultRegistry.RouterSet.selector
            ) {
                linked++;
            }
        }
        assertEq(linked, 1, "registry.setRouter must be called exactly once");
        assertEq(address(registry.router()), address(d.router), "registry.router != router");
    }

    /// @notice Returned struct fields match input parameters.
    function test_deploy_structFieldsMatchInputs() public {
        DeployPortfolioRouter.Deployed memory d =
            script.runInProcessWith(admin, address(registry), vault, address(usdc));

        assertEq(d.admin, admin, "admin field mismatch");
        assertEq(d.vault, vault, "vault field mismatch");
        assertEq(d.usdc, address(usdc), "usdc field mismatch");
        assertEq(address(d.registry), address(registry), "registry field mismatch");
    }

    // ─── Revert cases ─────────────────────────────────────────────────────────

    function test_deploy_revertsOnZeroAdmin() public {
        vm.expectRevert(bytes("ADMIN_ADDRESS=0"));
        script.runInProcessWith(address(0), address(registry), vault, address(usdc));
    }

    function test_deploy_revertsOnZeroRegistry() public {
        vm.expectRevert(bytes("REGISTRY_ADDRESS=0"));
        script.runInProcessWith(admin, address(0), vault, address(usdc));
    }

    function test_deploy_revertsOnZeroVault() public {
        vm.expectRevert(bytes("VAULT_ADDRESS=0"));
        script.runInProcessWith(admin, address(registry), address(0), address(usdc));
    }

    function test_deploy_revertsOnZeroUsdc() public {
        vm.expectRevert(bytes("USDC_ADDRESS=0"));
        script.runInProcessWith(admin, address(registry), vault, address(0));
    }

    /// @notice Deploying with a vault not in the registry reverts (setDefaultWeights
    ///         calls registry.getVault which reverts with NotRegistered).
    function test_deploy_revertsOnUnregisteredVault() public {
        address unregistered = makeAddr("unregistered");
        vm.expectRevert(VaultRegistry.NotRegistered.selector);
        script.runInProcessWith(admin, address(registry), unregistered, address(usdc));
    }
}
