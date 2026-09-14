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
    let event = evaluate_receipt_liveness(&cfg, 8453, Some(1_000_000), None, 1_200_000)
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
    assert_eq!(details["gap_started_at"], 1_000_000);
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

// ---- T08: nothing is committed before the receiver confirmed ---------------

/// A non-2xx receiver must leave the pager armed and must not silence the page
/// for a whole publishing cadence.
///
/// This is the regression for the defect as it stood: `on_firing` stamped
/// `last_paged_at` before any I/O and `main()` only logged the dispatch error,
/// so ONE transient non-2xx silenced the missing-receipt page for
/// `expected_cadence_secs` — 86 400 s on the committed staging profile,
/// including the `no_baseline` page whose whole job is to say the monitor is
/// blind. Driven through the real dispatcher and a real HTTP failure, not a
/// mocked `Result`.
#[tokio::test]
async fn a_non_2xx_receiver_leaves_the_missing_receipt_pager_armed() {
    use common::FailingWebhookServer;
    use watchdog::alert::dispatch_missing_receipt_alert;
    use watchdog::receipt_liveness::{
        AlertPager, MissingReceiptEvent, PageAction, RETRY_FLOOR_CEILING_SECS,
    };

    let down = FailingWebhookServer::start(503).await;
    let client = Client::new();

    // The committed staging cadence, so the silence this used to cause is the
    // silence being asserted against.
    let mut pager = AlertPager::new(86_400);
    let event = MissingReceiptEvent {
        chain_id: 918_453,
        last_recorded_at: None,
        gap_started_at: 1_000,
        now: 90_000,
        seconds_since: 89_000,
        budget_secs: 108_000,
    };

    let action = pager.on_firing(event.now);
    assert_eq!(action, PageAction::Trigger);
    let sent = dispatch_missing_receipt_alert(&client, &down.url, &event).await;
    assert!(
        sent.is_err(),
        "a 503 receiver must be reported as a failure"
    );
    pager.on_page_result(event.now, action, sent.is_ok());

    assert!(
        !pager.is_firing(),
        "an undelivered trigger must not be recorded as an open incident"
    );
    assert_eq!(
        pager.state().last_paged_at,
        None,
        "nothing reached a human, so nothing may be committed"
    );
    assert_eq!(
        pager.on_firing(event.now + RETRY_FLOOR_CEILING_SECS as i64),
        PageAction::Trigger,
        "the retry is due one 60s failure floor later, not 86 400s later"
    );
    // ...and the poll cycles inside the floor do not hammer the down receiver.
    assert_eq!(pager.on_firing(event.now + 12), PageAction::None);
    assert_eq!(pager.on_firing(event.now + 48), PageAction::None);

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    assert_eq!(
        down.request_count(),
        1,
        "exactly one POST was attempted against the down receiver"
    );
    down.shutdown();
}

/// A recovered receiver commits the trigger, and the resolve then closes it.
#[tokio::test]
async fn a_confirmed_delivery_commits_and_the_resolve_closes_the_incident() {
    use watchdog::alert::{dispatch_missing_receipt_alert, dispatch_missing_receipt_resolve};
    use watchdog::receipt_liveness::{AlertPager, MissingReceiptEvent, PageAction};

    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let mut pager = AlertPager::new(300);
    let event = MissingReceiptEvent {
        chain_id: 918_453,
        last_recorded_at: Some(1_000),
        gap_started_at: 1_000,
        now: 1_500,
        seconds_since: 500,
        budget_secs: 360,
    };

    let action = pager.on_firing(event.now);
    assert_eq!(action, PageAction::Trigger);
    let sent = dispatch_missing_receipt_alert(&client, &server.url, &event).await;
    assert!(sent.is_ok());
    assert!(pager.on_page_result(event.now, action, true));
    assert!(pager.is_firing());

    let action = pager.on_clear(1_600);
    assert_eq!(action, PageAction::Resolve);
    let sent = dispatch_missing_receipt_resolve(&client, &server.url, 918_453).await;
    assert!(sent.is_ok());
    assert!(pager.on_page_result(1_600, action, true));
    assert!(!pager.is_firing());

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    let caps = server.drain_captures();
    assert_eq!(caps.len(), 2, "one trigger, one resolve");
    let trigger: serde_json::Value = serde_json::from_slice(&caps[0].body).unwrap();
    let resolve: serde_json::Value = serde_json::from_slice(&caps[1].body).unwrap();
    assert_eq!(trigger["event_action"], "trigger");
    assert_eq!(resolve["event_action"], "resolve");
    assert_eq!(
        trigger["dedup_key"], resolve["dedup_key"],
        "the resolve must carry the same incident key, or on-call sees an \
         incident that never closes"
    );
    server.shutdown();
}

/// The no-baseline page reports only what a blind monitor actually knows (T30c).
#[tokio::test]
async fn the_no_baseline_page_reports_no_gap_numbers_it_never_measured() {
    use watchdog::alert::dispatch_no_baseline_alert;

    let server = MockWebhookServer::start().await;
    let client = Client::new();
    dispatch_no_baseline_alert(&client, &server.url, 918_453)
        .await
        .expect("dispatch");

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    let caps = server.drain_captures();
    assert_eq!(caps.len(), 1);
    let v: serde_json::Value = serde_json::from_slice(&caps[0].body).unwrap();
    assert_eq!(
        v["dedup_key"],
        "consensus_receipt_monitor_no_baseline:918453"
    );
    let d = &v["payload"]["custom_details"];
    assert_eq!(d["alert_kind"], "consensus_receipt_monitor_no_baseline");
    assert_eq!(d["chain_id"], 918_453);
    for absent in [
        "gap_started_at",
        "observed_at",
        "seconds_since_last_receipt",
        "budget_secs",
        "last_recorded_at",
    ] {
        assert!(
            d.get(absent).is_none(),
            "the wire payload must not assert {absent}: the monitor measured nothing"
        );
    }
    server.shutdown();
}

/// The quorum-floor page is its own incident with the numbers on it (T22/D16).
#[tokio::test]
async fn a_quorum_below_the_floor_pages_with_the_observed_threshold() {
    use watchdog::alert::dispatch_quorum_below_floor_alert;
    use watchdog::governance::QuorumBreach;

    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let breach = QuorumBreach {
        chain_id: 918_453,
        router_address: format!("0x{}", "ab".repeat(20)),
        threshold: 1,
        min_threshold: 2,
    };
    dispatch_quorum_below_floor_alert(&client, &server.url, &breach)
        .await
        .expect("dispatch");

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    let caps = server.drain_captures();
    assert_eq!(caps.len(), 1);
    let v: serde_json::Value = serde_json::from_slice(&caps[0].body).unwrap();
    assert_eq!(v["event_action"], "trigger");
    assert_eq!(v["dedup_key"], "router_quorum_below_floor:918453");
    let d = &v["payload"]["custom_details"];
    assert_eq!(d["alert_kind"], "router_quorum_below_floor");
    assert_eq!(d["quorum_threshold"], 1);
    assert_eq!(d["min_quorum_threshold"], 2);
    assert_eq!(d["router_address"], breach.router_address);
    assert!(v["payload"]["summary"]
        .as_str()
        .unwrap()
        .contains("one voter is a quorum"));
    server.shutdown();
}
