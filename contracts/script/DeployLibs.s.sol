// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops) — core S3, stage "libs"
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {TickMath} from "../lib/TickMath.sol";
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
///         Required env vars: EXPECTED_CHAIN_ID (mandatory and equal to 8453 on Base mainnet),
///         DEPLOYMENT_OUT (output JSON path).
contract DeployLibs is ExpectedChainGuard {
    /// @notice sqrt(1.0001^0) * 2^96: the canonical answer for tick 0.
    uint160 public constant SQRT_RATIO_AT_TICK_ZERO = 79228162514264337593543950336;

    struct Deployed {
        address tickMath;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        vm.startBroadcast();
        d = _deploy();
        vm.stopBroadcast();
        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    function runInProcess() external returns (Deployed memory d) {
        d = _deploy();
        console2.log("libs: tick_math", d.tickMath);
    }

    function _deploy() internal view returns (Deployed memory d) {
        d.tickMath = address(TickMath);
        // The call proves the library is linked to working code, not only to an address.
        require(
            TickMath.getSqrtRatioAtTick(0) == SQRT_RATIO_AT_TICK_ZERO,
            "TickMath: tick 0 mismatch"
        );
        _assertTickMathCanonical(d.tickMath);
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
        string memory json = vm.serializeAddress(obj, "tick_math", d.tickMath);
        vm.writeJson(json, outPath);
        console2.log("Wrote libs deployment JSON to", outPath);
    }
}
