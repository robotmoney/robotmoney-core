//! Canonical: none — integration tests for `rmpc deposit`
//!
//! Integration tests for `rmpc deposit` (issue #16).
//!
//! The happy-path test wires a `mockito` server with the full preflight
//! response set + `eth_feeHistory` + `eth_getTransactionCount` +
//! `eth_sendRawTransaction` + `eth_getTransactionReceipt` (carrying a
//! synthetic `AgentDeposit` log), invokes the binary, and asserts on the
//! JSON shape on stdout. Refusal-path tests override individual mocks to
//! force a specific failure mode and check the named-error JSON body.

mod common;

use crate::common::{
    enc_bool, install_gateway_implementation, install_happy_path_mocks, jrpc_result,
    jrpc_result_raw, match_eth_call_selector, selector_hex_of, Fixture, FIXTURE_BLOCK_TAG, GATEWAY,
    GATEWAY_CODE, SHARE_RECEIVER, SIGNER_ADDRESS, TEST_PASSPHRASE,
};
use alloy_primitives::{address, b256, hex as ahex, Address, Bytes, LogData, B256, U256};
use alloy_sol_types::{SolCall, SolEvent};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

const ORDER_ID: B256 = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const IDEMPOTENCY_KEY: B256 =
    b256!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const PAYMENT_ID: B256 = b256!("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
const TX_HASH: B256 = b256!("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");

/// One fee_history JSON-RPC body. `latest` block index is irrelevant for
/// the test; only the numeric fields matter for `compute_fees`.
fn fee_history_body() -> String {
    // base fees: all 1 gwei; rewards: 1 gwei. → maxFee = 2*1+1 = 3 gwei,
    // tip = 1 gwei. Well under the 100 gwei cap baked into Fixture's TOML.
    r#"{
        "oldestBlock":"0x1",
        "baseFeePerGas":["0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00"],
        "gasUsedRatio":[0.5,0.5,0.5,0.5,0.5],
        "reward":[["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"]]
    }"#
    .to_string()
}

/// Build the JSON for a `eth_getTransactionReceipt` body that carries
/// the `AgentDeposit` event log emitted by the gateway. Fields not used
/// by the deposit command are still populated to keep alloy's
/// `TransactionReceipt` deserialiser happy.
fn receipt_with_agent_deposit_body(amount: U256, shares: U256) -> String {
    let ev = RobotMoneyGateway::AgentDeposit {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        agent: SIGNER_ADDRESS,
        shareReceiver: SHARE_RECEIVER,
        amount,
        sharesMinted: shares,
        windowId: 42u64,
    };
    let topics = ev.encode_topics();
    let data: Vec<u8> = ev.encode_data();
    let log = LogData::new_unchecked(
        topics.iter().map(|t| B256::from(t.0)).collect(),
        Bytes::from(data),
    );
    let topics_hex: Vec<String> = log
        .topics()
        .iter()
        .map(|t| format!("\"0x{}\"", ahex::encode(t.as_slice())))
        .collect();
    let data_hex = format!("0x{}", ahex::encode(log.data.as_ref()));

    format!(
        r#"{{
            "transactionHash":"{TX_HASH:#x}",
            "transactionIndex":"0x0",
            "blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001",
            "blockNumber":"0x42",
            "from":"{SIGNER_ADDRESS:#x}",
            "to":"{GATEWAY:#x}",
            "cumulativeGasUsed":"0x5208",
            "gasUsed":"0x5208",
            "contractAddress":null,
            "logs":[{{
                "address":"{GATEWAY:#x}",
                "topics":[{topics}],
                "data":"{data_hex}",
                "blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001",
                "blockNumber":"0x42",
                "transactionHash":"{TX_HASH:#x}",
                "transactionIndex":"0x0",
                "logIndex":"0x0",
                "removed":false
            }}],
            "status":"0x1",
            "logsBloom":"0x{bloom}",
            "type":"0x2",
            "effectiveGasPrice":"0x3b9aca00"
        }}"#,
        topics = topics_hex.join(","),
        bloom = "00".repeat(256),
    )
}

