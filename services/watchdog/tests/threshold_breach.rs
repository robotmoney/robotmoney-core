//! Threshold-breach watchdog cycle integration test.
//!
//! Acceptance criterion (issue #658):
//! > The automated-pause path is covered by an integration test: a fixture replays
//! > deposits that exceed the per-block threshold and asserts the watchdog cycle
//! > detects the breach.
//!
//! Note on scope: this test proves the full detection pipeline — DB queries, threshold
//! comparison, and breach reporting — without actually calling `gateway.pauseDeposits()` on
//! a real chain (which would require a funded account and a live devnet).  The pause
//! call itself is tested by unit tests in `pause.rs` (selector, RLP encoding) and
//! validated by the CI fork-integration suite.  A future issue can add an end-to-end
//! test against a local Anvil instance.

mod common;

use bigdecimal::BigDecimal;
use common::pg_fixture;
use reqwest::Client;
use std::collections::HashMap;
use watchdog::{
    alert::ThresholdKind,
    config::{ActionConfig, ActionMode, Config, GlobalThresholds, SlaConfig, VaultThresholds},
    pager_state::ensure_pager_state_table,
    receipt_liveness::ReceiptLivenessConfig,
    watchdog::{load_cursor, run_cycle, run_cycles_since_cursor, store_cursor, CycleResult},
};

