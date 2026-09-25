// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md — gateway agent policy rules
// Implements: issue #1476 — one shared policy validator for every agents[...] writer,
//             and owner-initiated transferAgentOwnership to an ADMIN_ROLE holder.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {MockVault} from "../gateway/MockVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Shared fixture: a gateway with two ADMIN_ROLE holders (`admin`, the
///      constructor admin, and `adminOwner`, who owns agents in these tests)
///      and a permissionless account (`user`) that authorizes through
///      commit/reveal.
abstract contract GatewayAgentPolicyFixture is Test {
    uint256 internal constant ONE_USDC = 1e6;

    TestERC20 internal usdc;
    MockVault internal vault;
    RobotMoneyGateway internal gateway;

    bytes32 internal ADMIN_ROLE;
    bytes32 internal AGENT_ROLE;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    /// An ADMIN_ROLE holder that owns agents.
    address internal adminOwner = makeAddr("adminOwner");
    /// A second ADMIN_ROLE holder, the destination of ownership transfers.
    address internal adminB = makeAddr("adminB");
    /// A permissionless owner: no role at all.
    address internal user = makeAddr("user");
    address internal stranger = makeAddr("stranger");
    address internal otherReceiver = makeAddr("otherReceiver");

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        vm.roll(100);
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        ADMIN_ROLE = gateway.ADMIN_ROLE();
        AGENT_ROLE = gateway.AGENT_ROLE();
        vm.startPrank(admin);
        gateway.grantRole(ADMIN_ROLE, adminOwner);
        gateway.grantRole(ADMIN_ROLE, adminB);
        vm.stopPrank();
    }

    function _policy(address receiver) internal view returns (IGateway.AgentPolicy memory p) {
        address[] memory empty = new address[](0);
        p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 100 * ONE_USDC,
            maxPerWindow: 1_000 * ONE_USDC,
            shareReceiver: receiver,
            allowedDestinations: empty,
            assetRecipient: receiver,
            maxWithdrawPerPayment: 10 * ONE_USDC,
            maxWithdrawPerWindow: 100 * ONE_USDC,
            allowedSourceVaults: empty
        });
    }

    function _commit(address owner, address agent, bytes32 salt) internal {
        vm.prank(owner);
        gateway.commitAuthorization(keccak256(abi.encode(agent, owner, salt)));
    }

    /// @dev Commit/reveal authorization by `owner`, waiting the one block the
    ///      commitment requires.
    function _reveal(address owner, address agent, IGateway.AgentPolicy memory p) internal {
        bytes32 salt = keccak256(abi.encode("salt", agent));
        _commit(owner, agent, salt);
        vm.roll(block.number + 1);
        vm.prank(owner);
        gateway.revealAuthorization(agent, salt, p);
    }

    /// @dev Low-level call as `caller`: success flag and the revert selector.
    function _try(address caller, bytes memory data) internal returns (bool ok, bytes4 sel) {
        bytes memory ret;
        vm.prank(caller);
        (ok, ret) = address(gateway).call(data);
        if (!ok) {
            assertGe(ret.length, 4, "revert carried no selector");
            sel = bytes4(ret);
        }
    }

    /// @dev The non-array fields of the stored policy, as one hash.
    function _storedPolicyHash(address agent) internal view returns (bytes32) {
        (
            bool active,
            uint64 validUntil,
            uint256 maxPerPayment,
            uint256 maxPerWindow,
            address shareReceiver,
            address assetRecipient,
            uint256 maxWithdrawPerPayment,
            uint256 maxWithdrawPerWindow
        ) = gateway.agents(agent);
        return keccak256(
            abi.encode(
                active,
                validUntil,
                maxPerPayment,
                maxPerWindow,
                shareReceiver,
                assetRecipient,
                maxWithdrawPerPayment,
                maxWithdrawPerWindow
            )
        );
    }

    function _storedShareReceiver(address agent) internal view returns (address receiver) {
        (,,,, receiver,,,) = gateway.agents(agent);
    }
}

