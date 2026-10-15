//! Issue 1810: the watchdog pages each governed upgrade or freeze of a proxied
//! core contract once, from the indexer's `admin_events` proxy rows.
//!
//! A proxy's deployment emits `Upgraded` (and, frozen at deploy,
//! `UpgradesFrozen`) in its deployment block; those are not paged. A later
//! `Upgraded` (an upgrade) or `UpgradesFrozen` (a delayed freeze) is paged once
//! and never again, and a failed delivery is retried.
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

async fn seed(pool: &sqlx::PgPool) {
    sqlx::query("INSERT INTO chains (chain_id, name, rpc_label) VALUES ($1, 'fusion', 'stub')")
        .bind(CHAIN)
        .execute(pool)
        .await
        .unwrap();
    let v1 = format!("0x{}", "1a".repeat(20));
    let v2 = format!("0x{}", "2b".repeat(20));
    // (contract, block, log_index, event, detail)
    let rows = [
        // Gateway deployed upgradeable at block 10, upgraded at 50, frozen at 60.
        (
            GATEWAY,
            10i64,
            0i32,
            "Upgraded",
            format!(r#"{{"implementation":"{v1}"}}"#),
        ),
        (
            GATEWAY,
            50,
            0,
            "Upgraded",
            format!(r#"{{"implementation":"{v2}"}}"#),
        ),
        (
            GATEWAY,
            60,
            0,
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
            "Upgraded",
            format!(r#"{{"implementation":"{v1}"}}"#),
        ),
        (
            VAULT,
            12,
            1,
            "UpgradesFrozen",
            format!(
                r#"{{"implementation":"{v1}","code_hash":"0x{}"}}"#,
                "66".repeat(32)
            ),
        ),
    ];
    for (contract, block, log_index, event, detail) in &rows {
        sqlx::query(
            "INSERT INTO admin_events (chain_id, block_number, log_index, tx_hash, contract, \
                                       contract_kind, event_name, detail) \
             VALUES ($1, $2, $3, $4, $5, 'proxy', $6, $7)",
        )
        .bind(CHAIN)
        .bind(block)
        .bind(log_index)
        .bind(&[0x01u8; 32][..])
        .bind(&contract[..])
        .bind(*event)
        .bind(detail)
        .execute(pool)
        .await
        .unwrap();
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
