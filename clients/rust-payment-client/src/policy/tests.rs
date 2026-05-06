//! Preflight unit tests — drive a real `mockito` JSON-RPC server so the
//! transport, encoder, and decoder stay in the loop. Each test exercises
//! a single refusal path (or the happy path) by stubbing each
//! method/selector independently.

use super::*;
use crate::config::{Config, SignerConfig};
use crate::errors::RmpcError;
use alloy_primitives::{address, hex as ahex, keccak256, Address, B256, U256};
use alloy_sol_types::SolCall;
use mockito::Matcher;
use serde_json::json;
use std::path::PathBuf;

const SIGNER: Address = address!("00000000000000000000000000000000000000aa");
const GATEWAY: Address = address!("0000000000000000000000000000000000000b00");
const USDC: Address = address!("0000000000000000000000000000000000000c00");
const VAULT: Address = address!("0000000000000000000000000000000000000d00");

/// Canned gateway runtime bytecode used by all happy-path tests. The
/// preflight only cares about its keccak256, so any non-empty blob works.
const GATEWAY_CODE: &[u8] = &[0x60, 0x80, 0x60, 0x40, 0x52, 0xfe, 0xfe, 0xfe];

fn config() -> Config {
    let hash = keccak256(GATEWAY_CODE);
    Config {
        chain_id: 31337,
        rpc_url: "http://placeholder".into(),
        gateway_address: format!("{GATEWAY:#x}"),
        usdc_address: format!("{USDC:#x}"),
        vault_address: format!("{VAULT:#x}"),
        gateway_runtime_hash: format!("0x{}", ahex::encode(hash)),
        max_fee_per_gas_cap: 100_000_000_000,
        max_priority_fee_per_gas_cap: None,
        state_dir: None,
        signer: SignerConfig {
            allow_software_fallback: true,
            keystore_path: PathBuf::from("/tmp/ks.enc"),
        },
        log: Default::default(),
    }
}

fn inputs(amount: u64) -> PreflightInputs {
    PreflightInputs {
        signer_address: SIGNER,
        amount: U256::from(amount),
    }
}

/// Build a 32-byte right-padded boolean ABI return blob.
fn enc_bool(v: bool) -> String {
    let mut w = [0u8; 32];
    w[31] = if v { 1 } else { 0 };
    format!("0x{}", ahex::encode(w))
}

/// 32-byte ABI return blob for a single Address.
fn enc_address(a: Address) -> String {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a.as_slice());
    format!("0x{}", ahex::encode(w))
}

/// 32-byte ABI return blob for a single uint256.
fn enc_u256(v: U256) -> String {
    format!("0x{}", ahex::encode(v.to_be_bytes::<32>()))
}

/// Encode the 5-tuple `(bool active, uint64 validUntil, uint256 maxPerPayment,
/// uint256 maxPerWindow, address shareReceiver)` returned by `agents()`.
fn enc_agents(
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

fn jrpc_result(s: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":1,"result":"{s}"}}"#)
}

fn selector_hex_of<C: SolCall>() -> String {
    format!("0x{}", ahex::encode(C::SELECTOR))
}

/// Mock matcher: a JSON-RPC `eth_call` whose `params[0].data` starts with
/// the given 4-byte selector. Used to route responses per view call.
fn match_eth_call_selector(selector: &str) -> Matcher {
    let prefix = selector.to_string();
    Matcher::AllOf(vec![
        Matcher::PartialJson(json!({"method": "eth_call"})),
        Matcher::Regex(format!(r#""data":"{prefix}"#)),
    ])
}

/// Wire up the full happy-path response set. Tests then override one stub
/// to flip a single rule into a refusal.
async fn install_happy_path_mocks(server: &mut mockito::ServerGuard, cfg: &Config) {
    // chain_id
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{:x}", cfg.chain_id)))
        .expect_at_least(0)
        .create_async()
        .await;
    // eth_getCode
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getCode"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(GATEWAY_CODE))))
        .expect_at_least(0)
        .create_async()
        .await;
    // paused() = false
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
    // usdc()
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
    // vault()
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
    // agents() — active, far future expiry, ample caps
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
            address!("00000000000000000000000000000000000000ee"),
        )))
        .expect_at_least(0)
        .create_async()
        .await;
    // agentWindowGross() = 0
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
    // allowance() = ample
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
    // balanceOf() = ample
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

#[tokio::test]
async fn happy_path_returns_ok_report() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let report = pf.run(inputs(100)).await.expect("preflight ok");
    assert_eq!(report.chain_id, cfg.chain_id);
    assert!(report.gateway_runtime_hash_ok);
    assert!(!report.paused);
    assert!(report.agent_active);
}

