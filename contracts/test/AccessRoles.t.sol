// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for contracts/gateway/AccessRoles.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {AccessRoles} from "../gateway/AccessRoles.sol";

/// @dev Concrete harness exposing AccessRoles internals for test purposes.
contract AccessRolesHarness is AccessRoles {
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    function exposed_assertRoleSeparation(address account) external view {
        _assertRoleSeparation(account);
    }

    /// @dev Test-only escape hatch that forges a role assignment without
    ///      going through the `_grantRole` override. Used to verify that
    ///      `_assertRoleSeparation` still catches an overlap that somehow
    ///      slipped past the grant-time check (defense-in-depth).
    ///
    ///      OZ AccessControl stores `mapping(bytes32 => RoleData) _roles`
    ///      at slot 0; `RoleData.hasRole[address]` lives at
    ///      `keccak256(account || keccak256(role || 0))`.
    function unsafe_forgeRole(bytes32 role, address account) external {
        bytes32 slot = keccak256(
            abi.encode(account, keccak256(abi.encode(role, uint256(0))))
        );
        // Write `true` (1) into the bool slot.
        assembly {
            sstore(slot, 1)
        }
    }
}

contract AccessRolesTest is Test {
    AccessRolesHarness internal roles;

    bytes32 internal ADMIN;
    bytes32 internal PAUSER;
    bytes32 internal AGENT;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        roles = new AccessRolesHarness(admin);
        ADMIN = roles.ADMIN_ROLE();
        PAUSER = roles.PAUSER_ROLE();
        AGENT = roles.AGENT_ROLE();
    }

    // --- Role-constant identity ---------------------------------------------

    function test_adminRole_isKeccakOfName() public view {
        assertEq(roles.ADMIN_ROLE(), keccak256("ADMIN_ROLE"));
    }

    function test_pauserRole_isKeccakOfName() public view {
        assertEq(roles.PAUSER_ROLE(), keccak256("PAUSER_ROLE"));
    }

    function test_agentRole_isKeccakOfName() public view {
        assertEq(roles.AGENT_ROLE(), keccak256("AGENT_ROLE"));
    }

    // --- Role-distinctness invariant ----------------------------------------

    function test_allRoleIds_areDistinct() public view {
        bytes32 a = roles.ADMIN_ROLE();
        bytes32 p = roles.PAUSER_ROLE();
        bytes32 g = roles.AGENT_ROLE();
        bytes32 d = 0x00; // DEFAULT_ADMIN_ROLE

        assertTrue(a != p, "ADMIN == PAUSER");
        assertTrue(a != g, "ADMIN == AGENT");
        assertTrue(p != g, "PAUSER == AGENT");
        assertTrue(a != d, "ADMIN == DEFAULT_ADMIN");
        assertTrue(p != d, "PAUSER == DEFAULT_ADMIN");
        assertTrue(g != d, "AGENT == DEFAULT_ADMIN");
    }

    // --- Role-separation: AGENT must not also be ADMIN/PAUSER ---------------

    function test_grantAgent_revertsIfAlreadyAdmin() public {
        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.grantRole(AGENT, admin);
    }

    function test_grantAgent_revertsIfAlreadyPauser() public {
        vm.prank(admin);
        roles.grantRole(PAUSER, pauser);

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.grantRole(AGENT, pauser);
    }

    function test_grantAdmin_revertsIfAlreadyAgent() public {
        vm.prank(admin);
        roles.grantRole(AGENT, agent);

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.grantRole(ADMIN, agent);
    }

    function test_grantPauser_revertsIfAlreadyAgent() public {
        vm.prank(admin);
        roles.grantRole(AGENT, agent);

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.grantRole(PAUSER, agent);
    }

    function test_grantAgent_succeedsForFreshAccount() public {
        vm.prank(admin);
        roles.grantRole(AGENT, agent);
        assertTrue(roles.hasRole(AGENT, agent));
    }

    // --- Pairwise disjointness: ADMIN, PAUSER, AGENT ------------------------

    /// @dev Pauser key compromise must not also confer admin powers
    ///      (and vice versa). The audit (H1) flagged that the previous
    ///      implementation permitted this overlap.
    function test_grantPauser_revertsIfAlreadyAdmin() public {
        // `admin` already holds ADMIN_ROLE from the test fixture.
        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.grantRole(PAUSER, admin);
    }

    function test_grantAdmin_revertsIfAlreadyPauser() public {
        // Grant PAUSER first, then attempt to grant ADMIN to the same account.
        vm.prank(admin);
        roles.grantRole(PAUSER, pauser);

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.grantRole(ADMIN, pauser);
    }

    function test_adminAndPauser_cannotCoexistOnSameAccount() public {
        // Sanity: a freshly-granted PAUSER cannot subsequently be made ADMIN.
        vm.prank(admin);
        roles.grantRole(PAUSER, stranger);
        assertTrue(roles.hasRole(PAUSER, stranger));

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.grantRole(ADMIN, stranger);
    }

    // --- assertRoleSeparation helper ----------------------------------------

    function test_assertRoleSeparation_passesForAdminOnly() public view {
        roles.exposed_assertRoleSeparation(admin);
    }

    function test_assertRoleSeparation_passesForFreshAccount() public view {
        roles.exposed_assertRoleSeparation(stranger);
    }

    function test_assertRoleSeparation_passesForAgentOnly() public {
        vm.prank(admin);
        roles.grantRole(AGENT, agent);
        roles.exposed_assertRoleSeparation(agent);
    }

    function test_assertRoleSeparation_revertsOnAdminPauserOverlap() public {
        // Defense in depth: even if a future regression let two roles
        // co-exist on one account, the helper must catch it.
        roles.unsafe_forgeRole(PAUSER, admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.exposed_assertRoleSeparation(admin);
    }

    function test_assertRoleSeparation_revertsOnAgentAdminOverlap() public {
        roles.unsafe_forgeRole(AGENT, admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        roles.exposed_assertRoleSeparation(admin);
    }

    function test_grantRole_unauthorizedCaller_reverts() public {
        // Sanity: non-admin cannot grant.
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                bytes32(0)
            )
        );
        roles.grantRole(AGENT, agent);
    }
}
