//! Canonical: docs/implementation-plan.md §5.1 — Router-weight governance reads
//!
//! Integration tests for `rmpc get-router` (issue #308).
//! Drives the command against a `mockito` JSON-RPC server with canned
//! responses for `eth_chainId`, `eth_blockNumber`, `getWeights()`, and
//! `routerCap()`.

mod common;

use crate::common::{enc_u256, jrpc_result, match_eth_call_selector, selector_hex_of, USDC, VAULT};
use alloy_primitives::{address, hex as ahex, keccak256, Address, U256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::PortfolioRouter;
use serde_json::{json, Value};
use std::path::PathBuf;
use tempfile::TempDir;

/// A router address constant for tests.
const ROUTER: Address = address!("0000000000000000000000000000000000000f00");
/// A second vault address for weight-split tests.
const VAULT2: Address = address!("0000000000000000000000000000000000000d01");

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// Fixture that includes a `router_address` in the TOML config.
struct RouterFixture {
    _tmp: TempDir,
    pub config_path: PathBuf,
}

impl RouterFixture {
    fn build(rpc_url: &str, chain_id: u64) -> Self {
        use crate::common::{GATEWAY, GATEWAY_CODE, TEST_PASSPHRASE};
        use rust_payment_client::signer::software::SoftwareSigner;

        let tmp = TempDir::new().expect("tempdir");
        let keystore_path = tmp.path().join("keystore.json");
        const TEST_PRIVKEY: [u8; 32] = [
            0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38,
            0xff, 0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b,
            0xf4, 0xf2, 0xff, 0x80,
        ];
        SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
            .expect("create keystore");

        let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));
        let config_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "{GATEWAY:#x}"
usdc_address          = "{USDC:#x}"
vault_address         = "{VAULT:#x}"
router_address        = "{ROUTER:#x}"
gateway_runtime_hash  = "{runtime_hash}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{}"
"#,
            keystore_path.display(),
        );
        std::fs::write(&config_path, toml).expect("write config");
        Self {
            _tmp: tmp,
            config_path,
        }
    }
}

/// ABI-encode a `getWeights()` return: (address[], uint256[]).
fn enc_get_weights(vaults: &[Address], bps: &[u64]) -> String {
    use alloy_sol_types::SolCall;
    let bps_u256: Vec<U256> = bps.iter().map(|&b| U256::from(b)).collect();
    let blob = PortfolioRouter::getWeightsCall::abi_encode_returns(&(vaults.to_vec(), bps_u256));
    format!("0x{}", ahex::encode(blob))
}

// ── Happy path: two vaults with 60/40 split ──────────────────────────────────

#[tokio::test]
async fn get_router_two_vault_weights() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x10u64;
    let router_cap = U256::ZERO; // uncapped

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
    // getWeights() → ([VAULT, VAULT2], [6000, 4000])
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            PortfolioRouter::getWeightsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_get_weights(
            &[VAULT, VAULT2],
            &[6000, 4000],
        )))
        .expect_at_least(0)
        .create_async()
        .await;
    // routerCap() → 0
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            PortfolioRouter::routerCapCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(router_cap)))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = RouterFixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args(["get-router", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(v["block_number"], block_no);
    assert_eq!(v["source"], "json_rpc");
    assert_eq!(v["partial"], false);

    let weights = v["data"]["weights"].as_array().unwrap();
    assert_eq!(weights.len(), 2, "expected 2 weight entries: {v}");

    let w0 = &weights[0];
    assert_eq!(
        w0["vault"].as_str().unwrap().to_lowercase(),
        format!("{VAULT:#x}")
    );
    assert_eq!(w0["weight_bps"].as_str().unwrap(), "6000");

    let w1 = &weights[1];
    assert_eq!(
        w1["vault"].as_str().unwrap().to_lowercase(),
        format!("{VAULT2:#x}")
    );
    assert_eq!(w1["weight_bps"].as_str().unwrap(), "4000");

    assert_eq!(v["data"]["router_cap"].as_str().unwrap(), "0");
}

// ── Router cap set ────────────────────────────────────────────────────────────

#[tokio::test]
async fn get_router_with_cap_set() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x20u64;
    let router_cap = U256::from(500_000_000u64); // 500 USDC

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
            PortfolioRouter::getWeightsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_get_weights(&[VAULT], &[10_000])))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            PortfolioRouter::routerCapCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(router_cap)))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = RouterFixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args(["get-router", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["partial"], false);
    assert_eq!(v["data"]["router_cap"].as_str().unwrap(), "500000000");
}

// ── No router_address → fails fast ───────────────────────────────────────────

#[test]
fn get_router_without_router_address_fails() {
    let tmp = TempDir::new().expect("tempdir");
    let cfg_path = tmp.path().join("rmpc.toml");
    let toml = format!(
        r#"chain_id              = 31337
rpc_url               = "http://127.0.0.1:1"
gateway_address       = "0x{gw}"
usdc_address          = "0x{usdc}"
vault_address         = "0x{vault}"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
        gw = "00".repeat(20),
        usdc = "00".repeat(20),
        vault = "00".repeat(20),
        zeros = "0".repeat(64),
        ks = tmp.path().join("ks.json").display(),
    );
    std::fs::write(&cfg_path, &toml).expect("write config");
    rmpc()
        .args(["get-router", "--config", cfg_path.to_str().unwrap()])
        .assert()
        .failure();
}

// ── Partial envelope when getWeights reverts ──────────────────────────────────

#[tokio::test]
async fn get_router_partial_when_get_weights_reverts() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x30u64;

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
    // getWeights() reverts
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            PortfolioRouter::getWeightsCall,
        >()))
        .with_status(200)
        .with_body(r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}"#)
        .expect_at_least(0)
        .create_async()
        .await;
    // routerCap() succeeds
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            PortfolioRouter::routerCapCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::ZERO)))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = RouterFixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args(["get-router", "--config", fix.config_path.to_str().unwrap()])
        .assert()
        .success() // partial envelope still exits 0
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["partial"], true);
    let errors = v["errors"].as_array().unwrap();
    assert!(!errors.is_empty(), "expected at least one field error");
    let field = errors[0]["field"].as_str().unwrap();
    assert_eq!(field, "weights");
}
