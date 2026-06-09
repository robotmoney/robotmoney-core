//! Canonical: `docs/development/smoke-test-design.md` — Forked genesis.
//! Plan: `docs/implementation-plan.md` — Multi-vault devnet.
//! Dev-scout: issue #739. Runtime implementation belongs to issue #685.
//!
//! This documentation-only module records the real-adapter state injection
//! seam without changing [`crate::Fixture::new`] or its current
//! `USE_PASSTHROUGH_ADAPTER=true` deployment path.
//!
//! # Injection boundary
//!
//! Issue #685 owns a preparation step immediately before
//! `render_genesis_alloc_overlay` is consumed by [`crate::Fixture`]. That step
//! must produce one geth-compatible alloc overlay containing complete,
//! internally consistent state for all contracts reached by:
//!
//! - `AaveV3Adapter` deposit and withdrawal,
//! - `CompoundV3Adapter` deposit and withdrawal,
//! - `MorphoAdapter` deposit and withdrawal.
//!
//! The output remains an ordinary path passed to
//! `SMOKE_GENESIS_ALLOC_FILE`; compose and `Deploy.s.sol` must not know how the
//! state was captured. A failed or incomplete real-adapter preparation must be
//! fatal once real adapters become the default. It must not silently fall back
//! to the current clean-room/passthrough path.
//!
//! # Ownership and tests
//!
//! Issue #685 exclusively owns `testing/smoke-test`, `testing/fixtures/fork-state`,
//! `testing/ethereum-testnet/config`, `contracts/script/Deploy.s.sol`, and the
//! smoke workflow changes needed for adapter round trips. Its hermetic tests
//! validate the generated alloc before Docker starts; its devnet tests perform
//! deposit/redeem round trips through each real adapter.
//!
//! Issue #658 must not modify those files. Its gateway pause integration test
//! may consume the existing fixture API after #685 lands, but watchdog
//! aggregation, threshold, alert, and pause behavior remains in
//! `services/watchdog`.

// This module intentionally contains no runtime code.
