//! Canonical: none — unit tests for the policy preflight module
//!
//! Preflight unit tests — drive a real `mockito` JSON-RPC server so the
//! transport, encoder, and decoder stay in the loop. Each test exercises
//! a single refusal path (or the happy path) by stubbing each
//! method/selector independently.

use super::*;
use crate::config::{Config, SignerConfig};
use crate::errors::RmpcError;
use crate::rpc::FailoverRpcClient;
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
        rpc_url: Some("http://placeholder".into()),
        rpc_urls: None,
        gateway_address: format!("{GATEWAY:#x}"),
        usdc_address: format!("{USDC:#x}"),
        vault_address: format!("{VAULT:#x}"),
        gateway_runtime_hash: format!("0x{}", ahex::encode(hash)),
        max_fee_per_gas_cap: Some(100_000_000_000),
        max_priority_fee_per_gas_cap: None,
        state_dir: None,
        registry_address: None,
        router_address: None,
        governance_address: None,
        timelock_address: None,
        timelock_from_block: None,
        gateway_from_block: None,
        ic_policy_address: None,
        receipt_address: None,
        vault_addresses: None,
        share_receiver: None,
        agent_owner: None,
        gateway_implementation_hashes: None,
        proxy_implementation_hashes: None,
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

/// Encode the 8-tuple `(bool active, uint64 validUntil, uint256 maxPerPayment,
/// uint256 maxPerWindow, address shareReceiver, address assetRecipient,
/// uint256 maxWithdrawPerPayment, uint256 maxWithdrawPerWindow)` returned by
/// `agents()`. The three withdrawal fields (added in #311) are zero — withdrawal
/// disabled — so deposit preflight tests are unaffected.
fn enc_agents(
    active: bool,
    valid_until: u64,
    max_per_payment: U256,
    max_per_window: U256,
    share_receiver: Address,
) -> String {
    enc_agents_full(
        active,
        valid_until,
        max_per_payment,
        max_per_window,
        share_receiver,
        U256::ZERO,
        U256::ZERO,
    )
}

/// Encode the full 8-tuple including withdrawal-specific cap fields.
/// Used by withdrawal preflight tests (issue #371).
fn enc_agents_full(
    active: bool,
    valid_until: u64,
    max_per_payment: U256,
    max_per_window: U256,
    share_receiver: Address,
    max_withdraw_per_payment: U256,
    max_withdraw_per_window: U256,
) -> String {
    let mut blob = Vec::with_capacity(32 * 8);
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
    // assetRecipient = zero
    blob.extend_from_slice(&[0u8; 32]);
    blob.extend_from_slice(&max_withdraw_per_payment.to_be_bytes::<32>());
    blob.extend_from_slice(&max_withdraw_per_window.to_be_bytes::<32>());
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

/// Block the implementation reads of check 2b are pinned to in these tests.
const PIN_BLOCK: u64 = 0x2a;

/// Check 2b for a direct (pre-proxy) gateway: `eth_blockNumber` and an
/// empty ERC-1967 implementation slot (QA plan P3).
async fn install_direct_gateway_slot_mocks(server: &mut mockito::ServerGuard) {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{PIN_BLOCK:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getStorageAt"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", "00".repeat(32))))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// Wire up the full happy-path response set. Tests then override one stub
/// to flip a single rule into a refusal.
async fn install_happy_path_mocks(server: &mut mockito::ServerGuard, cfg: &Config) {
    install_direct_gateway_slot_mocks(server).await;
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
    // depositsPaused() = false (gateway and vault share the selector)
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
    // effectiveDepositWindowGross() = 0 (issue #497 — rolling deposit window)
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::effectiveDepositWindowGrossCall,
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
            Erc20::allowanceCall,
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
            Erc20::balanceOfCall,
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let report = pf.run(inputs(100)).await.expect("preflight ok");
    assert_eq!(report.chain_id, cfg.chain_id);
    assert!(report.gateway_runtime_hash_ok);
    assert!(!report.deposits_paused);
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(matches!(err, RmpcError::ErrCodeHashMismatch), "got {err:?}");
}

