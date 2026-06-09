//! Canonical: none — integration tests for `rmpc deposit --destination`
//!
//! Integration tests for the router-deposit path added in issue #649.
//!
//! The happy-path test wires a mockito server with the full preflight
//! response set + fee / nonce / broadcast / receipt mocks (carrying a
//! synthetic `AgentDeposit` log), invokes the binary with
//! `--destination <router>` and `--min-shares-per-leg 0`, and asserts
//! exit code 0 plus a non-zero `payment_id` in stdout.

mod common;

use crate::common::{
    install_happy_path_mocks, jrpc_result, jrpc_result_raw, Fixture, GATEWAY, SHARE_RECEIVER,
    SIGNER_ADDRESS, TEST_PASSPHRASE,
};
use alloy_primitives::{address, b256, hex as ahex, Address, Bytes, LogData, B256, U256};
use alloy_sol_types::SolEvent;
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// A PortfolioRouter address used as the `--destination` in tests.
const ROUTER: Address = address!("0000000000000000000000000000000000000e00");

const ORDER_ID: B256 = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const PAYMENT_ID: B256 = b256!("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
const TX_HASH: B256 = b256!("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");

fn fee_history_body() -> String {
    r#"{
        "oldestBlock":"0x1",
        "baseFeePerGas":["0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00"],
        "gasUsedRatio":[0.5,0.5,0.5,0.5,0.5],
        "reward":[["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"]]
    }"#
    .to_string()
}

/// Build a receipt body carrying an `AgentDeposit` event log, identical in
/// structure to the one used in the single-vault deposit tests.
fn receipt_with_agent_deposit_body(amount: U256, shares: U256) -> String {
    let ev = RobotMoneyGateway::AgentDeposit {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        agent: SIGNER_ADDRESS,
        shareReceiver: SHARE_RECEIVER,
        amount,
        sharesMinted: shares,
        windowId: 1u64,
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
            "blockNumber":"0x10",
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
                "blockNumber":"0x10",
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
        .with_body(jrpc_result("0x1"))
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
    std::env::temp_dir().join(format!("rmpc-router-test-{stamp}-{}", std::process::id()))
}

/// Happy path: `rmpc deposit --destination <router> --min-shares-per-leg 0`
/// exits 0 and emits a non-empty `payment_id` in stdout JSON.
#[tokio::test]
async fn deposit_router_happy_path_exits_zero_with_payment_id() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(1_000_000u64);
    let shares = U256::from(990_000u64);

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
            "--destination",
            &format!("{ROUTER:#x}"),
            "--min-shares-per-leg",
            "0",
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
    // payment_id must be present and non-empty
    let pid = v["payment_id"].as_str().expect("payment_id is string");
    assert!(!pid.is_empty(), "payment_id must be non-empty");
    assert_eq!(pid, format!("{PAYMENT_ID:#x}"));
    assert_eq!(v["order_id"], format!("{ORDER_ID:#x}"));
    assert_eq!(
        v["agent"].as_str().unwrap().to_lowercase(),
        format!("{SIGNER_ADDRESS:#x}")
    );
    assert_eq!(v["amount"], amount.to_string());
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
}

/// When `--destination` is omitted the existing single-vault path is used
/// and the binary still exits 0 with a valid `payment_id`. This asserts
/// that the router-deposit branch does not regress the default path.
#[tokio::test]
async fn deposit_without_destination_still_uses_single_vault_path() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(500_000u64);
    let shares = U256::from(495_000u64);

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
    let pid = v["payment_id"].as_str().expect("payment_id is string");
    assert!(!pid.is_empty(), "payment_id must be non-empty");
}

/// An invalid `--destination` address must cause exit code 3 (startup fail),
/// not a panic or silent wrong address.
#[test]
fn deposit_router_bad_destination_exits_startup_fail() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--destination",
            "not-an-address",
        ])
        .assert()
        .failure()
        .get_output()
        .clone();

    // Exit 3 = startup fail (bad flag value).
    assert_eq!(out.status.code(), Some(3));
}

/// An invalid `--min-shares-per-leg` value must cause exit code 3 (startup
/// fail), not a panic.
#[test]
fn deposit_router_bad_min_shares_exits_startup_fail() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--destination",
            &format!("{ROUTER:#x}"),
            "--min-shares-per-leg",
            "not-a-number",
        ])
        .assert()
        .failure()
        .get_output()
        .clone();

    // Exit 3 = startup fail (bad flag value).
    assert_eq!(out.status.code(), Some(3));
}
