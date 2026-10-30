//! Issue 1810: the watchdog pages each governed upgrade or freeze of a proxied
//! core contract once, from the indexer's `admin_events` proxy rows.
//!
//! A proxy's deployment emits `Upgraded` (and, frozen at deploy,
//! `UpgradesFrozen`) in its creation transaction; the indexer marks those rows
//! `"deployment": true` when the receipt's `contractAddress` is the proxy, and
//! they are not paged. Nothing else exempts a row: not "the first indexed
//! `Upgraded`", not a contract-creation transaction, not the deploy block
//! (issue 1840). Any
//! other `Upgraded` (an upgrade) or `UpgradesFrozen` (a delayed freeze) is paged
//! once and never again, and a failed delivery is retried.
//!
//! Run: `cargo test -p watchdog --test proxy_upgrades -- --test-threads=1`.

mod common;

use common::{pg_fixture, FailingWebhookServer, MockWebhookServer};
use reqwest::Client;
use watchdog::pager_state::{ensure_pager_state_table, load_pager_state, save_pager_state};
use watchdog::receipt_liveness::PagerState;
use watchdog::upgrade_monitor::{
    alert_new_proxy_changes, governed_proxy_changes, proxy_change_baseline,
};

const CHAIN: i64 = 918_453;
const GATEWAY: [u8; 20] = [0x11; 20];
const VAULT: [u8; 20] = [0x22; 20];

const TIMELOCK: [u8; 20] = [0x7a; 20];

async fn seed_chain(pool: &sqlx::PgPool) {
    sqlx::query("INSERT INTO chains (chain_id, name, rpc_label) VALUES ($1, 'fusion', 'stub')")
        .bind(CHAIN)
        .execute(pool)
        .await
        .unwrap();
}

/// One indexed transaction. `to = None` is a contract creation.
async fn seed_tx(pool: &sqlx::PgPool, tx: u8, block: i64, to: Option<[u8; 20]>) {
    sqlx::query(
        "INSERT INTO transactions (chain_id, tx_hash, block_number, tx_index, from_addr, to_addr, status) \
         VALUES ($1, $2, $3, 0, $4, $5, 1)",
    )
    .bind(CHAIN)
    .bind(&[tx; 32][..])
    .bind(block)
    .bind(&[0x0eu8; 20][..])
    .bind(to.as_ref().map(|a| &a[..]))
    .execute(pool)
    .await
    .unwrap();
}

/// One `proxy` row of `admin_events`, emitted in transaction `[tx; 32]`.
async fn seed_event(
    pool: &sqlx::PgPool,
    contract: [u8; 20],
    block: i64,
    log_index: i32,
    tx: u8,
    event: &str,
    detail: &str,
) {
    sqlx::query(
        "INSERT INTO admin_events (chain_id, block_number, log_index, tx_hash, contract, \
                                   contract_kind, event_name, detail) \
         VALUES ($1, $2, $3, $4, $5, 'proxy', $6, $7)",
    )
    .bind(CHAIN)
    .bind(block)
    .bind(log_index)
    .bind(&[tx; 32][..])
    .bind(&contract[..])
    .bind(event)
    .bind(detail)
    .execute(pool)
    .await
    .unwrap();
}

