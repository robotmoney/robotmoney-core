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
    /// Unix seconds of the most recently anchored receipt.
    pub last_recorded_at: i64,
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

    let body = MissingReceiptAlertPayload {
        event_action: "trigger",
        routing_key: "watchdog",
        payload: MissingReceiptAlertInner {
            summary,
            severity: "critical",
            source: "watchdog",
            custom_details: MissingReceiptDetails {
                alert_kind: "consensus_receipt_missing",
                chain_id: event.chain_id,
                last_recorded_at: event.last_recorded_at,
                observed_at: event.now,
                seconds_since_last_receipt: event.seconds_since,
                budget_secs: event.budget_secs,
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

/// PagerDuty Events v2 -shaped envelope for a missing-receipt page.
#[derive(Debug, Serialize)]
struct MissingReceiptAlertPayload {
    event_action: &'static str,
    routing_key: &'static str,
    payload: MissingReceiptAlertInner,
}

#[derive(Debug, Serialize)]
struct MissingReceiptAlertInner {
    summary: String,
    severity: &'static str,
    source: &'static str,
    custom_details: MissingReceiptDetails,
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
