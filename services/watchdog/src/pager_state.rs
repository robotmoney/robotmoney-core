//! Durable [`AlertPager`](crate::receipt_liveness::AlertPager) state.
//!
//! Canonical: `docs/architecture.md` §4.9; `AC-CORE-09` ("successful anchoring
//! resolves the alert").
//!
//! # Why the incident side must be durable too
//!
//! The *detection* side of the receipt-liveness monitor was deliberately made
//! restart-durable: the cold-start baseline is `MIN(indexer_runs.started_at)`,
//! so a restart cannot reset the observation window. The *incident* side was
//! not. It lived in two `let mut` bindings in `main()`, so a watchdog restarted
//! while `consensus_receipt_missing:<chain>` was open came back believing it had
//! never paged; `on_clear()` then returned `None` forever and the incident never
//! closed. On-call learns to ignore a key that never resolves, which is the same
//! failure as not paging at all.
//!
//! One row per `(chain_id, dedup_key)` holds exactly what the alert receiver is
//! believed to know. The table is created by the watchdog itself rather than by
//! an explorer-indexer migration: it is watchdog-private operational state, not
//! part of the indexed chain record the explorer schema describes, and the
//! watchdog already holds the pool.

use sqlx::PgPool;

use crate::receipt_liveness::PagerState;
use crate::WatchdogError;

/// DDL for the watchdog's private pager-state table.
///
/// `CREATE TABLE IF NOT EXISTS` is deliberate: the watchdog may start against a
/// database migrated by any explorer-indexer version, and a missing table must
/// not be a startup failure that takes the monitor off-line.
pub const PAGER_STATE_DDL: &str = "CREATE TABLE IF NOT EXISTS watchdog_pager_state (\
     chain_id BIGINT NOT NULL, \
     dedup_key TEXT NOT NULL, \
     firing BOOLEAN NOT NULL, \
     last_paged_at BIGINT, \
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), \
     PRIMARY KEY (chain_id, dedup_key))";

/// Create the pager-state table if it does not exist.
pub async fn ensure_pager_state_table(pool: &PgPool) -> Result<(), WatchdogError> {
    sqlx::query(PAGER_STATE_DDL).execute(pool).await?;
    Ok(())
}

/// Load the persisted state for one incident key, or `None` if this process is
/// the first to touch it.
pub async fn load_pager_state(
    pool: &PgPool,
    chain_id: i64,
    dedup_key: &str,
) -> Result<Option<PagerState>, WatchdogError> {
    let row: Option<(bool, Option<i64>)> = sqlx::query_as(
        "SELECT firing, last_paged_at FROM watchdog_pager_state \
         WHERE chain_id = $1 AND dedup_key = $2",
    )
    .bind(chain_id)
    .bind(dedup_key)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(firing, last_paged_at)| PagerState {
        firing,
        last_paged_at,
    }))
}

/// Persist the state for one incident key.
///
/// Called only after a **confirmed** delivery, so what the table holds is what
/// the receiver was actually told.
pub async fn save_pager_state(
    pool: &PgPool,
    chain_id: i64,
    dedup_key: &str,
    state: PagerState,
) -> Result<(), WatchdogError> {
    sqlx::query(
        "INSERT INTO watchdog_pager_state (chain_id, dedup_key, firing, last_paged_at, updated_at) \
         VALUES ($1, $2, $3, $4, now()) \
         ON CONFLICT (chain_id, dedup_key) DO UPDATE SET \
           firing = EXCLUDED.firing, \
           last_paged_at = EXCLUDED.last_paged_at, \
           updated_at = now()",
    )
    .bind(chain_id)
    .bind(dedup_key)
    .bind(state.firing)
    .bind(state.last_paged_at)
    .execute(pool)
    .await?;
    Ok(())
}
