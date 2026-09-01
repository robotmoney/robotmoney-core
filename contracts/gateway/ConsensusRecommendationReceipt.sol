// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §2.1
// Implements: issue #1247 — (fusion) anchor the receipt on chain
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {IConsensusRecommendationReceipt} from "./interfaces/IConsensusRecommendationReceipt.sol";

/// @title ConsensusRecommendationReceipt
/// @notice On-chain commitment register for the swarm's consensus
///         recommendation receipts. Stores a `receiptId`, the `keccak256` of the receipt's
///         canonical bytes, and the public URI serving those exact bytes.
///
/// Why the anchor exists (docs/product/…-investment-committee-v0.md §2.1): a
/// signed receipt published only at an RM-controlled URL can still be silently
/// suppressed by RM. The on-chain commitment is what makes the record
/// censorship-resistant. **That property lands at mainnet deployment, not at
/// v0.1's devnet proof of the mechanism** — no surface may describe the record
/// as tamper-proof in the present tense before then.
///
/// Design constraints, settled by issue #1247 task 4.0 and recorded in
/// `docs/architecture.md` §4.9:
/// - **Signalling only.** No treasury spend, no router-weight mutation, no
///   `receive`/`fallback`, no ERC-20 surface, no call into any vault or router.
///   INV-4 (`docs/prd.md` §12). Enforced by `testSignallingOnlyBoundary`.
/// - **One submitter, one write.** The rejected multi-signer design's
///   `consensusSubmitSignature` does not survive: a one-shot `recordReceipt`
///   replaces it. Analyst ed25519 signatures are payload data verified
///   off-chain; the EVM has no ed25519 precompile and ADR-0012 §5 closes that
///   seam. The chain proves the committee produced the recommendation and that
///   one submitter attested to it — never that each named analyst signed.
/// - **No contract expiry.** The 7-day `deadline` window collapses to zero: it
///   bounded a multi-party signature-collection window that no longer exists.
///   Staleness is a property of the recommendation, derived off-chain from the
///   payload's `created_at`. An unreleased receipt stays an immutable public
///   record forever; nothing deletes it or changes its on-chain state.
/// - **Role administration stays on one contract.** There is no second agent
///   registry: submitters are gated by `COMMITTEE_AGENT_ROLE` on the shipped
///   `InvestmentCommitteePolicy`.
/// - `ADMIN_ROLE` is held by the `TimelockController` (INV-3).
///
/// Payload contract: `tests/fixtures/consensus-receipt.schema.json` and
/// `consensus-receipt.canonicalization.json`, byte-identical to
/// `contract/src/__fixtures__/` in `robotmoney-frontend`.
///
/// Emits: `ReceiptRecorded`, `ReceiptReleased`.
contract ConsensusRecommendationReceipt is
    AccessControl,
    ReentrancyGuard,
    IConsensusRecommendationReceipt
{
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Releases receipts. Held by the `TimelockController` (INV-3).
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Mirror of `InvestmentCommitteePolicy.COMMITTEE_AGENT_ROLE`. This
    ///         contract keeps no agent registry of its own — membership is read
    ///         from the IC policy so role administration stays on one contract.
    bytes32 public constant COMMITTEE_AGENT_ROLE = keccak256("COMMITTEE_AGENT_ROLE");

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Domain separator for the receipt-id preimage, pinned by
    ///         `consensus-receipt.canonicalization.json#receipt_id_derivation`.
    string internal constant RECEIPT_ID_DOMAIN = "robotmoney:consensus-receipt-id:v1\n";

    // ─── State ───────────────────────────────────────────────────────────────

    /// @inheritdoc IConsensusRecommendationReceipt
    address public immutable gateway;

    /// @inheritdoc IConsensusRecommendationReceipt
    address public immutable icPolicy;

    /// @dev Append-only receipt log.
    Receipt[] private _receipts;

    /// @dev `receiptId` → 1-based index into `_receipts` (0 means absent).
    mapping(bytes32 => uint256) private _indexPlusOne;

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param admin_     Address granted `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.
    ///                   In every non-test deployment this is the
    ///                   `TimelockController` (INV-3).
    /// @param gateway_   Deployed `RobotMoneyGateway`; sole permitted writer.
    /// @param icPolicy_  Deployed `InvestmentCommitteePolicy`; the single source
    ///                   of `COMMITTEE_AGENT_ROLE` membership.
    constructor(address admin_, address gateway_, address icPolicy_) {
        if (admin_ == address(0) || gateway_ == address(0) || icPolicy_ == address(0)) {
            revert ZeroAddress();
        }
        gateway = gateway_;
        icPolicy = icPolicy_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
    }

    // ─── Modifiers ───────────────────────────────────────────────────────────

    /// @dev Reverts unless `msg.sender` is the registered RobotMoneyGateway.
    modifier onlyGateway() {
        if (msg.sender != gateway) revert CallerNotGateway();
        _;
    }

    // ─── Write surface ───────────────────────────────────────────────────────

    /// @inheritdoc IConsensusRecommendationReceipt
    function recordReceipt(
        address submitter,
        bytes32 receiptId,
        bytes32 payloadDigest,
        string calldata payloadUri
    ) external onlyGateway nonReentrant returns (uint256 index) {
        if (!IAccessControl(icPolicy).hasRole(COMMITTEE_AGENT_ROLE, submitter)) {
            revert SubmitterNotAllowlisted();
        }
        if (receiptId == bytes32(0)) revert EmptyReceiptId();
        if (payloadDigest == bytes32(0)) revert EmptyPayloadDigest();
        if (bytes(payloadUri).length == 0) revert EmptyPayloadUri();
        if (_indexPlusOne[receiptId] != 0) revert ReceiptAlreadyRecorded();

        uint64 recordedAt = uint64(block.timestamp);
        index = _receipts.length;
        _receipts.push(
            Receipt({
                receiptId: receiptId,
                payloadDigest: payloadDigest,
                payloadUri: payloadUri,
                submitter: submitter,
                recordedAt: recordedAt,
                releasedAt: 0,
                released: false
            })
        );
        _indexPlusOne[receiptId] = index + 1;

        emit ReceiptRecorded(receiptId, submitter, index, payloadDigest, payloadUri, recordedAt);
    }

    /// @inheritdoc IConsensusRecommendationReceipt
    function releaseReceipt(bytes32 receiptId) external onlyRole(ADMIN_ROLE) nonReentrant {
        uint256 slot = _indexPlusOne[receiptId];
        if (slot == 0) revert ReceiptNotFound();

        Receipt storage r = _receipts[slot - 1];
        if (r.released) revert ReceiptAlreadyReleased();

        uint64 releasedAt = uint64(block.timestamp);
        r.released = true;
        r.releasedAt = releasedAt;

        emit ReceiptReleased(receiptId, msg.sender, releasedAt);
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @inheritdoc IConsensusRecommendationReceipt
    function receiptCount() external view returns (uint256) {
        return _receipts.length;
    }

    /// @inheritdoc IConsensusRecommendationReceipt
    function getReceipt(uint256 index) external view returns (Receipt memory) {
        return _receipts[index];
    }

    /// @inheritdoc IConsensusRecommendationReceipt
    function getReceiptById(bytes32 receiptId) external view returns (Receipt memory) {
        uint256 slot = _indexPlusOne[receiptId];
        if (slot == 0) revert ReceiptNotFound();
        return _receipts[slot - 1];
    }

    /// @inheritdoc IConsensusRecommendationReceipt
    function isRecorded(bytes32 receiptId) external view returns (bool) {
        return _indexPlusOne[receiptId] != 0;
    }

    /// @inheritdoc IConsensusRecommendationReceipt
    function isReleased(bytes32 receiptId) external view returns (bool) {
        uint256 slot = _indexPlusOne[receiptId];
        if (slot == 0) return false;
        return _receipts[slot - 1].released;
    }

    /// @inheritdoc IConsensusRecommendationReceipt
    function computeReceiptId(string calldata sessionId, string calldata subjectId)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(RECEIPT_ID_DOMAIN, sessionId, "\n", subjectId));
    }

    // ─── Signalling-only boundary (issue #1247 AC1) ──────────────────────────
    //
    // This contract has NO treasury-spend function, NO router-weight setter, NO
    // `receive` and NO `fallback`. It holds no ERC-20 balance and cannot call
    // `RouterGovernance.execute()`, `PortfolioRouter.setWeights()` or
    // `RobotMoneyGateway.deposit()`. Verified by
    // ConsensusRecommendationReceiptTest.testSignallingOnlyBoundary.
}