async fn seed(pool: &sqlx::PgPool) {
    seed_chain(pool).await;
    let v1 = format!("0x{}", "1a".repeat(20));
    let v2 = format!("0x{}", "2b".repeat(20));
    // (contract, block, log_index, tx, event, detail)
    let rows = [
        // Gateway deployed upgradeable at block 10, upgraded at 50, frozen at 60.
        (
            GATEWAY,
            10i64,
            0i32,
            0x01u8,
            "Upgraded",
            format!(r#"{{"implementation":"{v1}","deployment":true}}"#),
        ),
        (
            GATEWAY,
            50,
            0,
            0x03,
            "Upgraded",
            format!(r#"{{"implementation":"{v2}"}}"#),
        ),
        (
            GATEWAY,
            60,
            0,
            0x04,
            "UpgradesFrozen",
            format!(
                r#"{{"implementation":"{v2}","code_hash":"0x{}"}}"#,
                "77".repeat(32)
            ),
        ),
        // Vault deployed frozen at block 12: both events in its deployment block.
        (
            VAULT,
            12,
            0,
            0x02,
            "Upgraded",
            format!(r#"{{"implementation":"{v1}","deployment":true}}"#),
        ),
        (
            VAULT,
            12,
            1,
            0x02,
            "UpgradesFrozen",
            format!(
                r#"{{"implementation":"{v1}","code_hash":"0x{}","deployment":true}}"#,
                "66".repeat(32)
            ),
        ),
    ];
    for (contract, block, log_index, tx, event, detail) in &rows {
        seed_event(pool, *contract, *block, *log_index, *tx, event, detail).await;
    }
}

#[tokio::test]
async fn governed_changes_are_paged_once_and_deployments_never() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed(&fx.pool).await;

    let changes = governed_proxy_changes(&fx.pool, CHAIN).await.unwrap();
    let kinds: Vec<(&str, i64)> = changes
        .iter()
        .map(|c| (c.event_name.as_str(), c.block_number))
        .collect();
    assert_eq!(
        kinds,
        vec![("Upgraded", 50), ("UpgradesFrozen", 60)],
        "only the gateway's later upgrade and delayed freeze are governed changes"
    );

    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(paged, 2);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let bodies: Vec<serde_json::Value> = server
        .drain_captures()
        .iter()
        .map(|c| serde_json::from_slice(&c.body).unwrap())
        .collect();
    assert_eq!(bodies.len(), 2);
    let up = &bodies[0]["payload"];
    assert_eq!(up["severity"], "critical");
    assert_eq!(up["custom_details"]["alert_kind"], "proxy_upgraded");
    assert_eq!(
        up["custom_details"]["implementation"],
        format!("0x{}", "2b".repeat(20))
    );
    assert_eq!(
        up["custom_details"]["contract"],
        format!("0x{}", hex::encode(GATEWAY))
    );
    let frozen = &bodies[1]["payload"];
    assert_eq!(
        frozen["custom_details"]["alert_kind"],
        "proxy_upgrades_frozen"
    );
    assert_eq!(
        frozen["custom_details"]["code_hash"],
        format!("0x{}", "77".repeat(32))
    );

    // Paged once: the next cycle sends nothing.
    let again = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_012)
        .await
        .unwrap();
    assert_eq!(again, 0);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(server.drain_captures().is_empty());
    server.shutdown();
}

#[tokio::test]
async fn a_failed_delivery_is_retried_and_no_webhook_records_nothing() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed(&fx.pool).await;
    let client = Client::new();

    // No webhook: nothing is recorded, so the change is still pending.
    let none = alert_new_proxy_changes(&fx.pool, &client, None, CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(none, 0);

    // A receiver that refuses: still nothing recorded.
    let failing = FailingWebhookServer::start(503).await;
    let refused = alert_new_proxy_changes(&fx.pool, &client, Some(&failing.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(refused, 0);
    assert!(failing.request_count() >= 2, "both changes were attempted");
    failing.shutdown();

    // A working receiver then gets both.
    let server = MockWebhookServer::start().await;
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_024)
        .await
        .unwrap();
    assert_eq!(paged, 2);
    server.shutdown();
}

/// Issue 1840: a registry-discovered vault is watched from the tick that saw
/// its `VaultRegistered`, so its deploy-time events are never indexed and its
/// deploy block is unknown. Its first indexed `Upgraded`, sent by the
/// Timelock, is a governed upgrade and is paged once.
#[tokio::test]
async fn a_late_registered_vaults_first_indexed_upgrade_is_paged_once() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed_chain(&fx.pool).await;
    // Deployed at block 5 (never indexed), registered and watched from 40.
    seed_tx(&fx.pool, 0x09, 70, Some(TIMELOCK)).await;
    let v2 = format!("0x{}", "2b".repeat(20));
    seed_event(
        &fx.pool,
        VAULT,
        70,
        0,
        0x09,
        "Upgraded",
        &format!(r#"{{"implementation":"{v2}"}}"#),
    )
    .await;

    let changes = governed_proxy_changes(&fx.pool, CHAIN).await.unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|c| (c.event_name.as_str(), c.block_number))
            .collect::<Vec<_>>(),
        vec![("Upgraded", 70)],
        "the first indexed Upgraded is not the deployment"
    );

    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(paged, 1);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let bodies = server.drain_captures();
    assert_eq!(bodies.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&bodies[0].body).unwrap();
    assert_eq!(
        body["payload"]["custom_details"]["alert_kind"],
        "proxy_upgraded"
    );
    assert_eq!(body["payload"]["custom_details"]["implementation"], v2);

    let again = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_012)
        .await
        .unwrap();
    assert_eq!(again, 0, "paged once");
    server.shutdown();
}

