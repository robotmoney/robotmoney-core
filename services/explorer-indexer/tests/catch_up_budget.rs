//! Issue 1769: request budget of one catch-up tick. A 1000-block tick over a range with no events
//! must stay within `TICK_REQUEST_BUDGET` JSON-RPC requests, whatever the endpoint latency is. The
//! docs (docs/development/stage-deployment.md, "Catch-up target") derive blocks per minute from it.
//!
//! Issue 1781 and QA plan X6 (DI-6): the budget holds for the four vaults of a deployment, because a
//! tick reads a vault only when it is new, emitted a watched log, holds nothing, has an unknown cap or
//! is due a heartbeat. An event block costs its header and one receipt per transaction that carries a
//! watched log, never the block's other transactions, and a `null` receipt fails the tick.
//!
//! Uses the shared Postgres fixture and the stub RPC. It does not skip when Docker is missing.

mod common;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolEvent;
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::IGatewayEvents,
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
    CONFIRMATIONS,
};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Requests allowed for one 1000-block tick with no events: block number, cursor header check, one
/// `eth_getLogs` for the whole range and the cursor block header (4), plus seven snapshot `eth_call`s for
/// each vault the tick reads. A quiet deployment whose vaults all have a row reads none of them.
const TICK_REQUEST_BUDGET: usize = 10;

/// The snapshot reads of one vault: totalAssets, totalSupply, previewRedeem(totalSupply) (core 1795),
/// exitFeeBps, tvlCap, perDepositCap, depositsPaused.
const READS_PER_VAULT: usize = 7;

/// The one `exclusionLedger()` read of a vault the indexer has not seen before (security round 1). The
/// answer is stored in `vault_exclusion_ledgers`, so no later tick repeats it.
const LEDGER_READS_PER_VAULT: usize = 1;

const CHAIN: i64 = 8453;
const GATEWAY: Address = Address::new([0x11u8; 20]);
const CONFIGURED_VAULT: Address = Address::new([0x22u8; 20]);

fn counts(stub: &StubRpcServer) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for r in stub.captured_requests() {
        *m.entry(r["method"].as_str().unwrap_or("?").to_string())
            .or_insert(0) += 1;
    }
    m
}

fn cfg() -> IndexerConfig {
    IndexerConfig {
        chain_id: CHAIN,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Some(GATEWAY),
        vault: CONFIGURED_VAULT,
        registry: None,
        router_governance: None,
        portfolio_router: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 1000,
        start_block: Some(1000),
        end_block: None,
        feature_flags: 0,
    }
}

/// A stub whose tip is far past the first tick, so each tick reads exactly 1000 blocks
/// (1000..=1999, then 2000..=2999). Every `eth_call` answers 7: a vault that holds value, with known
/// caps.
async fn stub(block: serde_json::Value) -> StubRpcServer {
    let stub = StubRpcServer::start().await;
    stub.set(
        "eth_blockNumber",
        serde_json::json!(format!("0x{:x}", 5000 + CONFIRMATIONS)),
    );
    stub.set("eth_getBlockByNumber", block);
    stub.set("eth_getLogs", serde_json::json!([]));
    let word = format!("0x{}", hex::encode(U256::from(7u64).to_be_bytes::<32>()));
    stub.set_call_hook(Arc::new(move |_to: &str, _data: &str| Ok(word.clone())));
    stub
}

fn header_only_block() -> serde_json::Value {
    serde_json::json!({
        "number": "0x7cf",
        "hash": format!("0x{}", hex::encode([0xaau8; 32])),
        "parentHash": format!("0x{}", hex::encode([0x00u8; 32])),
        "timestamp": "0x65000000",
        "transactions": []
    })
}

