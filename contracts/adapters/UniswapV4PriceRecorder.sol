// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: V4 venue and price recorder)
//            docs/adr/ADR-0001-mvp-agent-token-shortlist.md (2026-10-08: RM on the V4 RM/USDC 2.91% pool)
//            docs/technical/smart-contract-invariants.md (ORA-1, ORA-3)
//            docs/technical/asset-valuation-hybrid.md
//
// A hookless Uniswap V4 pool records no observations, so it has no on-chain TWAP. This contract is the
// in-protocol replacement: a small, permissionless, admin-free recorder that stores the pool's tick in a
// Uniswap V3 style observation ring and answers the V3 `observe()` call. BasketVault, BasketAssetConfigGuard
// and TwapTickMath read it exactly as they read a V3 pool, so no vault logic changes (the vault family has
// no EIP-170 headroom left).
//
// OWNER DECISION 2026-10-08: sufficient for the Base mainnet TEST, NOT for the final deployment. A stronger
// price source (a hooked oracle pool) is a later, separate decision. The security bound is POOL DEPTH: a
// manipulator has to move and hold the pool price, so `perDepositCap` and `tvlCap` must be sized below
// what the pool can absorb (see docs/adr/ADR-0005 amendment).
pragma solidity ^0.8.24;

import {IPoolManagerV4} from "../interfaces/IPoolManagerV4.sol";

