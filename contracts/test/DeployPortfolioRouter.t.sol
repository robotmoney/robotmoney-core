// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for contracts/script/DeployPortfolioRouter.s.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployPortfolioRouter} from "../script/DeployPortfolioRouter.s.sol";
import {DeployVaultRegistry} from "../script/DeployVaultRegistry.s.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice Minimal ERC-4626-shaped mock vault for router weight tests.
///         Only implements the subset required by PortfolioRouter.setWeights
///         (which calls registry.getVault to validate, not the vault itself).
contract MockVaultForRouter {}

/// @dev Exercises DeployPortfolioRouter in-process and asserts post-deploy
///      invariants the smoke-test and downstream tooling rely on.
contract DeployPortfolioRouterTest is Test {
    DeployPortfolioRouter internal script;
    DeployVaultRegistry internal registryScript;
    TestERC20 internal usdc;
    VaultRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal vault = makeAddr("vault");

    function setUp() public {
        script = new DeployPortfolioRouter();
        registryScript = new DeployVaultRegistry();
        usdc = new TestERC20();

        // Deploy a real VaultRegistry and register the vault so setWeights
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

    /// @notice Initial weights are 10 000 bps to RobotMoneyVault.
    function test_deploy_initialWeightsSet() public {
        DeployPortfolioRouter.Deployed memory d =
            script.runInProcessWith(admin, address(registry), vault, address(usdc));

        (address[] memory vaults, uint256[] memory bps) = d.router.getWeights();

        assertEq(vaults.length, 1, "expected one vault in weight vector");
        assertEq(vaults[0], vault, "wrong vault in weight vector");
        assertEq(bps.length, 1, "bps length mismatch");
        assertEq(bps[0], 10_000, "expected 10 000 bps to RobotMoneyVault");
    }

    /// @notice setWeights emits WeightsSet event with the correct args.
    function test_deploy_emitsWeightsSet() public {
        address[] memory expectedVaults = new address[](1);
        expectedVaults[0] = vault;
        uint256[] memory expectedBps = new uint256[](1);
        expectedBps[0] = 10_000;

        vm.expectEmit(false, false, false, true);
        emit PortfolioRouter.WeightsSet(expectedVaults, expectedBps);
        script.runInProcessWith(admin, address(registry), vault, address(usdc));
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

    /// @notice Deploying with a vault not in the registry reverts (setWeights
    ///         calls registry.getVault which reverts with NotRegistered).
    function test_deploy_revertsOnUnregisteredVault() public {
        address unregistered = makeAddr("unregistered");
        vm.expectRevert(VaultRegistry.NotRegistered.selector);
        script.runInProcessWith(admin, address(registry), unregistered, address(usdc));
    }
}