#[tokio::test]
async fn a_1000_block_tick_with_no_events_stays_within_the_request_budget() {
    let fx = pg_fixture().await;
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    // Four vaults, as on 8453: the configured one and three registry vaults (issue 1781).
    let registered = [0x31u8, 0x32, 0x33].map(|b| Address::from([b; 20]));
    for (i, vault) in registered.iter().enumerate() {
        fx.db
            .upsert_contract(CHAIN, vault.into_array(), "vault", None)
            .await
            .unwrap();
        fx.db
            .upsert_vault(
                CHAIN,
                vault.into_array(),
                &format!("Robot Money Basket {i}"),
                "SPECULATIVE",
                U256::ZERO,
                0,
                1,
                1,
                [0x01; 32],
            )
            .await
            .unwrap();
    }
    let vaults = 1 + registered.len();
    let stub = stub(header_only_block()).await;
    let rpc = JsonRpc::new(&stub.url);

    // First sight: every vault takes its first row, seven reads each, once, and names its
    // ExclusionLedger, one read each, once.
    let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(outcome.to_block, Some(1999), "one tick reads 1000 blocks");
    let first = counts(&stub);
    let total: usize = first.values().sum();
    eprintln!("first tick requests: {first:?} total {total}");
    assert_eq!(first.get("eth_getLogs"), Some(&1), "one logs call per tick");
    assert_eq!(
        first.get("eth_call").copied().unwrap_or(0),
        (READS_PER_VAULT + LEDGER_READS_PER_VAULT) * vaults,
        "the first tick reads each of the {vaults} vaults once and asks each for its ledger once"
    );
    let rest = total - (READS_PER_VAULT + LEDGER_READS_PER_VAULT) * vaults;
    assert!(rest <= TICK_REQUEST_BUDGET, "{rest} > budget: {first:?}");

    // The next tick adds the cursor reorg check and reads none of the four vaults: each holds value,
    // has known caps, emitted no log and is 1000 blocks from its heartbeat (issue 1781).
    let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(outcome.to_block, Some(2999));
    let second: BTreeMap<String, usize> = counts(&stub)
        .into_iter()
        .map(|(m, n)| {
            let before = first.get(&m).copied().unwrap_or(0);
            (m, n - before)
        })
        .filter(|(_, n)| *n > 0)
        .collect();
    let total: usize = second.values().sum();
    eprintln!("second tick requests: {second:?} total {total}");
    assert_eq!(
        second.get("eth_call"),
        None,
        "a quiet tick reads no vault: {second:?}"
    );
    assert_eq!(second.get("eth_getLogs"), Some(&1));
    assert!(
        total <= TICK_REQUEST_BUDGET,
        "{total} > budget with {vaults} vaults: {second:?}"
    );
    stub.shutdown();
}