/// Seed a chain + block into the DB, then insert `agent_deposits` rows.
async fn seed_deposits(pool: &sqlx::PgPool, chain_id: i64, block_number: i64, amounts: &[u64]) {
    sqlx::query(
        "INSERT INTO chains (chain_id, name, rpc_label) VALUES ($1, 'test', 'test') ON CONFLICT DO NOTHING",
    )
    .bind(chain_id)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO blocks (chain_id, block_number, hash, parent_hash, timestamp) \
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    )
    .bind(chain_id)
    .bind(block_number)
    .bind(&[0u8; 32][..])
    .bind(&[0u8; 32][..])
    .bind(1_700_000_000i64)
    .execute(pool)
    .await
    .unwrap();

    // Use a dummy contract address for agent deposits.
    sqlx::query(
        "INSERT INTO contracts (chain_id, address, kind) VALUES ($1, $2, 'gateway') ON CONFLICT DO NOTHING",
    )
    .bind(chain_id)
    .bind(&[0xAAu8; 20][..])
    .execute(pool)
    .await
    .unwrap();

    for (i, &amount) in amounts.iter().enumerate() {
        let amount_decimal = BigDecimal::from(amount);
        let log_index = i as i32;
        // Single-vault gateway deposits carry a non-NULL `vault`. Mint volume
        // counts agent_deposits only when vault IS NOT NULL (the NULL-vault rows
        // are routed-deposit parents, deduped against router_deposit_legs — see
        // volume.rs / IDX-7), so the seed must set a vault to register here.
        // Distinct tx_hash per row so the direct-deposit dedup can't elide them.
        let mut tx = [0u8; 32];
        tx[0] = (block_number & 0xff) as u8;
        tx[1] = i as u8;
        sqlx::query(
            "INSERT INTO agent_deposits \
             (chain_id, block_number, log_index, tx_hash, payment_id, order_id, agent, share_receiver, amount, shares_minted, window_id, vault) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) \
             ON CONFLICT DO NOTHING",
        )
        .bind(chain_id)
        .bind(block_number)
        .bind(log_index)
        .bind(&tx[..])
        .bind(&[0u8; 32][..])
        .bind(&[0u8; 32][..])
        .bind(&[0xBBu8; 20][..])
        .bind(&[0xCCu8; 20][..])
        .bind(amount_decimal)
        .bind(BigDecimal::from(0u64))
        .bind(1i64)
        .bind(&[0xCCu8; 20][..])
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Seed a successful indexer_runs row so `latest_indexed_block` returns data.
#[allow(dead_code)]
async fn seed_indexer_run(pool: &sqlx::PgPool, chain_id: i64, last_block: i64) {
    sqlx::query(
        "INSERT INTO indexer_runs (chain_id, from_block, last_indexed_block, finished_at, rows_inserted, reorg_count) \
         VALUES ($1, $2, $3, now(), 0, 0)",
    )
    .bind(chain_id)
    .bind(last_block)
    .bind(last_block)
    .execute(pool)
    .await
    .unwrap();
}

/// Build a test config with a tight per-block mint threshold and alert mode.
fn make_alert_config(per_block_mint: u64, webhook_url: &str) -> Config {
    Config {
        // Not used by these tests: the chain id reaches the poll loop from the CLI.
        chain_id: None,
        global: GlobalThresholds {
            per_block_mint_limit_usdc: per_block_mint.to_string(),
            per_hour_mint_limit_usdc: "999999999999".to_owned(), // effectively unlimited
            per_block_burn_limit_usdc: "999999999999".to_owned(),
            per_hour_burn_limit_usdc: "999999999999".to_owned(),
        },
        action: ActionConfig {
            mode: ActionMode::Alert,
            webhook_url: Some(webhook_url.to_owned()),
            gateway_rpc_url: None,
            gateway_address: None,
            pauser_private_key_hex: None,
            pause_fee_bump_bps: 1500,
        },
        sla: SlaConfig {
            max_response_secs: 300,
        },
        vault: HashMap::new(),
        // The consensus-receipt liveness monitor is off by default, so these
        // volume-path fixtures are unaffected by it (issue #1247 task 4.13).
        consensus_receipts: ReceiptLivenessConfig::default(),
        governance: Default::default(),
        indexer_lag: Default::default(),
    }
}

/// Deposits that exceed the per-block threshold → watchdog detects breach.
#[tokio::test]
async fn per_block_mint_breach_detected() {
    let fx = pg_fixture().await;

    use common::MockWebhookServer;
    let server = MockWebhookServer::start().await;
    let config = make_alert_config(500_000, &server.url);
    let client = Client::new();

    let chain_id = 8453i64;
    let block_number = 1000i64;

    // Seed deposits totalling 600_000 (> 500_000 threshold).
    seed_deposits(&fx.pool, chain_id, block_number, &[300_000, 300_000]).await;

    let result = run_cycle(&fx.pool, &config, &client, chain_id, block_number, None)
        .await
        .expect("cycle must not error");

    // The cycle must report a breach.
    match result {
        CycleResult::Breached(kinds) => {
            assert!(
                kinds.contains(&ThresholdKind::PerBlockMint),
                "PerBlockMint must be in breached kinds; got: {kinds:?}"
            );
        }
        other => panic!("expected Breached, got {other:?}"),
    }

    // The mock server must have received the alert.
    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    let captures = server.drain_captures();
    assert!(
        !captures.is_empty(),
        "at least one alert must have been dispatched"
    );

    let body: serde_json::Value = serde_json::from_slice(&captures[0].body).unwrap();
    assert_eq!(
        body["payload"]["custom_details"]["threshold_kind"],
        "per_block_mint"
    );
    assert_eq!(
        body["payload"]["custom_details"]["threshold_usdc"],
        "500000"
    );

    server.shutdown();
}

/// Deposits below the threshold → no breach detected.
#[tokio::test]
async fn deposits_within_threshold_no_breach() {
    let fx = pg_fixture().await;

    use common::MockWebhookServer;
    let server = MockWebhookServer::start().await;
    let config = make_alert_config(1_000_000, &server.url);
    let client = Client::new();

    let chain_id = 8453i64;
    let block_number = 2000i64;

    // Seed deposits totalling 200_000 (< 1_000_000 threshold).
    seed_deposits(&fx.pool, chain_id, block_number, &[100_000, 100_000]).await;

    let result = run_cycle(&fx.pool, &config, &client, chain_id, block_number, None)
        .await
        .expect("cycle must not error");

    assert_eq!(result, CycleResult::Ok, "no breach should be reported");

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    let captures = server.drain_captures();
    assert!(
        captures.is_empty(),
        "no alert should be dispatched when within threshold"
    );

    server.shutdown();
}

/// Config with zero per-block limit is rejected by `Config::validate()`.
#[test]
fn config_missing_threshold_is_fatal() {
    use watchdog::config::{ActionConfig, ActionMode, Config, GlobalThresholds, SlaConfig};
    use watchdog::receipt_liveness::ReceiptLivenessConfig;

    let bad = Config {
        // Not used by these tests: the chain id reaches the poll loop from the CLI.
        chain_id: None,
        global: GlobalThresholds {
            per_block_mint_limit_usdc: "0".to_owned(),
            per_hour_mint_limit_usdc: "2000000".to_owned(),
            per_block_burn_limit_usdc: "500000".to_owned(),
            per_hour_burn_limit_usdc: "2000000".to_owned(),
        },
        action: ActionConfig {
            mode: ActionMode::Alert,
            webhook_url: Some("https://example.com".to_owned()),
            gateway_rpc_url: None,
            gateway_address: None,
            pauser_private_key_hex: None,
            pause_fee_bump_bps: 1500,
        },
        sla: SlaConfig {
            max_response_secs: 300,
        },
        vault: HashMap::new(),
        // The consensus-receipt liveness monitor is off by default, so these
        // volume-path fixtures are unaffected by it (issue #1247 task 4.13).
        consensus_receipts: ReceiptLivenessConfig::default(),
        governance: Default::default(),
        indexer_lag: Default::default(),
    };

    let err = bad.validate().unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("per_block_mint_limit_usdc"),
        "error must name the bad field; got: {msg}"
    );
}

/// Empty block (no deposits) → cycle reports Ok.
#[tokio::test]
async fn empty_block_is_ok() {
    let fx = pg_fixture().await;

    use common::MockWebhookServer;
    let server = MockWebhookServer::start().await;
    let config = make_alert_config(500_000, &server.url);
    let client = Client::new();

    let chain_id = 8453i64;
    let block_number = 3000i64;

    // Seed a block with no deposits.
    seed_deposits(&fx.pool, chain_id, block_number, &[]).await;

    let result = run_cycle(&fx.pool, &config, &client, chain_id, block_number, None)
        .await
        .expect("cycle must not error");

    assert_eq!(result, CycleResult::Ok);

    server.shutdown();
}

