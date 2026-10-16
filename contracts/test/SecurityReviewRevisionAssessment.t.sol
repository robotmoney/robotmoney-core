// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Counterexamples to overly broad conclusions in the revised security report.
// These use local mocks; the recorder test does not establish economic exploitability.

import {SecurityReviewRecheckCommitteePoc} from "./SecurityReviewRecheckCommitteePoc.t.sol";
import {SecurityReviewRecheckVaultPoc} from "./SecurityReviewRecheckVaultPoc.t.sol";
import {UniswapV4PriceRecorderTest} from "./UniswapV4PriceRecorder.t.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {IInvestmentCommitteePolicy} from "../gateway/interfaces/IInvestmentCommitteePolicy.sol";
import {MockAdapter} from "./RobotMoneyVault.t.sol";

contract RevisionCommitteeAssessment is SecurityReviewRecheckCommitteePoc {
    /// Core 1791: an address that never consented cannot be squatted, so it cannot be
    /// registered by the attacker's ownership and the member's own onboarding still works.
    function test_assessment_unconsentedAgentCannotBeSquattedIntoCommittee() public {
        address victim = address(0xD1);
        bytes32 salt = keccak256("assessment");
        vm.prank(attacker);
        gateway.commitAuthorization(keccak256(abi.encode(victim, attacker, salt)));
        vm.roll(block.number + 1);
        vm.prank(attacker);
        vm.expectRevert(RobotMoneyGateway.OwnerConsentMissing.selector);
        gateway.revealAuthorization(victim, salt, _selfPolicy(attacker));
        assertEq(gateway.agentOwner(victim), address(0));

        // The member's address is onboarded by its own key and registers.
        _selfReveal(victim, victim, keccak256("assessment-self"));
        vm.prank(admin);
        gateway.committeeRegister(victim, "new-member");
        IInvestmentCommitteePolicy.VoteParams memory p = _defaultVoteParams();
        p.agent = victim;
        vm.prank(victim);
        uint256 id = gateway.committeeVoteSubmit(p);
        assertEq(ic.getVote(id).agent, victim);
        assertEq(gateway.agentOwner(victim), victim);
    }
}

contract RevisionVaultAssessment is SecurityReviewRecheckVaultPoc {
    /// The pre-1788 counterexample (re-exclude both adapters, deposit, restore) is closed by
    /// core 1788 (PR 1814): the deposit leg reverts while any active adapter is ineligible.
    /// Since core 1820 there is also nothing orphaned to redistribute: restoration realises the
    /// excluded balance into the exclusion record of alice, the holder at the snapshot.
    function test_assessment_orphanRedistributionSequenceBlocked() public {
        MockAdapter second = _secondAdapter();
        vm.prank(alice);
        vault.deposit(2_000 * ONE_USDC, alice);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), false);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertEq(vault.totalSupply(), 0);
        vm.prank(admin);
        vault.setAdapterAllowed(address(second), true);
        assertEq(vault.totalAssets(), 0, "nothing orphaned in NAV");
        assertEq(vault.exclusionLedger().claimable(1, alice), 1_000 * ONE_USDC, "alice's claim");
        vm.startPrank(admin);
        vault.setAdapterAllowed(address(adapter), false);
        vault.setAdapterAllowed(address(second), false);
        vm.stopPrank();
        assertEq(vault.maxDeposit(bob), 0);
        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(1_000 * ONE_USDC, bob);
    }
}

contract RevisionRecorderAssessment is UniswapV4PriceRecorderTest {
    function test_assessment_transientTickPersistsForFullWindowWithoutHonestRecord() public {
        rec.grow(2);
        _advance(60);
        pm.setTick(poolId, START_TICK + 50_000);
        rec.record();
        pm.setTick(poolId, START_TICK);
        _advance(1_800);
        int256 mean = (int256(_obs(0)) - int256(_obs(1_800))) / 1_800;
        assertEq(mean, int256(START_TICK) + 600);
        (, int24 live,,) = rec.slot0();
        assertEq(int256(live), int256(START_TICK));
    }
}
