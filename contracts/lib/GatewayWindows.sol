// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §9 (EIP-170 size budget, item 2)
// (See also: contracts/gateway/RobotMoneyGateway.sol — the caller; issues #449 (withdraw rolling
//  window), #497 (deposit rolling window); NC-7 / GW-4 (bounded ring buffer))
pragma solidity ^0.8.24;

/// @title GatewayWindows
/// @notice The per-agent rolling-window accounting of `RobotMoneyGateway`: a bounded ring buffer of
///         `(timestamp, amount)` entries whose live sum is capped over any `WINDOW_SECONDS`-wide
///         interval. A CREATE2-linked library: `public` functions run as the gateway through
///         `DELEGATECALL` and operate on the gateway's own `RollingWindow` storage.
/// @dev Why it exists (ADR-0014 §9): behind a UUPS proxy the gateway also carries the upgrade code
///      and its former constructor as an initializer; moving the ring buffer out keeps it under
///      EIP-170 with the 1,024-byte margin the ADR requires. The types and the window constants are
///      declared once, here; the gateway's public `WINDOW_SECONDS` and `MAX_WINDOW_ENTRIES` read
///      these. Errors mirror the gateway's declarations (same selectors).
library GatewayWindows {
    /// @notice Window length in seconds for per-window gross caps.
    uint64 internal constant WINDOW_SECONDS = 86400;

    /// @notice Hard cap on the number of distinct live ring-buffer entries per agent per side.
    ///         Same-second operations coalesce, so the live count can never exceed the number of
    ///         distinct seconds in the window; this pins the storage footprint regardless.
    uint256 internal constant MAX_WINDOW_ENTRIES = WINDOW_SECONDS;

    struct WindowEntry {
        uint64 timestamp;
        uint256 amount;
    }

    /// @notice Bounded ring buffer backing one agent's rolling-window accounting (NC-7 / GW-4).
    ///         SAME-SECOND COALESCING keeps the live entry count at most the number of distinct
    ///         seconds in the window (`MAX_WINDOW_ENTRIES`), and SLOT REUSE wraps `head`/`count`
    ///         around the fixed-capacity `slots`, so storage plateaus at the high-water mark of
    ///         concurrently-live entries. Exact `(t-WINDOW_SECONDS, t]` expiry per entry.
    /// @param slots Ring storage; length == live capacity (≤ MAX_WINDOW_ENTRIES).
    /// @param head  Index of the oldest live entry.
    /// @param count Number of live entries.
    /// @param total Cumulative amount across the live entries.
    struct RollingWindow {
        WindowEntry[] slots;
        uint256 head;
        uint256 count;
        uint256 total;
    }

    /// @dev Mirror of `RobotMoneyGateway.WindowCapExceeded` (deposit side, #497).
    error WindowCapExceeded();
    /// @dev Mirror of `RobotMoneyGateway.WithdrawWindowCapExceeded` (withdraw side, #449).
    error WithdrawWindowCapExceeded();
    /// @dev Mirror of `RobotMoneyGateway.WindowBufferFull`. Unreachable through the gateway API.
    error WindowBufferFull();

    /// @notice Apply `amount` against a rolling-window budget of `cap`. Prunes expired entries,
    ///         reverts when the projected live sum would breach `cap` (`WithdrawWindowCapExceeded`
    ///         when `withdrawSide`, else `WindowCapExceeded`), then records the entry.
    /// @return windowStart Timestamp of the oldest live entry after the append.
    /// @return total       Live sum after the append.
    function accrue(RollingWindow storage w, uint256 amount, uint256 cap, bool withdrawSide)
        public
        returns (uint64 windowStart, uint256 total)
    {
        _pruneWindow(w);
        if (w.total + amount > cap) {
            if (withdrawSide) revert WithdrawWindowCapExceeded();
            revert WindowCapExceeded();
        }
        _appendWindowEntry(w, amount);
        return (_oldestTimestamp(w), w.total);
    }

    /// @notice View-only effective live total after notionally pruning expired entries. Mirrors
    ///         `_pruneWindow`'s arithmetic without mutating storage.
    function effectiveTotal(RollingWindow storage w) public view returns (uint256 total) {
        uint256 cutoff = block.timestamp > WINDOW_SECONDS ? block.timestamp - WINDOW_SECONDS : 0;
        uint256 head = w.head;
        uint256 count = w.count;
        total = w.total;
        uint256 cap = w.slots.length;
        while (count > 0 && w.slots[head].timestamp <= cutoff) {
            total -= w.slots[head].amount;
            head = head + 1 == cap ? 0 : head + 1;
            count--;
        }
    }

    /// @dev Drop every live entry whose timestamp has aged past the rolling window
    ///      `(t-WINDOW_SECONDS, t]`, reclaiming its ring slot and decrementing `total`. Strictly
    ///      bounded: it scans at most `count` entries, which can never exceed `MAX_WINDOW_ENTRIES`.
    function _pruneWindow(RollingWindow storage w) private {
        uint256 cutoff = block.timestamp > WINDOW_SECONDS ? block.timestamp - WINDOW_SECONDS : 0;
        uint256 head = w.head;
        uint256 count = w.count;
        uint256 total = w.total;
        uint256 cap = w.slots.length;
        while (count > 0 && w.slots[head].timestamp <= cutoff) {
            total -= w.slots[head].amount;
            head = head + 1 == cap ? 0 : head + 1;
            count--;
        }
        w.head = count == 0 ? 0 : head;
        w.count = count;
        w.total = total;
    }

    /// @dev Record `amount` at the current `block.timestamp`. Operations within the same second
    ///      COALESCE into the newest live entry (no new slot), which is what bounds the live entry
    ///      count. Otherwise a freed slot is reused (ring wrap) or, only while the buffer has not
    ///      yet reached its high-water mark, a new slot is `push`ed, capped at `MAX_WINDOW_ENTRIES`.
    function _appendWindowEntry(RollingWindow storage w, uint256 amount) private {
        uint256 count = w.count;
        uint256 cap = w.slots.length;
        // Same-second coalescing: fold into the newest live entry if present.
        if (count > 0) {
            uint256 newest = w.head + count - 1;
            if (newest >= cap) newest -= cap;
            if (w.slots[newest].timestamp == uint64(block.timestamp)) {
                w.slots[newest].amount += amount;
                w.total += amount;
                return;
            }
        }
        // Distinct second: claim the next ring slot after the newest live entry.
        if (count == cap) {
            // Buffer is completely full: every slot is live, so there is no freed slot to reuse.
            // Grow capacity by one (hard-capped at MAX_WINDOW_ENTRIES), re-linearizing the live
            // region to start at index 0 first so the wrapped layout cannot corrupt ordering.
            //
            // The `count >= MAX_WINDOW_ENTRIES` revert cannot be reached through the gateway API:
            // live entries each occupy a distinct second, and the window is exactly
            // WINDOW_SECONDS == MAX_WINDOW_ENTRIES seconds wide, so one more distinct second
            // advances past the oldest entry's expiry and `_pruneWindow` evicts it first. See
            // test_rollingWindow_liveCountBoundedAcrossDistinctSeconds.
            // coverage:unreachable
            if (count >= MAX_WINDOW_ENTRIES) revert WindowBufferFull();
            _relinearize(w);
            w.slots.push(WindowEntry({timestamp: uint64(block.timestamp), amount: amount}));
            w.head = 0;
            w.count = count + 1;
            w.total += amount;
            return;
        }
        uint256 tail = w.head + count;
        if (tail >= cap) tail -= cap;
        w.slots[tail] = WindowEntry({timestamp: uint64(block.timestamp), amount: amount});
        w.count = count + 1;
        w.total += amount;
    }

    /// @dev Rotate the full ring buffer so the oldest live entry sits at index 0. Precondition: the
    ///      buffer is completely full, so a rotation by `head` re-linearizes the live region. Used
    ///      only on the rare grow path. Three in-place reversals, no scratch array.
    function _relinearize(RollingWindow storage w) private {
        uint256 head = w.head;
        if (head == 0) return;
        uint256 len = w.slots.length;
        _reverseRange(w, 0, head);
        _reverseRange(w, head, len);
        _reverseRange(w, 0, len);
        w.head = 0;
    }

    /// @dev Reverse `slots[lo:hi)` in place.
    function _reverseRange(RollingWindow storage w, uint256 lo, uint256 hi) private {
        while (lo + 1 < hi) {
            hi--;
            WindowEntry memory tmp = w.slots[lo];
            w.slots[lo] = w.slots[hi];
            w.slots[hi] = tmp;
            lo++;
        }
    }

    /// @dev Timestamp of the oldest live entry, or 0 when the window is empty. Only called right
    ///      after an append, so the empty branch is defensive.
    function _oldestTimestamp(RollingWindow storage w) private view returns (uint64) {
        // coverage:unreachable
        if (w.count == 0) return 0;
        return w.slots[w.head].timestamp;
    }
}