/// Receipt with `status: 0x0` — i.e. the tx mined but reverted.
fn reverted_receipt_body() -> String {
    format!(
        r#"{{
            "transactionHash":"{TX_HASH:#x}",
            "transactionIndex":"0x0",
            "blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001",
            "blockNumber":"0x42",
            "from":"{SIGNER_ADDRESS:#x}",
            "to":"{GATEWAY:#x}",
            "cumulativeGasUsed":"0x5208",
            "gasUsed":"0x5208",
            "contractAddress":null,
            "logs":[],
            "status":"0x0",
            "logsBloom":"0x{bloom}",
            "type":"0x2",
            "effectiveGasPrice":"0x3b9aca00"
        }}"#,
        bloom = "00".repeat(256),
    )
}

async fn install_post_preflight_mocks(server: &mut mockito::ServerGuard, receipt_body: &str) {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_feeHistory"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&fee_history_body()))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionCount"}),
        ))
        .with_status(200)
        .with_body(jrpc_result("0x7"))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(receipt_body))
        .expect_at_least(0)
        .create_async()
        .await;
}

fn unique_state_dir() -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!("rmpc-test-{stamp}-{}-{seq}", std::process::id()))
}

#[tokio::test]
async fn deposit_happy_path_emits_payment_id_and_exits_zero() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(123_456u64);
    let shares = U256::from(987_654u64);
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(amount, shares),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            &amount.to_string(),
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--idempotency-key",
            &format!("{IDEMPOTENCY_KEY:#x}"),
            "--receipt-timeout-secs",
            "5",
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    assert_eq!(v["status"], "success");
    assert_eq!(v["payment_id"], format!("{PAYMENT_ID:#x}"));
    assert_eq!(v["order_id"], format!("{ORDER_ID:#x}"));
    assert_eq!(
        v["agent"].as_str().unwrap().to_lowercase(),
        format!("{SIGNER_ADDRESS:#x}")
    );
    assert_eq!(v["amount"], amount.to_string());
    assert_eq!(v["shares_minted"], shares.to_string());
    assert_eq!(v["block_number"], 0x42);
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
    assert!(v["gas_used"].is_string());
    assert!(v["effective_gas_price"].is_string());
}

/// Owner decision 2026-10-06: a depositor may sign with the software keystore
/// on Base mainnet. The guard is gone, the production warning still prints
/// first. With no passphrase the command stops at keystore load (exit 3).
#[test]
fn deposit_base_mainnet_allows_software_signer_and_warns_first() {
    let logs = tempfile::TempDir::new().unwrap();
    let fix = Fixture::build("http://127.0.0.1:1", 8453);

    let out = rmpc()
        .env("RMPC_LOG_DIR", logs.path())
        .env_remove(PASSPHRASE_ENV_VAR)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
        ])
        .assert()
        .failure()
        .get_output()
        .clone();

    assert_eq!(out.status.code(), Some(3));
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(!stdout.contains("ErrProductionSignerRequired"));
    common::assert_mainnet_warning_precedes_keystore_load(logs.path());
}

/// QA plan U7, finding DR-11: a wrong passphrase exited 3 with an empty
/// stderr, because the reason went only to the diagnostic log file. The
/// reason must reach stderr now. Stdout stays empty (a startup failure
/// prints no document), and the passphrase itself is never echoed.
#[test]
fn deposit_wrong_passphrase_prints_reason_on_stderr() {
    let logs = tempfile::TempDir::new().unwrap();
    // The keystore load fails before any RPC call, so no server is needed.
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    let wrong = "not-the-keystore-passphrase";
    assert_ne!(wrong.as_bytes(), TEST_PASSPHRASE);

    let out = rmpc()
        .env("RMPC_LOG_DIR", logs.path())
        .env(PASSPHRASE_ENV_VAR, wrong)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
        ])
        .assert()
        .failure()
        .get_output()
        .clone();

    assert_eq!(out.status.code(), Some(3));
    assert!(
        out.stdout.is_empty(),
        "a startup failure prints nothing on stdout: {:?}",
        String::from_utf8_lossy(&out.stdout)
    );
    let stderr = String::from_utf8(out.stderr).unwrap();
    assert!(
        stderr.contains("ErrKeystoreDecrypt"),
        "stderr must name why the keystore did not open: {stderr:?}"
    );
    assert!(
        !stderr.contains(wrong),
        "the passphrase must never reach stderr: {stderr:?}"
    );
}

