//! Proxy upgrade and freeze alerts (issue 1810).
//!
//! Canonical: docs/technical/contract-upgradeability-plan.md — Release modes and proof
//! (monitors track proxy implementation and freeze state).
//!
//! Every proxied core contract emits ERC-1967 `Upgraded(implementation)` and
//! `UpgradesFrozen(proxy, implementation, codeHash)`, which the explorer
//! indexer stores in `admin_events` with `contract_kind = 'proxy'` (migration
//! 0019). Deploying a proxy emits `Upgraded` (and, frozen at deploy,
//! `UpgradesFrozen`) in its creation transaction. Every other proxy event is a
//! governed change: an upgrade that replaced the implementation, or a delayed
//! freeze. Each one pages the on-call operator exactly once.
//!
//! An event is the deployment only when its transaction created THIS proxy
//! (issue 1840). The indexer checks the receipt's `contractAddress` against the
//! emitting proxy and marks such rows `"deployment": true` in `detail`. Every
//! other proxy event pages, including:
//!
//! - an upgrade executed from a throwaway contract's constructor. The
//!   timelock's executor role is open, so that transaction is a contract
//!   creation, but it did not create the proxy;
//! - an upgrade in the proxy's deploy block sent by another transaction;
//! - the first indexed upgrade of a registry-discovered vault, or of a
//!   contract added to the config after the cursor passed its deploy block.
//!   The old rule took "the first indexed `Upgraded`" as the deployment, so
//!   that upgrade was never paged, and a freeze before it was dropped.
//!
//! A deployment row the indexer could not mark (no receipt, or a proxy created
//! by a factory) pages once too: a spurious page is recoverable, a silent
//! upgrade is not.
//!
//! # History older than the first run (issue 1856)
//!
//! The indexer's proxy backfill inserts every historical proxy event at once,
//! including deploy-time rows indexed before the deployment mark existed. Paging
//! each of them would bury the pages that matter. So on its first run the
//! monitor records a baseline block in `watchdog_proxy_baseline`: the indexer's
//! cursor (`MAX(last_indexed_block)`), which is also the upper bound of the
//! backfill. A proxy event at or below the baseline was indexable before the
//! monitor ever ran. It is logged once and recorded in the pager state as seen,
//! never paged. Every event above the baseline pages as before, including one
//! between the cursor and the chain head that live ingestion indexes later.
//!
//! The baseline is taken once and kept, and only by a watchdog that never ran
//! before on this database. Only the startup call (`first_start = true`) may
//! take the cursor, before the first cycle writes anything. If the chain already
//! has a `watchdog_cursor` row or any `watchdog_pager_state` row, an older
//! watchdog ran here. It may have seen a real upgrade whose page was never
//! delivered (webhook down or unset), so the baseline is `-1` and nothing is
//! seeded. With nothing indexed at startup the baseline is `-1` at once. After
//! a failed startup call the first later call stores `-1`, never the cursor:
//! an indexer run that commits after startup could otherwise cover an upgrade
//! mined after the watchdog started and silence it (issue 1868). Storing `-1`
//! at startup also closes that window for a restart or a second replica before
//! the first cycle. Every doubtful case pages.
//!
//! Alert-only: an upgrade never pauses the gateway.

use reqwest::Client;
use serde::Serialize;
use sqlx::PgPool;

use crate::alert::post_event;
use crate::pager_state::{load_pager_state, save_pager_state};
use crate::receipt_liveness::PagerState;
use crate::WatchdogError;

/// One governed change to a proxied core contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyChange {
    /// Chain id.
    pub chain_id: i64,
    /// The proxy (0x-prefixed lowercase hex).
    pub contract: String,
    /// `Upgraded` or `UpgradesFrozen`.
    pub event_name: String,
    /// Block of the event.
    pub block_number: i64,
    /// Log index of the event.
    pub log_index: i32,
    /// Transaction hash (0x-prefixed hex).
    pub tx_hash: String,
    /// The implementation the event names.
    pub implementation: Option<String>,
    /// For a freeze: the frozen implementation's code hash.
    pub code_hash: Option<String>,
}

impl ProxyChange {
    /// One incident per event, so a change is paged once and never again.
    pub fn dedup_key(&self) -> String {
        format!(
            "proxy_change:{}:{}:{}:{}",
            self.chain_id, self.contract, self.block_number, self.log_index
        )
    }

    /// Human summary for the page.
    pub fn summary(&self) -> String {
        let implementation = self.implementation.as_deref().unwrap_or("unknown");
        if self.event_name == "UpgradesFrozen" {
            format!(
                "RobotMoney watchdog: core contract {} upgrades permanently frozen at implementation \
                 {implementation} (block {}, chain {})",
                self.contract, self.block_number, self.chain_id
            )
        } else {
            format!(
                "RobotMoney watchdog: core contract {} UPGRADED to implementation {implementation} \
                 (block {}, chain {}) — verify it is the reviewed release and update every signing \
                 client's pin",
                self.contract, self.block_number, self.chain_id
            )
        }
    }
}