#[tokio::test]
async fn chain_id_mismatch_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // Override chain_id with a higher-priority mock returning the wrong id.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result("0x1")) // 1 != 31337
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(matches!(err, RmpcError::ErrChainIdMismatch), "got {err:?}");
}

#[tokio::test]
async fn empty_code_refuses_with_code_hash_mismatch() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{:x}", cfg.chain_id)))
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getCode"})))
        .with_status(200)
        .with_body(jrpc_result("0x"))
        .create_async()
        .await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(matches!(err, RmpcError::ErrCodeHashMismatch), "got {err:?}");
}

#[tokio::test]
async fn code_hash_mismatch_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{:x}", cfg.chain_id)))
        .create_async()
        .await;
    // Return code with a *different* keccak.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getCode"})))
        .with_status(200)
        .with_body(jrpc_result("0xdeadbeef"))
        .create_async()
        .await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(matches!(err, RmpcError::ErrCodeHashMismatch), "got {err:?}");
}

#[tokio::test]
async fn paused_gateway_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // Higher-priority paused() = true.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::pausedCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(matches!(err, RmpcError::ErrGatewayPaused), "got {err:?}");
}

#[tokio::test]
async fn usdc_address_mismatch_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // gateway.usdc() returns a different address.
    let wrong = address!("00000000000000000000000000000000deadbeef");
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::usdcCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(wrong)))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    match err {
        RmpcError::ErrConfig(msg) => assert!(msg.contains("usdc"), "msg = {msg}"),
        other => panic!("expected ErrConfig (usdc), got {other:?}"),
    }
}

#[tokio::test]
async fn vault_address_mismatch_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    let wrong = address!("00000000000000000000000000000000feedface");
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::vaultCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(wrong)))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    match err {
        RmpcError::ErrConfig(msg) => assert!(msg.contains("vault"), "msg = {msg}"),
        other => panic!("expected ErrConfig (vault), got {other:?}"),
    }
}

#[tokio::test]
async fn inactive_agent_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_agents(
            false,
            u64::MAX,
            U256::from(1_000_000u64),
            U256::from(100_000_000u64),
            address!("00000000000000000000000000000000000000ee"),
        )))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(
        matches!(err, RmpcError::ErrAgentNotAuthorized),
        "got {err:?}"
    );
}

#[tokio::test]
async fn expired_agent_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_agents(
            true,
            1, // way in the past
            U256::from(1_000_000u64),
            U256::from(100_000_000u64),
            address!("00000000000000000000000000000000000000ee"),
        )))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(
        matches!(err, RmpcError::ErrAgentNotAuthorized),
        "got {err:?}"
    );
}

#[tokio::test]
async fn over_per_payment_cap_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_agents(
            true,
            u64::MAX,
            U256::from(50u64), // tiny cap
            U256::from(100_000_000u64),
            address!("00000000000000000000000000000000000000ee"),
        )))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(1_000)).await.unwrap_err();
    match err {
        RmpcError::ErrConfig(m) => assert!(m.contains("maxPerPayment"), "m = {m}"),
        other => panic!("expected ErrConfig (maxPerPayment), got {other:?}"),
    }
}

#[tokio::test]
async fn over_window_cap_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // High agentWindowGross such that gross + amount > maxPerWindow.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentWindowGrossCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(99_999_999u64))))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(1_000)).await.unwrap_err();
    match err {
        RmpcError::ErrConfig(m) => assert!(m.contains("maxPerWindow"), "m = {m}"),
        other => panic!("expected ErrConfig (maxPerWindow), got {other:?}"),
    }
}

#[tokio::test]
async fn allowance_too_low_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockUsdc::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(1u64))))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(
        matches!(err, RmpcError::ErrAllowanceInsufficient),
        "got {err:?}"
    );
}

#[tokio::test]
async fn balance_too_low_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            MockUsdc::balanceOfCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(1u64))))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = RpcClient::new(server.url()).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(
        matches!(err, RmpcError::ErrBalanceInsufficient),
        "got {err:?}"
    );
}

#[test]
fn parse_b256_hex_round_trip() {
    let h = B256::from(keccak256(b"ok"));
    let s = format!("0x{}", ahex::encode(h));
    let bytes = parse_b256_hex(&s).unwrap();
    assert_eq!(bytes, h.0);
}

#[test]
fn parse_b256_hex_rejects_wrong_length() {
    assert!(parse_b256_hex("0xabcd").is_err());
}
