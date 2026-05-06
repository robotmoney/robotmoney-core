//! Canonical: docs/implementation-plan.md §9 — `rmpc get-roles`
//!
//! Integration tests for `rmpc get-roles` (issue #49). The four
//! `*_ROLE()` getters return distinct `bytes32` constants; we mock
//! each, then route `hasRole(role, address)` calls through their
//! request-body selector + role hash.

mod common;

use crate::common::{enc_bool, jrpc_result, match_eth_call_selector, selector_hex_of, Fixture};
use alloy_primitives::{b256, hex as ahex, B256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

fn enc_b256(b: B256) -> String {
    format!("0x{}", ahex::encode(b.as_slice()))
}

const DEFAULT_ADMIN: B256 =
    b256!("0000000000000000000000000000000000000000000000000000000000000000");
const ADMIN: B256 = b256!("a49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775");
const PAUSER: B256 = b256!("65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a");
const AGENT: B256 = b256!("ad8b3c9c5e1bb39e7d11f60d1aac96f10b0b4b8cb71afd96b6c9f5cce2fae12d");

#[tokio::test]
async fn get_roles_clean_envelope() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x99u64;
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
            RobotMoneyGateway::DEFAULT_ADMIN_ROLECall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_b256(DEFAULT_ADMIN)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::ADMIN_ROLECall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_b256(ADMIN)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::PAUSER_ROLECall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_b256(PAUSER)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::AGENT_ROLECall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_b256(AGENT)))
        .expect_at_least(0)
        .create_async()
        .await;
    // hasRole — mock all calls to return true. We don't disambiguate by
    // role because they share the same selector; the response is a
    // single boolean either way and the test asserts on the structural
    // envelope, not per-role values.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::hasRoleCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let target = "0x00000000000000000000000000000000000000aa";
    let out = rmpc()
        .args([
            "get-roles",
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

    let d = &v["data"];
    assert_eq!(d["address"].as_str().unwrap().to_lowercase(), target);
    let roles = d["roles"].as_array().unwrap();
    assert_eq!(roles.len(), 4);
    let names: Vec<&str> = roles.iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        vec![
            "DEFAULT_ADMIN_ROLE",
            "ADMIN_ROLE",
            "PAUSER_ROLE",
            "AGENT_ROLE"
        ]
    );
    for r in roles {
        assert_eq!(r["has_role"], true);
        let h = r["hash"].as_str().unwrap();
        assert!(h.starts_with("0x") && h.len() == 66);
    }
}

#[test]
fn get_roles_rejects_malformed_address() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-roles",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--address",
            "not-an-address",
        ])
        .assert()
        .failure();
}
