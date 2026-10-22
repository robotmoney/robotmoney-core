// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md — ACL-9, GW-6, GW-7
//            docs/architecture.md section 5.2 — agent ownership and policy rules
// Implements: issue #1890 — owner-consented agent lifecycle (RS-1019-10 to 13).
//             Earlier: issue #1476 — one shared policy validator for every agents[...] writer.
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {AccessRoles} from "../gateway/AccessRoles.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {GovernedUUPS} from "../lib/GovernedUUPS.sol";
import {AgentRegistration} from "./helpers/AgentRegistration.sol";

/// @dev Shared fixture: a gateway with two ADMIN_ROLE holders (`admin`, the
///      constructor admin that also holds DEFAULT_ADMIN_ROLE, and `adminOwner`)
///      and a permissionless account (`user`). Every account registers agents the
///      same way: agent consent, owner commit, owner reveal.
abstract contract GatewayAgentPolicyFixture is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant COMMIT_EXPIRY = 256;

    TestERC20 internal usdc;
    MockVault internal vault;
    RobotMoneyGateway internal gateway;

    bytes32 internal ADMIN_ROLE;
    bytes32 internal AGENT_ROLE;
    bytes32 internal DEPOSIT_PAUSER_ROLE;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    /// An ADMIN_ROLE holder that owns agents.
    address internal adminOwner = makeAddr("adminOwner");
    /// A second ADMIN_ROLE holder.
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
        gateway = CoreProxies.robotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        ADMIN_ROLE = gateway.ADMIN_ROLE();
        AGENT_ROLE = gateway.AGENT_ROLE();
        DEPOSIT_PAUSER_ROLE = gateway.DEPOSIT_PAUSER_ROLE();
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

    /// @dev Full consented registration by `owner` (consent, commit, one block, reveal).
    function _reveal(address owner, address agent, IGateway.AgentPolicy memory p) internal {
        AgentRegistration.registerAs(gateway, owner, agent, p);
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

    function _storedValidUntil(address agent) internal view returns (uint64 validUntil) {
        (, validUntil,,,,,,) = gateway.agents(agent);
    }

    /// @dev The agent deposits `amount` USDC through the gateway.
    function _deposit(address agent, uint256 amount, bytes32 key) internal {
        usdc.mint(agent, amount);
        vm.startPrank(agent);
        usdc.approve(address(gateway), amount);
        gateway.deposit(
            keccak256(abi.encode("order", key)), amount, uint64(block.timestamp + 60), key
        );
        vm.stopPrank();
    }

    /// @dev A deposit that must revert with `err`.
    function _depositReverts(address agent, uint256 amount, bytes32 key, bytes memory err)
        internal
    {
        usdc.mint(agent, amount);
        vm.startPrank(agent);
        usdc.approve(address(gateway), amount);
        vm.expectRevert(err);
        gateway.deposit(
            keccak256(abi.encode("order", key)), amount, uint64(block.timestamp + 60), key
        );
        vm.stopPrank();
    }
}

