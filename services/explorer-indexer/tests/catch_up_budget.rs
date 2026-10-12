//! Issue 1769: request budget of one catch-up tick. A 1000-block tick over a range with no events
//! must stay within `TICK_REQUEST_BUDGET` JSON-RPC requests, whatever the endpoint latency is. The
//! docs (docs/development/stage-deployment.md, "Catch-up target") derive blocks per minute from it.
//! Uses the shared Postgres fixture and the stub RPC. It does not skip when Docker is missing.

mod common;

use alloy_primitives::{Address, U256};
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
    CONFIRMATIONS,
};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Requests allowed for one 1000-block tick with no events: block number, cursor header check,
/// one `eth_getLogs` for the whole range, the cursor block header, and up to six vault snapshot reads.
const TICK_REQUEST_BUDGET: usize = 10;

fn counts(stub: &StubRpcServer) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for r in stub.captured_requests() {
        *m.entry(r["method"].as_str().unwrap_or("?").to_string())
            .or_insert(0) += 1;
    }
    m
}

#[tokio::test]
async fn a_1000_block_tick_with_no_events_stays_within_the_request_budget() {
    let fx = pg_fixture().await;
    fx.db.upsert_chain(8453, "base", "stub").await.unwrap();
    let cfg = IndexerConfig {
        chain_id: 8453,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0x11u8; 20]),
        vault: Address::from([0x22u8; 20]),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 1000,
        start_block: Some(1000),
        end_block: None,
        feature_flags: 0,
    };
    let stub = StubRpcServer::start().await;
    // The tip is far past the first tick, so the tick reads exactly 1000 blocks (1000..=1999).
    stub.set(
        "eth_blockNumber",
        serde_json::json!(format!("0x{:x}", 5000 + CONFIRMATIONS)),
    );
    stub.set(
        "eth_getBlockByNumber",
        serde_json::json!({
            "number": "0x7cf",
            "hash": format!("0x{}", hex::encode([0xaau8; 32])),
            "parentHash": format!("0x{}", hex::encode([0x00u8; 32])),
            "timestamp": "0x65000000",
            "transactions": []
        }),
    );
    stub.set("eth_getLogs", serde_json::json!([]));
    let word = format!("0x{}", hex::encode(U256::from(7u64).to_be_bytes::<32>()));
    stub.set_call_hook(Arc::new(move |_to: &str, _data: &str| Ok(word.clone())));
    let rpc = JsonRpc::new(&stub.url);

    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(outcome.to_block, Some(1999), "one tick reads 1000 blocks");
    let first = counts(&stub);
    let total: usize = first.values().sum();
    eprintln!("first tick requests: {first:?} total {total}");
    assert_eq!(first.get("eth_getLogs"), Some(&1), "one logs call per tick");
    assert!(total <= TICK_REQUEST_BUDGET, "{total} > budget: {first:?}");

    // The next tick adds the cursor reorg check.
    let outcome = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(outcome.error.is_none(), "{:?}", outcome.error);
    assert_eq!(outcome.to_block, Some(2999));
    let all: usize = counts(&stub).values().sum();
    eprintln!("second tick requests: {}", all - total);
    assert!(
        all - total <= TICK_REQUEST_BUDGET,
        "{} > budget",
        all - total
    );
    stub.shutdown();
}
