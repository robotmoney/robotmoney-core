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

/// @notice Minimal mintable ERC-20 that acts as the RM governance token.
contract MockRmToken is ERC20 {
    constructor() ERC20("RobotMoney", "RM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function totalSupply() public view override returns (uint256) {
        return super.totalSupply();
    }
}

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
    uint256 constant QUORUM_BPS = 5_100; // 51%
    uint256 constant EXECUTION_DELAY = 1 days;
    uint256 constant CADENCE_WINDOW = 7 days;

    // ── Token supply ──
    uint256 constant TOTAL_RM = 1_000_000e18; // 1 M RM tokens

    MockRmToken internal rmToken;
    MockUsdc internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    RouterGovernance internal gov;

    address internal routerAdmin = makeAddr("routerAdmin");
    address internal registryAdmin = makeAddr("registryAdmin");

    address internal alice = makeAddr("alice"); // ~60% RM — majority
    address internal bob = makeAddr("bob"); // ~20% RM
    address internal carol = makeAddr("carol"); // ~20% RM
    address internal stranger = makeAddr("stranger"); // 0 RM

    MockGovVault internal vaultA;
    MockGovVault internal vaultB;

    VaultRegistry.VaultMetadata internal metaA;
    VaultRegistry.VaultMetadata internal metaB;

    // ─── setUp ────────────────────────────────────────────────────────────────

    function setUp() public {
        // Deploy RM token and distribute supply.
        rmToken = new MockRmToken();
        rmToken.mint(alice, 600_000e18); // 60%
        rmToken.mint(bob, 200_000e18); // 20%
        rmToken.mint(carol, 200_000e18); // 20%

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
            address(rmToken),
            address(registry),
            address(router),
            QUORUM_BPS,
            EXECUTION_DELAY,
            CADENCE_WINDOW
        );

        // Grant governance contract ADMIN_ROLE on the router so it can call setWeights.
        // Read the role value before pranking to avoid consuming the prank on the staticcall.
        bytes32 adminRole = router.ADMIN_ROLE();
        vm.prank(routerAdmin);
        router.grantRole(adminRole, address(gov));
    }

    // ─── Helper ───────────────────────────────────────────────────────────────

    /// @dev Build a valid 60/40 proposal and submit it from alice.
    function _proposeValid() internal returns (uint256 proposalId) {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);

        uint256[] memory bps = new uint256[](2);
        bps[0] = 6_000;
        bps[1] = 4_000;

        vm.prank(alice);
        proposalId = gov.propose(vaults, bps);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_revertsOnZeroRmToken() public {
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        new RouterGovernance(
            address(0),
            address(registry),
            address(router),
            QUORUM_BPS,
            EXECUTION_DELAY,
            CADENCE_WINDOW
        );
    }

    function test_constructor_revertsOnZeroRegistry() public {
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        new RouterGovernance(
            address(rmToken),
            address(0),
            address(router),
            QUORUM_BPS,
            EXECUTION_DELAY,
            CADENCE_WINDOW
        );
    }

    function test_constructor_revertsOnZeroRouter() public {
        vm.expectRevert(RouterGovernance.ZeroAddress.selector);
        new RouterGovernance(
            address(rmToken),
            address(registry),
            address(0),
            QUORUM_BPS,
            EXECUTION_DELAY,
            CADENCE_WINDOW
        );
    }

    function test_constructor_storesParams() public view {
        assertEq(address(gov.rmToken()), address(rmToken));
        assertEq(address(gov.registry()), address(registry));
        assertEq(address(gov.router()), address(router));
        assertEq(gov.quorumBps(), QUORUM_BPS);
        assertEq(gov.executionDelay(), EXECUTION_DELAY);
        assertEq(gov.cadenceWindow(), CADENCE_WINDOW);
        assertEq(gov.totalRmSupply(), TOTAL_RM);
    }

    // ─── propose() ───────────────────────────────────────────────────────────

    function test_propose_successfulCreation() public {
        uint256 pid = _proposeValid();
        assertEq(pid, 1);
        assertEq(gov.proposalCount(), 1);
        assertEq(gov.activeProposalId(), 1);
    }

    function test_propose_emitsProposalCreated() public {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 6_000;
        bps[1] = 4_000;

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit RouterGovernance.ProposalCreated(1, alice, vaults, bps, block.number);
        gov.propose(vaults, bps);
    }

    function test_propose_revertsIfNotRmHolder() public {
        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(stranger);
        vm.expectRevert(RouterGovernance.NotRmHolder.selector);
        gov.propose(vaults, bps);
    }

    function test_propose_revertsOnInvalidWeightSum() public {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 5_000;
        bps[1] = 4_000; // sum = 9000, not 10000

        vm.prank(alice);
        vm.expectRevert(RouterGovernance.InvalidWeightSum.selector);
        gov.propose(vaults, bps);
    }

    function test_propose_revertsOnLengthMismatch() public {
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(alice);
        vm.expectRevert(RouterGovernance.LengthMismatch.selector);
        gov.propose(vaults, bps);
    }

    function test_propose_revertsIfVaultNotRegistered() public {
        address[] memory vaults = new address[](1);
        vaults[0] = makeAddr("unregisteredVault");
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(alice);
        vm.expectRevert(); // VaultRegistry reverts with NotRegistered
        gov.propose(vaults, bps);
    }

    function test_propose_revertsIfAlreadyActive() public {
        _proposeValid();

        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(bob);
        vm.expectRevert(RouterGovernance.ProposalAlreadyActive.selector);
        gov.propose(vaults, bps);
    }

    function test_propose_allowsNewProposalAfterExpiry() public {
        _proposeValid();

        // Fast-forward past cadence window to expire the active proposal.
        vm.warp(block.timestamp + CADENCE_WINDOW + 1);

        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(bob);
        uint256 pid = gov.propose(vaults, bps);
        assertEq(pid, 2);
        assertEq(gov.activeProposalId(), 2);
    }

    // ─── vote() ──────────────────────────────────────────────────────────────

    function test_vote_success() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);

        (uint256 totalVotes,,) = gov.voteTallies(pid);
        assertEq(totalVotes, 600_000e18);
    }

    function test_vote_emitsVoteCast() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit RouterGovernance.VoteCast(pid, alice, 600_000e18);
        gov.vote(pid);
    }

    function test_vote_revertsOnDoublVote() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);

        vm.prank(alice);
        vm.expectRevert(RouterGovernance.AlreadyVoted.selector);
        gov.vote(pid);
    }

    function test_vote_revertsOnExpiredProposal() public {
        uint256 pid = _proposeValid();

        vm.warp(block.timestamp + CADENCE_WINDOW + 1);

        vm.prank(alice);
        vm.expectRevert(RouterGovernance.ProposalExpired.selector);
        gov.vote(pid);
    }

    function test_vote_revertsOnNonExistentProposal() public {
        vm.prank(alice);
        vm.expectRevert(RouterGovernance.ProposalNotFound.selector);
        gov.vote(999);
    }

    function test_vote_revertsIfNotRmHolder() public {
        uint256 pid = _proposeValid();

        vm.prank(stranger);
        vm.expectRevert(RouterGovernance.NotRmHolder.selector);
        gov.vote(pid);
    }

    function test_vote_multipleVotersAccumulate() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.prank(bob);
        gov.vote(pid);

        (uint256 totalVotes,,) = gov.voteTallies(pid);
        assertEq(totalVotes, 800_000e18); // alice 600k + bob 200k
    }

    // ─── execute() ───────────────────────────────────────────────────────────

    function test_execute_success() public {
        uint256 pid = _proposeValid();

        // Alice votes — 60% > 51% quorum.
        vm.prank(alice);
        gov.vote(pid);

        // Fast-forward past execution delay.
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);

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

    function test_execute_emitsProposalExecutedAndWeightsApplied() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);

        vm.prank(carol);
        vm.expectEmit(true, true, false, false);
        emit RouterGovernance.ProposalExecuted(pid, carol);
        gov.execute(pid);
    }

    function test_execute_revertsBeforeExecutionDelay() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);

        // Only advance half the delay.
        vm.warp(block.timestamp + EXECUTION_DELAY / 2);

        vm.expectRevert(RouterGovernance.ExecutionDelayNotElapsed.selector);
        gov.execute(pid);
    }

    function test_execute_revertsIfQuorumNotReached() public {
        uint256 pid = _proposeValid();

        // Bob only has 20% — below 51% quorum.
        vm.prank(bob);
        gov.vote(pid);

        vm.warp(block.timestamp + EXECUTION_DELAY + 1);

        vm.expectRevert(RouterGovernance.QuorumNotReached.selector);
        gov.execute(pid);
    }

    function test_execute_revertsOnExpiredProposal() public {
        uint256 pid = _proposeValid();

        // Do NOT vote — let it expire.
        vm.warp(block.timestamp + CADENCE_WINDOW + 1);

        vm.expectRevert(RouterGovernance.ProposalExpired.selector);
        gov.execute(pid);
    }

    function test_execute_revertsIfAlreadyExecuted() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);
        gov.execute(pid);

        vm.expectRevert(RouterGovernance.ProposalNotActive.selector);
        gov.execute(pid);
    }

    function test_execute_clearsActiveProposalId() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);
        gov.execute(pid);

        assertEq(gov.activeProposalId(), 0);
    }

    // ─── View functions ───────────────────────────────────────────────────────

    function test_activeProposal_returnsZeroWhenNone() public view {
        (uint256 id,) = gov.activeProposal();
        assertEq(id, 0);
    }

    function test_activeProposal_returnsIdWhenSet() public {
        uint256 pid = _proposeValid();
        (uint256 id,) = gov.activeProposal();
        assertEq(id, pid);
    }

    function test_activeProposal_stateActiveBeforeVotes() public {
        _proposeValid();
        (, RouterGovernance.ProposalState state) = gov.activeProposal();
        assertEq(uint256(state), uint256(RouterGovernance.ProposalState.Active));
    }

    function test_activeProposal_stateSucceededAfterQuorumAndDelay() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);

        (, RouterGovernance.ProposalState state) = gov.activeProposal();
        assertEq(uint256(state), uint256(RouterGovernance.ProposalState.Succeeded));
    }

    function test_activeProposal_stateExpiredAfterWindow() public {
        _proposeValid();
        vm.warp(block.timestamp + CADENCE_WINDOW + 1);
        (, RouterGovernance.ProposalState state) = gov.activeProposal();
        assertEq(uint256(state), uint256(RouterGovernance.ProposalState.Expired));
    }

    function test_activeProposal_stateExecutedAfterExecution() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);
        gov.execute(pid);

        // Active proposal id is now 0; state returned is Active (default for id=0).
        (uint256 id,) = gov.activeProposal();
        assertEq(id, 0);

        // Check directly via getProposal.
        (,,,,,, bool executed) = gov.getProposal(pid);
        assertTrue(executed);
    }

    function test_voteTallies_correctValues() public {
        uint256 pid = _proposeValid();

        (uint256 totalVotesBefore, uint256 quorumNeeded, bool quorumReachedBefore) =
            gov.voteTallies(pid);
        assertEq(totalVotesBefore, 0);
        assertEq(quorumNeeded, (TOTAL_RM * QUORUM_BPS) / 10_000);
        assertFalse(quorumReachedBefore);

        vm.prank(alice);
        gov.vote(pid);

        (,, bool quorumReachedAfter) = gov.voteTallies(pid);
        assertTrue(quorumReachedAfter);
    }

    function test_currentWeights_returnsRouterWeights() public {
        uint256 pid = _proposeValid();

        vm.prank(alice);
        gov.vote(pid);
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);
        gov.execute(pid);

        (address[] memory vaults, uint256[] memory bps) = gov.currentWeights();
        assertEq(vaults.length, 2);
        assertEq(bps[0], 6_000);
        assertEq(bps[1], 4_000);
    }

    function test_cadenceParams_returnsStoredValues() public view {
        (uint256 q, uint256 d, uint256 c) = gov.cadenceParams();
        assertEq(q, QUORUM_BPS);
        assertEq(d, EXECUTION_DELAY);
        assertEq(c, CADENCE_WINDOW);
    }

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
        assertEq(gov.proposalCount(), 1);

        // Vote — alice (60%) reaches quorum.
        vm.prank(alice);
        gov.vote(pid);

        (,, bool quorumReached) = gov.voteTallies(pid);
        assertTrue(quorumReached);

        // Advance past execution delay.
        vm.warp(block.timestamp + EXECUTION_DELAY + 1);

        // Execute — anyone may call.
        gov.execute(pid);

        // Weights applied.
        (address[] memory vaults, uint256[] memory bps) = router.getWeights();
        assertEq(vaults.length, 2);
        assertEq(vaults[0], address(vaultA));
        assertEq(vaults[1], address(vaultB));
        assertEq(bps[0], 6_000);
        assertEq(bps[1], 4_000);

        // Active proposal cleared.
        assertEq(gov.activeProposalId(), 0);
    }
}
