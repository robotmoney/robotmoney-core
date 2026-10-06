// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (protocol-asset basket)
//            docs/prd.md §11.2 — Protocol Asset Vault (rmPROTO)
//            docs/development/single-production-codebase.md — router eligibility
//            is registry state set by ADMIN_ROLE, not a per-environment code variant.
//
// This script deploys `ProtocolAssetVault` and registers it in `VaultRegistry`.
// It intentionally does NOT call `setRouterEligible`: that step is separated into
// `ActivateBasketVaultEligibility.s.sol` and is gated behind a
// `BASKET_VAULT_AUDIT_COMPLETE` env flag that must be set only after the
// Architecture §4.1 certification checklist (pool cardinality, per-asset TWAP
// windows, intra-vault rebalancing model) is satisfied and the contract has
// passed audit.
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title DeployProtocolAssetVault
/// @notice Production deploy script for `ProtocolAssetVault` (PRD §11.2 — rmPROTO).
///         Deploys the vault, registers it in `VaultRegistry`, and emits the
///         deployed address. Router eligibility activation is intentionally
///         separated into `ActivateBasketVaultEligibility.s.sol`.
///
///         Required env vars:
///           ADMIN_ADDRESS              — receives ADMIN_ROLE on the vault and
///                                        must hold ADMIN_ROLE on VaultRegistry
///           EMERGENCY_RESPONDER_ADDRESS — receives EMERGENCY_ROLE on the vault;
///                                        use a distinct address from ADMIN_ADDRESS
///                                        in production for two-role key separation
///           SWAP_ROUTER                — Uniswap V3 SwapRouter02
///           USDC_ADDRESS               — ERC-20 asset the vault denominates in
///
///           TVL_CAP                    — USDC TVL ceiling
///           PER_DEPOSIT_CAP            — USDC per-deposit ceiling
///           EXIT_FEE_BPS               — exit fee in basis points
///           FEE_RECIPIENT              — recipient for exit fees
///
///         On chain id 8453, EXPECTED_CHAIN_ID must be set to 8453 and USDC_ADDRESS must
///         be the canonical Base USDC. No input has a default on any chain.
///
///         Optional env vars:
///           REGISTRY_ADDRESS  — when set, the vault is registered here as
///                               "Robot Money Protocol" (VaultMetadata.name)
///           DEPLOYMENT_OUT    — output JSON path
///                               (default: deployments/protocol-asset-vault-<chain_id>.json)
contract DeployProtocolAssetVault is ExpectedChainGuard {
    using stdJson for string;

    /// @notice Default TVL cap: 10M USDC (6 decimals).
    uint256 public constant DEFAULT_TVL_CAP = 10_000_000 * 1e6;

    /// @notice Default per-deposit cap: 1M USDC (6 decimals).
    uint256 public constant DEFAULT_PER_DEPOSIT_CAP = 1_000_000 * 1e6;

    /// @notice Vault name registered in VaultRegistry.
    string public constant VAULT_NAME = "Robot Money Protocol";

    /// @notice Result returned to in-process callers (e.g. forge tests).
    struct Deployed {
        address vault;
        address registry;
        bool registered;
    }

    /// @notice The sheet inputs of `run()`, all required.
    struct Params {
        address admin;
        address emergencyResponder;
        address swapRouter;
        address usdc;
        uint256 tvlCap;
        uint256 perDepositCap;
        uint256 exitFeeBps;
        address feeRecipient;
    }

    /// @notice Forge broadcast entrypoint. Deploys the vault, optionally
    ///         registers it in VaultRegistry, and writes a deployment JSON.
    function run() external returns (Deployed memory d) {
        Params memory p = _readParamsFrom("");

        vm.startBroadcast();
        d = _deployAndRegister(
            p.admin,
            p.emergencyResponder,
            p.swapRouter,
            p.usdc,
            p.tvlCap,
            p.perDepositCap,
            p.exitFeeBps,
            p.feeRecipient
        );
        vm.stopBroadcast();

        _writeDeploymentJson(d);
        console2.log("DeployProtocolAssetVault complete:", d.vault);
        if (d.registered) {
            console2.log("  registered in VaultRegistry:", d.registry);
        }
    }

    /// @dev Reads and checks every input. `prefix` is "" in production; tests pass their own
    ///      because env vars are process-wide and forge runs tests in parallel.
    function _readParamsFrom(string memory prefix) internal view returns (Params memory p) {
        _requireExpectedChain(prefix);
        p.admin = _envAddressRequired(string.concat(prefix, "ADMIN_ADDRESS"));
        p.emergencyResponder =
            _envAddressRequired(string.concat(prefix, "EMERGENCY_RESPONDER_ADDRESS"));
        p.swapRouter = _envAddressRequired(string.concat(prefix, "SWAP_ROUTER"));
        p.usdc = _envAddressRequired(string.concat(prefix, "USDC_ADDRESS"));
        require(p.admin != address(0), "ADMIN_ADDRESS=0");
        require(p.emergencyResponder != address(0), "EMERGENCY_RESPONDER_ADDRESS=0");
        require(p.swapRouter != address(0), "SWAP_ROUTER=0");
        require(p.usdc != address(0), "USDC_ADDRESS=0");
        _requireCanonicalUsdc(p.usdc);

        p.tvlCap = _envUintRequired(string.concat(prefix, "TVL_CAP"));
        p.perDepositCap = _envUintRequired(string.concat(prefix, "PER_DEPOSIT_CAP"));
        p.exitFeeBps = _envUintRequired(string.concat(prefix, "EXIT_FEE_BPS"));
        p.feeRecipient = _envAddressRequired(string.concat(prefix, "FEE_RECIPIENT"));
        require(p.feeRecipient != address(0), "FEE_RECIPIENT=0");
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    ///         Caller must ensure the call context holds ADMIN_ROLE on the registry
    ///         (or pass admin_ as the test contract so startPrank can be used).
    function runInProcessWith(
        address admin_,
        address emergencyResponder_,
        address swapRouter_,
        address usdc_,
        address registry_
    ) external returns (Deployed memory d) {
        require(admin_ != address(0), "admin=0");
        require(emergencyResponder_ != address(0), "emergencyResponder=0");
        require(swapRouter_ != address(0), "swapRouter=0");
        require(usdc_ != address(0), "usdc=0");

        d = _deployAndRegister(
            admin_,
            emergencyResponder_,
            swapRouter_,
            usdc_,
            DEFAULT_TVL_CAP,
            DEFAULT_PER_DEPOSIT_CAP,
            0,
            admin_
        );

        if (registry_ != address(0)) {
            vm.startPrank(admin_);
            _registerIfAbsent(VaultRegistry(registry_), d.vault, usdc_);
            vm.stopPrank();
            d.registry = registry_;
            d.registered = true;
        }

        console2.log("DeployProtocolAssetVault (in-process):", d.vault);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _deployAndRegister(
        address admin,
        address emergencyResponder,
        address swapRouter,
        address usdc,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient
    ) internal returns (Deployed memory d) {
        ProtocolAssetVault vault = new ProtocolAssetVault(
            IERC20(usdc),
            ISwapRouter(swapRouter),
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
        d.vault = address(vault);

        address registry = _envAddressOrDefault("REGISTRY_ADDRESS", address(0));
        if (registry != address(0)) {
            _registerIfAbsent(VaultRegistry(registry), address(vault), usdc);
            d.registry = registry;
            d.registered = true;
        }
    }

    /// @dev Register `vault` in the registry if not already present.
    ///      Caller must hold ADMIN_ROLE on the registry.
    function _registerIfAbsent(VaultRegistry registry, address vault, address asset) internal {
        address[] memory existing = registry.listVaults();
        for (uint256 i = 0; i < existing.length; i++) {
            if (existing[i] == vault) {
                console2.log("DeployProtocolAssetVault: vault already registered, skipping");
                return;
            }
        }
        registry.registerVault(
            vault, VaultRegistry.VaultMetadata({name: VAULT_NAME, asset: asset, registeredAt: 0})
        );
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringOrDefault(
            "DEPLOYMENT_OUT",
            string.concat("deployments/protocol-asset-vault-", vm.toString(block.chainid), ".json")
        );
        string memory obj = "protocol_asset_vault_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "vault", d.vault);
        vm.serializeAddress(obj, "registry", d.registry);
        string memory json = vm.serializeBool(obj, "registered", d.registered);
        vm.writeJson(json, outPath);
        console2.log("Wrote protocol-asset-vault deployment JSON to", outPath);
    }

    // ─── env helpers ──────────────────────────────────────────────────────────

    function _envAddressOrDefault(string memory key, address fallback_)
        internal
        view
        returns (address)
    {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return fallback_;
        }
    }

    function _envStringOrDefault(string memory key, string memory fallback_)
        internal
        view
        returns (string memory)
    {
        try vm.envString(key) returns (string memory v) {
            if (bytes(v).length > 0) return v;
            return fallback_;
        } catch {
            return fallback_;
        }
    }
}
