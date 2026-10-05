//! Canonical: `docs/development/smoke-test-design.md` — Forked genesis.
//! Dev-scout: issue #739. Implemented by issue #685.
//!
//! This documentation-only module records the real-adapter state injection
//! boundary implemented by issue #685.
//!
//! # Real adapter state
//!
//! The Twin chain (core 1498) is a pinned lazy fork of real Base state made with anvil, so the
//! real Aave V3, Compound V3 and Morpho protocol storage is served on demand from the upstream
//! node. There is no saved state snapshot to warm and nothing is injected or patched.
//!
//! `DeployVault.s.sol` deploys the three real adapters unconditionally (the test-only no-yield
//! deploy hatch was removed in issue #912), so every devnet boot exercises real protocol state.
//!
//! # Ownership
//!
//! Issue #685 owns `testing/smoke-test`, `testing/ethereum-testnet/config` and
//! `contracts/script/DeployVault.s.sol`.

// This module intentionally contains no runtime code.