/// @title GatewayAgentPolicyAuthorizationTest
/// @notice Every writer of `agents[...]` / `agentOwner[...]` applies the same
///         caller-dependent rule, judged on the caller's role at call time: a
///         caller without ADMIN_ROLE must name itself as `shareReceiver`.
contract GatewayAgentPolicyAuthorizationTest is GatewayAgentPolicyFixture {
    address internal agentU = makeAddr("agentU");
    address internal agentA = makeAddr("agentA");

    // ─── setPolicy: permissionless owner ─────────────────────────────────────

    function test_setPolicy_nonAdminOwner_foreignShareReceiver_reverts_policyUnchanged() public {
        _reveal(user, agentU, _policy(user));
        bytes32 before = _storedPolicyHash(agentU);

        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.ShareReceiverNotAuthorized.selector);
        gateway.setPolicy(agentU, _policy(otherReceiver));

        assertEq(_storedPolicyHash(agentU), before, "stored policy changed");
        assertEq(_storedShareReceiver(agentU), user, "shareReceiver changed");
    }

    function test_setPolicy_nonAdminOwner_zeroShareReceiver_reverts_likeAuthorization() public {
        _reveal(user, agentU, _policy(user));
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.ShareReceiverNotAuthorized.selector);
        gateway.setPolicy(agentU, _policy(address(0)));
    }

    function test_setPolicy_nonAdminOwner_selfShareReceiver_updates_andEmits() public {
        _reveal(user, agentU, _policy(user));
        IGateway.AgentPolicy memory p = _policy(user);
        p.maxPerPayment = 7 * ONE_USDC;
        p.maxPerWindow = 70 * ONE_USDC;
        p.validUntil = uint64(block.timestamp + 3 days);

        vm.expectEmit(true, true, false, true, address(gateway));
        emit IGateway.AgentAuthorized(
            agentU, user, p.validUntil, p.maxPerPayment, p.maxPerWindow, user
        );
        vm.prank(user);
        gateway.setPolicy(agentU, p);

        (, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address receiver,,,) =
            gateway.agents(agentU);
        assertEq(validUntil, p.validUntil, "validUntil");
        assertEq(maxPerPayment, p.maxPerPayment, "maxPerPayment");
        assertEq(maxPerWindow, p.maxPerWindow, "maxPerWindow");
        assertEq(receiver, user, "shareReceiver");
    }

    // ─── setPolicy: ADMIN_ROLE owner ─────────────────────────────────────────

    function test_setPolicy_adminOwner_acceptsForeignShareReceiver() public {
        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(otherReceiver));

        address next = makeAddr("nextReceiver");
        vm.prank(adminOwner);
        gateway.setPolicy(agentA, _policy(next));
        assertEq(_storedShareReceiver(agentA), next, "admin owner could not set a receiver");
    }

    /// @notice For an ADMIN_ROLE owner, setPolicy accepts exactly what
    ///         authorizeAgent accepts: each policy is sent to both, and the
    ///         outcome and the revert selector must agree.
    function test_setPolicy_adminOwner_matchesAuthorizeAgent() public {
        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(adminOwner));

        IGateway.AgentPolicy[] memory cases = new IGateway.AgentPolicy[](9);
        cases[0] = _policy(otherReceiver); // accepted
        cases[1] = _policy(address(0)); // InvalidShareReceiver
        cases[2] = _policy(otherReceiver);
        cases[2].active = false; // InvalidValidUntil
        cases[3] = _policy(otherReceiver);
        cases[3].validUntil = uint64(block.timestamp - 1); // InvalidValidUntil
        cases[4] = _policy(otherReceiver);
        cases[4].maxPerPayment = 0; // InvalidAmount
        cases[5] = _policy(otherReceiver);
        cases[5].maxPerPayment = cases[5].maxPerWindow + 1; // InvalidAmount
        cases[6] = _policy(otherReceiver);
        cases[6].assetRecipient = address(0); // InvalidAssetRecipient
        cases[7] = _policy(otherReceiver);
        cases[7].maxWithdrawPerWindow = 0; // InvalidAmount
        cases[8] = _policy(otherReceiver);
        cases[8].maxWithdrawPerPayment = 0; // withdrawal disabled: accepted

        uint256 accepted;
        for (uint256 i = 0; i < cases.length; i++) {
            address fresh = address(uint160(0xA000 + i));
            (bool okAuth, bytes4 selAuth) =
                _try(adminOwner, abi.encodeCall(gateway.authorizeAgent, (fresh, cases[i])));
            (bool okSet, bytes4 selSet) =
                _try(adminOwner, abi.encodeCall(gateway.setPolicy, (agentA, cases[i])));
            assertEq(okSet, okAuth, "setPolicy and authorizeAgent disagree on acceptance");
            assertEq(selSet, selAuth, "setPolicy and authorizeAgent disagree on the revert");
            if (okSet) accepted++;
        }
        assertEq(accepted, 2, "expected exactly the two valid cases to be accepted");
    }

    // ─── Differential fuzz: setPolicy vs fresh authorization ─────────────────

    /// @notice For fuzzed (caller role, policy) pairs, setPolicy on an agent
    ///         the caller owns and a fresh authorization by the same caller
    ///         (revealAuthorization for every caller, authorizeAgent as well
    ///         for an ADMIN_ROLE caller) either all succeed or all revert
    ///         with the same selector.
    function testFuzz_setPolicy_matchesFreshAuthorization(bool callerIsAdmin, uint256 seed) public {
        address caller = callerIsAdmin ? adminOwner : user;
        address owned = makeAddr("owned");
        address freshReveal = makeAddr("freshReveal");

        // The caller owns `owned` under a valid policy it could always set.
        _reveal(caller, owned, _policy(caller));
        bytes32 salt = keccak256("fresh");
        _commit(caller, freshReveal, salt);
        vm.roll(block.number + 1);

        IGateway.AgentPolicy memory p = _fuzzPolicy(caller, seed);

        (bool okSet, bytes4 selSet) = _try(caller, abi.encodeCall(gateway.setPolicy, (owned, p)));
        (bool okReveal, bytes4 selReveal) =
            _try(caller, abi.encodeCall(gateway.revealAuthorization, (freshReveal, salt, p)));
        assertEq(okSet, okReveal, "setPolicy and revealAuthorization disagree on acceptance");
        assertEq(selSet, selReveal, "setPolicy and revealAuthorization disagree on the revert");

        if (callerIsAdmin) {
            (bool okAuth, bytes4 selAuth) =
                _try(caller, abi.encodeCall(gateway.authorizeAgent, (makeAddr("freshAdmin"), p)));
            assertEq(okSet, okAuth, "setPolicy and authorizeAgent disagree on acceptance");
            assertEq(selSet, selAuth, "setPolicy and authorizeAgent disagree on the revert");
        }
    }

    /// @dev A policy whose every validated field is drawn from a small domain
    ///      around its boundary, one byte of `seed` per field: receivers from
    ///      {caller, another account, zero}, validUntil from {now-1, now, now+1},
    ///      caps from 0..3.
    function _fuzzPolicy(address caller, uint256 seed)
        internal
        view
        returns (IGateway.AgentPolicy memory p)
    {
        p = _policy(caller);
        address[3] memory who = [caller, otherReceiver, address(0)];
        p.shareReceiver = who[uint8(seed) % 3];
        p.assetRecipient = who[uint8(seed >> 8) % 3];
        p.active = uint8(seed >> 16) % 4 != 0;
        p.validUntil = uint64(block.timestamp - 1 + (uint8(seed >> 24) % 3));
        p.maxPerPayment = uint8(seed >> 32) % 4;
        p.maxPerWindow = uint8(seed >> 40) % 4;
        p.maxWithdrawPerPayment = uint8(seed >> 48) % 4;
        p.maxWithdrawPerWindow = uint8(seed >> 56) % 4;
    }

    // ─── Role judged at call time ────────────────────────────────────────────

    /// @notice An owner that authorized an agent while holding ADMIN_ROLE and
    ///         later lost it is judged as a caller without ADMIN_ROLE.
    function test_setPolicy_ownerLostAdminRole_judgedAsNonAdmin() public {
        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(otherReceiver));

        vm.prank(admin);
        gateway.revokeRole(ADMIN_ROLE, adminOwner);
        assertFalse(gateway.hasRole(ADMIN_ROLE, adminOwner), "role not revoked");

        // The very policy it set while holding ADMIN_ROLE is now refused.
        vm.prank(adminOwner);
        vm.expectRevert(RobotMoneyGateway.ShareReceiverNotAuthorized.selector);
        gateway.setPolicy(agentA, _policy(otherReceiver));
        assertEq(_storedShareReceiver(agentA), otherReceiver, "stored policy changed");

        // Naming itself is still allowed, as for any caller without the role.
        vm.prank(adminOwner);
        gateway.setPolicy(agentA, _policy(adminOwner));
        assertEq(_storedShareReceiver(agentA), adminOwner, "self receiver not stored");
    }

    // ─── Writer x caller-role matrix ─────────────────────────────────────────

    function test_authorizeAgent_adminCaller_succeeds() public {
        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(otherReceiver));
        assertEq(gateway.agentOwner(agentA), adminOwner, "owner not recorded");
        assertTrue(gateway.hasRole(AGENT_ROLE, agentA), "AGENT_ROLE not granted");
    }

    function test_authorizeAgent_permissionlessCaller_reverts() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user, ADMIN_ROLE
            )
        );
        gateway.authorizeAgent(agentU, _policy(user));
    }

    function test_revealAuthorization_adminCaller_acceptsForeignShareReceiver() public {
        _reveal(adminOwner, agentA, _policy(otherReceiver));
        assertEq(gateway.agentOwner(agentA), adminOwner, "owner not recorded");
        assertEq(_storedShareReceiver(agentA), otherReceiver, "receiver not stored");
    }

    function test_revealAuthorization_permissionlessOwner_selfShareReceiver_succeeds() public {
        _reveal(user, agentU, _policy(user));
        assertEq(gateway.agentOwner(agentU), user, "owner not recorded");
        assertTrue(gateway.hasRole(AGENT_ROLE, agentU), "AGENT_ROLE not granted");
    }

    function test_revealAuthorization_permissionlessOwner_foreignShareReceiver_reverts() public {
        bytes32 salt = keccak256("s");
        _commit(user, agentU, salt);
        vm.roll(block.number + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.ShareReceiverNotAuthorized.selector);
        gateway.revealAuthorization(agentU, salt, _policy(otherReceiver));
    }

    function test_revokeAgent_adminOwner_succeeds() public {
        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(otherReceiver));
        vm.prank(adminOwner);
        gateway.revokeAgent(agentA);
        assertEq(gateway.agentOwner(agentA), address(0), "owner not cleared");
        assertFalse(gateway.hasRole(AGENT_ROLE, agentA), "AGENT_ROLE kept");
    }

    function test_revokeAgent_permissionlessOwner_succeeds() public {
        _reveal(user, agentU, _policy(user));
        vm.prank(user);
        gateway.revokeAgent(agentU);
        assertEq(gateway.agentOwner(agentU), address(0), "owner not cleared");
        assertFalse(gateway.hasRole(AGENT_ROLE, agentU), "AGENT_ROLE kept");
    }

    function test_transferAgentOwnership_adminOwner_succeeds() public {
        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(otherReceiver));
        vm.prank(adminOwner);
        gateway.transferAgentOwnership(agentA, adminB);
        assertEq(gateway.agentOwner(agentA), adminB, "owner not moved");
    }

    function test_transferAgentOwnership_permissionlessOwner_toAdmin_succeeds() public {
        _reveal(user, agentU, _policy(user));
        vm.prank(user);
        gateway.transferAgentOwnership(agentU, adminB);
        assertEq(gateway.agentOwner(agentU), adminB, "owner not moved");
    }

    /// @notice setPolicy, revokeAgent and transferAgentOwnership from anyone
    ///         other than the recorded owner revert NotAgentOwner, for a
    ///         permissionless caller and for an ADMIN_ROLE caller alike.
    function test_nonOwner_setPolicy_revokeAgent_transfer_revertNotAgentOwner() public {
        _reveal(user, agentU, _policy(user));
        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(otherReceiver));

        address[2] memory callers = [stranger, adminB];
        address[2] memory owned = [agentU, agentA];
        for (uint256 i = 0; i < callers.length; i++) {
            for (uint256 j = 0; j < owned.length; j++) {
                vm.prank(callers[i]);
                vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
                gateway.setPolicy(owned[j], _policy(callers[i]));

                vm.prank(callers[i]);
                vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
                gateway.revokeAgent(owned[j]);

                vm.prank(callers[i]);
                vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
                gateway.transferAgentOwnership(owned[j], adminB);
            }
        }
        assertEq(gateway.agentOwner(agentU), user, "user lost its agent");
        assertEq(gateway.agentOwner(agentA), adminOwner, "adminOwner lost its agent");
    }

    // ─── transferAgentOwnership ──────────────────────────────────────────────

    function test_transferAgentOwnership_keepsRoleAndPolicy_emits_movesAuthority() public {
        _reveal(user, agentU, _policy(user));
        bytes32 policyBefore = _storedPolicyHash(agentU);

        vm.expectEmit(true, true, true, true, address(gateway));
        emit IGateway.AgentOwnershipTransferred(agentU, user, adminB);
        vm.prank(user);
        gateway.transferAgentOwnership(agentU, adminB);

        assertEq(gateway.agentOwner(agentU), adminB, "owner not moved");
        assertTrue(gateway.hasRole(AGENT_ROLE, agentU), "AGENT_ROLE lost");
        assertEq(_storedPolicyHash(agentU), policyBefore, "stored policy changed");

        // The previous owner has no authority left over the agent.
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.setPolicy(agentU, _policy(user));
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agentU);

        // The new owner has all of it.
        vm.prank(adminB);
        gateway.setPolicy(agentU, _policy(otherReceiver));
        assertEq(_storedShareReceiver(agentU), otherReceiver, "new owner could not set policy");
        vm.prank(adminB);
        gateway.revokeAgent(agentU);
        assertFalse(gateway.hasRole(AGENT_ROLE, agentU), "new owner could not revoke");
    }

    function test_transferAgentOwnership_nonAdminDestination_reverts() public {
        _reveal(user, agentU, _policy(user));
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.NewAgentOwnerNotAdmin.selector);
        gateway.transferAgentOwnership(agentU, stranger);

        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(otherReceiver));
        vm.prank(adminOwner);
        vm.expectRevert(RobotMoneyGateway.NewAgentOwnerNotAdmin.selector);
        gateway.transferAgentOwnership(agentA, user);

        assertEq(gateway.agentOwner(agentU), user, "owner moved to a non-admin");
        assertEq(gateway.agentOwner(agentA), adminOwner, "owner moved to a non-admin");
    }

    /// @notice The destination rule is the whole rule for a transfer: the
    ///         caller-dependent shareReceiver rule does not bind an ADMIN_ROLE
    ///         destination, so a stored policy naming a third-party receiver
    ///         moves unchanged, and the new owner can set that same policy.
    function test_transferAgentOwnership_foreignStoredReceiver_movesUnchecked() public {
        vm.prank(adminOwner);
        gateway.authorizeAgent(agentA, _policy(otherReceiver));
        bytes32 policyBefore = _storedPolicyHash(agentA);

        vm.prank(adminOwner);
        gateway.transferAgentOwnership(agentA, adminB);

        assertEq(gateway.agentOwner(agentA), adminB, "owner not moved");
        assertEq(_storedPolicyHash(agentA), policyBefore, "stored policy changed");
        assertEq(_storedShareReceiver(agentA), otherReceiver, "stored receiver changed");
        vm.prank(adminB);
        gateway.setPolicy(agentA, _policy(otherReceiver));
    }

    function test_transferAgentOwnership_zeroAddress_reverts() public {
        _reveal(user, agentU, _policy(user));
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        gateway.transferAgentOwnership(agentU, address(0));

        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        gateway.transferAgentOwnership(address(0), adminB);
    }

    function test_transferAgentOwnership_unownedAgent_revertsNotAgentOwner() public {
        vm.prank(adminOwner);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.transferAgentOwnership(makeAddr("nobodysAgent"), adminB);
    }

    /// @notice The destination is judged at call time: an account that lost
    ///         ADMIN_ROLE can no longer receive an agent.
    function test_transferAgentOwnership_destinationLostAdminRole_reverts() public {
        _reveal(user, agentU, _policy(user));
        vm.prank(admin);
        gateway.revokeRole(ADMIN_ROLE, adminB);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.NewAgentOwnerNotAdmin.selector);
        gateway.transferAgentOwnership(agentU, adminB);
    }
}

/// @title GatewayAgentPolicyCodeSizeGuard
/// @notice The gateway's deployed runtime stays under the EIP-170 limit with
///         the shared validator and transferAgentOwnership in it. Kept in its
///         own contract so the coverage job, which instruments bytecode past
///         the limit, can exclude it by name as it does VaultCodeSizeGuard.
contract GatewayAgentPolicyCodeSizeGuard is GatewayAgentPolicyFixture {
    uint256 internal constant EIP170_LIMIT = 24_576;

    function test_gatewayRuntime_underEip170() public {
        uint256 deployed = address(gateway).code.length;
        uint256 artifact = vm.getDeployedCode("RobotMoneyGateway.sol:RobotMoneyGateway").length;
        emit log_named_uint("RobotMoneyGateway deployed runtime bytes", deployed);
        emit log_named_uint("RobotMoneyGateway artifact runtime bytes", artifact);
        assertLt(deployed, EIP170_LIMIT, "deployed gateway runtime exceeds EIP-170");
        assertLt(artifact, EIP170_LIMIT, "gateway artifact runtime exceeds EIP-170");
    }
}
