//! Canonical: `docs/technical/security-model.md` §9.
//! Plan: `docs/implementation-plan.md` — Operational safeguards.
//! Dev-scout: issue #739. Runtime implementation belongs to issue #658.
//!
//! This crate is intentionally behavior-free. It partitions the watchdog into
//! three adapters so issue #658 can test aggregation independently from
//! Postgres, signer/RPC, and alert transports:
//!
//! - [`VolumeSource`] reads canonical mint and burn observations.
//! - [`GatewayPauser`] submits the gateway `pause()` transaction.
//! - [`AlertSink`] dispatches the structured breach notification.
//!
//! # Indexer boundary
//!
//! The source implementation belongs in issue #658 and may add read-only query
//! helpers to `services/explorer-indexer/src/db.rs`. Mint volume must use
//! `agent_deposits` for single-vault deposits and `router_deposit_legs` for
//! routed per-vault attribution without double-counting the routed parent row.
//! Burn volume must use `account_history_events.kind = 'withdrawal'` (or a
//! dedicated equivalent selected by #658), because the deposit tables contain
//! no withdrawals. Queries must be bounded by chain, finalized block, and UTC
//! timestamp for reorg-safe per-block and rolling-hour totals.
//!
//! # Gateway boundary
//!
//! The pauser implementation belongs in issue #658. It targets
//! `RobotMoneyGateway.pause()` with a separately funded `PAUSER_ROLE` signer.
//! The watchdog must never own unpause or admin authority. Submission,
//! confirmation, retry, idempotency, and signer custody are deliberately not
//! implemented by this scout.
//!
//! # Ownership
//!
//! Issue #658 exclusively owns this crate, watchdog-specific indexer queries,
//! pause/alert transports, and watchdog unit/integration tests. Issue #685
//! exclusively owns smoke fixture state injection, genesis artifacts,
//! `Deploy.s.sol` adapter selection, and real-adapter round-trip tests.

use std::error::Error;

/// Boxed adapter error used by the compile-safe boundary.
pub type AdapterError = Box<dyn Error + Send + Sync + 'static>;

/// Inclusive finalized-chain range to aggregate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ObservationWindow {
    /// Chain whose indexed observations are queried.
    pub chain_id: u64,
    /// First finalized block included in the query.
    pub from_block: u64,
    /// Last finalized block included in the query.
    pub through_block: u64,
    /// Earliest Unix timestamp included in the rolling-hour query.
    pub since_unix_seconds: u64,
}

/// Asset movement observed for one vault and window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VolumeObservation {
    /// Vault address, or `None` for a global aggregate.
    pub vault: Option<[u8; 20]>,
    /// Minted/deposited asset units.
    pub mint_units: u128,
    /// Burned/withdrawn asset units.
    pub burn_units: u128,
}

/// Read-only source for finalized mint and burn observations.
pub trait VolumeSource {
    /// Return global and per-vault observations for `window`.
    fn observe(&self, window: ObservationWindow) -> Result<Vec<VolumeObservation>, AdapterError>;
}

/// Threshold breach passed to pause and alert adapters.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThresholdBreach {
    /// Chain where the breach occurred.
    pub chain_id: u64,
    /// Vault address, or `None` for a global threshold.
    pub vault: Option<[u8; 20]>,
    /// Finalized block at which the breach was evaluated.
    pub observed_at_block: u64,
    /// Observed asset units.
    pub observed_units: u128,
    /// Configured maximum asset units.
    pub threshold_units: u128,
    /// Dimension that exceeded its threshold.
    pub dimension: ThresholdDimension,
}

/// Supported threshold dimensions from the security model.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThresholdDimension {
    /// Mint volume in one block.
    MintPerBlock,
    /// Mint volume in the rolling hour.
    MintPerHour,
    /// Burn volume in one block.
    BurnPerBlock,
    /// Burn volume in the rolling hour.
    BurnPerHour,
}

/// Minimal gateway emergency action owned by a `PAUSER_ROLE` signer.
pub trait GatewayPauser {
    /// Submit `RobotMoneyGateway.pause()` for the supplied breach.
    fn pause(&self, breach: ThresholdBreach) -> Result<(), AdapterError>;
}

/// Structured on-call notification boundary.
pub trait AlertSink {
    /// Dispatch one breach notification within the configured SLA.
    fn send(&self, breach: ThresholdBreach) -> Result<(), AdapterError>;
}