/// Match an `eth_call` of `selector` sent to `to`. The deposit preflight
/// reads `depositsPaused()` on the gateway and on the vault with one
/// selector, so a test that pauses only one of them must match the target.
fn match_eth_call_to(selector: &str, to: Address) -> Matcher {
    Matcher::AllOf(vec![
        Matcher::PartialJson(json!({"method": "eth_call"})),
        Matcher::Regex(format!(r#""data":"{selector}"#)),
        Matcher::Regex(format!(r#"(?i)"to":"{to:#x}""#)),
    ])
}

#[tokio::test]
async fn deposits_paused_gateway_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // Higher-priority gateway.depositsPaused() = true.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_to(
            &selector_hex_of::<RobotMoneyGateway::depositsPausedCall>(),
            GATEWAY,
        ))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(matches!(err, RmpcError::ErrDepositsPaused), "got {err:?}");
}

/// The vault the gateway deposits into reverts `DepositsArePaused` while its
/// own deposit pause is set, so the deposit preflight refuses on it too,
/// even when the gateway itself is not paused.
#[tokio::test]
async fn deposits_paused_vault_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // Higher-priority vault.depositsPaused() = true; the gateway's read
    // falls through to the happy-path `false`.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_to(
            &selector_hex_of::<RobotMoneyGateway::depositsPausedCall>(),
            VAULT,
        ))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(matches!(err, RmpcError::ErrDepositsPaused), "got {err:?}");
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(
        matches!(err, RmpcError::ErrAgentNotAuthorized),
        "got {err:?}"
    );
}

/// An expired policy is `ErrPolicyExpired`, the `expired_policy` reason
/// code, not `ErrAgentNotAuthorized` (QA plan U6).
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(matches!(err, RmpcError::ErrPolicyExpired), "got {err:?}");
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

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(1_000)).await.unwrap_err();
    match err {
        RmpcError::ErrDepositCapExceeded(m) => assert!(m.contains("maxPerPayment"), "m = {m}"),
        other => panic!("expected ErrDepositCapExceeded (maxPerPayment), got {other:?}"),
    }
}

#[tokio::test]
async fn over_window_cap_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // High effectiveDepositWindowGross such that gross + amount > maxPerWindow.
    // Issue #497: preflight now reads the rolling gross via effectiveDepositWindowGross.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::effectiveDepositWindowGrossCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(99_999_999u64))))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(1_000)).await.unwrap_err();
    match err {
        RmpcError::ErrDepositCapExceeded(m) => assert!(m.contains("maxPerWindow"), "m = {m}"),
        other => panic!("expected ErrDepositCapExceeded (maxPerWindow), got {other:?}"),
    }
}

#[tokio::test]
async fn allowance_too_low_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            Erc20::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(1u64))))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
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
            Erc20::balanceOfCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(1u64))))
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf.run(inputs(100)).await.unwrap_err();
    assert!(
        matches!(err, RmpcError::ErrBalanceInsufficient),
        "got {err:?}"
    );
}

/// Wire up happy-path mocks for `run_withdraw_gateway`. Uses
/// `enc_agents_full` so deposit caps and withdrawal caps can differ.
/// `effectiveWithdrawWindowGross` is stubbed to `withdraw_window_gross`
/// (issue #449 — rolling-window cap accounting).
async fn install_withdraw_gateway_mocks(
    server: &mut mockito::ServerGuard,
    cfg: &Config,
    max_per_payment: U256,
    max_per_window: U256,
    max_withdraw_per_payment: U256,
    max_withdraw_per_window: U256,
    withdraw_window_gross: U256,
) {
    install_direct_gateway_slot_mocks(server).await;
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
    // depositsPaused() = false (gateway and vault share the selector)
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
    // agents() — with split deposit / withdrawal caps
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_agents_full(
            true,
            u64::MAX,
            max_per_payment,
            max_per_window,
            address!("00000000000000000000000000000000000000ee"),
            max_withdraw_per_payment,
            max_withdraw_per_window,
        )))
        .expect_at_least(0)
        .create_async()
        .await;
    // effectiveWithdrawWindowGross() — issue #449
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::effectiveWithdrawWindowGrossCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(withdraw_window_gross)))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// Issue #371 — deposit caps are high but withdrawal caps are low.
/// A medium-sized withdrawal must be rejected even though the deposit
/// caps would allow it.
#[tokio::test]
async fn withdraw_gateway_rejects_when_deposit_caps_high_withdraw_caps_low() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // deposit caps: 10 USDC per payment, 1000 USDC per window (generous)
    // withdrawal caps: 50 shares per payment, 500 shares per window (tight)
    // attempt: 100 shares — within deposit caps but exceeds withdrawal cap
    install_withdraw_gateway_mocks(
        &mut server,
        &cfg,
        U256::from(10_000_000u64),    // maxPerPayment (deposit) = 10 USDC
        U256::from(1_000_000_000u64), // maxPerWindow (deposit)  = 1000 USDC
        U256::from(50u64),            // maxWithdrawPerPayment   = 50 shares
        U256::from(500u64),           // maxWithdrawPerWindow    = 500 shares
        U256::ZERO,                   // withdrawWindowGross     = 0
    )
    .await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let err = pf
        .run_withdraw_gateway(PreflightInputs {
            signer_address: SIGNER,
            amount: U256::from(100u64), // exceeds maxWithdrawPerPayment=50
        })
        .await
        .unwrap_err();
    match err {
        RmpcError::ErrWithdrawCapExceeded(m) => assert!(
            m.contains("maxWithdrawPerPayment"),
            "expected maxWithdrawPerPayment in msg, got: {m}"
        ),
        other => panic!("expected ErrWithdrawCapExceeded(maxWithdrawPerPayment), got {other:?}"),
    }
}

