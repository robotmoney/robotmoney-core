//! Canonical: docs/architecture.md §4.9 — Consensus Recommendation Receipt Contract
//! Canonical: docs/architecture.md §5.0 — Read Surface Taxonomy
//! Implements: issue #1247 — consensus receipt API endpoint tests.
//!
//! Covers:
//!   1. Protocol scope — GET /v1/consensus-receipts lists every commitment,
//!      newest first, and honours `?limit=`.
//!   2. Every field the dapp needs is present on each entry.
//!   3. Protocol scope — GET /v1/consensus-receipts/:receipt_id returns one,
//!      and 404s on an unknown id.
//!   4. Account scope — GET /v1/accounts/:address/consensus-receipts returns
//!      only the receipts anchored by that submitter.
//!   5. Unverified and unreleased receipts are still returned — a receipt that
//!      governance declined, or whose payload could not be fetched, must be
//!      visible as such rather than absent (architecture §4.9.1 answer 3).

use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;
use tokio::task::JoinHandle;

use explorer_api::{router, AppState};

const PRIMARY_CHAIN_ID: i64 = 8453;

/// All migrations in order. The consensus receipt migration (0015) is last.
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
    include_str!("../../../services/explorer-indexer/migrations/0015_consensus_receipts.sql"),
];

// Fixture identities.
const SUBMITTER_A: &str = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const SUBMITTER_B: &str = "0x5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b";
const TIMELOCK: &str = "0x7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b";
const RECEIPT_1: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const RECEIPT_2: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const RECEIPT_3: &str = "0x3333333333333333333333333333333333333333333333333333333333333333";
const UNKNOWN_RECEIPT: &str = "0x9999999999999999999999999999999999999999999999999999999999999999";

/// One seeded receipt: receipt_id, receipt_index, submitter, block_number,
/// verified, payload_bytes, released, released_at.
type FixtureRow = (
    &'static str,
    i64,
    &'static str,
    i64,
    bool,
    Option<i64>,
    bool,
    Option<i64>,
);

struct TestServer {
    pub addr: SocketAddr,
    _pool: sqlx::PgPool,
    _container: testcontainers::ContainerAsync<Postgres>,
    _server: JoinHandle<()>,
}

async fn start_receipt_server() -> TestServer {
    let container = Postgres::default().start().await.expect("start postgres");
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

    // Seed minimal indexer state (chain + indexer_run cursor for freshness).
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

    seed_receipt_fixture(&pool).await;

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

/// Three receipts:
///   receipt_1 — submitter A, block 300, verified, released at block 305.
///   receipt_2 — submitter A, block 310, verified, NOT released.
///   receipt_3 — submitter B, block 200, NOT verified (payload unfetchable),
///               NOT released.
async fn seed_receipt_fixture(pool: &sqlx::PgPool) {
    let rows: &[FixtureRow] = &[
        (
            RECEIPT_1,
            0,
            SUBMITTER_A,
            300,
            true,
            Some(512),
            true,
            Some(1_700_000_305),
        ),
        (RECEIPT_2, 1, SUBMITTER_A, 310, true, Some(600), false, None),
        (RECEIPT_3, 2, SUBMITTER_B, 200, false, None, false, None),
    ];

    for (receipt_id, index, submitter, block, verified, payload_bytes, released, released_at) in
        rows
    {
        sqlx::query(
            "INSERT INTO consensus_receipts \
               (chain_id, receipt_id, receipt_index, submitter, payload_digest, payload_uri, \
                recorded_at, block_number, log_index, tx_hash, verified, payload_bytes, \
                released, released_at, released_block_number, released_by) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,$14,$15)",
        )
        .bind(PRIMARY_CHAIN_ID)
        .bind(hex_bytes(receipt_id))
        .bind(index)
        .bind(hex_bytes(submitter))
        // Digest is the receipt id byte-pattern shifted by 0xd0 for legibility.
        .bind(vec![0xd0u8; 32])
        .bind(format!(
            "https://app.example.com/api/swarm/receipts/session-{index}"
        ))
        .bind(1_700_000_000i64 + block)
        .bind(*block)
        .bind(hex_bytes(receipt_id))
        .bind(*verified)
        .bind(*payload_bytes)
        .bind(*released)
        .bind(*released_at)
        .bind(released_at.map(|_| block + 5))
        .bind(released_at.map(|_| hex_bytes(TIMELOCK)))
        .execute(pool)
        .await
        .unwrap();
    }
}

fn http() -> reqwest::Client {
    reqwest::Client::builder().build().unwrap()
}

// ─── Protocol scope: list ────────────────────────────────────────────────────

#[tokio::test]
async fn list_consensus_receipts_returns_all_newest_first() {
    let s = start_receipt_server().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/consensus-receipts", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let receipts = body["receipts"].as_array().unwrap();
    assert_eq!(receipts.len(), 3, "expected all 3 receipts");

    // Newest first: block 310, 300, 200.
    assert_eq!(receipts[0]["receipt_id"], RECEIPT_2);
    assert_eq!(receipts[1]["receipt_id"], RECEIPT_1);
    assert_eq!(receipts[2]["receipt_id"], RECEIPT_3);
    assert_eq!(receipts[0]["block_number"], 310);
    assert_eq!(receipts[2]["block_number"], 200);

    // Freshness envelope.
    assert_eq!(body["block_number"], 1000);
    assert!(body["indexed_at"].is_string());
}

/// Every field the dapp needs must be on the wire. A missing field here is a
/// silent hole in the receipt surface.
#[tokio::test]
async fn consensus_receipt_entry_carries_every_dapp_field() {
    let s = start_receipt_server().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/consensus-receipts", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let entry = &body["receipts"][1]; // RECEIPT_1 — verified and released.
    for key in [
        "receipt_id",
        "index",
        "submitter",
        "payload_digest",
        "payload_uri",
        "recorded_at",
        "block_number",
        "tx_hash",
        "verified",
        "released",
        "released_at",
    ] {
        assert!(
            entry.get(key).is_some(),
            "consensus receipt entry must carry `{key}`; got {entry}"
        );
    }

    assert_eq!(entry["receipt_id"], RECEIPT_1);
    assert_eq!(entry["index"], 0);
    assert_eq!(entry["submitter"], SUBMITTER_A);
    assert_eq!(
        entry["payload_digest"],
        format!("0x{}", "d0".repeat(32)),
        "payload_digest must be 0x-prefixed 32-byte hex"
    );
    assert_eq!(
        entry["payload_uri"],
        "https://app.example.com/api/swarm/receipts/session-0"
    );
    assert_eq!(entry["recorded_at"], 1_700_000_300i64);
    assert_eq!(entry["block_number"], 300);
    assert_eq!(entry["tx_hash"], RECEIPT_1);
    assert_eq!(entry["verified"], true);
    assert_eq!(entry["released"], true);
    assert_eq!(entry["released_at"], 1_700_000_305i64);
}

#[tokio::test]
async fn list_consensus_receipts_honours_limit() {
    let s = start_receipt_server().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/consensus-receipts?limit=1", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let receipts = body["receipts"].as_array().unwrap();
    assert_eq!(receipts.len(), 1, "?limit=1 must return one receipt");
    assert_eq!(
        receipts[0]["receipt_id"], RECEIPT_2,
        "the newest receipt must be the one kept"
    );

    // A nonsensical limit is a 400, not a silent full scan.
    let status = http()
        .get(format!("http://{}/v1/consensus-receipts?limit=0", s.addr))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 400, "limit=0 must be rejected");
}

