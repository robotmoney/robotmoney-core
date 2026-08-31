//! Alert path integration test.
//!
//! Acceptance criterion (issue #658):
//! > The alert path is covered by a unit test: a mock webhook server receives the
//! > alert payload and the test asserts status 200 and correct threshold/volume
//! > fields in the JSON body.
//!
//! This test stands up a [`MockWebhookServer`], wires up the alert dispatcher,
//! triggers a breach, and asserts that:
//! - The mock received exactly one POST request.
//! - The JSON body contains `threshold_kind`, `threshold_usdc`, and `volume_usdc`
//!   with the correct values.

mod common;

use common::MockWebhookServer;
use reqwest::Client;
use watchdog::alert::{dispatch_alert, BreachEvent, ThresholdKind};

/// Mock webhook receives the alert payload with correct threshold/volume fields.
#[tokio::test]
async fn alert_webhook_receives_correct_payload() {
    let server = MockWebhookServer::start().await;
    let client = Client::new();

    let event = BreachEvent {
        kind: ThresholdKind::PerBlockMint,
        threshold_usdc: 500_000,
        volume_usdc: 750_000,
        chain_id: 8453,
        block_number: 12_345_678,
        vault: None,
    };

    dispatch_alert(&client, &server.url, &event)
        .await
        .expect("alert dispatch must succeed");

    // Give the server's async task a moment to process the connection.
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let captures = server.drain_captures();
    assert_eq!(captures.len(), 1, "exactly one POST must be captured");

    let body: serde_json::Value =
        serde_json::from_slice(&captures[0].body).expect("captured body must be valid JSON");

    // Assert required fields are present with correct values.
    let details = &body["payload"]["custom_details"];

    assert_eq!(
        details["threshold_kind"].as_str().unwrap(),
        "per_block_mint",
        "threshold_kind must match"
    );
    assert_eq!(
        details["threshold_usdc"].as_str().unwrap(),
        "500000",
        "threshold_usdc must be the string representation"
    );
    assert_eq!(
        details["volume_usdc"].as_str().unwrap(),
        "750000",
        "volume_usdc must be the string representation"
    );
    assert_eq!(
        details["chain_id"].as_i64().unwrap(),
        8453,
        "chain_id must match"
    );
    assert_eq!(
        details["block_number"].as_i64().unwrap(),
        12_345_678,
        "block_number must match"
    );
    assert_eq!(
        details["vault"].as_str().unwrap(),
        "global",
        "vault must be 'global' when vault is None"
    );

    // PagerDuty-compatible outer structure.
    assert_eq!(body["event_action"].as_str().unwrap(), "trigger");
    assert_eq!(body["routing_key"].as_str().unwrap(), "watchdog");
    assert_eq!(body["payload"]["severity"].as_str().unwrap(), "critical");

    server.shutdown();
}

/// Multiple breaches dispatch multiple alert payloads.
#[tokio::test]
async fn multiple_breaches_dispatch_multiple_alerts() {
    let server = MockWebhookServer::start().await;
    let client = Client::new();

    let events = vec![
        BreachEvent {
            kind: ThresholdKind::PerBlockMint,
            threshold_usdc: 100_000,
            volume_usdc: 200_000,
            chain_id: 8453,
            block_number: 1,
            vault: None,
        },
        BreachEvent {
            kind: ThresholdKind::PerHourBurn,
            threshold_usdc: 500_000,
            volume_usdc: 600_000,
            chain_id: 8453,
            block_number: 1,
            vault: Some("aabb1234aabb1234aabb1234aabb1234aabb1234".to_owned()),
        },
    ];

    for event in &events {
        dispatch_alert(&client, &server.url, event)
            .await
            .expect("dispatch must succeed");
    }

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let captures = server.drain_captures();
    assert_eq!(captures.len(), 2, "two alerts must be dispatched");

    // First: per_block_mint global
    let b0: serde_json::Value = serde_json::from_slice(&captures[0].body).unwrap();
    assert_eq!(
        b0["payload"]["custom_details"]["threshold_kind"],
        "per_block_mint"
    );

    // Second: per_hour_burn vault-specific
    let b1: serde_json::Value = serde_json::from_slice(&captures[1].body).unwrap();
    assert_eq!(
        b1["payload"]["custom_details"]["threshold_kind"],
        "per_hour_burn"
    );
    assert_eq!(
        b1["payload"]["custom_details"]["vault"],
        "aabb1234aabb1234aabb1234aabb1234aabb1234"
    );

    server.shutdown();
}

/// Issue #1247 AC7: a session that should have produced a receipt and did not
/// raises an alert rather than passing unnoticed.
///
/// Asserts the page is dispatched, is distinguishable from a volume breach by
/// its `alert_kind`, and carries the numbers an operator needs to act: how long
/// the gap has been open and what the budget was.
#[tokio::test]
async fn missing_consensus_receipt_pages_with_a_distinguishable_payload() {
    use watchdog::alert::dispatch_missing_receipt_alert;
    use watchdog::receipt_liveness::{evaluate_receipt_liveness, ReceiptLivenessConfig};

    let cfg = ReceiptLivenessConfig {
        enabled: true,
        expected_cadence_secs: 86_400,
        grace_secs: 21_600,
    };
    // Last receipt anchored 200_000s ago against a 108_000s budget.
    let event = evaluate_receipt_liveness(&cfg, 8453, Some(1_000_000), 1_200_000)
        .expect("a gap this far past budget must be a missing receipt");

    let server = MockWebhookServer::start().await;
    let client = Client::new();

    dispatch_missing_receipt_alert(&client, &server.url, &event)
        .await
        .expect("missing-receipt alert dispatch must succeed");

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let captures = server.drain_captures();
    assert_eq!(captures.len(), 1, "exactly one POST must be captured");

    let body: serde_json::Value =
        serde_json::from_slice(&captures[0].body).expect("captured body must be valid JSON");
    let details = &body["payload"]["custom_details"];

    assert_eq!(
        details["alert_kind"], "consensus_receipt_missing",
        "a missing receipt must be distinguishable from a volume breach"
    );
    assert_eq!(details["chain_id"], 8453);
    assert_eq!(details["last_recorded_at"], 1_000_000);
    assert_eq!(details["observed_at"], 1_200_000);
    assert_eq!(details["seconds_since_last_receipt"], 200_000);
    assert_eq!(details["budget_secs"], 108_000);
    assert_eq!(body["payload"]["severity"], "critical", "this is a page");

    // The volume-breach fields must NOT appear — reusing them would have made
    // the alert unreadable.
    assert!(
        details.get("threshold_usdc").is_none(),
        "a missing receipt is not a USDC volume breach"
    );
}