/// Issue #371 — deposit caps are low but withdrawal caps are high.
/// A medium-sized withdrawal must be accepted even though the deposit
/// caps would reject it.
#[tokio::test]
async fn withdraw_gateway_allows_when_deposit_caps_low_withdraw_caps_high() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // deposit caps: 50 shares per payment, 500 shares per window (tight)
    // withdrawal caps: 10_000 shares per payment, 100_000 per window (generous)
    // attempt: 100 shares — within withdrawal caps, would exceed deposit caps
    install_withdraw_gateway_mocks(
        &mut server,
        &cfg,
        U256::from(50u64),      // maxPerPayment (deposit)  = 50 (tight)
        U256::from(500u64),     // maxPerWindow  (deposit)  = 500 (tight)
        U256::from(10_000u64),  // maxWithdrawPerPayment    = 10_000
        U256::from(100_000u64), // maxWithdrawPerWindow     = 100_000
        U256::ZERO,             // withdrawWindowGross      = 0
    )
    .await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let pf = Preflight::new(&rpc, &cfg);
    let result = pf
        .run_withdraw_gateway(PreflightInputs {
            signer_address: SIGNER,
            amount: U256::from(100u64), // within withdrawal caps
        })
        .await;
    assert!(result.is_ok(), "expected ok, got {result:?}");
}

/// A deposit pause on the gateway never refuses a withdrawal (core 1494).
/// The preflight passes and reports the flag as information.
#[tokio::test]
async fn withdraw_gateway_passes_and_reports_while_deposits_paused() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // Higher-priority depositsPaused() = true.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::depositsPausedCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .create_async()
        .await;
    install_withdraw_gateway_mocks(
        &mut server,
        &cfg,
        U256::from(50u64),
        U256::from(500u64),
        U256::from(10_000u64),
        U256::from(100_000u64),
        U256::ZERO,
    )
    .await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let report = Preflight::new(&rpc, &cfg)
        .run_withdraw_gateway(PreflightInputs {
            signer_address: SIGNER,
            amount: U256::from(100u64),
        })
        .await
        .expect("a deposit pause must not refuse a withdrawal");
    assert!(report.deposits_paused);
}

/// The deposit-pause flag is information only on a withdrawal, so a failed
/// read of it cannot refuse the withdrawal either.
#[tokio::test]
async fn withdraw_gateway_passes_when_deposits_paused_read_fails() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    // Higher-priority depositsPaused() returns a JSON-RPC error.
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::depositsPausedCall,
        >()))
        .with_status(200)
        .with_body(r#"{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted"}}"#)
        .create_async()
        .await;
    install_withdraw_gateway_mocks(
        &mut server,
        &cfg,
        U256::from(50u64),
        U256::from(500u64),
        U256::from(10_000u64),
        U256::from(100_000u64),
        U256::ZERO,
    )
    .await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let result = Preflight::new(&rpc, &cfg)
        .run_withdraw_gateway(PreflightInputs {
            signer_address: SIGNER,
            amount: U256::from(100u64),
        })
        .await;
    assert!(result.is_ok(), "expected ok, got {result:?}");
}

