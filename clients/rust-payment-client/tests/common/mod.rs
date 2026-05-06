//! Shared test fixtures for the `rmpc` CLI integration tests.
//!
//! These helpers build a temp keystore + temp config file pointing at a
//! mockito JSON-RPC server, and set up the full happy-path response set.
//! Individual tests override the mocks they care about.

#![allow(dead_code)] // each integration target only uses a subset

use alloy_primitives::{address, hex as ahex, keccak256, Address, U256};
use alloy_sol_types::SolCall;
use mockito::Matcher;
use rust_payment_client::gateway::{MockUsdc, RobotMoneyGateway};
use rust_payment_client::signer::software::SoftwareSigner;
use serde_json::json;
use std::path::PathBuf;
use tempfile::TempDir;

pub const SIGNER_ADDRESS: Address = address!("f39fd6e51aad88f6f4ce6ab8827279cfffb92266");
pub const GATEWAY: Address = address!("0000000000000000000000000000000000000b00");
pub const USDC: Address = address!("0000000000000000000000000000000000000c00");
pub const VAULT: Address = address!("0000000000000000000000000000000000000d00");
pub const SHARE_RECEIVER: Address = address!("00000000000000000000000000000000000000ee");

/// Canned gateway runtime bytecode. The preflight only cares about its
/// keccak256, so any non-empty blob works.
pub const GATEWAY_CODE: &[u8] = &[0x60, 0x80, 0x60, 0x40, 0x52, 0xfe, 0xfe, 0xfe];

/// 32-byte private key whose corresponding address matches [`SIGNER_ADDRESS`]
/// (anvil account #0 — `0xac0974…ff80`, address
/// `0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266`). Used purely as a
/// deterministic test fixture.
const TEST_PRIVKEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94,
    0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];

pub const TEST_PASSPHRASE: &[u8] = b"correct horse battery staple";

/// A fully wired test environment.
pub struct Fixture {
    /// Owns the temp dir; drop-order matters (TempDir last).
    _tmp: TempDir,
    pub keystore_path: PathBuf,
    pub config_path: PathBuf,
}

impl Fixture {
    /// Build a temp keystore + config TOML pointing at `rpc_url`, with
    /// `chain_id` baked in.
    pub fn build(rpc_url: &str, chain_id: u64) -> Self {
        let tmp = TempDir::new().expect("tempdir");
        let keystore_path = tmp.path().join("keystore.json");
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
            keystore_path,
            config_path,
        }
    }
}

// --- ABI return helpers ----------------------------------------------------

pub fn enc_bool(v: bool) -> String {
    let mut w = [0u8; 32];
    w[31] = if v { 1 } else { 0 };
    format!("0x{}", ahex::encode(w))
}

pub fn enc_address(a: Address) -> String {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a.as_slice());
    format!("0x{}", ahex::encode(w))
}

pub fn enc_u256(v: U256) -> String {
    format!("0x{}", ahex::encode(v.to_be_bytes::<32>()))
}

pub fn enc_agents(
    active: bool,
    valid_until: u64,
    max_per_payment: U256,
    max_per_window: U256,
    share_receiver: Address,
) -> String {
    let mut blob = Vec::with_capacity(32 * 5);
    let mut w = [0u8; 32];
    w[31] = if active { 1 } else { 0 };
    blob.extend_from_slice(&w);
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&valid_until.to_be_bytes());
    blob.extend_from_slice(&w);
    blob.extend_from_slice(&max_per_payment.to_be_bytes::<32>());
    blob.extend_from_slice(&max_per_window.to_be_bytes::<32>());
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(share_receiver.as_slice());
    blob.extend_from_slice(&w);
    format!("0x{}", ahex::encode(blob))
}

pub fn jrpc_result(s: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":1,"result":"{s}"}}"#)
}

pub fn jrpc_result_raw(json: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":1,"result":{json}}}"#)
}

pub fn selector_hex_of<C: SolCall>() -> String {
    format!("0x{}", ahex::encode(C::SELECTOR))
}

pub fn match_eth_call_selector(selector: &str) -> Matcher {
    let prefix = selector.to_string();
    Matcher::AllOf(vec![
        Matcher::PartialJson(json!({"method": "eth_call"})),
        Matcher::Regex(format!(r#""data":"{prefix}"#)),
    ])
}

/// Wire the full happy-path JSON-RPC response set for the preflight.
/// `agent_address` controls which address the `agents()` view appears to
/// be keyed on — all callers happen to use the same software-signer
/// address, but the parameter is left explicit.
pub async fn install_happy_path_mocks(
    server: &mut mockito::ServerGuard,
    chain_id: u64,
    _agent_address: Address,
) {
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
        .with_body(jrpc_result(&enc_u256(U256::ZERO)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockUsdc::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(u128::MAX))))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockUsdc::balanceOfCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(u128::MAX))))
        .expect_at_least(0)
        .create_async()
        .await;
}