#[tokio::test]
async fn deposit_chain_id_mismatch_refuses_with_named_error() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    // Higher-priority mock returning the wrong chain id.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result("0x1"))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1u64), U256::from(1u64)),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
        ])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    assert_eq!(v["status"], "refused");
    assert_eq!(v["error"], "ErrChainIdMismatch");
    assert_eq!(v["checks"]["chain_id_match"], false);
}

#[tokio::test]
async fn deposit_while_deposits_paused_refuses_with_named_error() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::depositsPausedCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1u64), U256::from(1u64)),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
        ])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrDepositsPaused");
    assert_eq!(v["checks"]["deposits_paused"], true);
}

#[tokio::test]
async fn deposit_fee_cap_exceeded_refuses() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    // Higher-priority fee_history with a base fee of 10_000 gwei → way
    // above the 100 gwei cap baked into Fixture's TOML.
    let huge_fee_history = r#"{
        "oldestBlock":"0x1",
        "baseFeePerGas":["0x9184e72a000","0x9184e72a000","0x9184e72a000","0x9184e72a000","0x9184e72a000","0x9184e72a000"],
        "gasUsedRatio":[0.5,0.5,0.5,0.5,0.5],
        "reward":[["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"]]
    }"#;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_feeHistory"})))
        .with_status(200)
        .with_body(jrpc_result_raw(huge_fee_history))
        .create_async()
        .await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1u64), U256::from(1u64)),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
        ])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrFeeCapExceeded");
}

#[tokio::test]
async fn deposit_concurrent_invocation_locked() {
    use rust_payment_client::nonce::AgentLock;
    let chain_id = 31337u64;
    let mut server = mockito::Server::new_async().await;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1u64), U256::from(1u64)),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    // Hold the lock externally to simulate a concurrent in-flight invocation.
    let _held = AgentLock::acquire(&state_dir, &SIGNER_ADDRESS).expect("held");

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
        ])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrConcurrentInvocation");
    drop(_held);
}

#[tokio::test]
async fn deposit_receipt_timeout_refuses() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    // Higher-priority receipt mock returning null forever.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(r#"{"jsonrpc":"2.0","id":1,"result":null}"#)
        .expect_at_least(1)
        .create_async()
        .await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1u64), U256::from(1u64)),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--receipt-timeout-secs",
            "1",
        ])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrRpcTransport");
    assert!(v["tx_hash"].is_string());
}

/// A duplicate retry with the same (chain_id, gateway, agent, order_id,
/// amount, idempotency_key) must be refused locally before signing or
/// broadcasting, even if a different deadline is used on the second call.
///
/// Regression for issue #176: old cache keyed on (order_id,
/// idempotency_key, deadline), so a fresh deadline produced a false
/// negative and the second deposit would broadcast a gas-wasting duplicate.
#[tokio::test]
async fn deposit_duplicate_retry_refused_before_broadcast() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(123_456u64);
    let shares = U256::from(987_654u64);
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(amount, shares),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    // First deposit — succeeds and writes the replay cache entry.
    let out1 = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            &amount.to_string(),
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--idempotency-key",
            &format!("{IDEMPOTENCY_KEY:#x}"),
            "--receipt-timeout-secs",
            "5",
        ])
        .assert()
        .success()
        .get_output()
        .clone();
    let v1: Value = serde_json::from_str(String::from_utf8(out1.stdout).unwrap().trim()).unwrap();
    assert_eq!(v1["status"], "success");
    let prior_tx = v1["tx_hash"].as_str().unwrap().to_string();

    // Second invocation — same paymentId inputs but deadline will differ
    // (the binary computes `now + deadline_secs` internally; since time
    // has advanced even by one second the raw deadline value changes, but
    // the cache key must still hit).  The binary should refuse locally
    // before reaching eth_sendRawTransaction.
    let out2 = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            &amount.to_string(),
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--idempotency-key",
            &format!("{IDEMPOTENCY_KEY:#x}"),
            "--receipt-timeout-secs",
            "5",
        ])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out2.status.code(), Some(2));
    let v2: Value = serde_json::from_str(String::from_utf8(out2.stdout).unwrap().trim()).unwrap();
    assert_eq!(v2["status"], "refused");
    assert_eq!(v2["error"], "ErrOrderIdAlreadySubmitted");
    // The refusal must surface the tx_hash from the first deposit.
    assert_eq!(v2["tx_hash"].as_str().unwrap(), prior_tx.as_str());
}

