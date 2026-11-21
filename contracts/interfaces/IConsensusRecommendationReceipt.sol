// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §2.1
// Implements: issue #1247 — (fusion) anchor the receipt on chain
pragma solidity ^0.8.24;

/// @title IConsensusRecommendationReceipt
/// @notice Interface for the ConsensusRecommendationReceipt contract.
///
/// Design constraints (docs/architecture.md §4.9, settled by issue #1247 task 4.0):
/// - **Signalling only.** Recording or releasing a receipt moves no value and
///   sets no router weight. INV-4 (`docs/prd.md` §12).
/// - **One submitter attests for the committee.** There is no
///   `consensusSubmitSignature`: the analysts' ed25519 signatures ride inside
///   the payload as data verified off-chain (ADR-0012 §5). `recordReceipt` is
///   the single one-shot write.
/// - **No contract expiry.** The rejected multi-signer design's 7-day window is
///   deleted, not repurposed. Staleness is derived off-chain from the payload's
///   `created_at`.
/// - `recordReceipt` is called directly by a `RECEIPT_SUBMITTER_ROLE` holder (the submitter
///   Safe). `releaseReceipt` needs `RECEIPT_RELEASER_ROLE`, held by RouterGovernance.
///   `ADMIN_ROLE`, held by the `TimelockController` alone (INV-3), administers both.
interface IConsensusRecommendationReceipt {
    // ─── Types ───────────────────────────────────────────────────────────────

    /// @notice A single on-chain consensus-receipt commitment.
    /// @param receiptId     `keccak256` of the receipt-id preimage (see
    ///                      `computeReceiptId`). Unique per session per subject.
    /// @param payloadDigest `keccak256` of the receipt's canonical bytes, per
    ///                      `tests/fixtures/consensus-receipt.canonicalization.json`.
    /// @param payloadUri    Stable public route serving those exact bytes.
    /// @param submitter     The `RECEIPT_SUBMITTER_ROLE` holder that recorded the receipt (`msg.sender`).
    /// @param recordedAt    Block timestamp of `recordReceipt`.
    /// @param releasedAt    Block timestamp of `releaseReceipt`, or 0.
    /// @param released      Whether the release role has released the receipt.
    struct Receipt {
        bytes32 receiptId;
        bytes32 payloadDigest;
        string payloadUri;
        address submitter;
        uint64 recordedAt;
        uint64 releasedAt;
        bool released;
    }

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when a submitter records a receipt commitment.
    /// @dev Exactly three indexed parameters (the EVM's non-anonymous limit).
    ///      No parameter is an analyst signature — the payload signatures are
    ///      never event data, on-chain or indexed. See issue #1247 AC3.
    event ReceiptRecorded(
        bytes32 indexed receiptId,
        address indexed submitter,
        uint256 indexed index,
        bytes32 payloadDigest,
        string payloadUri,
        uint64 recordedAt
    );

    /// @notice Emitted when `RECEIPT_RELEASER_ROLE` releases a recorded receipt.
    /// @dev Signalling only: sets `released = true` and emits. No fund movement,
    ///      no `setWeights` call (INV-4).
    event ReceiptReleased(bytes32 indexed receiptId, address indexed releasedBy, uint64 releasedAt);

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Constructor passed `address(0)`.
    error ZeroAddress();
    /// @notice `migrateToSubmitterRoles` was called by an account other than the upgrade timelock.
    error MigrationCallerNotTimelock();
    /// @notice Caller does not hold `RECEIPT_SUBMITTER_ROLE`.
    error SubmitterNotAllowlisted();
    /// @notice `receiptId` was `bytes32(0)`.
    error EmptyReceiptId();
    /// @notice `payloadDigest` was `bytes32(0)`.
    error EmptyPayloadDigest();
    /// @notice `payloadUri` was the empty string.
    error EmptyPayloadUri();
    /// @notice `receiptId` has already been recorded — one receipt per session per subject.
    error ReceiptAlreadyRecorded();
    /// @notice `receiptId` has never been recorded.
    error ReceiptNotFound();
    /// @notice `receiptId` has already been released.
    error ReceiptAlreadyReleased();

    // ─── Write surface ───────────────────────────────────────────────────────

    /// @notice Record an unreleased consensus-receipt commitment. The caller must hold
    ///         `RECEIPT_SUBMITTER_ROLE` and is stored as the submitter.
    /// @param receiptId     Unique receipt id; see `computeReceiptId`.
    /// @param payloadDigest `keccak256` of the receipt's canonical bytes.
    /// @param payloadUri    Public route serving those exact bytes.
    /// @return index Index of the newly appended receipt.
    function recordReceipt(bytes32 receiptId, bytes32 payloadDigest, string calldata payloadUri)
        external
        returns (uint256 index);

    /// @notice Release a recorded receipt. `RECEIPT_RELEASER_ROLE` only (RouterGovernance).
    ///         Signalling only — see INV-4.
    /// @param receiptId The receipt to release.
    function releaseReceipt(bytes32 receiptId) external;

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice Total number of recorded receipts.
    function receiptCount() external view returns (uint256);

    /// @notice Retrieve a receipt by append index.
    function getReceipt(uint256 index) external view returns (Receipt memory);

    /// @notice Retrieve a receipt by its id. Reverts with `ReceiptNotFound`.
    function getReceiptById(bytes32 receiptId) external view returns (Receipt memory);

    /// @notice Whether `receiptId` has been recorded.
    function isRecorded(bytes32 receiptId) external view returns (bool);

    /// @notice Whether `receiptId` has been released. False when not recorded.
    function isReleased(bytes32 receiptId) external view returns (bool);

    /// @notice The receipt-id derivation pinned by
    ///         `tests/fixtures/consensus-receipt.canonicalization.json#receipt_id_derivation`:
    ///         `keccak256("robotmoney:consensus-receipt-id:v1\n" + session_id + "\n" + subject_id)`.
    function computeReceiptId(string calldata sessionId, string calldata subjectId)
        external
        pure
        returns (bytes32);
}
