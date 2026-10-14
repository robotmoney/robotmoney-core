//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//! Implements: issue #1053 — IC event indexing acceptance tests.
//!
//! Four cases as required by the issue acceptance criteria:
//!   1. AgentRegistered creates a committee_agents row.
//!   2. VoteSubmitted with a valid (matching) memo hash sets verified=true
//!      and populates tilt fields.
//!   3. VoteSubmitted with a mismatched memo hash sets verified=false and
//!      stores the commitment without tilt data.
//!   4. AgentRevoked sets active=false on the committee_agents row.
//!
//! Later cases: one signal per member end to end (issue #1790), and the regime
//! feed following a revoke, a newer unverified vote and a stale signal, each
//! agreeing with `/v1/committee/tilts` (DI-3). A vote from a member whose
//! registration was never indexed no longer stops the tick (DI-4), and a
//! redeployed policy's votes are kept beside the old policy's (DI-10).
//!
//! All tests skip cleanly when Docker is not available.

mod common;

use alloy_primitives::Address;
use alloy_sol_types::SolEvent as _;
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::IInvestmentCommitteePolicyEvents,
    db::CountTable,
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
};
use std::net::SocketAddr;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

// ─── helpers ─────────────────────────────────────────────────────────────────

fn ic_addr() -> Address {
    Address::from([0xCCu8; 20])
}
fn gateway_addr() -> Address {
    Address::from([0x11u8; 20])
}
fn vault_addr() -> Address {
    Address::from([0x22u8; 20])
}
fn agent_addr() -> Address {
    Address::from([0xAAu8; 20])
}

fn stub_block(number: u64, hash_byte: u8, parent_byte: u8) -> serde_json::Value {
    serde_json::json!({
        "number":     format!("0x{:x}", number),
        "hash":       format!("0x{}", hex::encode([hash_byte; 32])),
        "parentHash": format!("0x{}", hex::encode([parent_byte; 32])),
        "timestamp":  "0x65000000",
        "transactions": []
    })
}