/// An unverified, unreleased receipt is still served — the record's whole point
/// is that it cannot be quietly withheld (architecture §4.9).
#[tokio::test]
async fn unverified_and_unreleased_receipts_are_still_listed() {
    let s = start_receipt_server().await;
    let body: serde_json::Value = http()
        .get(format!("http://{}/v1/consensus-receipts", s.addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let receipts = body["receipts"].as_array().unwrap();
    let unverified: Vec<_> = receipts
        .iter()
        .filter(|r| r["verified"].as_bool() == Some(false))
        .collect();
    assert_eq!(
        unverified.len(),
        1,
        "the unverified receipt must be listed, not dropped"
    );
    assert_eq!(unverified[0]["receipt_id"], RECEIPT_3);
    assert_eq!(unverified[0]["released"], false);
    assert!(
        unverified[0]["released_at"].is_null(),
        "released_at must be null on an unreleased receipt"
    );

    let unreleased = receipts
        .iter()
        .filter(|r| r["released"].as_bool() == Some(false))
        .count();
    assert_eq!(unreleased, 2, "both unreleased receipts must be listed");
}

// ─── Protocol scope: one by id ───────────────────────────────────────────────

#[tokio::test]
async fn get_consensus_receipt_by_id_returns_one() {
    let s = start_receipt_server().await;
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/consensus-receipts/{RECEIPT_1}",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    assert_eq!(body["receipt"]["receipt_id"], RECEIPT_1);
    assert_eq!(body["receipt"]["submitter"], SUBMITTER_A);
    assert_eq!(body["receipt"]["verified"], true);
    assert_eq!(body["receipt"]["released"], true);
    assert_eq!(body["block_number"], 1000, "freshness envelope");
}

#[tokio::test]
async fn get_consensus_receipt_unknown_id_is_404() {
    let s = start_receipt_server().await;
    let status = http()
        .get(format!(
            "http://{}/v1/consensus-receipts/{UNKNOWN_RECEIPT}",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 404, "an unknown receipt id must 404");

    // A malformed (non-32-byte) id is a 400, not a 500.
    let status = http()
        .get(format!(
            "http://{}/v1/consensus-receipts/0xdeadbeef",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, 400, "a malformed receipt id must 400");
}

// ─── Account scope: by submitter ─────────────────────────────────────────────

#[tokio::test]
async fn account_consensus_receipts_filters_by_submitter() {
    let s = start_receipt_server().await;

    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/{SUBMITTER_A}/consensus-receipts",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let receipts = body["receipts"].as_array().unwrap();
    assert_eq!(receipts.len(), 2, "submitter A anchored 2 receipts");
    assert_eq!(receipts[0]["receipt_id"], RECEIPT_2, "newest first");
    assert_eq!(receipts[1]["receipt_id"], RECEIPT_1);
    for r in receipts {
        assert_eq!(r["submitter"], SUBMITTER_A);
    }
    assert_eq!(body["block_number"], 1000, "freshness envelope");

    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/{SUBMITTER_B}/consensus-receipts",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let receipts = body["receipts"].as_array().unwrap();
    assert_eq!(receipts.len(), 1, "submitter B anchored 1 receipt");
    assert_eq!(receipts[0]["receipt_id"], RECEIPT_3);

    // An address that anchored nothing gets an empty list, not a 404.
    let body: serde_json::Value = http()
        .get(format!(
            "http://{}/v1/accounts/0x0000000000000000000000000000000000000001/consensus-receipts",
            s.addr
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        body["receipts"].as_array().unwrap().len(),
        0,
        "an address with no receipts gets an empty list"
    );
}
