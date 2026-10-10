//! Issue 1731: the Timelock and the Safe are listed and their events indexed; every tick records the chain
//! head; an endpoint that refuses (HTTP 403) is reported as a refusal with one request, not as a flaky tick.
//!
//! The tests use the shared Postgres fixture and a stub RPC. They do not skip when Docker is missing: the
//! fixture panics, naming the missing dependency (issue #1377).

mod common;

use alloy_primitives::{Address, Bytes, FixedBytes, LogData, B256, U256};
use alloy_sol_types::{SolCall as _, SolEvent as _};
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::{ITimelockEvents, Topics},
    db::CountTable,
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const CHAIN: i64 = 8453;

fn timelock() -> Address {
    Address::from([0x7Au8; 20])
}
fn safe() -> Address {
    Address::from([0x5Eu8; 20])
}

fn cfg() -> IndexerConfig {
    IndexerConfig {
        chain_id: CHAIN,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0x11u8; 20]),
        vault: Address::from([0x22u8; 20]),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: Some(timelock()),
        safe: Some(safe()),
        max_blocks_per_tick: 100,
        start_block: None,
        end_block: Some(10),
        feature_flags: 0,
    }
}

fn log_json(address: Address, ld: &LogData, block: u64, log_index: u32) -> serde_json::Value {
    serde_json::json!({
        "address":          format!("{address:#x}"),
        "topics":           ld.topics().iter().map(|t| format!("{t:#x}")).collect::<Vec<_>>(),
        "data":             format!("0x{}", hex::encode(ld.data.as_ref())),
        "blockNumber":      format!("0x{block:x}"),
        "blockHash":        format!("0x{}", hex::encode([0xaau8; 32])),
        "transactionHash":  format!("0x{}", hex::encode([0x01u8; 32])),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{log_index:x}"),
    })
}

fn program(stub: &StubRpcServer, head: u64) {
    stub.set("eth_blockNumber", serde_json::json!(format!("0x{head:x}")));
    stub.set(
        "eth_getBlockByNumber",
        serde_json::json!({
            "number": "0xa",
            "hash": format!("0x{}", hex::encode([0xaau8; 32])),
            "parentHash": format!("0x{}", hex::encode([0x00u8; 32])),
            "timestamp": "0x65000000",
            "transactions": []
        }),
    );
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
}

