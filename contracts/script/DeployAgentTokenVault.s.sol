// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0001-mvp-agent-token-shortlist.md;
//            docs/prd.md §11.3 — Agent Token Vault;
//            docs/architecture.md §4.1 — Vault Family (agent-token basket)
//
// This script deploys `AgentTokenVault` and registers it in `VaultRegistry`.
// It intentionally does NOT call `setRouterEligible`: that step is separated into
// `ActivateBasketVaultEligibility.s.sol` and is gated behind a
// `BASKET_VAULT_AUDIT_COMPLETE` env flag that must be set only after the
// Architecture §4.1 certification checklist is satisfied and the contract has
// passed audit.
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

/// @title DeployAgentTokenVault
/// @notice Deploys `AgentTokenVault` and seeds it with the active three-token
///         demo shortlist: BNKR, JUNO, RM. Token, pool, adapter, and
///         venue data are read from `config/agent-token-shortlist.json`; no
///         token address is hardcoded in Solidity source.
///
///         Chain selection: `block.chainid == 8453` (Base mainnet) reads the
///         `mainnet` block of the config. Any other chain id reads stand-in
///         ERC20 + pool addresses from `DEVNET_AGENT_TOKEN_<SYMBOL>` /
///         `DEVNET_AGENT_POOL_<SYMBOL>` / `DEVNET_AGENT_FEE_<SYMBOL>` /
///         `DEVNET_AGENT_ADAPTER_<SYMBOL>` env
///         overrides, matching the single-production-codebase principle: the
///         same script ships everywhere, only the address source differs.
///
///         Required env vars:
///           ADMIN_ADDRESS              — receives ADMIN_ROLE on the vault and
///                                        must hold ADMIN_ROLE on VaultRegistry
///           EMERGENCY_RESPONDER_ADDRESS — receives EMERGENCY_ROLE on the vault
///                                        (hot key for rapid unwind/shutdown);
///                                        use a distinct address from ADMIN_ADDRESS
///                                        in production for two-role key separation
///           SWAP_ROUTER                — Uniswap V3 SwapRouter02
///           USDC_ADDRESS               — ERC-20 asset the vault denominates in
///
///         Optional env vars:
///           REGISTRY_ADDRESS  — when set, the vault is registered here as
///                               "Robot Money Agent Tokens" (the same path the
///                               demo seed and dapp Portfolio Explorer use)
///           CONFIG_PATH       — shortlist config path
///                               (default: config/agent-token-shortlist.json)
///           DEPLOYMENT_OUT    — output JSON path
///                               (default: deployments/agent-token-vault-<chain_id>.json)
contract DeployAgentTokenVault is Script {
    using stdJson for string;

    /// @notice Active shortlist symbols in deploy order.
    ///         Ordering is load-bearing: AgentTokenVault.shortlist() returns
    ///         tokens in this order, and the dapp/tests assert on it.
    string[3] internal SYMBOLS = ["BNKR", "JUNO", "RM"];

    /// @notice TVL/per-deposit caps mirrored from the other demo vaults.
    uint256 public constant TVL_CAP = 10_000_000 * 1e6;
    uint256 public constant PER_DEPOSIT_CAP = 1_000_000 * 1e6;

    /// @notice A single resolved shortlist entry.
    struct Entry {
        string symbol;
        address token;
        address pool;
        uint24 swapFee;
        address adapter;
        BasketVault.Venue venue;
    }

    /// @notice Result returned to in-process callers (e.g. forge tests).
    struct Deployed {
        address vault;
        address[] tokens;
        /// @dev True when the vault was registered in VaultRegistry during this
        ///      run (REGISTRY_ADDRESS was set and the vault was not already
        ///      registered). Router eligibility is NOT activated here — see
        ///      ActivateBasketVaultEligibility.s.sol.
        bool registered;
    }

    /// @notice Broadcast entrypoint. Deploys the vault, seeds the three-token
    ///         shortlist, optionally registers it, and writes a deployment JSON.
    function run() external returns (Deployed memory d) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address emergencyResponder = vm.envAddress("EMERGENCY_RESPONDER_ADDRESS");
        address swapRouter = vm.envAddress("SWAP_ROUTER");
        address usdc = vm.envAddress("USDC_ADDRESS");
        require(admin != address(0), "ADMIN_ADDRESS=0");
        require(emergencyResponder != address(0), "EMERGENCY_RESPONDER_ADDRESS=0");
        require(swapRouter != address(0), "SWAP_ROUTER=0");
        require(usdc != address(0), "USDC_ADDRESS=0");

        Entry[3] memory entries = _resolveShortlist();

        vm.startBroadcast();
        d = _deployAndSeed(admin, emergencyResponder, swapRouter, usdc, entries);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
        console2.log("DeployAgentTokenVault complete:", d.vault);
    }

    /// @dev Deploys the vault, adds each shortlist asset (in config order), and
    ///      registers the vault if REGISTRY_ADDRESS is set.
    function _deployAndSeed(
        address admin,
        address emergencyResponder,
        address swapRouter,
        address usdc,
        Entry[3] memory entries
    ) internal returns (Deployed memory d) {
        AgentTokenVault vault = new AgentTokenVault(
            IERC20(usdc),
            ISwapRouter(swapRouter),
            TVL_CAP,
            PER_DEPOSIT_CAP,
            0,
            admin,
            admin,
            emergencyResponder
        );

        d.vault = address(vault);
        d.tokens = new address[](entries.length);
        for (uint256 i = 0; i < entries.length; i++) {
            vault.addAsset(
                entries[i].token,
                entries[i].pool,
                entries[i].swapFee,
                entries[i].adapter,
                entries[i].venue
            );
            d.tokens[i] = entries[i].token;
        }

        address registry = _envAddressOrZero("REGISTRY_ADDRESS");
        if (registry != address(0)) {
            _registerIfAbsent(VaultRegistry(registry), address(vault), usdc);
            d.registered = true;
        }
    }

    /// @dev Resolve the three shortlist entries from config (mainnet) or env
    ///      overrides (devnet), selected by chain id.
    function _resolveShortlist() internal view returns (Entry[3] memory entries) {
        bool isMainnet = block.chainid == 8453;
        string memory json = isMainnet ? _readConfig() : "";

        for (uint256 i = 0; i < SYMBOLS.length; i++) {
            string memory sym = SYMBOLS[i];
            entries[i].symbol = sym;
            if (isMainnet) {
                string memory base = string.concat(".mainnet.shortlist[", vm.toString(i), "]");
                entries[i].token = json.readAddress(string.concat(base, ".token"));
                entries[i].pool = json.readAddress(string.concat(base, ".pool"));
                entries[i].swapFee = uint24(json.readUint(string.concat(base, ".swapFee")));
                entries[i].adapter = json.readAddress(string.concat(base, ".adapter"));
                entries[i].venue = _venueFromString(json.readString(string.concat(base, ".venue")));
                require(entries[i].token != address(0), "mainnet token unset in config");
                require(entries[i].pool != address(0), "mainnet pool unset in config");
                if (entries[i].venue != BasketVault.Venue.V3) {
                    require(entries[i].adapter != address(0), "mainnet adapter unset in config");
                }
            } else {
                entries[i].token = vm.envAddress(string.concat("DEVNET_AGENT_TOKEN_", sym));
                entries[i].pool = vm.envAddress(string.concat("DEVNET_AGENT_POOL_", sym));
                entries[i].swapFee =
                    uint24(_envUintOrDefault(string.concat("DEVNET_AGENT_FEE_", sym), 10_000));
                entries[i].adapter = _envAddressOrZero(string.concat("DEVNET_AGENT_ADAPTER_", sym));
                entries[i].venue = i == 0
                    ? BasketVault.Venue.V3
                    : i == 1 ? BasketVault.Venue.V4 : BasketVault.Venue.Aerodrome;
                require(entries[i].token != address(0), "devnet token override unset");
                require(entries[i].pool != address(0), "devnet pool override unset");
                if (entries[i].venue != BasketVault.Venue.V3) {
                    require(entries[i].adapter != address(0), "devnet adapter override unset");
                }
            }
        }
    }

    function _venueFromString(string memory value) internal pure returns (BasketVault.Venue) {
        bytes32 venueHash = keccak256(bytes(value));
        if (venueHash == keccak256("V3")) return BasketVault.Venue.V3;
        if (venueHash == keccak256("V4")) return BasketVault.Venue.V4;
        if (venueHash == keccak256("Aerodrome")) return BasketVault.Venue.Aerodrome;
        revert("unsupported venue");
    }

    function _readConfig() internal view returns (string memory) {
        string memory path = _envStringOrDefault("CONFIG_PATH", "config/agent-token-shortlist.json");
        return vm.readFile(path);
    }

    function _registerIfAbsent(VaultRegistry registry, address vault, address asset) internal {
        address[] memory existing = registry.listVaults();
        for (uint256 i = 0; i < existing.length; i++) {
            if (existing[i] == vault) {
                console2.log("DeployAgentTokenVault: vault already registered, skipping");
                return;
            }
        }
        registry.registerVault(
            vault,
            VaultRegistry.VaultMetadata({
                name: "Robot Money Agent Tokens", asset: asset, registeredAt: 0
            })
        );
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringOrDefault(
            "DEPLOYMENT_OUT",
            string.concat("deployments/agent-token-vault-", vm.toString(block.chainid), ".json")
        );
        string memory obj = "agent_token_vault_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        string memory json = vm.serializeAddress(obj, "vault", d.vault);
        vm.writeJson(json, outPath);
        console2.log("Wrote agent-token-vault deployment JSON to", outPath);
    }

    // ─── env helpers ──────────────────────────────────────────────────────

    function _envAddressOrZero(string memory key) internal view returns (address) {
        try vm.envAddress(key) returns (address v) {
            return v;
        } catch {
            return address(0);
        }
    }

    function _envUintOrDefault(string memory key, uint256 fallback_)
        internal
        view
        returns (uint256)
    {
        try vm.envUint(key) returns (uint256 v) {
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
