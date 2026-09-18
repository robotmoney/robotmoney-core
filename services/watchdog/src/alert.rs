//! Structured webhook/PagerDuty alert dispatcher.
//!
//! Canonical: docs/technical/security-model.md §9 — on-call alert path.
//!
//! When the watchdog detects a threshold breach and the configured action mode
//! includes `"alert"`, [`dispatch_alert`] posts a JSON payload to the configured
//! webhook URL.  The payload schema is compatible with PagerDuty Events API v2
//! (`POST /v2/enqueue`) and generic webhook receivers.
//!
//! # Payload shape
//!
//! ```json
//! {
//!   "event_action": "trigger",
//!   "routing_key": "watchdog",
//!   "payload": {
//!     "summary": "RobotMoney watchdog: per_block_mint threshold breached",
//!     "severity": "critical",
//!     "source": "watchdog",
//!     "custom_details": {
//!       "threshold_kind": "per_block_mint",
//!       "threshold_usdc": "500000",
//!       "volume_usdc": "600000",
//!       "chain_id": 8453,
//!       "block_number": 12345678,
//!       "vault": "global"
//!     }
//!   }
//! }
//! ```

use reqwest::Client;
use serde::Serialize;

use crate::WatchdogError;

/// The kind of threshold that was breached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThresholdKind {
    /// Per-block mint (deposit) volume.
    PerBlockMint,
    /// Per-hour mint (deposit) volume.
    PerHourMint,
    /// Per-block burn (withdrawal) volume.
    PerBlockBurn,
    /// Per-hour burn (withdrawal) volume.
    PerHourBurn,
}

impl ThresholdKind {
    /// Human-readable label for use in alert summaries.
    pub fn label(self) -> &'static str {
        match self {
            ThresholdKind::PerBlockMint => "per_block_mint",
            ThresholdKind::PerHourMint => "per_hour_mint",
            ThresholdKind::PerBlockBurn => "per_block_burn",
            ThresholdKind::PerHourBurn => "per_hour_burn",
        }
    }
}

/// Parameters describing a single threshold breach event.
#[derive(Debug, Clone)]
pub struct BreachEvent {
    /// The kind of threshold breached.
    pub kind: ThresholdKind,
    /// The configured threshold value (USDC base units).
    pub threshold_usdc: u128,
    /// The observed volume that exceeded the threshold (USDC base units).
    pub volume_usdc: u128,
    /// The chain ID on which the breach was detected.
    pub chain_id: i64,
    /// The block number at which the breach was detected.
    pub block_number: i64,
    /// Optional vault address (lowercase hex, no `0x`); `None` for global aggregate checks.
    pub vault: Option<String>,
}

/// JSON body sent to the webhook endpoint.
///
/// This schema is compatible with PagerDuty Events API v2.
#[derive(Debug, Serialize)]
struct AlertPayload {
    event_action: &'static str,
    routing_key: &'static str,
    payload: AlertPayloadInner,
}

/// Inner payload envelope.
#[derive(Debug, Serialize)]
struct AlertPayloadInner {
    summary: String,
    severity: &'static str,
    source: &'static str,
    custom_details: AlertDetails,
}

/// Machine-readable detail fields.
#[derive(Debug, Serialize)]
pub struct AlertDetails {
    /// The kind of threshold breached (e.g. `"per_block_mint"`).
    pub threshold_kind: String,
    /// Threshold in USDC base units (string to avoid JSON integer overflow).
    pub threshold_usdc: String,
    /// Observed volume in USDC base units (string).
    pub volume_usdc: String,
    /// Chain ID.
    pub chain_id: i64,
    /// Block number.
    pub block_number: i64,
    /// Vault address or `"global"`.
    pub vault: String,
}

