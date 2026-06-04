// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0006-despxa-rwa-vault-design.md §2 — Chronicle NAV oracle
pragma solidity ^0.8.24;

/// @title IChronicleOracle
/// @notice Minimal interface for Chronicle Protocol's on-chain push oracles.
///
///         Chronicle oracles are push-updated by a network of authorised attestors
///         ("Validators"). Each feed stores the latest signed price and the timestamp
///         at which it was written on-chain. Consumers call `latestAnswer()` to read
///         the price and `latestTimestamp()` to check freshness.
///
///         Note on access control: Chronicle feeds on Base are "self-kissed" for the
///         RwaVault contract address at deployment time via Chronicle's `kiss()` API.
///         Calls from non-kissed addresses revert; the vault's address must be
///         whitelisted before it can read the feed.
///
///         Chronicle deSPXA NAV feed on Base (mainnet):
///           0xc9Bc046d3a832f5Fb5cf24e8cb7Bb15Fe6F1b9e
///         Heartbeat: 24 hours (feed is pushed at least once every 24 h by Chronicle).
///
/// @dev The Chronicle IChronicle interface is defined in the Chronicle Solidity SDK:
///      https://github.com/chronicleprotocol/chronicle-std
///      We use a minimal subset — `latestAnswer` + `latestTimestamp` — to avoid
///      pulling in the full Chronicle SDK as a dependency.
interface IChronicleOracle {
    /// @notice Returns the latest pushed price, scaled to 18 decimals.
    /// @dev Reverts if the caller is not whitelisted ("kissed") by Chronicle.
    ///      Reverts if no price has been pushed yet.
    /// @return price Latest NAV price, 18-decimal fixed-point (WAD).
    function latestAnswer() external view returns (uint256 price);

    /// @notice Returns the Unix timestamp of the last price push.
    /// @dev Used by the vault to enforce the staleness heartbeat check.
    /// @return timestamp Unix timestamp (seconds) when `latestAnswer` was last updated.
    function latestTimestamp() external view returns (uint256 timestamp);
}
