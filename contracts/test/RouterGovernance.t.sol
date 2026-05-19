// SPDX-License-Identifier: MIT
// Canonical: none — Foundry unit tests for contracts/RouterGovernance.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

// ─── Test fixtures ────────────────────────────────────────────────────────────

/// @notice Minimal ERC-20 USDC mock (6 decimals) for the router.
contract MockUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal ERC-4626-shaped vault mock.
contract MockGovVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;

    constructor(address asset_) ERC20("Mock Vault Shares", "MVS") {
        assetToken = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }
}

// ─── RouterGovernanceTest ─────────────────────────────────────────────────────

contract RouterGovernanceTest is Test {
    // ── Governance parameters ──
    uint64 constant VOTING_PERIOD = 1 days;
    uint64 constant EXECUTION_DELAY = 1 days;
    uint256 constant QUORUM_THRESHOLD = 510_000e18; // 51% of 1M total power

    // ── Voting power ──
    uint256 constant ALICE_POWER = 600_000e18; // ~60%
    uint256 constant BOB_POWER = 200_000e18; // ~20%
    uint256 constant CAROL_POWER = 200_000e18; // ~20%

    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal gov;

    address internal govAdmin = makeAddr("govAdmin");
    address internal routerAdmin = makeAddr("routerAdmin");
    address internal registryAdmin = makeAddr("registryAdmin");

    address internal alice = makeAddr("alice"); // 60% power
    address internal bob = makeAddr("bob"); // 20% power
    address internal carol = makeAddr("carol"); // 20% power
    address internal stranger = makeAddr("stranger"); // 0 power

    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    VaultRegistry.VaultMetadata internal metaA;
    VaultRegistry.VaultMetadata internal metaB;

    // ─── setUp ────────────────────────────────────────────────────────────────

    function setUp() public {
        // Deploy USDC and registry.
        usdc = new MockUsdc();
        registry = new VaultRegistry(registryAdmin);

        // Deploy vaults and register them.
        vaultA = new MockGovVault(address(usdc));
        vaultB = new MockGovVault(address(usdc));

        metaA =
            VaultRegistry.VaultMetadata({name: "Vault A", asset: address(usdc), registeredAt: 0});
        metaB =
            VaultRegistry.VaultMetadata({name: "Vault B", asset: address(usdc), registeredAt: 0});

        vm.startPrank(registryAdmin);
        registry.registerVault(address(vaultA), metaA);
        registry.registerVault(address(vaultB), metaB);
        vm.stopPrank();

        // Deploy router and governance.
        router = new PortfolioRouter(address(usdc), address(registry), routerAdmin);
        gov = new RouterGovernance(
            address(router), govAdmin, VOTING_PERIOD, EXECUTION_DELAY, QUORUM_THRESHOLD
        );

        // Grant governance contract ADMIN_ROLE on the router so it can call setWeights.
        bytes32 adminRole = router.ADMIN_ROLE();
        vm.startPrank(routerAdmin);
        router.grantRole(adminRole, address(gov));
        // Issue #447: MockGovVault does not implement IPrototypeAware, so
        // attest both vaults as non-prototype before governance can weight
        // them.
        router.setNonPrototypeAttested(address(vaultA), true);
        router.setNonPrototypeAttested(address(vaultB), true);
        vm.stopPrank();

        // Assign voting power via govAdmin.
        vm.startPrank(govAdmin);
        gov.setVotingPower(alice, ALICE_POWER);
        gov.setVotingPower(bob, BOB_POWER);
        gov.setVotingPower(carol, CAROL_POWER);
        vm.stopPrank();
    }

    // ─── Helper ───────────────────────────────────────────────────────────────

    /// @dev Build a valid 60/40 proposal and submit it from govAdmin.
    function _proposeValid() internal returns (uint256 proposalId) {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);

        uint256[] memory bps = new uint256[](2);
        bps[0] = 6_000;
        bps[1] = 4_000;

        vm.prank(govAdmin);
        proposalId = gov.propose(vaults, bps);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroRouter() public {
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        new RouterGovernance(address(0), govAdmin, VOTING_PERIOD, EXECUTION_DELAY, QUORUM_THRESHOLD);
    }

    function test_constructor_revertsOnZeroAdmin() public {
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        new RouterGovernance(
            address(router), address(0), VOTING_PERIOD, EXECUTION_DELAY, QUORUM_THRESHOLD
        );
    }

    function test_constructor_storesParams() public view {
        assertEq(address(gov.router()), address(router));
        assertEq(gov.votingPeriod(), VOTING_PERIOD);
        assertEq(gov.executionDelay(), EXECUTION_DELAY);
        assertEq(gov.quorumThreshold(), QUORUM_THRESHOLD);
    }

    function test_constructor_adminRoleGranted() public view {
        assertTrue(gov.hasRole(gov.ADMIN_ROLE(), govAdmin));
    }

    // ─── setVotingPower() ─────────────────────────────────────────────────────

    function test_setVotingPower_setsAndTracksTotal() public view {
        assertEq(gov.votingPower(alice), ALICE_POWER);
        assertEq(gov.votingPower(bob), BOB_POWER);
        assertEq(gov.votingPower(carol), CAROL_POWER);
        assertEq(gov.totalVotingPower(), ALICE_POWER + BOB_POWER + CAROL_POWER);
    }

    function test_setVotingPower_revertsOnZeroAddress() public {
        vm.prank(govAdmin);
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        gov.setVotingPower(address(0), 100e18);
    }

    function test_setVotingPower_revertsForNonAdmin() public {
        vm.prank(alice);
        vm.expectRevert();
        gov.setVotingPower(alice, 1e18);
    }

    // ─── propose() ───────────────────────────────────────────────────────────

    function test_propose_successfulCreation() public {
        uint256 pid = _proposeValid();
        assertEq(pid, 1);
        assertEq(gov.currentProposalId(), 1);
    }

    function test_propose_emitsProposalCreated() public {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 6_000;
        bps[1] = 4_000;

        vm.prank(govAdmin);
        vm.expectEmit(true, true, false, false);
        emit RouterGovernance.ProposalCreated(
            1, govAdmin, vaults, bps, uint64(block.timestamp) + VOTING_PERIOD
        );
        gov.propose(vaults, bps);
    }

    function test_propose_revertsForNonAdmin() public {
        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(alice);
        vm.expectRevert();
        gov.propose(vaults, bps);
    }

    function test_propose_revertsOnInvalidWeightSum() public {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 5_000;
        bps[1] = 4_000; // sum = 9000, not 10000

        vm.prank(govAdmin);
        vm.expectRevert(RouterGovernance.InvalidWeightSum.selector);
        gov.propose(vaults, bps);
    }

    function test_propose_revertsOnLengthMismatch() public {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(govAdmin);
        vm.expectRevert(RouterGovernance.LengthMismatch.selector);
        gov.propose(vaults, bps);
    }

    function test_propose_revertsIfAlreadyActive() public {
        _proposeValid();

        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(govAdmin);
        vm.expectRevert(RouterGovernance.ActiveProposalExists.selector);
        gov.propose(vaults, bps);
    }

    function test_propose_allowsNewProposalAfterDefeated() public {
        _proposeValid();

        // Fast-forward past voting period without quorum — proposal becomes Defeated.
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(govAdmin);
        uint256 pid = gov.propose(vaults, bps);
        assertEq(pid, 2);
        assertEq(gov.currentProposalId(), 2);
    }

    // ─── vote() ──────────────────────────────────────────────────────────────

    function test_vote_success() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);

        // Check via proposalState — alice has 60% > 51% quorum so now Queued
        // after voting period (at this point it's still Active since we didn't warp).
        // Just check hasVoted.
        assertTrue(gov.hasVoted(pid, alice));
    }

    function test_vote_emitsVoteCast() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit RouterGovernance.VoteCast(pid, alice, ALICE_POWER, ALICE_POWER);
        gov.vote(pid);
    }

    function test_vote_revertsOnDoubleVote() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);

        vm.prank(alice);
        vm.expectRevert(RouterGovernance.AlreadyVoted.selector);
        gov.vote(pid);
    }

    function test_vote_revertsAfterVotingPeriod() public {
        uint256 pid = _proposeValid();

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        vm.prank(alice);
        vm.expectRevert(RouterGovernance.ProposalNotActive.selector);
        gov.vote(pid);
    }

    function test_vote_revertsOnNonExistentProposal() public {
        vm.prank(alice);
        vm.expectRevert(RouterGovernance.NoActiveProposal.selector);
        gov.vote(999);
    }

    function test_vote_revertsIfNoVotingPower() public {
        uint256 pid = _proposeValid();

        vm.prank(stranger);
        vm.expectRevert(RouterGovernance.NoVotingPower.selector);
        gov.vote(pid);
    }

    function test_vote_multipleVotersAccumulate() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.prank(bob);
        gov.vote(pid);

        // Both have voted — check hasVoted.
        assertTrue(gov.hasVoted(pid, alice));
        assertTrue(gov.hasVoted(pid, bob));
        assertFalse(gov.hasVoted(pid, carol));
    }

    // ─── proposalState() ─────────────────────────────────────────────────────

    function test_proposalState_activeBeforeVotingDeadline() public {
        uint256 pid = _proposeValid();
        RouterGovernance.ProposalState s = gov.proposalState(pid);
        assertEq(uint256(s), uint256(RouterGovernance.ProposalState.Active));
    }

    function test_proposalState_defeatedWhenNoQuorum() public {
        uint256 pid = _proposeValid();

        // Bob (20%) votes — below 51% quorum.
        vm.prank(bob);
        gov.vote(pid);

        // Advance past voting period.
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        RouterGovernance.ProposalState s = gov.proposalState(pid);
        assertEq(uint256(s), uint256(RouterGovernance.ProposalState.Defeated));
    }

    function test_proposalState_queuedWhenQuorumReached() public {
        uint256 pid = _proposeValid();

        // Alice (60%) votes — quorum reached.
        vm.prank(alice);
        gov.vote(pid);

        // Advance past voting period.
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        RouterGovernance.ProposalState s = gov.proposalState(pid);
        assertEq(uint256(s), uint256(RouterGovernance.ProposalState.Queued));
    }

    function test_proposalState_executedAfterExecution() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);

        // Advance past voting period + execution delay.
        vm.warp(block.timestamp + VOTING_PERIOD + EXECUTION_DELAY + 1);

        gov.execute(pid);

        RouterGovernance.ProposalState s = gov.proposalState(pid);
        assertEq(uint256(s), uint256(RouterGovernance.ProposalState.Executed));
    }

    function test_proposalState_revertsOnNonExistent() public {
        vm.expectRevert(RouterGovernance.NoActiveProposal.selector);
        gov.proposalState(999);
    }

    // ─── execute() ───────────────────────────────────────────────────────────

    function test_execute_success() public {
        uint256 pid = _proposeValid();

        // Alice votes — 60% > 51% quorum.
        vm.prank(alice);
        gov.vote(pid);

        // Fast-forward past voting period + execution delay.
        vm.warp(block.timestamp + VOTING_PERIOD + EXECUTION_DELAY + 1);

        vm.prank(carol);
        gov.execute(pid);

        // Verify weights applied to router.
        (address[] memory vaults, uint256[] memory bps) = router.getWeights();
        assertEq(vaults.length, 2);
        assertEq(vaults[0], address(vaultA));
        assertEq(vaults[1], address(vaultB));
        assertEq(bps[0], 6_000);
        assertEq(bps[1], 4_000);
    }

    function test_execute_emitsProposalExecuted() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + VOTING_PERIOD + EXECUTION_DELAY + 1);

        vm.prank(carol);
        vm.expectEmit(true, true, false, false);
        emit RouterGovernance.ProposalExecuted(pid, carol);
        gov.execute(pid);
    }

    function test_execute_revertsBeforeVotingEnds() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);

        // Still within voting period — quorum reached but voting open.
        vm.expectRevert(RouterGovernance.VotingStillOpen.selector);
        gov.execute(pid);
    }

    function test_execute_revertsBeforeExecutionDelay() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);

        // Past voting period but before execution delay.
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        vm.expectRevert(RouterGovernance.ExecutionDelayNotElapsed.selector);
        gov.execute(pid);
    }

    function test_execute_revertsIfQuorumNotReached() public {
        uint256 pid = _proposeValid();

        // Bob only has 20% — below 51% quorum.
        vm.prank(bob);
        gov.vote(pid);

        vm.warp(block.timestamp + VOTING_PERIOD + EXECUTION_DELAY + 1);

        vm.expectRevert(RouterGovernance.QuorumNotReached.selector);
        gov.execute(pid);
    }

    function test_execute_revertsIfAlreadyExecuted() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + VOTING_PERIOD + EXECUTION_DELAY + 1);
        gov.execute(pid);

        vm.expectRevert(RouterGovernance.AlreadyExecuted.selector);
        gov.execute(pid);
    }

    // ─── cadenceParams() ─────────────────────────────────────────────────────

    function test_cadenceParams_returnsStoredValues() public view {
        (uint64 vp, uint64 ed, uint256 qt, uint256 tvp) = gov.cadenceParams();
        assertEq(vp, VOTING_PERIOD);
        assertEq(ed, EXECUTION_DELAY);
        assertEq(qt, QUORUM_THRESHOLD);
        assertEq(tvp, ALICE_POWER + BOB_POWER + CAROL_POWER);
    }

    // ─── currentWeights() ────────────────────────────────────────────────────

    function test_currentWeights_returnsRouterWeights() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + VOTING_PERIOD + EXECUTION_DELAY + 1);
        gov.execute(pid);

        (address[] memory vaults, uint256[] memory bps) = gov.currentWeights();
        assertEq(vaults.length, 2);
        assertEq(bps[0], 6_000);
        assertEq(bps[1], 4_000);
    }

    // ─── hasVoted() ──────────────────────────────────────────────────────────

    function test_hasVoted_tracksVoterState() public {
        uint256 pid = _proposeValid();
        assertFalse(gov.hasVoted(pid, alice));

        vm.prank(alice);
        gov.vote(pid);

        assertTrue(gov.hasVoted(pid, alice));
        assertFalse(gov.hasVoted(pid, bob));
    }

    // ─── Full round-trip ──────────────────────────────────────────────────────

    function test_fullGovernanceRoundTrip() public {
        // Propose.
        uint256 pid = _proposeValid();
        assertEq(gov.currentProposalId(), 1);

        // Vote — alice (60%) reaches quorum.
        vm.prank(alice);
        gov.vote(pid);

        // Advance past voting period.
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // State should be Queued.
        assertEq(uint256(gov.proposalState(pid)), uint256(RouterGovernance.ProposalState.Queued));

        // Advance past execution delay.
        vm.warp(block.timestamp + EXECUTION_DELAY);

        // Execute — anyone may call.
        gov.execute(pid);

        // Weights applied.
        (address[] memory vaults, uint256[] memory bps) = router.getWeights();
        assertEq(vaults.length, 2);
        assertEq(vaults[0], address(vaultA));
        assertEq(vaults[1], address(vaultB));
        assertEq(bps[0], 6_000);
        assertEq(bps[1], 4_000);

        // State is now Executed.
        assertEq(uint256(gov.proposalState(pid)), uint256(RouterGovernance.ProposalState.Executed));
    }
}