fn encode_agent_registered_log(
    ic: Address,
    agent: Address,
    agent_id: &str,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    let event = IInvestmentCommitteePolicyEvents::AgentRegistered {
        agent,
        agentId: agent_id.to_string(),
    };
    let log_data: LogData = event.encode_log_data();
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{:#x}", t))
        .collect();
    let data_hex = format!("0x{}", hex::encode(log_data.data.as_ref()));
    serde_json::json!({
        "address":          format!("{:#x}", ic),
        "topics":           topics,
        "data":             data_hex,
        "blockNumber":      format!("0x{:x}", block_number),
        "blockHash":        format!("0x{}", hex::encode([0xaau8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

fn encode_agent_revoked_log(
    ic: Address,
    agent: Address,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    let event = IInvestmentCommitteePolicyEvents::AgentRevoked { agent };
    let log_data: LogData = event.encode_log_data();
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{:#x}", t))
        .collect();
    let data_hex = format!("0x{}", hex::encode(log_data.data.as_ref()));
    serde_json::json!({
        "address":          format!("{:#x}", ic),
        "topics":           topics,
        "data":             data_hex,
        "blockNumber":      format!("0x{:x}", block_number),
        "blockHash":        format!("0x{}", hex::encode([0xbbu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

#[allow(clippy::too_many_arguments)]
fn encode_vote_submitted_log(
    ic: Address,
    vote_id: u64,
    agent: Address,
    vault: Address,
    stance: u8,
    target_weight_bps: u16,
    confidence: u8,
    rationale_uri: &str,
    vote_json_hash: [u8; 32],
    timestamp: u64,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::{FixedBytes, LogData, U256};
    let event = IInvestmentCommitteePolicyEvents::VoteSubmitted {
        voteId: U256::from(vote_id),
        agent,
        vault,
        stance,
        targetWeightBps: target_weight_bps,
        confidence,
        rationaleUri: rationale_uri.to_string(),
        voteJsonHash: FixedBytes(vote_json_hash),
        timestamp,
    };
    let log_data: LogData = event.encode_log_data();
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{:#x}", t))
        .collect();
    let data_hex = format!("0x{}", hex::encode(log_data.data.as_ref()));
    serde_json::json!({
        "address":          format!("{:#x}", ic),
        "topics":           topics,
        "data":             data_hex,
        "blockNumber":      format!("0x{:x}", block_number),
        "blockHash":        format!("0x{}", hex::encode([0xccu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

fn base_cfg(_stub: &StubRpcServer) -> IndexerConfig {
    IndexerConfig {
        chain_id: 8453,
        chain_name: "base".to_string(),
        rpc_label: "stub".to_string(),
        gateway: gateway_addr(),
        vault: vault_addr(),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: Some(ic_addr()),
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 100,
        start_block: None,
        end_block: Some(10),
        feature_flags: 0,
    }
}

fn program_stub_block10(stub: &StubRpcServer) {
    stub.set(
        "eth_blockNumber",
        serde_json::json!("0x14"), // 20 — safe head = 20 - 5 = 15 > 10
    );
    stub.set(
        "eth_getBlockByNumber",
        serde_json::json!(stub_block(10, 0xaa, 0x00)),
    );
    // eth_call is needed for vault heartbeat snapshot (totalAssets / totalSupply).
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
}

// ─── AC-1: AgentRegistered creates a row ─────────────────────────────────────

#[tokio::test]
async fn agent_registered_creates_row() {
    let fx = pg_fixture().await;

    let ic = ic_addr();
    let agent = agent_addr();
    let tx: [u8; 32] = [0x01; 32];

    let reg_log = encode_agent_registered_log(ic, agent, "athena-v1", 10, tx, 0);

    let stub = StubRpcServer::start().await;
    program_stub_block10(&stub);
    stub.set("eth_getLogs", serde_json::json!([reg_log]));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_cfg(&stub);

    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );

    let count = fx.db.count(CountTable::CommitteeAgents).await.unwrap();
    assert_eq!(count, 1, "expected 1 committee_agents row");

    // Verify the row fields.
    let row: (Vec<u8>, String, bool) = sqlx::query_as(
        "SELECT agent_address, agent_id, active FROM committee_agents \
         WHERE chain_id = $1",
    )
    .bind(8453i64)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(row.0, agent.as_slice(), "agent_address mismatch");
    assert_eq!(row.1, "athena-v1", "agent_id mismatch");
    assert!(row.2, "active should be true");
}

// ─── AC-2: VoteSubmitted with valid memo sets verified=true ──────────────────

/// A tiny HTTP server that serves a fixed body on any request.
/// Used to simulate a valid rationaleUri endpoint.
struct MemoServer {
    pub url: String,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

impl MemoServer {
    async fn start(body: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let url = format!("http://{}/memo.json", addr);
        let body_clone = body.clone();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    accept = listener.accept() => {
                        let Ok((mut stream, _)) = accept else { continue };
                        let body = body_clone.clone();
                        tokio::spawn(async move {
                            let mut buf = [0u8; 4096];
                            let _ = stream.read(&mut buf).await;
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                            let _ = stream.write_all(&body).await;
                        });
                    }
                }
            }
        });
        MemoServer { url, _shutdown: tx }
    }
}

#[tokio::test]
async fn vote_submitted_valid_memo_sets_verified_true() {
    let fx = pg_fixture().await;

    // First register the agent.
    let reg_tx: [u8; 32] = [0x01; 32];
    let vote_tx: [u8; 32] = [0x02; 32];
    let ic = ic_addr();
    let agent = agent_addr();
    let vault = vault_addr();

    // Memo JSON body.
    let memo_body = br#"{"agent_id":"athena-v1","vault":"0x2222","stance":"Overweight"}"#;
    let memo_hash = alloy_primitives::keccak256(memo_body);

    // Start memo server.
    let memo_srv = MemoServer::start(memo_body.to_vec()).await;

    let reg_log = encode_agent_registered_log(ic, agent, "athena-v1", 9, reg_tx, 0);
    let vote_log = encode_vote_submitted_log(
        ic,
        1,
        agent,
        vault,
        0, // Overweight
        6000,
        80,
        &memo_srv.url,
        memo_hash.0,
        1_000_000,
        10,
        vote_tx,
        1,
    );

    let stub = StubRpcServer::start().await;
    program_stub_block10(&stub);
    stub.set("eth_getLogs", serde_json::json!([reg_log, vote_log]));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_cfg(&stub);

    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );

    let (verified, stance, weight): (bool, i16, i16) = sqlx::query_as(
        "SELECT verified, stance, target_weight_bps FROM committee_votes \
         WHERE chain_id = $1 AND vote_id = 1",
    )
    .bind(8453i64)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();

    assert!(verified, "verified should be true for valid memo hash");
    assert_eq!(stance, 0, "stance should be 0 (Overweight)");
    assert_eq!(weight, 6000, "target_weight_bps mismatch");

    // Regime snapshot should also exist.
    let snap_count = fx.db.count(CountTable::RegimeSnapshots).await.unwrap();
    assert_eq!(snap_count, 1, "expected 1 regime_snapshots row");
}

// ─── AC-3: VoteSubmitted with hash-mismatched memo sets verified=false ────────

#[tokio::test]
async fn vote_submitted_hash_mismatch_sets_verified_false() {
    let fx = pg_fixture().await;

    let ic = ic_addr();
    let agent = agent_addr();
    let vault = vault_addr();
    let reg_tx: [u8; 32] = [0x01; 32];
    let vote_tx: [u8; 32] = [0x03; 32];

    // Memo body that does NOT match the hash stored on-chain.
    let actual_body = b"different content that does not match";
    let wrong_hash = [0xddu8; 32]; // deliberately wrong

    let memo_srv = MemoServer::start(actual_body.to_vec()).await;

    let reg_log = encode_agent_registered_log(ic, agent, "athena-v1", 9, reg_tx, 0);
    let vote_log = encode_vote_submitted_log(
        ic,
        2,
        agent,
        vault,
        1, // Neutral
        5000,
        50,
        &memo_srv.url,
        wrong_hash,
        2_000_000,
        10,
        vote_tx,
        1,
    );

    let stub = StubRpcServer::start().await;
    program_stub_block10(&stub);
    stub.set("eth_getLogs", serde_json::json!([reg_log, vote_log]));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_cfg(&stub);

    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );

    let (verified,): (bool,) =
        sqlx::query_as("SELECT verified FROM committee_votes WHERE chain_id = $1 AND vote_id = 2")
            .bind(8453i64)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();

    assert!(!verified, "verified should be false for hash mismatch");

    // No regime snapshot should be created for unverified votes.
    let snap_count = fx.db.count(CountTable::RegimeSnapshots).await.unwrap();
    assert_eq!(
        snap_count, 0,
        "expected 0 regime_snapshots for unverified vote"
    );
}

// ─── AC-4: AgentRevoked sets active=false ────────────────────────────────────

#[tokio::test]
async fn agent_revoked_sets_active_false() {
    let fx = pg_fixture().await;

    let ic = ic_addr();
    let agent = agent_addr();
    let reg_tx: [u8; 32] = [0x01; 32];
    let rev_tx: [u8; 32] = [0x04; 32];

    let reg_log = encode_agent_registered_log(ic, agent, "athena-v1", 9, reg_tx, 0);
    let rev_log = encode_agent_revoked_log(ic, agent, 10, rev_tx, 1);

    let stub = StubRpcServer::start().await;
    program_stub_block10(&stub);
    stub.set("eth_getLogs", serde_json::json!([reg_log, rev_log]));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_cfg(&stub);

    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );

    let (active, revoked_at): (bool, Option<i64>) =
        sqlx::query_as("SELECT active, revoked_at FROM committee_agents WHERE chain_id = $1")
            .bind(8453i64)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();

    assert!(!active, "active should be false after AgentRevoked");
    assert_eq!(revoked_at, Some(10), "revoked_at should be block 10");
}

// ─── Issue #1790: one signal per member, ingestion through rendering ─────────

/// A member that floods the IC with votes moves the tilt by one vote, and a
/// revoked member does not count. The events go through `run_once` (the real
/// ingestion path), then the explorer-api router is served over the same
/// database and both the live tilt and the stored regime snapshot are read
/// back over HTTP, as the dapp reads them.
#[tokio::test]
async fn vote_flood_from_one_member_counts_once_end_to_end() {
    let fx = pg_fixture().await;

    let ic = ic_addr();
    let vault = vault_addr();
    let flooder = Address::from([0xA1u8; 20]);
    let honest = Address::from([0xB2u8; 20]);
    let revoked = Address::from([0xC3u8; 20]);

    let memo_body = br#"{"agent_id":"flood","stance":"Overweight"}"#;
    let memo_hash = alloy_primitives::keccak256(memo_body).0;
    let memo_srv = MemoServer::start(memo_body.to_vec()).await;

    let mut logs = vec![
        encode_agent_registered_log(ic, flooder, "flooder", 9, [0x01; 32], 0),
        encode_agent_registered_log(ic, honest, "honest", 9, [0x02; 32], 1),
        encode_agent_registered_log(ic, revoked, "revoked", 9, [0x03; 32], 2),
    ];
    let vote = |vote_id: u64, agent: Address, weight: u16, log_index: u32| {
        encode_vote_submitted_log(
            ic,
            vote_id,
            agent,
            vault,
            0,
            weight,
            80,
            &memo_srv.url,
            memo_hash,
            1_000_000 + vote_id,
            10,
            [0x10 + vote_id as u8; 32],
            log_index,
        )
    };
    // The revoked member votes 0 bps, then is revoked.
    logs.push(vote(0, revoked, 0, 0));
    logs.push(encode_agent_revoked_log(ic, revoked, 10, [0x04; 32], 1));
    // The flooder's older signals (3000 bps) are superseded by its latest
    // (10000 bps); the honest member votes 2000 bps once, last.
    for i in 0..4u64 {
        logs.push(vote(1 + i, flooder, 3000, 2 + i as u32));
    }
    logs.push(vote(5, flooder, 10_000, 6));
    logs.push(vote(6, honest, 2000, 7));

    let stub = StubRpcServer::start().await;
    program_stub_block10(&stub);
    stub.set("eth_getLogs", serde_json::Value::Array(logs));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_cfg(&stub);
    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );
    assert_eq!(
        fx.db.count(CountTable::CommitteeVotes).await.unwrap(),
        7,
        "every vote is still recorded"
    );

    // Serve the explorer API over the indexed database.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = explorer_api::router(explorer_api::AppState::new(fx.db.pool().clone(), 8453));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let get = |path: &'static str| async move {
        reqwest::get(format!("http://{addr}{path}"))
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap()
    };

    // Two members count: the flooder's latest (10000) and the honest 2000.
    // Counting every vote would give 6 votes; counting the revoked member
    // would give 3 members.
    let tilts = get("/v1/committee/tilts").await;
    let tilts = tilts["tilts"].as_array().unwrap();
    assert_eq!(tilts.len(), 1, "one vault has a tilt: {tilts:?}");
    assert_eq!(tilts[0]["vote_count"], 2, "one vote per active member");
    let avg: f64 = tilts[0]["avg_weight_bps"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(avg, 6000.0, "mean of 10000 and 2000");

    // The regime snapshot the indexer stored agrees with the live tilt.
    let feed = get("/v1/regime/feed").await;
    let snaps = feed["snapshots"].as_array().unwrap();
    assert_eq!(snaps.len(), 1, "one vault snapshot: {snaps:?}");
    assert_eq!(snaps[0]["vote_count"], 2);
    let snap_avg: f64 = snaps[0]["avg_weight_bps"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(snap_avg, 6000.0);
}

// ─── DI-3: the regime feed follows every change to the tilt ──────────────────

/// A memo host and the digest a `VoteSubmitted` log commits to. A vote that
/// names `hash` verifies; [`Memo::wrong`] gives the same host with a digest the
/// memo does not hash to, so the vote is stored unverified.
struct Memo {
    url: String,
    hash: [u8; 32],
    _server: MemoServer,
}

impl Memo {
    async fn start() -> Self {
        let body = br#"{"agent_id":"regime","stance":"Overweight"}"#;
        let server = MemoServer::start(body.to_vec()).await;
        Memo {
            url: server.url.clone(),
            hash: alloy_primitives::keccak256(body).0,
            _server: server,
        }
    }

    fn wrong(&self) -> (String, [u8; 32]) {
        (self.url.clone(), [0xddu8; 32])
    }
}

/// A `VoteSubmitted` log from `agent` on `vault` at `block`, committing to
/// `(rationale_uri, digest)`.
fn regime_vote(
    (rationale_uri, digest): (String, [u8; 32]),
    vote_id: u64,
    agent: Address,
    vault: Address,
    weight: u16,
    block: u64,
    log_index: u32,
) -> serde_json::Value {
    encode_vote_submitted_log(
        ic_addr(),
        vote_id,
        agent,
        vault,
        0,
        weight,
        80,
        &rationale_uri,
        digest,
        1_000_000 + vote_id,
        block,
        [0x40 + vote_id as u8; 32],
        log_index,
    )
}

/// One `run_once` tick ending at `end_block`, answering `eth_getLogs` with
/// `logs`. Every block the stub serves has hash 0xaa, so the reorg check at the
/// start of the next tick always matches.
async fn regime_tick(
    fx: &common::PgFixture,
    stub: &StubRpcServer,
    end_block: u64,
    logs: Vec<serde_json::Value>,
) {
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    let mut cfg = base_cfg(stub);
    cfg.end_block = Some(end_block);
    // The freshness test crosses COMMITTEE_VOTE_FRESHNESS_BLOCKS in one tick.
    cfg.max_blocks_per_tick = 1_000_000;
    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );
    assert_eq!(
        outcome.last_indexed_block,
        Some(end_block as i64),
        "the tick must reach block {end_block}"
    );
}

/// A stub chain whose safe head sits far above every block these tests index.
fn regime_stub_program(stub: &StubRpcServer) {
    program_stub_block10(stub);
    stub.set("eth_blockNumber", serde_json::json!("0x100000"));
}

/// The explorer API served over the test database, read over HTTP as the dapp
/// reads it.
async fn serve_api(fx: &common::PgFixture) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = explorer_api::router(explorer_api::AppState::new(fx.db.pool().clone(), 8453));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

/// `/v1/regime/feed` (`snapshots`) or `/v1/committee/tilts` (`tilts`) as
/// `vault -> (vote_count, avg_weight_bps)`.
async fn read_tilts(
    addr: SocketAddr,
    path: &str,
    key: &str,
) -> std::collections::BTreeMap<String, (i64, f64)> {
    let body = reqwest::get(format!("http://{addr}{path}"))
        .await
        .unwrap()
        .json::<serde_json::Value>()
        .await
        .unwrap();
    body[key]
        .as_array()
        .unwrap_or_else(|| panic!("{path} has no `{key}` list: {body}"))
        .iter()
        .map(|row| {
            let vault = row["vault"].as_str().unwrap().to_string();
            let count = row["vote_count"].as_i64().unwrap();
            let avg: f64 = row["avg_weight_bps"].as_str().unwrap().parse().unwrap();
            (vault, (count, avg))
        })
        .collect()
}

/// The feed as `vault -> (vote_count, avg)`, after asserting it says the same
/// thing as the live tilt read at the same cursor.
async fn feed_matching_tilts(addr: SocketAddr) -> std::collections::BTreeMap<String, (i64, f64)> {
    let feed = read_tilts(addr, "/v1/regime/feed", "snapshots").await;
    let tilts = read_tilts(addr, "/v1/committee/tilts", "tilts").await;
    assert_eq!(
        feed, tilts,
        "/v1/regime/feed must agree with /v1/committee/tilts"
    );
    feed
}

/// Every stored regime row for `vault`, oldest first: `(block, vote_count, avg)`.
async fn regime_rows(fx: &common::PgFixture, vault: Address) -> Vec<(i64, i32, f64)> {
    let rows: Vec<(i64, i32, String)> = sqlx::query_as(
        "SELECT block_number, vote_count, CAST(avg_weight_bps AS TEXT) FROM regime_snapshots \
         WHERE chain_id = $1 AND vault_address = $2 ORDER BY block_number",
    )
    .bind(8453i64)
    .bind(vault.as_slice())
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    rows.into_iter()
        .map(|(b, c, a)| (b, c, a.parse().unwrap()))
        .collect()
}

fn vault_key(vault: Address) -> String {
    format!("0x{}", hex::encode(vault))
}

/// A revoked member leaves the regime feed in the block it is revoked, on
/// every vault it voted on. Before DI-3 the snapshot was refreshed only on a
/// verified vote, so the feed kept the revoked member's tilt as its newest row
/// while `/v1/committee/tilts` had dropped it.
#[tokio::test]
async fn revoked_member_drops_out_of_regime_feed() {
    let fx = pg_fixture().await;
    let memo = Memo::start().await;
    let stub = StubRpcServer::start().await;
    regime_stub_program(&stub);
    let api = serve_api(&fx).await;

    let ic = ic_addr();
    let vault_a = vault_addr();
    let vault_b = Address::from([0x33u8; 20]);
    let stays = Address::from([0xA1u8; 20]);
    let leaves = Address::from([0xB2u8; 20]);
    let signed = || (memo.url.clone(), memo.hash);

    // Tick 1: both members tilt vault A; only the leaver tilts vault B.
    regime_tick(
        &fx,
        &stub,
        10,
        vec![
            encode_agent_registered_log(ic, stays, "stays", 9, [0x01; 32], 0),
            encode_agent_registered_log(ic, leaves, "leaves", 9, [0x02; 32], 1),
            regime_vote(signed(), 1, leaves, vault_a, 8000, 10, 0),
            regime_vote(signed(), 2, stays, vault_a, 2000, 10, 1),
            regime_vote(signed(), 3, leaves, vault_b, 4000, 10, 2),
        ],
    )
    .await;
    let feed = feed_matching_tilts(api).await;
    assert_eq!(feed.len(), 2, "both vaults have a tilt: {feed:?}");
    assert_eq!(
        feed[&vault_key(vault_a)],
        (2, 5000.0),
        "mean of 8000 and 2000"
    );
    assert_eq!(feed[&vault_key(vault_b)], (1, 4000.0));

    // Tick 2: the leaver is revoked at block 11.
    regime_tick(
        &fx,
        &stub,
        11,
        vec![encode_agent_revoked_log(ic, leaves, 11, [0x03; 32], 0)],
    )
    .await;
    let feed = feed_matching_tilts(api).await;
    assert_eq!(
        feed.len(),
        1,
        "vault B had only the revoked member and leaves the feed: {feed:?}"
    );
    assert_eq!(
        feed[&vault_key(vault_a)],
        (1, 2000.0),
        "vault A counts only the member that stays"
    );

    // The table records the change at the revoke block: a new aggregate for
    // vault A and a zero-count row for vault B, after the rows from tick 1.
    assert_eq!(
        regime_rows(&fx, vault_a).await,
        vec![(10, 2, 5000.0), (11, 1, 2000.0)]
    );
    assert_eq!(
        regime_rows(&fx, vault_b).await,
        vec![(10, 1, 4000.0), (11, 0, 0.0)]
    );
}

/// A member's newer vote replaces its older one even when the newer memo does
/// not verify, so the member stops counting. The feed follows on that vote,
/// not only on verified ones (DI-3).
#[tokio::test]
async fn newer_unverified_vote_drops_member_out_of_regime_feed() {
    let fx = pg_fixture().await;
    let memo = Memo::start().await;
    let stub = StubRpcServer::start().await;
    regime_stub_program(&stub);
    let api = serve_api(&fx).await;

    let ic = ic_addr();
    let vault = vault_addr();
    let first = Address::from([0xA1u8; 20]);
    let second = Address::from([0xB2u8; 20]);
    let signed = || (memo.url.clone(), memo.hash);

    regime_tick(
        &fx,
        &stub,
        10,
        vec![
            encode_agent_registered_log(ic, first, "first", 9, [0x01; 32], 0),
            encode_agent_registered_log(ic, second, "second", 9, [0x02; 32], 1),
            regime_vote(signed(), 1, first, vault, 8000, 10, 0),
            regime_vote(signed(), 2, second, vault, 2000, 10, 1),
        ],
    )
    .await;
    assert_eq!(
        feed_matching_tilts(api).await[&vault_key(vault)],
        (2, 5000.0)
    );

    // The first member votes again at block 11, with a digest its memo does
    // not hash to.
    regime_tick(
        &fx,
        &stub,
        11,
        vec![regime_vote(memo.wrong(), 3, first, vault, 9000, 11, 0)],
    )
    .await;
    let (verified,): (bool,) =
        sqlx::query_as("SELECT verified FROM committee_votes WHERE chain_id = $1 AND vote_id = 3")
            .bind(8453i64)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();
    assert!(!verified, "the newer vote is stored unverified");
    assert_eq!(
        feed_matching_tilts(api).await[&vault_key(vault)],
        (1, 2000.0),
        "only the second member still counts"
    );
    assert_eq!(
        regime_rows(&fx, vault).await,
        vec![(10, 2, 5000.0), (11, 1, 2000.0)]
    );
}

/// A signal that ages out of the freshness window leaves the feed at the first
/// tick past the window, with no event to trigger it, and an unchanged tilt
/// writes no row on the ticks before that (DI-3).
#[tokio::test]
async fn stale_signal_drops_out_of_regime_feed_without_an_event() {
    let fx = pg_fixture().await;
    let memo = Memo::start().await;
    let stub = StubRpcServer::start().await;
    regime_stub_program(&stub);
    let api = serve_api(&fx).await;

    let ic = ic_addr();
    let vault = vault_addr();
    let member = Address::from([0xA1u8; 20]);
    let window = explorer_indexer::db::COMMITTEE_VOTE_FRESHNESS_BLOCKS as u64;

    regime_tick(
        &fx,
        &stub,
        10,
        vec![
            encode_agent_registered_log(ic, member, "member", 9, [0x01; 32], 0),
            regime_vote((memo.url.clone(), memo.hash), 1, member, vault, 6000, 10, 0),
        ],
    )
    .await;
    assert_eq!(
        feed_matching_tilts(api).await[&vault_key(vault)],
        (1, 6000.0)
    );

    // The last block inside the window: the signal at block 10 still counts,
    // and the unchanged tilt writes no new row.
    regime_tick(&fx, &stub, 10 + window - 1, vec![]).await;
    assert_eq!(
        feed_matching_tilts(api).await[&vault_key(vault)],
        (1, 6000.0)
    );
    assert_eq!(regime_rows(&fx, vault).await, vec![(10, 1, 6000.0)]);

    // One block later the signal is stale. No log arrives, and the tick
    // still takes the vault out of the feed.
    let edge = 10 + window;
    regime_tick(&fx, &stub, edge, vec![]).await;
    let feed = feed_matching_tilts(api).await;
    assert!(
        feed.is_empty(),
        "the stale signal leaves the feed: {feed:?}"
    );
    assert_eq!(
        regime_rows(&fx, vault).await,
        vec![(10, 1, 6000.0), (edge as i64, 0, 0.0)]
    );
}

// ─── DI-4 / DI-10: votes the committee tables used to refuse or drop ─────────

/// One `run_once` tick ending at `end_block` with `policy` as the configured
/// InvestmentCommitteePolicy, answering `eth_getLogs` with `logs`. The same
/// tick as [`regime_tick`], for a test that switches policy deployments.
async fn policy_tick(
    fx: &common::PgFixture,
    stub: &StubRpcServer,
    policy: Address,
    end_block: u64,
    logs: Vec<serde_json::Value>,
) {
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    let mut cfg = base_cfg(stub);
    cfg.investment_committee = Some(policy);
    cfg.end_block = Some(end_block);
    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(
        outcome.error.is_none(),
        "indexer error: {:?}",
        outcome.error
    );
    assert_eq!(
        outcome.last_indexed_block,
        Some(end_block as i64),
        "the tick must reach block {end_block}"
    );
}

/// A member registered below the indexed range has no `committee_agents` row.
/// Its vote used to fail the `committee_votes` foreign key, the tick errored
/// before the cursor advanced, and every retry read the same vote again, so
/// the indexer never moved past it (DI-4). The vote now gets an inactive
/// placeholder member: the vote is stored, it tilts nothing, the tick reaches
/// its target, and a registered member's vote later in the same tick still
/// counts. When the member's registration is indexed later, the placeholder
/// becomes a real row and only votes from that registration on count.
#[tokio::test]
async fn vote_from_unindexed_member_does_not_wedge_the_tick() {
    let fx = pg_fixture().await;
    let memo = Memo::start().await;
    let stub = StubRpcServer::start().await;
    regime_stub_program(&stub);
    let api = serve_api(&fx).await;

    let ic = ic_addr();
    let vault = vault_addr();
    let unindexed = Address::from([0xE1u8; 20]);
    let member = Address::from([0xA1u8; 20]);
    let signed = || (memo.url.clone(), memo.hash);

    // Tick 1: the unindexed member votes first, then a member whose
    // registration is in range. `regime_tick` fails on a tick error or a
    // cursor short of block 10.
    regime_tick(
        &fx,
        &stub,
        10,
        vec![
            encode_agent_registered_log(ic, member, "member", 9, [0x01; 32], 0),
            regime_vote(signed(), 7, unindexed, vault, 9000, 10, 0),
            regime_vote(signed(), 8, member, vault, 3000, 10, 1),
        ],
    )
    .await;

    assert_eq!(
        fx.db.count(CountTable::CommitteeVotes).await.unwrap(),
        2,
        "both votes are stored"
    );
    let placeholder: (String, bool, i64, Option<i64>) = sqlx::query_as(
        "SELECT agent_id, active, registered_at, revoked_at FROM committee_agents \
         WHERE chain_id = $1 AND agent_address = $2",
    )
    .bind(8453i64)
    .bind(unindexed.as_slice())
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        placeholder,
        (String::new(), false, 10, None),
        "an inactive placeholder row, first seen at the vote's block"
    );
    assert_eq!(
        feed_matching_tilts(api).await[&vault_key(vault)],
        (1, 3000.0),
        "the placeholder member's verified vote tilts nothing"
    );

    // Tick 2: the member's registration is indexed at block 11 and it votes
    // again there. The placeholder becomes a real row; the block-10 vote
    // predates the registration and still does not count.
    regime_tick(
        &fx,
        &stub,
        11,
        vec![
            encode_agent_registered_log(ic, unindexed, "late", 11, [0x02; 32], 0),
            regime_vote(signed(), 9, unindexed, vault, 7000, 11, 1),
        ],
    )
    .await;
    let registered: (String, bool, i64) = sqlx::query_as(
        "SELECT agent_id, active, registered_at FROM committee_agents \
         WHERE chain_id = $1 AND agent_address = $2",
    )
    .bind(8453i64)
    .bind(unindexed.as_slice())
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(registered, ("late".to_string(), true, 11));
    assert_eq!(
        feed_matching_tilts(api).await[&vault_key(vault)],
        (2, 5000.0),
        "mean of 3000 and the new 7000; the block-10 vote is superseded"
    );
}

/// A redeployed policy numbers its votes from 0 again (`voteId =
/// _votes.length`). Under the 0014 key `(chain_id, vote_id)` the new policy's
/// vote 0 hit the old policy's vote 0, and `ON CONFLICT DO NOTHING` dropped it
/// with no error, so the tilt kept the superseded policy's view (DI-10). Keyed
/// by the emitting contract (migration 0019), both votes are stored, the tilt
/// follows the member's newest signal, and the track record tells them apart.
#[tokio::test]
async fn votes_from_two_policy_deployments_both_persist() {
    let fx = pg_fixture().await;
    let memo = Memo::start().await;
    let stub = StubRpcServer::start().await;
    regime_stub_program(&stub);
    let api = serve_api(&fx).await;

    let old_policy = ic_addr();
    let new_policy = Address::from([0xCDu8; 20]);
    let vault = vault_addr();
    let member = Address::from([0xA1u8; 20]);
    let vote_zero = |policy: Address, weight: u16, block: u64, tx: u8, log_index: u32| {
        encode_vote_submitted_log(
            policy,
            0,
            member,
            vault,
            0,
            weight,
            80,
            &memo.url,
            memo.hash,
            1_000_000 + block,
            block,
            [tx; 32],
            log_index,
        )
    };

    // Tick 1 indexes the first policy: the member registers and casts vote 0.
    policy_tick(
        &fx,
        &stub,
        old_policy,
        10,
        vec![
            encode_agent_registered_log(old_policy, member, "member", 9, [0x01; 32], 0),
            vote_zero(old_policy, 8000, 10, 0x10, 1),
        ],
    )
    .await;

    // Tick 2 indexes the redeployed policy: the member registers there and
    // casts that policy's vote 0.
    policy_tick(
        &fx,
        &stub,
        new_policy,
        11,
        vec![
            encode_agent_registered_log(new_policy, member, "member", 11, [0x02; 32], 0),
            vote_zero(new_policy, 3000, 11, 0x11, 1),
        ],
    )
    .await;

    let rows: Vec<(Vec<u8>, i64, i16)> = sqlx::query_as(
        "SELECT contract_address, vote_id, target_weight_bps FROM committee_votes \
         WHERE chain_id = $1 ORDER BY block_number",
    )
    .bind(8453i64)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (old_policy.as_slice().to_vec(), 0, 8000),
            (new_policy.as_slice().to_vec(), 0, 3000),
        ],
        "each policy's vote 0 is stored under its own contract"
    );

    assert_eq!(
        feed_matching_tilts(api).await[&vault_key(vault)],
        (1, 3000.0),
        "the tilt counts the member's newest signal, from the new policy"
    );

    let body = reqwest::get(format!(
        "http://{api}/v1/committee/agents/{member:#x}/track-record"
    ))
    .await
    .unwrap()
    .json::<serde_json::Value>()
    .await
    .unwrap();
    let seen: Vec<(String, i64)> = body["votes"]
        .as_array()
        .unwrap_or_else(|| panic!("track record has no `votes` list: {body}"))
        .iter()
        .map(|v| {
            (
                v["contract_address"].as_str().unwrap().to_string(),
                v["vote_id"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        seen,
        vec![
            (format!("{new_policy:#x}"), 0),
            (format!("{old_policy:#x}"), 0)
        ],
        "the track record names the policy behind each vote 0, newest first"
    );
}
