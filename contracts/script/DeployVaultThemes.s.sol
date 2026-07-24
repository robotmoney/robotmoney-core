// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0010-unified-vault-architecture.md §7 (themes are
//            deployments, not subclasses),
//            docs/technical/unified-vault-spec.md §8 (theme deployment table +
//            constructor + post-deploy ADMIN configuration),
//            docs/technical/unified-vault-open-questions-resolution.md.
//
// Per-theme deploy scripts for the unified `Vault` (ADR-0010). Every theme
// (rmUSDC / rmPROTO / rmAGENT / rmRWA) is ONE deployment of the single
// non-abstract `contracts/Vault.sol` composed with a THEME-SPECIFIC adapter set
// and parameters — never a subclass. This script replaces the four
// subclass-specific deploy scripts (DeployProtocolAssetVault / DeployAgentToken
// Vault / RwaVault / RobotMoneyVault) with one parameterized deployer.
//
// The old fixed-length-4 weight-array assumption is gone: each theme wires a
// VARIABLE-LENGTH adapter set (rmUSDC 3 lending adapters, rmPROTO 3 V3 asset
// adapters, rmAGENT 3 mixed-venue adapters, rmRWA a SINGLE Chronicle adapter),
// so the per-theme weight (`capBps`) array length varies per theme.
//
// Adapter INSTANCES (UniswapV3/V4 / Aerodrome / Chronicle AssetPositionAdapters,
// or the retrofit lending adapters) are deployed by their own scripts and bound
// to the vault at construction (`VAULT()` identity, ADR-0010 §2); this script
// consumes their addresses + the vault-attested `isExact` bool + `capBps` weight
// as an `AdapterSpec[]` and wires them through the full eligibility gate
// (allowlist + codehash pin + `addAdapter`, spec §5.1/C2). Mainnet deployment
// and the registry/router eligibility interlock (ADR-0010 §8, Phase 6) are OUT
// OF SCOPE here and handled by their own issues.
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {Vault} from "../Vault.sol";

