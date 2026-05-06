//! Canonical: docs/implementation-plan.md §9 — `rmpc get-deposit`
//!
//! Integration tests for `rmpc get-deposit` (issue #50).

mod common;

use crate::common::{jrpc_result, jrpc_result_raw, Fixture, GATEWAY};
use alloy_primitives::{address, b256, hex as ahex, Address, B256, U256};
use alloy_sol_types::SolEvent;
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

#[allow(clippy::too_many_arguments)]
fn agent_deposit_log_json(
    payment_id: B256,
    order_id: B256,
    agent: Address,
    share_receiver: Address,
    amount: U256,
    shares: U256,
    window_id: u64,
    block_no: u64,
    tx_hash: B256,
) -> String {
    let ev = RobotMoneyGateway::AgentDeposit {
        paymentId: payment_id,
        orderId: order_id,
        agent,
        shareReceiver: share_receiver,
        amount,
        sharesMinted: shares,
        windowId: window_id,
    };
    let topics = ev.encode_topics();
    let topic_strs: Vec<String> = topics
        .iter()
        .map(|t| format!("{:#x}", B256::from(t.0)))
        .collect();
    let data = ev.encode_data();
    let data_hex = format!("0x{}", ahex::encode(data));
    format!(
        r#"[{{"address":"{addr:#x}","topics":[{topics}],"data":"{data}","blockNumber":"0x{block:x}","transactionHash":"{tx:#x}","logIndex":"0x0","blockHash":"{tx:#x}","transactionIndex":"0x0","removed":false}}]"#,
        addr = GATEWAY,
        topics = topic_strs
            .iter()
            .map(|s| format!("\"{s}\""))
            .collect::<Vec<_>>()
            .join(","),
        data = data_hex,
        block = block_no,
        tx = tx_hash,
    )
}

#[tokio::test]
async fn get_deposit_clean_envelope_for_known_id() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x123u64;
    let log_block_no = 0x110u64;
    let payment_id = b256!("1111111111111111111111111111111111111111111111111111111111111111");
    let order_id = b256!("2222222222222222222222222222222222222222222222222222222222222222");
    let tx_hash = b256!("3333333333333333333333333333333333333333333333333333333333333333");
    let agent: Address = address!("00000000000000000000000000000000000000aa");
    let share_receiver: Address = address!("00000000000000000000000000000000000000bb");
    let amount = U256::from(50_000_000u64);
    let shares = U256::from(49_900_000u64);
    let window_id = 19_676u64;

    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{chain_id:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{block_no:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&agent_deposit_log_json(
            payment_id,
            order_id,
            agent,
            share_receiver,
            amount,
            shares,
            window_id,
            log_block_no,
            tx_hash,
        )))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args([
            "get-deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--deposit-id",
            &format!("{payment_id:#x}"),
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(v["block_number"], block_no);
    assert_eq!(v["source"], "json_rpc");
    assert_eq!(v["partial"], false);
    assert!(v["errors"].as_array().unwrap().is_empty());

    let d = &v["data"];
    assert_eq!(d["deposit_id"], format!("{payment_id:#x}"));
    assert_eq!(d["order_id"], format!("{order_id:#x}"));
    assert_eq!(d["agent"], format!("{agent:#x}"));
    assert_eq!(d["share_receiver"], format!("{share_receiver:#x}"));
    // Decimal-string contract.
    assert!(d["amount"].is_string());
    assert!(d["shares_minted"].is_string());
    assert_eq!(d["amount"], amount.to_string());
    assert_eq!(d["shares_minted"], shares.to_string());
    assert_eq!(d["window_id"], window_id);
    assert_eq!(d["log_block_number"], log_block_no);
    assert_eq!(d["tx_hash"], format!("{tx_hash:#x}"));
}

#[tokio::test]
async fn get_deposit_unknown_id_returns_exit_4() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x55u64;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{chain_id:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{block_no:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    // Empty log set ⇒ deposit not found ⇒ exit 4.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw("[]"))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    rmpc()
        .args([
            "get-deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--deposit-id",
            "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ])
        .assert()
        .failure()
        .code(4);
}

#[test]
fn get_deposit_rejects_malformed_id() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--deposit-id",
            "0xnothex",
        ])
        .assert()
        .failure()
        .code(2);
}
