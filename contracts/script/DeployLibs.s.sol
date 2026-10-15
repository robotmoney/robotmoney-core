// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499 — core S3, stage "libs"
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {TickMath} from "../lib/TickMath.sol";
import {VaultAdapterOps} from "../lib/VaultAdapterOps.sol";
import {GatewayWindows} from "../lib/GatewayWindows.sol";
import {GatewayAuth} from "../lib/GatewayAuth.sol";
import {GatewayWithdrawOps} from "../lib/GatewayWithdrawOps.sol";
import {ExclusionLedgerFactory} from "../ExclusionLedgerFactory.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title DeployLibs
/// @notice Stage 1 of the core deploy: libs, vault, registry, router, gateway.
///         Deploys the externally linked libraries (TickMath) and proves they are canonical.
///         The basket-family vaults DELEGATECALL TickMath on their NAV path, so the library has
///         to exist, and be the audited code, before any vault stage runs (finding L3-D1).
///
///         `forge script --broadcast` deploys a public library once when a script references
///         it. This script references TickMath through a real call, so the broadcast of this
///         stage is exactly one library deployment. The later basket-vault stages link the
///         address this stage writes to the manifest (`tick_math`).
///
///         ADR-0014 §9 adds the libraries the proxied implementations link (VaultAdapterOps,
///         GatewayWindows, GatewayAuth, GatewayWithdrawOps) and the stateless
///         `ExclusionLedgerFactory` the rmUSDC initializer calls. This stage references each library
///         so the broadcast deploys it once, and deploys the factory by CREATE2 (skipped when the
///         deterministic address already holds it). The manifest records every address for the
///         later stages and the verifier. forge deploys each library through the CREATE2 factory;
///         the vault and gateway stages compile with the same settings (no `--libraries`), so forge
///         finds the same addresses already deployed and links them (issue #1809).
///         BasketSwapOps is NOT deployed here (issue #1809): it links BasketAssetConfigGuard, and the
///         basket stages compile with `--libraries TickMath:<address>`, which changes the metadata
///         hash and so the CREATE2 address of both. The first basket stage deploys BasketSwapOps
///         itself, like its other basket libraries; a copy built here would never run.
///
///         Required env vars: EXPECTED_CHAIN_ID (mandatory and equal to 8453 on Base mainnet),
///         DEPLOYMENT_OUT (output JSON path).
contract DeployLibs is ExpectedChainGuard {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "libs.json";

    /// @notice sqrt(1.0001^0) * 2^96: the canonical answer for tick 0.
    uint160 public constant SQRT_RATIO_AT_TICK_ZERO = 79228162514264337593543950336;

    /// @notice CREATE2 salt of the `ExclusionLedgerFactory` (one per chain).
    bytes32 public constant EXCLUSION_LEDGER_FACTORY_SALT =
        keccak256("robotmoney.ExclusionLedgerFactory.v1");

    struct Deployed {
        address tickMath;
        address vaultAdapterOps;
        address gatewayWindows;
        address gatewayAuth;
        address gatewayWithdrawOps;
        address exclusionLedgerFactory;
    }

    /// @notice Forge broadcast entrypoint.
    /// @return d The deployed library addresses.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        vm.startBroadcast();
        d = _deploy();
        d.exclusionLedgerFactory = _deployFactoryCreate2();
        vm.stopBroadcast();
        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    /// @return d The deployed library addresses.
    function runInProcess() external returns (Deployed memory d) {
        d = _deploy();
        d.exclusionLedgerFactory = address(new ExclusionLedgerFactory());
        console2.log("libs: tick_math", d.tickMath);
    }

    function _deploy() internal view returns (Deployed memory d) {
        d.tickMath = address(TickMath);
        // ADR-0014 §9: referenced here so the broadcast deploys each linked library once.
        d.vaultAdapterOps = address(VaultAdapterOps);
        d.gatewayWindows = address(GatewayWindows);
        d.gatewayAuth = address(GatewayAuth);
        d.gatewayWithdrawOps = address(GatewayWithdrawOps);
        require(d.vaultAdapterOps.code.length > 0, "VaultAdapterOps: no code");
        require(d.gatewayWindows.code.length > 0, "GatewayWindows: no code");
        require(d.gatewayAuth.code.length > 0, "GatewayAuth: no code");
        require(d.gatewayWithdrawOps.code.length > 0, "GatewayWithdrawOps: no code");
        // The call proves the library is linked to working code, not only to an address.
        require(
            TickMath.getSqrtRatioAtTick(0) == SQRT_RATIO_AT_TICK_ZERO, "TickMath: tick 0 mismatch"
        );
        _assertTickMathCanonical(d.tickMath);
    }

    /// @dev The one `ExclusionLedgerFactory` of this chain, at its deterministic CREATE2 address
    ///      (the forge CREATE2 deployer, `EXCLUSION_LEDGER_FACTORY_SALT`). An existing deployment is
    ///      reused, so a re-run of this stage never fails on it.
    function _deployFactoryCreate2() internal returns (address factory) {
        factory = vm.computeCreate2Address(
            EXCLUSION_LEDGER_FACTORY_SALT, keccak256(type(ExclusionLedgerFactory).creationCode)
        );
        if (factory.code.length == 0) {
            address deployed =
                address(new ExclusionLedgerFactory{salt: EXCLUSION_LEDGER_FACTORY_SALT}());
            require(deployed == factory, "ExclusionLedgerFactory: CREATE2 address mismatch");
        }
        require(
            keccak256(factory.code) == keccak256(type(ExclusionLedgerFactory).runtimeCode),
            "ExclusionLedgerFactory: code at the CREATE2 address is not the factory"
        );
    }

    /// @dev Fail closed on a zero or empty linked library (finding L3-D1). The substantive
    ///      per-vault codehash check lives in the basket-vault stage scripts.
    function _assertTickMathCanonical(address lib) internal view {
        require(lib != address(0), "TickMath: zero linked library");
        require(lib.code.length > 0, "TickMath: linked library has no code");
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory obj = "libs_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "vault_adapter_ops", d.vaultAdapterOps);
        vm.serializeAddress(obj, "gateway_windows", d.gatewayWindows);
        vm.serializeAddress(obj, "gateway_auth", d.gatewayAuth);
        vm.serializeAddress(obj, "gateway_withdraw_ops", d.gatewayWithdrawOps);
        vm.serializeAddress(obj, "exclusion_ledger_factory", d.exclusionLedgerFactory);
        string memory json = vm.serializeAddress(obj, "tick_math", d.tickMath);
        vm.writeJson(json, outPath);
        console2.log("Wrote libs deployment JSON to", outPath);
    }
}