#[tokio::test]
async fn timelock_and_safe_events_are_indexed_listed_and_rolled_back_on_reorg() {
    let fx = pg_fixture().await;
    let topics = Topics::new();

    let scheduled = ITimelockEvents::CallScheduled {
        id: FixedBytes([0xab; 32]),
        index: U256::from(0),
        target: Address::from([0x99; 20]),
        value: U256::ZERO,
        data: Bytes::from(vec![0xde, 0xad]),
        predecessor: B256::ZERO,
        delay: U256::from(172_800u64),
    }
    .encode_log_data();
    let executed = ITimelockEvents::CallExecuted {
        id: FixedBytes([0xab; 32]),
        index: U256::ZERO,
        target: Address::from([0x99; 20]),
        value: U256::ZERO,
        data: Bytes::from(vec![0xde, 0xad]),
    }
    .encode_log_data();
    // Safe 1.4 layout: the transaction hash is indexed.
    let safe_ok = LogData::new_unchecked(
        vec![topics.safe_execution_success, B256::from([0xcd; 32])],
        Bytes::from(U256::from(0u64).to_be_bytes::<32>().to_vec()),
    );
    // An impostor with the Timelock's topic-0 from an address that is not the Timelock.
    let impostor = log_json(Address::from([0x01; 20]), &scheduled, 10, 9);

    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    stub.set(
        "eth_getLogs",
        serde_json::json!([
            log_json(timelock(), &scheduled, 10, 0),
            log_json(timelock(), &executed, 10, 1),
            log_json(safe(), &safe_ok, 10, 2),
            impostor,
        ]),
    );
    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);

    assert_eq!(
        fx.db.count(CountTable::AdminEvents).await.unwrap(),
        3,
        "the impostor is ignored"
    );
    let rows: Vec<(String, String, Option<Vec<u8>>, String)> = sqlx::query_as(
        "SELECT contract_kind, event_name, op_id, detail FROM admin_events \
         WHERE chain_id = $1 ORDER BY log_index",
    )
    .bind(CHAIN)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(rows[0].0, "timelock");
    assert_eq!(rows[0].1, "CallScheduled");
    assert_eq!(rows[0].2.as_deref(), Some(&[0xab; 32][..]));
    assert!(rows[0].3.contains("172800"), "{}", rows[0].3);
    assert_eq!(rows[1].1, "CallExecuted");
    assert_eq!(
        (rows[2].0.as_str(), rows[2].1.as_str()),
        ("safe", "ExecutionSuccess")
    );
    assert_eq!(rows[2].2.as_deref(), Some(&[0xcd; 32][..]));

    // Both are listed as contracts of the chain.
    let kinds: Vec<(Vec<u8>, String)> = sqlx::query_as(
        "SELECT address, kind FROM contracts WHERE chain_id = $1 AND kind IN ('timelock', 'safe')",
    )
    .bind(CHAIN)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert!(kinds.contains(&(timelock().to_vec(), "timelock".to_string())));
    assert!(kinds.contains(&(safe().to_vec(), "safe".to_string())));

    stub.shutdown();
    // A reorg above block 9 removes the rows with every other event table.
    fx.db.delete_above_block(CHAIN, 9).await.unwrap();
    assert_eq!(fx.db.count(CountTable::AdminEvents).await.unwrap(), 0);
}

#[tokio::test]
async fn every_tick_records_the_chain_head_even_when_nothing_is_left_to_index() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    stub.set("eth_getLogs", serde_json::json!([]));
    let rpc = JsonRpc::new(&stub.url);
    let mut c = cfg();
    c.end_block = None;

    let first = run_once(&fx.db, &rpc, &c).await.unwrap();
    assert!(first.error.is_none(), "{:?}", first.error);
    assert_eq!(first.chain_head_block, Some(20));
    let row: (Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT chain_head_block, last_indexed_block FROM indexer_runs WHERE run_id = $1",
    )
    .bind(first.run_id)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(row, (Some(20), Some(15)), "head 20, safe head 15");

    // Caught up: the next tick has nothing to read. It still records the head and keeps the cursor.
    let idle = run_once(&fx.db, &rpc, &c).await.unwrap();
    assert_eq!(idle.last_indexed_block, Some(15));
    let row: (Option<i64>,) =
        sqlx::query_as("SELECT chain_head_block FROM indexer_runs WHERE run_id = $1")
            .bind(idle.run_id)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();
    assert_eq!(row.0, Some(20));
    stub.shutdown();
}

/// Answers every request with 403 and counts them.
fn forbidden() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let h = Arc::clone(&hits);
    std::thread::spawn(move || {
        for s in listener.incoming() {
            let Ok(mut sock) = s else { break };
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf);
            h.fetch_add(1, Ordering::SeqCst);
            let _ = sock.write_all(
                b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    });
    (url, hits)
}

#[tokio::test]
async fn a_logs_endpoint_that_answers_403_is_reported_as_a_refusal_with_one_request() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    let (logs_url, logs_hits) = forbidden();
    let rpc = JsonRpc::new(&stub.url).with_logs_url(Some(logs_url));
    let mut c = cfg();
    c.end_block = None;

    let outcome = run_once(&fx.db, &rpc, &c).await.unwrap();
    assert!(outcome.refused, "the outcome says the endpoint refused");
    let err = outcome.error.expect("an error");
    assert!(
        err.contains("eth_getLogs refused by http://127.0.0.1"),
        "{err}"
    );
    assert!(err.contains("INDEXER_LOGS_RPC_URL"), "{err}");
    assert!(err.contains("https://base.gateway.tenderly.co"), "{err}");
    assert_eq!(
        logs_hits.load(Ordering::SeqCst),
        1,
        "one request, no hammering"
    );
    // The refusal is stored on the run, so the operator can read it from the database too.
    let stored: Option<String> =
        sqlx::query_scalar("SELECT error FROM indexer_runs WHERE run_id = $1")
            .bind(outcome.run_id)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();
    assert!(stored.unwrap().contains("refused by"));
    stub.shutdown();
}

