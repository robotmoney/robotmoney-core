//! Canonical: none — integration tests for `rmpc self-check`
//!
//! Integration tests for `rmpc self-check` (issue #15).
//!
//! Each test wires a `mockito` JSON-RPC server, builds a temp config +
//! keystore via [`common::Fixture`], and invokes the binary with
//! `assert_cmd`. Assertions cover both exit code and the JSON shape on
//! stdout.

mod common;

use crate::common::{
    enc_agents_with_withdrawal, enc_bool, install_happy_path_mocks, jrpc_result,
    match_eth_call_selector, selector_hex_of, Fixture, GATEWAY, SHARE_RECEIVER, SIGNER_ADDRESS,
    TEST_PASSPHRASE,
};
use alloy_primitives::{address, Address, U256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

#[tokio::test]
async fn self_check_happy_path_emits_v92_report_and_exits_zero() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;

    let fix = Fixture::build(&server.url(), chain_id);

    let out = rmpc()
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
    assert_eq!(v["network_env"], "local_devnet");
    assert_eq!(
        v["gateway"].as_str().unwrap().to_lowercase(),
        format!("{GATEWAY:#x}")
    );
    assert_eq!(v["software_fallback_allowed"], true);
    assert_eq!(v["selected_backend_production_ready"], false);
    assert!(v["selected_backend_operator_message"]
        .as_str()
        .unwrap()
        .contains("non-production"));
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

    // Issue #429: withdrawal_exposure block must always be present so
    // operators can see whether agent-initiated withdrawals are
    // enabled and how much can be moved on an agent-key compromise.
    // The happy-path mock leaves the withdrawal policy fields at zero,
    // so `withdrawals_enabled` must be false and the exposure caps
    // must report "0". This is the regression check for "deposit-only
    // policies do not show withdrawal exposure as enabled".
    let exposure = &v["withdrawal_exposure"];
    assert_eq!(exposure["withdrawals_enabled"], false);
    assert_eq!(exposure["max_withdraw_per_payment"], "0");
    assert_eq!(exposure["max_withdraw_per_window"], "0");
    assert_eq!(
        exposure["asset_recipient"].as_str().unwrap(),
        "0x0000000000000000000000000000000000000000"
    );
    // share_allowance is read from the same allowanceCall mock as the
    // USDC allowance check (selector match, not address match) — what
    // matters here is the field shape, not the exact value.
    assert!(exposure["share_allowance"].is_string());
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

    let out = rmpc()
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

    let out = rmpc()
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

    let out = rmpc()
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

/// Issue #429 acceptance: when the agent policy has withdrawals
/// enabled (`maxWithdrawPerPayment > 0`) `rmpc self-check` must report
/// `withdrawals_enabled = true`, the configured `asset_recipient`, and
/// the share-withdrawal caps. This drives the rmpc test_plan bullet
/// "self-check/status reports share allowance and withdrawal cap
/// exposure".
#[tokio::test]
async fn self_check_surfaces_withdrawal_enabled_policy() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let asset_recipient: Address = address!("00000000000000000000000000000000000000cc");
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    // Override the deposit-only `agents()` mock from
    // `install_happy_path_mocks` with the withdrawal-enabled tuple.
    // Mockito tries the most-recently-registered matching mock first,
    // so this is what both the preflight and the withdrawal-exposure
    // read see.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_agents_with_withdrawal(
            true,
            u64::MAX,
            U256::from(1_000_000u64),
            U256::from(100_000_000u64),
            SHARE_RECEIVER,
            asset_recipient,
            U256::from(500_000u64),
            U256::from(5_000_000u64),
        )))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = rmpc()
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
    let exposure = &v["withdrawal_exposure"];
    assert_eq!(exposure["withdrawals_enabled"], true);
    assert_eq!(exposure["max_withdraw_per_payment"], "500000");
    assert_eq!(exposure["max_withdraw_per_window"], "5000000");
    assert_eq!(
        exposure["asset_recipient"].as_str().unwrap(),
        format!("{asset_recipient:#x}")
    );
    // share_allowance is the u128::MAX value from install_happy_path_mocks.
    // What matters is the field exists and decodes; the exact value is
    // policy-irrelevant.
    assert!(exposure["share_allowance"].is_string());
    assert_eq!(exposure["stale_share_allowance"], false);
}

/// Issue #429 stale-allowance regression: when withdrawals are
/// disabled but the agent still has a non-zero `vault.allowance(agent,
/// gateway)`, `self-check` must flag `stale_share_allowance = true`.
/// That signal is the hook the allowance-hygiene UX hangs off.
#[tokio::test]
async fn self_check_flags_stale_share_allowance() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    // `install_happy_path_mocks` returns the deposit-only agent shape
    // (`maxWithdrawPerPayment = 0`) and `allowance = u128::MAX`, which
    // is exactly the stale-allowance case: withdrawals disabled but a
    // non-zero share allowance still sits on the gateway. The
    // hygiene-flag derivation is the contract under test.
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = rmpc()
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
    let exposure = &v["withdrawal_exposure"];
    assert_eq!(exposure["withdrawals_enabled"], false);
    assert_eq!(exposure["stale_share_allowance"], true);
    // Sanity: the share_allowance value is non-zero (u128::MAX from the
    // happy-path mock), which is why stale_share_allowance triggers.
    assert_ne!(exposure["share_allowance"], "0");
}

#[test]
fn self_check_without_passphrase_env_fails_fast() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    let mut cmd = rmpc();
    cmd.env_remove(PASSPHRASE_ENV_VAR);
    cmd.args(["self-check", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .failure();
}
