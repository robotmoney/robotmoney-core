// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9.3 check 3 (internal TWAP: slice median and quorum),
//            §5.9.5 (slices, quorum, dispersionBps); docs/technical/one-vault-timed-flows-eng-plan.md E6
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IObservablePool} from "../../../../interfaces/IObservablePool.sol";
import {TickMath} from "../../../../lib/TickMath.sol";
import {BPS} from "../FundTypes.sol";

/// @title TwapSlicesLib
/// @notice Layer 3 of proposal §5.9.1: one `observe` call per pool returns the tick cumulatives at `slices + 1`
///         equally spaced points over the last `window` seconds; each slice's mean tick is the difference over the
///         slice length. The TWAP is the median of the slice means. No checkpoint call and no storage (E6).
///
///         A push made and undone inside one transaction leaves no trace in the cumulatives, and a push held for
///         part of the window moves only the slices it covers, so the median ignores it until it covers half of
///         them, and the quorum count shows it before that.
library TwapSlicesLib {
    /// @dev Upper bound on `slices` the library accepts (FlowTypes.MAX_SLICES is 48).
    uint8 private constant MAX_SLICES = 64;

    /// @notice Median slice tick of `pool` (an `IObservablePool`) over the last `window` seconds in `slices` equal
    ///         slices, and how many slice means sit within `dispersionBps` of the median. Never reverts on a pool
    ///         that answers `observe` with well-formed data: when `observe` reverts (too little history, plan §9
    ///         "pool history"), the pool has no code, or the inputs are unusable (`slices` 0 or above 64, `window`
    ///         0 or not a multiple of `slices`), `ok` is false and the other values are 0.
    ///
    ///         The band: a slice is inside when `|meanTick − medianTick| ≤ bandTicks(dispersionBps)`, where
    ///         `bandTicks` is the largest tick count whose price ratio `1.0001^t` is at most `1 + dispersionBps/1e4`.
    ///         That is the upward side of a `dispersionBps` price band; it is used on both sides, which is the
    ///         stricter choice below the median (`−log(1 − d) > log(1 + d)`). Ties count as inside.
    /// @param window Seconds; must be a multiple of `slices`.
    /// @return ok         The observe call succeeded and returned `slices + 1` points.
    /// @return medianTick The median of the slice mean ticks: the lower median for an even count. Each slice mean
    ///                    rounds toward negative infinity, like `TwapTickMath.meanTick`.
    /// @return inBand     Number of slices within the band, compared by the caller with `quorum`.
    function median(address pool, uint32 window, uint8 slices, uint16 dispersionBps)
        internal
        view
        returns (bool ok, int24 medianTick, uint8 inBand)
    {
        if (pool.code.length == 0 || slices == 0 || slices > MAX_SLICES || window == 0 || window % slices != 0) {
            return (false, 0, 0);
        }
        int24[] memory means;
        (ok, means) = sliceMeans(pool, window, slices);
        if (!ok) return (false, 0, 0);

        int24[] memory sorted = new int24[](slices);
        for (uint256 j; j < slices; ++j) {
            sorted[j] = means[j];
        }
        _sort(sorted);
        medianTick = sorted[(uint256(slices) - 1) / 2];

        int256 band = int256(uint256(bandTicks(dispersionBps)));
        for (uint256 j; j < slices; ++j) {
            int256 d = int256(means[j]) - int256(medianTick);
            if (d < 0) d = -d;
            if (d <= band) ++inBand;
        }
    }

    /// @notice The mean tick of each of `slices` equal slices of the last `window` seconds, oldest first, from one
    ///         `observe` call. `ok` false when the call fails or returns the wrong number of points.
    function sliceMeans(address pool, uint32 window, uint8 slices)
        internal
        view
        returns (bool ok, int24[] memory means)
    {
        uint32 len = window / slices;
        uint32[] memory ago = new uint32[](uint256(slices) + 1);
        for (uint256 j; j <= slices; ++j) {
            ago[j] = window - uint32(j) * len;
        }
        (bool success, bytes memory ret) =
            pool.staticcall(abi.encodeWithSelector(IObservablePool.observe.selector, ago));
        if (!success || ret.length < 128) return (false, means);
        // Well-formed `observe` data (a real Uniswap V3 or Aerodrome CL pool) is assumed from here on; malformed
        // data from a hostile pool reverts the decode. Such a pool cannot be admitted (`addAsset` checks history).
        (int56[] memory cum,) = abi.decode(ret, (int56[], uint160[]));
        if (cum.length != uint256(slices) + 1) return (false, means);
        means = new int24[](slices);
        int56 l = int56(uint56(len));
        for (uint256 j; j < slices; ++j) {
            int56 delta = cum[j + 1] - cum[j];
            int56 m = delta / l;
            if (delta < 0 && delta % l != 0) m--;
            if (m > int56(TickMath.MAX_TICK) || m < int56(TickMath.MIN_TICK)) return (false, means);
            means[j] = int24(m);
        }
        ok = true;
    }

    /// @notice The largest tick count `t ≥ 0` with `1.0001^t ≤ 1 + bps / 10 000` (rounded DOWN, so the band in
    ///         ticks is never wider than the band in price). `bandTicks(100) == 99`.
    function bandTicks(uint16 bps) internal pure returns (uint24 t) {
        // 1.0001^t ≥ 1 + t/1e4 (Bernoulli), so t ≤ bps. Binary search on sqrtP(t)² × BPS ≤ (BPS + bps) × 2^192.
        uint256 rhs = (BPS + uint256(bps)) << 192;
        uint256 lo = 0;
        uint256 hi = bps;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            uint256 sp = uint256(TickMath.getSqrtRatioAtTick(int24(int256(mid))));
            if (sp * sp * BPS <= rhs) lo = mid;
            else hi = mid - 1;
        }
        t = uint24(lo);
    }

    /// @dev Insertion sort, ascending. At most 64 entries.
    function _sort(int24[] memory a) private pure {
        uint256 n = a.length;
        for (uint256 i = 1; i < n; ++i) {
            int24 v = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > v) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = v;
        }
    }
}
