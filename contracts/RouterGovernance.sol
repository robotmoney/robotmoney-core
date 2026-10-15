// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Canonical: docs/technical/governance-decisions.md §3.2, §3.6, §3.7 — a receipt is applied, not voted on
// Implements: issue #1698 — the weight setter applies a consensus receipt in one call; voting deleted
// Implements: issue #309, issue #496 (router-weight authority lives behind the Safe and the timelock)
pragma solidity ^0.8.24;

import {AdminFloorAccessControl} from "./lib/AdminFloorAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PortfolioRouter} from "./PortfolioRouter.sol";
import {
    IConsensusRecommendationReceipt
} from "./gateway/interfaces/IConsensusRecommendationReceipt.sol";
import {BpsMath} from "./lib/BpsMath.sol";

/// @title RouterGovernance
/// @notice The weight setter of the Portfolio Router. It holds the router's
///         `WEIGHT_SETTER_ROLE` (and `ADMIN_ROLE`) and acts only on a
///         Safe-scheduled timelock operation: `ADMIN_ROLE` here is held by the
///         `TimelockController` after the stage 11 handover.
///
///         There is no voting. The Investment Committee records a consensus
///         receipt on `ConsensusRecommendationReceipt`; when the Safe decides
///         to act on it, it schedules ONE call, `applyReceipt`, which releases
///         the receipt and writes its weight vector to the router in the same
///         transaction. So `applyReceipt` never leaves applied weights whose
///         receipt is unreleased, nor a receipt it released without weights.
///         The timelock ALSO holds the register's `ADMIN_ROLE` and can release a
///         receipt directly (the standalone `release-receipt` govern row, issue
///         1611). A receipt released that way carries no weights, and
///         `applyReceipt` refuses it forever (`ReceiptAlreadyReleased`): the
///         committee must record a new receipt (governance-decisions.md §3.2,
///         §3.7). "Released" therefore does not mean "applied"; read
///         `ReceiptApplied` for that. The propose/vote/execute path, the
///         voter set, voting power, quorum, voting period and execution delay
///         were deleted by issue #1698: nobody held the voter keys, and one
///         voter met the example quorum (security review 2026-10-12 finding 4).
///
///         Design constraints (docs/architecture.md §2.3):
///         - Controls router weights only; cannot govern vault internals,
///           agent permissions, or protocol admin operations.
///         - Replaced, never upgraded: a new weight setter is rotated in through
///           `PortfolioRouter.proposeWeightSetterRotation` (ADR-0002).
///
/// Boundary note (issue #942): the unified governance `retire()` (DI-2,
/// decision #925; docs/architecture.md §4.7) does NOT belong here. `retire()`
/// is a TimelockController-gated registry/vault action (`VaultRegistry.retire`),
/// not a router-weight change. Dropping a retired vault to 0 bps is an ordinary
/// receipt application, requiring NO new code in this contract.
///
/// Emits: `ReceiptContractSet`, `ReceiptApplied`.
contract RouterGovernance is AdminFloorAccessControl, ReentrancyGuard {
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Applies receipts and sets the default vector. Held by the
    ///         `TimelockController` after the stage 11 handover (INV-3).
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Basis-points denominator (10 000 = 100%). Sourced from the
    ///         shared `BpsMath.BPS_DENOMINATOR` so weight-sum math cannot drift.
    uint256 public constant BPS_DENOMINATOR = BpsMath.BPS_DENOMINATOR;

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @notice The Portfolio Router whose `setWeights` is called on application.
    PortfolioRouter public immutable router;

    /// @notice The receipt register `applyReceipt` releases from. Set by stage
    ///         11 (`DeployTimelock`) once `ConsensusRecommendationReceipt` exists
    ///         (it is deployed after this contract, in the ic-policy stage).
    ///         Zero until then, and `applyReceipt` refuses while it is zero.
    IConsensusRecommendationReceipt public receiptContract;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice Emitted when the receipt register is set.
    /// @param oldReceipt The previous register (zero on first set).
    /// @param newReceipt The register `applyReceipt` releases from now.
    event ReceiptContractSet(address indexed oldReceipt, address indexed newReceipt);

    /// @notice Emitted when a receipt is applied: released and its vector written
    ///         to the router in one transaction.
    /// @param receiptId     The applied receipt.
    /// @param payloadDigest The receipt's stored payload digest, as the call named it.
    /// @param vaults        New vault address list.
    /// @param bps           New weight bps list (parallel to vaults).
    event ReceiptApplied(
        bytes32 indexed receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps
    );

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    /// @notice `applyReceipt` was called before stage 11 set the receipt register.
    error ReceiptContractNotSet();
    /// @notice `setReceiptContract` was given an address with no code.
    error ReceiptContractNotContract(address receipt);
    /// @notice The receipt id was never recorded on the register.
    error ReceiptNotRecorded(bytes32 receiptId);
    /// @notice The receipt was already released: one operation per receipt. Raised both for an
    ///         earlier `applyReceipt` and for a standalone timelock `releaseReceipt`; a receipt
    ///         released either way can never be applied.
    error ReceiptAlreadyReleased(bytes32 receiptId);
    /// @notice The digest the call named is not the digest the receipt stored.
    /// @param receiptId The receipt.
    /// @param expected  The digest in the scheduled calldata.
    /// @param stored    The digest the committee submitter recorded.
    error ReceiptDigestMismatch(bytes32 receiptId, bytes32 expected, bytes32 stored);

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param _router Portfolio Router whose weights this contract controls.
    /// @param _admin  Address that receives ADMIN_ROLE (the deployer until stage 11).
    constructor(address _router, address _admin) {
        if (_router == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        router = PortfolioRouter(_router);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, _admin);

        // Operational note: only this contract (reached through Safe → Timelock)
        // should hold WEIGHT_SETTER_ROLE on the Portfolio Router. If that role
        // is held elsewhere, setWeights bypasses the receipt path entirely.
    }

    // ─── Admin: receipt register ─────────────────────────────────────────────

    /// @notice Set the receipt register `applyReceipt` releases from. Restricted
    ///         to ADMIN_ROLE. Stage 11 calls it with the deployed
    ///         `ConsensusRecommendationReceipt` before handing ADMIN_ROLE to the
    ///         timelock; afterwards only a Safe-scheduled timelock operation can
    ///         change it. This contract must hold `ADMIN_ROLE` on the register
    ///         (its `releaseReceipt` gate); stage 11 grants that too.
    /// @param receipt_ The deployed `ConsensusRecommendationReceipt`.
    function setReceiptContract(address receipt_) external onlyRole(ADMIN_ROLE) {
        if (receipt_ == address(0)) revert ZeroAddress();
        if (receipt_.code.length == 0) revert ReceiptContractNotContract(receipt_);
        emit ReceiptContractSet(address(receiptContract), receipt_);
        receiptContract = IConsensusRecommendationReceipt(receipt_);
    }

    // ─── Admin: apply a consensus receipt ────────────────────────────────────

    /// @notice Apply one consensus receipt: release it on the register and write
    ///         its weight vector to the router, atomically. Restricted to
    ///         ADMIN_ROLE (the timelock), so the Safe applies a receipt by
    ///         scheduling and executing this one call. This is the rebalance.
    ///
    ///         Refuses a receipt that is not recorded, one that is already
    ///         released, and a `payloadDigest` that differs from the digest the
    ///         committee submitter recorded. The vector itself is validated by
    ///         the router (`setWeights`: every vault router-eligible AND Active,
    ///         no duplicate vault, bps sum == BPS_DENOMINATOR), so a vector the
    ///         router would not route by releases nothing.
    ///
    ///         Digest binding (governance-decisions.md §3.7): the register stores
    ///         `keccak256` of the receipt's canonical bytes, which the chain
    ///         cannot parse into a vector. The scheduled calldata therefore
    ///         names the digest beside the vector, and the chain checks the
    ///         digest against the register; the vector-to-payload equality is
    ///         checked by the govern tool before scheduling and attested by the
    ///         Safe signatures over this calldata.
    /// @param receiptId     The receipt to apply.
    /// @param payloadDigest The receipt's payload digest, as recorded.
    /// @param vaults        Ordered vault address list.
    /// @param bps           Parallel weight array; must sum to BPS_DENOMINATOR.
    // slither-disable-start reentrancy-events
    // `applyReceipt()` is `nonReentrant`; the event emission follows the guarded
    // register and router calls and the detector is a false positive here.
    function applyReceipt(
        bytes32 receiptId,
        bytes32 payloadDigest,
        address[] calldata vaults,
        uint256[] calldata bps
    ) external onlyRole(ADMIN_ROLE) nonReentrant {
        IConsensusRecommendationReceipt register = receiptContract;
        if (address(register) == address(0)) revert ReceiptContractNotSet();
        if (!register.isRecorded(receiptId)) revert ReceiptNotRecorded(receiptId);
        if (register.isReleased(receiptId)) revert ReceiptAlreadyReleased(receiptId);
        bytes32 stored = register.getReceiptById(receiptId).payloadDigest;
        if (stored != payloadDigest) {
            revert ReceiptDigestMismatch(receiptId, payloadDigest, stored);
        }

        // Release first, then the weights: both revert together, so neither
        // half can land without the other.
        register.releaseReceipt(receiptId);
        router.setWeights(vaults, bps);

        emit ReceiptApplied(receiptId, payloadDigest, vaults, bps);
    }

    // slither-disable-end reentrancy-events

    // ─── Admin: default (fallback) weights ───────────────────────────────────

    /// @notice Set the router's default (fallback) weight vector, forwarding to
    ///         `PortfolioRouter.setDefaultWeights`. This is the on-chain vector
    ///         the router routes by — and the public allocation surface renders
    ///         — whenever no applied receipt vector is active. An applied
    ///         receipt overrides it; the default itself stays put as the
    ///         fallback. Restricted to ADMIN_ROLE (Safe -> Timelock -> ADMIN_ROLE).
    ///         ADR-0002.
    ///
    ///         The router enforces: ADMIN_ROLE on the router (this contract must
    ///         hold it), bps sum == BPS_DENOMINATOR, no duplicate vault, and
    ///         length == the registry's router-eligible vault count.
    /// @param vaults Ordered vault address list.
    /// @param bps    Parallel weight array (must sum to BPS_DENOMINATOR).
    function setDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
        external
        onlyRole(ADMIN_ROLE)
    {
        router.setDefaultWeights(vaults, bps);
    }

    /// @notice Clear the router's applied (voted) weight vector and revert
    ///         routing to the default vector. The emergency lever: a receipt
    ///         vector that should no longer route is cleared here, through the
    ///         timelock. Restricted to ADMIN_ROLE. ADR-0002.
    function clearVotedWeights() external onlyRole(ADMIN_ROLE) {
        router.clearVotedWeights();
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice Return the current Portfolio Router weight vector directly.
    function currentWeights()
        external
        view
        returns (address[] memory vaults, uint256[] memory bps)
    {
        return router.getWeights();
    }
}
