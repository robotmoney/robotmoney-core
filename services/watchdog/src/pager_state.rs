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
use tracing::error;

use crate::receipt_liveness::{AlertPager, PageAction, PagerState};
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

/// Create the watchdog's private tables if they do not exist: the pager state
/// and the proxy-change baseline
/// ([`crate::upgrade_monitor::PROXY_BASELINE_DDL`], issue 1856).
pub async fn ensure_pager_state_table(pool: &PgPool) -> Result<(), WatchdogError> {
    sqlx::query(PAGER_STATE_DDL).execute(pool).await?;
    sqlx::query(crate::upgrade_monitor::PROXY_BASELINE_DDL)
        .execute(pool)
        .await?;
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

/// Remove every row of `chain_id` whose `dedup_key` starts with `prefix`.
///
/// Volume-breach keys name one block's breach (DI-7). They only matter while
/// that block is being retried; once the cursor has moved past it they are
/// dropped so the table does not grow by one row per breached block forever.
pub async fn clear_pager_states_with_prefix(
    pool: &PgPool,
    chain_id: i64,
    prefix: &str,
) -> Result<u64, WatchdogError> {
    let r = sqlx::query(
        "DELETE FROM watchdog_pager_state \
         WHERE chain_id = $1 AND substr(dedup_key, 1, length($2)) = $2",
    )
    .bind(chain_id)
    .bind(prefix)
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// Commit the outcome of one dispatch and persist the pager's durable state.
///
/// Task T08: nothing is committed before the receiver confirmed. On a failed
/// delivery the pager stays armed and refuses to retry before its failure
/// floor, so a hard-down receiver is neither hammered at the 12 s poll rate nor
/// silenced for a whole publishing cadence.
///
/// Shared by the standing-condition pagers in `main` and the volume-breach
/// alerts in [`crate::watchdog::run_cycle`] (DI-7), so every page the watchdog
/// sends goes through one deliver-then-commit seam.
pub async fn commit_page(
    pool: &PgPool,
    pager: &mut AlertPager,
    chain_id: i64,
    dedup_key: &str,
    now: i64,
    action: PageAction,
    sent: Result<(), WatchdogError>,
) {
    let ok = match &sent {
        Ok(()) => true,
        Err(e) => {
            error!(dedup_key, "alert dispatch failed, pager stays armed: {e}");
            false
        }
    };
    if pager.on_page_result(now, action, ok) {
        if let Err(e) = save_pager_state(pool, chain_id, dedup_key, pager.state()).await {
            // Durability is best-effort: losing the write must not take the
            // monitor off-line, but it must never be silent, because the next
            // restart is then the one that forgets an open incident.
            error!(dedup_key, "pager state persist failed: {e}");
        }
    }
}
