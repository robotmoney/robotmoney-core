// SPDX-License-Identifier: MIT
// Canonical: docs/technical/consensus-receipt-submitter-runbook.md (issue 1750, owner decision 2026-10-10: the receipt submitter is a multisig)
// Implements: issue 1888 — the submitter Safe records directly on the receipt; the timelock alone grants its role
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ConsensusRecommendationReceipt} from "../ConsensusRecommendationReceipt.sol";
import {IConsensusRecommendationReceipt} from "../interfaces/IConsensusRecommendationReceipt.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";

/// @title ConsensusReceiptSafeSubmitterTest
/// @notice The consensus receipt SUBMITTER is a real SafeL2 1.4.1 proxy (a second Safe, separate from the governing Safe). It holds
///         `RECEIPT_SUBMITTER_ROLE` on the receipt contract and nothing else. The role is granted by exactly one delayed timelock call
///         (`govern --row register-submitter`). The contract makes no tx.origin, isContract or ecrecover check on the role holder, so a
///         contract account is accepted unchanged, and the stored submitter is the Safe (`msg.sender`).
contract ConsensusReceiptSafeSubmitterTest is SafeGovernance {
    address governingSafe;
    address submitterSafe;

    ConsensusRecommendationReceipt receipts;
    TimelockController timelock;

    string constant URI = "https://twin.invalid/r.json";
    uint256 constant DELAY = 1 hours;

    function setUp() public {
        _installSafeSet();
        governingSafe = _newDefaultSafe();
        submitterSafe = _newDefaultSafe(); // a SECOND Safe: same owner keys, a different address and its own nonce
        timelock = _newGovTimelock(governingSafe, DELAY);
        receipts = CoreProxies.consensusRecommendationReceipt(address(timelock));
    }

    /// @dev `register-submitter`: the governing Safe schedules one `grantRole(RECEIPT_SUBMITTER_ROLE, safe)` on the receipt, then executes it.
    function _registerSubmitter(address safe_) internal {
        bytes memory grant =
            abi.encodeCall(receipts.grantRole, (receipts.RECEIPT_SUBMITTER_ROLE(), safe_));
        _govSchedule(governingSafe, timelock, address(receipts), grant, bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        _govExecute(governingSafe, timelock, address(receipts), grant, bytes32(0));
    }

    function _recordCall(bytes32 id, bytes32 digest) internal pure returns (bytes memory) {
        return abi.encodeCall(IConsensusRecommendationReceipt.recordReceipt, (id, digest, URI));
    }

    /// The registered Safe records with two owner signatures and the receipt contract stores the Safe as the submitter.
    function testSafeSubmitterRecordsAReceiptWithTwoOwnerSignatures() public {
        _registerSubmitter(submitterSafe);
        assertTrue(
            receipts.hasRole(receipts.RECEIPT_SUBMITTER_ROLE(), submitterSafe),
            "RECEIPT_SUBMITTER_ROLE"
        );
        bytes32 id = keccak256("receipt");
        bytes32 digest = keccak256("digest");
        uint256 nonceBefore = _nonce(submitterSafe);
        assertTrue(_safeExec(submitterSafe, address(receipts), _recordCall(id, digest)));
        assertEq(_nonce(submitterSafe), nonceBefore + 1, "the submitter Safe's own nonce moved");
        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(id);
        assertEq(r.submitter, submitterSafe, "submitter == the Safe");
        assertEq(r.payloadDigest, digest);
        assertEq(r.payloadUri, URI);
    }

    /// One owner signature is below the 2-of-3 threshold: the Safe refuses (GS020) and nothing is recorded.
    function testOneOwnerSignatureCannotRecord() public {
        _registerSubmitter(submitterSafe);
        bytes32 id = keccak256("receipt");
        bytes memory data = _recordCall(id, keccak256("d"));
        bytes memory oneSig =
            _oneOwnerSignature(_safeDigest(submitterSafe, address(receipts), data));
        vm.expectRevert(bytes("GS020"));
        _safeExecWith(submitterSafe, address(receipts), data, oneSig);
        assertFalse(receipts.isRecorded(id));
    }

    /// The governing Safe is NOT a submitter: with a full quorum it still cannot record (it holds no role).
    function testGoverningSafeCannotRecord() public {
        _registerSubmitter(submitterSafe);
        bytes memory data = _recordCall(keccak256("r"), keccak256("d"));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(governingSafe, address(receipts), data));
        vm.expectRevert(bytes("GS013"));
        _safeExecWith(governingSafe, address(receipts), data, sigs);
        assertFalse(receipts.isRecorded(keccak256("r")));
    }

    /// Signatures made for the governing Safe's hash do not execute on the submitter Safe (different address, different domain).
    function testSignaturesDoNotTransferBetweenTheTwoSafes() public {
        _registerSubmitter(submitterSafe);
        bytes memory data = _recordCall(keccak256("r"), keccak256("d"));
        bytes memory forGoverning =
            _twoOwnerSignatures(_safeDigest(governingSafe, address(receipts), data));
        vm.expectRevert();
        _safeExecWith(submitterSafe, address(receipts), data, forGoverning);
    }

    /// An unregistered Safe cannot record, even with a full quorum.
    function testUnregisteredSafeCannotRecord() public {
        address other = _newDefaultSafe();
        bytes memory data = _recordCall(keccak256("r"), keccak256("d"));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(other, address(receipts), data));
        vm.expectRevert(bytes("GS013"));
        _safeExecWith(other, address(receipts), data, sigs);
    }

    /// The governing Safe may be the submitter too (shared owners): one grant, the same Safe proposes on the timelock and records.
    function testGoverningSafeAsSubmitterRecordsAfterTheGrant() public {
        _registerSubmitter(governingSafe);
        bytes32 id = keccak256("shared");
        assertTrue(_safeExec(governingSafe, address(receipts), _recordCall(id, keccak256("d"))));
        assertEq(receipts.getReceiptById(id).submitter, governingSafe);
    }

    /// A revoked Safe submitter can no longer record. The revoke is a delayed timelock call.
    function testRevokedSafeSubmitterCannotRecord() public {
        _registerSubmitter(submitterSafe);
        bytes memory revoke =
            abi.encodeCall(receipts.revokeRole, (receipts.RECEIPT_SUBMITTER_ROLE(), submitterSafe));
        _govSchedule(governingSafe, timelock, address(receipts), revoke, bytes32(uint256(1)), DELAY);
        vm.warp(block.timestamp + DELAY);
        _govExecute(governingSafe, timelock, address(receipts), revoke, bytes32(uint256(1)));

        bytes memory data = _recordCall(keccak256("r"), keccak256("d"));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(submitterSafe, address(receipts), data));
        vm.expectRevert(bytes("GS013"));
        _safeExecWith(submitterSafe, address(receipts), data, sigs);
        assertFalse(receipts.isRecorded(keccak256("r")));
    }

    function _nonce(address safe_) internal view returns (uint256) {
        (bool ok, bytes memory out) = safe_.staticcall(abi.encodeWithSignature("nonce()"));
        require(ok, "nonce");
        return abi.decode(out, (uint256));
    }
}
