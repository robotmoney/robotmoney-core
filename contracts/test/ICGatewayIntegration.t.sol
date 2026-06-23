// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.8, §2.4, §5.2
// Implements: issue #1049 — gateway committee routing integration tests
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {IInvestmentCommitteePolicy} from "../gateway/interfaces/IInvestmentCommitteePolicy.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "../gateway/MockVault.sol";

/// @title ICGatewayIntegration
/// @notice Integration tests verifying the full on-chain path:
///         gateway → IC contract → event emitted (issue #1049 acceptance criteria).
///
///         Three tests cover all three ACs:
///           1. gateway-routed `committeeRegister` reaches IC and emits `AgentRegistered`
///           2. gateway-routed `committeeVoteSubmit` reaches IC and emits `VoteSubmitted`
///           3. direct (non-gateway) call to IC `registerAgent` reverts
contract ICGatewayIntegration is Test {
    // ─── Actors ──────────────────────────────────────────────────────────────

    address admin = address(0xA0);
    address pauser = address(0xA1);
    address shareReceiver = address(0xA2);
    // The committee agent holds AGENT_ROLE on the gateway (to call committeeVoteSubmit)
    // but is NOT an admin of the IC contract.
    address committeeAgent = address(0xB1);
    // A vault address used in vote params.
    address vaultAddr = address(0xC1);

    // ─── Contracts ───────────────────────────────────────────────────────────

    TestERC20 usdc;
    MockVault vault;
    RobotMoneyGateway gateway;
    InvestmentCommitteePolicy ic;

    // ─── Constants ───────────────────────────────────────────────────────────

    bytes32 constant VOTE_JSON_HASH = keccak256("vote-json-integration");
    bytes32 constant PROMPT_HASH = keccak256("prompt-v1");
    bytes32 constant INPUTS_DIGEST = keccak256("inputs-2026-06-23");

    // ─── Setup ───────────────────────────────────────────────────────────────

    function setUp() public {
        // 1. Deploy token + vault stubs.
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));

        // 2. Deploy gateway (admin holds ADMIN_ROLE + DEFAULT_ADMIN_ROLE;
        //    pauser holds PAUSER_ROLE; no router).
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );

        // 3. Deploy IC policy pointing at the gateway as the sole permitted caller
        //    for `submitVote`. The IC admin is set to `admin`.
        ic = new InvestmentCommitteePolicy(admin, address(gateway));

        // 4. Grant IC's ADMIN_ROLE to the gateway so the gateway can forward
        //    `registerAgent` calls to the IC contract on behalf of the admin.
        //    In production, the deployer grants this after deploying both contracts.
        //    Capture the role constant before pranking to avoid consuming the prank
        //    on the staticcall to ic.ADMIN_ROLE().
        bytes32 icAdminRole = ic.ADMIN_ROLE();
        vm.prank(admin);
        ic.grantRole(icAdminRole, address(gateway));

        // 5. Wire IC policy into gateway (admin required).
        vm.prank(admin);
        gateway.setICPolicy(address(ic));

        // 6. Authorize the committee agent on the gateway (requires ADMIN_ROLE).
        //    Policy: minimal deposit/withdraw caps so AGENT_ROLE is granted;
        //    no withdrawal enabled (maxWithdrawPerPayment == 0).
        address[] memory noList = new address[](0);
        IGateway.AgentPolicy memory policy = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 1e6,
            maxPerWindow: 10e6,
            shareReceiver: shareReceiver,
            allowedDestinations: noList,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noList
        });
        vm.prank(admin);
        gateway.authorizeAgent(committeeAgent, policy);

        // 7. Register the committee agent on the IC contract via the gateway so
        //    it holds COMMITTEE_AGENT_ROLE for vote submission tests.
        vm.prank(admin);
        gateway.committeeRegister(committeeAgent, "athena-v1");
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _defaultVoteParams()
        internal
        view
        returns (IInvestmentCommitteePolicy.VoteParams memory)
    {
        return IInvestmentCommitteePolicy.VoteParams({
            agent: committeeAgent,
            vault: vaultAddr,
            stance: IInvestmentCommitteePolicy.Stance.Overweight,
            targetWeightBps: 6000,
            confidence: 80,
            rationaleUri: "https://gist.github.com/test/integration",
            voteJsonHash: VOTE_JSON_HASH,
            promptHash: PROMPT_HASH,
            inputsDigest: INPUTS_DIGEST,
            schemaVersion: "1.0",
            timestamp: uint64(block.timestamp)
        });
    }

    // ─── AC-1: gateway-routed register reaches IC and emits AgentRegistered ──

    /// @dev AC-1 (issue #1049): `gateway.committeeRegister` → IC `registerAgent`
    ///      → `AgentRegistered` event emitted with the correct args.
    ///      Proves the full on-chain path gateway → IC contract → event.
    function test_gatewayRoutedRegister_emitsAgentRegistered() public {
        address newAgent = address(0xD1);

        vm.expectEmit(true, false, false, true, address(ic));
        emit InvestmentCommitteePolicy.AgentRegistered(newAgent, "robot-money");

        vm.prank(admin);
        gateway.committeeRegister(newAgent, "robot-money");

        // Post-condition: agent now holds COMMITTEE_AGENT_ROLE on the IC contract.
        assertTrue(
            ic.hasRole(ic.COMMITTEE_AGENT_ROLE(), newAgent),
            "committee agent must hold COMMITTEE_AGENT_ROLE after gateway-routed register"
        );
        assertEq(ic.agentId(newAgent), "robot-money");
    }

    // ─── AC-2: gateway-routed voteSubmit reaches IC and emits VoteSubmitted ──

    /// @dev AC-2 (issue #1049): `gateway.committeeVoteSubmit` → IC `submitVote`
    ///      → `VoteSubmitted` event emitted with the correct args.
    ///      Proves the full on-chain path gateway → IC contract → event.
    function test_gatewayRoutedVoteSubmit_emitsVoteSubmitted() public {
        IInvestmentCommitteePolicy.VoteParams memory p = _defaultVoteParams();

        vm.expectEmit(true, true, true, true, address(ic));
        emit InvestmentCommitteePolicy.VoteSubmitted(
            0, // first vote, id == 0
            committeeAgent,
            vaultAddr,
            InvestmentCommitteePolicy.Stance.Overweight,
            6000,
            80,
            "https://gist.github.com/test/integration",
            VOTE_JSON_HASH,
            p.timestamp
        );

        vm.prank(committeeAgent);
        uint256 voteId = gateway.committeeVoteSubmit(p);

        assertEq(voteId, 0, "first vote id must be 0");
        assertEq(ic.voteCount(), 1, "vote count must be 1 after submission");

        InvestmentCommitteePolicy.Vote memory v = ic.getVote(0);
        assertEq(v.agent, committeeAgent);
        assertEq(v.vault, vaultAddr);
        assertEq(v.voteJsonHash, VOTE_JSON_HASH);
    }

    // ─── AC-3: direct (non-gateway) call to IC register() reverts ────────────

    /// @dev AC-3 (issue #1049): direct call to IC `registerAgent` by an address
    ///      that does not hold IC's ADMIN_ROLE reverts. The committee agent holds
    ///      AGENT_ROLE on the gateway but not ADMIN_ROLE on the IC contract, so a
    ///      direct bypass attempt is rejected — the gateway is the only path.
    function test_directCallToICRegister_reverts() public {
        address intruder = address(0xDEAD);

        // An address that is not an IC admin calling registerAgent directly reverts.
        // AccessControl reverts with AccessControlUnauthorizedAccount when the caller
        // lacks the required role.
        vm.prank(intruder);
        vm.expectRevert();
        ic.registerAgent(intruder, "unauthorized");
    }

    /// @dev Complementary revert test: even an AGENT_ROLE holder on the gateway
    ///      cannot bypass the gateway to call IC registerAgent directly — role
    ///      separation ensures the agent has no IC admin privileges.
    function test_directCallToICRegister_byAgent_reverts() public {
        // committeeAgent holds AGENT_ROLE on gateway, but NOT ADMIN_ROLE on IC.
        // Calling IC.registerAgent directly must revert.
        vm.prank(committeeAgent);
        vm.expectRevert();
        ic.registerAgent(committeeAgent, "self-register-attempt");
    }
}