/// After a successful deposit the replay cache must contain an entry so
/// subsequent calls (including non-duplicate ones) don't wipe state.
/// This regression check ensures the non-duplicate path still writes
/// a replay entry after broadcast / receipt handling.
#[tokio::test]
async fn deposit_non_duplicate_still_writes_replay_entry() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(5_000u64);
    let shares = U256::from(4_000u64);
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(amount, shares),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    // Single successful deposit.
    rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            &amount.to_string(),
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--idempotency-key",
            &format!("{IDEMPOTENCY_KEY:#x}"),
            "--receipt-timeout-secs",
            "5",
        ])
        .assert()
        .success();

    // Verify the replay cache file was written.
    let cache_file = state_dir.join("submitted_order_ids.json");
    assert!(
        cache_file.exists(),
        "replay cache file should exist after a successful deposit"
    );
    let raw = std::fs::read_to_string(&cache_file).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn deposit_reverted_tx_emits_err_tx_reverted() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(&mut server, &reverted_receipt_body()).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--receipt-timeout-secs",
            "5",
        ])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrTxReverted");
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
}

// ── Gateway implementation binding (issue 1810) ─────────────────────────
//
// The fixture gateway is an ERC-1967 proxy. Its runtime code — and so the
// pinned `gateway_runtime_hash` — never changes in these tests; only what the
// implementation slot names does. The approved implementation is IMPL_A.

const IMPL_A: Address = address!("00000000000000000000000000000000000a11ce");
const IMPL_B: Address = address!("00000000000000000000000000000000000b0b00");
const IMPL_A_CODE: &[u8] = &[0x60, 0x01, 0x60, 0x02, 0xaa];
const IMPL_B_CODE: &[u8] = &[0x60, 0x01, 0x60, 0x02, 0xbb];
/// The receipt bodies above mine the transaction in block 0x42.
const RECEIPT_BLOCK_TAG: &str = "0x42";

/// Run `rmpc deposit` against `fix` and return (exit code, stdout JSON).
fn run_deposit(fix: &Fixture) -> (Option<i32>, Value) {
    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", unique_state_dir())
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--receipt-timeout-secs",
            "5",
        ])
        .output()
        .expect("rmpc ran");
    eprintln!("STDERR: {}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim())
        .expect("stdout is JSON");
    (out.status.code(), v)
}

/// `eth_sendRawTransaction` that must never be called.
async fn forbid_broadcast(server: &mut mockito::ServerGuard) -> mockito::Mock {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await
}

/// The gateway-code mock, asserted hit: the proxy hash pin ran and passed.
async fn proxy_code_read(server: &mut mockito::ServerGuard) -> mockito::Mock {
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getCode"})),
            Matcher::Regex(format!(r#""params":\["{GATEWAY:#x}""#)),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(GATEWAY_CODE))))
        .expect_at_least(1)
        .create_async()
        .await
}

#[tokio::test]
async fn deposit_signs_and_succeeds_under_the_approved_implementation() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    install_gateway_implementation(&mut server, IMPL_A, IMPL_A_CODE, None).await;

    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL_A, IMPL_A_CODE);
    let (code, v) = run_deposit(&fix);
    assert_eq!(code, Some(0), "{v}");
    assert_eq!(v["status"], "success");
}