#[tokio::test]
async fn a_transient_failure_is_not_a_refusal() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    stub.force_failure(true);
    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(outcome.error.is_some());
    assert!(
        !outcome.refused,
        "a JSON-RPC error object is not an HTTP refusal"
    );
    stub.shutdown();
}

fn pause_log(vault: Address, block: u64) -> serde_json::Value {
    let ld = LogData::new_unchecked(
        vec![Topics::new().deposits_paused],
        Bytes::from(vec![0u8; 32]),
    );
    log_json(vault, &ld, block, 0)
}

async fn register_vault(fx: &common::PgFixture, vault: Address) {
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    fx.db
        .upsert_contract(CHAIN, vault.into_array(), "vault", None)
        .await
        .unwrap();
    fx.db
        .upsert_vault(
            CHAIN,
            vault.into_array(),
            "Robot Money USDC",
            "STABLE_YIELD",
            U256::ZERO,
            0,
            1,
            1,
            [0x01; 32],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn a_deposits_paused_log_from_a_registered_vault_snapshots_its_paused_flag() {
    let fx = pg_fixture().await;
    let vault = Address::from([0x33u8; 20]);
    register_vault(&fx, vault).await;
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    // Every eth_call answers 1: totalAssets 1, totalSupply 1, depositsPaused() true.
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}01", "00".repeat(31))),
    );
    stub.set("eth_getLogs", serde_json::json!([pause_log(vault, 10)]));
    let rpc = JsonRpc::new(&stub.url);
    // The tick ends at block 12, so the heartbeat snapshot is at 12. A snapshot at block 10, where the pause
    // log is, can only come from the pause-log trigger.
    let mut c = cfg();
    c.end_block = Some(12);
    let outcome = run_once(&fx.db, &rpc, &c).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    let paused: Option<bool> = sqlx::query_scalar(
        "SELECT paused FROM vault_snapshots WHERE chain_id = $1 AND contract = $2 AND block_number = 10",
    )
    .bind(CHAIN)
    .bind(vault.as_slice())
    .fetch_optional(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        paused,
        Some(true),
        "the pause log's block carries a snapshot with paused = true"
    );
    stub.shutdown();
}

#[tokio::test]
async fn a_failed_depositspaused_read_skips_the_snapshot_instead_of_recording_open() {
    let fx = pg_fixture().await;
    let vault = Address::from([0x33u8; 20]);
    register_vault(&fx, vault).await;
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    // totalAssets, totalSupply, exitFeeBps and tvlCap answer; only depositsPaused() fails. Before the fix the
    // failure was read as "not paused" and a snapshot with paused = false was stored for a closed vault.
    let paused_selector = alloy_primitives::hex::encode(
        explorer_indexer::abi::IVaultReads::depositsPausedCall::SELECTOR,
    );
    stub.set_call_hook(Arc::new(move |data: &str| {
        if data.trim_start_matches("0x").starts_with(&paused_selector) {
            Err("execution reverted".to_string())
        } else {
            Ok(format!("0x{}01", "00".repeat(31)))
        }
    }));
    stub.set("eth_getLogs", serde_json::json!([pause_log(vault, 10)]));
    let rpc = JsonRpc::new(&stub.url);
    let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    let rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM vault_snapshots WHERE chain_id = $1 AND contract = $2",
    )
    .bind(CHAIN)
    .bind(vault.as_slice())
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(rows, 0, "no snapshot is better than a guessed 'open'");
    stub.shutdown();
}