/// @title GatewayAgentPolicyAuthorizationTest
/// @notice Every writer of `agents[...]` / `agentOwner[...]` applies the same
///         rule to every caller, whatever its role: the caller names itself as
///         `shareReceiver` (ACL-9, GW-7).
contract GatewayAgentPolicyAuthorizationTest is GatewayAgentPolicyFixture {
    address internal agentU = makeAddr("agentU");
    address internal agentA = makeAddr("agentA");

    // ─── setPolicy: every owner must name itself ─────────────────────────────

    function test_setPolicy_nonAdminOwner_foreignShareReceiver_reverts_policyUnchanged() public {
        _reveal(user, agentU, _policy(user));
        bytes32 before = _storedPolicyHash(agentU);

        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.ShareReceiverNotAuthorized.selector);
        gateway.setPolicy(agentU, _policy(otherReceiver));

        assertEq(_storedPolicyHash(agentU), before, "stored policy changed");
        assertEq(_storedShareReceiver(agentU), user, "shareReceiver changed");
    }

    function test_setPolicy_nonAdminOwner_zeroShareReceiver_reverts() public {
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

    /// @notice ADMIN_ROLE grants no receiver exception on either writer (ACL-9).
    function test_adminOwner_foreignShareReceiver_reverts_onSetPolicyAndReveal() public {
        _reveal(adminOwner, agentA, _policy(adminOwner));
        bytes32 before = _storedPolicyHash(agentA);

        vm.prank(adminOwner);
        vm.expectRevert(RobotMoneyGateway.ShareReceiverNotAuthorized.selector);
        gateway.setPolicy(agentA, _policy(otherReceiver));
        assertEq(_storedPolicyHash(agentA), before, "stored policy changed");

        AgentRegistration.revealExpectRevert(
            gateway,
            adminOwner,
            agentU,
            _policy(otherReceiver),
            RobotMoneyGateway.ShareReceiverNotAuthorized.selector
        );
        assertEq(gateway.agentOwner(agentU), address(0), "foreign receiver registered");
    }

    function test_adminOwner_selfShareReceiver_registersAndUpdates() public {
        _reveal(adminOwner, agentA, _policy(adminOwner));
        assertEq(gateway.agentOwner(agentA), adminOwner, "owner not recorded");
        assertEq(_storedShareReceiver(agentA), adminOwner, "receiver not the owner");
        assertTrue(gateway.hasRole(AGENT_ROLE, agentA), "AGENT_ROLE not granted");

        IGateway.AgentPolicy memory p = _policy(adminOwner);
        p.maxPerPayment = 5 * ONE_USDC;
        vm.prank(adminOwner);
        gateway.setPolicy(agentA, p);
        (,, uint256 maxPerPayment,,,,,) = gateway.agents(agentA);
        assertEq(maxPerPayment, 5 * ONE_USDC, "admin owner could not update");
    }

    // ─── Differential fuzz: setPolicy vs fresh registration ──────────────────

    /// @notice For fuzzed (caller role, policy) pairs, setPolicy on an agent the
    ///         caller owns and a fresh reveal by the same caller either both
    ///         succeed or both revert with the same selector (GW-7, ACL-9).
    function testFuzz_setPolicy_matchesFreshRegistration(uint8 callerKind, uint256 seed) public {
        address[3] memory callers = [adminOwner, user, admin];
        address caller = callers[callerKind % 3];
        address owned = makeAddr("owned");
        address freshReveal = makeAddr("freshReveal");

        // The caller owns `owned` under a valid policy it could always set.
        _reveal(caller, owned, _policy(caller));
        bytes32 salt = keccak256("fresh");
        IGateway.AgentPolicy memory p = _fuzzPolicy(caller, seed);
        // The fresh agent consents to the caller for this exact reveal (core 1791),
        // before the caller's own commit.
        vm.prank(freshReveal);
        gateway.commitAuthorization(AgentRegistration.consentHash(caller, freshReveal, salt, p));
        vm.prank(caller);
        gateway.commitAuthorization(keccak256(abi.encode(freshReveal, caller, salt)));
        vm.roll(block.number + 1);

        (bool okSet, bytes4 selSet) = _try(caller, abi.encodeCall(gateway.setPolicy, (owned, p)));
        (bool okReveal, bytes4 selReveal) =
            _try(caller, abi.encodeCall(gateway.revealAuthorization, (freshReveal, salt, p)));
        assertEq(okSet, okReveal, "setPolicy and revealAuthorization disagree on acceptance");
        assertEq(selSet, selReveal, "setPolicy and revealAuthorization disagree on the revert");
        if (okSet) {
            assertEq(p.shareReceiver, caller, "an accepted policy named a foreign receiver");
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

    /// @notice The receiver rule does not depend on the caller's role at all: an
    ///         owner that lost ADMIN_ROLE is judged exactly as before.
    function test_setPolicy_ownerLosingAdminRole_changesNothing() public {
        _reveal(adminOwner, agentA, _policy(adminOwner));

        vm.prank(admin);
        gateway.revokeRole(ADMIN_ROLE, adminOwner);
        assertFalse(gateway.hasRole(ADMIN_ROLE, adminOwner), "role not revoked");

        vm.prank(adminOwner);
        vm.expectRevert(RobotMoneyGateway.ShareReceiverNotAuthorized.selector);
        gateway.setPolicy(agentA, _policy(otherReceiver));

        vm.prank(adminOwner);
        gateway.setPolicy(agentA, _policy(adminOwner));
        assertEq(_storedShareReceiver(agentA), adminOwner, "self receiver not stored");
    }

    // ─── No authority without ownership ──────────────────────────────────────

    /// @notice setPolicy and revokeAgent from anyone other than the recorded owner
    ///         (or, for revoke, the agent) revert NotAgentOwner, for a
    ///         permissionless caller and for ADMIN_ROLE and DEFAULT_ADMIN_ROLE holders alike.
    function test_nonOwner_setPolicy_revokeAgent_revertNotAgentOwner() public {
        _reveal(user, agentU, _policy(user));
        _reveal(adminOwner, agentA, _policy(adminOwner));

        address[4] memory callers = [stranger, adminB, admin, pauser];
        address[2] memory owned = [agentU, agentA];
        for (uint256 i = 0; i < callers.length; i++) {
            for (uint256 j = 0; j < owned.length; j++) {
                vm.prank(callers[i]);
                vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
                gateway.setPolicy(owned[j], _policy(callers[i]));

                vm.prank(callers[i]);
                vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
                gateway.revokeAgent(owned[j]);
            }
        }
        // The two owners cannot touch each other's agent either.
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agentA);
        vm.prank(adminOwner);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.setPolicy(agentU, _policy(adminOwner));

        assertEq(gateway.agentOwner(agentU), user, "user lost its agent");
        assertEq(gateway.agentOwner(agentA), adminOwner, "adminOwner lost its agent");
    }

    /// @notice A live registration's owner never changes: for every caller, a
    ///         fresh reveal, a setPolicy and a foreign revoke leave it in place.
    function testFuzz_noTransitionChangesALiveOwner(uint8 callerKind, uint256 seed) public {
        address[6] memory callers = [stranger, adminB, admin, pauser, user, otherReceiver];
        address caller = callers[callerKind % 6];
        _reveal(adminOwner, agentA, _policy(adminOwner));

        // A takeover attempt by reveal, with the agent's consent in place (the worst case).
        IGateway.AgentPolicy memory p = _policy(caller);
        p.maxPerPayment = 1 + (seed % 50);
        (bool ok, bytes4 sel) = _tryReveal(caller, agentA, p);
        assertFalse(ok, "a live agent was re-registered");
        assertEq(sel, RobotMoneyGateway.AgentAlreadyOwned.selector, "wrong refusal");

        (ok,) = _try(caller, abi.encodeCall(gateway.setPolicy, (agentA, p)));
        assertFalse(ok, "setPolicy by a non-owner succeeded");
        (ok,) = _try(caller, abi.encodeCall(gateway.revokeAgent, (agentA)));
        assertFalse(ok, "revokeAgent by a non-owner succeeded");

        assertEq(gateway.agentOwner(agentA), adminOwner, "owner changed");
        assertTrue(gateway.hasRole(AGENT_ROLE, agentA), "agent lost its role");
    }

    /// @dev Consent plus commit plus a low-level reveal by `caller` for `agent`.
    function _tryReveal(address caller, address agent, IGateway.AgentPolicy memory p)
        internal
        returns (bool ok, bytes4 sel)
    {
        AgentRegistration.commitBoth(gateway, caller, agent, p);
        (ok, sel) = _try(
            caller,
            abi.encodeCall(
                gateway.revealAuthorization, (agent, AgentRegistration.saltFor(agent, caller, p), p)
            )
        );
    }

    // ─── ABI: the removed entrypoints are gone ───────────────────────────────

    function test_removedSelectors_absent() public {
        IGateway.AgentPolicy memory p = _policy(admin);
        vm.prank(admin);
        (bool ok,) = address(gateway)
            .call(
                abi.encodeWithSignature(
                    "authorizeAgent(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))",
                    agentA,
                    p
                )
            );
        assertFalse(ok, "authorizeAgent still exists");
        _reveal(user, agentU, _policy(user));
        vm.prank(user);
        (ok,) = address(gateway)
            .call(
                abi.encodeWithSignature("transferAgentOwnership(address,address)", agentU, adminB)
            );
        assertFalse(ok, "transferAgentOwnership still exists");
        assertEq(gateway.agentOwner(agentU), user, "owner moved");
    }
}

/// @title GatewayAgentRoleImmunityTest
/// @notice ACL-9: AGENT_ROLE can be neither granted, revoked nor renounced through
///         the public role methods, by any caller, whatever the stored role admin.
contract GatewayAgentRoleImmunityTest is GatewayAgentPolicyFixture {
    /// ERC-7201 slot of OpenZeppelin AccessControlUpgradeable storage.
    bytes32 internal constant AC_STORAGE =
        0x02dd7bc7dec4dceedda775e58dd541e08a116c6c53815c0bd028192f7b626800;

    address internal agentU = makeAddr("agentU");
    address internal target = makeAddr("roleTarget");

    function _callers() internal view returns (address[8] memory c) {
        c = [admin, adminOwner, adminB, pauser, user, stranger, agentU, address(gateway)];
    }

    /// @dev Overwrites the stored admin role of `role` (an unset or manipulated role admin).
    function _setRoleAdmin(bytes32 role, bytes32 newAdminRole) internal {
        bytes32 roleData = keccak256(abi.encode(role, AC_STORAGE));
        vm.store(address(gateway), bytes32(uint256(roleData) + 1), newAdminRole);
        assertEq(gateway.getRoleAdmin(role), newAdminRole, "role admin not overwritten");
    }

    function _assertImmune(bytes32 note) internal {
        address[8] memory callers = _callers();
        for (uint256 i = 0; i < callers.length; i++) {
            address caller = callers[i];
            vm.prank(caller);
            vm.expectRevert(AccessRoles.AgentRoleNotManageable.selector);
            gateway.grantRole(AGENT_ROLE, target);

            vm.prank(caller);
            vm.expectRevert(AccessRoles.AgentRoleNotManageable.selector);
            gateway.revokeRole(AGENT_ROLE, agentU);

            vm.prank(caller);
            vm.expectRevert(AccessRoles.AgentRoleNotManageable.selector);
            gateway.renounceRole(AGENT_ROLE, caller);
        }
        assertFalse(
            gateway.hasRole(AGENT_ROLE, target), string(abi.encodePacked(note, ": granted"))
        );
        assertTrue(gateway.hasRole(AGENT_ROLE, agentU), string(abi.encodePacked(note, ": revoked")));
    }

    function test_agentRole_immuneForEveryCaller_defaultRoleAdmin() public {
        _reveal(user, agentU, _policy(user));
        _assertImmune("default");
    }

    function test_agentRole_immuneForEveryCaller_afterRoleAdminManipulation() public {
        _reveal(user, agentU, _policy(user));
        // The role admin points at DEFAULT_ADMIN_ROLE (the unset value), which `admin` holds.
        _setRoleAdmin(AGENT_ROLE, bytes32(0));
        _assertImmune("default admin");
        // The role admin points at itself, so the agent administers its own role.
        _setRoleAdmin(AGENT_ROLE, AGENT_ROLE);
        _assertImmune("self admin");
        // The role admin points at the pauser role.
        _setRoleAdmin(AGENT_ROLE, DEPOSIT_PAUSER_ROLE);
        _assertImmune("pauser admin");
    }

    /// @notice The internal lifecycle paths keep working: a consented reveal grants
    ///         the role and revokeAgent revokes it.
    function test_lifecycle_stillGrantsAndRevokesInternally() public {
        _setRoleAdmin(AGENT_ROLE, bytes32(0));
        _reveal(user, agentU, _policy(user));
        assertTrue(gateway.hasRole(AGENT_ROLE, agentU), "reveal did not grant");
        vm.prank(user);
        gateway.revokeAgent(agentU);
        assertFalse(gateway.hasRole(AGENT_ROLE, agentU), "revokeAgent did not revoke");
    }

    /// @notice Unrelated role operations keep their prior access checks.
    function test_unrelatedRoles_keepTheirAccessChecks() public {
        // ADMIN_ROLE administers DEPOSIT_PAUSER_ROLE? The gateway's admin of every
        // other role is DEFAULT_ADMIN_ROLE, held by `admin`.
        address newPauser = makeAddr("newPauser");
        vm.prank(admin);
        gateway.grantRole(DEPOSIT_PAUSER_ROLE, newPauser);
        assertTrue(
            gateway.hasRole(DEPOSIT_PAUSER_ROLE, newPauser), "admin could not grant the pauser role"
        );

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
            )
        );
        gateway.grantRole(DEPOSIT_PAUSER_ROLE, stranger);

        vm.prank(admin);
        gateway.revokeRole(DEPOSIT_PAUSER_ROLE, newPauser);
        assertFalse(gateway.hasRole(DEPOSIT_PAUSER_ROLE, newPauser), "admin could not revoke");

        vm.prank(pauser);
        gateway.renounceRole(DEPOSIT_PAUSER_ROLE, pauser);
        assertFalse(gateway.hasRole(DEPOSIT_PAUSER_ROLE, pauser), "pauser could not renounce");
    }
}

