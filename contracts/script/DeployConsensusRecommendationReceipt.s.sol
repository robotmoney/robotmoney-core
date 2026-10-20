// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.8, §4.9 — Receipt Submitter Authority, Consensus Receipt
// Implements: issue #1247 (receipt contract), issue 1888 (receipt deploys alone, no IC policy, no gateway)
pragma solidity ^0.8.24;

import {stdJson} from "forge-std/StdJson.sol";
import {console2} from "forge-std/console2.sol";

import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {UpgradeAuthority} from "./UpgradeAuthority.sol";

/// @title DeployConsensusRecommendationReceipt
/// @notice Foundry deploy script for the receipt contract alone. The receipt is a
///         vaults-system contract: it binds no gateway and no committee registry.
///         `RECEIPT_ADMIN_ADDRESS` receives `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`
///         (the deployer until DeployTimelock hands both to the timelock). The
///         timelock then alone grants `RECEIPT_SUBMITTER_ROLE` and
///         `RECEIPT_RELEASER_ROLE`.
///
///         Required env vars (unset or malformed reverts, there is no default):
///           RECEIPT_ADMIN_ADDRESS — holder of ADMIN_ROLE until the timelock stage
///           DEPLOYMENT_OUT        — path for the output JSON
///           EXPECTED_CHAIN_ID     — mandatory and equal to 8453 on Base mainnet
///           SAFE_ADDRESS, TIMELOCK_MIN_DELAY, UPGRADE_MODE — the upgrade authority and
///                                   release mode (`UpgradeAuthority`, issue 1808).
///         The manifest `consensus_receipt` is the ERC-1967 proxy and
///         `consensus_receipt_implementation` is its implementation.
contract DeployConsensusRecommendationReceipt is UpgradeAuthority {
    /// @dev Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "receipt.json";

    using stdJson for string;

    /// @notice Result struct returned to in-process callers (e.g. forge tests).
    struct Deployed {
        ConsensusRecommendationReceipt receipts;
        address receiptAdmin;
        address receiptsImplementation;
        UpgradeConfig upgrade;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        address receiptAdmin = _envAddressRequired("RECEIPT_ADMIN_ADDRESS");
        require(receiptAdmin != address(0), "RECEIPT_ADMIN_ADDRESS=0");

        UpgradeConfig memory u = _readUpgradeConfig("");

        vm.startBroadcast();
        d = _deploy(receiptAdmin, u);
        vm.stopBroadcast();

        _writeDeploymentJson(d);
    }

    /// @notice In-process variant for forge tests. No broadcast, no JSON written.
    /// @param receiptAdmin_ Holder of `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` on the receipt.
    function runInProcessWith(address receiptAdmin_) external returns (Deployed memory d) {
        require(receiptAdmin_ != address(0), "RECEIPT_ADMIN_ADDRESS=0");
        d = _deploy(receiptAdmin_, _inProcessUpgradeConfig());
        _logResult(d);
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _deploy(address receiptAdmin_, UpgradeConfig memory u)
        internal
        returns (Deployed memory d)
    {
        d.receiptAdmin = receiptAdmin_;
        d.upgrade = u;
        d.receiptsImplementation = address(new ConsensusRecommendationReceipt());
        d.receipts = ConsensusRecommendationReceipt(
            _deployProxy(
                d.receiptsImplementation,
                abi.encodeCall(
                    ConsensusRecommendationReceipt.initialize, (receiptAdmin_, u.timelock, u.mode)
                )
            )
        );
    }

    function _logResult(Deployed memory d) internal pure {
        console2.log("ConsensusRecommendationReceipt deployed");
        console2.log("  receipts     :", address(d.receipts));
        console2.log("  receiptAdmin :", d.receiptAdmin);
    }

    function _writeDeploymentJson(Deployed memory d) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");

        string memory obj = "receipt_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "consensus_receipt", address(d.receipts));
        vm.serializeAddress(obj, "consensus_receipt_implementation", d.receiptsImplementation);
        vm.serializeAddress(obj, "upgrade_timelock", d.upgrade.timelock);
        vm.serializeString(obj, "upgrade_mode", upgradeModeName(d.upgrade.mode));
        string memory json = vm.serializeAddress(obj, "receipt_admin", d.receiptAdmin);

        vm.writeJson(json, outPath);
        console2.log("Wrote receipt deployment JSON to", outPath);
    }
}
