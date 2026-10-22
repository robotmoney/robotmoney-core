// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IGateway} from "../../gateway/interfaces/IGateway.sol";

/// @title AgentRegistration
/// @notice Test helper that registers a gateway agent the only way the gateway
///         allows (ACL-9): agent consent, owner commit, one block, owner reveal.
///         The gateway has no admin shortcut, so every test that needs a
///         registered agent goes through here.
/// @dev Canonical: docs/architecture.md section 5.2, docs/technical/smart-contract-invariants.md ACL-9.
library AgentRegistration {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Fixed salt per (agent, owner, validUntil). A consumed commitment is
    ///      deleted, so reusing it for a later registration is safe.
    function saltFor(address agent, address owner, IGateway.AgentPolicy memory p)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode("agent-registration", agent, owner, p.validUntil));
    }

    /// @notice Register `agent` with owner `p.shareReceiver` (the only owner the
    ///         gateway accepts for that policy).
    function register(IGateway gw, address agent, IGateway.AgentPolicy memory p) internal {
        registerAs(gw, p.shareReceiver, agent, p);
    }

    /// @notice Register `agent` with `owner` as the caller of the reveal.
    function registerAs(IGateway gw, address owner, address agent, IGateway.AgentPolicy memory p)
        internal
    {
        commitBoth(gw, owner, agent, p);
        vm.prank(owner);
        gw.revealAuthorization(agent, saltFor(agent, owner, p), p);
    }

    /// @notice The consent commit (when `agent != owner`), the owner commit and
    ///         one block of waiting. A test calls `revealAuthorization` itself
    ///         afterwards, for example under `vm.expectRevert`.
    function commitBoth(IGateway gw, address owner, address agent, IGateway.AgentPolicy memory p)
        internal
    {
        bytes32 salt = saltFor(agent, owner, p);
        if (agent != owner) {
            vm.prank(agent);
            gw.commitAuthorization(consentHash(owner, agent, salt, p));
        }
        vm.prank(owner);
        gw.commitAuthorization(keccak256(abi.encode(agent, owner, salt)));
        vm.roll(block.number + 1);
    }

    /// @notice Commits as `registerAs` does, then expects the reveal to revert with `err`.
    function revealExpectRevert(
        IGateway gw,
        address owner,
        address agent,
        IGateway.AgentPolicy memory p,
        bytes4 err
    ) internal {
        commitBoth(gw, owner, agent, p);
        vm.prank(owner);
        vm.expectRevert(err);
        gw.revealAuthorization(agent, saltFor(agent, owner, p), p);
    }

    /// @notice The hash the agent commits to consent to `owner` for this exact reveal.
    function consentHash(address owner, address agent, bytes32 salt, IGateway.AgentPolicy memory p)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                owner, keccak256(abi.encodeCall(IGateway.revealAuthorization, (agent, salt, p)))
            )
        );
    }
}
