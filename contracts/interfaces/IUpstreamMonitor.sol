// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IUpstreamMonitor
/// @notice Interface stub for upstream protocol health monitoring integration.
///
/// @dev STUB — issue #702 dev-scout. This interface registers the seam between the
///      RobotMoney gateway/vault stack and a future on-chain upstream-monitoring
///      contract. The upstream monitor will surface real-time health signals from
///      the yield protocols (Aave V3, Compound V3, Morpho) that the strategy
///      adapters interact with, enabling the gateway's circuit-breaker logic to
///      halt deposits or trigger an emergency pause when an upstream protocol
///      exhibits anomalous behaviour (e.g. near-insolvent reserve, abnormal
///      liquidity depth, oracle deviation).
///
/// Integration points discovered by scout (issue #702):
/// - The gateway's authorizeAgent policy includes an `allowedDestinations` field
///   (RobotMoneyGateway.sol, AuthorizedAgent struct). An upstream monitor check
///   could gate agent deposit routing to vaults whose strategy adapter is healthy.
/// - The VaultRegistry (contracts/VaultRegistry.sol) tracks per-vault status
///   (Active, Paused, Deprecated). The monitor could call registry.setVaultStatus()
///   via the PAUSER_ROLE to halt a vault whose upstream protocol is unhealthy.
/// - The FeatureFlags contract (contracts/FeatureFlags.sol) gates experimental
///   features; the monitor could use a feature flag to disable a risk-path before
///   the full circuit-breaker is wired.
/// - No existing on-chain monitor contract in the repo as of scout date 2026-06-07.
///   The monitor contract and its deployment script must be created in a downstream
///   implementation issue.
///
/// Canonical docs: docs/prd.md §10 (risk management), docs/architecture*.md.
interface IUpstreamMonitor {
    /// @notice Returns true if the upstream protocol backing `adapter` is considered
    ///         healthy (adequate liquidity, oracle within bounds, no active exploit).
    /// @dev Implementation TODO: consult Aave/Compound/Morpho on-chain state.
    ///      Should revert with InsufficientData if insufficient oracle rounds exist.
    /// @param adapter The strategy adapter address to query health for.
    /// @return healthy True when the adapter's upstream protocol passes all health checks.
    function isAdapterHealthy(address adapter) external view returns (bool healthy);

    /// @notice Returns the current utilisation ratio for the upstream protocol
    ///         backing `adapter`, in basis points (0–10 000).
    /// @dev Implementation TODO: fetch from Aave IPool.getReserveData(),
    ///      Compound IComet.getUtilization(), or Morpho market state.
    ///      Utilisation > 9 500 bps (95%) is a signal to halt new deposits.
    /// @param adapter The strategy adapter address to query.
    /// @return utilisationBps Current utilisation in basis points.
    function adapterUtilisationBps(address adapter) external view returns (uint256 utilisationBps);

    /// @notice Emitted when a monitored adapter transitions from healthy to unhealthy.
    /// @param adapter The strategy adapter address.
    /// @param reason  A short human-readable reason code (e.g. "utilisation_exceeded").
    event AdapterUnhealthy(address indexed adapter, string reason);

    /// @notice Emitted when a monitored adapter recovers to healthy.
    /// @param adapter The strategy adapter address.
    event AdapterRecovered(address indexed adapter);
}
