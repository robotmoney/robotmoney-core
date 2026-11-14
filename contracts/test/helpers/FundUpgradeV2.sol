// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md (Delivery sequence step 3, v1 -> v2), docs/runbooks/contract-qa/releases/v0.7.0-onevault.yaml
//            (P9.69 to P9.72: the fund system's governed upgrade lifecycle, Deploy 4).
pragma solidity ^0.8.24;

import {Rebalancer} from "../prototype/src/Rebalancer.sol";

// Test-only v2 of the fund system's rebalancer (Deploy 4), in the shape of helpers/UpgradeV2.sol: the v1 contract plus one marker getter,
// so the rehearsal can read which implementation the rebalancer proxy runs while every v1 slot stays where it was. It adds no state, so
// its storage layout is the Rebalancer's (scripts/ci/check-core-storage-layout.sh pins both snapshots, and deploy-implementation refuses
// a snapshot that does not extend the deployed Rebalancer's). No stage of scripts/deploy/stage-table.json deploys it: only
// `publish-contracts/src/cli.ts deploy-implementation --system fund --proxy rebalancer --contract RebalancerV2` does, for the runbook's
// upgrade lifecycle, which upgrades the proxy back to the release implementation before the final verify.
// UpgradeV2.sol is not imported: it compiles the vaults contracts into this unit, whose namespaces the layout gate would then attribute to it.

/// @dev The marker the fund v2 answers (the value of UpgradeV2.sol's UPGRADE_V2_MARKER).
uint256 constant FUND_UPGRADE_V2_MARKER = 2;

contract RebalancerV2 is Rebalancer {
    function upgradeMarker() external pure returns (uint256) {
        return FUND_UPGRADE_V2_MARKER;
    }
}
