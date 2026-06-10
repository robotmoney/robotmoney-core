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