/// The `custom_details.vault` of a captured breach alert.
fn alert_vault(body: &[u8]) -> String {
    let v: serde_json::Value = serde_json::from_slice(body).expect("alert body is JSON");
    v["payload"]["custom_details"]["vault"]
        .as_str()
        .expect("alert names its scope")
        .to_owned()
}

/// DI-7: a breach alert the receiver did not confirm is sent again on the next
/// cycle, and the cursor does not move past its block until it is delivered.
/// An alert the receiver already confirmed for the same block is not re-sent.
///
/// Before the fix a non-2xx was logged, the cursor advanced, and the alert was
/// never sent again.
#[tokio::test]
async fn failed_webhook_is_retried_next_cycle() {
    use common::ScriptedWebhookServer;

    let fx = pg_fixture().await;
    // The daemon creates its pager table at startup; this test is that startup.
    ensure_pager_state_table(&fx.pool).await.unwrap();

    // The receiver confirms the first alert, answers 503 to the second, then
    // recovers (every later request is answered 202).
    let server = ScriptedWebhookServer::start(vec![202, 503]).await;
    let mut config = make_alert_config(500_000, &server.url);
    // A per-vault override on the seeded vault makes one block raise two
    // alerts: the global one, then the per-vault one.
    let vault_hex = "cc".repeat(20);
    config.vault.insert(
        vault_hex.clone(),
        VaultThresholds {
            per_block_mint_limit_usdc: Some("500000".to_owned()),
            per_hour_mint_limit_usdc: None,
            per_block_burn_limit_usdc: None,
            per_hour_burn_limit_usdc: None,
        },
    );
    let client = Client::new();

    let chain_id = 8453i64;
    let block_number = 4000i64;
    // 600_000 > 500_000 for the aggregate and for the vault.
    seed_deposits(&fx.pool, chain_id, block_number, &[300_000, 300_000]).await;
    store_cursor(&fx.pool, chain_id, block_number - 1)
        .await
        .unwrap();

    // Cycle 1: the global alert lands, the per-vault alert gets a 503.
    let first = run_cycles_since_cursor(&fx.pool, &config, &client, chain_id, block_number, None)
        .await
        .expect("an undelivered alert is a result, not a cycle error");
    assert_eq!(
        first,
        CycleResult::BreachUndelivered(vec![ThresholdKind::PerBlockMint])
    );
    assert_eq!(
        load_cursor(&fx.pool, chain_id).await.unwrap(),
        Some(block_number - 1),
        "the cursor must not move past a block whose alert was not delivered"
    );
    let attempt = server.drain_captures();
    assert_eq!(attempt.len(), 2, "both alerts were attempted: {attempt:?}");
    assert_eq!(
        (attempt[0].status, alert_vault(&attempt[0].body)),
        (202, "global".to_owned())
    );
    assert_eq!(
        (attempt[1].status, alert_vault(&attempt[1].body)),
        (503, vault_hex.clone())
    );

    // Cycle 2 (the next poll): only the undelivered alert is sent again. It
    // lands, and the cursor moves past the block.
    let second = run_cycles_since_cursor(&fx.pool, &config, &client, chain_id, block_number, None)
        .await
        .expect("cycle must not error");
    assert_eq!(
        second,
        CycleResult::Breached(vec![ThresholdKind::PerBlockMint])
    );
    assert_eq!(
        load_cursor(&fx.pool, chain_id).await.unwrap(),
        Some(block_number),
        "a delivered block releases the cursor"
    );
    let retry = server.drain_captures();
    assert_eq!(
        retry.len(),
        1,
        "the confirmed global alert must not be re-sent: {retry:?}"
    );
    assert_eq!(retry[0].status, 202);
    assert_eq!(alert_vault(&retry[0].body), vault_hex);
    let body: serde_json::Value = serde_json::from_slice(&retry[0].body).unwrap();
    assert_eq!(
        body["dedup_key"],
        format!("volume_breach:{chain_id}:{block_number}:per_block_mint:{vault_hex}"),
        "the retry carries the same key the first attempt did"
    );

    // The block is done: its delivery records are cleared, and nothing is sent
    // for it again.
    let left: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM watchdog_pager_state WHERE chain_id = $1 AND dedup_key LIKE 'volume_breach:%'",
    )
    .bind(chain_id)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(left, 0, "per-block breach records must not pile up");
    let third = run_cycles_since_cursor(&fx.pool, &config, &client, chain_id, block_number, None)
        .await
        .unwrap();
    assert_eq!(third, CycleResult::NoData);
    assert!(server.drain_captures().is_empty(), "nothing re-sent");

    server.shutdown();
}
