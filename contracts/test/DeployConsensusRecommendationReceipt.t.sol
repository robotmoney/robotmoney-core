// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Implements: issue #1247 acceptance criteria 2 and 10, task 4.10
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployInvestmentCommitteePolicy} from "../script/DeployInvestmentCommitteePolicy.s.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {
    IConsensusRecommendationReceipt
} from "../gateway/interfaces/IConsensusRecommendationReceipt.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "../gateway/MockVault.sol";

/// @title DeployConsensusRecommendationReceiptTest
/// @notice AC10: the receipt contract deploys **alongside**
///         InvestmentCommitteePolicy in one ceremony, and AC2: `ADMIN_ROLE` on
///         the receipt contract lands on the `TimelockController` and nowhere
///         else. This is a single greenfield rollout — no migration and no
///         registered agent to preserve.
contract DeployConsensusRecommendationReceiptTest is Test {
    address admin = address(0xA0);
    address pauser = address(0xA1);
    address submitter = address(0xB1);
    address proposer = address(0xC0);
    address executor = address(0xC1);

    TestERC20 usdc;
    MockVault vault;
    RobotMoneyGateway gateway;
    TimelockController timelock;
    DeployInvestmentCommitteePolicy script;
    DeployInvestmentCommitteePolicy.Deployed d;

    function setUp() public {
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = executor;
        timelock = new TimelockController(1 hours, proposers, executors, address(0));

        script = new DeployInvestmentCommitteePolicy();

        // Mirror the production ceremony: the deployer holds gateway
        // ADMIN_ROLE and is the IC admin at construction time (handover to the
        // timelock is DeployTimelock's job). In process, the deployer is the
        // script contract itself.
        // Capture the constant before pranking: a staticcall would otherwise
        // consume the prank (same gotcha as ICGatewayIntegration).
        bytes32 gatewayAdminRole = gateway.ADMIN_ROLE();
        vm.prank(admin);
        gateway.grantRole(gatewayAdminRole, address(script));

        // One ceremony deploys both. The receipt contract's ADMIN_ROLE goes to
        // the timelock and to nothing else.
        d = script.runInProcessWith(address(script), address(timelock), address(gateway));
        script.wireGatewayInProcess(d);
    }

    /// @dev AC10: both contracts exist after a single ceremony, and both are
    ///      wired into the gateway.
    function testOneCeremonyDeploysAndWiresBoth() public view {
        assertTrue(address(d.policy) != address(0), "IC policy deployed");
        assertTrue(address(d.receipts) != address(0), "receipt contract deployed");
        assertEq(address(gateway.icPolicy()), address(d.policy), "IC wired into gateway");
        assertEq(
            address(gateway.consensusReceipt()),
            address(d.receipts),
            "receipt contract wired into gateway"
        );
        assertEq(d.receipts.gateway(), address(gateway), "receipt gateway pinned");
        assertEq(
            d.receipts.icPolicy(),
            address(d.policy),
            "receipt reads membership off the same IC policy"
        );
    }

    /// @dev AC2 / INV-3: `ADMIN_ROLE` on the receipt contract is held by the
    ///      TimelockController — and by nobody else, including the gateway,
    ///      the deployer, and the protocol admin.
    function testReceiptAdminRoleIsTimelockOnly() public view {
        bytes32 role = d.receipts.ADMIN_ROLE();
        assertTrue(d.receipts.hasRole(role, address(timelock)), "timelock holds ADMIN_ROLE");
        assertFalse(d.receipts.hasRole(role, address(gateway)), "gateway must not hold it");
        assertFalse(d.receipts.hasRole(role, admin), "protocol admin must not hold it");
        assertFalse(d.receipts.hasRole(role, address(script)), "deployer must not hold it");
        assertFalse(d.receipts.hasRole(role, address(d.policy)), "IC policy must not hold it");
        assertTrue(
            d.receipts.hasRole(d.receipts.DEFAULT_ADMIN_ROLE(), address(timelock)),
            "timelock holds DEFAULT_ADMIN_ROLE"
        );
        assertFalse(
            d.receipts.hasRole(d.receipts.DEFAULT_ADMIN_ROLE(), admin),
            "protocol admin must not hold DEFAULT_ADMIN_ROLE"
        );
    }

    /// @dev The as-deployed wiring actually anchors: an allowlisted submitter
    ///      records through the gateway and only the timelock can release.
    function testDeployedWiringAnchorsAndReleases() public {
        address[] memory noList = new address[](0);
        IGateway.AgentPolicy memory policy = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 30 days),
            maxPerPayment: 1e6,
            maxPerWindow: 10e6,
            shareReceiver: address(0xA2),
            allowedDestinations: noList,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noList
        });
        vm.prank(admin);
        gateway.authorizeAgent(submitter, policy);
        vm.prank(admin);
        gateway.committeeRegister(submitter, "swarm-submitter-v1");

        bytes32 id = keccak256("ceremony-receipt");
        bytes32 digest = keccak256("ceremony-digest");
        vm.prank(submitter);
        gateway.consensusRecordReceipt(id, digest, "https://robotmoney.net/api/swarm/receipts/s1");

        assertEq(d.receipts.getReceiptById(id).payloadDigest, digest);

        vm.prank(admin);
        vm.expectRevert();
        d.receipts.releaseReceipt(id);

        vm.prank(address(timelock));
        d.receipts.releaseReceipt(id);
        assertTrue(d.receipts.isReleased(id));
    }
}