/// Issue 1840: RouterGovernance became watched after the cursor had passed its
/// deploy block, so it can have an `UpgradesFrozen` and no indexed `Upgraded`
/// at all. The old JOIN on the first `Upgraded` dropped that freeze. It pages,
/// and so does a later upgrade of a contract whose first indexed row is a freeze.
#[tokio::test]
async fn a_freeze_before_the_first_indexed_upgrade_is_paged() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed_chain(&fx.pool).await;
    // Deployed at block 3, outside the indexed range.
    seed_tx(&fx.pool, 0x0a, 80, Some(TIMELOCK)).await;
    seed_tx(&fx.pool, 0x0b, 90, Some(TIMELOCK)).await;
    let v1 = format!("0x{}", "1a".repeat(20));
    seed_event(
        &fx.pool,
        GATEWAY,
        80,
        0,
        0x0a,
        "UpgradesFrozen",
        &format!(
            r#"{{"implementation":"{v1}","code_hash":"0x{}"}}"#,
            "55".repeat(32)
        ),
    )
    .await;
    seed_event(
        &fx.pool,
        GATEWAY,
        90,
        0,
        0x0b,
        "Upgraded",
        &format!(r#"{{"implementation":"0x{}"}}"#, "2b".repeat(20)),
    )
    .await;

    let changes = governed_proxy_changes(&fx.pool, CHAIN).await.unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|c| (c.event_name.as_str(), c.block_number))
            .collect::<Vec<_>>(),
        vec![("UpgradesFrozen", 80), ("Upgraded", 90)],
    );

    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(paged, 2);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let first: serde_json::Value =
        serde_json::from_slice(&server.drain_captures()[0].body).unwrap();
    assert_eq!(
        first["payload"]["custom_details"]["alert_kind"],
        "proxy_upgrades_frozen"
    );
    assert_eq!(
        alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_012)
            .await
            .unwrap(),
        0
    );
    server.shutdown();
}

