// Robot Money explorer HTTP API.
//
// Canonical docs:
//   - docs/implementation-plan.md §11 (Phase 5 — Simple Web Explorer API and Database)
//   - docs/technical/explorer-schema-decisions.md (DB engine, indexer cadence,
//     reorg handling, per-table idempotency keys, ingestion model)
//
// Boundary (§11): this crate is read-only. It MUST NOT sign, authorize, or
// otherwise mutate state. Every response surfaces `block_number` and
// `indexed_at` so consumers can distinguish indexed reads from live chain
// reads (§11 acceptance criterion).

pub mod error;
pub mod model;
pub mod routes;
pub mod state;

pub use routes::router;
pub use state::AppState;
