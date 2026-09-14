// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Canonical: docs/technical/router-governance-handoff-runbook.md §1.1
// Implements: project-fusion.md §12.5 AC-GOV-03 — "approval quorum is
//             meaningfully greater than the placeholder 1", proved by a
//             DEPLOYMENT-DEFAULT test rather than only by an invariant over a
//             hand-configured fixture.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Why this file exists separately from GovernanceSeparationInvariant.t.sol:
///      that suite proves the quorum is meaningful for a fixture it configures
///      itself (`QUORUM_THRESHOLD = 250e18`). It says nothing about what a
///      deployment does when nobody passes a quorum — which is exactly how the
///      devnet ended up reporting `quorumThreshold() == 1`. The gap was a
///      DEFAULT, so the test has to be about the default.
contract DeployRouterGovernanceDefaultsTest is Test {
    DeployRouterGovernance internal script;
    PortfolioRouter internal router;
    address internal admin = makeAddr("gov-admin");

    function setUp() public {
        script = new DeployRouterGovernance();
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);
    }

    // ─── The default itself ──────────────────────────────────────────────────

    /// @notice The shipped default is greater than the placeholder `1`.
    function test_defaultQuorumThresholdIsAboveThePlaceholder() public view {
        assertGt(
            script.DEFAULT_QUORUM_THRESHOLD(),
            1,
            "a deployment that takes no QUORUM_THRESHOLD must not land on 1"
        );
    }

    /// @notice Deploying with the default produces on-chain state that agrees
    ///         with it. The criterion is about `quorumThreshold()` as READ FROM
    ///         THE CHAIN, so assert the deployed value, not the constant.
    function test_deployingWithTheDefaultYieldsAMeaningfulOnChainQuorum() public {
        DeployRouterGovernance.Deployed memory d = script.runInProcessWith(
            admin,
            address(router),
            script.DEFAULT_VOTING_PERIOD(),
            script.DEFAULT_EXECUTION_DELAY(),
            script.DEFAULT_QUORUM_THRESHOLD()
        );
        assertEq(d.governance.quorumThreshold(), script.DEFAULT_QUORUM_THRESHOLD());
        assertGt(d.governance.quorumThreshold(), 1, "deployed quorum is still the placeholder");
    }

    /// @notice The default quorum is strictly more than one unit of voting
    ///         power, so a holder of one unit cannot constitute quorum alone.
    /// @dev    Named for what it actually asserts. It does NOT drive a
    ///         propose/vote/execute attempt, and a single voter granted two
    ///         units would still reach the default quorum — the stronger
    ///         voter-set form lives in
    ///         GovernanceSeparationInvariant.t.sol::test_quorumReflectsTheVoterSet.
    function test_defaultQuorumExceedsOneUnitOfVotingPower() public {
        DeployRouterGovernance.Deployed memory d = script.runInProcessWith(
            admin,
            address(router),
            script.DEFAULT_VOTING_PERIOD(),
            script.DEFAULT_EXECUTION_DELAY(),
            script.DEFAULT_QUORUM_THRESHOLD()
        );
        address soloVoter = makeAddr("solo-voter");
        vm.prank(admin);
        d.governance.setVotingPower(soloVoter, 1);
        assertLt(
            d.governance.votingPower(soloVoter),
            d.governance.quorumThreshold(),
            "one unit of voting power must not constitute quorum"
        );
    }

    // ─── The floor is enforced, not merely defaulted ─────────────────────────

    /// @notice An explicit `QUORUM_THRESHOLD=1` is refused by the broadcast
    ///         entrypoint before anything is deployed.
    /// @dev    Sets ONLY `QUORUM_THRESHOLD`. `vm.setEnv` writes process-global
    ///         state that concurrently scheduled test files share, and
    ///         `Deploy.t.sol::test_deploy_envDriven_runInProcessSucceeds` both
    ///         sets and asserts on `ADMIN_ADDRESS`; setting it here too raced
    ///         that test and intermittently deployed with the wrong admin
    ///         (AgentTokenVault.t.sol:238 records the prior incident). The
    ///         script now checks the quorum floor before reading any address,
    ///         so those two writes are unnecessary. `QUORUM_THRESHOLD` is read
    ///         by nothing else in the suite. Restored afterwards so no later
    ///         test in this file inherits it.
    function test_runRefusesAnExplicitQuorumOfOne() public {
        vm.setEnv("QUORUM_THRESHOLD", "1");
        vm.expectRevert(bytes("QUORUM_THRESHOLD must be greater than 1"));
        script.run();
        vm.setEnv("QUORUM_THRESHOLD", vm.toString(script.DEFAULT_QUORUM_THRESHOLD()));
    }

    /// @notice `QUORUM_THRESHOLD=0` — the #864 env-default hazard — is refused
    ///         by the same guard rather than by the contract's own minimum.
    /// @dev    See the note on test_runRefusesAnExplicitQuorumOfOne: only
    ///         `QUORUM_THRESHOLD` is touched, and it is restored.
    function test_runRefusesAQuorumOfZero() public {
        vm.setEnv("QUORUM_THRESHOLD", "0");
        vm.expectRevert(bytes("QUORUM_THRESHOLD must be greater than 1"));
        script.run();
        vm.setEnv("QUORUM_THRESHOLD", vm.toString(script.DEFAULT_QUORUM_THRESHOLD()));
    }

    /// @notice The in-process path enforces the same floor. It is the entrypoint
    ///         fork tests and fixtures call, so an unguarded variant would be a
    ///         second, quieter way to deploy a hollow quorum.
    function test_inProcessDeployRefusesAQuorumOfOne() public {
        // Read the defaults BEFORE arming expectRevert: they are external calls
        // on `script`, and the cheatcode applies to the next call it sees.
        uint64 period = script.DEFAULT_VOTING_PERIOD();
        uint64 delay = script.DEFAULT_EXECUTION_DELAY();
        vm.expectRevert(bytes("QUORUM_THRESHOLD must be greater than 1"));
        script.runInProcessWith(admin, address(router), period, delay, 1);
    }

    /// @notice The contract floor and the deploy default now agree (T22 /
    ///         D16: `MIN_QUORUM_THRESHOLD` was raised from 1 to 2). The script
    ///         guard is kept anyway — it refuses BEFORE spending gas on a
    ///         deployment and gives the operator a sentence instead of a
    ///         four-byte selector — but it is no longer the only thing standing
    ///         between the topology and a hollow quorum. This test fails loudly
    ///         if the two ever drift apart in the weaker direction.
    function test_theDeployDefaultIsNotBelowTheContractFloor() public {
        DeployRouterGovernance.Deployed memory d = script.runInProcessWith(
            admin,
            address(router),
            script.DEFAULT_VOTING_PERIOD(),
            script.DEFAULT_EXECUTION_DELAY(),
            script.DEFAULT_QUORUM_THRESHOLD()
        );
        assertEq(d.governance.MIN_QUORUM_THRESHOLD(), 2, "contract floor is no longer 2 (D16)");
        assertGe(
            script.DEFAULT_QUORUM_THRESHOLD(),
            d.governance.MIN_QUORUM_THRESHOLD(),
            "the deploy default must never be below the constructor floor"
        );
    }

    /// @notice The constructor now refuses a quorum of 1 on its own, so the
    ///         guarantee survives a caller that bypasses this script entirely.
    function test_theContractItselfRefusesAQuorumOfOne() public {
        // Read the defaults BEFORE arming expectRevert — they are external
        // calls on `script` and the cheatcode applies to the next call it sees.
        uint64 period = script.DEFAULT_VOTING_PERIOD();
        uint64 delay = script.DEFAULT_EXECUTION_DELAY();
        vm.expectRevert(RouterGovernance.QuorumBelowMinimum.selector);
        new RouterGovernance(address(router), admin, period, delay, 1);
    }
}
