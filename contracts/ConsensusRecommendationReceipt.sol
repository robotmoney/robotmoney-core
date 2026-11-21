// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
// Canonical: docs/product/20260623-product-proposal-investment-committee-v0.md §2.1
// Canonical: docs/architecture.md §4.8 — Receipt Submitter Authority
// Implements: issue #1247 — (fusion) anchor the receipt on chain
pragma solidity ^0.8.24;

import {AdminFloorAccessControl} from "./lib/AdminFloorAccessControl.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {GovernedUUPS, GovernedUpgrade} from "./lib/GovernedUUPS.sol";

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
/// - **The receipt owns its roles.** There is no committee registry and no gateway
///   route. Submitters hold `RECEIPT_SUBMITTER_ROLE` on this contract and call
///   `recordReceipt` directly. The submitter is `msg.sender`.
/// - `ADMIN_ROLE` is held by the `TimelockController` alone (INV-3). It administers
///   `RECEIPT_SUBMITTER_ROLE` and `RECEIPT_RELEASER_ROLE`. RouterGovernance holds only
///   the narrow `RECEIPT_RELEASER_ROLE`.
///
/// Payload contract: `tests/fixtures/consensus-receipt.schema.json` and
/// `consensus-receipt.canonicalization.json`, byte-identical to
/// `contract/src/__fixtures__/` in `robotmoney-frontend`.
///
/// Emits: `ReceiptRecorded`, `ReceiptReleased`.
///
/// Runs behind its own ERC-1967 proxy (issue 1808): `initialize` replaces the constructor,
/// the implementation is locked, and only `upgradeTimelock()` can upgrade or freeze it
/// (`GovernedUUPS`). `_retiredWriterSlot` (slot 0) and `icPolicy` are retired storage slots: they are kept so the
/// proxy layout never changes, they are never written again and nothing reads them.
contract ConsensusRecommendationReceipt is
    AdminFloorAccessControl,
    ReentrancyGuardUpgradeable,
    GovernedUUPS,
    IConsensusRecommendationReceipt
{
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Administers the two receipt roles below. Held by the `TimelockController`
    ///         alone (INV-3). RouterGovernance does not hold it.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice May call `recordReceipt`. Granted and revoked only by `ADMIN_ROLE`.
    bytes32 public constant RECEIPT_SUBMITTER_ROLE = keccak256("RECEIPT_SUBMITTER_ROLE");

    /// @notice May call `releaseReceipt`. Held by RouterGovernance, whose `applyReceipt`
    ///         releases a receipt in the same call that sets its weights (issue 1698).
    ///         It is a single-purpose role: it cannot grant or revoke any role.
    bytes32 public constant RECEIPT_RELEASER_ROLE = keccak256("RECEIPT_RELEASER_ROLE");

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Domain separator for the receipt-id preimage, pinned by
    ///         `consensus-receipt.canonicalization.json#receipt_id_derivation`.
    string internal constant RECEIPT_ID_DOMAIN = "robotmoney:consensus-receipt-id:v1\n";

    // ─── State ───────────────────────────────────────────────────────────────

    /// @dev Retired slot 0. Formerly the only permitted writer (it held the gateway address). Never written, never read.
    ///      It stays so the proxy layout never changes (ADR-0014). The public getter is gone: the vaults system names no
    ///      gateway (SYS-1, issue 1906). The ABI drops the retired getter and the storage-layout gate records the rename.
    address private _retiredWriterSlot;

    /// @notice Retired slot. Formerly the committee role source. Never written, never read.
    address public icPolicy;

    /// @dev Append-only receipt log.
    Receipt[] private _receipts;

    /// @dev `receiptId` → 1-based index into `_receipts` (0 means absent).
    mapping(bytes32 => uint256) private _indexPlusOne;

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @notice Atomic proxy initialization (the ERC1967Proxy constructor calls it).
    /// @param admin_     Address granted `DEFAULT_ADMIN_ROLE` and `ADMIN_ROLE`.
    ///                   In every non-test deployment this is the
    ///                   `TimelockController` (INV-3).
    /// @param upgradeTimelock_ The Safe-controlled timelock: the only upgrade and freeze authority.
    /// @param upgradeMode_ The release mode. `Undeclared` reverts.
    function initialize(address admin_, address upgradeTimelock_, UpgradeMode upgradeMode_)
        external
        initializer
    {
        __AccessControlEnumerable_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
        if (admin_ == address(0)) revert ZeroAddress();

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        _setRoleAdmin(RECEIPT_SUBMITTER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(RECEIPT_RELEASER_ROLE, ADMIN_ROLE);
    }

    /// @notice One-time migration for a live proxy created before the receipt owned its roles.
    ///         Run it through the timelock's `upgradeToAndCall`. It wires the role admins,
    ///         grants `releaser` the narrow release role and removes `ADMIN_ROLE` from it if
    ///         it held that role. Receipts, slots and every other role are untouched.
    /// @param releaser RouterGovernance.
    function migrateToSubmitterRoles(address releaser) external reinitializer(2) {
        if (msg.sender != GovernedUpgrade.layout().upgradeTimelock) {
            revert MigrationCallerNotTimelock();
        }
        if (releaser == address(0)) revert ZeroAddress();
        _setRoleAdmin(RECEIPT_SUBMITTER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(RECEIPT_RELEASER_ROLE, ADMIN_ROLE);
        _grantRole(RECEIPT_RELEASER_ROLE, releaser);
        if (hasRole(ADMIN_ROLE, releaser)) _revokeRole(ADMIN_ROLE, releaser);
    }

    /// @dev Last-admin floor for `DEFAULT_ADMIN_ROLE` (ADMIN_ROLE is covered by
    ///      `AdminFloorAccessControl`). Both `revokeRole` and `renounceRole`
    ///      route here, so the timelock cannot lock itself out (#1447, L).
    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && hasRole(role, account) && getRoleMemberCount(role) == 1) {
            revert LastAdminFloor();
        }
        return super._revokeRole(role, account);
    }

    // ─── Write surface ───────────────────────────────────────────────────────

    /// @inheritdoc IConsensusRecommendationReceipt
    function recordReceipt(bytes32 receiptId, bytes32 payloadDigest, string calldata payloadUri)
        external
        nonReentrant
        returns (uint256 index)
    {
        address submitter = msg.sender;
        if (!hasRole(RECEIPT_SUBMITTER_ROLE, submitter)) revert SubmitterNotAllowlisted();
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
    function releaseReceipt(bytes32 receiptId)
        external
        onlyRole(RECEIPT_RELEASER_ROLE)
        nonReentrant
    {
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
    // `RouterGovernance.applyReceipt()`, `PortfolioRouter.setWeights()` or
    // `RobotMoneyGateway.deposit()`. Verified by
    // ConsensusRecommendationReceiptTest.testSignallingOnlyBoundary. The
    // weight setter calls `releaseReceipt` (it holds `RECEIPT_RELEASER_ROLE` here), never
    // the other way round.
}
