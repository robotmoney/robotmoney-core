// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §4 (the timelock is deployed before every proxy)
// Implements: issue #1809 (upgradeability stage 2), stage "authority" of scripts/deploy/stage-table.json
pragma solidity ^0.8.24;

import {DeployTimelock} from "./DeployTimelock.s.sol";

/// @title DeployUpgradeAuthority
/// @notice The forge stage right before the first proxy stage (ADR-0014 §4, stage `authority`): it deploys only
///         the ProposerFloorTimelock that every proxy names as its upgrade authority. The Safe is
///         its one proposer and canceller, the executor is open and nobody holds its admin role.
///         It grants no role on any Robot Money contract (none exists yet). The handover stage
///         (`DeployTimelock`, stage `timelock`) later reuses this timelock through TIMELOCK_ADDRESS
///         and refuses unless every handed-over proxy names it.
/// @dev A stage of its own so that forge writes its own broadcast file
///      (`broadcast/DeployUpgradeAuthority.s.sol/<chain>/run-latest.json`) and the stage driver
///      keeps one script per stage. The body is `DeployTimelock.runAuthority`, with the same Safe
///      and delay checks as the handover. Required env (no defaults): SAFE_ADDRESS, SAFE_OWNERS,
///      SAFE_THRESHOLD, TIMELOCK_MIN_DELAY, DEPLOYMENT_OUT. Optional: EXPECTED_CHAIN_ID (mandatory
///      and 8453 on Base mainnet), DEPLOYMENT_KIND (`rehearsal` applies the rehearsal delay range).
contract DeployUpgradeAuthority is DeployTimelock {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    ///         Fields: chain_id, safe, min_delay, deployment_kind, timelock, timelock_codehash.
    string public constant AUTHORITY_MANIFEST_FILE = "upgrade-authority.json";

    /// @notice Broadcast entrypoint of the authority stage. Only the timelock fields of the returned
    ///         record are set: this stage hands nothing over.
    function run() external override returns (Deployed memory d) {
        Authority memory a = _runAuthorityFrom("");
        d.timelock = a.timelock;
        d.safe = a.safe;
        d.minDelay = a.minDelay;
        d.rehearsal = a.rehearsal;
    }
}
