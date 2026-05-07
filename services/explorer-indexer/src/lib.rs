//! Canonical: docs/implementation-plan.md §11 — Phase 5 — Simple Web Explorer API and Database.
//! Decision record: docs/technical/explorer-schema-decisions.md (issue #56).
//! Implements: issue #57 / PR #76.
//!
//! Postgres-backed, JSON-RPC-only indexer that polls a Base-mainnet-shaped
//! chain every `tick_seconds` (default 12) for logs emitted by the
//! configured `IGateway` and `RobotMoneyVault` contracts, decodes them,
//! and writes idempotent rows to the nine §11 minimum tables. State
//! snapshots (`vault_snapshots`, `wallet_positions`) are written either
//! on event-driven triggers (a watched event in a block) or on the
//! `SNAPSHOT_HEARTBEAT_BLOCKS` heartbeat — both keyed
//! `(chain_id, contract, block_number)` so heartbeat snapshots are
//! no-ops when an event already covered the block.
//!
//! Operational invariants:
//! - The indexer never ingests blocks within `CONFIRMATIONS = 5` of
//!   `eth_blockNumber` (ADR §3.3).
//! - Reorgs are detected by hash mismatch on the previously-stored
//!   `last_indexed_block`; recovery is `DELETE WHERE block_number > root`
//!   then re-ingest forward (ADR §3.3).
//! - Every PK starts with `chain_id` (ADR §3.4); re-indexing the same
//!   range is a no-op via `INSERT ... ON CONFLICT DO NOTHING`.
//! - `indexer_runs` records every run (started_at, last_indexed_block,
//!   reorg_count, rows_inserted, error). A failure mid-run captures
//!   the error string and the next run resumes from `last_indexed_block`.

pub mod abi;
pub mod db;
pub mod indexer;
pub mod rpc;

pub use db::Db;
pub use indexer::{run_once, IndexerConfig, IndexerOutcome};
pub use rpc::JsonRpc;

/// Confirmations before a block is considered safe to ingest. ADR §3.3.
pub const CONFIRMATIONS: u64 = 5;

/// Heartbeat interval (in blocks) for state snapshots when no event
/// covered the contract recently. ADR §3.5.
pub const SNAPSHOT_HEARTBEAT_BLOCKS: u64 = 7200;

/// Default polling cadence in seconds. ADR §3.2.
pub const DEFAULT_TICK_SECONDS: u64 = 12;
