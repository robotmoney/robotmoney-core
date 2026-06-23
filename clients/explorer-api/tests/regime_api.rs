//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//! Implements: issue #1053 — regime-feed API endpoint test.
//!
//! AC: GET /v1/regime/feed returns the latest snapshot per vault.

use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;
use tokio::task::JoinHandle;

use explorer_api::{router, AppState};

const PRIMARY_CHAIN_ID: i64 = 8453;

const MIGRATIONS: &[&str] = &[
    include_str!("../../../services/explorer-indexer/migrations/0001_minimum_tables.sql"),
    include_str!("../../../services/explorer-indexer/migrations/0002_add_vaults_table.sql"),
    include_str!("../../../services/explorer-indexer/migrations/0003_multi_vault_schema.sql"),
    include_str!(
        "../../../services/explorer-indexer/migrations/0004_add_router_weight_snapshots.sql"
    ),
    include_str!("../../../services/explorer-indexer/migrations/0005_add_governance_tables.sql"),
    include_str!(
        "../../../services/explorer-indexer/migrations/0006_agent_deposit_vault_and_router_legs.sql"
    ),
    include_str!(
        "../../../services/explorer-indexer/migrations/0007_account_history_and_vault_detail_stubs.sql"
    ),
    include_str!("../../../services/explorer-indexer/migrations/0008_vault_detail_events.sql"),
    include_str!("../../../services/explorer-indexer/migrations/0009_account_history_events.sql"),
    include_str!(
        "../../../services/explorer-indexer/migrations/0010_agent_policy_owner_column.sql"
    ),
    include_str!("../../../services/explorer-indexer/migrations/0011_watchdog_cursor.sql"),
    include_str!("../../../services/explorer-indexer/migrations/0012_vault_status_events.sql"),
    include_str!("../../../services/explorer-indexer/migrations/0013_vote_power_tally.sql"),
    include_str!("../../../services/explorer-indexer/migrations/0014_committee_tables.sql"),
];

struct TestServer {
    pub addr: SocketAddr,
    _pool: sqlx::PgPool,
    _container: testcontainers::ContainerAsync<Postgres>,
    _server: JoinHandle<()>,
}

async fn start_regime_server() -> TestServer {
    let container = Postgres::default()
        .start()
        .await
        .expect("start postgres");
    let host = container.get_host().await.expect("host");
    let port = container.get_host_port_ipv4(5432).await.expect("port");
    let url = format!("postgres://postgres:postgres@{host}:{port}/postgres");

    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("connect");

    for sql in MIGRATIONS {
        sqlx::raw_sql(sql).execute(&pool).await.expect("migration");
    }

    sqlx::query("INSERT INTO chains (chain_id, name, rpc_label) VALUES ($1, $2, $3)")
        .bind(PRIMARY_CHAIN_ID)
        .bind("base")
        .bind("base-mainnet")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO indexer_runs \
         (chain_id, started_at, from_block, last_indexed_block, reorg_count, rows_inserted) \
         VALUES ($1, now(), 0, 500, 0, 0)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .execute(&pool)
    .await
    .unwrap();

    seed_regime_fixture(&pool).await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let app = router(AppState::new(pool.clone(), PRIMARY_CHAIN_ID));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    TestServer {
        addr,
        _pool: pool,
        _container: container,
        _server: server,
    }
}

fn hex_bytes(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).expect("hex literal")
}

async fn seed_regime_fixture(pool: &sqlx::PgPool) {
    let vault_a = hex_bytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let vault_b = hex_bytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    // vault_a: two snapshots at different blocks — the latest (300) should be returned.
    sqlx::query(
        "INSERT INTO regime_snapshots \
         (chain_id, vault_address, block_number, avg_weight_bps, vote_count) \
         VALUES ($1, $2, 200, 5000.00, 1)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&vault_a)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO regime_snapshots \
         (chain_id, vault_address, block_number, avg_weight_bps, vote_count) \
         VALUES ($1, $2, 300, 7500.00, 3)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&vault_a)
    .execute(pool)
    .await
    .unwrap();

    // vault_b: one snapshot.
    sqlx::query(
        "INSERT INTO regime_snapshots \
         (chain_id, vault_address, block_number, avg_weight_bps, vote_count) \
         VALUES ($1, $2, 250, 3000.00, 2)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&vault_b)
    .execute(pool)
    .await
    .unwrap();
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().build().unwrap()
}

/// GET /v1/regime/feed returns latest snapshot per vault.
#[tokio::test]
async fn regime_feed_returns_latest_snapshot() {
    let s = start_regime_server().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/regime/feed", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let snapshots = body["snapshots"].as_array().unwrap();
    // Two vaults, one snapshot each (latest).
    assert_eq!(snapshots.len(), 2, "expected 2 regime snapshots (one per vault)");

    // Find vault_a snapshot — should be block 300 with vote_count=3.
    let vault_a_hex = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let snap_a = snapshots
        .iter()
        .find(|s| s["vault"].as_str() == Some(vault_a_hex))
        .expect("vault_a snapshot missing");
    assert_eq!(
        snap_a["block_number"], 300,
        "vault_a should have latest snapshot at block 300"
    );
    assert_eq!(snap_a["vote_count"], 3, "vault_a vote_count mismatch");

    // Freshness header.
    assert_eq!(body["block_number"], 500);
    assert!(body["indexed_at"].is_string());
}