/// Issue 1840 (review): the timelock's executor role is open, so anyone can
/// execute a ready upgrade from a throwaway contract's constructor. That
/// transaction is a contract creation, and here it even lands in the proxy's
/// deploy block. It did not create the proxy, so the indexer did not mark it
/// as the deployment, and it pages.
#[tokio::test]
async fn an_upgrade_executed_from_a_constructor_in_the_deploy_block_pages() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed_chain(&fx.pool).await;
    let v1 = format!("0x{}", "1a".repeat(20));
    let v2 = format!("0x{}", "2b".repeat(20));
    // Block 20: the proxy's own creation (tx 0x0c), then a throwaway
    // contract's creation (tx 0x0d) whose constructor runs timelock.execute().
    seed_tx(&fx.pool, 0x0c, 20, None).await;
    seed_tx(&fx.pool, 0x0d, 20, None).await;
    seed_event(
        &fx.pool,
        GATEWAY,
        20,
        0,
        0x0c,
        "Upgraded",
        &format!(r#"{{"implementation":"{v1}","deployment":true}}"#),
    )
    .await;
    seed_event(
        &fx.pool,
        GATEWAY,
        20,
        5,
        0x0d,
        "Upgraded",
        &format!(r#"{{"implementation":"{v2}"}}"#),
    )
    .await;

    let changes = governed_proxy_changes(&fx.pool, CHAIN).await.unwrap();
    assert_eq!(
        changes
            .iter()
            .map(|c| (c.event_name.as_str(), c.block_number, c.log_index))
            .collect::<Vec<_>>(),
        vec![("Upgraded", 20, 5)],
        "only the proxy's own creation is exempt"
    );
    let server = MockWebhookServer::start().await;
    let paged = alert_new_proxy_changes(&fx.pool, &Client::new(), Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(paged, 1);
    server.shutdown();
}

/// One successful indexer run: cursor `last_indexed_block`, chain head `head`.
async fn seed_run(pool: &sqlx::PgPool, last_indexed_block: i64, head: i64) {
    sqlx::query(
        "INSERT INTO indexer_runs (chain_id, from_block, finished_at, last_indexed_block, \
                                   chain_head_block) \
         VALUES ($1, 1, now(), $2, $3)",
    )
    .bind(CHAIN)
    .bind(last_indexed_block)
    .bind(head)
    .execute(pool)
    .await
    .unwrap();
}

/// Issue 1856: the indexer's first backfill inserts every historical proxy
/// event at once, including deploy-time rows indexed before the deployment
/// mark existed. On its first run the watchdog records the indexer cursor as a
/// baseline. Events at or below it, even ones the backfill inserts later, are
/// recorded as seen and never paged. An event between the cursor and the chain
/// head at first run, indexed later, pages, and so does a new upgrade.
#[tokio::test]
async fn proxy_events_older_than_the_first_run_do_not_page_and_a_new_upgrade_does() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed_chain(&fx.pool).await;
    seed_run(&fx.pool, 95, 100).await;
    let v1 = format!("0x{}", "1a".repeat(20));
    let v2 = format!("0x{}", "2b".repeat(20));
    let v3 = format!("0x{}", "3c".repeat(20));
    // A deploy-time row the indexer has not marked yet, and an old upgrade.
    seed_event(
        &fx.pool,
        GATEWAY,
        10,
        0,
        0x01,
        "Upgraded",
        &format!(r#"{{"implementation":"{v1}"}}"#),
    )
    .await;
    seed_event(
        &fx.pool,
        GATEWAY,
        50,
        0,
        0x03,
        "Upgraded",
        &format!(r#"{{"implementation":"{v2}"}}"#),
    )
    .await;

    // Startup takes the baseline before the first cycle (issue 1868).
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, true).await.unwrap(),
        Some(95)
    );
    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let first = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(first, 0, "history older than the first run is not paged");
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, false).await.unwrap(),
        Some(95),
        "the baseline is the indexer cursor, not the chain head (100)"
    );
    let seen = load_pager_state(
        &fx.pool,
        CHAIN,
        &format!("proxy_change:{CHAIN}:0x{}:50:0", hex::encode(GATEWAY)),
    )
    .await
    .unwrap()
    .expect("the old upgrade is recorded as seen");
    assert_eq!(seen.last_paged_at, None, "seen, never paged");

    // The backfill then inserts an even older freeze, and the chain moves on.
    seed_event(
        &fx.pool,
        VAULT,
        30,
        0,
        0x04,
        "UpgradesFrozen",
        &format!(
            r#"{{"implementation":"{v1}","code_hash":"0x{}"}}"#,
            "66".repeat(32)
        ),
    )
    .await;
    seed_run(&fx.pool, 200, 205).await;
    assert_eq!(
        alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_012)
            .await
            .unwrap(),
        0,
        "a backfilled row below the baseline is not paged either"
    );
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, false).await.unwrap(),
        Some(95),
        "the baseline is kept, not moved with the chain"
    );

    // A real upgrade at block 98: above the cursor but below the head the
    // indexer had seen at first run. Live ingestion indexes it later. It pages,
    // and so does a new upgrade after the first run.
    seed_event(
        &fx.pool,
        GATEWAY,
        98,
        0,
        0x06,
        "Upgraded",
        &format!(r#"{{"implementation":"{v2}"}}"#),
    )
    .await;
    seed_event(
        &fx.pool,
        GATEWAY,
        150,
        0,
        0x05,
        "Upgraded",
        &format!(r#"{{"implementation":"{v3}"}}"#),
    )
    .await;
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_024)
        .await
        .unwrap();
    assert_eq!(paged, 2);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let bodies: Vec<serde_json::Value> = server
        .drain_captures()
        .iter()
        .map(|c| serde_json::from_slice(&c.body).unwrap())
        .collect();
    assert_eq!(bodies.len(), 2, "only the two new upgrades were sent");
    assert_eq!(bodies[0]["payload"]["custom_details"]["block_number"], 98);
    assert_eq!(bodies[1]["payload"]["custom_details"]["block_number"], 150);
    assert_eq!(bodies[1]["payload"]["custom_details"]["implementation"], v3);
    assert_eq!(
        alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_036)
            .await
            .unwrap(),
        0
    );
    server.shutdown();
}