/// The proxy hash is unchanged and passes; the slot names IMPL_B. The write
/// refuses before anything is signed or sent.
#[tokio::test]
async fn deposit_refuses_a_swapped_implementation_while_the_proxy_hash_is_unchanged() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let proxy_code = proxy_code_read(&mut server).await;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    install_gateway_implementation(&mut server, IMPL_B, IMPL_B_CODE, None).await;
    let send = forbid_broadcast(&mut server).await;

    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL_A, IMPL_A_CODE);
    let (code, v) = run_deposit(&fix);
    assert_eq!(code, Some(2), "{v}");
    assert_eq!(v["error"], "ErrImplementationNotApproved");
    assert_eq!(v["checks"]["gateway_code_hash_match"], true);
    assert_eq!(v["checks"]["gateway_implementation_match"], false);
    proxy_code.assert_async().await;
    send.assert_async().await;
}

/// The implementation slot cannot be read: refuse, never sign.
#[tokio::test]
async fn deposit_refuses_when_the_implementation_read_fails() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getStorageAt"})))
        .with_status(200)
        .with_body(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"missing trie node"}}"#,
        )
        .expect_at_least(1)
        .create_async()
        .await;
    let send = forbid_broadcast(&mut server).await;

    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL_A, IMPL_A_CODE);
    let (code, v) = run_deposit(&fix);
    assert_eq!(code, Some(2), "{v}");
    assert_eq!(v["error"], "ErrImplementationUnverified");
    send.assert_async().await;
}

/// The preflight block (FIXTURE_BLOCK_TAG) shows IMPL_A; by `latest`, after
/// signing, the slot names IMPL_B. The signed envelope is discarded unsent.
#[tokio::test]
async fn deposit_discards_the_signed_transaction_when_the_implementation_changes_before_broadcast()
{
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    install_gateway_implementation(&mut server, IMPL_A, IMPL_A_CODE, Some(FIXTURE_BLOCK_TAG)).await;
    install_gateway_implementation(&mut server, IMPL_B, IMPL_B_CODE, Some("latest")).await;
    let send = forbid_broadcast(&mut server).await;

    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL_A, IMPL_A_CODE);
    let (code, v) = run_deposit(&fix);
    assert_eq!(code, Some(2), "{v}");
    assert_eq!(v["error"], "ErrImplementationChanged");
    assert!(
        v["message"].as_str().unwrap().contains("discarded unsent"),
        "{v}"
    );
    send.assert_async().await;
}

/// Verified and broadcast under IMPL_A, but the block the transaction
/// executed in (0x42) shows IMPL_B. The write is not reported as a success.
#[tokio::test]
async fn deposit_is_not_a_success_when_it_executed_under_another_implementation() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    install_gateway_implementation(&mut server, IMPL_A, IMPL_A_CODE, None).await;
    install_gateway_implementation(&mut server, IMPL_B, IMPL_B_CODE, Some(RECEIPT_BLOCK_TAG)).await;

    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL_A, IMPL_A_CODE);
    let (code, v) = run_deposit(&fix);
    assert_eq!(code, Some(2), "{v}");
    assert_eq!(v["error"], "ErrImplementationChanged");
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
}

/// The receipt comes back, then the first read of its block hits a node that
/// has not reached it ("block not found", Deploy 3 P6.55). The read is
/// retried and the write is a success, not a refusal of a mined deposit.
#[tokio::test]
async fn deposit_retries_the_executed_block_read_when_the_node_is_behind() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    let behind = server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getStorageAt"})),
            common::at_block(RECEIPT_BLOCK_TAG),
        ]))
        .with_status(200)
        .with_body(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"block not found: 0x42"}}"#,
        )
        .expect(1)
        .create_async()
        .await;
    install_gateway_implementation(&mut server, IMPL_A, IMPL_A_CODE, None).await;

    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL_A, IMPL_A_CODE);
    let (code, v) = run_deposit(&fix);
    assert_eq!(code, Some(0), "{v}");
    assert_eq!(v["status"], "success");
    behind.assert_async().await;
}

// ── Requested vault (issue 1889) ────────────────────────────────────────
//
// The gateway pins no vault. `rmpc deposit --vault B` deposits into B through
// `gateway.depositTo`, with the config's `vault_address` (A) only the default.
// The preflight reads B's state, never `gateway.vault()`, and a vault the owner
// did not select, a paused B, or a B whose implementation changed before
// broadcast reaches no broadcast.

