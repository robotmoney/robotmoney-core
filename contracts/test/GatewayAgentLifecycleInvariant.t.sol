// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md ACL-9, GW-7
//            docs/architecture.md section 5.2 (agent ownership and policy rules)
//
// Stateful invariant test for the owner-consented agent lifecycle (issue 1890). A handler
// drives fuzzed sequences of registration (with and without consent, for the right and the
// wrong receiver), setPolicy, revoke by owner / agent / stranger / admin, time moves, public
// role calls on AGENT_ROLE and deposits. After every sequence the invariants assert:
//
//   - the stored share receiver of a registered agent is its owner (no role exception),
//   - AGENT_ROLE is held exactly by the registered agents (no public role call changed it),
//   - a live registration's owner never changed without a revoke or an expiry,
//   - a revoked or replaced registration left a zero deposit budget behind.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {AgentRegistration} from "./helpers/AgentRegistration.sol";

/// @dev Bounded handler over the gateway's agent lifecycle surface.
contract AgentLifecycleHandler is Test {
    RobotMoneyGateway public immutable gw;
    TestERC20 public immutable usdc;
    address public immutable admin;
    address public immutable pauser;

    address[] public owners;
    address[] public agents;

    // Ghost counters, read by the invariants.
    uint256 public publicRoleSuccess;
    uint256 public liveOwnerChanged;
    uint256 public staleBudgetAfterEnd;
    uint256 public wrongReceiverAccepted;
    uint256 public registrations;
    uint256 public replacements;
    uint256 public revocations;
    uint256 public selfRevocations;
    uint256 public deposits;
    uint256 internal nonce;

    constructor(RobotMoneyGateway gw_, TestERC20 usdc_, address admin_, address pauser_) {
        gw = gw_;
        usdc = usdc_;
        admin = admin_;
        pauser = pauser_;
        for (uint256 i = 0; i < 4; i++) {
            owners.push(makeAddr(string.concat("owner", vm.toString(i))));
        }
        owners.push(admin_);
        for (uint256 i = 0; i < 3; i++) {
            agents.push(makeAddr(string.concat("agent", vm.toString(i))));
        }
    }

    function ownerCount() external view returns (uint256) {
        return owners.length;
    }

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    function _policy(address receiver, uint256 validFor)
        internal
        view
        returns (IGateway.AgentPolicy memory p)
    {
        address[] memory none = new address[](0);
        p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + bound(validFor, 1, 3 days)),
            maxPerPayment: 100e6,
            maxPerWindow: 1_000e6,
            shareReceiver: receiver,
            allowedDestinations: none,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: none
        });
    }

    /// @dev Registration by a fuzzed owner for a fuzzed agent. `wrongReceiver` makes the
    ///      policy name another receiver (the gateway must refuse it, for every role).
    ///      `withConsent` false skips the agent's consent for a distinct agent.
    function register(
        uint256 ownerSeed,
        uint256 agentSeed,
        uint256 validFor,
        bool wrongReceiver,
        bool withConsent
    ) external {
        address owner = owners[ownerSeed % owners.length];
        address agent = agents[agentSeed % agents.length];
        address receiver = wrongReceiver ? owners[(ownerSeed + 1) % owners.length] : owner;
        IGateway.AgentPolicy memory p = _policy(receiver, validFor);
        bytes32 salt = keccak256(abi.encode("salt", nonce++));

        address oldOwner = gw.agentOwner(agent);
        (, uint64 oldValidUntil,,,,,,) = gw.agents(agent);

        if (withConsent && agent != owner) {
            vm.prank(agent);
            gw.commitAuthorization(AgentRegistration.consentHash(owner, agent, salt, p));
        }
        vm.prank(owner);
        gw.commitAuthorization(keccak256(abi.encode(agent, owner, salt)));
        vm.roll(block.number + 1);

        vm.prank(owner);
        try gw.revealAuthorization(agent, salt, p) {
            registrations++;
            if (receiver != owner) wrongReceiverAccepted++;
            if (oldOwner != address(0)) {
                replacements++;
                // A live registration (validUntil not passed) must never be replaced.
                if (oldValidUntil >= block.timestamp) liveOwnerChanged++;
                if (gw.effectiveDepositWindowGross(agent) != 0) staleBudgetAfterEnd++;
            }
        } catch {}
    }

    function setPolicy(uint256 callerSeed, uint256 agentSeed, uint256 validFor, bool wrongReceiver)
        external
    {
        address caller = owners[callerSeed % owners.length];
        address agent = agents[agentSeed % agents.length];
        address receiver = wrongReceiver ? owners[(callerSeed + 1) % owners.length] : caller;
        address before = gw.agentOwner(agent);
        vm.prank(caller);
        try gw.setPolicy(agent, _policy(receiver, validFor)) {
            if (receiver != caller) wrongReceiverAccepted++;
            if (before != caller) liveOwnerChanged++;
        } catch {}
        if (gw.agentOwner(agent) != before) liveOwnerChanged++;
    }

    /// @dev A revoke by an owner, the agent itself, the admin or the pauser.
    function revoke(uint256 callerSeed, uint256 agentSeed) external {
        address agent = agents[agentSeed % agents.length];
        address[3] memory pool = [owners[callerSeed % owners.length], agent, pauser];
        address caller = pool[(callerSeed / 7) % 3];
        address owner = gw.agentOwner(agent);
        vm.prank(caller);
        try gw.revokeAgent(agent) {
            revocations++;
            if (caller == agent) selfRevocations++;
            // Only the owner or the agent may succeed.
            if (caller != owner && caller != agent) liveOwnerChanged++;
            if (gw.effectiveDepositWindowGross(agent) != 0) staleBudgetAfterEnd++;
        } catch {}
    }

    /// @dev Public role calls on AGENT_ROLE from any caller must always revert.
    function publicRoleCall(uint256 callerSeed, uint256 agentSeed, uint8 kind) external {
        address agent = agents[agentSeed % agents.length];
        address[3] memory pool = [admin, owners[callerSeed % owners.length], agent];
        address caller = pool[callerSeed % 3];
        bytes32 role = gw.AGENT_ROLE();
        vm.prank(caller);
        if (kind % 3 == 0) {
            try gw.grantRole(role, agent) {
                publicRoleSuccess++;
            } catch {}
        } else if (kind % 3 == 1) {
            try gw.revokeRole(role, agent) {
                publicRoleSuccess++;
            } catch {}
        } else {
            try gw.renounceRole(role, caller) {
                publicRoleSuccess++;
            } catch {}
        }
    }

    function deposit(uint256 agentSeed, uint256 amount) external {
        address agent = agents[agentSeed % agents.length];
        amount = bound(amount, 1, 100e6);
        usdc.mint(agent, amount);
        vm.startPrank(agent);
        usdc.approve(address(gw), amount);
        try gw.deposit(
            keccak256(abi.encode("o", nonce)),
            amount,
            uint64(block.timestamp + 60),
            keccak256(abi.encode("k", nonce++))
        ) {
            deposits++;
        } catch {}
        vm.stopPrank();
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }
}

