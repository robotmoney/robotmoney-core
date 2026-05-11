//! Canonical: docs/implementation-plan.md §9 — `rmpc get-balance`
//!
//! Integration tests for `rmpc get-balance` (issue #50).

mod common;

use crate::common::{
    enc_u256, jrpc_result, match_eth_call_selector, selector_hex_of, Fixture, USDC,
};
use alloy_primitives::U256;
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::Erc20;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

#[tokio::test]
async fn get_balance_clean_envelope_with_decimal_string() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x77u64;
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
        .match_body(match_eth_call_selector(&selector_hex_of::<
            Erc20::balanceOfCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(123_456_789u64))))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let target = "0x00000000000000000000000000000000000000aa";
    let out = rmpc()
        .args([
            "get-balance",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--address",
            target,
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
    assert_eq!(d["address"].as_str().unwrap().to_lowercase(), target);
    assert_eq!(
        d["token"].as_str().unwrap().to_lowercase(),
        format!("{USDC:#x}")
    );
    // §9 contract: large integers must serialize as decimal strings.
    assert!(d["balance"].is_string());
    assert_eq!(d["balance"], "123456789");
}

#[test]
fn get_balance_rejects_malformed_address() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-balance",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--address",
            "not-an-address",
        ])
        .assert()
        .failure()
        .code(2);
}
