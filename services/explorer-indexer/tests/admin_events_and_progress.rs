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
    abi::{IGovernedUpgradeEvents, ITimelockEvents, IVaultRegistryEvents, Topics},
    db::CountTable,
    indexer::{
        backfill_proxy_events, run_once, IndexerConfig, ProxyBackfillOutcome,
        PROXY_BACKFILL_MAX_REQUESTS, PROXY_BACKFILL_SLICE_REQUESTS,
    },
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

/// Issue 1810: a proxied core contract's `Upgraded` and `UpgradesFrozen` are
/// stored as `proxy` rows naming the implementation (and the frozen code
/// hash), from the gateway and from RouterGovernance, which is now watched.
/// The same topic from the Timelock is not a proxy event. A reorg removes the
/// rows, so the derived freeze state rolls back with them.
#[tokio::test]
async fn proxy_upgrade_and_freeze_events_are_indexed_and_rolled_back_on_reorg() {
    let fx = pg_fixture().await;
    let gateway = cfg().gateway;
    let governance = Address::from([0x66u8; 20]);
    let impl_v1 = Address::from([0x1au8; 20]);
    let impl_v2 = Address::from([0x2bu8; 20]);

    let upgraded =
        |implementation| IGovernedUpgradeEvents::Upgraded { implementation }.encode_log_data();
    let frozen = IGovernedUpgradeEvents::UpgradesFrozen {
        proxy: gateway,
        implementation: impl_v2,
        codeHash: FixedBytes([0x77; 32]),
    }
    .encode_log_data();

    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    stub.set(
        "eth_getLogs",
        serde_json::json!([
            log_json(gateway, &upgraded(impl_v1), 10, 0),
            log_json(governance, &upgraded(impl_v1), 10, 1),
            log_json(gateway, &upgraded(impl_v2), 10, 2),
            log_json(gateway, &frozen, 10, 3),
            // Not a Robot Money proxy: ignored.
            log_json(timelock(), &upgraded(impl_v2), 10, 4),
        ]),
    );
    let rpc = JsonRpc::new(&stub.url);
    let mut c = cfg();
    c.router_governance = Some(governance);
    let outcome = run_once(&fx.db, &rpc, &c).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);

    // RouterGovernance is in the eth_getLogs address set.
    let asked_governance = stub.captured_requests().iter().any(|r| {
        r["method"] == "eth_getLogs"
            && r["params"][0]["address"]
                .as_array()
                .is_some_and(|a| a.iter().any(|x| x == &format!("{governance:#x}")))
    });
    assert!(
        asked_governance,
        "RouterGovernance must be watched for proxy events"
    );

    let rows: Vec<(Vec<u8>, String, String, String)> = sqlx::query_as(
        "SELECT contract, contract_kind, event_name, detail FROM admin_events \
         WHERE chain_id = $1 ORDER BY log_index",
    )
    .bind(CHAIN)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        rows.len(),
        4,
        "the Timelock's Upgraded is not a proxy event: {rows:?}"
    );
    for r in &rows {
        assert_eq!(r.1, "proxy");
    }
    assert_eq!(
        (rows[0].0.as_slice(), rows[0].2.as_str()),
        (gateway.as_slice(), "Upgraded")
    );
    assert!(
        rows[0].3.contains(&format!("{impl_v1:#x}")),
        "{}",
        rows[0].3
    );
    assert_eq!(rows[1].0.as_slice(), governance.as_slice());
    assert!(
        rows[2].3.contains(&format!("{impl_v2:#x}")),
        "{}",
        rows[2].3
    );
    assert_eq!(rows[3].2, "UpgradesFrozen");
    assert!(
        rows[3].3.contains(&format!("{impl_v2:#x}")),
        "{}",
        rows[3].3
    );
    assert!(rows[3].3.contains(&"77".repeat(32)), "{}", rows[3].3);

    stub.shutdown();
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
    stub.set_call_hook(Arc::new(move |_to: &str, data: &str| {
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

/// Issue 1840: the startup backfill reads every watched proxy's `Upgraded` and
/// `UpgradesFrozen` from the deploy floor up to the cursor, which live
/// ingestion never revisits. It stores the event block's transactions, so the
/// watchdog can tell a deployment by its contract-creation transaction. It
/// ignores other topics, other addresses and blocks above the cursor, and a
/// second run inserts nothing.
#[tokio::test]
async fn the_startup_backfill_indexes_proxy_events_below_the_cursor_once() {
    let fx = pg_fixture().await;
    let gateway = cfg().gateway;
    let late_vault = Address::from([0x33u8; 20]);
    register_vault(&fx, late_vault).await;
    let impl_v1 = Address::from([0x1au8; 20]);
    let upgraded =
        |implementation| IGovernedUpgradeEvents::Upgraded { implementation }.encode_log_data();
    let frozen = IGovernedUpgradeEvents::UpgradesFrozen {
        proxy: late_vault,
        implementation: impl_v1,
        codeHash: FixedBytes([0x66; 32]),
    }
    .encode_log_data();

    // A first tick with no logs moves the cursor to the safe head, 15.
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    stub.set("eth_getLogs", serde_json::json!([]));
    let rpc = JsonRpc::new(&stub.url);
    let mut c = cfg();
    c.end_block = None;
    c.start_block = Some(1);
    let first = run_once(&fx.db, &rpc, &c).await.unwrap();
    assert!(first.error.is_none(), "{:?}", first.error);
    assert_eq!(first.last_indexed_block, Some(15));
    assert_eq!(fx.db.count(CountTable::AdminEvents).await.unwrap(), 0);

    // The deploy-time events the live ticks never read: a contract creation at
    // block 5. Plus noise the backfill must ignore.
    stub.set(
        "eth_getBlockByNumber",
        serde_json::json!({
            "number": "0x5",
            "hash": format!("0x{}", hex::encode([0xbbu8; 32])),
            "parentHash": format!("0x{}", hex::encode([0x00u8; 32])),
            "timestamp": "0x65000000",
            "transactions": [{
                "hash": format!("0x{}", hex::encode([0x01u8; 32])),
                "transactionIndex": "0x0",
                "from": format!("0x{}", hex::encode([0x0eu8; 20])),
                "to": null
            }]
        }),
    );
    // Transaction 0x01 created the gateway proxy (and only the gateway).
    stub.set(
        "eth_getTransactionReceipt",
        serde_json::json!({"status": "0x1", "contractAddress": format!("{gateway:#x}")}),
    );
    // The gateway's deploy-time row was indexed before the receipt check
    // existed, so it carries no deployment mark yet.
    sqlx::query(
        "INSERT INTO admin_events (chain_id, block_number, log_index, tx_hash, contract, \
                                   contract_kind, event_name, detail) \
         VALUES ($1, 5, 0, $2, $3, 'proxy', 'Upgraded', $4)",
    )
    .bind(CHAIN)
    .bind(&[0x01u8; 32][..])
    .bind(gateway.as_slice())
    .bind(format!(r#"{{"implementation":"{impl_v1:#x}"}}"#))
    .execute(fx.db.pool())
    .await
    .unwrap();
    stub.set(
        "eth_getLogs",
        serde_json::json!([
            log_json(gateway, &upgraded(impl_v1), 5, 0),
            log_json(late_vault, &upgraded(impl_v1), 5, 1),
            log_json(late_vault, &frozen, 5, 2),
            // Not a watched proxy.
            log_json(Address::from([0x01; 20]), &upgraded(impl_v1), 5, 3),
            // The Timelock is not a Robot Money proxy.
            log_json(timelock(), &upgraded(impl_v1), 5, 4),
            // Above the cursor: live ingestion's job.
            log_json(gateway, &upgraded(impl_v1), 18, 0),
        ]),
    );
    let inserted = backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap();
    assert_eq!(
        inserted,
        ProxyBackfillOutcome::Done { inserted: 2 },
        "the registered vault's events; the gateway's row already existed"
    );
    let rows: Vec<(Vec<u8>, i64, String, String, String)> = sqlx::query_as(
        "SELECT contract, block_number, contract_kind, event_name, detail FROM admin_events \
         WHERE chain_id = $1 ORDER BY log_index",
    )
    .bind(CHAIN)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert!(rows.iter().all(|r| r.1 == 5 && r.2 == "proxy"), "{rows:?}");
    assert_eq!(rows[0].0.as_slice(), gateway.as_slice());
    assert_eq!(rows[2].0.as_slice(), late_vault.as_slice());
    assert_eq!(rows[2].3, "UpgradesFrozen");
    // Issue 1840 review: only the row whose transaction created THAT proxy is
    // the deployment. The existing gateway row is marked now. The vault's rows
    // share the creation transaction, but it created the gateway, so they page.
    let deployment = |d: &str| {
        serde_json::from_str::<serde_json::Value>(d).unwrap()["deployment"]
            == serde_json::json!(true)
    };
    assert!(deployment(&rows[0].4), "{}", rows[0].4);
    assert!(!deployment(&rows[1].4), "{}", rows[1].4);
    assert!(!deployment(&rows[2].4), "{}", rows[2].4);
    let creation: Option<Option<Vec<u8>>> =
        sqlx::query_scalar("SELECT to_addr FROM transactions WHERE chain_id = $1 AND tx_hash = $2")
            .bind(CHAIN)
            .bind(&[0x01u8; 32][..])
            .fetch_optional(fx.db.pool())
            .await
            .unwrap();
    assert_eq!(
        creation,
        Some(None),
        "the deployment's contract-creation transaction is stored"
    );

    // The proxy topics alone were asked for.
    let proxy_topics = [
        format!("{:#x}", Topics::new().proxy_upgraded),
        format!("{:#x}", Topics::new().proxy_upgrades_frozen),
    ];
    let last_logs = stub
        .captured_requests()
        .into_iter()
        .rev()
        .find(|r| r["method"] == "eth_getLogs")
        .unwrap();
    assert_eq!(
        last_logs["params"][0]["topics"][0],
        serde_json::json!(proxy_topics)
    );

    let again = backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap();
    assert_eq!(
        again,
        ProxyBackfillOutcome::Done { inserted: 0 },
        "idempotent: a second pass inserts nothing"
    );
    assert_eq!(fx.db.count(CountTable::AdminEvents).await.unwrap(), 3);
    stub.shutdown();
}

/// A finished indexer run whose cursor is `last_indexed_block`.
async fn finished_run(fx: &common::PgFixture, last_indexed_block: i64) {
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    let run = fx.db.start_run(CHAIN, 1).await.unwrap();
    fx.db
        .finish_run(
            run,
            Some(last_indexed_block),
            Some(last_indexed_block),
            0,
            0,
            None,
        )
        .await
        .unwrap();
}

/// The `fromBlock` of every `eth_getLogs` request the stub has seen.
fn get_logs_from_blocks(stub: &StubRpcServer) -> Vec<u64> {
    stub.captured_requests()
        .into_iter()
        .filter(|r| r["method"] == "eth_getLogs")
        .map(|r| {
            let from = r["params"][0]["fromBlock"].as_str().unwrap();
            u64::from_str_radix(from.trim_start_matches("0x"), 16).unwrap()
        })
        .collect()
}

/// Issue 1856: a refused range and a missing cursor used to return `Ok(0)`,
/// which the main loop took as done, so the backfill never ran again and only
/// one log line said why. Each is now its own outcome, saved in
/// `proxy_backfill_progress` (which `/health` reports as `proxy_backfill`),
/// and the next call tries again.
#[tokio::test]
async fn a_refused_or_cursorless_backfill_is_reported_and_retried_not_marked_done() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    stub.set("eth_getLogs", serde_json::json!([]));
    let rpc = JsonRpc::new(&stub.url);
    let mut c = cfg();
    c.end_block = None;
    c.start_block = Some(1);
    c.max_blocks_per_tick = 1000;
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    // Nothing indexed yet.
    assert_eq!(
        backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap(),
        ProxyBackfillOutcome::NoCursor
    );
    let state = fx.db.proxy_backfill_progress(CHAIN).await.unwrap().unwrap();
    assert_eq!(state.state, "no_cursor");

    // A cursor 20M blocks above the floor: 20000 requests, over the limit.
    finished_run(&fx, 20_000_000).await;
    let refused = ProxyBackfillOutcome::Refused {
        floor: 1,
        cursor: 20_000_000,
        requests: 20_000,
    };
    const { assert!(20_000 > PROXY_BACKFILL_MAX_REQUESTS) };
    assert_eq!(
        backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap(),
        refused
    );
    let state = fx.db.proxy_backfill_progress(CHAIN).await.unwrap().unwrap();
    assert_eq!(state.state, "refused", "{state:?}");
    assert_eq!(
        (state.floor_block, state.target_block),
        (Some(1), Some(20_000_000))
    );
    assert!(
        state
            .detail
            .as_deref()
            .is_some_and(|d| d.contains("INDEXER_START_BLOCK")),
        "the health record says what to do: {state:?}"
    );

    // Retried, not done: the next call refuses again, and nothing was scanned.
    assert_eq!(
        backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap(),
        refused
    );
    assert!(get_logs_from_blocks(&stub).is_empty());

    // The operator sets INDEXER_START_BLOCK: the retry now completes.
    c.start_block = Some(19_999_001);
    assert_eq!(
        backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap(),
        ProxyBackfillOutcome::Done { inserted: 0 }
    );
    let state = fx.db.proxy_backfill_progress(CHAIN).await.unwrap().unwrap();
    assert_eq!(state.state, "done", "{state:?}");
    assert_eq!(state.detail, None);
    stub.shutdown();
}

/// Issue 1856: the backfill used to scan the whole floor-to-cursor range inside
/// one tick, stalling live ingestion, and restart from the floor after any
/// error. Each call now scans one slice of at most
/// PROXY_BACKFILL_SLICE_REQUESTS requests from the saved checkpoint, and a
/// restart resumes the saved pass (same target) where it stopped.
#[tokio::test]
async fn the_backfill_scans_one_slice_per_tick_and_resumes_from_the_checkpoint() {
    let fx = pg_fixture().await;
    let gateway = cfg().gateway;
    let impl_v2 = Address::from([0x2bu8; 20]);
    let upgraded = IGovernedUpgradeEvents::Upgraded {
        implementation: impl_v2,
    }
    .encode_log_data();
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    // One upgrade at block 300, in the second slice.
    stub.set(
        "eth_getLogs",
        serde_json::json!([log_json(gateway, &upgraded, 300, 0)]),
    );
    let mut c = cfg();
    c.end_block = None;
    c.start_block = Some(1);
    c.max_blocks_per_tick = 10;
    let slice = 10 * PROXY_BACKFILL_SLICE_REQUESTS; // 250 blocks
    finished_run(&fx, 600).await;

    // Tick 1: blocks 1..=250, one slice of requests, checkpoint saved.
    let rpc = JsonRpc::new(&stub.url);
    assert_eq!(
        backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap(),
        ProxyBackfillOutcome::Progress {
            next_block: 1 + slice,
            target_block: 600,
            inserted: 0
        }
    );
    let first = get_logs_from_blocks(&stub);
    assert_eq!(
        first.len() as u64,
        PROXY_BACKFILL_SLICE_REQUESTS,
        "one slice"
    );
    assert_eq!((first[0], *first.last().unwrap()), (1, 241));
    let state = fx.db.proxy_backfill_progress(CHAIN).await.unwrap().unwrap();
    assert_eq!(
        (
            state.state.as_str(),
            state.floor_block,
            state.target_block,
            state.next_block
        ),
        ("running", Some(1), Some(600), Some(251))
    );

    // Live ingestion moves the cursor on, then the process restarts (a new
    // RPC client, nothing in memory). The saved pass resumes at block 251 and
    // keeps its target of 600.
    finished_run(&fx, 900).await;
    let restarted = JsonRpc::new(&stub.url);
    assert_eq!(
        backfill_proxy_events(&fx.db, &restarted, &c).await.unwrap(),
        ProxyBackfillOutcome::Progress {
            next_block: 501,
            target_block: 600,
            inserted: 1
        }
    );
    let second = get_logs_from_blocks(&stub)[first.len()..].to_vec();
    assert_eq!(second.len() as u64, PROXY_BACKFILL_SLICE_REQUESTS);
    assert_eq!(second[0], 251, "resumed from the checkpoint, not the floor");

    // Tick 3: the last 100 blocks, and the pass is done.
    assert_eq!(
        backfill_proxy_events(&fx.db, &restarted, &c).await.unwrap(),
        ProxyBackfillOutcome::Done { inserted: 0 }
    );
    let third = get_logs_from_blocks(&stub)[first.len() + second.len()..].to_vec();
    assert_eq!(third.len(), 10);
    assert_eq!((third[0], *third.last().unwrap()), (501, 591));
    assert_eq!(
        fx.db
            .proxy_backfill_progress(CHAIN)
            .await
            .unwrap()
            .unwrap()
            .state,
        "done"
    );
    assert_eq!(fx.db.count(CountTable::AdminEvents).await.unwrap(), 1);
    stub.shutdown();
}

/// Issue 1856 (review): a reorg rolls the cursor back below the pass's target
/// between slices. The pass stops at the new cursor and never stores a block
/// above it: live ingestion re-indexes that range, proxy topics included.
#[tokio::test]
async fn a_rollback_mid_pass_clamps_the_backfill_to_the_cursor() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    let gateway = cfg().gateway;
    let upgraded = IGovernedUpgradeEvents::Upgraded {
        implementation: Address::from([0x2bu8; 20]),
    }
    .encode_log_data();
    // Upgrades at 280 (below the rollback root) and 400 (above it).
    stub.set(
        "eth_getLogs",
        serde_json::json!([
            log_json(gateway, &upgraded, 280, 0),
            log_json(gateway, &upgraded, 400, 0)
        ]),
    );
    let mut c = cfg();
    c.end_block = None;
    c.start_block = Some(1);
    c.max_blocks_per_tick = 10;
    finished_run(&fx, 600).await;
    let rpc = JsonRpc::new(&stub.url);
    assert!(matches!(
        backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap(),
        ProxyBackfillOutcome::Progress {
            next_block: 251,
            target_block: 600,
            ..
        }
    ));

    // Reorg: the cursor falls back to 300.
    fx.db.delete_above_block(CHAIN, 300).await.unwrap();
    assert_eq!(fx.db.last_indexed_block(CHAIN).await.unwrap(), Some(300));
    assert_eq!(
        backfill_proxy_events(&fx.db, &rpc, &c).await.unwrap(),
        ProxyBackfillOutcome::Done { inserted: 1 },
        "the slice ends at the cursor: only the upgrade at 280"
    );
    let last_from = *get_logs_from_blocks(&stub).last().unwrap();
    assert_eq!(
        last_from, 291,
        "the last request starts at 291 and ends at 300"
    );
    let above: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks WHERE chain_id = $1 AND block_number > 300",
    )
    .bind(CHAIN)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(above, 0, "no block stored above the cursor");
    let state = fx.db.proxy_backfill_progress(CHAIN).await.unwrap().unwrap();
    assert_eq!(
        (state.state.as_str(), state.target_block),
        ("done", Some(300))
    );
    stub.shutdown();
}

/// Issue 1840: the registry is a proxied core contract, so its `Upgraded` and
/// `UpgradesFrozen` are indexed with INDEXER_MULTI_VAULT_EVENTS off. Its
/// `VaultRegistered` stays behind the flag.
#[tokio::test]
async fn registry_proxy_events_are_indexed_with_multi_vault_events_off() {
    let fx = pg_fixture().await;
    let registry = Address::from([0x44u8; 20]);
    let impl_v1 = Address::from([0x1au8; 20]);
    let upgraded = IGovernedUpgradeEvents::Upgraded {
        implementation: impl_v1,
    }
    .encode_log_data();
    let registered = IVaultRegistryEvents::VaultRegistered {
        vault: Address::from([0x33u8; 20]),
        name: "Robot Money USDC".into(),
        asset: Address::from([0x55u8; 20]),
    }
    .encode_log_data();

    let stub = StubRpcServer::start().await;
    program(&stub, 20);
    stub.set(
        "eth_getLogs",
        serde_json::json!([
            log_json(registry, &upgraded, 10, 0),
            log_json(registry, &registered, 10, 1),
        ]),
    );
    let rpc = JsonRpc::new(&stub.url);
    let mut c = cfg();
    c.registry = Some(registry);
    assert_eq!(c.feature_flags, 0, "INDEXER_MULTI_VAULT_EVENTS is off");
    let outcome = run_once(&fx.db, &rpc, &c).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);

    // The registry is asked for its proxy topics, not only by vault discovery.
    let upgraded_topic = format!("{:#x}", Topics::new().proxy_upgraded);
    let asked_registry_proxy = stub.captured_requests().iter().any(|r| {
        r["method"] == "eth_getLogs"
            && r["params"][0]["address"]
                .as_array()
                .is_some_and(|a| a.iter().any(|x| x == &format!("{registry:#x}")))
            && r["params"][0]["topics"][0]
                .as_array()
                .is_some_and(|t| t.iter().any(|x| x == &upgraded_topic))
    });
    assert!(
        asked_registry_proxy,
        "the registry's proxy topics must be fetched with the flag off"
    );

    let rows: Vec<(Vec<u8>, String, String)> = sqlx::query_as(
        "SELECT contract, contract_kind, event_name FROM admin_events WHERE chain_id = $1",
    )
    .bind(CHAIN)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![(
            registry.to_vec(),
            "proxy".to_string(),
            "Upgraded".to_string()
        )]
    );
    let vaults: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vaults WHERE chain_id = $1")
        .bind(CHAIN)
        .fetch_one(fx.db.pool())
        .await
        .unwrap();
    assert_eq!(vaults, 0, "VaultRegistered stays behind the flag");
    stub.shutdown();
}

