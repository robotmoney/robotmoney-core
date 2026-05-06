//! Integration tests for `rmpc status --payment-id` (issue #15).
//!
//! Each test wires a `mockito` JSON-RPC server that answers a single
//! `eth_getLogs` request with a synthetic `AgentDeposit` log, builds a
//! temp config + keystore via [`common::Fixture`], and invokes the binary
//! via `assert_cmd`.

mod common;

use crate::common::{jrpc_result_raw, Fixture, GATEWAY, SHARE_RECEIVER, SIGNER_ADDRESS};
use alloy_primitives::{address, b256, hex as ahex, Address, Bytes, LogData, B256, U256};
use alloy_sol_types::SolEvent;
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

const PAYMENT_ID: B256 = b256!("1111111111111111111111111111111111111111111111111111111111111111");
const ORDER_ID: B256 = b256!("2222222222222222222222222222222222222222222222222222222222222222");
const TX_HASH: B256 = b256!("3333333333333333333333333333333333333333333333333333333333333333");
const AGENT: Address = SIGNER_ADDRESS;

/// Build the RPC `result` array for a found `AgentDeposit` log.
fn synthesize_agent_deposit_log() -> String {
    let ev = RobotMoneyGateway::AgentDeposit {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        agent: AGENT,
        shareReceiver: SHARE_RECEIVER,
        amount: U256::from(123_456u64),
        sharesMinted: U256::from(987_654u64),
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
        r#"[{{
            "address": "{GATEWAY:#x}",
            "topics": [{}],
            "data": "{data_hex}",
            "blockNumber": "0x10",
            "transactionHash": "{TX_HASH:#x}",
            "blockHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
            "transactionIndex": "0x0",
            "logIndex": "0x0",
            "removed": false
        }}]"#,
        topics_hex.join(",")
    )
}

#[tokio::test]
async fn status_found_emits_decoded_payment_record() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&synthesize_agent_deposit_log()))
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let pid_hex = format!("{PAYMENT_ID:#x}");
    let out = rmpc()
        .args([
            "status",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--payment-id",
            &pid_hex,
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    assert_eq!(v["payment_id"], pid_hex);
    assert_eq!(v["order_id"], format!("{ORDER_ID:#x}"));
    assert_eq!(
        v["agent"].as_str().unwrap().to_lowercase(),
        format!("{AGENT:#x}")
    );
    assert_eq!(
        v["share_receiver"].as_str().unwrap().to_lowercase(),
        format!(
            "{:#x}",
            address!("00000000000000000000000000000000000000ee")
        )
    );
    assert_eq!(v["amount"], "123456");
    assert_eq!(v["shares_minted"], "987654");
    assert_eq!(v["block_number"], 16); // 0x10
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
    assert!(v.get("status").is_none());
}

#[tokio::test]
async fn status_not_found_emits_status_object() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw("[]"))
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let pid_hex = format!("{PAYMENT_ID:#x}");
    let out = rmpc()
        .args([
            "status",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--payment-id",
            &pid_hex,
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(v["payment_id"], pid_hex);
    assert_eq!(v["status"], "not_found");
    assert!(v.get("amount").is_none());
}

#[tokio::test]
async fn status_pretty_flag_emits_multiline_json() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw("[]"))
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let pid_hex = format!("{PAYMENT_ID:#x}");
    let out = rmpc()
        .args([
            "status",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--payment-id",
            &pid_hex,
            "--pretty",
        ])
        .assert()
        .success()
        .get_output()
        .clone();
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.lines().count() >= 3,
        "pretty json must be multi-line"
    );
}

#[test]
fn status_rejects_malformed_payment_id() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "status",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--payment-id",
            "not-hex",
        ])
        .assert()
        .failure();
}