// ── Agent binding (QA plan D2, finding CS-1) ───────────────────────────
//
// A squatter can bind a fresh agent address first, naming itself as
// `shareReceiver`. The agent's own preflight then saw an active policy and
// signed deposits whose shares went to the squatter. With `share_receiver` /
// `agent_owner` pinned in the config, the preflight refuses instead.

/// The happy-path `agents()` mock names this share receiver.
const ON_CHAIN_RECEIVER: Address = address!("00000000000000000000000000000000000000ee");
/// The operator's own address, pinned in the config.
const OPERATOR: Address = address!("00000000000000000000000000000000000000ef");

/// Mock `agentOwner(SIGNER)` to return `owner`.
async fn mock_agent_owner(server: &mut mockito::ServerGuard, owner: Address) -> mockito::Mock {
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentOwnerCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(owner)))
        .expect_at_least(1)
        .create_async()
        .await
}

#[tokio::test]
async fn preflight_refuses_foreign_share_receiver() {
    let mut server = mockito::Server::new_async().await;
    let mut cfg = config();
    cfg.share_receiver = Some(format!("{OPERATOR:#x}"));
    install_happy_path_mocks(&mut server, &cfg).await;
    // Registered last, so it would serve any allowance read the preflight made.
    let usdc_reads = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            Erc20::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(u128::MAX))))
        .expect(0)
        .create_async()
        .await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .unwrap_err();
    match &err {
        RmpcError::ErrAgentBindingMismatch {
            field,
            on_chain,
            configured,
        } => {
            assert_eq!(*field, "agents(self).shareReceiver");
            assert_eq!(on_chain, &format!("{ON_CHAIN_RECEIVER:#x}"));
            assert_eq!(configured, &format!("{OPERATOR:#x}"));
        }
        other => panic!("expected ErrAgentBindingMismatch, got {other:?}"),
    }
    assert_eq!(err.name(), "ErrAgentBindingMismatch");
    // Refused at check 6b: the USDC reads after it never ran.
    usdc_reads.assert_async().await;

    // The withdraw preflight reads the same binding and refuses the same way.
    let err = Preflight::new(&rpc, &cfg)
        .run_withdraw_gateway(inputs(100))
        .await
        .unwrap_err();
    assert_eq!(err.name(), "ErrAgentBindingMismatch", "got {err:?}");
}

#[tokio::test]
async fn preflight_refuses_foreign_agent_owner() {
    let mut server = mockito::Server::new_async().await;
    let mut cfg = config();
    cfg.share_receiver = Some(format!("{ON_CHAIN_RECEIVER:#x}"));
    cfg.agent_owner = Some(format!("{OPERATOR:#x}"));
    let squatter = address!("000000000000000000000000000000000000dead");
    let owner_read = mock_agent_owner(&mut server, squatter).await;
    install_happy_path_mocks(&mut server, &cfg).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .unwrap_err();
    match &err {
        RmpcError::ErrAgentBindingMismatch {
            field, on_chain, ..
        } => {
            assert_eq!(*field, "agentOwner(self)");
            assert_eq!(on_chain, &format!("{squatter:#x}"));
        }
        other => panic!("expected ErrAgentBindingMismatch, got {other:?}"),
    }
    owner_read.assert_async().await;
}

/// A binding that matches the config passes, and an unpinned config never
/// reads `agentOwner` (configs written before D2 keep working unchanged).
#[tokio::test]
async fn preflight_passes_when_binding_matches_config() {
    let mut server = mockito::Server::new_async().await;
    let mut cfg = config();
    cfg.share_receiver = Some(format!("{ON_CHAIN_RECEIVER:#x}"));
    cfg.agent_owner = Some(format!("{OPERATOR:#x}"));
    let owner_read = mock_agent_owner(&mut server, OPERATOR).await;
    install_happy_path_mocks(&mut server, &cfg).await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let report = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .expect("a matching binding passes");
    assert_eq!(report.share_receiver, ON_CHAIN_RECEIVER);
    owner_read.assert_async().await;

    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    let no_owner_read = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::agentOwnerCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(OPERATOR)))
        .expect(0)
        .create_async()
        .await;
    install_happy_path_mocks(&mut server, &cfg).await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .expect("an unpinned config passes");
    no_owner_read.assert_async().await;
}

