//! Canonical: Plan tracking issue #109 §9 — `rmpc get-gateway`
//!
//! Integration tests for `rmpc get-gateway` (issue #49). Drives the
//! command against a `mockito` JSON-RPC server with canned responses
//! for `eth_chainId`, `eth_blockNumber`, `eth_getCode`, and the three
//! gateway view selectors (`depositsPaused`, `usdc`, `vault`).

mod common;

use crate::common::{
    enc_address, enc_bool, jrpc_result, match_eth_call_selector, selector_hex_of, Fixture,
    GATEWAY_CODE, USDC,
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
    // Empty ERC-1967 implementation slot: a direct gateway.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getStorageAt"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", "00".repeat(32))))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::depositsPausedCall,
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
    assert_eq!(d["deposits_paused"], false);
    assert_eq!(
        d["usdc"].as_str().unwrap().to_lowercase(),
        format!("{USDC:#x}")
    );
    // The gateway pins no vault, so the envelope carries no `vault` field.
    assert!(d.get("vault").is_none(), "gateway.vault() is retired");
}

#[tokio::test]
async fn get_gateway_partial_when_deposits_paused_reverts() {
    // Install everything except `depositsPaused` succeeds, then layer a 200
    // *response* with a JSON-RPC error object on the depositsPaused selector.
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
    // depositsPaused: deliberate revert via JSON-RPC error object.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::depositsPausedCall,
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
    assert!(errs.iter().any(|e| e["field"] == "deposits_paused"));
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

/// Issue 1810: a proxied gateway discloses its live implementation, that
/// implementation's code hash, the freeze state and the upgrade timelock,
/// beside the approved implementation from the TOML.
#[tokio::test]
async fn get_gateway_discloses_implementation_and_freeze_state() {
    use alloy_primitives::{address, Address};
    use rust_payment_client::policy::implementation::ERC1967_IMPLEMENTATION_SLOT;
    const IMPL: Address = address!("00000000000000000000000000000000000a11ce");
    const IMPL_CODE: &[u8] = &[0x60, 0x01, 0xaa];
    const TIMELOCK: Address = address!("0000000000000000000000000000000000071e10");

    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_gateway_mocks(&mut server, chain_id, 0x42).await;
    crate::common::install_gateway_implementation(&mut server, IMPL, IMPL_CODE, Some("0x42")).await;
    for (selector, body) in [
        (
            selector_hex_of::<RobotMoneyGateway::upgradesFrozenCall>(),
            enc_bool(true),
        ),
        (
            selector_hex_of::<RobotMoneyGateway::upgradeTimelockCall>(),
            enc_address(TIMELOCK),
        ),
    ] {
        server
            .mock("POST", "/")
            .match_body(match_eth_call_selector(&selector))
            .with_status(200)
            .with_body(jrpc_result(&body))
            .expect(1)
            .create_async()
            .await;
    }
    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL, IMPL_CODE);

    let out = rmpc()
        .args(["get-gateway", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["partial"], false, "{v}");
    let d = &v["data"];
    let impl_hash = format!("0x{}", ahex::encode(keccak256(IMPL_CODE)));
    assert_eq!(d["implementation"], format!("{IMPL:#x}"));
    assert_eq!(d["implementation_code_hash"], impl_hash);
    assert_eq!(d["configured_implementation"], format!("{IMPL:#x}"));
    assert_eq!(d["configured_implementation_code_hash"], impl_hash);
    assert_eq!(d["upgrades_frozen"], true);
    assert_eq!(d["upgrade_timelock"], format!("{TIMELOCK:#x}"));
    // The slot constant is the ERC-1967 one.
    assert_eq!(
        format!("{ERC1967_IMPLEMENTATION_SLOT:#x}"),
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
    );
}

/// A direct gateway has no upgrade path: the upgrade fields are null and the
/// envelope is not partial.
#[tokio::test]
async fn get_gateway_reports_a_direct_gateway_as_having_no_implementation() {
    let mut server = mockito::Server::new_async().await;
    install_gateway_mocks(&mut server, 31337, 0x42).await;
    let fix = Fixture::build(&server.url(), 31337);
    let out = rmpc()
        .args(["get-gateway", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["partial"], false, "{v}");
    assert!(v["data"]["implementation"].is_null());
    assert!(v["data"]["upgrades_frozen"].is_null());
    assert!(v["data"]["upgrade_timelock"].is_null());
}