const VAULT_B: Address = address!("0000000000000000000000000000000000000d0b");
const VAULT_B_IMPL: Address = address!("000000000000000000000000000b1b1b1b1b1b1b");
const VAULT_B_IMPL_CODE: &[u8] = &[0x60, 0x0b, 0x60, 0x01, 0xfe];
const VAULT_B_OTHER_IMPL: Address = address!("000000000000000000000000000b2b2b2b2b2b2b");
const VAULT_B_OTHER_IMPL_CODE: &[u8] = &[0x60, 0x0b, 0x60, 0x02, 0xfe];

fn two_vault_extra() -> String {
    format!(
        "allowed_destinations = [\"{:#x}\", \"{VAULT_B:#x}\"]\n",
        common::VAULT
    )
}

/// `rmpc deposit --vault <vault>` against `fix`; returns (exit code, stdout JSON).
fn run_deposit_vault(fix: &Fixture, vault: Address) -> (Option<i32>, Value) {
    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", unique_state_dir())
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--vault",
            &format!("{vault:#x}"),
            "--receipt-timeout-secs",
            "5",
        ])
        .output()
        .expect("rmpc ran");
    eprintln!("STDERR: {}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim())
        .expect("stdout is JSON");
    (out.status.code(), v)
}

/// An `eth_call` to `to` whose calldata starts with `selector`.
fn eth_call_to(selector: &str, to: Address) -> Matcher {
    Matcher::AllOf(vec![
        Matcher::PartialJson(json!({"method": "eth_call"})),
        Matcher::Regex(format!(r#""data":"{selector}"#)),
        Matcher::Regex(format!(r#"(?i)"to":"{to:#x}""#)),
    ])
}

/// Make `proxy` an ERC-1967 proxy over `implementation` (code `code`) for reads
/// tagged `tag` (every read when `None`).
async fn install_vault_proxy(
    server: &mut mockito::ServerGuard,
    proxy: Address,
    implementation: Address,
    code: &[u8],
    tag: Option<&str>,
) {
    let mut slot_word = [0u8; 32];
    slot_word[12..].copy_from_slice(implementation.as_slice());
    let mut slot = vec![
        Matcher::PartialJson(json!({"method": "eth_getStorageAt"})),
        Matcher::Regex(format!(r#""params":\["{proxy:#x}""#)),
    ];
    if let Some(tag) = tag {
        slot.push(common::at_block(tag));
    }
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(slot))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(slot_word))))
        .expect_at_least(1)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getCode"})),
            Matcher::Regex(format!(r#""params":\["{implementation:#x}""#)),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(code))))
        .expect_at_least(1)
        .create_async()
        .await;
}

#[tokio::test]
async fn deposit_into_requested_vault_b_calls_depositto_with_b_and_reads_b() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(1000u64);
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(amount, amount),
    )
    .await;
    // B's pause flag is read. A's is never read.
    let paused = selector_hex_of::<RobotMoneyGateway::depositsPausedCall>();
    let b_read = server
        .mock("POST", "/")
        .match_body(eth_call_to(&paused, VAULT_B))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(false)))
        .expect_at_least(1)
        .create_async()
        .await;
    let a_read = server
        .mock("POST", "/")
        .match_body(eth_call_to(&paused, common::VAULT))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(false)))
        .expect(0)
        .create_async()
        .await;
    // The pre-sign simulation carries `depositTo(.., B, [])`.
    let deposit_to = format!(
        "0x{}",
        ahex::encode(RobotMoneyGateway::depositToCall::SELECTOR)
    );
    let b_word = common::abi_addr_hex(VAULT_B);
    let sim = server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_call"})),
            Matcher::Regex(format!(r#""data":"{deposit_to}[0-9a-f]*{b_word}"#)),
        ]))
        .with_status(200)
        .with_body(jrpc_result("0x"))
        .expect_at_least(1)
        .create_async()
        .await;
    // `gateway.vault()` no longer exists and must never be called.
    let vault_selector = format!(
        "0x{}",
        ahex::encode(&alloy_primitives::keccak256(b"vault()")[..4])
    );
    let vault_call = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&vault_selector))
        .with_status(200)
        .with_body(jrpc_result("0x"))
        .expect(0)
        .create_async()
        .await;

    let fix = Fixture::build_with(&server.url(), chain_id, &two_vault_extra());
    let (code, v) = run_deposit_vault(&fix, VAULT_B);
    assert_eq!(code, Some(0), "{v}");
    assert_eq!(v["status"], "success");
    assert_eq!(v["vault"], format!("{VAULT_B:#x}"));
    b_read.assert_async().await;
    a_read.assert_async().await;
    sim.assert_async().await;
    vault_call.assert_async().await;
}