/// @title GatewayAgentRevokeTest
/// @notice The only exits are `revokeAgent` by the owner or by the agent. Both
///         clear the registration and reset the deposit budget.
contract GatewayAgentRevokeTest is GatewayAgentPolicyFixture {
    address internal agentU = makeAddr("agentU");

    function _spendBudget() internal returns (uint256 spent) {
        for (uint256 i = 0; i < 9; i++) {
            _deposit(agentU, 100 * ONE_USDC, bytes32(i + 1));
        }
        spent = 900 * ONE_USDC;
        assertEq(gateway.effectiveDepositWindowGross(agentU), spent, "budget not spent");
        (, uint256 gross) = gateway.agentDepositWindow(agentU);
        assertEq(gross, spent, "legacy window projection not written");
    }

    function _assertCleared() internal view {
        assertEq(gateway.agentOwner(agentU), address(0), "owner kept");
        assertFalse(gateway.hasRole(AGENT_ROLE, agentU), "role kept");
        (bool active, uint64 validUntil, uint256 maxPay, uint256 maxWin, address recv,,,) =
            gateway.agents(agentU);
        assertFalse(active, "policy active");
        assertEq(validUntil, 0, "validUntil kept");
        assertEq(maxPay, 0, "maxPerPayment kept");
        assertEq(maxWin, 0, "maxPerWindow kept");
        assertEq(recv, address(0), "receiver kept");
        assertEq(gateway.effectiveDepositWindowGross(agentU), 0, "deposit window not reset");
        (uint64 windowStart, uint256 gross) = gateway.agentDepositWindow(agentU);
        assertEq(windowStart, 0, "legacy window start kept");
        assertEq(gross, 0, "legacy window gross kept");
    }

    /// @dev After clearing, a fresh consented registration spends a full budget.
    function _assertFreshBudget(address owner) internal {
        _reveal(owner, agentU, _policy(owner));
        for (uint256 i = 0; i < 10; i++) {
            _deposit(agentU, 100 * ONE_USDC, bytes32(i + 100));
        }
        assertEq(gateway.effectiveDepositWindowGross(agentU), 1_000 * ONE_USDC, "fresh budget");
        _depositReverts(
            agentU,
            ONE_USDC,
            bytes32(uint256(999)),
            abi.encodeWithSelector(RobotMoneyGateway.WindowCapExceeded.selector)
        );
    }

    function test_ownerRevoke_afterSpending_clearsEverything_andReRegistrationHasFreshBudget()
        public
    {
        _reveal(user, agentU, _policy(user));
        _spendBudget();

        vm.expectEmit(true, true, false, false, address(gateway));
        emit IGateway.AgentRevoked(agentU, user);
        vm.prank(user);
        gateway.revokeAgent(agentU);

        _assertCleared();
        _assertFreshBudget(user);
    }

    function test_agentSelfRevoke_afterSpending_clearsEverything_andReRegistrationHasFreshBudget()
        public
    {
        _reveal(adminOwner, agentU, _policy(adminOwner));
        _spendBudget();

        vm.expectEmit(true, true, false, false, address(gateway));
        emit IGateway.AgentRevoked(agentU, adminOwner);
        vm.prank(agentU);
        gateway.revokeAgent(agentU);

        _assertCleared();
        // Another owner can take the address with the agent's consent.
        _assertFreshBudget(user);
        assertEq(gateway.agentOwner(agentU), user, "new owner not recorded");
    }

    function test_revokedAgent_cannotDeposit() public {
        _reveal(user, agentU, _policy(user));
        vm.prank(agentU);
        gateway.revokeAgent(agentU);
        _depositReverts(
            agentU,
            ONE_USDC,
            bytes32(uint256(1)),
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, agentU, AGENT_ROLE
            )
        );
    }

    function test_revoke_byThirdParty_orUnregistered_reverts() public {
        vm.prank(agentU);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agentU);

        _reveal(user, agentU, _policy(user));
        vm.prank(stranger);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agentU);
        vm.prank(admin);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agentU);
        assertEq(gateway.agentOwner(agentU), user, "registration lost");
    }
}

