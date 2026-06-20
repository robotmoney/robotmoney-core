// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (ADP-2, ORA-3)
//            docs/code-review/external-audit-verification-20260619.md (NC-2, F-09)
pragma solidity ^0.8.24;

import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";
import {IAerodromePool} from "../interfaces/IAerodromePool.sol";

/// @title BasketAssetConfigGuard
/// @notice The config-validation interface the 2026-06-19 audit recommended for
///         `BasketVault.addAsset`: it enforces the ADP-2 adapter codehash
///         allowlist and the ORA-3 execution-pool == TWAP-pool equality (F-09).
/// @dev Declared `public` (external, DELEGATECALL-linked) so the checks live in a
///      single deployed library instead of being inlined into every vault in the
///      already-EIP-170-tight basket family.
library BasketAssetConfigGuard {
    /// @dev Mirror of `BasketVault.Venue`. Kept value-compatible (same ordinals).
    enum Venue {
        V3,
        V4,
        Aerodrome
    }

    /// @dev Layout-compatible mirror of `BasketVault.AssetInfo`. Field order and
    ///      types MUST match exactly so the delegatecall-linked dedup scan below
    ///      reads/writes the vault's `assets` storage correctly.
    struct AssetInfo {
        address token;
        address pool;
        uint24 swapFee;
        bool active;
        address adapter;
        Venue venue;
    }

    /// @dev Adapter runtime-bytecode hash not on the ADMIN-approved allowlist (ADP-2).
    error AdapterCodeHashNotAllowed();
    /// @dev Execution pool (resolved from swapFee) != registered TWAP pool (ORA-3).
    error ExecutionPoolMismatch();
    /// @dev `addAsset` re-add of a token that already has an ACTIVE entry (NC-8).
    error AssetAlreadyActive();
    /// @dev Pool does not pair `token` with USDC.
    error PoolTokenMismatch();
    /// @dev Pool observation cardinality below the minimum required for TWAP.
    error InsufficientPoolCardinality(address pool, uint16 required, uint16 actual);
    /// @dev Pool lacks the observation history to service a full TWAP window.
    error InsufficientObservationHistory(address pool, uint32 requiredWindow);
    /// @dev Pool in-range liquidity below the synchronous-redemption minimum.
    error InsufficientPoolLiquidity(address pool, uint128 required, uint128 actual);

    /// @notice Assert `pool` is usable as an `addAsset` venue: it pairs `token`
    ///         with `usdc`, has enough observation cardinality and history to serve
    ///         a `twapWindow`-second TWAP, and has at least `minLiquidity` in-range
    ///         liquidity. Extracted from `BasketVault.addAsset` into this
    ///         delegatecall-linked guard to keep the EIP-170-tight basket-vault
    ///         bytecode small. Behaviour-identical to the prior inline checks.
    function requirePoolUsable(
        address pool,
        address token,
        address usdc,
        uint32 twapWindow,
        uint16 minCardinality,
        uint128 minLiquidity
    ) public view {
        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        if (!((t0 == token && t1 == usdc) || (t1 == token && t0 == usdc))) {
            revert PoolTokenMismatch();
        }
        (,,, uint16 cardinality,,,) = IUniswapV3Pool(pool).slot0();
        if (cardinality < minCardinality) {
            revert InsufficientPoolCardinality(pool, minCardinality, cardinality);
        }
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;
        try IUniswapV3Pool(pool).observe(secondsAgos) returns (int56[] memory, uint160[] memory) {}
        catch {
            revert InsufficientObservationHistory(pool, twapWindow);
        }
        uint128 poolLiquidity = IUniswapV3Pool(pool).liquidity();
        if (poolLiquidity < minLiquidity) {
            revert InsufficientPoolLiquidity(pool, minLiquidity, poolLiquidity);
        }
    }

    /// @notice NC-8 (no duplicate AssetInfo): if `token` already has an entry in
    ///         `assets`, reuse it instead of letting the caller append a second
    ///         one. An ACTIVE duplicate is rejected; an INACTIVE (removed) entry is
    ///         refreshed to the new config and re-activated in place. Lives in this
    ///         delegatecall-linked library so the scan/write logic stays out of the
    ///         EIP-170-tight basket-vault bytecode.
    /// @return reusedIndex The registry index of the inactive entry that was
    ///         reactivated in place (the caller must NOT push); or
    ///         `type(uint256).max` when the token is new and the caller must push.
    function reuseOrRejectDuplicate(
        AssetInfo[] storage assets,
        address token,
        address pool,
        uint24 swapFee,
        address adapter,
        Venue venue
    ) public returns (uint256 reusedIndex) {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (assets[i].token != token) continue;
            if (assets[i].active) revert AssetAlreadyActive();
            assets[i].pool = pool;
            assets[i].swapFee = swapFee;
            assets[i].adapter = adapter;
            assets[i].venue = venue;
            assets[i].active = true;
            return i;
        }
        return type(uint256).max;
    }

    /// @notice Vet a non-zero adapter's codehash against the allowlist (ADP-2 / NC-2).
    ///         The default Uniswap V3 path (adapter == 0) needs no vetting.
    function requireAllowedAdapter(address adapter, bool allowed) public pure {
        if (adapter != address(0) && !allowed) revert AdapterCodeHashNotAllowed();
    }

    /// @notice Assert the execution pool resolved from `swapFee` is the SAME pool
    ///         the NAV TWAP reads from (ORA-3 / F-09): fee tier for V3/V4, tick
    ///         spacing for Aerodrome. `swapFee == 0` is the pool-independent-pricing
    ///         sentinel (e.g. the Chronicle NAV adapter) and is exempt.
    function requireExecutionPoolMatchesTwap(address pool, uint24 swapFee, Venue venue)
        public
        view
    {
        if (swapFee == 0) return;
        uint256 poolParam = venue == Venue.Aerodrome
            ? uint256(uint24(IAerodromePool(pool).tickSpacing()))
            : uint256(IUniswapV3Pool(pool).fee());
        if (poolParam != uint256(swapFee)) revert ExecutionPoolMismatch();
    }
}
