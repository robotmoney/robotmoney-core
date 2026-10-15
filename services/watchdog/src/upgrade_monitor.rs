//! Proxy upgrade and freeze alerts (issue 1810).
//!
//! Canonical: docs/technical/contract-upgradeability-plan.md — Release modes and proof
//! (monitors track proxy implementation and freeze state).
//!
//! Every proxied core contract emits ERC-1967 `Upgraded(implementation)` and
//! `UpgradesFrozen(proxy, implementation, codeHash)`, which the explorer
//! indexer stores in `admin_events` with `contract_kind = 'proxy'` (migration
//! 0019). Deploying a proxy emits `Upgraded` (and, frozen at deploy,
//! `UpgradesFrozen`) in its deployment block. Anything in a LATER block is a
//! governed change: an upgrade that replaced the implementation, or a delayed
//! freeze. Each one pages the on-call operator exactly once.
//!
//! Alert-only: an upgrade never pauses the gateway. The rule assumes the
//! indexer starts at or before each proxy's deployment block, so the first
//! indexed `Upgraded` is the deployment.

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

/// (contract, event_name, block_number, log_index, tx_hash, detail) of one `admin_events` row.
type ProxyEventRow = (Vec<u8>, String, i64, i32, Vec<u8>, String);

/// Governed proxy changes for `chain_id`: proxy events in a later block than
/// the contract's first indexed `Upgraded`, oldest first.
pub async fn governed_proxy_changes(
    pool: &PgPool,
    chain_id: i64,
) -> Result<Vec<ProxyChange>, WatchdogError> {
    let rows: Vec<ProxyEventRow> = sqlx::query_as(
        "SELECT e.contract, e.event_name, e.block_number, e.log_index, e.tx_hash, e.detail \
         FROM admin_events e \
         JOIN (SELECT contract, MIN(block_number) AS deploy_block FROM admin_events \
               WHERE chain_id = $1 AND contract_kind = 'proxy' AND event_name = 'Upgraded' \
               GROUP BY contract) d ON d.contract = e.contract \
         WHERE e.chain_id = $1 AND e.contract_kind = 'proxy' AND e.block_number > d.deploy_block \
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
pub async fn alert_new_proxy_changes(
    pool: &PgPool,
    client: &Client,
    webhook_url: Option<&str>,
    chain_id: i64,
    now: i64,
) -> Result<usize, WatchdogError> {
    let mut paged = 0;
    for change in governed_proxy_changes(pool, chain_id).await? {
        let key = change.dedup_key();
        if load_pager_state(pool, chain_id, &key)
            .await?
            .is_some_and(|s| s.firing)
        {
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
