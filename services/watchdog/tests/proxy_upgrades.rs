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
use watchdog::pager_state::ensure_pager_state_table;
use watchdog::upgrade_monitor::{alert_new_proxy_changes, governed_proxy_changes};

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
