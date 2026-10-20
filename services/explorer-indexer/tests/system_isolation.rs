//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API (SYS-1)
//! Implements: core issue 1891 (SS-1019-8) — the vaults system and the gateway system are indexed
//! independently.
//!
//! These tests run the COMPILED `indexer` binary against a Postgres testcontainer and a local
//! JSON-RPC stub:
//!
//! 1. `a_run_with_no_gateway_indexes_vaults_and_receipts_and_never_asks_for_one` — no `--gateway`
//!    argument and no `INDEXER_GATEWAY` variable. The vault registry and the receipt register are
//!    ingested, the cursor moves, the gateway tables stay empty, and no RPC request names a gateway.
//! 2. `a_configured_gateway_is_watched_and_registered` — the control for test 1. The same run with a
//!    gateway asks the node for it and registers it. Without this test the absence in test 1 could be
//!    a stub that never records anything.
//! 3. `a_malformed_configured_gateway_exits_nonzero` — an explicitly configured gateway that is not an
//!    address is an error, never silently dropped.
//! 4. `an_empty_gateway_variable_means_no_gateway` — a deployment manifest that leaves the variable
//!    empty runs vaults-only.
//!
//! Like every test behind `pg_fixture()`, these fail loudly when Docker is absent.

mod common;

use alloy_primitives::{Address, FixedBytes, LogData};
use alloy_sol_types::SolEvent as _;
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::{IConsensusRecommendationReceiptEvents, IVaultRegistryEvents},
    db::CountTable,
};
use std::process::{Command, Output};

const CHAIN: i64 = 8453;
const GATEWAY: &str = "0x00000000000000000000000000000000000000bb";
const VAULT: &str = "0x00000000000000000000000000000000000000cc";
const REGISTRY: &str = "0x00000000000000000000000000000000000000ee";
const RECEIPT: &str = "0x00000000000000000000000000000000000000c7";
const END_BLOCK: u64 = 10;

fn log_json(address: &str, log_data: &LogData, log_index: u32, tx_byte: u8) -> serde_json::Value {
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{t:#x}"))
        .collect();
    serde_json::json!({
        "address":          address,
        "topics":           topics,
        "data":             format!("0x{}", hex::encode(log_data.data.as_ref())),
        "blockNumber":      format!("0x{END_BLOCK:x}"),
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode([tx_byte; 32])),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{log_index:x}"),
    })
}

/// Stub node for one bounded run: a VaultRegistered from the registry and a ReceiptRecorded from the
/// receipt register, both at the end block. It answers `eth_getLogs` like a node, by address.
fn program_node(stub: &StubRpcServer) {
    let registered = IVaultRegistryEvents::VaultRegistered {
        vault: Address::from([0xAAu8; 20]),
        name: "RobotMoney USDC Vault".to_string(),
        asset: Address::from([0xDDu8; 20]),
    };
    let recorded = IConsensusRecommendationReceiptEvents::ReceiptRecorded {
        receiptId: FixedBytes([0x9au8; 32]),
        submitter: Address::from([0x5Au8; 20]),
        index: alloy_primitives::U256::from(1u64),
        payloadDigest: FixedBytes([0x01u8; 32]),
        payloadUri: String::new(),
        recordedAt: 1_700_000_000,
    };
    stub.honour_log_filter(true);
    stub.set(
        "eth_getLogs",
        serde_json::json!([
            log_json(REGISTRY, &registered.encode_log_data(), 0, 0x11),
            log_json(RECEIPT, &recorded.encode_log_data(), 1, 0x22),
        ]),
    );
    stub.set("eth_blockNumber", serde_json::json!("0x20"));
    stub.set(
        "eth_getBlockByNumber",
        serde_json::json!({
            "number":     format!("0x{END_BLOCK:x}"),
            "hash":       format!("0x{}", hex::encode([0xabu8; 32])),
            "parentHash": format!("0x{}", hex::encode([0xaau8; 32])),
            "timestamp":  "0x65000000",
            "transactions": []
        }),
    );
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
}

/// Run the compiled indexer once. `gateway` is passed as `--gateway` when given. Every
/// chain-watching variable is cleared first, so the run sees only what this test passes.
async fn run_indexer(url: &str, rpc_url: &str, gateway: Option<&str>) -> Output {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_indexer"));
    cmd.arg("--once")
        .args(["--rpc-url", rpc_url])
        .args(["--vault", VAULT])
        .args(["--registry", REGISTRY])
        .args(["--consensus-receipt", RECEIPT])
        .args(["--start-block", "1"])
        .args(["--end-block", &END_BLOCK.to_string()])
        .env("DATABASE_URL", url)
        // INDEXER_MULTI_VAULT_EVENTS (flag id 2) turns the registry events on.
        .env("FEATURE_FLAGS", "4")
        .env_remove("INDEXER_RPC_URL")
        .env_remove("INDEXER_GATEWAY")
        .env_remove("INDEXER_VAULT")
        .env_remove("INDEXER_REGISTRY")
        .env_remove("INDEXER_ROUTER_GOVERNANCE")
        .env_remove("INDEXER_PORTFOLIO_ROUTER")
        .env_remove("INDEXER_CONSENSUS_RECEIPT")
        .env_remove("INDEXER_START_BLOCK")
        .env_remove("INDEXER_END_BLOCK");
    if let Some(gateway) = gateway {
        cmd.args(["--gateway", gateway]);
    }
    output(cmd).await
}

