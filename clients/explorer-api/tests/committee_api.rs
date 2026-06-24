//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//! Implements: issue #1053 — committee API endpoint tests.
//!
//! Covers three AC cases:
//!   1. GET /v1/committee/agents — returns registered agents
//!   2. GET /v1/committee/agents/:address/track-record — returns vote history
//!   3. GET /v1/committee/tilts — excludes unverified votes

use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;
use tokio::task::JoinHandle;

use explorer_api::{router, AppState};

const PRIMARY_CHAIN_ID: i64 = 8453;

/// All migrations in order. The committee migration (0014) is the last one.
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

async fn start_committee_server() -> TestServer {
    let container = Postgres::default().start().await.expect("start postgres");
    let host = container.get_host().await.expect("host");
    let port = container.get_host_port_ipv4(5432).await.expect("port");
    let url = format!("postgres://postgres:postgres@{host}:{port}/postgres");

    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .expect("connect");

    // Apply all migrations.
    for sql in MIGRATIONS {
        sqlx::raw_sql(sql).execute(&pool).await.expect("migration");
    }

    // Seed minimal indexer state (chain + indexer_run cursor).
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
         VALUES ($1, now(), 0, 1000, 0, 0)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .execute(&pool)
    .await
    .unwrap();

    // Seed committee fixture.
    seed_committee_fixture(&pool).await;

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

async fn seed_committee_fixture(pool: &sqlx::PgPool) {
    let agent_a = hex_bytes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    let agent_b = hex_bytes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let vault_a = hex_bytes("1111111111111111111111111111111111111111");
    let vault_b = hex_bytes("2222222222222222222222222222222222222222");
    let tx1 = hex_bytes("0101010101010101010101010101010101010101010101010101010101010101");
    let tx2 = hex_bytes("0202020202020202020202020202020202020202020202020202020202020202");
    let tx3 = hex_bytes("0303030303030303030303030303030303030303030303030303030303030303");
    let vote_hash = vec![0xabu8; 32];

    // Two agents.
    sqlx::query(
        "INSERT INTO committee_agents \
         (chain_id, agent_address, agent_id, active, registered_at) \
         VALUES ($1, $2, $3, TRUE, 100)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&agent_a)
    .bind("athena-v1")
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO committee_agents \
         (chain_id, agent_address, agent_id, active, registered_at) \
         VALUES ($1, $2, $3, FALSE, 50)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&agent_b)
    .bind("zeus-v0")
    .execute(pool)
    .await
    .unwrap();

    // agent_a: two votes — one verified (vault_a, Overweight, 7000), one unverified (vault_b).
    sqlx::query(
        "INSERT INTO committee_votes \
         (chain_id, vote_id, block_number, log_index, tx_hash, agent_address, vault_address, \
          stance, target_weight_bps, confidence, rationale_uri, vote_json_hash, \
          timestamp_secs, verified) \
         VALUES ($1, 1, 200, 0, $2, $3, $4, 0, 7000, 90, 'https://example.com/v1', $5, 1000000, TRUE)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&tx1)
    .bind(&agent_a)
    .bind(&vault_a)
    .bind(&vote_hash)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO committee_votes \
         (chain_id, vote_id, block_number, log_index, tx_hash, agent_address, vault_address, \
          stance, target_weight_bps, confidence, rationale_uri, vote_json_hash, \
          timestamp_secs, verified) \
         VALUES ($1, 2, 210, 0, $2, $3, $4, 1, 5000, 60, 'https://example.com/v2', $5, 1001000, FALSE)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&tx2)
    .bind(&agent_a)
    .bind(&vault_b)
    .bind(&vote_hash)
    .execute(pool)
    .await
    .unwrap();

    // agent_b: one verified vote on vault_a (Neutral, 5000).
    sqlx::query(
        "INSERT INTO committee_votes \
         (chain_id, vote_id, block_number, log_index, tx_hash, agent_address, vault_address, \
          stance, target_weight_bps, confidence, rationale_uri, vote_json_hash, \
          timestamp_secs, verified) \
         VALUES ($1, 3, 150, 0, $2, $3, $4, 1, 5000, 70, 'https://example.com/v3', $5, 900000, TRUE)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&tx3)
    .bind(&agent_b)
    .bind(&vault_a)
    .bind(&vote_hash)
    .execute(pool)
    .await
    .unwrap();

    // Regime snapshot for vault_a: avg of (7000 + 5000) / 2 = 6000, vote_count=2.
    sqlx::query(
        "INSERT INTO regime_snapshots \
         (chain_id, vault_address, block_number, avg_weight_bps, vote_count) \
         VALUES ($1, $2, 210, 6000.00, 2)",
    )
    .bind(PRIMARY_CHAIN_ID)
    .bind(&vault_a)
    .execute(pool)
    .await
    .unwrap();
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().build().unwrap()
}

// ─── AC-1: GET /v1/committee/agents ──────────────────────────────────────────

#[tokio::test]
async fn list_committee_agents_returns_all_agents() {
    let s = start_committee_server().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/committee/agents", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let agents = body["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 2, "expected 2 agents");

    // Both active and inactive agents are returned.
    let active_count = agents
        .iter()
        .filter(|a| a["active"].as_bool() == Some(true))
        .count();
    let inactive_count = agents
        .iter()
        .filter(|a| a["active"].as_bool() == Some(false))
        .count();
    assert_eq!(active_count, 1, "expected 1 active agent");
    assert_eq!(inactive_count, 1, "expected 1 inactive agent");

    // Freshness header.
    assert_eq!(body["block_number"], 1000);
    assert!(body["indexed_at"].is_string());
}

// ─── AC-2: GET /v1/committee/agents/:address/track-record ────────────────────

#[tokio::test]
async fn get_committee_track_record_returns_vote_history() {
    let s = start_committee_server().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/committee/agents/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/track-record",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let votes = body["votes"].as_array().unwrap();
    // agent_a has 2 votes.
    assert_eq!(votes.len(), 2, "expected 2 votes for agent_a");

    // Most recent vote is first (block 210 before block 200).
    assert_eq!(votes[0]["vote_id"], 2);
    assert_eq!(votes[1]["vote_id"], 1);

    // Freshness.
    assert_eq!(body["block_number"], 1000);
}

// ─── AC-3: GET /v1/committee/tilts excludes unverified ───────────────────────

#[tokio::test]
async fn committee_tilts_excludes_unverified_votes() {
    let s = start_committee_server().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/committee/tilts", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let tilts = body["tilts"].as_array().unwrap();

    // vault_a has 2 verified votes (vote_id 1 and 3); vault_b has 0 verified.
    assert_eq!(
        tilts.len(),
        1,
        "only vault_a should appear (vault_b has no verified votes)"
    );

    let vault_a_tilt = &tilts[0];
    assert_eq!(
        vault_a_tilt["vault"],
        "0x1111111111111111111111111111111111111111"
    );
    // avg of 7000 and 5000 = 6000
    assert_eq!(vault_a_tilt["vote_count"], 2);

    // Freshness.
    assert_eq!(body["block_number"], 1000);
}
