// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (basket vault production path)
//            docs/prd.md §11.2 — Protocol Asset Vault (rmPROTO)
//            docs/prd.md §11.3 — Agent Token Vault (rmAGENT)
//            docs/development/single-production-codebase.md — router eligibility
//            is registry state, not a per-environment code variant.
//
// This script calls `VaultRegistry.setRouterEligible` for both basket vaults
// (ProtocolAssetVault and AgentTokenVault). It is intentionally separate from
// the deploy scripts and is gated behind a `BASKET_VAULT_AUDIT_COMPLETE` env
// flag that must be set to "true" only after the Architecture §4.1 certification
// checklist is satisfied and both contracts have passed external audit.
//
// Execution sequence:
//   1. Deploy ProtocolAssetVault  (DeployProtocolAssetVault.s.sol)
//   2. Deploy AgentTokenVault     (DeployAgentTokenVault.s.sol)
//   3. Register both vaults in VaultRegistry (done by the deploy scripts)
//   4. Audit + certify pool cardinality, per-asset TWAP windows, rebalancing model
//   5. Set BASKET_VAULT_AUDIT_COMPLETE=true
//   6. Run this script to activate router eligibility for both basket vaults
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {VaultRegistry} from "../VaultRegistry.sol";

/// @title ActivateBasketVaultEligibility
/// @notice Calls `VaultRegistry.setRouterEligible(vault, true)` for both
///         `ProtocolAssetVault` (rmPROTO) and `AgentTokenVault` (rmAGENT).
///
///         SAFETY GATE: the script reverts unless `BASKET_VAULT_AUDIT_COMPLETE`
///         env var is set to exactly `"true"`. This prevents accidental execution
///         before the Architecture §4.1 certification checklist is satisfied.
///
///         Required env vars:
///           BASKET_VAULT_AUDIT_COMPLETE — must be "true" (reverts otherwise)
///           REGISTRY_ADDRESS            — deployed VaultRegistry
///           PROTOCOL_VAULT_ADDRESS      — deployed ProtocolAssetVault (rmPROTO)
///           AGENT_VAULT_ADDRESS         — deployed AgentTokenVault (rmAGENT)
///
///         The broadcaster must hold ADMIN_ROLE on the VaultRegistry.
contract ActivateBasketVaultEligibility is Script {
    /// @notice Result returned to in-process callers (e.g. forge tests).
    struct Activated {
        address protocolVault;
        address agentVault;
        address registry;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars, validates the audit
    ///         gate, and calls `setRouterEligible(true)` for both basket vaults.
    function run() external returns (Activated memory a) {
        // Audit gate: revert unless the operator has explicitly set the flag.
        _requireAuditComplete();

        address registry = vm.envAddress("REGISTRY_ADDRESS");
        address protocolVault = vm.envAddress("PROTOCOL_VAULT_ADDRESS");
        address agentVault = vm.envAddress("AGENT_VAULT_ADDRESS");

        require(registry != address(0), "REGISTRY_ADDRESS=0");
        require(protocolVault != address(0), "PROTOCOL_VAULT_ADDRESS=0");
        require(agentVault != address(0), "AGENT_VAULT_ADDRESS=0");

        vm.startBroadcast();
        a = _activate(VaultRegistry(registry), protocolVault, agentVault);
        vm.stopBroadcast();

        console2.log("ActivateBasketVaultEligibility complete");
        console2.log("  protocolVault router-eligible:", protocolVault);
        console2.log("  agentVault    router-eligible:", agentVault);
    }

    /// @notice In-process variant for forge tests. No broadcast. Caller must
    ///         prank admin or call from a context that holds ADMIN_ROLE.
    ///
    ///         `auditComplete` is passed explicitly so tests can exercise both
    ///         the gated path (true) and the revert path (false) without setting
    ///         env vars.
    function runInProcessWith(
        address registry_,
        address protocolVault_,
        address agentVault_,
        bool auditComplete
    ) external returns (Activated memory a) {
        require(auditComplete, "BASKET_VAULT_AUDIT_COMPLETE not set - activation blocked");
        require(registry_ != address(0), "registry=0");
        require(protocolVault_ != address(0), "protocolVault=0");
        require(agentVault_ != address(0), "agentVault=0");

        return _activate(VaultRegistry(registry_), protocolVault_, agentVault_);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Activate router eligibility for both basket vaults. Caller must
    ///      hold ADMIN_ROLE on the registry.
    function _activate(VaultRegistry registry, address protocolVault, address agentVault)
        internal
        returns (Activated memory a)
    {
        registry.setRouterEligible(protocolVault, true);
        registry.setRouterEligible(agentVault, true);
        a.protocolVault = protocolVault;
        a.agentVault = agentVault;
        a.registry = address(registry);
    }

    /// @dev Revert unless `BASKET_VAULT_AUDIT_COMPLETE` env var equals "true".
    ///      This guards the broadcast path so the operator cannot accidentally
    ///      activate eligibility before the Architecture §4.1 checklist is done.
    function _requireAuditComplete() internal view {
        string memory flag;
        try vm.envString("BASKET_VAULT_AUDIT_COMPLETE") returns (string memory v) {
            flag = v;
        } catch {
            revert("BASKET_VAULT_AUDIT_COMPLETE not set - activation blocked");
        }
        require(
            keccak256(bytes(flag)) == keccak256(bytes("true")),
            "BASKET_VAULT_AUDIT_COMPLETE not set - activation blocked"
        );
    }
}
