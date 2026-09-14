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
///         Exposes the `getThreshold()` surface DeployTimelock._validate
///         checks, returning a hard-coded threshold of 2, plus a single
///         owner-gated call forwarder.
///
///         The forwarder is not decoration. `DeployTimelock` makes this
///         address the TimelockController's sole PROPOSER and EXECUTOR and
///         then revokes every role from the deployer EOA. A stand-in that can
///         only answer `getThreshold()` therefore ends the ceremony by
///         freezing the entire topology: nobody can `schedule`, nobody can
///         `execute`, and no role can ever be granted again — including the
///         router `ADMIN_ROLE` grant a governance redeploy needs. On a
///         rehearsal or devnet chain that is not a safety property, it is a
///         bricked environment, and it is why the post-handover half of
///         AC-GOV-04 could not be exercised at all.
///
///         `owner` is the address that deployed this contract (the rehearsal
///         deployer EOA). It stands in for the Safe's signer set, with a
///         threshold of exactly one real key — which is precisely why this
///         contract must never be used in production, where the signer set is
///         a real 2-of-N Safe with hardware wallets
///         (docs/technical/security-model.md §4).
contract RehearsalSafe {
    /// @notice The single key permitted to forward calls. Set at construction
    ///         to the deployer and never changed.
    address public immutable owner;

    error NotOwner();
    error CallFailed(bytes returndata);

    constructor(address owner_) {
        owner = owner_;
    }

    /// @notice DeployTimelock._validate's threshold check.
    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    /// @notice Forward one call as this contract. Used to drive the
    ///         TimelockController's `schedule`/`execute` after handover.
    /// @param target Contract to call.
    /// @param value  Wei to forward.
    /// @param data   ABI-encoded calldata.
    /// @return returndata The call's raw return data.
    function exec(address target, uint256 value, bytes calldata data)
        external
        payable
        returns (bytes memory returndata)
    {
        if (msg.sender != owner) revert NotOwner();
        bool ok;
        // slither-disable-next-line low-level-calls
        (ok, returndata) = target.call{value: value}(data);
        if (!ok) revert CallFailed(returndata);
    }

    receive() external payable {}
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
        // `msg.sender` is the broadcasting account: the rehearsal deployer,
        // which becomes the one key able to drive the timelock afterwards.
        safe = new RehearsalSafe(msg.sender);
        vm.stopBroadcast();

        console2.log("  owner (sole key able to drive the timelock):", safe.owner());

        console2.log("RehearsalSafe deployed:", address(safe));
    }
}