/// Run a command to completion off the async runtime, so the in-process stub node keeps answering.
async fn output(mut cmd: Command) -> Output {
    tokio::task::spawn_blocking(move || cmd.output().expect("failed to spawn the indexer"))
        .await
        .expect("join")
}

fn describe(out: &Output) -> String {
    format!(
        "status={:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    )
}

/// True when any request the stub received names `address` anywhere in its params (a log filter, a call
/// target, a code probe).
fn requests_name(stub: &StubRpcServer, address: &str) -> bool {
    let needle = address.to_lowercase();
    stub.captured_requests()
        .iter()
        .any(|r| r["params"].to_string().to_lowercase().contains(&needle))
}

async fn count(fx: &common::PgFixture, table: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as(&format!("SELECT COUNT(*)::BIGINT FROM {table}"))
        .fetch_one(fx.db.pool())
        .await
        .expect("count");
    n
}

async fn last_indexed(fx: &common::PgFixture) -> Option<i64> {
    fx.db
        .last_indexed_block(CHAIN)
        .await
        .expect("last indexed block")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_with_no_gateway_indexes_vaults_and_receipts_and_never_asks_for_one() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program_node(&stub);

    let out = run_indexer(&fx.url, &stub.url, None).await;
    assert!(
        out.status.success(),
        "a vaults-only run must boot with no gateway:\n{}",
        describe(&out)
    );

    // The vaults system is ingested: the registry's vault, the receipt, and the cursor.
    assert_eq!(
        fx.db.count(CountTable::Vaults).await.unwrap(),
        1,
        "{}",
        describe(&out)
    );
    assert_eq!(fx.db.count(CountTable::ConsensusReceipts).await.unwrap(), 1);
    assert_eq!(last_indexed(&fx).await, Some(END_BLOCK as i64));

    // The gateway system stays empty.
    assert_eq!(fx.db.count(CountTable::AgentDeposits).await.unwrap(), 0);
    assert_eq!(fx.db.count(CountTable::AgentPolicies).await.unwrap(), 0);
    let gateways: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM contracts WHERE kind = 'gateway'")
        .fetch_one(fx.db.pool())
        .await
        .unwrap();
    assert_eq!(gateways, 0, "no gateway contract row without a gateway");

    // No request names a gateway: the node was asked about the other contracts only.
    assert!(!requests_name(&stub, GATEWAY), "a request named a gateway");
    assert!(
        requests_name(&stub, REGISTRY) && requests_name(&stub, RECEIPT),
        "the run must have asked the node for the registry and the receipt register: {:?}",
        stub.captured_requests()
    );
    // Exactly one tick ran.
    assert_eq!(count(&fx, "indexer_runs").await, 1);
    stub.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_configured_gateway_is_watched_and_registered() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program_node(&stub);

    let out = run_indexer(&fx.url, &stub.url, Some(GATEWAY)).await;
    assert!(out.status.success(), "{}", describe(&out));

    // Same vaults-system rows as without a gateway.
    assert_eq!(fx.db.count(CountTable::Vaults).await.unwrap(), 1);
    assert_eq!(fx.db.count(CountTable::ConsensusReceipts).await.unwrap(), 1);
    assert_eq!(last_indexed(&fx).await, Some(END_BLOCK as i64));
    // The gateway is asked for and registered.
    assert!(
        requests_name(&stub, GATEWAY),
        "a configured gateway must be in the log filter"
    );
    let gateways: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM contracts WHERE kind = 'gateway'")
        .fetch_one(fx.db.pool())
        .await
        .unwrap();
    assert_eq!(gateways, 1);
    stub.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_configured_gateway_exits_nonzero() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program_node(&stub);

    for bad in ["not-an-address", "0x1234"] {
        let out = run_indexer(&fx.url, &stub.url, Some(bad)).await;
        assert!(
            !out.status.success(),
            "--gateway {bad:?} must exit nonzero:\n{}",
            describe(&out)
        );
    }
    // The run declined before indexing anything.
    assert_eq!(count(&fx, "indexer_runs").await, 0);
    assert!(
        stub.captured_requests().is_empty(),
        "no RPC request before a config error"
    );
    stub.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_gateway_variable_means_no_gateway() {
    let fx = pg_fixture().await;
    let stub = StubRpcServer::start().await;
    program_node(&stub);

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_indexer"));
    cmd.arg("--once")
        .args(["--rpc-url", &stub.url])
        .args(["--vault", VAULT])
        .args(["--registry", REGISTRY])
        .args(["--start-block", "1"])
        .args(["--end-block", &END_BLOCK.to_string()])
        .env("DATABASE_URL", &fx.url)
        .env("FEATURE_FLAGS", "4")
        .env("INDEXER_GATEWAY", "")
        .env_remove("INDEXER_CONSENSUS_RECEIPT");
    let out = output(cmd).await;
    assert!(out.status.success(), "{}", describe(&out));
    assert_eq!(fx.db.count(CountTable::Vaults).await.unwrap(), 1);
    assert!(!requests_name(&stub, GATEWAY));
    stub.shutdown();
}