contract GatewayAgentLifecycleInvariantTest is StdInvariant, Test {
    RobotMoneyGateway internal gw;
    AgentLifecycleHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        TestERC20 usdc = new TestERC20();
        MockVault vault = new MockVault(address(usdc));
        address admin = makeAddr("inv-admin");
        address pauser = makeAddr("inv-pauser");
        gw = CoreProxies.robotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        handler = new AgentLifecycleHandler(gw, usdc, admin, pauser);
        targetContract(address(handler));
    }

    /// @dev Every registered agent pays shares to its owner, and holds AGENT_ROLE; every
    ///      unregistered agent holds no role.
    function invariant_receiverIsOwner_andRoleMatchesRegistration() public view {
        bytes32 agentRole = gw.AGENT_ROLE();
        for (uint256 i = 0; i < handler.agentCount(); i++) {
            address agent = handler.agents(i);
            address owner = gw.agentOwner(agent);
            (,,,, address receiver,,,) = gw.agents(agent);
            if (owner != address(0)) {
                assertEq(receiver, owner, "share receiver is not the owner");
                assertTrue(gw.hasRole(agentRole, agent), "registered agent without the role");
            } else {
                assertEq(receiver, address(0), "policy left behind an ended registration");
                assertFalse(gw.hasRole(agentRole, agent), "role without a registration");
            }
        }
    }

    function invariant_noPublicRoleCallChangedAgentRole() public view {
        assertEq(handler.publicRoleSuccess(), 0, "a public role call touched AGENT_ROLE");
    }

    function invariant_noLiveOwnerChange_noForeignReceiver_noStaleBudget() public view {
        assertEq(handler.liveOwnerChanged(), 0, "a live registration changed owner");
        assertEq(handler.wrongReceiverAccepted(), 0, "a foreign receiver was accepted");
        assertEq(handler.staleBudgetAfterEnd(), 0, "a budget survived the end of a registration");
    }

    /// @notice Execution floor: a scripted run of the handler reaches registration, replacement
    ///         after expiry, owner revoke, agent self-revoke and a deposit. A handler that can no
    ///         longer reach them fails here instead of letting the invariants pass vacuously.
    function test_handlerReachesEveryLifecyclePath() public {
        handler.register(0, 0, 1 hours, false, true);
        assertEq(handler.registrations(), 1, "registration");
        handler.deposit(0, 10e6);
        assertEq(handler.deposits(), 1, "deposit");

        // Expiry, then a different owner replaces the registration.
        handler.warp(2 days);
        handler.register(1, 0, 1 hours, false, true);
        assertEq(handler.registrations(), 2, "replacement registration");
        assertEq(handler.replacements(), 1, "replacement");

        // Owner revoke (callerSeed 1 picks owner 1, pool index 0).
        handler.revoke(1, 0);
        assertEq(handler.revocations(), 1, "owner revoke");

        // Agent self-revoke: pool index 1 (callerSeed / 7 % 3 == 1) is the agent.
        handler.register(2, 1, 1 hours, false, true);
        handler.revoke(7, 1);
        assertEq(handler.selfRevocations(), 1, "agent self-revoke");

        // The wrong receiver and the missing consent are refused, a public role call fails.
        handler.register(0, 2, 1 hours, true, true);
        handler.register(0, 2, 1 hours, false, false);
        handler.publicRoleCall(0, 2, 0);
        assertEq(handler.registrations(), 3, "a refused registration was counted");
        assertEq(handler.publicRoleSuccess(), 0);
    }
}