/// @title GatewayAgentExpiryTest
/// @notice A reveal on an agent whose policy `validUntil` passed treats it as
///         unowned. The old owner cannot revive an expired policy.
contract GatewayAgentExpiryTest is GatewayAgentPolicyFixture {
    address internal agentU = makeAddr("agentU");

    function _shortPolicy(address owner, uint64 validUntil)
        internal
        view
        returns (IGateway.AgentPolicy memory p)
    {
        p = _policy(owner);
        p.validUntil = validUntil;
    }

    /// @dev Registers `agentU` for `owner` expiring one hour from now and spends 300 USDC.
    function _registerShort(address owner) internal returns (uint64 validUntil) {
        validUntil = uint64(block.timestamp + 1 hours);
        _reveal(owner, agentU, _shortPolicy(owner, validUntil));
        for (uint256 i = 0; i < 3; i++) {
            _deposit(agentU, 100 * ONE_USDC, bytes32(i + 1));
        }
    }

    function test_equalityAtValidUntil_staysLive_andBlocksReveal() public {
        uint64 validUntil = _registerShort(user);
        vm.warp(validUntil);

        AgentRegistration.revealExpectRevert(
            gateway,
            otherReceiver,
            agentU,
            _policy(otherReceiver),
            RobotMoneyGateway.AgentAlreadyOwned.selector
        );
        assertEq(gateway.agentOwner(agentU), user, "owner changed at equality");
        // The agent still deposits at validUntil.
        _deposit(agentU, ONE_USDC, bytes32(uint256(50)));
    }

    function test_afterValidUntil_differentOwner_replacesWithRevokedThenAuthorized() public {
        uint64 validUntil = _registerShort(user);
        assertEq(gateway.effectiveDepositWindowGross(agentU), 300 * ONE_USDC, "pre budget");
        vm.warp(validUntil + 1);

        IGateway.AgentPolicy memory p = _policy(otherReceiver);
        AgentRegistration.commitBoth(gateway, otherReceiver, agentU, p);
        vm.recordLogs();
        vm.prank(otherReceiver);
        gateway.revealAuthorization(agentU, AgentRegistration.saltFor(agentU, otherReceiver, p), p);
        _assertRevokedThenAuthorized(user, otherReceiver);

        assertEq(gateway.agentOwner(agentU), otherReceiver, "new owner");
        assertTrue(gateway.hasRole(AGENT_ROLE, agentU), "role");
        assertEq(_storedShareReceiver(agentU), otherReceiver, "new receiver");
        assertEq(_storedValidUntil(agentU), p.validUntil, "new policy");
        assertEq(gateway.effectiveDepositWindowGross(agentU), 0, "old window not cleared");
        (, uint256 gross) = gateway.agentDepositWindow(agentU);
        assertEq(gross, 0, "legacy window not cleared");
        // The new owner's budget is whole.
        for (uint256 i = 0; i < 10; i++) {
            _deposit(agentU, 100 * ONE_USDC, bytes32(i + 200));
        }
    }

    function test_afterValidUntil_sameOwner_reRegisters() public {
        uint64 validUntil = _registerShort(user);
        vm.warp(validUntil + 1);

        IGateway.AgentPolicy memory p = _policy(user);
        AgentRegistration.commitBoth(gateway, user, agentU, p);
        vm.recordLogs();
        vm.prank(user);
        gateway.revealAuthorization(agentU, AgentRegistration.saltFor(agentU, user, p), p);
        _assertRevokedThenAuthorized(user, user);

        assertEq(gateway.agentOwner(agentU), user, "owner");
        assertEq(gateway.effectiveDepositWindowGross(agentU), 0, "old window not cleared");
        assertEq(_storedValidUntil(agentU), p.validUntil, "new policy");
    }

    /// @dev Exactly one AgentRevoked(agent, oldOwner) precedes exactly one AgentAuthorized(agent, newOwner).
    function _assertRevokedThenAuthorized(address oldOwner, address newOwner) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        int256 revokedAt = -1;
        int256 authorizedAt = -1;
        uint256 revokedCount;
        uint256 authorizedCount;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(gateway)) continue;
            if (logs[i].topics[0] == IGateway.AgentRevoked.selector) {
                revokedAt = int256(i);
                revokedCount++;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), agentU, "revoked agent");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), oldOwner, "revoked owner");
            } else if (logs[i].topics[0] == IGateway.AgentAuthorized.selector) {
                authorizedAt = int256(i);
                authorizedCount++;
                assertEq(address(uint160(uint256(logs[i].topics[1]))), agentU, "authorized agent");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), newOwner, "new owner topic");
            }
        }
        assertEq(revokedCount, 1, "AgentRevoked count");
        assertEq(authorizedCount, 1, "AgentAuthorized count");
        assertLt(revokedAt, authorizedAt, "AgentRevoked must precede AgentAuthorized");
    }

    function test_oldOwnerSetPolicy_afterExpiry_reverts_evenBeforeReplacement() public {
        uint64 validUntil = _registerShort(user);
        vm.warp(validUntil + 1);

        IGateway.AgentPolicy memory p = _policy(user);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.AgentPolicyExpired.selector);
        gateway.setPolicy(agentU, p);
        assertEq(gateway.agentOwner(agentU), user, "registration is not touched until a reveal");
    }

    function test_extensionBeforeExpiry_blocksTakeover() public {
        uint64 validUntil = _registerShort(user);
        vm.warp(validUntil - 1);

        IGateway.AgentPolicy memory extended = _policy(user);
        vm.prank(user);
        gateway.setPolicy(agentU, extended);
        vm.warp(validUntil + 1);

        AgentRegistration.revealExpectRevert(
            gateway,
            otherReceiver,
            agentU,
            _policy(otherReceiver),
            RobotMoneyGateway.AgentAlreadyOwned.selector
        );
        assertEq(gateway.agentOwner(agentU), user, "extended registration was taken");
    }

    function test_failedReplacement_rollsBackOldRegistration() public {
        uint64 validUntil = _registerShort(user);
        vm.warp(validUntil + 1);

        // The replacement policy is invalid, so the whole reveal reverts. The old
        // registration is untouched (a reverted frame keeps no state and no event).
        IGateway.AgentPolicy memory bad = _policy(otherReceiver);
        bad.maxPerPayment = 0;
        AgentRegistration.revealExpectRevert(
            gateway, otherReceiver, agentU, bad, RobotMoneyGateway.InvalidAmount.selector
        );
        assertEq(gateway.agentOwner(agentU), user, "old owner cleared by a failed reveal");
        assertEq(gateway.effectiveDepositWindowGross(agentU), 300 * ONE_USDC, "window cleared");
    }
}

