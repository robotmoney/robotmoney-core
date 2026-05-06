// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

import {MockUSDC} from "../gateway/MockUSDC.sol";
import {MockVault} from "../gateway/MockVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {AccessRoles} from "../gateway/AccessRoles.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

/// @dev Exercises the deploy script in-process and asserts the post-deploy
///      invariants the operator and downstream tooling rely on (issue #10).
contract DeployTest is Test {
    Deploy internal script;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal shareReceiver = makeAddr("shareReceiver");

    function setUp() public {
        script = new Deploy();
    }

    // --- Happy path -----------------------------------------------------

    function test_deploy_wiresUsdcVaultAndAdminPauserRoles() public {
        Deploy.Deployed memory d = script.runInProcessWith(admin, pauser, agent, shareReceiver);

        // Gateway pins the right token + vault.
        assertEq(d.gateway.usdc(), address(d.usdc), "usdc mismatch");
        assertEq(d.gateway.vault(), address(d.vault), "vault mismatch");
        assertEq(address(d.vault.assetToken()), address(d.usdc), "vault.asset mismatch");

        // Admin + Pauser hold their roles.
        assertTrue(d.gateway.hasRole(d.gateway.ADMIN_ROLE(), admin), "admin role");
        assertTrue(d.gateway.hasRole(d.gateway.DEFAULT_ADMIN_ROLE(), admin), "default admin");
        assertTrue(d.gateway.hasRole(d.gateway.PAUSER_ROLE(), pauser), "pauser role");

        // Agent holds AGENT and nothing else.
        assertTrue(d.gateway.hasRole(d.gateway.AGENT_ROLE(), agent), "agent role");
        assertFalse(d.gateway.hasRole(d.gateway.ADMIN_ROLE(), agent), "agent !admin");
        assertFalse(d.gateway.hasRole(d.gateway.PAUSER_ROLE(), agent), "agent !pauser");

        // Runtime hash pinned correctly.
        assertEq(d.gatewayRuntimeHash, keccak256(address(d.gateway).code));
    }

    function test_deploy_authorizesAgentWithSanePolicy() public {
        Deploy.Deployed memory d = script.runInProcessWith(admin, pauser, agent, shareReceiver);
        (
            bool active,
            uint64 validUntil,
            uint256 maxPerPayment,
            uint256 maxPerWindow,
            address recv
        ) = d.gateway.agents(agent);
        assertTrue(active);
        assertGt(validUntil, block.timestamp);
        assertEq(maxPerPayment, script.DEFAULT_MAX_PER_PAYMENT());
        assertEq(maxPerWindow,  script.DEFAULT_MAX_PER_WINDOW());
        assertEq(recv, shareReceiver);
    }

    function test_deploy_mintsTestUsdcToAgent() public {
        Deploy.Deployed memory d = script.runInProcessWith(admin, pauser, agent, shareReceiver);
        assertEq(
            d.usdc.balanceOf(agent),
            script.DEFAULT_AGENT_USDC_MINT(),
            "agent mint amount"
        );
    }

    // --- Role-separation invariant (issue #10's headline test) ----------

    function test_deploy_grantingAgentRoleToAdminReverts() public {
        Deploy.Deployed memory d = script.runInProcessWith(admin, pauser, agent, shareReceiver);

        // Build a policy and try to authorize ADMIN as an AGENT — this
        // must revert because admin already holds ADMIN_ROLE.
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 1 days),
            maxPerPayment: 1e6,
            maxPerWindow: 1e6,
            shareReceiver: shareReceiver
        });

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        d.gateway.authorizeAgent(admin, p);
    }

    function test_deploy_grantingAgentRoleToPauserReverts() public {
        Deploy.Deployed memory d = script.runInProcessWith(admin, pauser, agent, shareReceiver);

        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 1 days),
            maxPerPayment: 1e6,
            maxPerWindow: 1e6,
            shareReceiver: shareReceiver
        });

        vm.prank(admin);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        d.gateway.authorizeAgent(pauser, p);
    }

    // --- Pre-deploy distinctness check ----------------------------------

    function test_deploy_revertsWhenAdminEqualsPauser() public {
        vm.expectRevert(bytes("ADMIN==PAUSER"));
        script.runInProcessWith(admin, admin, agent, shareReceiver);
    }

    function test_deploy_revertsWhenAdminEqualsAgent() public {
        vm.expectRevert(bytes("ADMIN==AGENT"));
        script.runInProcessWith(admin, pauser, admin, shareReceiver);
    }

    function test_deploy_revertsWhenPauserEqualsAgent() public {
        vm.expectRevert(bytes("PAUSER==AGENT"));
        script.runInProcessWith(admin, pauser, pauser, shareReceiver);
    }

    // --- Env-driven path also works (single test to keep coverage) ------

    function test_deploy_envDriven_runInProcessSucceeds() public {
        vm.setEnv("ADMIN_ADDRESS", vm.toString(admin));
        vm.setEnv("PAUSER_ADDRESS", vm.toString(pauser));
        vm.setEnv("AGENT_ADDRESS", vm.toString(agent));
        vm.setEnv("SHARE_RECEIVER_ADDRESS", vm.toString(shareReceiver));
        Deploy.Deployed memory d = script.runInProcess();
        assertEq(d.admin, admin);
        assertEq(d.pauser, pauser);
        assertEq(d.agent, agent);
    }
}