/// Dispatch a structured alert to the configured webhook URL.
///
/// Returns `Ok(())` on HTTP 200–299.  Any non-2xx response or network error is
/// returned as [`WatchdogError::Alert`].
pub async fn dispatch_alert(
    client: &Client,
    webhook_url: &str,
    event: &BreachEvent,
) -> Result<(), WatchdogError> {
    let vault_label = event.vault.as_deref().unwrap_or("global").to_owned();

    let summary = format!(
        "RobotMoney watchdog: {} threshold breached (volume={}, threshold={}, chain={}, block={})",
        event.kind.label(),
        event.volume_usdc,
        event.threshold_usdc,
        event.chain_id,
        event.block_number,
    );

    let body = AlertPayload {
        event_action: "trigger",
        routing_key: "watchdog",
        payload: AlertPayloadInner {
            summary,
            severity: "critical",
            source: "watchdog",
            custom_details: AlertDetails {
                threshold_kind: event.kind.label().to_owned(),
                threshold_usdc: event.threshold_usdc.to_string(),
                volume_usdc: event.volume_usdc.to_string(),
                chain_id: event.chain_id,
                block_number: event.block_number,
                vault: vault_label,
            },
        },
    };

    let resp = client
        .post(webhook_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| WatchdogError::Alert(format!("webhook POST failed: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(WatchdogError::Alert(format!(
            "webhook returned HTTP {status}: {text}"
        )));
    }

    Ok(())
}

/// Machine-readable detail fields for a consensus-receipt anchoring gap.
///
/// A deliberately separate payload from [`AlertDetails`]: a missing receipt is
/// not a volume breach, and reusing the USDC-shaped fields would have made the
/// alert unreadable. See `receipt_liveness` for why this path never pauses.
#[derive(Debug, Serialize)]
pub struct MissingReceiptDetails {
    /// Always `"consensus_receipt_missing"`.
    pub alert_kind: &'static str,
    /// Chain ID.
    pub chain_id: i64,
    /// Unix seconds of the most recently anchored receipt; null on cold start.
    pub last_recorded_at: Option<i64>,
    /// Persisted timestamp from which the gap was measured.
    pub gap_started_at: i64,
    /// Unix seconds at evaluation time.
    pub observed_at: i64,
    /// Observed anchoring gap, in seconds.
    pub seconds_since_last_receipt: i64,
    /// Configured cadence + grace, in seconds.
    pub budget_secs: u64,
}

/// Dispatch a consensus-receipt anchoring-gap alert.
///
/// Issue #1247 AC7: a session that should have produced a receipt and did not
/// must raise an alert rather than pass unnoticed. This is a **page**, not a
/// warning, and it never pauses the gateway — see
/// [`crate::receipt_liveness`].
///
/// Returns `Ok(())` on HTTP 200–299; any non-2xx or network error is returned
/// as [`WatchdogError::Alert`] so the caller can log it rather than drop it.
pub async fn dispatch_missing_receipt_alert(
    client: &Client,
    webhook_url: &str,
    event: &crate::receipt_liveness::MissingReceiptEvent,
) -> Result<(), WatchdogError> {
    let summary = format!(
        "RobotMoney watchdog: no consensus receipt anchored for {}s (budget={}s, chain={}) \
         — a session that should have produced a receipt did not",
        event.seconds_since, event.budget_secs, event.chain_id,
    );

    // One POST helper for all four consensus-receipt events (T30c). The inline
    // copy this replaces was the odd one out: the next hardening applied to
    // `post_event` — a timeout, a retry, an auth header — would have reached
    // three call sites and silently missed the missing-receipt trigger, which
    // is the one that matters most.
    post_event(
        client,
        webhook_url,
        &MissingReceiptAlertPayload {
            event_action: "trigger",
            routing_key: "watchdog",
            dedup_key: missing_receipt_dedup_key(event.chain_id),
            payload: Some(MissingReceiptAlertInner {
                summary,
                severity: "critical",
                source: "watchdog",
                custom_details: MissingReceiptDetails {
                    alert_kind: "consensus_receipt_missing",
                    chain_id: event.chain_id,
                    last_recorded_at: event.last_recorded_at,
                    gap_started_at: event.gap_started_at,
                    observed_at: event.now,
                    seconds_since_last_receipt: event.seconds_since,
                    budget_secs: event.budget_secs,
                },
            }),
        },
    )
    .await
}

