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
    enc_bool, install_happy_path_mocks, jrpc_result, jrpc_result_raw, match_eth_call_selector,
    selector_hex_of, Fixture, GATEWAY, SHARE_RECEIVER, SIGNER_ADDRESS, TEST_PASSPHRASE,
};
use alloy_primitives::{b256, hex as ahex, Bytes, LogData, B256, U256};
use alloy_sol_types::SolEvent;
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
    std::env::temp_dir().join(format!("rmpc-test-{stamp}-{}", std::process::id()))
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
async fn deposit_paused_gateway_refuses_with_named_error() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::pausedCall,
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
    assert_eq!(v["error"], "ErrGatewayPaused");
    assert_eq!(v["checks"]["gateway_paused"], true);
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
