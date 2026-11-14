// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 (Consensus Receipt); docs/technical/one-vault-rebalancer-proposal.md §5.1 (from receipt to plan)
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {DeployConsensusRecommendationReceipt} from "./DeployConsensusRecommendationReceipt.s.sol";
import {FundTimelockPolicy} from "./FundTimelockPolicy.sol";
import {UpgradeAuthority} from "./UpgradeAuthority.sol";

/// @title DeployFundReceipt
/// @notice The `fund-receipt` stage: the fund system's own ConsensusRecommendationReceipt register, deployed by the vaults system's receipt
///         script unchanged except the timelock it predicts (`FundTimelockPolicy`: the Safe is its only executor, decision D4-10). It is a script file of its own so the fund system's stage writes its own
///         manifest (fund-receipt.json) and forge keeps its own broadcast record (broadcast/DeployFundReceipt.s.sol/<chain>/), never the
///         vaults system's receipt stage's. RECEIPT_ADMIN_ADDRESS (the deployer) holds ADMIN_ROLE until fund-timelock hands it over.
/// @dev `FundTimelockPolicy`: the register names the fund-system timelock, whose only executor is the Safe (decision D4-10).
contract DeployFundReceipt is DeployConsensusRecommendationReceipt, FundTimelockPolicy {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json): FUND_MANIFEST_FILE = "fund-receipt.json".
    string public constant FUND_MANIFEST_FILE = "fund-receipt.json";

    /// @dev The fund system's executor policy (decision D4-10): the Safe.
    function _timelockExecutor(address safe)
        internal
        pure
        override(UpgradeAuthority, FundTimelockPolicy)
        returns (address)
    {
        return FundTimelockPolicy._timelockExecutor(safe);
    }
}