/// @title UniswapV4PriceRecorder
/// @notice Permissionless tick recorder and V3-shaped oracle facade for one hookless Uniswap V4 pool.
///
/// @dev DESIGN (every point is tested in `UniswapV4PriceRecorder.t.sol`)
///
///      1. No role, owner or setter. Anyone calls `record()` (a keeper, or the swap adapter before every
///         swap) and `grow()`.
///      2. At most one snapshot per block timestamp. A second call in the same block is a no-op, so a
///         same-block "swap, record, swap back" cannot write two points or overwrite its own record.
///      3. LAGGED TICK, as in Uniswap V3. The cumulative for the interval since the previous snapshot is
///         extended with the PREVIOUS recorded tick, then the new tick replaces it. A tick that an attacker
///         pushes into the pool and records in block N therefore weights only the time after block N, and
///         only until the next record.
///      4. CLAMP. The recorded tick moves toward the live pool tick by at most `MAX_TICK_STEP_PER_SECOND`
///         ticks per elapsed second, with elapsed capped at `CLAMP_ELAPSED_CAP` seconds. So one record can
///         move the recorded tick by at most 600 ticks (about 6.2 percent of price), however far a flash loan
///         moved the pool, and a long gap cannot widen the step. The live tick is read through the
///         PoolManager `extsload`, never a spot-in-the-same-call trade.
///      5. `observe()` never reads live spot. `observe([0])` returns the last snapshot extended by the last
///         recorded tick, as V3 does. Live spot is exposed only through `slot0()`, which the vault's ORA-4
///         deposit guard compares against the TWAP (a guard, not a price).
///      6. STALE FAILS CLOSED. If the last snapshot is older than `MAX_STALENESS` (one 1800 s window),
///         `observe()` reverts `StaleRecorder`. Deposits, USDC redeems, `totalAssets()` and `addAsset` then
///         revert, and `redeemInKind` still works because it reads no oracle (ADR-0007, core 1665). Any call
///         to `record()` makes it fresh again.
///      7. FIRST RECORD. The constructor records the live tick with cumulative 0, so there is no
///         uninitialised first read. The pool must be initialised.
///      8. `grow(n)` raises the ring like V3's `increaseObservationCardinalityNext`. `slot0()` reports the
///         ring cardinality in the position `BasketAssetConfigGuard.requireObservationHistory` reads.
///
///      NOT a defence: a manipulator who can move the pool price by more than the ORA-4 deviation guard and
///      hold it across many blocks can drag the TWAP at up to 10 ticks per second. That cost is the pool's
///      depth, which is why the vault caps must stay below it.
contract UniswapV4PriceRecorder {
    // ─── Constants ────────────────────────────────────────────────────

    /// @notice Largest age of the last snapshot at which `observe` still answers: one default TWAP window.
    uint32 public constant MAX_STALENESS = 1_800;
    /// @notice Largest tick change per elapsed second between two recorded ticks.
    uint32 public constant MAX_TICK_STEP_PER_SECOND = 10;
    /// @notice Elapsed seconds beyond this do not widen the clamp.
    uint32 public constant CLAMP_ELAPSED_CAP = 60;
    /// @dev PoolManager storage slot of `mapping(PoolId => Pool.State) _pools`.
    uint256 private constant POOLS_SLOT = 6;
    /// @dev `Pool.State.liquidity` sits three slots after `slot0`.
    uint256 private constant LIQUIDITY_OFFSET = 3;

    // ─── Immutables: the full PoolKey, bound to the pool id at construction ──

    IPoolManagerV4 public immutable POOL_MANAGER;
    bytes32 public immutable POOL_ID;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable hooks;
    /// @dev Storage slot of this pool's `Pool.State` in the PoolManager.
    bytes32 private immutable POOL_STATE_SLOT;

    // ─── Storage ──────────────────────────────────────────────────────

    struct Observation {
        uint32 blockTimestamp;
        int56 tickCumulative;
        bool initialized;
    }

    struct State {
        int24 lastTick; // the recorded (clamped) tick: weights the next interval
        uint16 index;
        uint16 cardinality;
        uint16 cardinalityNext;
    }

    Observation[65535] public observations;
    State private _state;

    // ─── Events and errors ────────────────────────────────────────────

    event Recorded(uint32 blockTimestamp, int24 recordedTick, int24 liveTick, int56 tickCumulative);
    event Grown(uint16 cardinalityNext);

    error InvalidPoolKey();
    error PoolNotInitialized();
    /// @dev `observe` was asked for a point older than the oldest snapshot (same meaning as V3's "OLD").
    error ObservationTooOld();
    /// @dev The last snapshot is older than `MAX_STALENESS`.
    error StaleRecorder(uint32 lastRecordedAt, uint32 nowTs);

    // ─── Constructor ──────────────────────────────────────────────────

    /// @param poolManager_ The Uniswap V4 PoolManager (Base: 0x498581fF718922c3f8e6A244956aF099B2652b2b).
    /// @param currency0_   Lower token address of the pool key.
    /// @param currency1_   Higher token address of the pool key.
    /// @param fee_         Pool fee in hundredths of a bip (RM/USDC: 29100).
    /// @param tickSpacing_ Pool tick spacing (RM/USDC: 582).
    /// @param hooks_       Hook address. Must be zero: a hooked pool can change swap outcomes.
    constructor(
        address poolManager_,
        address currency0_,
        address currency1_,
        uint24 fee_,
        int24 tickSpacing_,
        address hooks_
    ) {
        if (poolManager_.code.length == 0) revert InvalidPoolKey();
        if (currency0_ == address(0) || currency0_ >= currency1_) revert InvalidPoolKey();
        if (hooks_ != address(0)) revert InvalidPoolKey();
        POOL_MANAGER = IPoolManagerV4(poolManager_);
        token0 = currency0_;
        token1 = currency1_;
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;
        bytes32 id = keccak256(abi.encode(currency0_, currency1_, fee_, tickSpacing_, hooks_));
        POOL_ID = id;
        bytes32 stateSlot = keccak256(abi.encode(id, POOLS_SLOT));
        POOL_STATE_SLOT = stateSlot;

        (uint160 sqrtPriceX96, int24 tick) = _readSlot0(IPoolManagerV4(poolManager_), stateSlot);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        observations[0] = Observation(uint32(block.timestamp), 0, true);
        _state = State({lastTick: tick, index: 0, cardinality: 1, cardinalityNext: 1});
        emit Recorded(uint32(block.timestamp), tick, tick, 0);
    }

    // ─── Write surface (permissionless) ───────────────────────────────

    /// @notice Record the pool tick. A no-op when this block timestamp is already recorded.
    /// @return recorded True when a snapshot was written.
    function record() external returns (bool recorded) {
        State memory s = _state;
        Observation memory last = observations[s.index];
        uint32 ts = uint32(block.timestamp);
        if (last.blockTimestamp == ts) return false;

        (uint160 sqrtPriceX96, int24 liveTick) = _readSlot0(POOL_MANAGER, POOL_STATE_SLOT);
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();

        uint32 delta = ts - last.blockTimestamp;
        int56 cumulative = last.tickCumulative + int56(s.lastTick) * int56(uint56(delta));
        int24 recordedTick = _clamp(s.lastTick, liveTick, delta);

        // V3 ring rule: the ring widens only when the write position reaches the end.
        uint16 cardinalityUpdated = (s.cardinalityNext > s.cardinality
                && s.index == s.cardinality - 1)
            ? s.cardinalityNext
            : s.cardinality;
        // slither-disable-next-line weak-prng
        uint16 indexUpdated = (s.index + 1) % cardinalityUpdated;
        observations[indexUpdated] = Observation(ts, cumulative, true);
        _state = State({
            lastTick: recordedTick,
            index: indexUpdated,
            cardinality: cardinalityUpdated,
            cardinalityNext: s.cardinalityNext
        });
        emit Recorded(ts, recordedTick, liveTick, cumulative);
        return true;
    }

    /// @notice Raise the ring to at least `next` slots. Permissionless: the caller pays the storage writes.
    ///         The ring widens at the next `record()` that reaches the end of the current ring.
    function grow(uint16 next) external returns (uint16) {
        uint16 current = _state.cardinalityNext;
        if (next <= current) return current;
        for (uint16 i = current; i < next; i++) {
            observations[i].blockTimestamp = 1; // touch the slot so later records are cheap; still uninitialised
        }
        _state.cardinalityNext = next;
        emit Grown(next);
        return next;
    }

    // ─── Read surface: V3 shaped ──────────────────────────────────────

    /// @notice Cumulative ticks at `secondsAgos[i]` seconds ago, from the recorded snapshots only. Never reads live spot.
    /// @dev Reverts `StaleRecorder` when the last snapshot is older than `MAX_STALENESS`, and `ObservationTooOld`
    ///      when a requested point predates the oldest snapshot. The second return value is always zeros (V3 ABI).
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        )
    {
        State memory s = _state;
        uint32 time = uint32(block.timestamp);
        uint32 lastTs = observations[s.index].blockTimestamp;
        if (time - lastTs > MAX_STALENESS) revert StaleRecorder(lastTs, time);

        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = _observeSingle(s, time, secondsAgos[i]);
        }
    }

    /// @notice V3 `slot0` prefix. `sqrtPriceX96` and `tick` are the LIVE pool values, for the ORA-4 spot-versus-TWAP
    ///         guard only (they are never a price). `observationIndex` and `observationCardinality` describe the ring.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality
        )
    {
        (sqrtPriceX96, tick) = _readSlot0(POOL_MANAGER, POOL_STATE_SLOT);
        State memory s = _state;
        return (sqrtPriceX96, tick, s.index, s.cardinality);
    }

    /// @notice Live in-range liquidity L of the pool (V3 `liquidity()` shape). The unit is the raw uint128 L, not USDC.
    function liquidity() external view returns (uint128) {
        bytes32 raw = POOL_MANAGER.extsload(bytes32(uint256(POOL_STATE_SLOT) + LIQUIDITY_OFFSET));
        return uint128(uint256(raw));
    }

    /// @notice The last recorded (clamped) tick, the snapshot timestamp and the ring state.
    function latest()
        external
        view
        returns (
            int24 lastTick,
            uint32 lastRecordedAt,
            uint16 index,
            uint16 cardinality,
            uint16 cardinalityNext
        )
    {
        State memory s = _state;
        return (
            s.lastTick,
            observations[s.index].blockTimestamp,
            s.index,
            s.cardinality,
            s.cardinalityNext
        );
    }

    /// @notice Timestamp of the oldest snapshot still in the ring. The history `observe` can serve is `now - oldestObservation()`.
    ///         The deploy runner reads it to wait for a full window before the vault stage (core 1676).
    function oldestObservation() external view returns (uint32) {
        State memory s = _state;
        // slither-disable-next-line weak-prng
        Observation memory oldest = observations[(uint256(s.index) + 1) % s.cardinality];
        if (!oldest.initialized) oldest = observations[0];
        return oldest.blockTimestamp;
    }

    /// @notice True when `observe` answers now (the last snapshot is within `MAX_STALENESS`).
    function isFresh() external view returns (bool) {
        return uint32(block.timestamp) - observations[_state.index].blockTimestamp <= MAX_STALENESS;
    }

    // ─── Internals ────────────────────────────────────────────────────

    function _readSlot0(IPoolManagerV4 pm, bytes32 stateSlot)
        private
        view
        returns (uint160 sqrtPriceX96, int24 tick)
    {
        uint256 data = uint256(pm.extsload(stateSlot));
        sqrtPriceX96 = uint160(data);
        tick = int24(uint24(data >> 160));
    }

    /// @dev Move `prev` toward `live` by at most MAX_TICK_STEP_PER_SECOND * min(elapsed, CLAMP_ELAPSED_CAP).
    function _clamp(int24 prev, int24 live, uint32 elapsed) private pure returns (int24) {
        uint256 e = elapsed > CLAMP_ELAPSED_CAP ? CLAMP_ELAPSED_CAP : elapsed;
        int256 maxStep = int256(uint256(MAX_TICK_STEP_PER_SECOND) * e);
        int256 lo = int256(prev) - maxStep;
        int256 hi = int256(prev) + maxStep;
        int256 t = live;
        if (t < lo) t = lo;
        else if (t > hi) t = hi;
        return int24(t);
    }

    /// @dev V3 `Oracle.observeSingle`, with the recorded tick as the extrapolation tick.
    function _observeSingle(State memory s, uint32 time, uint32 secondsAgo)
        private
        view
        returns (int56)
    {
        if (secondsAgo == 0) {
            Observation memory last = observations[s.index];
            if (last.blockTimestamp != time) last = _transform(last, time, s.lastTick);
            return last.tickCumulative;
        }
        if (secondsAgo > time) revert ObservationTooOld();
        uint32 target = time - secondsAgo;
        (Observation memory beforeOrAt, Observation memory atOrAfter) = _surrounding(s, target);
        if (target == beforeOrAt.blockTimestamp) return beforeOrAt.tickCumulative;
        if (target == atOrAfter.blockTimestamp) return atOrAfter.tickCumulative;
        int56 observationTimeDelta =
            int56(uint56(atOrAfter.blockTimestamp - beforeOrAt.blockTimestamp));
        int56 targetDelta = int56(uint56(target - beforeOrAt.blockTimestamp));
        return beforeOrAt.tickCumulative
            + ((atOrAfter.tickCumulative - beforeOrAt.tickCumulative) / observationTimeDelta)
            * targetDelta;
    }

    function _transform(Observation memory last, uint32 ts, int24 tick)
        private
        pure
        returns (Observation memory)
    {
        uint32 delta = ts - last.blockTimestamp;
        return Observation(ts, last.tickCumulative + int56(tick) * int56(uint56(delta)), true);
    }

    function _surrounding(State memory s, uint32 target)
        private
        view
        returns (Observation memory beforeOrAt, Observation memory atOrAfter)
    {
        beforeOrAt = observations[s.index];
        if (beforeOrAt.blockTimestamp <= target) {
            if (beforeOrAt.blockTimestamp == target) return (beforeOrAt, atOrAfter);
            return (beforeOrAt, _transform(beforeOrAt, target, s.lastTick));
        }
        // Oldest snapshot: the slot after the newest, or slot 0 when the ring has not wrapped yet.
        // slither-disable-next-line weak-prng
        beforeOrAt = observations[(s.index + 1) % s.cardinality];
        if (!beforeOrAt.initialized) beforeOrAt = observations[0];
        if (beforeOrAt.blockTimestamp > target) revert ObservationTooOld();
        return _binarySearch(s, target);
    }

    function _binarySearch(State memory s, uint32 target)
        private
        view
        returns (Observation memory beforeOrAt, Observation memory atOrAfter)
    {
        // slither-disable-next-line weak-prng
        uint256 l = (uint256(s.index) + 1) % s.cardinality;
        uint256 r = l + s.cardinality - 1;
        uint256 i;
        while (true) {
            i = (l + r) / 2;
            // slither-disable-next-line weak-prng
            beforeOrAt = observations[i % s.cardinality];
            if (!beforeOrAt.initialized) {
                l = i + 1;
                continue;
            }
            // slither-disable-next-line weak-prng
            atOrAfter = observations[(i + 1) % s.cardinality];
            bool targetAtOrAfter = beforeOrAt.blockTimestamp <= target;
            if (targetAtOrAfter && target <= atOrAfter.blockTimestamp) break;
            if (!targetAtOrAfter) r = i - 1;
            else l = i + 1;
        }
    }
}