/// PagerDuty Events v2 -shaped envelope for a missing-receipt page.
///
/// `dedup_key` is what turns a condition that stays true into ONE incident.
/// Without it every poll cycle (12 s by default) opened a fresh page, so a
/// devnet that has never anchored a receipt produced roughly 7 200 pages a day
/// and buried the very signal the monitor exists to raise. The same key carries
/// the `"resolve"` event, which is how AC-CORE-09's "successful anchoring
/// resolves the alert" is actually delivered.
#[derive(Debug, Serialize)]
struct MissingReceiptAlertPayload {
    event_action: &'static str,
    routing_key: &'static str,
    dedup_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<MissingReceiptAlertInner>,
}

/// Stable incident key for the consensus-receipt gap on one chain.
pub fn missing_receipt_dedup_key(chain_id: i64) -> String {
    format!("consensus_receipt_missing:{chain_id}")
}

/// Stable incident key for "the monitor is enabled but has no baseline at all".
pub fn no_baseline_dedup_key(chain_id: i64) -> String {
    format!("consensus_receipt_monitor_no_baseline:{chain_id}")
}

/// Stable incident key for "the router's quorum threshold is below the floor".
pub fn quorum_below_floor_dedup_key(chain_id: i64) -> String {
    format!("router_quorum_below_floor:{chain_id}")
}

/// Details for the no-baseline page.
///
/// Its own type rather than a reuse of [`MissingReceiptDetails`] (T30c): a
/// blind monitor has measured nothing, so it has no gap, no budget and no
/// observation time. The reused shape asserted a 0-second gap observed at Unix
/// epoch 0 — three numbers that are not merely absent but wrong, and that read
/// on the receiver as a healthy instantaneous check.
#[derive(Debug, Serialize)]
pub struct NoBaselineDetails {
    /// Always `"consensus_receipt_monitor_no_baseline"`.
    pub alert_kind: &'static str,
    /// Chain ID the monitor is blind on.
    pub chain_id: i64,
}

#[derive(Debug, Serialize)]
struct NoBaselineAlertPayload {
    event_action: &'static str,
    routing_key: &'static str,
    dedup_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<NoBaselineAlertInner>,
}

#[derive(Debug, Serialize)]
struct NoBaselineAlertInner {
    summary: String,
    severity: &'static str,
    source: &'static str,
    custom_details: NoBaselineDetails,
}

/// Details for the router quorum-floor page (task T22, decision D16).
#[derive(Debug, Serialize)]
pub struct QuorumBelowFloorDetails {
    /// Always `"router_quorum_below_floor"`.
    pub alert_kind: &'static str,
    /// Chain the router lives on.
    pub chain_id: i64,
    /// Router address that was read.
    pub router_address: String,
    /// The threshold read from the chain.
    pub quorum_threshold: u64,
    /// The configured floor.
    pub min_quorum_threshold: u64,
}

#[derive(Debug, Serialize)]
struct QuorumAlertPayload {
    event_action: &'static str,
    routing_key: &'static str,
    dedup_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<QuorumAlertInner>,
}

#[derive(Debug, Serialize)]
struct QuorumAlertInner {
    summary: String,
    severity: &'static str,
    source: &'static str,
    custom_details: QuorumBelowFloorDetails,
}

/// Page because `RouterGovernance.quorumThreshold()` is at or below the floor.
///
/// Decision D16: the contract floor stops a *new* deployment from being wired
/// this way; this stops an already-deployed router from being quietly lowered
/// by an `ADMIN_ROLE` holder after `AC-GOV-03`'s evidence was collected.
pub async fn dispatch_quorum_below_floor_alert(
    client: &Client,
    webhook_url: &str,
    breach: &crate::governance::QuorumBreach,
) -> Result<(), WatchdogError> {
    post_event(
        client,
        webhook_url,
        &QuorumAlertPayload {
            event_action: "trigger",
            routing_key: "watchdog",
            dedup_key: quorum_below_floor_dedup_key(breach.chain_id),
            payload: Some(QuorumAlertInner {
                summary: format!(
                    "RobotMoney watchdog: RouterGovernance.quorumThreshold() is {} on chain {} \
                     (floor {}) — one voter is a quorum. AC-GOV-03 was accepted on two-of-two; \
                     check who called setQuorumThreshold and restore the threshold.",
                    breach.threshold, breach.chain_id, breach.min_threshold,
                ),
                severity: "critical",
                source: "watchdog",
                custom_details: QuorumBelowFloorDetails {
                    alert_kind: "router_quorum_below_floor",
                    chain_id: breach.chain_id,
                    router_address: breach.router_address.clone(),
                    quorum_threshold: breach.threshold,
                    min_quorum_threshold: breach.min_threshold,
                },
            }),
        },
    )
    .await
}

