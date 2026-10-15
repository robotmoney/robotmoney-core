//! Canonical: Plan tracking issue #109 §9 — `rmpc get-gateway`
//!
//! Integration tests for `rmpc get-gateway` (issue #49). Drives the
//! command against a `mockito` JSON-RPC server with canned responses
//! for `eth_chainId`, `eth_blockNumber`, `eth_getCode`, `eth_getStorageAt`
//! and the gateway view selectors (`depositsPaused`, `usdc`, `vault`, and
//! for a proxied gateway `upgradeAuthority`, `upgradesFrozen`,
//! `implementationVersion`; QA plan P3).

mod common;

use crate::common::{
    enc_address, enc_bool, enc_string, install_direct_gateway_slot_mock, jrpc_result,
    match_eth_call_selector, selector_hex_of, Fixture, GATEWAY, GATEWAY_CODE, USDC, VAULT,
};
use alloy_primitives::{address, hex as ahex, keccak256, Address};
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
    install_direct_gateway_slot_mock(server).await;
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
    assert_eq!(d["deposits_paused"], false);
    assert_eq!(
        d["usdc"].as_str().unwrap().to_lowercase(),
        format!("{USDC:#x}")
    );
    assert_eq!(
        d["vault"].as_str().unwrap().to_lowercase(),
        format!("{VAULT:#x}")
    );
    // A direct gateway: no implementation, nothing to pin, approved as is.
    assert!(d["implementation"].is_null());
    assert_eq!(d["implementation_approved"], true);
    assert!(d["upgrades_frozen"].is_null());
}

// ─── QA plan P3: a proxied gateway ──────────────────────────────────────────

const IMPL: Address = address!("00000000000000000000000000000000000001a1");
const IMPL_CODE: &[u8] = &[0x60, 0x01, 0x60, 0x00, 0xfe];
const TIMELOCK: Address = address!("000000000000000000000000000000000000071c");

/// The gateway is a proxy over `IMPL` (frozen, version "2", governed by
/// `TIMELOCK`). Install after `install_gateway_mocks`: the last matching mock
/// answers.
async fn install_proxied_gateway_mocks(server: &mut mockito::ServerGuard) {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getStorageAt"})))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(IMPL)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getCode"})),
            Matcher::Regex(format!(r#"(?i)"params":\["{IMPL:#x}""#)),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(IMPL_CODE))))
        .expect_at_least(0)
        .create_async()
        .await;
    for (selector, body) in [
        (
            selector_hex_of::<RobotMoneyGateway::upgradeAuthorityCall>(),
            enc_address(TIMELOCK),
        ),
        (
            selector_hex_of::<RobotMoneyGateway::upgradesFrozenCall>(),
            enc_bool(true),
        ),
        (
            selector_hex_of::<RobotMoneyGateway::implementationVersionCall>(),
            enc_string("2"),
        ),
    ] {
        server
            .mock("POST", "/")
            .match_body(match_eth_call_selector(&selector))
            .with_status(200)
            .with_body(jrpc_result(&body))
            .expect_at_least(0)
            .create_async()
            .await;
    }
}

/// Write `gateway_implementation_hashes = [hash]` into the fixture config.
fn pin_implementation(fix: &Fixture, hash: &str) {
    let mut toml = std::fs::read_to_string(&fix.config_path).unwrap();
    toml = toml.replacen(
        "max_fee_per_gas_cap",
        &format!("gateway_implementation_hashes = [\"{hash}\"]\nmax_fee_per_gas_cap"),
        1,
    );
    std::fs::write(&fix.config_path, toml).unwrap();
}

fn get_gateway(fix: &Fixture) -> Value {
    let out = rmpc()
        .args(["get-gateway", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();
    serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).expect("stdout is JSON")
}

/// rmpc prints the implementation, its code hash, the freeze state, the
/// authority and the consent version, and says the pinned implementation is
/// approved. The proxy's own code hash still matches the old pin.
#[tokio::test]
async fn get_gateway_prints_implementation_and_freeze_state() {
    let mut server = mockito::Server::new_async().await;
    install_gateway_mocks(&mut server, 31337, 0x42).await;
    install_proxied_gateway_mocks(&mut server).await;
    let fix = Fixture::build(&server.url(), 31337);
    let impl_hash = format!("0x{}", ahex::encode(keccak256(IMPL_CODE)));
    pin_implementation(&fix, &impl_hash);

    let v = get_gateway(&fix);
    assert_eq!(v["partial"], false, "{v}");
    let d = &v["data"];
    assert_eq!(d["address"], format!("{GATEWAY:#x}"));
    assert_eq!(
        d["code_hash"], d["configured_code_hash"],
        "proxy pin unchanged"
    );
    assert_eq!(d["implementation"], format!("{IMPL:#x}"));
    assert_eq!(d["implementation_code_hash"], impl_hash);
    assert_eq!(d["configured_implementation_hashes"], json!([impl_hash]));
    assert_eq!(d["implementation_approved"], true);
    assert_eq!(d["implementation_version"], "2");
    assert_eq!(d["upgrade_authority"], format!("{TIMELOCK:#x}"));
    assert_eq!(d["upgrades_frozen"], true);
}

/// Same proxy, but the config pins another implementation: the read still
/// succeeds and says a write would be refused.
#[tokio::test]
async fn get_gateway_reports_an_unapproved_implementation() {
    let mut server = mockito::Server::new_async().await;
    install_gateway_mocks(&mut server, 31337, 0x42).await;
    install_proxied_gateway_mocks(&mut server).await;
    let fix = Fixture::build(&server.url(), 31337);
    pin_implementation(&fix, &format!("0x{}", "ab".repeat(32)));

    let v = get_gateway(&fix);
    let d = &v["data"];
    assert_eq!(d["implementation"], format!("{IMPL:#x}"));
    assert_eq!(d["implementation_approved"], false);
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
