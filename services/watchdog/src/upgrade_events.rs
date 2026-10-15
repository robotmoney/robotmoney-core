//! Upgrade and freeze alerts (issue 1810 monitoring scope, ADR-0014 §3, §5).
//!
//! Canonical: `docs/adr/ADR-0014-governed-upgrades-and-freeze.md` §3 (OZ
//! `Upgraded` marks each upgrade) and §5 (`UpgradesFrozen` marks the one-way
//! freeze); `docs/operations/contract-release-runbooks.md` §4.12.
//!
//! # Why this exists
//!
//! Every proxied Robot Money contract can get new logic through Safe →
//! timelock → `upgradeToAndCall`, and each proxy can be frozen for good. Both
//! are scheduled in public for the timelock delay, but nothing told on-call
//! when one executed. An executed upgrade that nobody reviewed is the one
//! event operators most need to see: rmpc refuses to sign against an
//! unapproved implementation, so an unexpected upgrade also stops every agent
//! write until someone looks.
//!
//! # What it does
//!
//! It reads the indexer's `proxy_upgrade_events` table (migration 0024), the
//! same database the volume checks read. Each poll pages once for every
//! `upgraded` or `frozen` row after its cursor, oldest first, with a dedup key
//! per event (`proxy_upgrade:<chain>:<block>:<log index>`). The page names the
//! proxy, the new implementation, the transaction and, for a freeze, the
//! frozen code hash, and asks on-call to match it against the release issue.
//! The cursor moves past a row only once its page was sent, so a webhook
//! outage retries instead of dropping the event.
//!
//! At startup the cursor is set to the newest row indexed more than
//! `startup_lookback_secs` ago (default: the 48 hour Base timelock delay), so a
//! restart re-pages recent events instead of missing the ones that landed
//! while the daemon was down, and old history never pages.
//!
//! Read-only: SQL reads only. It never pauses, upgrades or freezes anything.
//! The missed-deadline alert is [`crate::freeze_deadline`].

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::postgres::PgPool;

use crate::WatchdogError;

/// Default startup lookback: the Base mainnet timelock delay (172 800 s).
pub const DEFAULT_UPGRADE_EVENTS_STARTUP_LOOKBACK_SECS: u64 = 172_800;

/// At most this many events page in one poll; the rest wait for the next.
pub const UPGRADE_EVENTS_PER_POLL: i64 = 50;

/// Configuration for the upgrade and freeze alert (`[upgrade_events]`).
///
/// Absent means enabled with the defaults: every deployment has proxies, so an
/// executed upgrade must page unless an operator turns it off on purpose.
#[derive(Debug, Clone, Deserialize)]
pub struct UpgradeEventsConfig {
    /// Whether the check runs.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// How far back the startup cursor reaches (see the module doc).
    #[serde(default = "default_startup_lookback_secs")]
    pub startup_lookback_secs: u64,
}

fn default_enabled() -> bool {
    true
}

fn default_startup_lookback_secs() -> u64 {
    DEFAULT_UPGRADE_EVENTS_STARTUP_LOOKBACK_SECS
}

impl Default for UpgradeEventsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            startup_lookback_secs: DEFAULT_UPGRADE_EVENTS_STARTUP_LOOKBACK_SECS,
        }
    }
}

/// `(block_number, log_index)` of the last event already paged.
pub type UpgradeCursor = (i64, i32);

