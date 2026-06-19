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
//! `Deploy.s.sol` deploys the three real adapters unconditionally — the
//! test-only no-yield deploy hatch was removed in issue #912, so every devnet
//! boot exercises real Aave V3 / Compound V3 / Morpho protocol state.
//!
//! # Ownership
//!
//! Issue #685 owns `testing/smoke-test`, `testing/fixtures/fork-state`,
//! `testing/ethereum-testnet/config`, `contracts/script/Deploy.s.sol`, and
//! `scripts/devnet/snapshot-fork.sh`. Issue #658 consumes the fixture API
//! after #685 lands.

// This module intentionally contains no runtime code.