/// Resolve the quorum-floor page once the threshold is back at or above it.
pub async fn dispatch_quorum_below_floor_resolve(
    client: &Client,
    webhook_url: &str,
    chain_id: i64,
) -> Result<(), WatchdogError> {
    post_event(
        client,
        webhook_url,
        &QuorumAlertPayload {
            event_action: "resolve",
            routing_key: "watchdog",
            dedup_key: quorum_below_floor_dedup_key(chain_id),
            payload: None,
        },
    )
    .await
}

#[derive(Debug, Serialize)]
struct MissingReceiptAlertInner {
    summary: String,
    severity: &'static str,
    source: &'static str,
    custom_details: MissingReceiptDetails,
}

/// Post the `"resolve"` event for a consensus-receipt gap on `chain_id`.
///
/// AC-CORE-09 requires that "successful anchoring resolves the alert". A
/// trigger with no matching resolve leaves the incident open forever and
/// teaches on-call to ignore the key, which is the same failure as not paging
/// at all. Sent once, on the first cycle the gap comes back within budget.
pub async fn dispatch_missing_receipt_resolve(
    client: &Client,
    webhook_url: &str,
    chain_id: i64,
) -> Result<(), WatchdogError> {
    post_event(
        client,
        webhook_url,
        &MissingReceiptAlertPayload {
            event_action: "resolve",
            routing_key: "watchdog",
            dedup_key: missing_receipt_dedup_key(chain_id),
            payload: None,
        },
    )
    .await
}

/// Page because the monitor is enabled but has no baseline to measure against.
///
/// `receipt_liveness` can only measure a gap from a persisted timestamp: the
/// last anchored receipt, or failing that the earliest `indexer_runs.started_at`
/// for the configured chain. When neither exists the check returns "no event",
/// which is byte-identical to "healthy" at the call site — so a watchdog
/// pointed at the wrong `--chain-id` (the CLI used to default to Base mainnet's
/// 8453 while the Fusion devnet is 918453) reported perfect health while seeing
/// nothing at all. That state is a fault, and it pages.
pub async fn dispatch_no_baseline_alert(
    client: &Client,
    webhook_url: &str,
    chain_id: i64,
) -> Result<(), WatchdogError> {
    post_event(
        client,
        webhook_url,
        &NoBaselineAlertPayload {
            event_action: "trigger",
            routing_key: "watchdog",
            dedup_key: no_baseline_dedup_key(chain_id),
            payload: Some(NoBaselineAlertInner {
                summary: format!(
                    "RobotMoney watchdog: consensus-receipt monitor has NO baseline on chain \
                     {chain_id} — no anchored receipt and no indexer run for this chain id. \
                     The monitor is blind, not healthy; check WATCHDOG_CHAIN_ID."
                ),
                severity: "critical",
                source: "watchdog",
                custom_details: NoBaselineDetails {
                    alert_kind: "consensus_receipt_monitor_no_baseline",
                    chain_id,
                },
            }),
        },
    )
    .await
}

/// Resolve the no-baseline page once a baseline exists.
pub async fn dispatch_no_baseline_resolve(
    client: &Client,
    webhook_url: &str,
    chain_id: i64,
) -> Result<(), WatchdogError> {
    post_event(
        client,
        webhook_url,
        &NoBaselineAlertPayload {
            event_action: "resolve",
            routing_key: "watchdog",
            dedup_key: no_baseline_dedup_key(chain_id),
            payload: None,
        },
    )
    .await
}