/// One indexed `Upgraded` or `UpgradesFrozen` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeEvent {
    /// Chain the event is on.
    pub chain_id: i64,
    /// Block of the event.
    pub block_number: i64,
    /// Log index in the block.
    pub log_index: i32,
    /// `0x`-prefixed transaction hash.
    pub tx_hash: String,
    /// `0x`-prefixed proxy address.
    pub contract: String,
    /// `upgraded` or `frozen`.
    pub kind: String,
    /// `0x`-prefixed implementation the proxy runs from now on, or froze on.
    pub implementation: String,
    /// `frozen` only: `0x`-prefixed runtime code hash the freeze named.
    pub code_hash: Option<String>,
}

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// The startup cursor: the newest event indexed at least `lookback_secs` ago,
/// or `None` when there is none (every indexed event then pages once).
pub async fn startup_cursor(
    pool: &PgPool,
    chain_id: i64,
    lookback_secs: u64,
) -> Result<Option<UpgradeCursor>, WatchdogError> {
    let lookback = i64::try_from(lookback_secs).unwrap_or(i64::MAX);
    let row: Option<(i64, i32)> = sqlx::query_as(
        "SELECT block_number, log_index FROM proxy_upgrade_events \
         WHERE chain_id = $1 AND indexed_at <= now() - make_interval(secs => $2::double precision) \
         ORDER BY block_number DESC, log_index DESC LIMIT 1",
    )
    .bind(chain_id)
    .bind(lookback as f64)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Events after `cursor` (all of them when `None`), oldest first, at most
/// [`UPGRADE_EVENTS_PER_POLL`].
pub async fn events_after(
    pool: &PgPool,
    chain_id: i64,
    cursor: Option<UpgradeCursor>,
) -> Result<Vec<UpgradeEvent>, WatchdogError> {
    let (block, log) = cursor.unwrap_or((-1, -1));
    #[allow(clippy::type_complexity)]
    let rows: Vec<(i64, i32, Vec<u8>, Vec<u8>, String, Vec<u8>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT block_number, log_index, tx_hash, contract, kind, implementation, code_hash \
             FROM proxy_upgrade_events \
             WHERE chain_id = $1 AND (block_number, log_index) > ($2, $3) \
             ORDER BY block_number, log_index LIMIT $4",
    )
    .bind(chain_id)
    .bind(block)
    .bind(log)
    .bind(UPGRADE_EVENTS_PER_POLL)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(block_number, log_index, tx, contract, kind, implementation, code_hash)| {
                UpgradeEvent {
                    chain_id,
                    block_number,
                    log_index,
                    tx_hash: hex0x(&tx),
                    contract: hex0x(&contract),
                    kind,
                    implementation: hex0x(&implementation),
                    code_hash: code_hash.as_deref().map(hex0x),
                }
            },
        )
        .collect())
}

/// Stable incident key of one event.
pub fn upgrade_event_dedup_key(e: &UpgradeEvent) -> String {
    format!(
        "proxy_upgrade:{}:{}:{}",
        e.chain_id, e.block_number, e.log_index
    )
}

#[derive(Debug, Serialize)]
struct UpgradeEventPayload {
    event_action: &'static str,
    routing_key: &'static str,
    dedup_key: String,
    payload: UpgradeEventInner,
}

#[derive(Debug, Serialize)]
struct UpgradeEventInner {
    summary: String,
    severity: &'static str,
    source: &'static str,
    custom_details: UpgradeEventDetails,
}

/// What the page carries for one event.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct UpgradeEventDetails {
    /// `proxy_upgraded` or `proxy_frozen`.
    pub alert_kind: &'static str,
    /// Chain of the event.
    pub chain_id: i64,
    /// The proxy.
    pub proxy: String,
    /// The implementation from now on (or frozen on).
    pub implementation: String,
    /// `frozen` only: the frozen runtime code hash.
    pub code_hash: Option<String>,
    /// The transaction (the timelock execute).
    pub tx_hash: String,
    /// Block of the event.
    pub block_number: i64,
}