#[tokio::test]
async fn deposit_into_paused_vault_b_refuses_with_no_broadcast() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    // A is fine (happy path); only B is paused.
    server
        .mock("POST", "/")
        .match_body(eth_call_to(
            &selector_hex_of::<RobotMoneyGateway::depositsPausedCall>(),
            VAULT_B,
        ))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .expect_at_least(1)
        .create_async()
        .await;
    let send = forbid_broadcast(&mut server).await;

    let fix = Fixture::build_with(&server.url(), chain_id, &two_vault_extra());
    let (code, v) = run_deposit_vault(&fix, VAULT_B);
    assert_eq!(code, Some(2), "{v}");
    assert_eq!(v["error"], "ErrDepositsPaused");
    send.assert_async().await;
}

#[tokio::test]
async fn deposit_into_an_unselected_vault_refuses_with_no_broadcast() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    let send = forbid_broadcast(&mut server).await;

    // No allowed_destinations: only A (`vault_address`) is selected.
    let fix = Fixture::build(&server.url(), chain_id);
    let (code, v) = run_deposit_vault(&fix, VAULT_B);
    assert_eq!(code, Some(2), "{v}");
    assert_eq!(v["error"], "ErrDestinationNotSelected");
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .contains(&format!("{VAULT_B:#x}")),
        "{v}"
    );
    send.assert_async().await;
}

#[tokio::test]
async fn deposit_discards_the_signed_transaction_when_vault_b_implementation_changes() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    // B is a proxy over VAULT_B_IMPL at the preflight block and over another
    // implementation at `latest`, after signing. Both are approved, so only
    // the binding to the implementation verified before signing catches it.
    install_vault_proxy(
        &mut server,
        VAULT_B,
        VAULT_B_IMPL,
        VAULT_B_IMPL_CODE,
        Some(FIXTURE_BLOCK_TAG),
    )
    .await;
    install_vault_proxy(
        &mut server,
        VAULT_B,
        VAULT_B_OTHER_IMPL,
        VAULT_B_OTHER_IMPL_CODE,
        Some("latest"),
    )
    .await;
    let send = forbid_broadcast(&mut server).await;

    let extra = format!(
        "{}proxy_implementation_hashes = [\"0x{}\", \"0x{}\"]\n",
        two_vault_extra(),
        ahex::encode(alloy_primitives::keccak256(VAULT_B_IMPL_CODE)),
        ahex::encode(alloy_primitives::keccak256(VAULT_B_OTHER_IMPL_CODE)),
    );
    let fix = Fixture::build_with(&server.url(), chain_id, &extra);
    let (code, v) = run_deposit_vault(&fix, VAULT_B);
    assert_eq!(code, Some(2), "{v}");
    assert_eq!(v["error"], "ErrImplementationChanged");
    assert!(
        v["message"].as_str().unwrap().contains("discarded unsent"),
        "{v}"
    );
    send.assert_async().await;
}

#[tokio::test]
async fn deposit_refuses_a_proxied_vault_b_whose_implementation_is_not_approved() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(U256::from(1000u64), U256::from(1000u64)),
    )
    .await;
    install_vault_proxy(&mut server, VAULT_B, VAULT_B_IMPL, VAULT_B_IMPL_CODE, None).await;
    let send = forbid_broadcast(&mut server).await;

    // proxy_implementation_hashes is unset: B's implementation is unverified.
    let fix = Fixture::build_with(&server.url(), chain_id, &two_vault_extra());
    let (code, v) = run_deposit_vault(&fix, VAULT_B);
    assert_eq!(code, Some(2), "{v}");
    assert_eq!(v["error"], "ErrImplementationNotApproved");
    send.assert_async().await;
}