/// @title GatewayConsentBoundaryTest
/// @notice Owner and agent commitments both live COMMIT_EXPIRY_BLOCKS blocks. A
///         reveal needs a live owner commit and a live consent for the exact call.
contract GatewayConsentBoundaryTest is GatewayAgentPolicyFixture {
    address internal agentU = makeAddr("agentU");
    bytes32 internal constant SALT = keccak256("boundary-salt");

    function _ownerCommit(address owner, address agent, bytes32 salt) internal {
        vm.prank(owner);
        gateway.commitAuthorization(keccak256(abi.encode(agent, owner, salt)));
    }

    function _consent(address owner, address agent, bytes32 salt, IGateway.AgentPolicy memory p)
        internal
    {
        vm.prank(agent);
        gateway.commitAuthorization(AgentRegistration.consentHash(owner, agent, salt, p));
    }

    function _reveal(address owner, address agent, bytes32 salt, IGateway.AgentPolicy memory p)
        internal
    {
        vm.prank(owner);
        gateway.revealAuthorization(agent, salt, p);
    }

    function _assertNothingWritten(address agent) internal view {
        assertEq(gateway.agentOwner(agent), address(0), "owner written");
        assertFalse(gateway.hasRole(AGENT_ROLE, agent), "role written");
    }

    function test_ownerAndConsent_succeedAtTheirLimit() public {
        IGateway.AgentPolicy memory p = _policy(user);
        uint256 start = block.number;
        _consent(user, agentU, SALT, p);
        _ownerCommit(user, agentU, SALT);
        vm.roll(start + COMMIT_EXPIRY);
        _reveal(user, agentU, SALT, p);
        assertEq(gateway.agentOwner(agentU), user, "both limits are inclusive");
    }

    function test_ownerCommit_failsOneBlockAfterItsLimit() public {
        IGateway.AgentPolicy memory p = _policy(user);
        uint256 start = block.number;
        _ownerCommit(user, agentU, SALT);
        vm.roll(start + 10);
        _consent(user, agentU, SALT, p);
        vm.roll(start + COMMIT_EXPIRY + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.CommitmentExpired.selector);
        gateway.revealAuthorization(agentU, SALT, p);
        _assertNothingWritten(agentU);
    }

    function test_consent_failsOneBlockAfterItsLimit_evenWithFreshOwnerCommit() public {
        IGateway.AgentPolicy memory p = _policy(user);
        uint256 start = block.number;
        _consent(user, agentU, SALT, p);
        vm.roll(start + 200);
        _ownerCommit(user, agentU, SALT); // the owner's commit is young
        vm.roll(start + COMMIT_EXPIRY);
        // Consent is exactly at its limit: this reveal would pass. Move one block on.
        vm.roll(start + COMMIT_EXPIRY + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.CommitmentExpired.selector);
        gateway.revealAuthorization(agentU, SALT, p);
        _assertNothingWritten(agentU);
        // The owner's commitment is still stored: the failed reveal rolled back its deletion.
        (address committer,) = gateway.commitments(
            keccak256(abi.encode(keccak256(abi.encode(agentU, user, SALT)), user))
        );
        assertEq(committer, user, "failed reveal consumed the owner commitment");
    }

    function test_reveal_inTheCommitBlock_fails() public {
        IGateway.AgentPolicy memory p = _policy(user);
        _consent(user, agentU, SALT, p);
        _ownerCommit(user, agentU, SALT);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.CommitmentTooRecent.selector);
        gateway.revealAuthorization(agentU, SALT, p);
        _assertNothingWritten(agentU);
    }

    function test_missingConsent_fails() public {
        IGateway.AgentPolicy memory p = _policy(user);
        _ownerCommit(user, agentU, SALT);
        vm.roll(block.number + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.OwnerConsentMissing.selector);
        gateway.revealAuthorization(agentU, SALT, p);
        _assertNothingWritten(agentU);
    }

    function test_consumedConsent_cannotBeReused() public {
        IGateway.AgentPolicy memory p = _policy(user);
        AgentRegistration.registerAs(gateway, user, agentU, p);
        vm.prank(user);
        gateway.revokeAgent(agentU);

        // A second registration with the same call needs a new consent.
        _ownerCommit(user, agentU, SALT);
        vm.roll(block.number + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.OwnerConsentMissing.selector);
        gateway.revealAuthorization(agentU, SALT, p);
        _assertNothingWritten(agentU);
    }

    function test_changedPolicy_changedSalt_changedOwner_changedAgent_fail() public {
        IGateway.AgentPolicy memory p = _policy(user);
        IGateway.AgentPolicy memory other = _policy(user);
        other.maxPerPayment = p.maxPerPayment - 1;

        // Consent given for `other`, reveal sends `p`.
        _consent(user, agentU, SALT, other);
        _ownerCommit(user, agentU, SALT);
        vm.roll(block.number + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.OwnerConsentMissing.selector);
        gateway.revealAuthorization(agentU, SALT, p);

        // Consent given for another salt.
        bytes32 salt2 = keccak256("salt2");
        _consent(user, agentU, salt2, p);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.OwnerConsentMissing.selector);
        gateway.revealAuthorization(agentU, SALT, p);

        // Consent given to another owner: `adminOwner` consented, `user` reveals.
        address agent2 = makeAddr("agent2");
        IGateway.AgentPolicy memory pu = _policy(user);
        _consent(adminOwner, agent2, SALT, pu);
        _ownerCommit(user, agent2, SALT);
        vm.roll(block.number + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.OwnerConsentMissing.selector);
        gateway.revealAuthorization(agent2, SALT, pu);

        // Consent committed by another account than the agent.
        address agent3 = makeAddr("agent3");
        vm.prank(stranger);
        gateway.commitAuthorization(AgentRegistration.consentHash(user, agent3, SALT, pu));
        _ownerCommit(user, agent3, SALT);
        vm.roll(block.number + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.OwnerConsentMissing.selector);
        gateway.revealAuthorization(agent3, SALT, pu);

        _assertNothingWritten(agentU);
        _assertNothingWritten(agent2);
        _assertNothingWritten(agent3);
    }

    function test_selfRegistration_needsNoSeparateConsent() public {
        IGateway.AgentPolicy memory p = _policy(agentU);
        _ownerCommit(agentU, agentU, SALT);
        vm.roll(block.number + 1);
        vm.prank(agentU);
        gateway.revealAuthorization(agentU, SALT, p);
        assertEq(gateway.agentOwner(agentU), agentU, "self-registration failed");
    }

    function test_failedReveal_keepsCommitments_andWritesNothing() public {
        IGateway.AgentPolicy memory p = _policy(user);
        p.maxPerPayment = 0; // invalid after the commitments exist
        _consent(user, agentU, SALT, p);
        _ownerCommit(user, agentU, SALT);
        vm.roll(block.number + 1);
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.revealAuthorization(agentU, SALT, p);
        (address committer,) = gateway.commitments(
            keccak256(abi.encode(AgentRegistration.consentHash(user, agentU, SALT, p), agentU))
        );
        assertEq(committer, agentU, "consent was consumed by a failed reveal");
    }
}