/// DDL for the proxy-change baseline (issue 1856, see the module doc). Created
/// by the watchdog with its pager state, for the same reason: it is
/// watchdog-private operational state.
pub const PROXY_BASELINE_DDL: &str = "CREATE TABLE IF NOT EXISTS watchdog_proxy_baseline (\
     chain_id BIGINT NOT NULL, \
     baseline_block BIGINT NOT NULL, \
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), \
     PRIMARY KEY (chain_id))";

/// The block at or below which a proxy event predates the monitor's first run
/// (see the module doc). Taken on the first call that stores one, and kept.
/// With `first_start` (the startup call, before the first cycle writes the
/// watchdog cursor) it is the indexer cursor when no watchdog ran on this
/// database before and something is indexed, else `-1`. Without `first_start`
/// a missing baseline is stored as `-1`, so every unpaged change pages
/// (issue 1868). `None` only if the stored row vanished after the insert.
pub async fn proxy_change_baseline(
    pool: &PgPool,
    chain_id: i64,
    first_start: bool,
) -> Result<Option<i64>, WatchdogError> {
    let stored = "SELECT baseline_block FROM watchdog_proxy_baseline WHERE chain_id = $1";
    if let Some(b) = sqlx::query_scalar(stored)
        .bind(chain_id)
        .fetch_optional(pool)
        .await?
    {
        return Ok(Some(b));
    }
    // Nothing indexed at startup stores -1 at once: a restart or a second
    // replica after the indexer's first run must not take its cursor.
    let baseline = if first_start {
        cursor_baseline(pool, chain_id).await?.unwrap_or(-1)
    } else {
        -1
    };
    sqlx::query(
        "INSERT INTO watchdog_proxy_baseline (chain_id, baseline_block) VALUES ($1, $2) \
         ON CONFLICT (chain_id) DO NOTHING",
    )
    .bind(chain_id)
    .bind(baseline)
    .execute(pool)
    .await?;
    tracing::info!(
        chain_id,
        baseline,
        "proxy change baseline recorded: proxy events at or below this block predate the \
         watchdog's first run and are not paged"
    );
    // Another watchdog may have stored its own first: theirs stands.
    Ok(sqlx::query_scalar(stored)
        .bind(chain_id)
        .fetch_optional(pool)
        .await?)
}

/// The startup baseline: the indexer cursor when no watchdog ran on this
/// database before, else `-1`. `None` when nothing is indexed yet.
async fn cursor_baseline(pool: &PgPool, chain_id: i64) -> Result<Option<i64>, WatchdogError> {
    let ran_before: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM watchdog_cursor WHERE chain_id = $1) \
             OR EXISTS (SELECT 1 FROM watchdog_pager_state WHERE chain_id = $1)",
    )
    .bind(chain_id)
    .fetch_one(pool)
    .await?;
    if ran_before {
        return Ok(Some(-1));
    }
    Ok(sqlx::query_scalar(
        "SELECT MAX(last_indexed_block) FROM indexer_runs \
         WHERE chain_id = $1 AND error IS NULL",
    )
    .bind(chain_id)
    .fetch_one(pool)
    .await?)
}

/// (contract, event_name, block_number, log_index, tx_hash, detail) of one `admin_events` row.
type ProxyEventRow = (Vec<u8>, String, i64, i32, Vec<u8>, String);

/// Governed proxy changes for `chain_id`, oldest first: every proxy event
/// the indexer did not mark as its proxy's deployment (see the module doc).
pub async fn governed_proxy_changes(
    pool: &PgPool,
    chain_id: i64,
) -> Result<Vec<ProxyChange>, WatchdogError> {
    let rows: Vec<ProxyEventRow> = sqlx::query_as(
        "SELECT e.contract, e.event_name, e.block_number, e.log_index, e.tx_hash, e.detail \
         FROM admin_events e \
         WHERE e.chain_id = $1 AND e.contract_kind = 'proxy' \
           AND (e.detail::jsonb -> 'deployment') IS DISTINCT FROM 'true'::jsonb \
         ORDER BY e.block_number, e.log_index",
    )
    .bind(chain_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(contract, event_name, block_number, log_index, tx_hash, detail)| {
                let detail: serde_json::Value =
                    serde_json::from_str(&detail).unwrap_or(serde_json::Value::Null);
                let field = |k: &str| detail.get(k).and_then(|v| v.as_str()).map(str::to_string);
                ProxyChange {
                    chain_id,
                    contract: format!("0x{}", hex::encode(contract)),
                    event_name,
                    block_number,
                    log_index,
                    tx_hash: format!("0x{}", hex::encode(tx_hash)),
                    implementation: field("implementation"),
                    code_hash: field("code_hash"),
                }
            },
        )
        .collect())
}

#[derive(Debug, Serialize)]
struct ProxyChangePayload {
    event_action: &'static str,
    routing_key: &'static str,
    dedup_key: String,
    payload: ProxyChangeInner,
}

#[derive(Debug, Serialize)]
struct ProxyChangeInner {
    summary: String,
    severity: &'static str,
    source: &'static str,
    custom_details: ProxyChangeDetails,
}

