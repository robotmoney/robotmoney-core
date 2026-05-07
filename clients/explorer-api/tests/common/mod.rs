// Test harness: boots a Postgres container via testcontainers, applies the
// crate's migrations, seeds a deterministic fixture, and serves the HTTP
// router on an ephemeral port.
//
// Per docs/technical/explorer-schema-decisions.md §3.1 we test against
// Postgres only — no SQLite shortcut. testcontainers boots a real engine
// in CI (~10 s) which is consistent with the project's "no fast-feedback
// optimization" memory.

use std::net::SocketAddr;

use chrono::{TimeZone, Utc};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use testcontainers::runners::AsyncRunner;
use testcontainers::ContainerAsync;
use testcontainers_modules::postgres::Postgres;
use tokio::task::JoinHandle;

use explorer_api::{router, AppState};

pub struct TestServer {
    pub addr: SocketAddr,
    pub _pool: PgPool,
    pub _container: ContainerAsync<Postgres>,
    pub _server: JoinHandle<()>,
}

pub async fn start_with_seed() -> TestServer {
    let container = Postgres::default()
        .start()
        .await
        .expect("start postgres container");
    let host = container.get_host().await.expect("container host");
    let port = container
        .get_host_port_ipv4(5432)
        .await
        .expect("container port");
    let url = format!("postgres://postgres:postgres@{host}:{port}/postgres");

    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("connect postgres");

    apply_migrations(&pool).await;
    seed_fixture(&pool).await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let app = router(AppState::new(pool.clone()));
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

async fn apply_migrations(pool: &PgPool) {
    let sql = include_str!("../../migrations/0001_init.sql");
    sqlx::raw_sql(sql)
        .execute(pool)
        .await
        .expect("apply migrations");
}

/// Deterministic fixture: one chain, one contract, one indexer run, one
/// deposit, one tx, one vault snapshot, one agent policy.
async fn seed_fixture(pool: &PgPool) {
    let indexed_at = Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap();

    sqlx::query("INSERT INTO chains (chain_id, name) VALUES ($1, $2)")
        .bind(8453_i64)
        .bind("base")
        .execute(pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO contracts (chain_id, address, kind, label) VALUES ($1, $2, $3, $4)")
        .bind(8453_i64)
        .bind("0x1111111111111111111111111111111111111111")
        .bind("gateway")
        .bind(Some("RobotMoneyGateway"))
        .execute(pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO indexer_runs (started_at, finished_at, last_indexed_block, reorg_count) \
         VALUES ($1, $1, $2, 0)",
    )
    .bind(indexed_at)
    .bind(1000_i64)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO blocks (chain_id, block_number, hash, timestamp) VALUES ($1, $2, $3, $4)",
    )
    .bind(8453_i64)
    .bind(1000_i64)
    .bind("0xaaaa")
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO transactions (chain_id, tx_hash, block_number, from_address, to_address, status, indexed_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(8453_i64)
    .bind("0x2222222222222222222222222222222222222222222222222222222222222222")
    .bind(1000_i64)
    .bind("0x3333333333333333333333333333333333333333")
    .bind(Some("0x1111111111111111111111111111111111111111"))
    .bind(1_i16)
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO agent_deposits (chain_id, block_number, log_index, tx_hash, payment_id, agent, token, amount, indexed_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::NUMERIC, $9)",
    )
    .bind(8453_i64)
    .bind(1000_i64)
    .bind(0_i32)
    .bind("0x2222222222222222222222222222222222222222222222222222222222222222")
    .bind("0x4444444444444444444444444444444444444444444444444444444444444444")
    .bind("0x3333333333333333333333333333333333333333")
    .bind("0x5555555555555555555555555555555555555555")
    .bind("1000000")
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO agent_policies (chain_id, block_number, log_index, agent, authorized, cap, indexed_at) \
         VALUES ($1, $2, $3, $4, $5, $6::NUMERIC, $7)",
    )
    .bind(8453_i64)
    .bind(900_i64)
    .bind(0_i32)
    .bind("0x3333333333333333333333333333333333333333")
    .bind(true)
    .bind("5000000")
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO vault_snapshots (chain_id, contract, block_number, total_assets, total_supply, indexed_at) \
         VALUES ($1, $2, $3, $4::NUMERIC, $5::NUMERIC, $6)",
    )
    .bind(8453_i64)
    .bind("0x1111111111111111111111111111111111111111")
    .bind(1000_i64)
    .bind("12345678")
    .bind("11111111")
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder().build().unwrap()
}
