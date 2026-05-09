//! Canonical: docs/implementation-plan.md §4.8 / §9 — CLI integration tests for `rmpc status`
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! Integration tests for `rmpc status --payment-id` (issue #149).
//!
//! Each test wires a `mockito` JSON-RPC server that answers three calls:
//!   1. `eth_chainId` — envelope header.
//!   2. `eth_blockNumber` — envelope header.
//!   3. `eth_getLogs` filtered on the gateway address + `AgentDeposit` topic0.
//!
//! Asserts that stdout follows the Phase 3 shared envelope with `chain_id`,
//! `block_number`, `source: "json_rpc"`, `partial`, `errors`, and `data`.

mod common;

use crate::common::{
    jrpc_result, jrpc_result_raw, Fixture, GATEWAY, SHARE_RECEIVER, SIGNER_ADDRESS,
};
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

/// Install the three mocks required by the new envelope-aware `rmpc status`.
async fn install_status_mocks(
    server: &mut mockito::ServerGuard,
    chain_id: u64,
    block_number: u64,
    logs_body: &str,
) {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{chain_id:x}")))
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{block_number:x}")))
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw(logs_body))
        .create_async()
        .await;
}

#[tokio::test]
async fn status_found_emits_envelope_with_decoded_payment_record() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_number = 9999u64;
    install_status_mocks(
        &mut server,
        chain_id,
        block_number,
        &synthesize_agent_deposit_log(),
    )
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

    // Phase 3 envelope top-level fields.
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(v["block_number"], block_number);
    assert_eq!(v["source"], "json_rpc");
    assert_eq!(v["partial"], false);
    assert!(v["errors"].as_array().unwrap().is_empty());

    // Deposit fields inside `data`.
    let data = &v["data"];
    assert_eq!(data["payment_id"], pid_hex);
    assert_eq!(data["order_id"], format!("{ORDER_ID:#x}"));
    assert_eq!(
        data["agent"].as_str().unwrap().to_lowercase(),
        format!("{AGENT:#x}")
    );
    assert_eq!(
        data["share_receiver"].as_str().unwrap().to_lowercase(),
        format!(
            "{:#x}",
            address!("00000000000000000000000000000000000000ee")
        )
    );
    // Large integers must be decimal strings, never JSON numbers.
    assert_eq!(data["amount"], "123456");
    assert_eq!(data["shares_minted"], "987654");
    assert_eq!(data["block_number"], 16u64); // 0x10
    assert_eq!(data["tx_hash"], format!("{TX_HASH:#x}"));
    assert!(
        data.get("status").is_none(),
        "found record must not have a 'status' field"
    );
}

#[tokio::test]
async fn status_not_found_emits_envelope_with_not_found_data() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_number = 8888u64;
    install_status_mocks(&mut server, chain_id, block_number, "[]").await;

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

    // Phase 3 envelope top-level fields present even for not-found.
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(v["block_number"], block_number);
    assert_eq!(v["source"], "json_rpc");
    assert_eq!(v["partial"], false);
    assert!(v["errors"].as_array().unwrap().is_empty());

    // Not-found data fields.
    let data = &v["data"];
    assert_eq!(data["payment_id"], pid_hex);
    assert_eq!(data["status"], "not_found");
    assert!(
        data.get("amount").is_none(),
        "not-found must not have 'amount'"
    );
}

#[tokio::test]
async fn status_pretty_flag_emits_multiline_json() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_status_mocks(&mut server, chain_id, 1, "[]").await;

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