/// Issue 1856: a watchdog that already recorded a proxy change before the
/// baseline existed seeds nothing, so a change whose page was never delivered
/// (the receiver was down) still pages after the upgrade.
#[tokio::test]
async fn a_monitor_that_ran_before_seeds_nothing_and_an_undelivered_change_still_pages() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed(&fx.pool).await;
    seed_run(&fx.pool, 95, 100).await;
    // The upgrade at 50 was paged by the old monitor; the freeze at 60 was not.
    save_pager_state(
        &fx.pool,
        CHAIN,
        &format!("proxy_change:{CHAIN}:0x{}:50:0", hex::encode(GATEWAY)),
        PagerState {
            firing: true,
            last_paged_at: Some(900),
        },
    )
    .await
    .unwrap();

    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, true).await.unwrap(),
        Some(-1),
        "a pager row shows a watchdog ran here: startup seeds nothing"
    );
    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(paged, 1, "the undelivered freeze pages");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let bodies = server.drain_captures();
    let body: serde_json::Value = serde_json::from_slice(&bodies[0].body).unwrap();
    assert_eq!(
        body["payload"]["custom_details"]["alert_kind"],
        "proxy_upgrades_frozen"
    );
    server.shutdown();
}

/// Issue 1856 (review): an older watchdog ran here, saw a real upgrade and
/// could not deliver its page (webhook down or unset), so it saved no pager
/// row. Its `watchdog_cursor` row shows it ran. The new watchdog seeds nothing
/// and the undelivered upgrade pages.
#[tokio::test]
async fn an_upgrade_an_older_watchdog_failed_to_deliver_still_pages_after_rollout() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed(&fx.pool).await;
    seed_run(&fx.pool, 95, 100).await;
    sqlx::query("INSERT INTO watchdog_cursor (chain_id, last_processed_block) VALUES ($1, 90)")
        .bind(CHAIN)
        .execute(&fx.pool)
        .await
        .unwrap();
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, true).await.unwrap(),
        Some(-1),
        "a cursor row shows a watchdog ran here: startup seeds nothing"
    );
    // The old watchdog's delivery failed: nothing is recorded.
    let failing = FailingWebhookServer::start(503).await;
    let client = Client::new();
    assert_eq!(
        alert_new_proxy_changes(&fx.pool, &client, Some(&failing.url), CHAIN, 900)
            .await
            .unwrap(),
        0
    );
    failing.shutdown();
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, false).await.unwrap(),
        Some(-1),
        "a watchdog ran here before: nothing is seeded"
    );

    let server = MockWebhookServer::start().await;
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(paged, 2, "the undelivered upgrade and freeze both page");
    server.shutdown();
}

