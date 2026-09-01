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
/// - `recordReceipt` is `onlyGateway`; `releaseReceipt` is `ADMIN_ROLE`, which
///   the `TimelockController` holds (INV-3).
interface IConsensusRecommendationReceipt {
    // ─── Types ───────────────────────────────────────────────────────────────

    /// @notice A single on-chain consensus-receipt commitment.
    /// @param receiptId     `keccak256` of the receipt-id preimage (see
    ///                      `computeReceiptId`). Unique per session per subject.
    /// @param payloadDigest `keccak256` of the receipt's canonical bytes, per
    ///                      `tests/fixtures/consensus-receipt.canonicalization.json`.
    /// @param payloadUri    Stable public route serving those exact bytes.
    /// @param submitter     Committee agent EOA that attested for the committee.
    /// @param recordedAt    Block timestamp of `recordReceipt`.
    /// @param releasedAt    Block timestamp of `releaseReceipt`, or 0.
    /// @param released      Whether an admin has released the receipt.
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

    /// @notice Emitted when a committee submitter records a receipt commitment.
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

    /// @notice Emitted when `ADMIN_ROLE` releases a recorded receipt.
    /// @dev Signalling only: sets `released = true` and emits. No fund movement,
    ///      no `setWeights` call (INV-4).
    event ReceiptReleased(bytes32 indexed receiptId, address indexed releasedBy, uint64 releasedAt);

    // ─── Errors ──────────────────────────────────────────────────────────────

    /// @notice Constructor passed `address(0)`.
    error ZeroAddress();
    /// @notice Caller is not the registered RobotMoneyGateway.
    error CallerNotGateway();
    /// @notice Submitter does not hold `COMMITTEE_AGENT_ROLE` on the IC policy.
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

    /// @notice Record an unreleased consensus-receipt commitment.
    ///         Must be called via the RobotMoneyGateway (`onlyGateway`).
    /// @param submitter     Committee agent that attested (the gateway's `msg.sender`).
    /// @param receiptId     Unique receipt id; see `computeReceiptId`.
    /// @param payloadDigest `keccak256` of the receipt's canonical bytes.
    /// @param payloadUri    Public route serving those exact bytes.
    /// @return index Index of the newly appended receipt.
    function recordReceipt(
        address submitter,
        bytes32 receiptId,
        bytes32 payloadDigest,
        string calldata payloadUri
    ) external returns (uint256 index);

    /// @notice Release a recorded receipt. `ADMIN_ROLE` only (the timelock).
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

    /// @notice The RobotMoneyGateway. All receipt writes must originate here.
    function gateway() external view returns (address);

    /// @notice The InvestmentCommitteePolicy whose `COMMITTEE_AGENT_ROLE` gates submitters.
    function icPolicy() external view returns (address);
}
