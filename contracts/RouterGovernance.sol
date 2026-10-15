// SPDX-License-Identifier: MIT
// Canonical: docs/technical/governance-decisions.md §3 — the Safe applies consensus receipts through the weight setter
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Implements: issue #1698 — the weight setter applies a consensus receipt in one call; voting deleted
pragma solidity ^0.8.24;

import {AdminFloorAccessControl} from "./lib/AdminFloorAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PortfolioRouter} from "./PortfolioRouter.sol";
import {
    IConsensusRecommendationReceipt
} from "./gateway/interfaces/IConsensusRecommendationReceipt.sol";

/// @title RouterGovernance
/// @notice The router's weight setter. It holds the Portfolio Router's
///         `WEIGHT_SETTER_ROLE` (the only gate on `setWeights`) and moves the
///         active weight vector in exactly one way: `applyReceipt`, which
///         releases a recorded Investment Committee consensus receipt and sets
///         the receipt's weight vector in the same call.
///
///         `applyReceipt` is gated by this contract's own `WEIGHT_SETTER_ROLE`,
///         held by the `TimelockController`. The Safe is the timelock's only
///         proposer, so a receipt is applied only when the Safe schedules the
///         call, the timelock delay passes and the call executes. There is no
///         voting by anyone: no voter set, no voting power, no quorum, no voting
///         period, no proposal. The voting functions this contract carried
///         through the MVP were deleted (issue 1698) because nothing used them
///         and every one of them was attack surface on the weight path
///         (security review 2026-10-12 finding 4: one voter met quorum).
///
///         Payload-digest binding (docs/technical/governance-decisions.md §3.7):
///         a receipt's `payloadDigest` commits to the canonical receipt bytes,
///         which the EVM cannot parse into a router vector. The scheduled call
///         therefore names the digest it was built from; `applyReceipt` reverts
///         unless it equals the stored digest, and `ReceiptApplied` records the
///         digest and the vector together so anyone can re-derive the vector
///         from the public payload and compare.
///
///         Design constraints (docs/architecture.md §2.3):
///         - Controls router weights only; cannot govern vault internals,
///           agent permissions, or protocol admin operations.
///         - No token, no minting, no wrapping (§6.6 of the decision record).
///
///         `ADMIN_ROLE` (the timelock) keeps the two router fallbacks:
///         `setDefaultWeights` and the emergency `clearVotedWeights`.
///
/// Emits: `ReceiptApplied`.
contract RouterGovernance is AdminFloorAccessControl, ReentrancyGuard {
    // ─── Roles ───────────────────────────────────────────────────────────────

    /// @notice Sets the router's default weights and clears the active vector.
    ///         Held by the `TimelockController` after the deploy handover.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice The only role that can call `applyReceipt`. Held by the
    ///         `TimelockController` after the deploy handover. Self-administered,
    ///         so no `ADMIN_ROLE` holder can grant it.
    bytes32 public constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @notice The Portfolio Router whose `setWeights` `applyReceipt` calls.
    PortfolioRouter public immutable router;

    /// @notice The ConsensusRecommendationReceipt register whose receipts this
    ///         contract applies. This contract holds `ADMIN_ROLE` there so it
    ///         can release a receipt in the same call that applies it.
    IConsensusRecommendationReceipt public immutable receipts;

    // ─── Events ──────────────────────────────────────────────────────────────

    /// @notice A recorded receipt was released and its vector set on the router.
    /// @param receiptId     The applied receipt.
    /// @param payloadDigest The receipt's stored digest, which the call named.
    /// @param vaults        The vault list set on the router.
    /// @param bps           The weights set on the router (parallel to vaults).
    event ReceiptApplied(
        bytes32 indexed receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps
    );

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();

    /// @notice `receiptId` was never recorded on the receipt register.
    error ReceiptNotRecorded(bytes32 receiptId);

    /// @notice `receiptId` is already released, so it was already applied.
    error ReceiptAlreadyReleased(bytes32 receiptId);

    /// @notice The call named `given`, but the receipt's stored digest is `stored`.
    error PayloadDigestMismatch(bytes32 receiptId, bytes32 stored, bytes32 given);

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param _router   Portfolio Router whose weights this contract sets.
    /// @param _receipts ConsensusRecommendationReceipt register.
    /// @param _admin    Receives `ADMIN_ROLE` and `WEIGHT_SETTER_ROLE`. The deploy
    ///                  is the deployer; the timelock stage hands both to the
    ///                  `TimelockController` and drops the deployer's copies.
    constructor(address _router, address _receipts, address _admin) {
        if (_router == address(0) || _receipts == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        router = PortfolioRouter(_router);
        receipts = IConsensusRecommendationReceipt(_receipts);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, _admin);
        _setRoleAdmin(WEIGHT_SETTER_ROLE, WEIGHT_SETTER_ROLE);
        _grantRole(WEIGHT_SETTER_ROLE, _admin);
    }

    // ─── Weight setter: apply a consensus receipt ────────────────────────────

    /// @notice Release `receiptId` and set its weight vector on the router, in
    ///         one call. `WEIGHT_SETTER_ROLE` only (the timelock).
    ///
    ///         Reverts unless the receipt is recorded, is not released, and its
    ///         stored digest equals `payloadDigest`. The router then refuses a
    ///         vector whose lengths differ, whose bps do not sum to 10 000, that
    ///         names a vault twice, or that names a vault that is not
    ///         router-eligible and Active. Any refusal reverts the whole call, so
    ///         a released receipt whose vector was not set cannot exist.
    /// @param receiptId     The recorded receipt to apply.
    /// @param payloadDigest The digest of the payload the vector was derived from.
    /// @param vaults        Ordered vault list.
    /// @param bps           Parallel weights in basis points.
    // slither-disable-start reentrancy-events
    // `applyReceipt` is `nonReentrant` and both external calls go to deploy-time
    // immutable contracts; the event follows them so it records what landed.
    function applyReceipt(
        bytes32 receiptId,
        bytes32 payloadDigest,
        address[] calldata vaults,
        uint256[] calldata bps
    ) external onlyRole(WEIGHT_SETTER_ROLE) nonReentrant {
        if (!receipts.isRecorded(receiptId)) {
            revert ReceiptNotRecorded(receiptId);
        }
        IConsensusRecommendationReceipt.Receipt memory r = receipts.getReceiptById(receiptId);
        if (r.released) revert ReceiptAlreadyReleased(receiptId);
        if (r.payloadDigest != payloadDigest) {
            revert PayloadDigestMismatch(receiptId, r.payloadDigest, payloadDigest);
        }

        receipts.releaseReceipt(receiptId);
        router.setWeights(vaults, bps);

        emit ReceiptApplied(receiptId, payloadDigest, vaults, bps);
    }

    // slither-disable-end reentrancy-events

    // ─── Admin: router fallbacks ─────────────────────────────────────────────

    /// @notice Set the router's default (fallback) weight vector, forwarding to
    ///         `PortfolioRouter.setDefaultWeights`. The router routes by it
    ///         until a receipt is applied, and again after `clearVotedWeights`.
    ///         `ADMIN_ROLE` only (Safe -> Timelock -> ADMIN_ROLE). ADR-0002.
    /// @param vaults Ordered vault address list.
    /// @param bps    Parallel weight array (must sum to 10 000).
    function setDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
        external
        onlyRole(ADMIN_ROLE)
    {
        router.setDefaultWeights(vaults, bps);
    }

    /// @notice Clear the router's active weight vector so routing falls back to
    ///         the default vector. The emergency lever. `ADMIN_ROLE` only. ADR-0002.
    function clearVotedWeights() external onlyRole(ADMIN_ROLE) {
        router.clearVotedWeights();
    }

    // ─── Read surface ────────────────────────────────────────────────────────

    /// @notice The router's active weight vector (empty until a receipt is applied).
    function currentWeights()
        external
        view
        returns (address[] memory vaults, uint256[] memory bps)
    {
        return router.getWeights();
    }
}
