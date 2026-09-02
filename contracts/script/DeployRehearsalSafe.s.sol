// SPDX-License-Identifier: MIT
// Rehearsal-only (issue #1303): a minimal Safe stand-in that satisfies
// DeployTimelock.s.sol's deploy-time validation (deployed code + getThreshold() >= 2)
// on rehearsal environments where no real Safe multisig exists. It is NEVER used
// in production: the production ceremony deploys a real Safe with hardware-wallet
// signers (docs/operations/manual-admin-actions.md §2, security-model.md §4).
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @notice Minimal Safe stand-in for rehearsal ceremonies only.
///         Exposes exactly the `getThreshold()` surface DeployTimelock._validate
///         checks, returning a hard-coded threshold of 2.
contract RehearsalSafe {
    function getThreshold() external pure returns (uint256) {
        return 2;
    }
}

/// @title DeployRehearsalSafe
/// @notice Deploy the rehearsal-only Safe stand-in. Broadcast as the deployer
///         EOA so the SAFE_ADDRESS passed to DeployTimelock.s.sol has deployed
///         code and a threshold >= 2, exactly as _validate requires.
///
///         Optional env vars:
///           DEPLOYMENT_OUT   — path for the output JSON
///                              (default: "deployments/rehearsal-safe-<chain_id>.json")
contract DeployRehearsalSafe is Script {
    function run() external returns (RehearsalSafe safe) {
        vm.startBroadcast();
        safe = new RehearsalSafe();
        vm.stopBroadcast();

        console2.log("RehearsalSafe deployed:", address(safe));
    }
}
