// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (basket vault production path)
//            docs/prd.md §11.2 — Protocol Asset Vault (rmPROTO)
//            docs/prd.md §11.3 — Agent Token Vault (rmAGENT)
//            docs/development/single-production-codebase.md — router eligibility
//            is registry state, not a per-environment code variant.
//
// This script calls `VaultRegistry.setRouterEligible` for both basket vaults
// (ProtocolAssetVault and AgentTokenVault). It is intentionally separate from
// the deploy scripts. No env flag gates it: the broadcaster must hold ADMIN_ROLE
// on the registry, and the operator runs it only after the Architecture §4.1
// certification checklist is satisfied.
//
// Execution sequence:
//   1. Deploy ProtocolAssetVault  (DeployProtocolAssetVault.s.sol)
//   2. Deploy AgentTokenVault     (DeployAgentTokenVault.s.sol)
//   3. Register both vaults in VaultRegistry (done by the deploy scripts)
//   4. Audit + certify pool cardinality, per-asset TWAP windows, rebalancing model
//   5. Run this script to activate router eligibility for both basket vaults
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";
import {console2} from "forge-std/console2.sol";

import {VaultRegistry} from "../VaultRegistry.sol";

/// @title ActivateBasketVaultEligibility
/// @notice Calls `VaultRegistry.setRouterEligible(vault, true)` for both
///         `ProtocolAssetVault` (rmPROTO) and `AgentTokenVault` (rmAGENT).
///
///         Required env vars:
///           EXPECTED_CHAIN_ID           — mandatory and equal to 8453 on Base mainnet
///           REGISTRY_ADDRESS            — deployed VaultRegistry
///           PROTOCOL_VAULT_ADDRESS      — deployed ProtocolAssetVault (rmPROTO)
///           AGENT_VAULT_ADDRESS         — deployed AgentTokenVault (rmAGENT)
///
///         The broadcaster must hold ADMIN_ROLE on the VaultRegistry.
contract ActivateBasketVaultEligibility is ExpectedChainGuard {
    /// @notice Result returned to in-process callers (e.g. forge tests).
    struct Activated {
        address protocolVault;
        address agentVault;
        address registry;
    }

    /// @notice Forge broadcast entrypoint. Reads env vars and calls `setRouterEligible(true)` for both basket vaults.
    function run() external returns (Activated memory a) {
        _requireExpectedChain("");

        address registry = _envAddressRequired("REGISTRY_ADDRESS");
        address protocolVault = _envAddressRequired("PROTOCOL_VAULT_ADDRESS");
        address agentVault = _envAddressRequired("AGENT_VAULT_ADDRESS");

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

    function runInProcessWith(
        address registry_,
        address protocolVault_,
        address agentVault_
    ) external returns (Activated memory a) {
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
}