/// Issue 1856 (review): the baseline table is unreadable (the watchdog role
/// could not create it). The monitor fails toward paging: every change pages.
#[tokio::test]
async fn an_unreadable_baseline_pages_everything() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed(&fx.pool).await;
    seed_run(&fx.pool, 95, 100).await;
    sqlx::query("DROP TABLE watchdog_proxy_baseline")
        .execute(&fx.pool)
        .await
        .unwrap();
    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(
        paged, 2,
        "below the cursor, yet paged: no baseline, no seeding"
    );
    server.shutdown();
}

/// Issue 1868: a call after startup that finds no stored baseline stores `-1`,
/// never the indexer cursor, so every unpaged change pages.
#[tokio::test]
async fn non_startup_call_stores_minus_one() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed_chain(&fx.pool).await;
    seed_run(&fx.pool, 95, 100).await;
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, false).await.unwrap(),
        Some(-1),
        "only startup may take the cursor (95)"
    );
    let stored: i64 = sqlx::query_scalar(
        "SELECT baseline_block FROM watchdog_proxy_baseline WHERE chain_id = $1",
    )
    .bind(CHAIN)
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(stored, -1);
}

/// Issue 1868: startup finds nothing indexed, so the baseline is `-1`. The
/// indexer's first run then commits a cursor at 95 that covers an upgrade at
/// 90 mined after the watchdog started. The next cycle must not take that
/// cursor as the baseline: the upgrade pages exactly once.
#[tokio::test]
async fn late_cycle_never_takes_a_cursor_baseline() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed_chain(&fx.pool).await;
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, true).await.unwrap(),
        Some(-1),
        "nothing indexed at startup: the baseline is -1 at once"
    );

    seed_run(&fx.pool, 95, 100).await;
    let v2 = format!("0x{}", "2b".repeat(20));
    seed_event(
        &fx.pool,
        GATEWAY,
        90,
        0,
        0x03,
        "Upgraded",
        &format!(r#"{{"implementation":"{v2}"}}"#),
    )
    .await;

    let server = MockWebhookServer::start().await;
    let client = Client::new();
    let paged = alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_000)
        .await
        .unwrap();
    assert_eq!(paged, 1, "the upgrade at or below the cursor still pages");
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, false).await.unwrap(),
        Some(-1)
    );
    assert_eq!(
        alert_new_proxy_changes(&fx.pool, &client, Some(&server.url), CHAIN, 1_012)
            .await
            .unwrap(),
        0,
        "paged once, never again"
    );
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let bodies = server.drain_captures();
    assert_eq!(bodies.len(), 1, "exactly one page reached the webhook");
    let body: serde_json::Value = serde_json::from_slice(&bodies[0].body).unwrap();
    assert_eq!(body["payload"]["custom_details"]["block_number"], 90);
    assert_eq!(
        body["payload"]["custom_details"]["alert_kind"],
        "proxy_upgraded"
    );
    server.shutdown();
}

/// Issue 1868 (review): startup finds nothing indexed and the watchdog restarts
/// (or a second replica starts) after the indexer's first run but before any
/// cycle ran. The second startup must not take the new cursor as the baseline.
#[tokio::test]
async fn a_restart_after_an_empty_startup_never_takes_a_cursor_baseline() {
    let fx = pg_fixture().await;
    ensure_pager_state_table(&fx.pool).await.unwrap();
    seed_chain(&fx.pool).await;
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, true).await.unwrap(),
        Some(-1)
    );
    seed_run(&fx.pool, 95, 100).await;
    assert_eq!(
        proxy_change_baseline(&fx.pool, CHAIN, true).await.unwrap(),
        Some(-1),
        "the second startup keeps -1, not the cursor (95)"
    );
}
