#![allow(dead_code)]

// Test harness: boots a Postgres container via testcontainers, applies the
// canonical (explorer-indexer) migrations, seeds a deterministic fixture,
// and serves the HTTP router on an ephemeral port.
//
// Per docs/technical/explorer-schema-decisions.md §3.1 we test against
// Postgres only — no SQLite shortcut. testcontainers boots a real engine
// in CI (~10 s) which is consistent with the project's "no fast-feedback
// optimization" memory.
//
// Issue #87 / PR #99: the schema is owned by `services/explorer-indexer/`
// and consumed verbatim here via `include_str!` so the two crates can
// never drift. The CI guard
// (`.github/scripts/check_explorer_migrations.py`) rejects any
// `clients/explorer-api/migrations/*.sql` that would re-introduce a
// local copy.

use std::net::SocketAddr;

use chrono::{TimeZone, Utc};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use testcontainers::runners::AsyncRunner;
use testcontainers::ContainerAsync;
use testcontainers_modules::postgres::Postgres;
use tokio::task::JoinHandle;

use explorer_api::{router, AppState};

/// The canonical schema source. Owned by `services/explorer-indexer/`
/// per ADR §3.4 and issue #87. If this path changes, update both this
/// constant AND `tests/canonical_schema.rs` (which asserts on the same
/// bytes).
pub const CANONICAL_MIGRATION: &str =
    include_str!("../../../../services/explorer-indexer/migrations/0001_minimum_tables.sql");

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

pub async fn apply_migrations(pool: &PgPool) {
    sqlx::raw_sql(CANONICAL_MIGRATION)
        .execute(pool)
        .await
        .expect("apply canonical indexer migrations");
}

/// Decode a 0x-prefixed hex string into raw bytes for BYTEA columns.
fn hex_bytes(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).expect("hex literal")
}

/// Deterministic fixture: one chain, one contract, one indexer run, one
/// deposit, one tx, one vault snapshot, one agent policy. Mirrors the
/// canonical (BYTEA-typed) schema.
async fn seed_fixture(pool: &PgPool) {
    let indexed_at = Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap();
    let block_ts: i64 = 1_735_732_800; // 2026-01-01T12:00:00Z as unix seconds.

    let gateway = hex_bytes("1111111111111111111111111111111111111111");
    let agent = hex_bytes("3333333333333333333333333333333333333333");
    let share_receiver = hex_bytes("5555555555555555555555555555555555555555");
    let block_hash = hex_bytes("00000000000000000000000000000000000000000000000000000000000000aa");
    let parent_hash = hex_bytes("00000000000000000000000000000000000000000000000000000000000000bb");
    let tx_hash = hex_bytes("2222222222222222222222222222222222222222222222222222222222222222");
    let payment_id = hex_bytes("4444444444444444444444444444444444444444444444444444444444444444");
    let order_id = hex_bytes("6666666666666666666666666666666666666666666666666666666666666666");

    sqlx::query("INSERT INTO chains (chain_id, name, rpc_label) VALUES ($1, $2, $3)")
        .bind(8453_i64)
        .bind("base")
        .bind("base-mainnet")
        .execute(pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO contracts (chain_id, address, kind, deployed_block) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(8453_i64)
    .bind(&gateway[..])
    .bind("gateway")
    .bind(Some(900_i64))
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO indexer_runs (chain_id, started_at, finished_at, from_block, to_block, last_indexed_block, reorg_count, rows_inserted) \
         VALUES ($1, $2, $2, $3, $4, $4, 0, 0)",
    )
    .bind(8453_i64)
    .bind(indexed_at)
    .bind(900_i64)
    .bind(1000_i64)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO blocks (chain_id, block_number, hash, parent_hash, timestamp) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(8453_i64)
    .bind(1000_i64)
    .bind(&block_hash[..])
    .bind(&parent_hash[..])
    .bind(block_ts)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO transactions (chain_id, tx_hash, block_number, tx_index, from_addr, to_addr, status, indexed_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(8453_i64)
    .bind(&tx_hash[..])
    .bind(1000_i64)
    .bind(0_i32)
    .bind(&agent[..])
    .bind(Some(&gateway[..]))
    .bind(1_i16)
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO agent_deposits (chain_id, block_number, log_index, tx_hash, payment_id, order_id, agent, share_receiver, amount, shares_minted, window_id, indexed_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::NUMERIC, $10::NUMERIC, $11, $12)",
    )
    .bind(8453_i64)
    .bind(1000_i64)
    .bind(0_i32)
    .bind(&tx_hash[..])
    .bind(&payment_id[..])
    .bind(&order_id[..])
    .bind(&agent[..])
    .bind(&share_receiver[..])
    .bind("1000000")
    .bind("1000000")
    .bind(1_i64)
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO agent_policies (chain_id, block_number, log_index, tx_hash, agent, revoked, valid_until, max_per_payment, max_per_window, share_receiver, indexed_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::NUMERIC, $9::NUMERIC, $10, $11)",
    )
    .bind(8453_i64)
    .bind(900_i64)
    .bind(0_i32)
    .bind(&tx_hash[..])
    .bind(&agent[..])
    .bind(false)
    .bind(Some(2_000_000_000_i64))
    .bind(Some("5000000"))
    .bind(Some("5000000"))
    .bind(Some(&share_receiver[..]))
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO vault_snapshots (chain_id, contract, block_number, total_assets, total_supply, exit_fee_bps, tvl_cap, paused, indexed_at) \
         VALUES ($1, $2, $3, $4::NUMERIC, $5::NUMERIC, $6, $7::NUMERIC, $8, $9)",
    )
    .bind(8453_i64)
    .bind(&gateway[..])
    .bind(1000_i64)
    .bind("12345678")
    .bind("11111111")
    .bind(50_i64)
    .bind("100000000000")
    .bind(false)
    .bind(indexed_at)
    .execute(pool)
    .await
    .unwrap();
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder().build().unwrap()
}
