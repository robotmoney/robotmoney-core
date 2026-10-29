// SPDX-License-Identifier: MIT
// Canonical: docs/technical/governance-decisions.md §3 — the Safe applies consensus receipts through the weight setter
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Implements: issue #1698 — the weight setter applies a consensus receipt in one call; voting deleted
// Implements: issue #1831 — applyReceipt is monotonic in the receipt's recordedAt
pragma solidity ^0.8.24;

import {AdminFloorAccessControl} from "./lib/AdminFloorAccessControl.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {GovernedUUPS} from "./lib/GovernedUUPS.sol";
import {PortfolioRouter} from "./PortfolioRouter.sol";
import {IConsensusRecommendationReceipt} from "./interfaces/IConsensusRecommendationReceipt.sol";

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
///         Released is not applied (security review 2026-10-15, finding 023): a
///         receipt released outside `applyReceipt` carries no weights, and
///         `applyReceipt` refuses it forever (`ReceiptAlreadyReleased`); the committee must
///         record a new receipt. This contract holds only the register's narrow
///         `RECEIPT_RELEASER_ROLE`. The timelock holds the register's `ADMIN_ROLE` alone
///         and releases nothing directly. Read `ReceiptApplied` to learn what was applied.
///
///         Design constraints (docs/architecture.md §2.3):
///         - Controls router weights only; cannot govern vault internals,
///           agent permissions, or protocol admin operations.
///         - No token, no minting, no wrapping (§6.6 of the decision record).
///
///         `ADMIN_ROLE` (the timelock) keeps one router fallback:
///         `setDefaultWeights`. Nothing here clears or resets the router's
///         applied vector: a bad vector is replaced by a newer receipt through
///         `applyReceipt` (issue 1988, ADR-0002).
///
/// Emits: `ReceiptApplied`.
///
/// Runs behind its own ERC-1967 proxy (issue 1808): `initialize` replaces the constructor,
/// the implementation is locked, and only `upgradeTimelock()` can upgrade or freeze it
/// (`GovernedUUPS`). This contract's own roles (ADMIN_ROLE, WEIGHT_SETTER_ROLE) carry no
/// upgrade power, here or on any other proxy. `router` and `receipts` are set once at
/// initialization and have no setter.
contract RouterGovernance is AdminFloorAccessControl, ReentrancyGuardUpgradeable, GovernedUUPS {
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
    PortfolioRouter public router;

    /// @notice The ConsensusRecommendationReceipt register whose receipts this
    ///         contract applies. This contract holds the narrow
    ///         `RECEIPT_RELEASER_ROLE` there (never its `ADMIN_ROLE`) so it can
    ///         release a receipt in the same call that applies it.
    IConsensusRecommendationReceipt public receipts;

    /// @notice The `recordedAt` of the last receipt `applyReceipt` applied (0 until
    ///         the first). `applyReceipt` refuses any receipt not recorded strictly
    ///         later, so two ready apply operations executed out of order cannot
    ///         make the older receipt's vector the active one (issue 1831).
    ///         Appended after `receipts`: the compiler packs it into the unused
    ///         bytes 20..27 of slot 1, which earlier code never wrote, so the
    ///         layout stays append-only and an upgraded proxy reads 0 here.
    uint64 public lastAppliedRecordedAt;

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

    /// @notice `receiptId` is already released: applied earlier, or released
    ///         directly by the timelock without weights. Either way it can never
    ///         be applied (again).
    error ReceiptAlreadyReleased(bytes32 receiptId);

    /// @notice The call named `given`, but the receipt's stored digest is `stored`.
    error PayloadDigestMismatch(bytes32 receiptId, bytes32 stored, bytes32 given);

    /// @notice `receiptId` was recorded at `recordedAt`, which is not later than
    ///         `lastApplied`, the `recordedAt` of the receipt already applied.
    error ReceiptNotNewerThanApplied(bytes32 receiptId, uint64 recordedAt, uint64 lastApplied);

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @notice Atomic proxy initialization (the ERC1967Proxy constructor calls it).
    /// @param _router   Portfolio Router whose weights this contract sets.
    /// @param _receipts ConsensusRecommendationReceipt register.
    /// @param _admin    Receives `ADMIN_ROLE` and `WEIGHT_SETTER_ROLE`. The deploy
    ///                  is the deployer; the timelock stage hands both to the
    ///                  `TimelockController` and drops the deployer's copies.
    /// @param upgradeTimelock_ The Safe-controlled timelock: the only upgrade and freeze authority.
    /// @param upgradeMode_ The release mode. `Undeclared` reverts.
    function initialize(
        address _router,
        address _receipts,
        address _admin,
        address upgradeTimelock_,
        UpgradeMode upgradeMode_
    ) external initializer {
        __AccessControlEnumerable_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
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
    ///         Reverts unless the receipt is recorded, is not released, its
    ///         stored digest equals `payloadDigest`, and it was recorded strictly
    ///         later than the last applied receipt (`lastAppliedRecordedAt`).
    ///         An older receipt executed after a newer one therefore reverts and
    ///         stays unreleased, and the newer vector stays active. The router then refuses a
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
        uint64 last = lastAppliedRecordedAt;
        if (r.recordedAt <= last) revert ReceiptNotNewerThanApplied(receiptId, r.recordedAt, last);
        lastAppliedRecordedAt = r.recordedAt;

        receipts.releaseReceipt(receiptId);
        router.setWeights(vaults, bps);

        emit ReceiptApplied(receiptId, payloadDigest, vaults, bps);
    }

    // slither-disable-end reentrancy-events

    // ─── Admin: router fallback ──────────────────────────────────────────────

    /// @notice Set the router's default (fallback) weight vector, forwarding to
    ///         `PortfolioRouter.setDefaultWeights`. The router routes by it
    ///         until the first receipt is applied.
    ///         `ADMIN_ROLE` only (Safe -> Timelock -> ADMIN_ROLE). ADR-0002.
    /// @param vaults Ordered vault address list.
    /// @param bps    Parallel weight array (must sum to 10 000).
    function setDefaultWeights(address[] calldata vaults, uint256[] calldata bps)
        external
        onlyRole(ADMIN_ROLE)
    {
        router.setDefaultWeights(vaults, bps);
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