/// @title GatewayAgentUpgradeTest
/// @notice A populated gateway proxy upgrades to a fresh implementation through its timelock.
///         The stored registration (owner, role, policy tuple, deposit budget) survives, and
///         the owner-consented lifecycle still holds afterwards (issue 1890, ACL-9).
contract GatewayAgentUpgradeTest is GatewayAgentPolicyFixture {
    address internal constant UPGRADE_TIMELOCK = address(0x7157);
    address internal agentU = makeAddr("agentU");

    function setUp() public override {
        CoreProxies.useUpgradeConfig(UPGRADE_TIMELOCK, GovernedUUPS.UpgradeMode.Upgradeable);
        super.setUp();
    }

    function test_populatedProxy_upgrade_keepsRegistration_andLifecycleStillHolds() public {
        _reveal(user, agentU, _policy(user));
        _deposit(agentU, 100 * ONE_USDC, bytes32(uint256(1)));
        bytes32 policyBefore = _storedPolicyHash(agentU);
        uint256 budgetBefore = gateway.effectiveDepositWindowGross(agentU);
        assertEq(budgetBefore, 100 * ONE_USDC, "pre budget");

        address newImpl = address(new RobotMoneyGateway());
        vm.prank(UPGRADE_TIMELOCK);
        GovernedUUPS(address(gateway)).upgradeToAndCall(newImpl, "");

        // Stored data is intact.
        assertEq(gateway.agentOwner(agentU), user, "owner kept");
        assertTrue(gateway.hasRole(AGENT_ROLE, agentU), "role kept");
        assertEq(_storedPolicyHash(agentU), policyBefore, "policy tuple kept");
        assertEq(gateway.effectiveDepositWindowGross(agentU), budgetBefore, "budget kept");

        // Lifecycle enforcement works on the upgraded proxy.
        vm.prank(admin);
        vm.expectRevert(AccessRoles.AgentRoleNotManageable.selector);
        gateway.grantRole(AGENT_ROLE, stranger);
        vm.prank(admin);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agentU);
        AgentRegistration.revealExpectRevert(
            gateway,
            adminOwner,
            agentU,
            _policy(adminOwner),
            RobotMoneyGateway.AgentAlreadyOwned.selector
        );
        vm.prank(user);
        vm.expectRevert(RobotMoneyGateway.ShareReceiverNotAuthorized.selector);
        gateway.setPolicy(agentU, _policy(otherReceiver));

        // Self-revoke clears everything, and a new owner registers with a fresh budget.
        vm.prank(agentU);
        gateway.revokeAgent(agentU);
        assertEq(gateway.agentOwner(agentU), address(0), "owner cleared");
        assertEq(gateway.effectiveDepositWindowGross(agentU), 0, "budget reset");
        _reveal(adminOwner, agentU, _policy(adminOwner));
        assertEq(gateway.agentOwner(agentU), adminOwner, "re-registered");
    }
}

/// @title GatewayAgentPolicyCodeSizeGuard
/// @notice The gateway's deployed runtime stays under the EIP-170 limit with
///         the shared validator and the owner-consented lifecycle in it. Kept in its
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