/// A watched gateway log at `block`, carried by transaction `tx_hash` at position `tx_index`.
fn gateway_log(block: u64, tx_hash: [u8; 32], tx_index: u32, log_index: u32) -> serde_json::Value {
    let ld = IGatewayEvents::DepositsPaused {
        by: Address::from([0x44u8; 20]),
    }
    .encode_log_data();
    serde_json::json!({
        "address":          format!("{GATEWAY:#x}"),
        "topics":           ld.topics().iter().map(|t| format!("{t:#x}")).collect::<Vec<_>>(),
        "data":             format!("0x{}", hex::encode(ld.data.as_ref())),
        "blockNumber":      format!("0x{block:x}"),
        "blockHash":        format!("0x{}", hex::encode([0xaau8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": format!("0x{tx_index:x}"),
        "logIndex":         format!("0x{log_index:x}"),
    })
}

const EVENT_BLOCK: u64 = 1500;
const TX_A: [u8; 32] = [0xa1u8; 32];
const TX_B: [u8; 32] = [0xb2u8; 32];

/// Block 1500 holds 200 transactions. Two of them carry watched logs: A (index 7, two logs) and B
/// (index 42, one log).
async fn busy_event_block_stub() -> StubRpcServer {
    let txs: Vec<serde_json::Value> = (0u32..200)
        .map(|i| {
            serde_json::json!({
                "hash": format!("0x{}", hex::encode(U256::from(10_000 + i).to_be_bytes::<32>())),
                "transactionIndex": format!("0x{i:x}"),
                "from": format!("0x{}", hex::encode([0x99u8; 20])),
                "to": format!("0x{}", hex::encode([0x98u8; 20])),
            })
        })
        .collect();
    let mut block = header_only_block();
    block["number"] = serde_json::json!(format!("0x{EVENT_BLOCK:x}"));
    block["transactions"] = serde_json::Value::Array(txs);
    let stub = stub(block).await;
    stub.set(
        "eth_getLogs",
        serde_json::json!([
            gateway_log(EVENT_BLOCK, TX_A, 7, 0),
            gateway_log(EVENT_BLOCK, TX_A, 7, 1),
            gateway_log(EVENT_BLOCK, TX_B, 42, 5),
        ]),
    );
    stub
}

const RECEIPT_FROM: [u8; 20] = [0xf1u8; 20];

/// `transactions` row: tx_hash, block_number, tx_index, from_addr, to_addr, status.
type TxRow = (Vec<u8>, i64, i32, Vec<u8>, Option<Vec<u8>>, i16);

#[tokio::test]
async fn event_block_fetches_only_log_bearing_transactions() {
    let fx = pg_fixture().await;
    let stub = busy_event_block_stub().await;
    stub.set(
        "eth_getTransactionReceipt",
        serde_json::json!({
            "status": "0x1",
            "from": format!("0x{}", hex::encode(RECEIPT_FROM)),
            "to": format!("{GATEWAY:#x}"),
        }),
    );
    let rpc = JsonRpc::new(&stub.url);

    let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(outcome.to_block, Some(1999));

    let requests = stub.captured_requests();
    stub.shutdown();
    let blocks: Vec<&serde_json::Value> = requests
        .iter()
        .filter(|r| r["method"] == "eth_getBlockByNumber")
        .collect();
    assert!(!blocks.is_empty());
    for r in &blocks {
        assert_eq!(
            r["params"][1],
            serde_json::json!(false),
            "a block is fetched without its transactions: {r}"
        );
    }
    let mut receipts: Vec<String> = requests
        .iter()
        .filter(|r| r["method"] == "eth_getTransactionReceipt")
        .map(|r| r["params"][0].as_str().unwrap().to_lowercase())
        .collect();
    receipts.sort();
    assert_eq!(
        receipts,
        vec![
            format!("0x{}", hex::encode(TX_A)),
            format!("0x{}", hex::encode(TX_B)),
        ],
        "one receipt per transaction that carries a watched log, none for the other 198"
    );

    // The rows: hash, block and index from the log; from, to and status from the receipt.
    let rows: Vec<TxRow> = sqlx::query_as(
        "SELECT tx_hash, block_number, tx_index, from_addr, to_addr, status \
         FROM transactions WHERE chain_id = $1 ORDER BY tx_index",
    )
    .bind(CHAIN)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                TX_A.to_vec(),
                EVENT_BLOCK as i64,
                7,
                RECEIPT_FROM.to_vec(),
                Some(GATEWAY.as_slice().to_vec()),
                1
            ),
            (
                TX_B.to_vec(),
                EVENT_BLOCK as i64,
                42,
                RECEIPT_FROM.to_vec(),
                Some(GATEWAY.as_slice().to_vec()),
                1
            ),
        ]
    );
    let block_row: Option<(i64,)> =
        sqlx::query_as("SELECT block_number FROM blocks WHERE chain_id = $1 AND block_number = $2")
            .bind(CHAIN)
            .bind(EVENT_BLOCK as i64)
            .fetch_optional(fx.db.pool())
            .await
            .unwrap();
    assert!(block_row.is_some(), "the event block keeps its blocks row");
}

#[tokio::test]
async fn a_null_receipt_fails_the_tick_instead_of_storing_status_0() {
    let fx = pg_fixture().await;
    let stub = busy_event_block_stub().await;
    // A node that served the logs but does not know the transaction (a lagging backend, a reorg).
    stub.set("eth_getTransactionReceipt", serde_json::Value::Null);
    let rpc = JsonRpc::new(&stub.url);

    let outcome = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    stub.shutdown();
    let error = outcome.error.expect("a null receipt fails the tick");
    assert!(error.contains("eth_getTransactionReceipt"), "{error}");
    assert_eq!(
        outcome.last_indexed_block, None,
        "the cursor does not pass the block"
    );
    let txs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transactions WHERE chain_id = $1")
        .bind(CHAIN)
        .fetch_one(fx.db.pool())
        .await
        .unwrap();
    assert_eq!(txs, 0, "no transaction is stored with a made-up status 0");
    let block_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE chain_id = $1 AND block_number = $2")
            .bind(CHAIN)
            .bind(EVENT_BLOCK as i64)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();
    assert_eq!(
        block_rows, 0,
        "the block is read in full before any row of it is written"
    );
}
