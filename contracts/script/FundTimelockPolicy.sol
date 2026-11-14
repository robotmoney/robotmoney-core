// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.6 and §10 (Deploy 4, decision D4-10);
//            docs/adr/ADR-0004-agent-token-shortlist-governance.md (addendum 2026-11-13: the fund system departs from the open executor).
pragma solidity ^0.8.24;

import {UpgradeAuthority} from "./UpgradeAuthority.sol";

/// @title FundTimelockPolicy
/// @notice The fund system's timelock executor policy (owner decision D4-10, 2026-11-13): the Safe is the only EXECUTOR_ROLE
///         holder of the fund-system timelock, so a ready operation runs only when the Safe's owners sign its execution too.
///         The vaults system keeps ADR-0004's open executor. Every fund-system stage that predicts the timelock (each proxy
///         stage) and the handover stage that deploys it inherits this, so all of them predict one address.
abstract contract FundTimelockPolicy is UpgradeAuthority {
    /// @notice Recorded in fund-timelock.json as `executorPolicy`.
    string public constant FUND_EXECUTOR_POLICY = "safe-only";

    function _timelockExecutor(address safe) internal pure virtual override returns (address) {
        return safe;
    }
}
