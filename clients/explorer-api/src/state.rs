// Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
// (See also: docs/technical/explorer-schema-decisions.md §4)
// Shared HTTP-handler state.
//
// Chain scoping contract (docs/technical/explorer-schema-decisions.md §4):
// explorer-api is a single-chain service. `chain_id` is bound at startup
// from the `EXPLORER_API_CHAIN_ID` environment variable and injected into
// every query that touches tables with a `chain_id` column. No request
// parameter can override the configured chain. This prevents a DB that
// indexes multiple chains from leaking rows across chains when two chains
// share an address or identifier.

use sqlx::PgPool;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// EIP-155 chain id this instance is scoped to. Set from
    /// `EXPLORER_API_CHAIN_ID` at startup; all queries filter on this
    /// value. Changing the chain requires restarting with a new env var.
    pub chain_id: i64,
}

impl AppState {
    pub fn new(pool: PgPool, chain_id: i64) -> Self {
        Self { pool, chain_id }
    }
}
