// SPDX-License-Identifier: MIT
// Canonical: docs/technical/unified-vault-spec.md §2 (`IPositionAdapter`),
//            docs/adr/ADR-0010-unified-vault-architecture.md §2.
//
// ============================================================================
// FROZEN INTERFACE SURFACE (scouted by #1115, finalized by #1116)
// ============================================================================
// This file is the FROZEN adapter boundary the Unified-Vault phase decouples
// around. The eight members and the normative error set below are the stable
// surface the parallel downstream feature issues compile and type-check
// against WITHOUT anyone having landed the vault (#1119), the lending-adapter
// retrofit (#1117), or any AssetPositionAdapter (#1118/#1124/#1125/#1126) yet.
//
// It changes NO runtime behavior on its own — a Solidity `interface` has no
// bytecode; nothing in the deployed system references it until a concrete
// implementation and the unified Vault are written. The v1 `IStrategyAdapter`
// and every deployed adapter/vault are UNTOUCHED and retire per ADR-0009.
//
// #1116 has frozen the member signatures, the normative error set
// (`OnlyVault` / `SlippageExceeded`), and the NatSpec. Downstream issues MUST
// treat this surface as stable and coordinate any change through a new issue.
// The extraction/insertion seams keyed off this boundary are enumerated in
// docs/technical/unified-vault-seam-map.json (validated by
// scripts/validate-seam-map).
//
// `isExact()` is present here for the at-registration cross-check and for
// monitoring/differential tests ONLY. It is NEVER a per-call gate: the vault
// reads the vault-attested `AdapterInfo.isExact` bool set by ADMIN at
// `addAdapter` (spec §2.2 / §5.1, C2). A self-reported `isExact()` cannot be
// allowed to select share-value-critical branches.
pragma solidity ^0.8.24;

/// @notice Position-adapter boundary for the unified Vault (ADR-0010). A
///         superset of the v1 `IStrategyAdapter`: it adds min-out parameters, a
///         realized-value return on `deploy`, and the `isExact()` /
///         `USDC()` / `VAULT()` identity views the vault's eligibility probe
///         requires. Every vault theme (rmUSDC/rmPROTO/rmAGENT/rmRWA) is one
///         Vault deployment composed with a set of these adapters.
/// @dev    All mutating functions are `onlyVault` inside implementations. The
///         normative semantics (choreography, floor-composition, sentinel,
///         clamp-vs-revert, protected-token sets) live in
///         docs/technical/unified-vault-spec.md §2.2 and are finalized by #1116.
interface IPositionAdapter {
    // ── Normative error set ─────────────────────────────────────────────────
    // The shared adapter-boundary errors every `IPositionAdapter` implementation
    // reverts with. Frozen here so the vault, the router, and rmpc decode one
    // canonical selector per condition instead of a per-adapter re-declaration.
    // Adapter-specific reverts remain on their implementations and are NOT part
    // of this surface: `MorphoAdapter.ExposureCapExceeded(current, amount, cap)`
    // (exposure cap, spec §3), oracle staleness/deviation guards on asset
    // adapters (spec §4), and the vault-side `InsufficientAdapterLiquidity(
    // requested, available)` raised by `_pullProportional` (spec §5.3), not the
    // adapter.

    /// @notice The caller of a mutating function (`deploy` / `withdraw`) is not
    ///         the single bound `VAULT()`. Every mutating path is `onlyVault`
    ///         (spec §2.2, INV-1 authority binding).
    error OnlyVault();

    /// @notice A min-out slippage floor was breached: `deploy` realized
    ///         `valueAdded < minValueOut`, or `withdraw` realized
    ///         `usdcOut < max(minUsdcOut, adapterInternalFloor)`. Both revert
    ///         (no clamp below the floor) — spec §2.2.
    error SlippageExceeded();

    /// @notice Convert `usdcIn` USDC (transferred to the adapter first, same
    ///         choreography as v1 `_allocateTo`) into the adapter's position.
    /// @param usdcIn USDC (6-decimal units) the vault has already `safeTransfer`ed.
    /// @param minValueOut Slippage floor; the adapter MUST revert
    ///        `SlippageExceeded` when the realized USDC-denominated value added
    ///        is below this (no clamp on the deploy path).
    /// @return valueAdded USDC-denominated increase in `totalAssets()` from this
    ///         call. Exact adapters MUST return exactly `usdcIn`.
    /// @dev    `onlyVault` (reverts `OnlyVault`). Also reverts on venue failure,
    ///         the oracle staleness/deviation guard (asset adapters), and the
    ///         implementation exposure cap (e.g. `MorphoAdapter.maxExposure`).
    function deploy(uint256 usdcIn, uint256 minValueOut) external returns (uint256 valueAdded);

    /// @notice Liquidate position back to USDC and deliver it to the vault.
    /// @param usdcWanted Target USDC; `type(uint256).max` means "withdraw all"
    ///        (emergency drains, adapter retirement). Clamped at liquidatable
    ///        balance — shortfall against `usdcWanted` clamps.
    /// @param minUsdcOut Effective floor is `max(minUsdcOut, adapterInternalFloor)`;
    ///        shortfall against the floor REVERTS `SlippageExceeded`. `0` means
    ///        "adapter's own floor" (not "no floor"). Shortfall against
    ///        `usdcWanted` above the floor CLAMPS (returns the realized `usdcOut`).
    /// @return usdcOut Realized USDC delivered to the vault.
    /// @dev    `onlyVault` (reverts `OnlyVault`).
    function withdraw(uint256 usdcWanted, uint256 minUsdcOut) external returns (uint256 usdcOut);

    /// @notice Live USDC-denominated value of the position (principal + accrued
    ///         interest for lending; TWAP/oracle-priced balance for assets).
    ///         Spot (`slot0`) is never read here (ORA-1). MAY revert fail-closed
    ///         when the price source is unusable; MUST return 0 (without touching
    ///         the oracle) on a zero balance (SUP-5).
    function totalAssets() external view returns (uint256);

    /// @notice Bytecode-level exactness declaration: `true` iff `deploy`/`withdraw`
    ///         are 1:1 and `totalAssets()` is a hard redemption claim (lending),
    ///         `false` for slippage-priced asset adapters.
    /// @dev    At-registration cross-check + monitoring ONLY — never a per-call
    ///         gate. Share-critical paths read the vault-attested
    ///         `AdapterInfo.isExact` (spec §2.2, C2).
    function isExact() external view returns (bool);

    /// @notice Permissionlessly claim venue rewards, convert to USDC, and credit
    ///         the vault (never a caller-supplied address, INV-1; never stranded,
    ///         INV-2). MUST NOT revert when there is nothing to claim.
    function harvestRewards() external;

    /// @notice Permissionlessly sweep a NON-protected foreign token to the fixed
    ///         quarantine address (INV-1/INV-2). Protected set: USDC, the venue
    ///         receipt/share token, and the custodied basket token — reverts on
    ///         those; they stay in NAV and accrue pro-rata.
    /// @param token Foreign ERC-20 to quarantine.
    function sweepForeignToken(address token) external;

    /// @notice The USDC token address this adapter denominates in. Consumed
    ///         unchanged by the vault's `_isAdapterEligible` asset-match probe.
    function USDC() external view returns (address);

    /// @notice The single vault this adapter is bound to. Load-bearing identity
    ///         binding that prevents cross-vault authority substitution; MUST NOT
    ///         be relaxed for adapter reuse (spec §2, ADR-0010 §2).
    function VAULT() external view returns (address);
}