/// The withdraw preflight names a rolling-window breach with its reason
/// code, not `ErrConfig` (QA plan U6).
#[tokio::test]
async fn withdraw_gateway_names_window_cap_breach() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    install_withdraw_gateway_mocks(
        &mut server,
        &cfg,
        U256::from(10_000u64),
        U256::from(100_000u64),
        U256::from(10_000u64),
        U256::from(500u64),
        U256::from(450u64),
    )
    .await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run_withdraw_gateway(inputs(100))
        .await
        .unwrap_err();
    match err {
        RmpcError::ErrWithdrawCapExceeded(m) => {
            assert!(m.contains("maxWithdrawPerWindow"), "m = {m}")
        }
        other => panic!("expected ErrWithdrawCapExceeded, got {other:?}"),
    }
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

// ── Withdraw vault preflight (issue #312, RPC-7) ───────────────────────
//
// These moved here with `run_withdraw_vault` (issue #1285). They
// previously lived in `commands::withdraw` and `commands::withdraw_router`
// as two near-identical copies, because the rule itself lived in a command
// module rather than in the policy layer.

/// Install the two vault reads the withdraw preflight makes: the share
/// allowance/balance reads, plain ERC-20 calls against the vault. It never
/// reads `depositsPaused()` (core 1494).
async fn install_vault_mocks(server: &mut mockito::ServerGuard, allowance: U256, balance: U256) {
    // The vault's ERC-1967 slot read (ADR-0014): empty, a direct vault.
    install_direct_gateway_slot_mocks(server).await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            Erc20::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(allowance)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            Erc20::balanceOfCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(balance)))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// A vault whose deposits are paused still passes the withdraw preflight:
/// a deposit pause never blocks a redeem (core 1494). The preflight does not
/// even read the flag; the `expect(0)` mock proves it.
#[tokio::test]
async fn withdraw_vault_deposits_paused_still_passes() {
    let mut server = mockito::Server::new_async().await;
    let paused_read = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::depositsPausedCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .expect(0)
        .create_async()
        .await;
    install_vault_mocks(&mut server, U256::from(u128::MAX), U256::from(u128::MAX)).await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let cfg = config();
    let result = Preflight::new(&rpc, &cfg)
        .run_withdraw_vault(VAULT, GATEWAY, SIGNER, U256::from(100u64))
        .await;
    assert!(result.is_ok(), "expected ok, got {result:?}");
    paused_read.assert_async().await;
}

/// RPC-7: the withdraw and router-withdraw paths must REFUSE when the
/// agent's vault-share allowance to the gateway cannot cover the shares,
/// rather than reporting success right up to an on-chain revert.
#[tokio::test]
async fn withdraw_vault_allowance_insufficient_refuses() {
    let mut server = mockito::Server::new_async().await;
    install_vault_mocks(&mut server, U256::from(1u64), U256::from(u128::MAX)).await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let cfg = config();
    let err = Preflight::new(&rpc, &cfg)
        .run_withdraw_vault(VAULT, GATEWAY, SIGNER, U256::from(1_000u64))
        .await
        .unwrap_err();
    assert!(
        matches!(err, RmpcError::ErrShareAllowanceInsufficient),
        "got {err:?}"
    );
}

/// RPC-7: same, for a share balance that cannot cover the shares.
#[tokio::test]
async fn withdraw_vault_balance_insufficient_refuses() {
    let mut server = mockito::Server::new_async().await;
    install_vault_mocks(&mut server, U256::from(u128::MAX), U256::from(1u64)).await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let cfg = config();
    let err = Preflight::new(&rpc, &cfg)
        .run_withdraw_vault(VAULT, GATEWAY, SIGNER, U256::from(1_000u64))
        .await
        .unwrap_err();
    assert!(
        matches!(err, RmpcError::ErrShareBalanceInsufficient),
        "got {err:?}"
    );
}

/// With ample allowance and balance the check passes — confirming it reads
/// real values rather than always refusing.
#[tokio::test]
async fn withdraw_vault_preflight_happy_path() {
    let mut server = mockito::Server::new_async().await;
    install_vault_mocks(&mut server, U256::from(u128::MAX), U256::from(u128::MAX)).await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let cfg = config();
    let result = Preflight::new(&rpc, &cfg)
        .run_withdraw_vault(VAULT, GATEWAY, SIGNER, U256::from(100u64))
        .await;
    assert!(result.is_ok(), "expected ok, got {result:?}");
}

