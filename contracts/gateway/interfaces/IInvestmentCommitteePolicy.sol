// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §1, §4.8 — no on-chain committee
pragma solidity ^0.8.24;

/// @title IInvestmentCommitteePolicy
/// @notice Retired. The on-chain committee is deleted. This empty interface stays only to type
///         the gateway's retired `icPolicy` storage slot, so the proxy storage layout gate
///         (`scripts/ci/check-core-storage-layout.sh`) sees no removal. It declares nothing.
interface IInvestmentCommitteePolicy {}
