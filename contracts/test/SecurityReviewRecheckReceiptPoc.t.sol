// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.8 — Receipt Submitter Authority
// Implements: issue 1888 — the receipt cases of the retired committee re-check suite
pragma solidity ^0.8.24;

// Adversarial re-check of finding 3 of docs/code-review/20261012-security-review.md (attribution).
// The committee vote cases are gone with the on-chain committee. Receipt anchoring stays: only a
// `RECEIPT_SUBMITTER_ROLE` holder records, and the stored submitter is `msg.sender`.
// Run: forge test --match-path 'contracts/test/SecurityReviewRecheckReceiptPoc.t.sol' -vv

import {Test} from "forge-std/Test.sol";

import {ConsensusRecommendationReceipt} from "../ConsensusRecommendationReceipt.sol";
import {IConsensusRecommendationReceipt} from "../interfaces/IConsensusRecommendationReceipt.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

contract SecurityReviewRecheckReceiptPoc is Test {
    address attacker = address(0xB2);
    address member = address(0xB1);
    ConsensusRecommendationReceipt receipt;

    function setUp() public {
        receipt = CoreProxies.consensusRecommendationReceipt(address(this));
        receipt.grantRole(receipt.RECEIPT_SUBMITTER_ROLE(), member);
    }

    // ── Q3: receipt anchoring is NOT spoofable ───────────────────────────────

    /// @dev An address with no submitter role cannot anchor, whatever else it holds elsewhere.
    function test_addressWithoutTheRoleCannotAnchorReceipt() public {
        vm.prank(attacker);
        vm.expectRevert(IConsensusRecommendationReceipt.SubmitterNotAllowlisted.selector);
        receipt.recordReceipt(keccak256("rid"), keccak256("digest"), "https://x/r");
        assertEq(receipt.receiptCount(), 0);

        // The real submitter can, and is recorded as the submitter.
        vm.prank(member);
        receipt.recordReceipt(keccak256("rid"), keccak256("digest"), "https://x/r");
        assertEq(receipt.getReceipt(0).submitter, member);
    }

    /// @dev The submitter is `msg.sender`: there is no argument through which a caller could
    ///      file a receipt under another member's address.
    function test_submitterCannotBeSpoofedByArgument() public {
        vm.prank(member);
        receipt.recordReceipt(keccak256("a"), keccak256("da"), "https://x/a");
        vm.prank(member);
        receipt.recordReceipt(keccak256("b"), keccak256("db"), "https://x/b");
        assertEq(receipt.getReceiptById(keccak256("a")).submitter, member);
        assertEq(receipt.getReceiptById(keccak256("b")).submitter, member);
        assertEq(receipt.receiptCount(), 2);
    }

    /// @dev The role admin is ADMIN_ROLE only: a submitter cannot grant the role to another account.
    function test_submitterCannotGrantTheRoleToAnotherAccount() public {
        bytes32 role = receipt.RECEIPT_SUBMITTER_ROLE();
        vm.prank(member);
        vm.expectRevert();
        receipt.grantRole(role, attacker);
        assertFalse(receipt.hasRole(role, attacker));
    }
}
