//! Canonical: docs/implementation-plan.md §9 — `rmpc get-tx`
//!
//! Integration tests for `rmpc get-tx` (issue #50).

mod common;

use crate::common::{jrpc_result, jrpc_result_raw, Fixture};
use assert_cmd::Command;
use mockito::Matcher;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// Build a JSON-RPC `eth_getTransactionReceipt` result body for a
/// successful EIP-1559 transaction with no logs. Field set is the
/// minimum that `alloy_rpc_types::TransactionReceipt` deserialises.
fn receipt_json(
    tx_hash: &str,
    status_one: bool,
    block_no: u64,
    from: &str,
    to: Option<&str>,
    gas_used: u128,
    eff_gas_price: u128,
) -> String {
    let to_field = match to {
        Some(t) => format!(r#""to":"{t}""#),
        None => r#""to":null"#.to_string(),
    };
    format!(
        r#"{{"transactionHash":"{tx_hash}","transactionIndex":"0x0","blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001","blockNumber":"0x{block_no:x}","cumulativeGasUsed":"0x{gas:x}","gasUsed":"0x{gas:x}","effectiveGasPrice":"0x{egp:x}","from":"{from}",{to_field},"contractAddress":null,"logs":[],"logsBloom":"0x{bloom}","status":"{status}","type":"0x2"}}"#,
        gas = gas_used,
        egp = eff_gas_price,
        bloom = "00".repeat(256),
        status = if status_one { "0x1" } else { "0x0" },
    )
}

#[tokio::test]
async fn get_tx_clean_envelope_for_successful_receipt() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0xabcu64;
    let receipt_block = 0xab0u64;
    let tx_hash = "0x1111111111111111111111111111111111111111111111111111111111111111";
    let from = "0x00000000000000000000000000000000000000aa";
    let to = "0x00000000000000000000000000000000000000bb";
    let gas_used: u128 = 21_000;
    let egp: u128 = 1_500_000_000;

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
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(&receipt_json(
            tx_hash,
            true,
            receipt_block,
            from,
            Some(to),
            gas_used,
            egp,
        )))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            tx_hash,
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
    assert_eq!(d["tx_hash"], tx_hash);
    assert_eq!(d["status"], "success");
    assert_eq!(d["block_number"], receipt_block);
    assert_eq!(d["from"].as_str().unwrap().to_lowercase(), from);
    assert_eq!(d["to"].as_str().unwrap().to_lowercase(), to);
    // Decimal-string contract.
    assert!(d["gas_used"].is_string());
    assert!(d["effective_gas_price"].is_string());
    assert_eq!(d["gas_used"], gas_used.to_string());
    assert_eq!(d["effective_gas_price"], egp.to_string());
}

#[tokio::test]
async fn get_tx_unknown_hash_returns_exit_4() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x10u64;
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
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw("null"))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ])
        .assert()
        .failure()
        .code(4);
}

#[test]
fn get_tx_rejects_malformed_hash() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            "0xnothex",
        ])
        .assert()
        .failure()
        .code(2);
}
