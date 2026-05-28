// SPDX-License-Identifier: MIT
// Canonical: docs/implementation-plan.md §"Phase: Demo seeding"; docs/architecture.md §4.2 — Portfolio Router
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {PassthroughAdapter} from "../adapters/PassthroughAdapter.sol";
import {AdapterBytecodeGuard} from "./AdapterBytecodeGuard.sol";

/// @title DeployDemoExtraVaults
/// @notice Demo-only deploy script that registers two additional ERC-4626
///         vaults plus a non-Active RWA/Thematic placeholder in
///         `VaultRegistry` and re-sets the router weight vector to a
///         non-degenerate three-way split.
///
///         Why this exists: the production basket vaults `ProtocolAssetVault`
///         and `AgentTokenVault` remain ADR-blocked (see
///         `docs/technical/basket-vault-gap-report.md` — they lack TWAP
///         hardening and slippage-bounded `previewRedeem`), so the demo cannot
///         seed them today. To still exercise the multi-vault router story end
///         to end (Portfolio Explorer, /v1/vaults TVL, Router Governance
///         weights) the demo registers two extra `RobotMoneyVault` instances
///         wired to `PassthroughAdapter` — the same adapter the smoke-test
///         devnet already uses for the primary vault. They are demo-only
///         stand-ins; no mainnet build runs this script.
///
///         Four-vault PRD conformance (issue #479): PRD §11 names four vault
///         categories — Stable Yield, Protocol Asset, Agent Token, and
///         RWA/Thematic. PRD §11.4 marks RWA/Thematic as Future / not
///         specified. To make the deployed vault set match the four-vault
///         catalog, this script also registers a single RWA/Thematic
///         placeholder. It is registered then set to a non-Active status
///         (Paused) and is never marked router-eligible, so `PortfolioRouter`
///         skips it (it is not in the weight vector) and the dapp renders it
///         as a Future / Coming-soon tile whose inactive state is read from
///         on-chain status, not a hard-coded flag. This is registry state, not
///         a code variant — single-production-codebase
///         (`docs/development/single-production-codebase.md`).
///
///         Required env vars:
///           ADMIN_ADDRESS      — receives ADMIN_ROLE on the new vaults and
///                                must already hold ADMIN_ROLE on
///                                VaultRegistry + PortfolioRouter
///           REGISTRY_ADDRESS   — deployed VaultRegistry
///           ROUTER_ADDRESS     — deployed PortfolioRouter
///           PRIMARY_VAULT      — RobotMoneyVault deployed by Deploy.s.sol
///                                (kept in the weight vector with the largest
///                                share)
///           USDC_ADDRESS       — ERC-20 asset every vault denominates in
///           WEIGHT_PRIMARY_BPS — bps for PRIMARY_VAULT in the new vector
///           WEIGHT_EXTRA1_BPS  — bps for the first extra vault
///           WEIGHT_EXTRA2_BPS  — bps for the second extra vault
///                                (the three must sum to 10 000)
///
///         Optional env vars:
///           VAULT1_NAME        — registry name for the first extra vault
///                                (default: "Robot Money Demo Vault A")
///           VAULT2_NAME        — registry name for the second extra vault
///                                (default: "Robot Money Demo Vault B")
///           RWA_VAULT_NAME     — registry name for the RWA/Thematic
///                                placeholder
///                                (default: "Robot Money RWA / Thematic")
///           DEPLOYMENT_OUT     — output JSON path
///                                (default: "deployments/demo-extra-vaults-<chain_id>.json")
contract DeployDemoExtraVaults is Script {
    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        address vault1;
        address vault2;
        address adapter1;
        address adapter2;
        uint256 weightPrimaryBps;
        uint256 weightExtra1Bps;
        uint256 weightExtra2Bps;
        /// @dev RWA/Thematic placeholder (issue #479). Registered non-Active
        ///      (Paused) and never router-eligible; not in the weight vector.
        address rwaVault;
    }

    /// @notice Default human-readable name for the first extra demo vault.
    string public constant DEFAULT_VAULT1_NAME = "Robot Money Demo Vault A";
    /// @notice Default human-readable name for the second extra demo vault.
    string public constant DEFAULT_VAULT2_NAME = "Robot Money Demo Vault B";
    /// @notice Default human-readable name for the RWA/Thematic placeholder
    ///         (issue #479, PRD §11.4). Future / not-specified vault category.
    string public constant DEFAULT_RWA_NAME = "Robot Money RWA / Thematic";

    /// @notice TVL cap mirrored from Deploy.s.sol (10M USDC) — demo vaults
    ///         carry the same caps as the primary so the harness can fund any
    ///         scenario without per-vault tuning.
    uint256 public constant DEMO_TVL_CAP = 10_000_000 * 1e6;
    /// @notice Per-deposit cap mirrored from Deploy.s.sol (1M USDC).
    uint256 public constant DEMO_PER_DEPOSIT_CAP = 1_000_000 * 1e6;

    /// @dev Env-derived params bundled to keep `run()` locals below the
    ///      Solidity stack limit (16 slots, ~stack-too-deep).
    struct Params {
        address admin;
        address registry;
        address router;
        address primaryVault;
        address usdc;
        uint256 wPrimary;
        uint256 wExtra1;
        uint256 wExtra2;
        string name1;
        string name2;
        string rwaName;
    }

    /// @notice Forge broadcast entrypoint. Deploys two extra demo vaults +
    ///         passthrough adapters, registers them, attests them on the
    ///         router, and resets the router weight vector.
    function run() external returns (Deployed memory d) {
        Params memory p = _readParams();

        vm.startBroadcast();
        d = _doDeploy(p);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
        _logResult(d);
    }

    /// @notice In-process entrypoint for forge tests. Runs the same deploy +
    ///         seed body as `run()` but without `vm.startBroadcast`, so the
    ///         caller (the test contract) is the broadcaster and must already
    ///         hold ADMIN_ROLE on the registry and router. No deployment JSON
    ///         is written. Used by `test_demo_seed_populates_defaultWeights`.
    /// @param p Fully-formed params (no env reads).
    function runInProcess(Params memory p) external returns (Deployed memory d) {
        require(p.wPrimary + p.wExtra1 + p.wExtra2 == 10_000, "weights must sum to 10000");
        require(p.wPrimary > 0 && p.wExtra1 > 0 && p.wExtra2 > 0, "weights must be non-zero");
        d = _doDeploy(p);
    }

    function _readParams() internal view returns (Params memory p) {
        p.admin = vm.envAddress("ADMIN_ADDRESS");
        p.registry = vm.envAddress("REGISTRY_ADDRESS");
        p.router = vm.envAddress("ROUTER_ADDRESS");
        p.primaryVault = vm.envAddress("PRIMARY_VAULT");
        p.usdc = vm.envAddress("USDC_ADDRESS");
        p.wPrimary = vm.envUint("WEIGHT_PRIMARY_BPS");
        p.wExtra1 = vm.envUint("WEIGHT_EXTRA1_BPS");
        p.wExtra2 = vm.envUint("WEIGHT_EXTRA2_BPS");
        p.name1 = _envStringOrDefault("VAULT1_NAME", DEFAULT_VAULT1_NAME);
        p.name2 = _envStringOrDefault("VAULT2_NAME", DEFAULT_VAULT2_NAME);
        p.rwaName = _envStringOrDefault("RWA_VAULT_NAME", DEFAULT_RWA_NAME);

        require(p.admin != address(0), "ADMIN_ADDRESS=0");
        require(p.registry != address(0), "REGISTRY_ADDRESS=0");
        require(p.router != address(0), "ROUTER_ADDRESS=0");
        require(p.primaryVault != address(0), "PRIMARY_VAULT=0");
        require(p.usdc != address(0), "USDC_ADDRESS=0");
        require(p.wPrimary + p.wExtra1 + p.wExtra2 == 10_000, "weights must sum to 10000");
        require(p.wPrimary > 0 && p.wExtra1 > 0 && p.wExtra2 > 0, "weights must be non-zero");
    }

    /// @dev Caller must hold ADMIN_ROLE on registry + router via broadcast
    ///      key. Splits the body of `run()` so the locals stay below the
    ///      stack-too-deep limit.
    function _doDeploy(Params memory p) internal returns (Deployed memory d) {
        // 1. Deploy two RobotMoneyVault instances wired to PassthroughAdapter.
        //    PassthroughAdapter is the same path the primary vault uses on
        //    devnet (USE_PASSTHROUGH_ADAPTER=true in Deploy.s.sol), so deposit
        //    flow is identical and no fork-state assumptions are introduced.
        RobotMoneyVault vault1 = _deployVault(p);
        RobotMoneyVault vault2 = _deployVault(p);
        PassthroughAdapter adapter1 = _wireAdapter(vault1, p.usdc);
        PassthroughAdapter adapter2 = _wireAdapter(vault2, p.usdc);

        // 2. Register both vaults in the registry (idempotent).
        VaultRegistry registry = VaultRegistry(p.registry);
        _registerIfAbsent(registry, address(vault1), p.usdc, p.name1);
        _registerIfAbsent(registry, address(vault2), p.usdc, p.name2);

        // 3. Mark both vaults router-eligible in the registry so setWeights
        //    accepts them. The primary vault is already opted in by
        //    DeployPortfolioRouter.s.sol (see issue #475 — single registry
        //    eligibility gate; same contracts every environment).
        PortfolioRouter router = PortfolioRouter(p.router);
        registry.setRouterEligible(address(vault1), true);
        registry.setRouterEligible(address(vault2), true);

        // 4. Reset the router voted weight vector to the three-way split (kept
        //    for the existing AC3 smoke test which reads getWeights()).
        _setThreeWayWeights(router, p.primaryVault, address(vault1), address(vault2), p);

        // 5. Populate the on-chain default (below-quorum fallback) weight vector
        //    with the same three-way split so the public allocation surface
        //    (robotmoney.net/allocation) renders out of the box with no
        //    governance activity. ADR-0002. The default vector length must match
        //    the registry's router-eligible count, so link the router on the
        //    registry first (idempotent) — this also arms the stale-length guard.
        if (address(registry.router()) != p.router) {
            registry.setRouter(p.router);
        }
        _setThreeWayDefaultWeights(router, p.primaryVault, address(vault1), address(vault2), p);

        // 6. Register the RWA/Thematic placeholder (issue #479). It rounds the
        //    deployed set out to the four PRD §11 categories. It is registered
        //    then immediately set to a non-Active status (Paused) and is never
        //    marked router-eligible (the registry default), so:
        //      - PortfolioRouter never weights or deposits into it (it is not
        //        in the weight vector and isRouterEligible() == false);
        //      - the dapp renders it as a Future / Coming-soon tile, reading
        //        its inactive state from on-chain status rather than a flag.
        //    No adapter is wired: the placeholder takes no deposits, so a bare
        //    RobotMoneyVault registry entry is sufficient.
        address rwaVault = _registerRwaPlaceholder(registry, p);

        d = Deployed({
            vault1: address(vault1),
            vault2: address(vault2),
            adapter1: address(adapter1),
            adapter2: address(adapter2),
            weightPrimaryBps: p.wPrimary,
            weightExtra1Bps: p.wExtra1,
            weightExtra2Bps: p.wExtra2,
            rwaVault: rwaVault
        });
    }

    /// @dev Deploy a bare RobotMoneyVault, register it, and set it to a
    ///      non-Active status so the Router skips it and the dapp marks it
    ///      Future. Router eligibility is left at the registry default
    ///      (`false`) — the placeholder is never opted in. Idempotent only at
    ///      registration; a re-run deploys a fresh vault address (demo seed
    ///      runs once against a fresh fork).
    function _registerRwaPlaceholder(VaultRegistry registry, Params memory p)
        internal
        returns (address rwaVault)
    {
        RobotMoneyVault rwa = _deployVault(p);
        rwaVault = address(rwa);
        registry.registerVault(
            rwaVault, VaultRegistry.VaultMetadata({name: p.rwaName, asset: p.usdc, registeredAt: 0})
        );
        registry.setVaultStatus(rwaVault, VaultRegistry.VaultStatus.Paused);
    }

    function _deployVault(Params memory p) internal returns (RobotMoneyVault) {
        return new RobotMoneyVault(
            IERC20(p.usdc),
            DEMO_TVL_CAP,
            DEMO_PER_DEPOSIT_CAP,
            0, // exitFeeBps
            p.admin, // feeRecipient (fees are 0)
            p.admin
        );
    }

    function _wireAdapter(RobotMoneyVault vault_, address usdc_)
        internal
        returns (PassthroughAdapter adapter_)
    {
        adapter_ = new PassthroughAdapter(usdc_, address(vault_));
        _approveAdapter(vault_, address(adapter_));
        vault_.addAdapter(address(adapter_), 10_000);
    }

    function _setThreeWayWeights(
        PortfolioRouter router,
        address primary,
        address extra1,
        address extra2,
        Params memory p
    ) internal {
        address[] memory vaults = new address[](3);
        vaults[0] = primary;
        vaults[1] = extra1;
        vaults[2] = extra2;
        uint256[] memory bps = new uint256[](3);
        bps[0] = p.wPrimary;
        bps[1] = p.wExtra1;
        bps[2] = p.wExtra2;
        router.setWeights(vaults, bps);
    }

    /// @dev Populate the router's default (below-quorum fallback) weight vector
    ///      with the same three-way split. ADR-0002: this is the vector the
    ///      router routes by — and the allocation surface renders — with no
    ///      governance activity.
    function _setThreeWayDefaultWeights(
        PortfolioRouter router,
        address primary,
        address extra1,
        address extra2,
        Params memory p
    ) internal {
        address[] memory vaults = new address[](3);
        vaults[0] = primary;
        vaults[1] = extra1;
        vaults[2] = extra2;
        uint256[] memory bps = new uint256[](3);
        bps[0] = p.wPrimary;
        bps[1] = p.wExtra1;
        bps[2] = p.wExtra2;
        router.setDefaultWeights(vaults, bps);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    /// @dev Approve `adapter_` on `vault_` matching Deploy.s.sol semantics:
    ///      assert no DELEGATECALL in adapter runtime, then allowlist address
    ///      and codehash.
    function _approveAdapter(RobotMoneyVault vault_, address adapter_) internal {
        AdapterBytecodeGuard.requireNoDelegatecall(adapter_);
        vault_.setAdapterAllowed(adapter_, true);
        vault_.setAdapterCodeHashAllowed(adapter_.codehash, true);
    }

    /// @dev Register `vault` in `registry` if not already present. Returns
    ///      true if registration happened, false if already there.
    function _registerIfAbsent(
        VaultRegistry registry,
        address vault,
        address asset,
        string memory vaultName
    ) internal returns (bool registered) {
        address[] memory existing = registry.listVaults();
        for (uint256 i = 0; i < existing.length; i++) {
            if (existing[i] == vault) {
                console2.log("DeployDemoExtraVaults: vault already registered, skipping");
                return false;
            }
        }
        registry.registerVault(
            vault, VaultRegistry.VaultMetadata({name: vaultName, asset: asset, registeredAt: 0})
        );
        return true;
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

    function _logResult(Deployed memory d) internal view {
        console2.log("DeployDemoExtraVaults complete");
        console2.log("  vault1  :", d.vault1);
        console2.log("  vault2  :", d.vault2);
        console2.log("  rwaVault:", d.rwaVault);
        console2.log("  wPrimary:", d.weightPrimaryBps);
        console2.log("  wExtra1 :", d.weightExtra1Bps);
        console2.log("  wExtra2 :", d.weightExtra2Bps);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath;
        try vm.envString("DEPLOYMENT_OUT") returns (string memory s) {
            outPath = s;
        } catch {
            outPath = string.concat(
                "deployments/demo-extra-vaults-", vm.toString(block.chainid), ".json"
            );
        }

        string memory obj = "demo_extra_vaults_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "vault1", d.vault1);
        vm.serializeAddress(obj, "vault2", d.vault2);
        vm.serializeAddress(obj, "adapter1", d.adapter1);
        vm.serializeAddress(obj, "adapter2", d.adapter2);
        vm.serializeAddress(obj, "rwa_vault", d.rwaVault);
        vm.serializeUint(obj, "weight_primary_bps", d.weightPrimaryBps);
        vm.serializeUint(obj, "weight_extra1_bps", d.weightExtra1Bps);
        string memory json = vm.serializeUint(obj, "weight_extra2_bps", d.weightExtra2Bps);

        vm.writeJson(json, outPath);
        console2.log("Wrote demo extra vaults deployment JSON to", outPath);
    }
}
