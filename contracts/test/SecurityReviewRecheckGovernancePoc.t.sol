// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Adversarial re-check of docs/code-review/20261012-security-review.md. Reproduces: with the shipped stage-sheet values
// (QUORUM_THRESHOLD=2, VOTER_POWER=1000 per voter) a single voter carries a
// router-weight proposal alone, contradicting RouterGovernance.sol:52-54 and
// the fixture-only assertion in GovernanceSeparationInvariant.t.sol:191.
//
// Run: forge test --match-path contracts/test/SecurityReviewRecheckGovernancePoc.t.sol -vv

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

contract RecheckUsdc is ERC20 {
    constructor() ERC20("USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract RecheckVault is ERC20 {
    address private immutable _asset;

    constructor(address asset_) ERC20("v", "v") {
        _asset = asset_;
    }

    function asset() external view returns (address) {
        return _asset;
    }
}

contract SecurityReviewRecheckGovernancePoc is Test {
    // Values copied from deployments/twin-918453/stage-sheet.env and
    // deployments/base-8453-rehearsal/stage-sheet.example.env.
    uint256 constant QUORUM_THRESHOLD = 2;
    uint256 constant VOTER_POWER = 1000;
    uint64 constant VOTING_PERIOD = 3600;
    uint64 constant EXECUTION_DELAY = 3600;

    address admin = makeAddr("timelock");
    address voterA = makeAddr("voterA");
    address voterB = makeAddr("voterB");

    VaultRegistry registry;
    PortfolioRouter router;
    RouterGovernance gov;
    RecheckVault vault;

    function setUp() public {
        RecheckUsdc usdc = new RecheckUsdc();
        registry = new VaultRegistry(admin);
        vault = new RecheckVault(address(usdc));
        vm.startPrank(admin);
        registry.registerVault(
            address(vault),
            VaultRegistry.VaultMetadata({name: "v", asset: address(usdc), registeredAt: 0})
        );
        registry.setRouterEligible(address(vault), true);
        vm.stopPrank();

        router = new PortfolioRouter(address(usdc), address(registry), admin);
        gov = new RouterGovernance(
            address(router), admin, VOTING_PERIOD, EXECUTION_DELAY, QUORUM_THRESHOLD
        );

        vm.startPrank(admin);
        router.grantRole(router.ADMIN_ROLE(), address(gov));
        router.grantRole(router.WEIGHT_SETTER_ROLE(), address(gov));
        router.revokeRole(router.WEIGHT_SETTER_ROLE(), admin);
        // DeployRouterGovernance._setVotingPower: every voter gets VOTER_POWER,
        // the only guard is totalVotingPower >= quorumThreshold.
        gov.setVotingPower(voterA, VOTER_POWER);
        gov.setVotingPower(voterB, VOTER_POWER);
        vm.stopPrank();
    }

    function test_singleVoterCarriesProposalWithSheetValues() public {
        address[] memory vaults = new address[](1);
        vaults[0] = address(vault);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.roll(block.number + 1);
        vm.prank(admin);
        uint256 id = gov.propose(vaults, bps);

        vm.roll(block.number + 1);
        vm.prank(voterA); // one of two voters
        gov.vote(id);

        vm.warp(block.timestamp + VOTING_PERIOD + EXECUTION_DELAY + 1);
        assertEq(uint256(gov.proposalState(id)), uint256(RouterGovernance.ProposalState.Queued));

        gov.execute(id);
        assertTrue(router.votedWeightsActive(), "one voter of two moved the active weights");
        assertFalse(gov.hasVoted(id, voterB), "second voter never voted");
    }
}
