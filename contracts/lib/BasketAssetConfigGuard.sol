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

    /// @dev Adapter runtime-bytecode hash not on the ADMIN-approved allowlist (ADP-2).
    error AdapterCodeHashNotAllowed();
    /// @dev Execution pool (resolved from swapFee) != registered TWAP pool (ORA-3).
    error ExecutionPoolMismatch();

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
