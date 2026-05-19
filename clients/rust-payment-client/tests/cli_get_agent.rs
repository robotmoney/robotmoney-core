//! Canonical: docs/implementation-plan.md §9 — `rmpc get-agent`
//!
//! Integration tests for `rmpc get-agent` (issue #49).

mod common;

use crate::common::{
    enc_agents, enc_agents_with_withdrawal, enc_u256, jrpc_result, jrpc_result_raw,
    match_eth_call_selector, selector_hex_of, Fixture, SHARE_RECEIVER,
};
use alloy_primitives::{address, Address, U256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::{Erc20, RobotMoneyGateway};
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

#[tokio::test]
async fn get_agent_clean_envelope_with_decimal_strings() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x123u64;
    let block_ts = 1_700_000_000u64;
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
            json!({"method": "eth_getBlockByNumber"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(&format!(
            r#"{{"timestamp":"0x{ts:x}","number":"0x{block_no:x}"}}"#,
            ts = block_ts,
            block_no = block_no
        )))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_agents(
            true,
            u64::MAX,
            U256::from(1_000_000u64),
            U256::from(100_000_000u64),
            SHARE_RECEIVER,
        )))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentWindowGrossCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(42u64))))
        .expect_at_least(0)
        .create_async()
        .await;
    // vault.allowance(agent, gateway) — surfaced as `share_allowance`
    // by issue #429 to quantify the agent-compromise blast radius.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            Erc20::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(0u64))))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let target = "0x00000000000000000000000000000000000000aa";
    let out = rmpc()
        .args([
            "get-agent",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--agent",
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

    let d = &v["data"];
    assert_eq!(d["agent"].as_str().unwrap().to_lowercase(), target);
    assert_eq!(d["active"], true);
    assert_eq!(d["valid_until"], u64::MAX);
    // Decimal-string contract: large integers must serialize as strings.
    assert_eq!(d["max_per_payment"], "1000000");
    assert_eq!(d["max_per_window"], "100000000");
    assert_eq!(d["window_gross"], "42");
    // window_id = block_ts / WINDOW_SECONDS (86400)
    assert_eq!(d["window_id"], block_ts / 86400);

    // Issue #429: deposit-only policies (maxWithdrawPerPayment == 0)
    // must report withdrawals_enabled = false. This is the regression
    // guard against "deposit-only policies do not show withdrawal
    // exposure as enabled" from the issue acceptance tests.
    assert_eq!(d["withdrawals_enabled"], false);
    assert_eq!(d["max_withdraw_per_payment"], "0");
    assert_eq!(d["max_withdraw_per_window"], "0");
    assert_eq!(
        d["asset_recipient"].as_str().unwrap(),
        "0x0000000000000000000000000000000000000000"
    );
    assert_eq!(d["share_allowance"], "0");
}

/// Issue #429: when a policy has `maxWithdrawPerPayment > 0` the
/// envelope must report `withdrawals_enabled = true`, expose the
/// `asset_recipient` and the per-payment / per-window withdrawal caps,
/// and surface the outstanding `share_allowance` so operators can see
/// the agent-compromise blast radius.
#[tokio::test]
async fn get_agent_surfaces_withdrawal_exposure() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x123u64;
    let block_ts = 1_700_000_000u64;
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
            json!({"method": "eth_getBlockByNumber"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(&format!(
            r#"{{"timestamp":"0x{ts:x}","number":"0x{block_no:x}"}}"#,
            ts = block_ts,
            block_no = block_no
        )))
        .expect_at_least(0)
        .create_async()
        .await;
    let asset_recipient: Address = address!("00000000000000000000000000000000000000bb");
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
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentWindowGrossCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(0u64))))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            Erc20::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(7_777_777u64))))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let target = "0x00000000000000000000000000000000000000aa";
    let out = rmpc()
        .args([
            "get-agent",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--agent",
            target,
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let d = &v["data"];
    assert_eq!(d["withdrawals_enabled"], true);
    assert_eq!(d["max_withdraw_per_payment"], "500000");
    assert_eq!(d["max_withdraw_per_window"], "5000000");
    assert_eq!(
        d["asset_recipient"].as_str().unwrap(),
        format!("{asset_recipient:#x}")
    );
    // share_allowance is exposed even when allowance > policy caps;
    // operators compare it with `max_withdraw_per_window` themselves.
    assert_eq!(d["share_allowance"], "7777777");
}

#[test]
fn get_agent_rejects_malformed_address() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-agent",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--agent",
            "garbage",
        ])
        .assert()
        .failure();
}