/// The page summary and details of one event. Pure.
pub fn upgrade_event_alert(e: &UpgradeEvent) -> (String, &'static str, UpgradeEventDetails) {
    let frozen = e.kind == "frozen";
    let summary = if frozen {
        format!(
            "RobotMoney watchdog: proxy {} on chain {} froze for good on implementation {} \
             (code hash {}) in tx {} at block {}. No upgrade can ever run on it again. Confirm \
             it is the freeze the release issue scheduled (contract-release-runbooks.md §4.12).",
            e.contract,
            e.chain_id,
            e.implementation,
            e.code_hash.as_deref().unwrap_or("unknown"),
            e.tx_hash,
            e.block_number,
        )
    } else {
        format!(
            "RobotMoney watchdog: proxy {} on chain {} now runs implementation {} (Upgraded, tx \
             {} at block {}). Confirm it is the reviewed upgrade the release issue scheduled. rmpc \
             refuses every write until operators pin the new implementation's code hash.",
            e.contract, e.chain_id, e.implementation, e.tx_hash, e.block_number,
        )
    };
    let details = UpgradeEventDetails {
        alert_kind: if frozen {
            "proxy_frozen"
        } else {
            "proxy_upgraded"
        },
        chain_id: e.chain_id,
        proxy: e.contract.clone(),
        implementation: e.implementation.clone(),
        code_hash: e.code_hash.clone(),
        tx_hash: e.tx_hash.clone(),
        block_number: e.block_number,
    };
    // An upgrade changes the logic users and agents sign against: warning. A
    // freeze ends upgrades for good and needs no action beyond a match: info.
    (summary, if frozen { "info" } else { "warning" }, details)
}

/// Post the page for one event.
pub async fn dispatch_upgrade_event_alert(
    client: &Client,
    webhook_url: &str,
    e: &UpgradeEvent,
) -> Result<(), WatchdogError> {
    let (summary, severity, custom_details) = upgrade_event_alert(e);
    let body = UpgradeEventPayload {
        event_action: "trigger",
        routing_key: "watchdog",
        dedup_key: upgrade_event_dedup_key(e),
        payload: UpgradeEventInner {
            summary,
            severity,
            source: "watchdog",
            custom_details,
        },
    };
    let resp = client
        .post(webhook_url)
        .json(&body)
        .send()
        .await
        .map_err(|err| WatchdogError::Alert(format!("webhook POST failed: {err}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(WatchdogError::Alert(format!(
            "webhook returned HTTP {status}: {text}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str) -> UpgradeEvent {
        UpgradeEvent {
            chain_id: 8453,
            block_number: 100,
            log_index: 3,
            tx_hash: format!("0x{}", "ab".repeat(32)),
            contract: "0x00000000000000000000000000000000000000aa".into(),
            kind: kind.into(),
            implementation: "0x00000000000000000000000000000000000001a1".into(),
            code_hash: (kind == "frozen").then(|| format!("0x{}", "cd".repeat(32))),
        }
    }

    #[test]
    fn an_upgrade_pages_as_a_warning_naming_proxy_implementation_and_tx() {
        let e = event("upgraded");
        let (summary, severity, details) = upgrade_event_alert(&e);
        assert_eq!(severity, "warning");
        assert_eq!(details.alert_kind, "proxy_upgraded");
        assert!(summary.contains(&e.contract), "{summary}");
        assert!(summary.contains(&e.implementation), "{summary}");
        assert!(summary.contains(&e.tx_hash), "{summary}");
        assert_eq!(upgrade_event_dedup_key(&e), "proxy_upgrade:8453:100:3");
    }

    #[test]
    fn a_freeze_pages_with_the_frozen_code_hash() {
        let e = event("frozen");
        let (summary, severity, details) = upgrade_event_alert(&e);
        assert_eq!(severity, "info");
        assert_eq!(details.alert_kind, "proxy_frozen");
        assert!(summary.contains(&"cd".repeat(32)), "{summary}");
        assert_eq!(details.code_hash, e.code_hash);
    }

    #[test]
    fn absent_config_is_enabled_with_the_timelock_delay_lookback() {
        let c: UpgradeEventsConfig = toml::from_str("").unwrap();
        assert!(c.enabled);
        assert_eq!(c.startup_lookback_secs, 172_800);
        let off: UpgradeEventsConfig = toml::from_str("enabled = false").unwrap();
        assert!(!off.enabled);
    }
}