#[derive(Debug, Serialize)]
struct ProxyChangeDetails {
    alert_kind: &'static str,
    chain_id: i64,
    contract: String,
    event_name: String,
    block_number: i64,
    tx_hash: String,
    implementation: Option<String>,
    code_hash: Option<String>,
}

/// Post one change to the webhook. An upgrade is `critical`; a freeze, which
/// only removes the upgrade path, is `warning`.
pub async fn dispatch_proxy_change_alert(
    client: &Client,
    webhook_url: &str,
    change: &ProxyChange,
) -> Result<(), WatchdogError> {
    let frozen = change.event_name == "UpgradesFrozen";
    post_event(
        client,
        webhook_url,
        &ProxyChangePayload {
            event_action: "trigger",
            routing_key: "watchdog",
            dedup_key: change.dedup_key(),
            payload: ProxyChangeInner {
                summary: change.summary(),
                severity: if frozen { "warning" } else { "critical" },
                source: "watchdog",
                custom_details: ProxyChangeDetails {
                    alert_kind: if frozen {
                        "proxy_upgrades_frozen"
                    } else {
                        "proxy_upgraded"
                    },
                    chain_id: change.chain_id,
                    contract: change.contract.clone(),
                    event_name: change.event_name.clone(),
                    block_number: change.block_number,
                    tx_hash: change.tx_hash.clone(),
                    implementation: change.implementation.clone(),
                    code_hash: change.code_hash.clone(),
                },
            },
        },
    )
    .await
}

/// Page every governed change not paged before. Returns how many were paged
/// in this call. A change is recorded as paged only after the webhook
/// confirmed it, so a failed delivery is retried next cycle. With no webhook
/// configured nothing is recorded and every cycle logs the change again.
///
/// A change at or below the [`proxy_change_baseline`] predates the monitor's
/// first run: it is logged once and recorded as seen, not paged (issue 1856).
pub async fn alert_new_proxy_changes(
    pool: &PgPool,
    client: &Client,
    webhook_url: Option<&str>,
    chain_id: i64,
    now: i64,
) -> Result<usize, WatchdogError> {
    let mut paged = 0;
    // Fail toward paging: without a baseline every change pages. Only startup
    // may take the cursor as the baseline (issue 1868).
    let baseline = match proxy_change_baseline(pool, chain_id, false).await {
        Ok(b) => b,
        Err(e) => {
            tracing::error!(
                chain_id,
                "proxy change baseline unavailable, paging every unpaged proxy change: {e}"
            );
            None
        }
    };
    for change in governed_proxy_changes(pool, chain_id).await? {
        let key = change.dedup_key();
        if load_pager_state(pool, chain_id, &key)
            .await?
            .is_some_and(|s| s.firing)
        {
            continue;
        }
        if let Some(baseline) = baseline.filter(|b| change.block_number <= *b) {
            tracing::warn!(
                dedup_key = %key,
                baseline,
                "not paged: this proxy change predates the watchdog's first run. {}",
                change.summary()
            );
            save_pager_state(
                pool,
                chain_id,
                &key,
                PagerState {
                    firing: true,
                    last_paged_at: None,
                },
            )
            .await?;
            continue;
        }
        tracing::error!(dedup_key = %key, "{}", change.summary());
        let Some(url) = webhook_url else {
            tracing::error!(
                dedup_key = %key,
                "proxy change detected but action.webhook_url is unset — the alert had nowhere to go"
            );
            continue;
        };
        match dispatch_proxy_change_alert(client, url, &change).await {
            Ok(()) => {
                save_pager_state(
                    pool,
                    chain_id,
                    &key,
                    PagerState {
                        firing: true,
                        last_paged_at: Some(now),
                    },
                )
                .await?;
                paged += 1;
            }
            Err(e) => tracing::error!(dedup_key = %key, "proxy change alert failed: {e}"),
        }
    }
    Ok(paged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(event_name: &str) -> ProxyChange {
        ProxyChange {
            chain_id: 8453,
            contract: "0x1111111111111111111111111111111111111111".into(),
            event_name: event_name.into(),
            block_number: 42,
            log_index: 3,
            tx_hash: format!("0x{}", "ab".repeat(32)),
            implementation: Some("0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b".into()),
            code_hash: None,
        }
    }

    #[test]
    fn each_event_is_its_own_incident() {
        let a = change("Upgraded");
        let mut b = a.clone();
        b.log_index = 4;
        assert_ne!(a.dedup_key(), b.dedup_key());
        assert_eq!(
            a.dedup_key(),
            "proxy_change:8453:0x1111111111111111111111111111111111111111:42:3"
        );
    }

    #[test]
    fn summaries_name_the_contract_the_implementation_and_the_kind() {
        let up = change("Upgraded").summary();
        assert!(up.contains("UPGRADED") && up.contains("0x2b2b"), "{up}");
        let frozen = change("UpgradesFrozen").summary();
        assert!(frozen.contains("permanently frozen"), "{frozen}");
    }
}