/// The single POST seam every consensus-receipt and governance event goes
/// through. Generic over the payload so there is exactly one place to add a
/// timeout, a retry or an auth header (T30c).
async fn post_event<B: Serialize>(
    client: &Client,
    webhook_url: &str,
    body: &B,
) -> Result<(), WatchdogError> {
    let resp = client
        .post(webhook_url)
        .json(body)
        .send()
        .await
        .map_err(|e| WatchdogError::Alert(format!("webhook POST failed: {e}")))?;
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

    #[test]
    fn threshold_kind_labels_are_distinct() {
        let labels = [
            ThresholdKind::PerBlockMint.label(),
            ThresholdKind::PerHourMint.label(),
            ThresholdKind::PerBlockBurn.label(),
            ThresholdKind::PerHourBurn.label(),
        ];
        let unique: std::collections::HashSet<_> = labels.iter().collect();
        assert_eq!(
            unique.len(),
            labels.len(),
            "each ThresholdKind must have a unique label"
        );
    }

    #[test]
    fn dedup_keys_are_stable_per_chain_and_distinct_per_condition() {
        assert_eq!(
            missing_receipt_dedup_key(918_453),
            "consensus_receipt_missing:918453"
        );
        assert_ne!(
            missing_receipt_dedup_key(918_453),
            missing_receipt_dedup_key(8_453),
            "two chains must not collapse into one incident"
        );
        assert_ne!(
            missing_receipt_dedup_key(918_453),
            no_baseline_dedup_key(918_453),
            "a blind monitor is a different incident from an observed gap"
        );
    }

    #[test]
    fn a_resolve_carries_the_same_key_and_no_payload() {
        let body = MissingReceiptAlertPayload {
            event_action: "resolve",
            routing_key: "watchdog",
            dedup_key: missing_receipt_dedup_key(918_453),
            payload: None,
        };
        let v = serde_json::to_value(&body).unwrap();
        assert_eq!(v["event_action"], "resolve");
        assert_eq!(v["dedup_key"], "consensus_receipt_missing:918453");
        assert!(
            v.get("payload").is_none(),
            "a resolve must not re-send the trigger body"
        );
    }

    #[test]
    fn the_no_baseline_payload_asserts_no_numbers_it_never_measured() {
        // T30c regression: the no-baseline page used to reuse MissingReceiptDetails
        // and ship gap_started_at=0, observed_at=0, seconds_since_last_receipt=0,
        // budget_secs=0 — a 0-second gap observed at the Unix epoch.
        let v = serde_json::to_value(NoBaselineDetails {
            alert_kind: "consensus_receipt_monitor_no_baseline",
            chain_id: 918_453,
        })
        .unwrap();
        assert_eq!(v["alert_kind"], "consensus_receipt_monitor_no_baseline");
        assert_eq!(v["chain_id"], 918_453);
        for absent in [
            "gap_started_at",
            "observed_at",
            "seconds_since_last_receipt",
            "budget_secs",
            "last_recorded_at",
        ] {
            assert!(
                v.get(absent).is_none(),
                "a blind monitor must not report {absent}: it measured nothing"
            );
        }
    }

    #[test]
    fn quorum_dedup_key_is_its_own_incident_per_chain() {
        assert_eq!(
            quorum_below_floor_dedup_key(918_453),
            "router_quorum_below_floor:918453"
        );
        assert_ne!(
            quorum_below_floor_dedup_key(918_453),
            missing_receipt_dedup_key(918_453)
        );
        assert_ne!(
            quorum_below_floor_dedup_key(918_453),
            quorum_below_floor_dedup_key(8_453)
        );
    }

    #[test]
    fn a_quorum_resolve_carries_the_key_and_no_payload() {
        let v = serde_json::to_value(QuorumAlertPayload {
            event_action: "resolve",
            routing_key: "watchdog",
            dedup_key: quorum_below_floor_dedup_key(918_453),
            payload: None,
        })
        .unwrap();
        assert_eq!(v["event_action"], "resolve");
        assert_eq!(v["dedup_key"], "router_quorum_below_floor:918453");
        assert!(v.get("payload").is_none());
    }

    #[test]
    fn alert_details_serializes_string_amounts() {
        let details = AlertDetails {
            threshold_kind: "per_block_mint".to_owned(),
            threshold_usdc: "500000".to_owned(),
            volume_usdc: "600000".to_owned(),
            chain_id: 8453,
            block_number: 99,
            vault: "global".to_owned(),
        };
        let v = serde_json::to_value(&details).unwrap();
        assert_eq!(v["threshold_usdc"], "500000");
        assert_eq!(v["volume_usdc"], "600000");
        assert_eq!(v["chain_id"], 8453);
    }
}
