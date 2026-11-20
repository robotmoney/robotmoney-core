// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md (a reinitializer runs inside `upgradeToAndCall`);
//            docs/technical/one-vault-timed-flows-eng-plan.md §3.1 (FlowQueue state), E8, E13, E17, E24
pragma solidity ^0.8.24;

import {
    Claim,
    FlowParams,
    IFlowEvents,
    Request,
    RequestKind,
    Settlement,
    MIN_CANCEL_BUFFER,
    MAX_CANCEL_BUFFER,
    MIN_MAX_PAUSE,
    MAX_PAUSE_DURATION,
    TIMELOCK_DELAY_REFERENCE
} from "../FlowTypes.sol";
import {FlowState} from "./FlowStorage.sol";
import {GovernedUpgrade} from "./GovernedUUPS.sol";

/// @title FlowMigrateLib
/// @notice The one-time state migration of a `FlowQueue` proxy upgraded in place from contracts 0.8.0 to 0.9.0. It is
///         the body of `FlowQueue.migrateV090`, a `reinitializer(2)` the upgrade timelock passes as the data of
///         `upgradeToAndCall`, so the new code never runs on unmigrated state. A queue deployed at 0.9.0 never needs
///         it (`initialize` writes everything below).
///
///         What 0.9.0 changed under an existing proxy, and what this does about it:
///
///         1. `Request` and `Settlement` changed in the middle of the struct (the top-level `FlowState` only grew at
///            its end). Layouts, slot offsets from the mapping entry:
///
///            | slot | 0.8.0 `Request`            | 0.9.0 `Request`                                                |
///            | 0    | owner, kind, epoch        | owner, kind, epoch                                             |
///            | 1    | amount                    | amount                                                         |
///            | 2    | remaining                 | remaining                                                      |
///            | 3    | limit (uint256)           | closed, exitFeeBps, minHold, maxRoll, createdAt, expiryEpoch   |
///            | 4    | closed (bool)             | expiresAt, noticeRound, era, enrolled                          |
///            | 5-9  | (none)                    | matchCycle, normBasis, entryCumScaled, entryUnmatchedFactor,   |
///            |      |                           | nextMatchId                                                    |
///
///            | slot | 0.8.0 `Settlement`                                   | 0.9.0 `Settlement`                  |
///            | 0    | time, settler                                        | time, settler                       |
///            | 1    | depositBoundPrice                                    | matchedShares                       |
///            | 2    | redeemBoundPrice                                     | matchedUsdc                         |
///            | 3    | usdcIn                                               | matchSharePrice                     |
///            | 4    | sharesMinted                                         | usdcIn                              |
///            | 5    | sharesBurned                                         | sharesMinted                        |
///            | 6    | usdcOut                                              | sharesBurned                        |
///            | 7    | frozenUntil (bytes 0-7), returnAllowed (byte 8),     | usdcOut                             |
///            |      | holdEndsAt (bytes 9-16)                              |                                     |
///            | 8    | (none)                                               | frozenUntil, freezeSetAt, holdEndsAt|
///
///            Every request `1..requestCount` and settlement `1..settlementCount` is rewritten into the 0.9.0 layout.
///            A member with no 0.8.0 meaning gets its neutral value (0; `era` stays 0, the era of an upgraded queue).
///            This is not only for the views: the per-epoch id lists are shared, so a 0.9.0 request made in an epoch
///            that holds 0.8.0 requests puts them in front of the round's enrollment and walk, which read `closed`,
///            `enrolled`, `era` and `expiryEpoch` of each.
///         2. 0.9.0 keeps deposit shares held for an owner in `ownerHeldShares`; 0.8.0 kept them in `queuedShares`.
///            Without a backfill a 0.8.0 deposit claim cannot be delivered (the subtraction underflows) and
///            `queuedSharesOf` leaves the shares out. The backfill adds every undelivered deposit share to its owner.
///         3. `cancelBuffer`, `maxPause` and `matchBandBps` are new `FlowParams` members and read 0, which ends a
///            pause at once and skips every match. They are written here, inside their bounds.
///         4. `oldestEpoch` was an epoch number and is now an index into `activeEpochs`; the walk cursors point into
///            0.8.0 lists. Both are reset.
///
///         A 0.8.0 request that is still open has no place in the 0.9.0 match pools, so the migration refuses to run
///         while any escrow is pending: cancel or settle it under 0.8.0 first.
library FlowMigrateLib {
    /// @notice The migration ran: counts of what it rewrote and the held deposit shares it assigned to their owners.
    event QueueMigratedV090(
        uint256 requests, uint256 settlements, uint256 claims, uint256 heldShares
    );
    /// @notice Request `requestId` was rewritten; `limit` is the 0.8.0 price limit, which 0.9.0 no longer stores.
    event LegacyRequestMigrated(uint256 indexed requestId, uint256 limit);
    /// @notice Settlement `settlementId` was rewritten; the two bound prices are 0.8.0 members 0.9.0 no longer stores.
    event LegacySettlementMigrated(
        uint256 indexed settlementId, uint256 depositBoundPrice, uint256 redeemBoundPrice
    );

    /// @notice Deposit USDC or redemption shares of a 0.8.0 request are still in escrow.
    error LegacyEscrowOpen(uint256 pendingUsdc, uint256 escrowShares);
    /// @notice The queue already holds 0.9.0 round state (`activeEpochs` is not empty).
    error QueueAlreadyActive(uint256 activeEpochs);
    /// @notice The queue already went through a wind-down under 0.9.0.
    error WindDownEraStarted(uint64 era);
    /// @notice Request `requestId` is not closed and still has escrow.
    error LegacyRequestOpen(uint256 requestId);
    /// @notice Request `requestId` does not have the 0.8.0 layout (it was made or already migrated under 0.9.0).
    error NotLegacyRequest(uint256 requestId);
    /// @notice Settlement `settlementId` does not have the 0.8.0 layout.
    error NotLegacySettlement(uint256 settlementId);
    /// @notice Settlement `settlementId` is frozen with in-kind returns allowed, a 0.8.0 exit 0.9.0 does not have.
    ///         Release the freeze under 0.8.0 first.
    error LegacyReturnAllowed(uint256 settlementId);
    /// @notice The undelivered deposit shares of all claims do not add up to `totalHeldShares`.
    error HeldSharesMismatch(uint256 claimsSum, uint256 totalHeldShares);

    /// @notice Body of `FlowQueue.migrateV090` (see the library note). Runs once, in the proxy's storage.
    /// @param cancelBuffer  `FlowParams.cancelBuffer` to write, in [MIN_CANCEL_BUFFER, MAX_CANCEL_BUFFER] and below
    ///                      `epochLength`.
    /// @param maxPause      `FlowParams.maxPause` to write, in [MIN_MAX_PAUSE, MAX_PAUSE_DURATION] and at least
    ///                      `TIMELOCK_DELAY_REFERENCE + epochLength`.
    /// @param matchBandBps  `FlowParams.matchBandBps` to write, in [1, `refBandBps`].
    function migrateV090(
        FlowState storage s,
        uint32 cancelBuffer,
        uint32 maxPause,
        uint16 matchBandBps
    ) public {
        // The caller of a DELEGATECALL chain is the proxy's caller. With `reinitializer(2)` on the entry point this
        // leaves one way in: the timelock's own `upgradeToAndCall` (or its direct call, once).
        if (msg.sender != GovernedUpgrade.layout().upgradeTimelock) {
            revert GovernedUpgrade.NotUpgradeTimelock(msg.sender);
        }
        if (s.totalPendingUsdc != 0 || s.totalEscrowShares != 0) {
            revert LegacyEscrowOpen(s.totalPendingUsdc, s.totalEscrowShares);
        }
        if (s.activeEpochs.length != 0) revert QueueAlreadyActive(s.activeEpochs.length);
        if (s.windDownEra != 0) revert WindDownEraStarted(s.windDownEra);

        uint256 nRequests = s.requestCount;
        for (uint256 id = 1; id <= nRequests; ++id) {
            _migrateRequest(s, id);
        }
        uint256 nSettlements = s.settlementCount;
        for (uint256 id = 1; id <= nSettlements; ++id) {
            _migrateSettlement(s, id);
        }

        // Every request is a 0.8.0 one (checked above), so every claim is too and no owner has a 0.9.0 held balance.
        uint256 nClaims = s.claimCount;
        uint256 held;
        for (uint256 id = 1; id <= nClaims; ++id) {
            Claim storage c = s.claims[id];
            if (c.kind == RequestKind.Deposit && c.claimed < c.shares) {
                uint256 rest = c.shares - c.claimed;
                s.ownerHeldShares[c.owner] += rest;
                held += rest;
            }
        }
        if (held != s.totalHeldShares) revert HeldSharesMismatch(held, s.totalHeldShares);

        // `checkFlowParams` checks the whole struct against the live fund, which an upgrade in progress may not pass
        // yet. Only the three new members are written, with their own bounds (fields 18 to 20 there).
        FlowParams storage p = s.params;
        if (
            cancelBuffer < MIN_CANCEL_BUFFER || cancelBuffer > MAX_CANCEL_BUFFER
                || cancelBuffer >= p.epochLength
        ) revert IFlowEvents.FlowParamOutOfBounds(18);
        if (
            maxPause < MIN_MAX_PAUSE || maxPause > MAX_PAUSE_DURATION
                || maxPause < uint256(TIMELOCK_DELAY_REFERENCE) + p.epochLength
        ) revert IFlowEvents.FlowParamOutOfBounds(19);
        if (matchBandBps == 0 || matchBandBps > p.refBandBps) {
            revert IFlowEvents.FlowParamOutOfBounds(20);
        }
        p.cancelBuffer = cancelBuffer;
        p.maxPause = maxPause;
        p.matchBandBps = matchBandBps;
        emit IFlowEvents.FlowParamsSet(p);

        s.oldestEpoch = 0;
        delete s.cursors;
        emit QueueMigratedV090(nRequests, nSettlements, nClaims, held);
    }

    /// @dev Rewrite request `id` from the 0.8.0 layout. Slots 0 to 2 are the same in both.
    function _migrateRequest(FlowState storage s, uint256 id) private {
        Request storage r = s.requests[id];
        uint256 base;
        assembly {
            base := r.slot
        }
        uint256 limit = _load(base + 3);
        uint256 closedWord = _load(base + 4);
        // A 0.9.0 request has `expiresAt` in slot 4 (never 0: a deposit's expiry time, a redemption's uint64 max),
        // so the word is above 1; a 0.8.0 one has a bool there and nothing in slots 5 to 9.
        if (closedWord > 1) revert NotLegacyRequest(id);
        for (uint256 k = 5; k < 10; ++k) {
            if (_load(base + k) != 0) revert NotLegacyRequest(id);
        }
        if (closedWord == 0 && r.remaining != 0) revert LegacyRequestOpen(id);

        _store(base + 3, 0);
        _store(base + 4, 0);
        // Nothing is left in escrow for it. A request 0.8.0 emptied without closing is closed here the way the queue
        // closes one, so its epoch does not count it as open (the round and walk checks read these counts if a
        // 0.9.0 request later lands in the same epoch).
        if (closedWord == 0) {
            uint64 e = r.epoch;
            uint8 k = uint8(r.kind);
            if (s.epochOpen[e] != 0) s.epochOpen[e] -= 1;
            if (s.sideOpen[k][e] != 0) s.sideOpen[k][e] -= 1;
        }
        r.closed = true;
        r.remaining = 0;
        r.expiryEpoch = r.epoch;
        if (r.kind == RequestKind.Redeem) r.expiresAt = type(uint64).max;
        emit LegacyRequestMigrated(id, limit);
    }

    /// @dev Rewrite settlement `id` from the 0.8.0 layout. Slot 0 is the same in both.
    function _migrateSettlement(FlowState storage s, uint256 id) private {
        Settlement storage st = s.settlements[id];
        uint256 base;
        assembly {
            base := st.slot
        }
        uint256 packed = _load(base + 7);
        // 0.8.0 used 17 bytes of slot 7 and had no slot 8.
        if (_load(base + 8) != 0 || packed >> 136 != 0) revert NotLegacySettlement(id);
        uint64 frozenUntil = uint64(packed);
        bool returnAllowed = uint8(packed >> 64) != 0;
        uint64 holdEndsAt = uint64(packed >> 72);
        // 0.8.0 left the flag set after a freeze ran out; it only meant something while the freeze lasted.
        if (returnAllowed && frozenUntil > block.timestamp) revert LegacyReturnAllowed(id);

        uint256 depositBoundPrice = _load(base + 1);
        uint256 redeemBoundPrice = _load(base + 2);
        uint256 usdcIn = _load(base + 3);
        uint256 sharesMinted = _load(base + 4);
        uint256 sharesBurned = _load(base + 5);
        uint256 usdcOut = _load(base + 6);

        // No whole match existed in 0.8.0: every share of the settlement was minted or burned.
        st.matchedShares = 0;
        st.matchedUsdc = 0;
        st.matchSharePrice = 0;
        st.usdcIn = usdcIn;
        st.sharesMinted = sharesMinted;
        st.sharesBurned = sharesBurned;
        st.usdcOut = usdcOut;
        // `freezeSetAt` 0: a 0.8.0 freeze was only allowed inside the hold, so it holds back every claim of the
        // settlement, which is what 0.9.0 does for a claim that unlocks after `freezeSetAt`.
        st.frozenUntil = frozenUntil;
        st.freezeSetAt = 0;
        st.holdEndsAt = holdEndsAt;
        emit LegacySettlementMigrated(id, depositBoundPrice, redeemBoundPrice);
    }

    function _load(uint256 slot) private view returns (uint256 word) {
        assembly {
            word := sload(slot)
        }
    }

    function _store(uint256 slot, uint256 word) private {
        assembly {
            sstore(slot, word)
        }
    }
}