/// Issue 1840 review: the timelock's executor role is open, so anyone can run a
/// ready upgrade from a throwaway contract's constructor. Its transaction is a
/// contract creation, but the contract it created is not the proxy, so the
/// indexer does not mark the `Upgraded` row as the deployment and the watchdog
/// pages it. When the transaction created the proxy itself, the row is marked.
#[tokio::test]
async fn a_proxy_row_is_the_deployment_only_when_its_transaction_created_that_proxy() {
    for (created, expect_deployment) in
        [(Address::from([0x99u8; 20]), false), (cfg().gateway, true)]
    {
        let fx = pg_fixture().await;
        let gateway = cfg().gateway;
        let upgraded = IGovernedUpgradeEvents::Upgraded {
            implementation: Address::from([0x2bu8; 20]),
        }
        .encode_log_data();
        let stub = StubRpcServer::start().await;
        program(&stub, 20);
        stub.set(
            "eth_getBlockByNumber",
            serde_json::json!({
                "number": "0xa",
                "hash": format!("0x{}", hex::encode([0xaau8; 32])),
                "parentHash": format!("0x{}", hex::encode([0x00u8; 32])),
                "timestamp": "0x65000000",
                "transactions": [{
                    "hash": format!("0x{}", hex::encode([0x01u8; 32])),
                    "transactionIndex": "0x0",
                    "from": format!("0x{}", hex::encode([0x0eu8; 20])),
                    "to": null
                }]
            }),
        );
        stub.set(
            "eth_getTransactionReceipt",
            serde_json::json!({"status": "0x1", "contractAddress": format!("{created:#x}")}),
        );
        stub.set(
            "eth_getLogs",
            serde_json::json!([log_json(gateway, &upgraded, 10, 0)]),
        );
        let rpc = JsonRpc::new(&stub.url);
        let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
        assert!(outcome.error.is_none(), "{:?}", outcome.error);
        let detail: String = sqlx::query_scalar(
            "SELECT detail FROM admin_events WHERE chain_id = $1 AND contract_kind = 'proxy'",
        )
        .bind(CHAIN)
        .fetch_one(fx.db.pool())
        .await
        .unwrap();
        let marked = serde_json::from_str::<serde_json::Value>(&detail).unwrap()["deployment"]
            == serde_json::json!(true);
        assert_eq!(marked, expect_deployment, "created {created:#x}: {detail}");
        stub.shutdown();
    }
}