// ─── QA plan P3: the implementation behind a proxied gateway ────────────────
//
// A proxy keeps its own runtime code across an upgrade, so these fixtures keep
// `eth_getCode(GATEWAY)` = `GATEWAY_CODE` (the pinned `gateway_runtime_hash`)
// and change only what the ERC-1967 slot names. Check 2b must refuse an
// implementation the config does not list, and any failed read, before a
// signature exists.

const IMPL_V1: Address = address!("00000000000000000000000000000000000001a1");
const IMPL_V2: Address = address!("00000000000000000000000000000000000001a2");
const IMPL_CODE_V1: &[u8] = &[0x60, 0x01, 0x60, 0x00, 0xfe];
const IMPL_CODE_V2: &[u8] = &[0x60, 0x02, 0x60, 0x00, 0xfe];

/// `config()` that approves the implementations whose code is `approved`.
fn proxied_config(approved: &[&[u8]]) -> Config {
    let mut cfg = config();
    cfg.gateway_implementation_hashes = Some(
        approved
            .iter()
            .map(|c| format!("0x{}", ahex::encode(keccak256(c))))
            .collect(),
    );
    cfg
}

/// The slot of GATEWAY names `implementation`, whose code is `code`. Both
/// mocks answer only a read at `PIN_BLOCK`, so a preflight that read the slot
/// and the code at different blocks (or at `latest`) would miss them. Install
/// after the happy-path set: the last matching mock answers.
async fn install_proxy_mocks(
    server: &mut mockito::ServerGuard,
    implementation: Address,
    code: &[u8],
) -> (mockito::Mock, mockito::Mock) {
    install_proxy_mocks_for(server, GATEWAY, implementation, code).await
}

/// `install_proxy_mocks` for any proxy: the slot of `proxy` names
/// `implementation`, whose code is `code`, both read at `PIN_BLOCK`.
async fn install_proxy_mocks_for(
    server: &mut mockito::ServerGuard,
    proxy: Address,
    implementation: Address,
    code: &[u8],
) -> (mockito::Mock, mockito::Mock) {
    let slot = crate::upgrade::ERC1967_IMPLEMENTATION_SLOT;
    let storage = server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getStorageAt"})),
            Matcher::Regex(format!(
                r#"(?i)"params":\["{proxy:#x}","{slot:#x}","0x{PIN_BLOCK:x}"\]"#
            )),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(implementation)))
        .expect_at_least(1)
        .create_async()
        .await;
    let code_mock = server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getCode"})),
            Matcher::Regex(format!(
                r#"(?i)"params":\["{implementation:#x}","0x{PIN_BLOCK:x}"\]"#
            )),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(code))))
        .expect_at_least(1)
        .create_async()
        .await;
    (storage, code_mock)
}

fn rpc_error_body() -> String {
    r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"header not found"}}"#.into()
}

fn not_approved_reason(err: RmpcError) -> (String, String) {
    match err {
        RmpcError::ErrImplementationNotApproved {
            code_hash, reason, ..
        } => (code_hash, reason),
        other => panic!("expected ErrImplementationNotApproved, got {other:?}"),
    }
}

/// An approved implementation passes, and the report names it. Both reads
/// were made at one block.
#[tokio::test]
async fn proxy_with_approved_implementation_passes_and_reports_it() {
    let mut server = mockito::Server::new_async().await;
    let cfg = proxied_config(&[IMPL_CODE_V1]);
    install_happy_path_mocks(&mut server, &cfg).await;
    let (storage, code) = install_proxy_mocks(&mut server, IMPL_V1, IMPL_CODE_V1).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let report = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .expect("an approved implementation passes");
    assert_eq!(report.implementation, Some(IMPL_V1));
    assert_eq!(
        report.implementation_code_hash,
        Some(keccak256(IMPL_CODE_V1))
    );
    storage.assert_async().await;
    code.assert_async().await;
}

