// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for contracts/script/ActivateBasketVaultEligibility.s.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ActivateBasketVaultEligibility} from "../script/ActivateBasketVaultEligibility.s.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice Tests for ActivateBasketVaultEligibility.s.sol.
///
/// The acceptance criteria (issue #692):
///   - Reverts when `BASKET_VAULT_AUDIT_COMPLETE` is not set (passed as false).
///   - Succeeds with `isRouterEligible` returning true for both vaults when
///     `BASKET_VAULT_AUDIT_COMPLETE` is set to "true".
///
/// Uses `runInProcessWith(auditComplete=true/false)` to exercise both paths
/// without requiring env var manipulation inside forge tests.
contract ActivateBasketVaultEligibilityTest is Test {
    ActivateBasketVaultEligibility internal script;
    TestERC20 internal usdc;
    VaultRegistry internal registry;

    address internal admin = address(this);
    address internal protocolVault;
    address internal agentVault;

    function setUp() public {
        script = new ActivateBasketVaultEligibility();
        usdc = new TestERC20();
        registry = new VaultRegistry(admin);

        // Create two mock vault addresses representing the basket vaults.
        // They don't need real vault contracts for registry eligibility tests —
        // VaultRegistry.setRouterEligible only checks registration.
        protocolVault = makeAddr("protocolVault");
        agentVault = makeAddr("agentVault");

        // Register both vaults so setRouterEligible won't revert with NotRegistered.
        registry.registerVault(
            protocolVault,
            VaultRegistry.VaultMetadata({
                name: "Robot Money Protocol", asset: address(usdc), registeredAt: 0
            })
        );
        registry.registerVault(
            agentVault,
            VaultRegistry.VaultMetadata({
                name: "Robot Money Agent Tokens", asset: address(usdc), registeredAt: 0
            })
        );
    }

    // ─── Audit gate: revert path ───────────────────────────────────────────────

    /// @notice The activation script reverts when auditComplete is false.
    ///         This exercises the safety gate that prevents accidental activation
    ///         before the Architecture §4.1 certification checklist is satisfied.
    function test_reverts_when_auditComplete_false() public {
        vm.expectRevert(bytes("BASKET_VAULT_AUDIT_COMPLETE not set - activation blocked"));
        script.runInProcessWith(address(registry), protocolVault, agentVault, false);
    }

    /// @notice Both vaults remain ineligible after the gated revert.
    function test_vaults_stay_ineligible_when_gate_reverts() public {
        // Capture state before attempting gated activation.
        bool protoBefore = registry.isRouterEligible(protocolVault);
        bool agentBefore = registry.isRouterEligible(agentVault);

        try script.runInProcessWith(address(registry), protocolVault, agentVault, false) {} catch {}

        assertEq(registry.isRouterEligible(protocolVault), protoBefore, "proto eligibility changed");
        assertEq(registry.isRouterEligible(agentVault), agentBefore, "agent eligibility changed");
    }

    // ─── Audit gate: success path ──────────────────────────────────────────────

    /// @notice Both vaults become router-eligible after successful activation.
    ///         The test contract is admin (setUp set admin = address(this) and
    ///         deployed registry with that admin), so no prank is needed.
    function test_activates_both_vaults_when_auditComplete_true() public {
        assertFalse(registry.isRouterEligible(protocolVault), "proto should start ineligible");
        assertFalse(registry.isRouterEligible(agentVault), "agent should start ineligible");

        // Grant ADMIN_ROLE to the script so it can call setRouterEligible.
        // In broadcast mode the broadcaster IS admin. In-process, we prank.
        registry.grantRole(registry.ADMIN_ROLE(), address(script));

        script.runInProcessWith(address(registry), protocolVault, agentVault, true);

        assertTrue(
            registry.isRouterEligible(protocolVault), "protocolVault should be router-eligible"
        );
        assertTrue(registry.isRouterEligible(agentVault), "agentVault should be router-eligible");
    }

    /// @notice The returned struct contains the correct vault addresses.
    function test_returned_struct_matches_inputs() public {
        registry.grantRole(registry.ADMIN_ROLE(), address(script));

        ActivateBasketVaultEligibility.Activated memory a =
            script.runInProcessWith(address(registry), protocolVault, agentVault, true);

        assertEq(a.protocolVault, protocolVault, "protocolVault address mismatch");
        assertEq(a.agentVault, agentVault, "agentVault address mismatch");
        assertEq(a.registry, address(registry), "registry address mismatch");
    }

    /// @notice `routerEligibleCount` increments by 2 after activating both vaults.
    function test_routerEligibleCount_increments_by_two() public {
        registry.grantRole(registry.ADMIN_ROLE(), address(script));

        uint256 countBefore = registry.routerEligibleCount();
        script.runInProcessWith(address(registry), protocolVault, agentVault, true);
        assertEq(
            registry.routerEligibleCount(), countBefore + 2, "routerEligibleCount should be +2"
        );
    }

    // ─── Zero-address guards ───────────────────────────────────────────────────

    function test_reverts_on_zero_registry() public {
        vm.expectRevert(bytes("registry=0"));
        script.runInProcessWith(address(0), protocolVault, agentVault, true);
    }

    function test_reverts_on_zero_protocolVault() public {
        vm.expectRevert(bytes("protocolVault=0"));
        script.runInProcessWith(address(registry), address(0), agentVault, true);
    }

    function test_reverts_on_zero_agentVault() public {
        vm.expectRevert(bytes("agentVault=0"));
        script.runInProcessWith(address(registry), protocolVault, address(0), true);
    }
}
