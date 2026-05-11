//! Canonical: docs/implementation-plan.md §9 — `rmpc get-allowance`
//!
//! Integration tests for `rmpc get-allowance` (issue #50).

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
async fn get_allowance_clean_envelope_with_max_u256() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x42u64;
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
            Erc20::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::MAX)))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let owner = "0x00000000000000000000000000000000000000aa";
    let spender = "0x00000000000000000000000000000000000000bb";
    let out = rmpc()
        .args([
            "get-allowance",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--owner",
            owner,
            "--spender",
            spender,
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
    assert_eq!(d["owner"].as_str().unwrap().to_lowercase(), owner);
    assert_eq!(d["spender"].as_str().unwrap().to_lowercase(), spender);
    assert_eq!(
        d["token"].as_str().unwrap().to_lowercase(),
        format!("{USDC:#x}")
    );
    // §9 contract: large integers must serialize as decimal strings.
    assert!(d["allowance"].is_string());
    assert_eq!(d["allowance"], U256::MAX.to_string());
}

#[test]
fn get_allowance_rejects_malformed_owner() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-allowance",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--owner",
            "garbage",
            "--spender",
            "0x00000000000000000000000000000000000000bb",
        ])
        .assert()
        .failure()
        .code(2);
}

#[test]
fn get_allowance_rejects_malformed_spender() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-allowance",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--owner",
            "0x00000000000000000000000000000000000000aa",
            "--spender",
            "nope",
        ])
        .assert()
        .failure()
        .code(2);
}
