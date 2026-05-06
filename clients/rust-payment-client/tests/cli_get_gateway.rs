//! Canonical: docs/implementation-plan.md §9 — `rmpc get-gateway`
//!
//! Integration tests for `rmpc get-gateway` (issue #49). Drives the
//! command against a `mockito` JSON-RPC server with canned responses
//! for `eth_chainId`, `eth_blockNumber`, `eth_getCode`, and the three
//! gateway view selectors (`paused`, `usdc`, `vault`).

mod common;

use crate::common::{
    enc_address, enc_bool, jrpc_result, match_eth_call_selector, selector_hex_of, Fixture,
    GATEWAY_CODE, USDC, VAULT,
};
use alloy_primitives::{hex as ahex, keccak256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

async fn install_gateway_mocks(server: &mut mockito::ServerGuard, chain_id: u64, block_no: u64) {
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
        .match_body(Matcher::PartialJson(json!({"method": "eth_getCode"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(GATEWAY_CODE))))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::pausedCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(false)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::usdcCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(USDC)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::vaultCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(VAULT)))
        .expect_at_least(0)
        .create_async()
        .await;
}

#[tokio::test]
async fn get_gateway_clean_envelope_shape() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x42u64;
    install_gateway_mocks(&mut server, chain_id, block_no).await;
    let fix = Fixture::build(&server.url(), chain_id);

    let out = rmpc()
        .args(["get-gateway", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");

    // Envelope shape (ADR §3.2)
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(v["block_number"], block_no);
    assert_eq!(v["source"], "json_rpc");
    assert_eq!(v["partial"], false);
    assert!(v["errors"].as_array().unwrap().is_empty());

    // Per-command data
    let d = &v["data"];
    let observed_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));
    assert_eq!(d["code_hash"], observed_hash);
    assert_eq!(d["configured_code_hash"], observed_hash);
    assert_eq!(d["paused"], false);
    assert_eq!(
        d["usdc"].as_str().unwrap().to_lowercase(),
        format!("{USDC:#x}")
    );
    assert_eq!(
        d["vault"].as_str().unwrap().to_lowercase(),
        format!("{VAULT:#x}")
    );
}

#[tokio::test]
async fn get_gateway_partial_when_paused_reverts() {
    // Install everything except `paused` succeeds, then layer a 200
    // *response* with a JSON-RPC error object on the paused selector.
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
        .match_body(Matcher::PartialJson(json!({"method": "eth_getCode"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(GATEWAY_CODE))))
        .expect_at_least(0)
        .create_async()
        .await;
    // paused: deliberate revert via JSON-RPC error object.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::pausedCall,
        >()))
        .with_status(200)
        .with_body(r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}"#)
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::usdcCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(USDC)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::vaultCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(VAULT)))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args(["get-gateway", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["partial"], true);
    let errs = v["errors"].as_array().unwrap();
    assert!(errs.iter().any(|e| e["field"] == "paused"));
}

#[tokio::test]
async fn get_gateway_pretty_emits_multiline() {
    let mut server = mockito::Server::new_async().await;
    install_gateway_mocks(&mut server, 31337, 1).await;
    let fix = Fixture::build(&server.url(), 31337);
    let out = rmpc()
        .args([
            "get-gateway",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--pretty",
        ])
        .assert()
        .success()
        .get_output()
        .clone();
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.lines().count() >= 5, "pretty must be multi-line");
}
