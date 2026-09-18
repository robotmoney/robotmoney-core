// SPDX-License-Identifier: MIT
// Canonical: project-fusion.md §4.3 — Governance topology, three bodies
// Canonical: docs/technical/security-model.md §4 — Access control & admin
// Implements: fusion round-2 task R7 — the RouterGovernance execute() path must
//             actually reach PortfolioRouter.setWeights on a FRESH deployment,
//             while the deployer EOA must not be able to call setWeights at all.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {RehearsalSafe} from "../script/DeployRehearsalSafe.s.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockUsdc, MockGovVault} from "./RouterGovernance.t.sol";

/// @title GovernanceExecutePathAfterHandover
/// @notice R7's two halves, proved on one topology built the way the deploy
///         scripts build it — not on a hand-wired fixture.
///
///         Before this task, `DeployRouterGovernance` deployed the governance
///         contract and stopped. Nothing ever granted it `ADMIN_ROLE` on the
///         `PortfolioRouter`, so a proposal that passed quorum and cleared its
///         execution delay still reverted inside `router.setWeights` — the
///         approving body could approve and could not act. The only thing that
///         COULD move weights was the deployer EOA, which is exactly the
///         inversion §4.3 describes as the gap.
///
///         `DeployTimelock` then revokes the deployer's router `ADMIN_ROLE`,
///         so after a complete ceremony the honest end state is: governance
///         can act, the deployer cannot, and the timelock administers both.
contract GovernanceExecutePathAfterHandoverTest is Test {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Scripts (the "deployer EOA" is the timelock script address) ─────────

    DeployRouterGovernance internal govScript;
    DeployTimelock internal timelockScript;

    /// @dev Every privileged role starts here. Inside `DeployTimelock`'s
    ///      internal calls the EVM records `msg.sender` as the script address,
    ///      so the script address IS the deployer EOA for this fixture.
    address internal deployer;

    // ─── Topology ────────────────────────────────────────────────────────────

    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal gov;
    RobotMoneyVault internal vault;
    RobotMoneyGateway internal gateway;
    InvestmentCommitteePolicy internal icPolicy;
    TimelockController internal timelock;

    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    /// @dev The REAL rehearsal Safe stand-in, not a local mock: the
    ///      post-handover path is only proved if the artifact a rehearsal
    ///      actually deploys can drive the timelock.
    RehearsalSafe internal safe;
    address internal emergency = makeAddr("emergency");
    address internal pauser = makeAddr("pauser");

    // Approving body: two voters, one unit of power each, quorum 2 — so BOTH
    // must vote. This is AC-GOV-03's "quorum 2 of total voting power 2".
    address internal voter1 = makeAddr("gov-voter-1");
    address internal voter2 = makeAddr("gov-voter-2");

    // Recommending body: committee agents, deliberately disjoint (INV-4).
    address internal agentAthena = makeAddr("committee-athena");
    address internal agentWoon = makeAddr("committee-woon");

    uint64 internal constant VOTING_PERIOD = 1 days;
    uint64 internal constant EXECUTION_DELAY = 1 days;
    uint256 internal constant QUORUM = 2;
    uint256 internal constant MIN_DELAY = 2 days;

    function setUp() public {
        timelockScript = new DeployTimelock();
        govScript = new DeployRouterGovernance();
        deployer = address(timelockScript);

        safe = new RehearsalSafe(address(this));
        usdc = new MockUsdc();

        vault = new RobotMoneyVault(
            usdc,
            type(uint256).max,
            type(uint256).max,
            0,
            address(safe), // feeRecipient
            deployer, // admin
            deployer // emergencyResponder
        );
        gateway = new RobotMoneyGateway(usdc, vault, deployer, pauser, address(0));
        registry = new VaultRegistry(deployer);
        router = new PortfolioRouter(address(usdc), address(registry), deployer);

        // Two weightable vaults, registered and router-eligible.
        vaultA = new MockGovVault(address(usdc));
        vaultB = new MockGovVault(address(usdc));
        vm.startPrank(deployer);
        registry.registerVault(
            address(vaultA),
            VaultRegistry.VaultMetadata({name: "Vault A", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(vaultB),
            VaultRegistry.VaultMetadata({name: "Vault B", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);
        vm.stopPrank();

        // The committee body. Separately administered; no voting power.
        icPolicy = new InvestmentCommitteePolicy(deployer, address(gateway));
        vm.startPrank(deployer);
        icPolicy.grantRole(icPolicy.COMMITTEE_AGENT_ROLE(), agentAthena);
        icPolicy.grantRole(icPolicy.COMMITTEE_AGENT_ROLE(), agentWoon);
        vm.stopPrank();

        // The deployment under test: the governance script, at quorum 2.
        DeployRouterGovernance.Deployed memory d = govScript.runInProcessWith(
            deployer, address(router), VOTING_PERIOD, EXECUTION_DELAY, QUORUM
        );
        gov = d.governance;

        // Voting power is assigned by ADMIN_ROLE, which the deployer still
        // holds until the handover below.
        vm.startPrank(deployer);
        gov.setVotingPower(voter1, 1);
        gov.setVotingPower(voter2, 1);
        vm.stopPrank();

        // The handover ceremony: every ADMIN_ROLE moves to the timelock and is
        // revoked from the deployer EOA.
        // Call the script FROM the script's own address. `DeployTimelock`
        // revokes roles from `msg.sender` while its own external calls
        // originate from the script address; only when those two coincide does
        // the fixture model a real ceremony, where one EOA does both. (A test
        // that lets them differ revokes from an address that never held the
        // role, and the script's "deployer no longer has ADMIN_ROLE" requires
        // pass vacuously.)
        vm.prank(deployer);
        DeployTimelock.Deployed memory t = timelockScript.runInProcess(
            address(vault),
            address(gateway),
            address(registry),
            address(router),
            address(gov),
            address(safe),
            emergency,
            MIN_DELAY
        );
        timelock = t.timelock;
    }

    // ─── Half 1: the approving body can act ──────────────────────────────────

    /// @notice The deploy script leaves governance able to call setWeights.
    function test_governanceHoldsRouterAdminRole() public view {
        assertTrue(
            IAccessControl(address(router)).hasRole(ADMIN_ROLE, address(gov)),
            "RouterGovernance cannot reach router.setWeights: execute() is dead on arrival"
        );
    }

    /// @notice THE R7 regression: propose (routed through the timelock, which
    ///         now holds governance ADMIN_ROLE) → both voters vote → delay
    ///         elapses → execute() lands the weights on the router.
    function test_executeReachesSetWeightsOnAFreshDeployment() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();

        uint256 proposalId = _proposeViaTimelock(vaults, bps);

        // Quorum is 2 and each voter has 1: a single vote is not enough.
        vm.prank(voter1);
        gov.vote(proposalId);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);
        vm.expectRevert(RouterGovernance.QuorumNotReached.selector);
        gov.execute(proposalId);

        // Second proposal, both voters — the honest path.
        proposalId = _proposeViaTimelock(vaults, bps);
        vm.prank(voter1);
        gov.vote(proposalId);
        vm.prank(voter2);
        gov.vote(proposalId);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);

        gov.execute(proposalId);

        (address[] memory appliedVaults, uint256[] memory appliedBps) = router.getWeights();
        assertEq(appliedVaults.length, 2, "no voted weight vector on the router");
        assertEq(appliedVaults[0], address(vaultA));
        assertEq(appliedVaults[1], address(vaultB));
        assertEq(appliedBps[0], 6_000, "vault A weight not applied");
        assertEq(appliedBps[1], 4_000, "vault B weight not applied");
    }

    // ─── Half 2: the deployer EOA cannot ─────────────────────────────────────

    /// @notice After the ceremony a direct setWeights from the deployer EOA
    ///         reverts. This is the assertion the deploy script now makes too.
    function test_deployerEoaCannotCallSetWeightsDirectly() public {
        (address[] memory vaults, uint256[] memory bps) = _sixtyForty();
        vm.prank(deployer);
        vm.expectRevert();
        router.setWeights(vaults, bps);
    }

    function test_deployerEoaHasNoRouterAdminRole() public view {
        assertFalse(
            IAccessControl(address(router)).hasRole(ADMIN_ROLE, deployer),
            "deployer EOA still holds router ADMIN_ROLE"
        );
    }

    // ─── INV-4: the two bodies are disjoint ──────────────────────────────────

    /// @notice The voters that carried the executed proposal hold no
    ///         COMMITTEE_AGENT_ROLE, and the committee agents hold no power.
    function test_voterSetIsDisjointFromTheCommittee() public view {
        bytes32 agentRole = icPolicy.COMMITTEE_AGENT_ROLE();
        assertFalse(icPolicy.hasRole(agentRole, voter1), "voter1 is also a committee agent");
        assertFalse(icPolicy.hasRole(agentRole, voter2), "voter2 is also a committee agent");
        assertEq(gov.votingPower(agentAthena), 0, "committee agent holds voting power");
        assertEq(gov.votingPower(agentWoon), 0, "committee agent holds voting power");
    }

    /// @notice The quorum that carried it is the D16 floor, and it is not
    ///         satisfiable by one voter.
    function test_quorumIsTwoOfTotalVotingPowerTwo() public view {
        (,, uint256 quorumThreshold, uint256 totalVotingPower) = gov.cadenceParams();
        assertEq(quorumThreshold, 2);
        assertEq(totalVotingPower, 2);
        assertGt(quorumThreshold, 1, "a quorum of 1 is a hollow separate-body control");
    }

    // ─── The rehearsal Safe stand-in ────────────────────────────────────────

    /// @notice Without a call forwarder the handover bricks the environment:
    ///         the stand-in is the timelock's only proposer and executor, and
    ///         a contract that can only answer `getThreshold()` can do neither.
    function test_rehearsalSafeCanDriveTheTimelock() public view {
        assertTrue(
            timelock.hasRole(timelock.PROPOSER_ROLE(), address(safe)), "safe is not a proposer"
        );
        assertEq(safe.owner(), address(this), "nobody holds the stand-in's key");
    }

    /// @notice The forwarder is owner-gated — it stands in for a signer set,
    ///         not for an open door.
    function test_rehearsalSafeForwarderRefusesANonOwner() public {
        bytes memory data = abi.encodeCall(RouterGovernance.setQuorumThreshold, (99));
        vm.prank(makeAddr("intruder"));
        vm.expectRevert(RehearsalSafe.NotOwner.selector);
        safe.exec(address(gov), 0, data);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _sixtyForty() internal view returns (address[] memory vaults, uint256[] memory bps) {
        vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        bps = new uint256[](2);
        bps[0] = 6_000;
        bps[1] = 4_000;
    }

    /// @dev `propose` is ADMIN_ROLE-gated and ADMIN_ROLE now lives on the
    ///      timelock, so a proposal is scheduled by the Safe and executed after
    ///      the min delay — the real post-handover route.
    function _proposeViaTimelock(address[] memory vaults, uint256[] memory bps)
        internal
        returns (uint256 proposalId)
    {
        bytes memory data = abi.encodeCall(RouterGovernance.propose, (vaults, bps));
        bytes32 salt = keccak256(abi.encode(block.timestamp, vaults, bps));

        safe.exec(
            address(timelock),
            0,
            abi.encodeCall(
                TimelockController.schedule, (address(gov), 0, data, bytes32(0), salt, MIN_DELAY)
            )
        );

        vm.warp(block.timestamp + MIN_DELAY + 1);

        safe.exec(
            address(timelock),
            0,
            abi.encodeCall(TimelockController.execute, (address(gov), 0, data, bytes32(0), salt))
        );

        proposalId = gov.currentProposalId();
    }
}
