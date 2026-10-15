// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway (rolling-window caps, GW-4 / NC-7)
// (See also: contracts/gateway/RobotMoneyGateway.sol; issue 1808 — moved out of the gateway
//            so the proxied gateway, which now carries the upgrade entry points, fits EIP-170)
pragma solidity ^0.8.24;

/// @title GatewayWindows
/// @notice The gateway's per-agent rolling-window accounting, as an externally linked library.
///         Its code runs by DELEGATECALL on the gateway proxy's own storage. The logic is the
///         ring buffer the gateway carried inline before issue 1808, unchanged:
///
///         1. SAME-SECOND COALESCING: operations sharing a `block.timestamp` merge into the
///            newest entry, so the live entry count never exceeds the number of distinct
///            seconds in the window, hard-capped at `MAX_WINDOW_ENTRIES`.
///         2. SLOT REUSE: pruned slots are reclaimed by wrapping `head`/`count` around the
///            fixed-capacity `slots` array, so storage plateaus at the high-water mark.
///
///         Exact rolling-window semantics (strict `(t-WINDOW_SECONDS, t]` expiry) hold per entry.
library GatewayWindows {
    /// @notice Rolling window length (mirrors `RobotMoneyGateway.WINDOW_SECONDS`).
    uint64 internal constant WINDOW_SECONDS = 86400;
    /// @notice Hard cap on distinct live entries per agent per side
    ///         (mirrors `RobotMoneyGateway.MAX_WINDOW_ENTRIES`).
    uint256 internal constant MAX_WINDOW_ENTRIES = WINDOW_SECONDS;

    struct WindowEntry {
        uint64 timestamp;
        uint256 amount;
    }

    struct RollingWindow {
        WindowEntry[] slots; // ring storage; length == live capacity (<= MAX_WINDOW_ENTRIES)
        uint256 head; // index of the oldest live entry
        uint256 count; // number of live entries
        uint256 total; // cumulative amount across the live entries
    }

    /// @notice The live entry count would exceed `MAX_WINDOW_ENTRIES` (same selector as the
    ///         gateway's own `WindowBufferFull`).
    error WindowBufferFull();

    /// @notice Prune expired entries, then record `amount` unless the live total would exceed
    ///         `cap`.
    /// @return withinCap False when `total + amount > cap`. The caller reverts with its own
    ///         error, which also undoes the prune.
    /// @return oldest Timestamp of the oldest live entry after the append.
    /// @return total The live total after the append.
    function accrue(RollingWindow storage w, uint256 amount, uint256 cap)
        external
        returns (bool withinCap, uint64 oldest, uint256 total)
    {
        _prune(w);
        if (w.total + amount > cap) return (false, 0, 0);
        _append(w, amount);
        // `_append` just added an entry, so `count >= 1` and `slots[head]` is live.
        return (true, w.slots[w.head].timestamp, w.total);
    }

    /// @notice View-only live total after notionally pruning expired entries.
    function effectiveTotal(RollingWindow storage w) external view returns (uint256 total) {
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

    /// @dev Drop every live entry whose timestamp has aged past `(t-WINDOW_SECONDS, t]`.
    ///      Bounded: scans at most `count <= MAX_WINDOW_ENTRIES` entries (NC-7).
    function _prune(RollingWindow storage w) private {
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

    /// @dev Record `amount` at the current second. Same-second operations coalesce into the
    ///      newest live entry. Otherwise a freed slot is reused or, only while below the
    ///      high-water mark, a new slot is pushed, capped at `MAX_WINDOW_ENTRIES`.
    function _append(RollingWindow storage w, uint256 amount) private {
        uint256 count = w.count;
        uint256 cap = w.slots.length;
        if (count > 0) {
            uint256 newest = w.head + count - 1;
            if (newest >= cap) newest -= cap;
            if (w.slots[newest].timestamp == uint64(block.timestamp)) {
                w.slots[newest].amount += amount;
                w.total += amount;
                return;
            }
        }
        if (count == cap) {
            // Every slot is live: grow by one after re-linearizing the live region to index 0.
            // The `MAX_WINDOW_ENTRIES` revert cannot be reached through the public gateway API:
            // live entries occupy distinct seconds and the window is exactly
            // MAX_WINDOW_ENTRIES seconds wide, so `_prune` evicts the oldest entry before a
            // full buffer is observed. See
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

    /// @dev Rotate a completely full ring so the oldest live entry sits at index 0, with three
    ///      in-place reversals (no scratch array). Only on the rare grow path.
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
}