/// @title DeployVaultThemes
/// @notice Parameterized per-theme deployer for the unified `Vault` (ADR-0010 §7,
///         spec §8). Exposes the theme matrix, the vault constructor call, the
///         variable-length adapter-set wiring, the rmAGENT per-theme
///         `TimelockController` handoff, and the rmRWA active-adapter-count cap.
contract DeployVaultThemes is Script {
    /// @notice The four unified-vault themes (ADR-0010 §7). Each is one `Vault`
    ///         deployment distinguished only by its parameters + adapter set.
    enum Theme {
        RM_USDC,
        RM_PROTO,
        RM_AGENT,
        RM_RWA
    }

    /// @notice One adapter to register: its (pre-deployed, vault-bound) address,
    ///         its per-adapter `capBps` allocation weight, and the VAULT-ATTESTED
    ///         `isExact` flag ADMIN pins at `addAdapter` (spec §5.1, C2). The
    ///         array of these is the per-theme VARIABLE-LENGTH weight set.
    struct AdapterSpec {
        address adapter;
        uint16 capBps;
        bool isExact;
    }

    /// @notice The non-theme (deployment-environment) parameters for a vault. Kept
    ///         as a struct so the `deployThemeVault` call site stays within the
    ///         non-`via_ir` stack limit this repo compiles under.
    struct VaultConfig {
        IERC20 usdc; // asset the vault denominates in
        uint256 tvlCap; // TVL ceiling (6-decimal USDC)
        uint256 perDepositCap; // per-deposit ceiling
        uint256 exitFeeBps; // exit fee (≤ 100)
        uint256 maxNavGrowthRateBps; // residual NAV-growth-rate cap (> 0)
        address feeRecipient; // exit-fee recipient
        address admin; // bootstrap ADMIN_ROLE holder (wires adapters)
        address emergency; // EMERGENCY_ROLE holder
    }

    /// @notice Static per-theme parameters (spec §8 theme deployment table).
    struct ThemeParams {
        string name; // ERC-20 share name
        string symbol; // ERC-20 share symbol
        uint256 maxSlippageBps; // worst-case per-leg slippage bound
        uint256 maxActiveAdapters; // active-adapter-count cap (rmRWA = 1)
        uint256 expectedAdapters; // how many adapters the theme wires (doc/assert aid)
        bool allExact; // true only for the all-lending rmUSDC composition
    }

    /// @notice Default TVL cap: 10M USDC (6 decimals).
    uint256 public constant DEFAULT_TVL_CAP = 10_000_000 * 1e6;
    /// @notice Default per-deposit cap: 1M USDC (6 decimals).
    uint256 public constant DEFAULT_PER_DEPOSIT_CAP = 1_000_000 * 1e6;
    /// @notice Default residual NAV-growth-rate cap (bps of checkpoint NAV per
    ///         hour). A concrete governance/tuning value (spec §10, still-open Q3);
    ///         a finite non-zero placeholder here — narrow before mainnet.
    uint256 public constant DEFAULT_MAX_NAV_GROWTH_RATE_BPS = 500;

    /// @notice The static parameter matrix for `t` (spec §8, table + M-A9).
    /// @dev `maxSlippageBps` / `maxActiveAdapters` are the load-bearing per-theme
    ///      divergences; `allExact` records the composition class (rmUSDC only).
    function themeParams(Theme t) public pure returns (ThemeParams memory p) {
        if (t == Theme.RM_USDC) {
            // All-lending, exact composition: `withdraw()` live, maxSlippage 0.
            return ThemeParams({
                name: "Robot Money USDC",
                symbol: "rmUSDC",
                maxSlippageBps: 0,
                // 20 == Vault.MAX_ADAPTERS (the default ceiling); `_wireInner`
                // therefore skips the `setMaxActiveAdapters` no-op for rmUSDC.
                maxActiveAdapters: 20,
                expectedAdapters: 3,
                allExact: true
            });
        }
        if (t == Theme.RM_PROTO) {
            // 3 × Uniswap-V3 AssetPositionAdapter (wETH/cbBTC/wSOL), inexact.
            return ThemeParams({
                name: "Robot Money Protocol",
                symbol: "rmPROTO",
                maxSlippageBps: 100,
                maxActiveAdapters: 10,
                expectedAdapters: 3,
                allExact: false
            });
        }
        if (t == Theme.RM_AGENT) {
            // 3 × mixed-venue AssetPositionAdapter (BNKR V3 / JUNO V4 / RM
            // Aerodrome), inexact; per-theme TimelockController as ADMIN (ADR-0004).
            return ThemeParams({
                name: "Robot Money Agent Tokens",
                symbol: "rmAGENT",
                maxSlippageBps: 300,
                maxActiveAdapters: 15,
                expectedAdapters: 3,
                allExact: false
            });
        }
        // RM_RWA: a single Chronicle-priced deSPXA Aerodrome adapter, inexact,
        // active-adapter-count cap = 1 (the RwaVault.maxAssets()==1 constraint).
        return ThemeParams({
            name: "Robot Money RWA",
            symbol: "rmRWA",
            maxSlippageBps: 50,
            maxActiveAdapters: 1,
            expectedAdapters: 1,
            allExact: false
        });
    }

    /// @notice Deploy the parameterized `Vault` for theme `t`. Pure construction —
    ///         no role-gated calls, so no broadcast/prank context is required. The
    ///         constructed vault grants `ADMIN_ROLE` to `admin` and starts with the
    ///         default `maxActiveAdapters == MAX_ADAPTERS`; `wireTheme` narrows it
    ///         to the theme cap (rmRWA → 1).
    /// @param t   The theme to deploy (supplies name/symbol/maxSlippage).
    /// @param cfg The deployment-environment parameters (asset, caps, fee,
    ///            NAV-growth cap, recipients, and the bootstrap `admin` that wires
    ///            the adapters — a per-theme TimelockController for rmAGENT, see
    ///            `deployAgentTimelock`; the operator/timelock otherwise).
    function deployThemeVault(Theme t, VaultConfig memory cfg) public returns (Vault vault) {
        ThemeParams memory p = themeParams(t);
        vault = new Vault(
            cfg.usdc,
            p.name,
            p.symbol,
            cfg.tvlCap,
            cfg.perDepositCap,
            cfg.exitFeeBps,
            p.maxSlippageBps,
            cfg.maxNavGrowthRateBps,
            cfg.feeRecipient,
            cfg.admin,
            cfg.emergency
        );
    }

    /// @notice Wire theme `t`'s VARIABLE-LENGTH adapter set into `vault` and narrow
    ///         the active-adapter cap, all as `admin` (the vault's `ADMIN_ROLE`
    ///         holder). Each adapter is put through the full eligibility gate:
    ///         `setAdapterAllowed` (instance allowlist) + `setAdapterCodeHashAllowed`
    ///         (codehash pin) + `addAdapter(adapter, capBps, isExact)`.
    /// @dev    In-process / test path: pranks as `admin` so the vault sees the
    ///         ADMIN caller. Production wiring inside a broadcast uses
    ///         `wireThemeBroadcast` instead. `specs.length` MUST equal the theme's
    ///         expected adapter count and (for rmRWA) not exceed the cap of 1.
    function wireTheme(Vault vault, Theme t, address admin, AdapterSpec[] memory specs) public {
        vm.startPrank(admin);
        _wireInner(vault, t, specs);
        vm.stopPrank();
    }

    /// @notice Broadcast variant of `wireTheme` for production `run*` flows where
    ///         `admin` is the broadcasting deployer/timelock.
    function wireThemeBroadcast(Vault vault, Theme t, AdapterSpec[] memory specs) public {
        vm.startBroadcast();
        _wireInner(vault, t, specs);
        vm.stopBroadcast();
    }

    /// @dev The raw wiring — assumes the current caller context holds `ADMIN_ROLE`.
    function _wireInner(Vault vault, Theme t, AdapterSpec[] memory specs) internal {
        ThemeParams memory p = themeParams(t);

        // Narrow the active-adapter cap to the theme bound (rmRWA → 1). Skip the
        // no-op when the theme keeps the default ceiling.
        if (p.maxActiveAdapters < vault.MAX_ADAPTERS()) {
            vault.setMaxActiveAdapters(p.maxActiveAdapters);
        }

        for (uint256 i = 0; i < specs.length; i++) {
            AdapterSpec memory s = specs[i];
            vault.setAdapterAllowed(s.adapter, true);
            vault.setAdapterCodeHashAllowed(s.adapter.codehash, true);
            vault.addAdapter(s.adapter, s.capBps, s.isExact);
        }
    }

    /// @notice Deploy the per-theme `TimelockController` that serves as rmAGENT's
    ///         `ADMIN_ROLE` holder (ADR-0004 add/remove delays — spec §8, M-A9).
    ///         One `ADMIN_ROLE` on the vault cannot express per-theme delays, so
    ///         the timelock's `minDelay` encodes them and the vault sees a single
    ///         ADMIN held by this timelock.
    /// @param minDelay Minimum timelock delay (seconds) — the ADR-0004 add/remove
    ///        delay (e.g. 48h). Distinct add-vs-remove delays need an
    ///        operation-scoped delay; a single min-delay is the base case.
    /// @param proposer PROPOSER_ROLE holder (governance multisig in production).
    /// @param executor EXECUTOR_ROLE holder.
    function deployAgentTimelock(uint256 minDelay, address proposer, address executor)
        public
        returns (TimelockController timelock)
    {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;
        // admin == address(0): no standalone timelock admin; role administration
        // is self-governed through the proposer/executor set (OZ v5 recommended).
        timelock = new TimelockController(minDelay, proposers, executors, address(0));
    }

    /// @notice Hand the vault's `ADMIN_ROLE` from the bootstrap operator to the
    ///         final admin (a per-theme `TimelockController` for rmAGENT), then
    ///         renounce the operator's role so the timelock is the sole ADMIN.
    ///         The last-admin floor (ACL-3) permits this: `newAdmin` is granted
    ///         BEFORE `oldAdmin` renounces, so the ADMIN count never hits zero.
    /// @dev    In-process / test path (pranks as `oldAdmin`).
    function finalizeAdmin(Vault vault, address oldAdmin, address newAdmin) public {
        vm.startPrank(oldAdmin);
        _finalizeInner(vault, oldAdmin, newAdmin);
        vm.stopPrank();
    }

    /// @dev Raw handoff — assumes the caller context holds `oldAdmin`'s ADMIN_ROLE.
    function _finalizeInner(Vault vault, address oldAdmin, address newAdmin) internal {
        bytes32 adminRole = vault.ADMIN_ROLE();
        vault.grantRole(adminRole, newAdmin);
        vault.renounceRole(adminRole, oldAdmin);
    }

    /// @notice Forge broadcast entrypoint: deploy a single theme's `Vault` (theme
    ///         selected by the `THEME` env var: USDC|PROTO|AGENT|RWA) and narrow
    ///         its active-adapter cap. Adapter INSTANCE deployment + wiring is a
    ///         governed follow-up (their own scripts, then `wireThemeBroadcast`);
    ///         the registry/router eligibility interlock is Phase-6 (ADR-0010 §8).
    ///
    ///         Required env: THEME, USDC_ADDRESS, ADMIN_ADDRESS,
    ///         EMERGENCY_RESPONDER_ADDRESS. Optional: TVL_CAP, PER_DEPOSIT_CAP,
    ///         EXIT_FEE_BPS, MAX_NAV_GROWTH_RATE_BPS, FEE_RECIPIENT.
    function run() external returns (address vault) {
        Theme t = _themeFromEnv();
        address usdc = vm.envAddress("USDC_ADDRESS");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address emergency = vm.envAddress("EMERGENCY_RESPONDER_ADDRESS");
        require(usdc != address(0), "USDC_ADDRESS=0");
        require(admin != address(0), "ADMIN_ADDRESS=0");
        require(emergency != address(0), "EMERGENCY_RESPONDER_ADDRESS=0");

        VaultConfig memory cfg = VaultConfig({
            usdc: IERC20(usdc),
            tvlCap: _envUintOrDefault("TVL_CAP", DEFAULT_TVL_CAP),
            perDepositCap: _envUintOrDefault("PER_DEPOSIT_CAP", DEFAULT_PER_DEPOSIT_CAP),
            exitFeeBps: _envUintOrDefault("EXIT_FEE_BPS", 0),
            maxNavGrowthRateBps: _envUintOrDefault(
                "MAX_NAV_GROWTH_RATE_BPS", DEFAULT_MAX_NAV_GROWTH_RATE_BPS
            ),
            feeRecipient: _envAddressOrDefault("FEE_RECIPIENT", admin),
            admin: admin,
            emergency: emergency
        });

        ThemeParams memory p = themeParams(t);

        vm.startBroadcast();
        Vault v = deployThemeVault(t, cfg);
        if (p.maxActiveAdapters < v.MAX_ADAPTERS()) {
            v.setMaxActiveAdapters(p.maxActiveAdapters);
        }
        vm.stopBroadcast();

        vault = address(v);
        console2.log("DeployVaultThemes:", p.symbol, "->", vault);
        console2.log("  maxActiveAdapters:", v.maxActiveAdapters());
        console2.log(
            "  next: deploy this theme's adapters bound to the vault, then wireThemeBroadcast"
        );
    }

    // ─── env helpers ───────────────────────────────────────────────────────

    function _themeFromEnv() internal view returns (Theme) {
        string memory raw = vm.envString("THEME");
        bytes32 h = keccak256(bytes(raw));
        if (h == keccak256("USDC") || h == keccak256("rmUSDC")) return Theme.RM_USDC;
        if (h == keccak256("PROTO") || h == keccak256("rmPROTO")) return Theme.RM_PROTO;
        if (h == keccak256("AGENT") || h == keccak256("rmAGENT")) return Theme.RM_AGENT;
        if (h == keccak256("RWA") || h == keccak256("rmRWA")) return Theme.RM_RWA;
        revert("THEME must be one of USDC|PROTO|AGENT|RWA");
    }

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
}