/// The issue #1810 fixture: the proxy's code (and so `gateway_runtime_hash`)
/// is unchanged, but the slot now names an implementation nobody approved.
/// The deposit preflight refuses before anything is signed.
#[tokio::test]
async fn swapped_implementation_refuses_while_proxy_hash_is_unchanged() {
    let mut server = mockito::Server::new_async().await;
    let cfg = proxied_config(&[IMPL_CODE_V1]);
    install_happy_path_mocks(&mut server, &cfg).await;
    install_proxy_mocks(&mut server, IMPL_V2, IMPL_CODE_V2).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .unwrap_err();
    let (code_hash, reason) = not_approved_reason(err);
    assert_eq!(code_hash, format!("{:#x}", keccak256(IMPL_CODE_V2)));
    assert!(
        reason.contains("not in gateway_implementation_hashes"),
        "{reason}"
    );
}

/// The withdraw preflight runs the same check: an exit is signed only
/// against an approved implementation too.
#[tokio::test]
async fn withdraw_preflight_refuses_a_swapped_implementation() {
    let mut server = mockito::Server::new_async().await;
    let cfg = proxied_config(&[IMPL_CODE_V1]);
    install_withdraw_gateway_mocks(
        &mut server,
        &cfg,
        U256::from(1_000_000u64),
        U256::from(100_000_000u64),
        U256::from(1_000u64),
        U256::from(10_000u64),
        U256::ZERO,
    )
    .await;
    install_proxy_mocks(&mut server, IMPL_V2, IMPL_CODE_V2).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run_withdraw_gateway(inputs(100))
        .await
        .unwrap_err();
    not_approved_reason(err);
}

/// A proxied gateway with no `gateway_implementation_hashes` is refused: the
/// proxy pin alone approves any logic.
#[tokio::test]
async fn proxy_without_implementation_pin_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = config();
    install_happy_path_mocks(&mut server, &cfg).await;
    install_proxy_mocks(&mut server, IMPL_V1, IMPL_CODE_V1).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .unwrap_err();
    let (_, reason) = not_approved_reason(err);
    assert!(reason.contains("not set"), "{reason}");
}

/// A failed slot read is a refusal, never read as "not a proxy".
#[tokio::test]
async fn failed_implementation_slot_read_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = proxied_config(&[IMPL_CODE_V1]);
    install_happy_path_mocks(&mut server, &cfg).await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getStorageAt"})))
        .with_status(200)
        .with_body(rpc_error_body())
        .expect_at_least(1)
        .create_async()
        .await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .unwrap_err();
    assert!(matches!(err, RmpcError::ErrRpcServer { .. }), "got {err:?}");
}

/// A failed read of the implementation's code is a refusal too.
#[tokio::test]
async fn failed_implementation_code_read_refuses() {
    let mut server = mockito::Server::new_async().await;
    let cfg = proxied_config(&[IMPL_CODE_V1]);
    install_happy_path_mocks(&mut server, &cfg).await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getStorageAt"})))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(IMPL_V1)))
        .expect_at_least(1)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getCode"})),
            Matcher::Regex(format!(r#"(?i)"params":\["{IMPL_V1:#x}""#)),
        ]))
        .with_status(200)
        .with_body(rpc_error_body())
        .expect_at_least(1)
        .create_async()
        .await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .unwrap_err();
    assert!(matches!(err, RmpcError::ErrRpcServer { .. }), "got {err:?}");
}

/// Issue 1810: a refusal that can come from check 2b itself (an RPC error on
/// the slot or code read, a malformed `gateway_implementation_hashes` entry)
/// never reports `gateway_implementation_approved: true` in the JSON
/// `checks` block. Only errors raised after 2b passed may claim it.
#[test]
fn partial_checks_never_claim_an_approved_implementation_on_a_2b_failure() {
    for err in [
        RmpcError::ErrRpcServer {
            code: -32000,
            message: "header not found".into(),
        },
        RmpcError::ErrRpcTransport("connection reset".into()),
        RmpcError::ErrRpcDecode("bad word".into()),
        RmpcError::ErrConfig("gateway_implementation_hashes[0]: odd length".into()),
        RmpcError::ErrImplementationNotApproved {
            proxy: crate::upgrade::GATEWAY.into(),
            implementation: format!("{IMPL_V2:#x}"),
            code_hash: format!("{:#x}", keccak256(IMPL_CODE_V2)),
            reason: "its code hash is not in gateway_implementation_hashes".into(),
        },
    ] {
        let c = ChecksOutput::from_err_partial(&err);
        assert!(
            !c.gateway_implementation_approved,
            "{err:?} must not report an approved implementation"
        );
    }
    for err in [
        RmpcError::ErrDepositsPaused,
        RmpcError::ErrAgentNotAuthorized,
        RmpcError::ErrPolicyExpired,
        RmpcError::ErrAllowanceInsufficient,
        RmpcError::ErrBalanceInsufficient,
        RmpcError::ErrShareAllowanceInsufficient,
        RmpcError::ErrShareBalanceInsufficient,
        RmpcError::ErrDepositCapExceeded("cap".into()),
        RmpcError::ErrWithdrawCapExceeded("cap".into()),
    ] {
        let c = ChecksOutput::from_err_partial(&err);
        assert!(
            c.gateway_implementation_approved,
            "{err:?} is raised only after check 2b passed"
        );
    }
}

