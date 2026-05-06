//! Integration tests for `rmpd self-check` (issue #15).
//!
//! Each test wires a `mockito` JSON-RPC server, builds a temp config +
//! keystore via [`common::Fixture`], and invokes the binary with
//! `assert_cmd`. Assertions cover both exit code and the JSON shape on
//! stdout.

mod common;

use crate::common::{
    enc_bool, install_happy_path_mocks, jrpc_result, match_eth_call_selector, selector_hex_of,
    Fixture, GATEWAY, SIGNER_ADDRESS, TEST_PASSPHRASE,
};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_daemon::gateway::RobotMoneyGateway;
use rust_payment_daemon::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::{json, Value};

fn rmpd() -> Command {
    Command::cargo_bin("rmpd").expect("rmpd binary built")
}

#[tokio::test]
async fn self_check_happy_path_emits_v92_report_and_exits_zero() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;

    let fix = Fixture::build(&server.url(), chain_id);

    let out = rmpd()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args(["self-check", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");

    // v0 §9.2 fields.
    assert_eq!(v["selected_backend"], "software");
    assert_eq!(
        v["agent_address"].as_str().unwrap().to_lowercase(),
        format!("{SIGNER_ADDRESS:#x}")
    );
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(
        v["gateway"].as_str().unwrap().to_lowercase(),
        format!("{GATEWAY:#x}")
    );
    assert_eq!(v["software_fallback_allowed"], true);
    assert_eq!(v["key_exportable"], true);
    assert_eq!(v["device_bound"], false);
    assert!(v["timestamp"].is_number());

    // Preflight snapshot.
    let checks = &v["checks"];
    assert_eq!(checks["chain_id_match"], true);
    assert_eq!(checks["gateway_code_hash_match"], true);
    assert_eq!(checks["gateway_paused"], false);
    assert_eq!(checks["agent_active"], true);
    assert!(checks["agent_valid_until"].is_number());
    assert_eq!(checks["max_per_payment"], "1000000");
    assert_eq!(checks["max_per_window"], "100000000");
    assert_eq!(checks["window_gross"], "0");

    assert_eq!(v["ok"], true);
    assert!(v.get("error").is_none());
}

#[tokio::test]
async fn self_check_chain_id_mismatch_exits_nonzero_with_named_error() {
    let mut server = mockito::Server::new_async().await;
    let cfg_chain_id = 31337u64;
    // Higher-priority mock returning the *wrong* chain id.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result("0x1"))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, cfg_chain_id, SIGNER_ADDRESS).await;

    let fix = Fixture::build(&server.url(), cfg_chain_id);

    let out = rmpd()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args(["self-check", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .failure()
        .get_output()
        .clone();

    assert_eq!(out.status.code(), Some(2), "preflight refusal => exit 2");
    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrChainIdMismatch");
    assert_eq!(v["checks"]["chain_id_match"], false);
}

#[tokio::test]
async fn self_check_paused_gateway_exits_nonzero() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    // paused() = true (higher priority).
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::pausedCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;

    let fix = Fixture::build(&server.url(), chain_id);

    let out = rmpd()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args(["self-check", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .failure()
        .get_output()
        .clone();

    assert_eq!(out.status.code(), Some(2));
    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrGatewayPaused");
    assert_eq!(v["checks"]["gateway_paused"], true);
}

#[tokio::test]
async fn self_check_pretty_emits_multiline_indented_json() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    let fix = Fixture::build(&server.url(), chain_id);

    let out = rmpd()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args([
            "self-check",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--pretty",
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(
        stdout.lines().count() > 5,
        "pretty output should span multiple lines, got:\n{stdout}"
    );
    assert!(
        stdout.contains("  \"selected_backend\""),
        "pretty output should be 2-space indented"
    );
    // Still valid JSON.
    serde_json::from_str::<Value>(stdout.trim()).unwrap();
}

#[test]
fn self_check_without_passphrase_env_fails_fast() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    let mut cmd = rmpd();
    cmd.env_remove(PASSPHRASE_ENV_VAR);
    cmd.args(["self-check", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .failure();
}
