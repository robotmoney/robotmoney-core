// SPDX-License-Identifier: MIT
// Canonical: project-fusion.md §4.3 — Governance topology, three bodies
// Canonical: docs/technical/security-model.md §4 — Access control & admin
// Canonical: docs/technical/governance-isomorphism.md — the Safe is a real
//            2-of-3 SafeProxy on the canonical SafeL2 singleton (R5, R6, R9)
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
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockUsdc, MockGovVault} from "./RouterGovernance.t.sol";
import {ISafe, ISafeProxyFactory, _ISafeSetup} from "./SafeIntegration.t.sol";

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
///
/// @dev    Fork test. The Safe that drives the timelock is the one stage now
///         runs (issue #1447): a SafeProxy created through the canonical
///         SafeProxyFactory on the canonical SafeL2 singleton, 2-of-3, driven
///         by `execTransaction` with two owner signatures. Those contracts
///         exist only on a Base fork, so CI runs this file through
///         scripts/devnet/run-golden-forge-forks.sh against the golden
///         fixture, like SafeIntegration.t.sol.
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

    // ─── The Safe (canonical Safe v1.4.1 on Base) ────────────────────────────

    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    /// @dev A real 2-of-3 Safe, the topology stage's ceremony creates: the
    ///      post-handover path is only proved if an actual quorum-enforcing
    ///      Safe can drive the timelock.
    ISafe internal safe;
    uint256[3] internal ownerPks;
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
        string memory rpc = vm.envOr("FORK_RPC_URL", string("http://127.0.0.1:8545"));
        vm.createSelectFork(rpc);

        timelockScript = new DeployTimelock();
        govScript = new DeployRouterGovernance();
        deployer = address(timelockScript);

        safe = _createSafe();
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

    // ─── The Safe ────────────────────────────────────────────────────────────

    /// @notice The Safe is the timelock's proposer and executor, and it is a
    ///         real 2-of-3: threshold and owner set read back from the Safe.
    function test_safeIsTheTimelockDriverAndIsTwoOfThree() public view {
        assertTrue(
            timelock.hasRole(timelock.PROPOSER_ROLE(), address(safe)), "safe is not a proposer"
        );
        assertTrue(
            timelock.hasRole(timelock.EXECUTOR_ROLE(), address(safe)), "safe is not an executor"
        );
        assertEq(safe.getThreshold(), 2, "safe threshold must be 2");
        assertEq(safe.getOwners().length, 3, "safe must have 3 owners");
    }

    /// @notice One owner's signature cannot schedule anything (GS020), so no
    ///         single key drives governance (governance-isomorphism.md R10).
    function test_oneOwnerCannotDriveTheTimelock() public {
        bytes memory data = abi.encodeCall(
            TimelockController.schedule,
            (
                address(gov),
                0,
                abi.encodeCall(RouterGovernance.setQuorumThreshold, (99)),
                bytes32(0),
                keccak256("one-owner"),
                MIN_DELAY
            )
        );
        bytes memory oneSig = _sign(_sortedOwnerPks()[0], _safeTxHash(address(timelock), data));

        vm.prank(makeAddr("intruder"));
        vm.expectRevert(bytes("GS020"));
        safe.execTransaction(
            address(timelock), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), oneSig
        );
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

        _safeExec(
            address(timelock),
            abi.encodeCall(
                TimelockController.schedule, (address(gov), 0, data, bytes32(0), salt, MIN_DELAY)
            )
        );

        vm.warp(block.timestamp + MIN_DELAY + 1);

        _safeExec(
            address(timelock),
            abi.encodeCall(TimelockController.execute, (address(gov), 0, data, bytes32(0), salt))
        );

        proposalId = gov.currentProposalId();
    }

    /// @dev A 2-of-3 SafeProxy on SafeL2 through the canonical factory — the
    ///      same call stage's ceremony makes (fusion-ceremony.sh create_safe).
    function _createSafe() internal returns (ISafe created) {
        ownerPks[0] = uint256(keccak256("handover-safe-owner-1"));
        ownerPks[1] = uint256(keccak256("handover-safe-owner-2"));
        ownerPks[2] = uint256(keccak256("handover-safe-owner-3"));
        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            owners[i] = vm.addr(ownerPks[i]);
        }
        bytes memory setup = abi.encodeCall(
            _ISafeSetup.setup,
            (owners, 2, address(0), "", SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        created = ISafe(
            ISafeProxyFactory(SAFE_PROXY_FACTORY)
                .createProxyWithNonce(SAFE_SINGLETON_L2, setup, uint256(keccak256("handover-safe")))
        );
    }

    /// @dev Owner keys ordered by owner address, ascending (Safe requirement).
    function _sortedOwnerPks() internal view returns (uint256[3] memory pks) {
        pks = ownerPks;
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = i + 1; j < 3; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) (pks[i], pks[j]) = (pks[j], pks[i]);
            }
        }
    }

    function _safeTxHash(address to, bytes memory data) internal view returns (bytes32) {
        return safe.getTransactionHash(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), safe.nonce()
        );
    }

    /// @dev One 65-byte (r, s, v) owner signature over a SafeTx digest.
    function _sign(uint256 pk, bytes32 txHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s_) = vm.sign(pk, txHash);
        return abi.encodePacked(r, s_, v);
    }

    /// @dev execTransaction with the two lowest-address owners' signatures.
    function _safeExec(address to, bytes memory data) internal {
        bytes32 txHash = _safeTxHash(to, data);
        uint256[3] memory pks = _sortedOwnerPks();
        bytes memory sigs = bytes.concat(_sign(pks[0], txHash), _sign(pks[1], txHash));
        assertTrue(
            safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs),
            "safe.execTransaction failed"
        );
    }
}