// ─── ADR-0014: the vault behind the gateway is a proxy too ──────────────────
//
// `vault_address` and `gateway.vault()` pin the vault's address, not the logic
// behind it. Check 5c (deposit) and the withdraw vault preflight read the
// vault's implementation at one block and refuse unless its code hash is in
// `proxy_implementation_hashes`.

const VAULT_IMPL: Address = address!("00000000000000000000000000000000000002b1");
const VAULT_IMPL_CODE: &[u8] = &[0x60, 0x03, 0x60, 0x00, 0xfe];

fn vault_pinned(cfg: Config, approved: &[&[u8]]) -> Config {
    Config {
        proxy_implementation_hashes: Some(
            approved
                .iter()
                .map(|c| format!("0x{}", ahex::encode(keccak256(c))))
                .collect(),
        ),
        ..cfg
    }
}

#[tokio::test]
async fn deposit_refuses_a_proxied_vault_whose_implementation_is_not_pinned() {
    let mut server = mockito::Server::new_async().await;
    let cfg = vault_pinned(config(), &[IMPL_CODE_V1]);
    install_happy_path_mocks(&mut server, &cfg).await;
    install_proxy_mocks_for(&mut server, VAULT, VAULT_IMPL, VAULT_IMPL_CODE).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let err = Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .unwrap_err();
    match &err {
        RmpcError::ErrImplementationNotApproved { proxy, reason, .. } => {
            assert_eq!(proxy, &format!("vault {VAULT:#x}"));
            assert!(reason.contains("proxy_implementation_hashes"), "{reason}");
        }
        other => panic!("expected ErrImplementationNotApproved, got {other:?}"),
    }
    let c = ChecksOutput::from_err_partial(&err);
    assert!(c.gateway_implementation_approved, "the gateway passed 2b");
    assert!(
        c.gateway_implementation.is_none(),
        "a vault is not the gateway"
    );
}

#[tokio::test]
async fn deposit_passes_with_the_vault_implementation_pinned() {
    let mut server = mockito::Server::new_async().await;
    let cfg = vault_pinned(config(), &[VAULT_IMPL_CODE]);
    install_happy_path_mocks(&mut server, &cfg).await;
    let (storage, code) =
        install_proxy_mocks_for(&mut server, VAULT, VAULT_IMPL, VAULT_IMPL_CODE).await;

    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    Preflight::new(&rpc, &cfg)
        .run(inputs(100))
        .await
        .expect("a pinned vault implementation passes");
    storage.assert_async().await;
    code.assert_async().await;
}

#[tokio::test]
async fn withdraw_vault_refuses_a_proxied_vault_without_a_pin() {
    let mut server = mockito::Server::new_async().await;
    install_vault_mocks(&mut server, U256::from(u128::MAX), U256::from(u128::MAX)).await;
    install_proxy_mocks_for(&mut server, VAULT, VAULT_IMPL, VAULT_IMPL_CODE).await;
    let rpc = FailoverRpcClient::new(vec![server.url()]).unwrap();
    let cfg = config();
    let err = Preflight::new(&rpc, &cfg)
        .run_withdraw_vault(VAULT, GATEWAY, SIGNER, U256::from(100u64))
        .await
        .unwrap_err();
    match err {
        RmpcError::ErrImplementationNotApproved { reason, .. } => {
            assert!(reason.contains("not set"), "{reason}")
        }
        other => panic!("expected ErrImplementationNotApproved, got {other:?}"),
    }
}
