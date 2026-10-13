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
