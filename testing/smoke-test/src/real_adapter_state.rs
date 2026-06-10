//! Canonical: `docs/development/smoke-test-design.md` — Forked genesis.
//! Dev-scout: issue #739. Implemented by issue #685.
//!
//! This documentation-only module records the real-adapter state injection
//! boundary implemented by issue #685.
//!
//! # What changed (issue #685)
//!
//! `scripts/devnet/snapshot-fork.sh` now executes a deposit→redeem round-trip
//! through each real adapter (Aave V3, Compound V3, Morpho) after the forge
//! deploy. This forces anvil to fetch the reserve config, liquidity/borrow
//! index, aToken supply, Comet base tracking, and Morpho market+position slots
//! into the fork cache and dirties every slot the round-trip writes, so
//! `--dump-state` captures the working set. The committed
//! `testing/fixtures/fork-state/genesis-alloc.json` now carries real protocol
//! storage for all three adapters.
//!
//! [`crate::Fixture::new`] no longer passes `USE_PASSTHROUGH_ADAPTER=true`.
//! `Deploy.s.sol` deploys real adapters by default. `PassthroughAdapter` is
//! retained as a debugging escape hatch only (pass `USE_PASSTHROUGH_ADAPTER=true`
//! via [`crate::Fixture::with_deploy_env`] if needed).
//!
//! # Ownership
//!
//! Issue #685 owns `testing/smoke-test`, `testing/fixtures/fork-state`,
//! `testing/ethereum-testnet/config`, `contracts/script/Deploy.s.sol`, and
//! `scripts/devnet/snapshot-fork.sh`. Issue #658 consumes the fixture API
//! after #685 lands.

// This module intentionally contains no runtime code.
