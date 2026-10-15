//! Canonical: none — integration tests for `rmpc withdraw`
//!
//! End-to-end coverage for `rmpc withdraw` (issue #1285).
//!
//! `withdraw` is one of the two largest and most safety-critical command
//! modules and had **no** end-to-end coverage: the only integration
//! references were parser-level (`tests/cli.rs`), and the in-module
//! `#[cfg(test)]` block never called `run()`. The cause was structural —
//! `run()` read process-global env, took a filesystem lock, built its own
//! runtime and printed to stdout, so the only usable seam is spawning the
//! binary. This suite uses that seam, mirroring `cli_deposit.rs`.
//!
//! Covered here: the refusal, fee-cap, concurrent-lock, receipt-timeout
//! and revert paths, plus the happy path, the replay-cache refusal, and
//! the vault-side share checks that are specific to a redemption.
//!
//! QA plan D9 (finding E8, SR-M16): on a gateway with a router the command
//! signs a one-leg `withdrawFromRouter` carrying a `minAssetsPerLeg` floor,
//! never `gateway.withdraw` (→ `vault.redeem`, no min-out). The default
//! floor is `previewRedeem(shares)` less 0.50%. A gateway without a router
//! redeems through `gateway.withdraw` only for `--min-assets 0`.
//!
//! CI: run by `suite-07-rmpc-integration.yml`'s `rmpc-parity` job, which
//! names this binary explicitly with `--test cli_withdraw`. `cargo test
//! --lib` (suite 6) does not build it.

mod common;

use crate::common::{
    enc_address, enc_bool, enc_u256, install_gateway_implementation, install_happy_path_mocks,
    install_withdraw_preflight_mocks, jrpc_result, jrpc_result_raw, match_eth_call_selector,
    selector_hex_of, Fixture, ASSET_RECIPIENT, GATEWAY, SHARE_RECEIVER, SIGNER_ADDRESS,
    TEST_PASSPHRASE, VAULT,
};
use alloy_primitives::{
    address, b256, hex as ahex, keccak256, Address, Bytes, LogData, B256, U256,
};
use alloy_sol_types::{SolCall, SolEvent};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::{Erc20, RobotMoneyGateway};
use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

const ORDER_ID: B256 = b256!("1111111111111111111111111111111111111111111111111111111111111111");
const IDEMPOTENCY_KEY: B256 =
    b256!("2222222222222222222222222222222222222222222222222222222222222222");
const PAYMENT_ID: B256 = b256!("3333333333333333333333333333333333333333333333333333333333333333");
const TX_HASH: B256 = b256!("4444444444444444444444444444444444444444444444444444444444444444");

const SHARES: u64 = 500_000;
const ASSETS_OUT: u64 = 499_000;
/// `vault.previewRedeem(SHARES)` in the mocks.
const PREVIEW_REDEEM: u64 = 499_000;
/// PREVIEW_REDEEM less 0.50%: 499_000 * 9_950 / 10_000.
const DEFAULT_FLOOR: u64 = 496_505;
/// `gateway.router()` in the mocks.
const ROUTER: Address = address!("0000000000000000000000000000000000000a11");
/// `chain_deadline`: the mocked block timestamp 0x64a9f4c0 plus the default
/// 300 s horizon.
const DEADLINE: u64 = 0x64a9_f4c0 + 300;

/// base fees 1 gwei, rewards 1 gwei → maxFee = 2*1 + 1 = 3 gwei, well
/// under the 100 gwei cap baked into `Fixture`'s TOML.
fn fee_history_body() -> String {
    r#"{
        "oldestBlock":"0x1",
        "baseFeePerGas":["0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00"],
        "gasUsedRatio":[0.5,0.5,0.5,0.5,0.5],
        "reward":[["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"]]
    }"#
    .to_string()
}

/// A receipt carrying the `AgentWithdrawalRouted` log the gateway emits for
/// the one-leg router redemption (QA plan D9).
fn receipt_with_routed_withdrawal_body(shares: U256, assets_out: U256) -> String {
    let ev = RobotMoneyGateway::AgentWithdrawalRouted {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        agent: SIGNER_ADDRESS,
        router: ROUTER,
        shareHolder: SHARE_RECEIVER,
        sharesPerLeg: vec![shares],
        assetsPerLeg: vec![assets_out],
        assetRecipient: ASSET_RECIPIENT,
        windowId: 42u64,
    };
    let topics = ev.encode_topics();
    receipt_with_log_body(LogData::new_unchecked(
        topics.iter().map(|t| B256::from(t.0)).collect(),
        Bytes::from(ev.encode_data()),
    ))
}

/// A receipt carrying the `AgentWithdrawal` log `gateway.withdraw` emits
/// (single-vault mode, `--min-assets 0`).
fn receipt_with_agent_withdrawal_body(shares: U256, assets_out: U256) -> String {
    let ev = RobotMoneyGateway::AgentWithdrawal {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        agent: SIGNER_ADDRESS,
        sourceVault: VAULT,
        shares,
        assetsOut: assets_out,
        assetRecipient: ASSET_RECIPIENT,
        windowId: 42u64,
    };
    let topics = ev.encode_topics();
    receipt_with_log_body(LogData::new_unchecked(
        topics.iter().map(|t| B256::from(t.0)).collect(),
        Bytes::from(ev.encode_data()),
    ))
}

/// A mined, successful receipt with one gateway log.
fn receipt_with_log_body(log: LogData) -> String {
    let topics_hex: Vec<String> = log
        .topics()
        .iter()
        .map(|t| format!("\"0x{}\"", ahex::encode(t.as_slice())))
        .collect();
    let data_hex = format!("0x{}", ahex::encode(log.data.as_ref()));

    format!(
        r#"{{
            "transactionHash":"{TX_HASH:#x}",
            "transactionIndex":"0x0",
            "blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001",
            "blockNumber":"0x42",
            "from":"{SIGNER_ADDRESS:#x}",
            "to":"{GATEWAY:#x}",
            "cumulativeGasUsed":"0x5208",
            "gasUsed":"0x5208",
            "contractAddress":null,
            "logs":[{{
                "address":"{GATEWAY:#x}",
                "topics":[{topics}],
                "data":"{data_hex}",
                "blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001",
                "blockNumber":"0x42",
                "transactionHash":"{TX_HASH:#x}",
                "transactionIndex":"0x0",
                "logIndex":"0x0",
                "removed":false
            }}],
            "status":"0x1",
            "logsBloom":"0x{bloom}",
            "type":"0x2",
            "effectiveGasPrice":"0x3b9aca00"
        }}"#,
        topics = topics_hex.join(","),
        bloom = "00".repeat(256),
    )
}

/// Receipt with `status: 0x0` — mined but reverted.
fn reverted_receipt_body() -> String {
    format!(
        r#"{{
            "transactionHash":"{TX_HASH:#x}",
            "transactionIndex":"0x0",
            "blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001",
            "blockNumber":"0x42",
            "from":"{SIGNER_ADDRESS:#x}",
            "to":"{GATEWAY:#x}",
            "cumulativeGasUsed":"0x5208",
            "gasUsed":"0x5208",
            "contractAddress":null,
            "logs":[],
            "status":"0x0",
            "logsBloom":"0x{bloom}",
            "type":"0x2",
            "effectiveGasPrice":"0x3b9aca00"
        }}"#,
        bloom = "00".repeat(256),
    )
}

async fn install_post_preflight_mocks(server: &mut mockito::ServerGuard, receipt_body: &str) {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_feeHistory"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&fee_history_body()))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionCount"}),
        ))
        .with_status(200)
        .with_body(jrpc_result("0x7"))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(receipt_body))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// The full happy-path mock set for a withdrawal: the shared preflight
/// set, then the withdraw-specific reads that must override it (see
/// `install_withdraw_preflight_mocks` on ordering), then the
/// post-preflight chain writes.
async fn install_withdraw_happy_path(server: &mut mockito::ServerGuard, chain_id: u64) {
    install_withdraw_happy_path_with_caps(server, chain_id, U256::from(u128::MAX)).await;
}

/// As above, with the agent's `maxWithdrawPerPayment` under test control.
async fn install_withdraw_happy_path_with_caps(
    server: &mut mockito::ServerGuard,
    chain_id: u64,
    max_withdraw_per_payment: U256,
) {
    install_withdraw_mocks(
        server,
        chain_id,
        max_withdraw_per_payment,
        ROUTER,
        &receipt_with_routed_withdrawal_body(U256::from(SHARES), U256::from(ASSETS_OUT)),
    )
    .await;
}

/// Every mock a withdrawal reads or writes, for a gateway whose `router()`
/// is `router` and a receipt carrying `receipt_body`.
async fn install_withdraw_mocks(
    server: &mut mockito::ServerGuard,
    chain_id: u64,
    max_withdraw_per_payment: U256,
    router: Address,
    receipt_body: &str,
) {
    install_happy_path_mocks(server, chain_id, SIGNER_ADDRESS).await;
    install_withdraw_preflight_mocks(
        server,
        max_withdraw_per_payment,
        U256::from(u128::MAX),
        U256::ZERO,
    )
    .await;
    install_route_mocks(server, router).await;
    install_post_preflight_mocks(server, receipt_body).await;
}

/// `previewRedeem(uint256)` selector, 0x-prefixed. The rmpc `IVault` binding
/// does not carry the function.
fn preview_redeem_selector() -> String {
    format!(
        "0x{}",
        ahex::encode(&keccak256(b"previewRedeem(uint256)")[..4])
    )
}

/// The two reads that choose the route and its default floor (QA plan D9):
/// `gateway.router()` and the source vault's `previewRedeem(shares)`.
async fn install_route_mocks(server: &mut mockito::ServerGuard, router: Address) {
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::routerCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(router)))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&preview_redeem_selector()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(PREVIEW_REDEEM))))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// A mock that answers the pre-sign simulation of exactly `calldata` (an
/// `eth_call` to the gateway carrying it) and must be hit once. The
/// simulated calldata is the calldata the command signs (`write_path`).
async fn expect_simulation_of(server: &mut mockito::ServerGuard, calldata: &[u8]) -> mockito::Mock {
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_call"})),
            Matcher::Regex(format!(r#""data":"0x{}""#, ahex::encode(calldata))),
        ]))
        .with_status(200)
        .with_body(jrpc_result("0x"))
        .expect(1)
        .create_async()
        .await
}

fn unique_state_dir() -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "rmpc-withdraw-test-{stamp}-{}-{seq}",
        std::process::id()
    ))
}

/// The argument vector every test below varies from.
fn withdraw_args<'a>(config_path: &'a str, state_dir: &'a std::path::Path) -> Command {
    let mut cmd = rmpc();
    cmd.env(
        PASSPHRASE_ENV_VAR,
        std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
    )
    .env("RMPC_STATE_DIR", state_dir)
    .args([
        "withdraw",
        "--config",
        config_path,
        "--shares",
        &SHARES.to_string(),
        "--source-vault",
        &format!("{VAULT:#x}"),
        "--order-id",
        &format!("{ORDER_ID:#x}"),
        "--idempotency-key",
        &format!("{IDEMPOTENCY_KEY:#x}"),
    ]);
    cmd
}

#[tokio::test]
async fn withdraw_happy_path_emits_payment_id_and_exits_zero() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--receipt-timeout-secs", "5"])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim())
        .expect("stdout is JSON");
    assert_eq!(v["status"], "success");
    assert_eq!(v["payment_id"], format!("{PAYMENT_ID:#x}"));
    assert_eq!(v["order_id"], format!("{ORDER_ID:#x}"));
    assert_eq!(
        v["agent"].as_str().unwrap().to_lowercase(),
        format!("{SIGNER_ADDRESS:#x}")
    );
    assert_eq!(
        v["asset_recipient"].as_str().unwrap().to_lowercase(),
        format!("{ASSET_RECIPIENT:#x}")
    );
    assert_eq!(
        v["source_vault"].as_str().unwrap().to_lowercase(),
        format!("{VAULT:#x}")
    );
    assert_eq!(v["shares"], SHARES.to_string());
    assert_eq!(v["assets_out"], ASSETS_OUT.to_string());
    // QA plan D9: the router route, with the default floor, from the
    // policy's shareReceiver.
    assert_eq!(v["route"], "router");
    assert_eq!(v["min_assets"], DEFAULT_FLOOR.to_string());
    assert_eq!(
        v["share_holder"].as_str().unwrap().to_lowercase(),
        format!("{SHARE_RECEIVER:#x}")
    );
    assert_eq!(v["block_number"], 0x42);
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
    assert!(v["gas_used"].is_string());
    assert!(v["effective_gas_price"].is_string());
}

/// QA plan D9 (finding E8, SR-M16): `gateway.withdraw` → `vault.redeem` has
/// no min-out. With a router on the gateway, `rmpc withdraw` simulates and
/// signs the one-leg `withdrawFromRouter([vault], [shares],
/// [previewRedeem less 0.50%])` instead, and never `gateway.withdraw`.
#[tokio::test]
async fn withdraw_signs_withdraw_from_router_with_the_preview_redeem_floor() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;
    let expected = RobotMoneyGateway::withdrawFromRouterCall {
        orderId: ORDER_ID,
        vaults: vec![VAULT],
        sharesPerLeg: vec![U256::from(SHARES)],
        minAssetsPerLeg: vec![U256::from(DEFAULT_FLOOR)],
        deadline: DEADLINE,
        idempotencyKey: IDEMPOTENCY_KEY,
    }
    .abi_encode();
    let simulated = expect_simulation_of(&mut server, &expected).await;
    let direct = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::withdrawCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result("0x"))
        .expect(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();
    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--receipt-timeout-secs", "5"])
        .assert()
        .success()
        .get_output()
        .clone();

    simulated.assert_async().await;
    direct.assert_async().await;
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["route"], "router");
    assert_eq!(v["min_assets"], DEFAULT_FLOOR.to_string());
}

/// An explicit `--min-assets` is the floor the router call carries.
#[tokio::test]
async fn withdraw_min_assets_flag_sets_the_router_floor() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;
    let expected = RobotMoneyGateway::withdrawFromRouterCall {
        orderId: ORDER_ID,
        vaults: vec![VAULT],
        sharesPerLeg: vec![U256::from(SHARES)],
        minAssetsPerLeg: vec![U256::from(498_000u64)],
        deadline: DEADLINE,
        idempotencyKey: IDEMPOTENCY_KEY,
    }
    .abi_encode();
    let simulated = expect_simulation_of(&mut server, &expected).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();
    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--min-assets", "498000", "--receipt-timeout-secs", "5"])
        .assert()
        .success()
        .get_output()
        .clone();

    simulated.assert_async().await;
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["min_assets"], "498000");
}

/// A gateway without a router (single-vault mode) can only sign
/// `gateway.withdraw`, which has no floor. Without `--min-assets 0` the
/// command refuses before signing.
#[tokio::test]
async fn withdraw_without_router_refuses_unless_the_floor_is_explicitly_zero() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_mocks(
        &mut server,
        chain_id,
        U256::from(u128::MAX),
        Address::ZERO,
        &receipt_with_agent_withdrawal_body(U256::from(SHARES), U256::from(ASSETS_OUT)),
    )
    .await;
    let broadcast = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = withdraw_args(fix.config_path.to_str().unwrap(), &unique_state_dir())
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrConfig");
    assert!(v["message"].as_str().unwrap().contains("--min-assets 0"));
    broadcast.assert_async().await;
}

/// With `--min-assets 0` a single-vault-mode gateway redeems through
/// `gateway.withdraw`, from the agent's own shares, and says it had no floor.
#[tokio::test]
async fn withdraw_without_router_and_a_zero_floor_signs_gateway_withdraw() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_mocks(
        &mut server,
        chain_id,
        U256::from(u128::MAX),
        Address::ZERO,
        &receipt_with_agent_withdrawal_body(U256::from(SHARES), U256::from(ASSETS_OUT)),
    )
    .await;
    let expected = RobotMoneyGateway::withdrawCall {
        orderId: ORDER_ID,
        shares: U256::from(SHARES),
        sourceVault: VAULT,
        deadline: DEADLINE,
        idempotencyKey: IDEMPOTENCY_KEY,
    }
    .abi_encode();
    let simulated = expect_simulation_of(&mut server, &expected).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = withdraw_args(fix.config_path.to_str().unwrap(), &unique_state_dir())
        .args(["--min-assets", "0", "--receipt-timeout-secs", "5"])
        .assert()
        .success()
        .get_output()
        .clone();

    simulated.assert_async().await;
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["route"], "vault");
    assert_eq!(v["min_assets"], "0");
    assert_eq!(
        v["share_holder"].as_str().unwrap().to_lowercase(),
        format!("{SIGNER_ADDRESS:#x}")
    );
    assert_eq!(v["assets_out"], ASSETS_OUT.to_string());
}

/// A `--gas-limit` under the router call's gateway floor (2_250_000) is
/// refused before signing.
#[tokio::test]
async fn withdraw_gas_limit_below_the_router_floor_refuses() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = withdraw_args(fix.config_path.to_str().unwrap(), &unique_state_dir())
        .args(["--gas-limit", "2100000"])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrGasLimitBelowFloor");
}

/// ADR-0014 (security round 1): `withdrawFromRouter` makes the gateway approve
/// the router for the share receiver's shares and call its `redeemFor`. The
/// router is a proxy, so a plain `rmpc withdraw` must check its implementation
/// as `withdraw-router` does: an implementation whose code hash is not in
/// `proxy_implementation_hashes` refuses before anything is simulated, signed
/// or broadcast, even though the router proxy's own code is unchanged.
#[tokio::test]
async fn withdraw_refuses_a_router_whose_implementation_is_not_pinned() {
    let implementation = address!("00000000000000000000000000000000000001a2");
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;
    // gateway.router() is ROUTER (install_route_mocks). Its ERC-1967 slot
    // names `implementation`, whose code nobody pinned.
    let slot = server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getStorageAt"})),
            Matcher::Regex(format!(r#"(?i)"params":\["{ROUTER:#x}""#)),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&format!(
            "0x{}",
            common::abi_addr_hex(implementation)
        )))
        .expect_at_least(1)
        .create_async()
        .await;
    let _impl_code = server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getCode"})),
            Matcher::Regex(format!(r#"(?i)"params":\["{implementation:#x}""#)),
        ]))
        .with_status(200)
        .with_body(jrpc_result("0x6001fe"))
        .expect_at_least(1)
        .create_async()
        .await;
    let simulated = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::withdrawFromRouterCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result("0x"))
        .expect(0)
        .create_async()
        .await;
    let broadcast = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    // Pin some other reviewed implementation: the live one is not it.
    let config = std::fs::read_to_string(&fix.config_path).unwrap().replacen(
        "[signer]",
        &format!(
            "proxy_implementation_hashes = [\"{:#x}\"]\n\n[signer]",
            keccak256(b"a reviewed router implementation")
        ),
        1,
    );
    std::fs::write(&fix.config_path, config).unwrap();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &unique_state_dir())
        .args(["--receipt-timeout-secs", "5"])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(
        out.status.code(),
        Some(2),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["status"], "refused");
    assert_eq!(v["error"], "ErrImplementationNotApproved");
    let message = v["message"].as_str().unwrap().to_lowercase();
    assert!(message.contains(&format!("router {ROUTER:#x}")), "{v}");
    assert!(message.contains(&format!("{implementation:#x}")), "{v}");
    assert!(
        message.contains("not in proxy_implementation_hashes"),
        "{v}"
    );
    slot.assert_async().await;
    simulated.assert_async().await;
    broadcast.assert_async().await;
}

/// Owner decision 2026-10-06: the software keystore is allowed on Base
/// mainnet; the production warning prints before the keystore is loaded.
#[test]
fn withdraw_base_mainnet_allows_software_signer_and_warns_first() {
    let logs = tempfile::TempDir::new().unwrap();
    let fix = Fixture::build("http://127.0.0.1:1", 8453);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .env("RMPC_LOG_DIR", logs.path())
        .env_remove(PASSPHRASE_ENV_VAR)
        .assert()
        .failure()
        .get_output()
        .clone();

    assert_eq!(out.status.code(), Some(3));
    assert!(!String::from_utf8(out.stdout.clone())
        .unwrap()
        .contains("ErrProductionSignerRequired"));
    common::assert_mainnet_warning_precedes_keystore_load(logs.path());
}

/// Refusal path: the preflight's chain-id pin. The `checks` snapshot must
/// come along so operators can correlate with `rmpc self-check`.
#[tokio::test]
async fn withdraw_chain_id_mismatch_refuses_with_named_error() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result("0x1"))
        .create_async()
        .await;
    install_withdraw_happy_path(&mut server, chain_id).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["status"], "refused");
    assert_eq!(v["error"], "ErrChainIdMismatch");
    assert_eq!(v["checks"]["chain_id_match"], false);
}

/// A deposit pause never blocks a withdrawal (core 1494). With
/// `depositsPaused() == true` on every target (gateway and vault share the
/// selector) the withdrawal still signs, broadcasts and succeeds.
#[tokio::test]
async fn withdraw_succeeds_while_deposits_paused() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;
    // Registered last with `expect_at_least`, so it serves every
    // depositsPaused() read ahead of the happy-path `false`.
    let paused_read = server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::depositsPausedCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_bool(true)))
        .expect_at_least(1)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--receipt-timeout-secs", "5"])
        .assert()
        .success()
        .get_output()
        .clone();
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["status"], "success");
    assert_eq!(v["assets_out"], ASSETS_OUT.to_string());
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
    // The preflight did observe the pause; it just never refuses on it.
    paused_read.assert_async().await;
}

/// Refusal path: the withdrawal-specific policy cap. Issue #371 —
/// `withdraw` must check `maxWithdrawPerPayment`, not the deposit caps.
#[tokio::test]
async fn withdraw_over_policy_cap_refuses_before_signing() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    // maxWithdrawPerPayment one share below the requested amount.
    install_withdraw_happy_path_with_caps(&mut server, chain_id, U256::from(SHARES - 1)).await;
    let broadcast_mock = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    // QA plan U6: a cap breach is `ErrWithdrawCapExceeded`, not `ErrConfig`.
    assert_eq!(v["error"], "ErrWithdrawCapExceeded");
    assert!(v["message"]
        .as_str()
        .unwrap()
        .contains("maxWithdrawPerPayment"));
    broadcast_mock.assert_async().await;
}

/// Refusal path: the vault-side share allowance. A redemption burns the
/// share holder's vault shares (the policy's `shareReceiver` on the router
/// route), which the gateway pulls from the source vault, so an unapproved
/// gateway is refused client-side rather than on chain.
#[tokio::test]
async fn withdraw_insufficient_share_allowance_refuses() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            Erc20::allowanceCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u256(U256::from(1u64))))
        .create_async()
        .await;
    install_withdraw_happy_path(&mut server, chain_id).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrShareAllowanceInsufficient");
    // The vault check runs after the gateway preflight, so the full
    // snapshot is available.
    assert_eq!(v["checks"]["deposits_paused"], false);
}

/// Fee-cap path: a bid above the operator's cap is a refusal, not a
/// silently-more-expensive transaction.
#[tokio::test]
async fn withdraw_fee_cap_exceeded_refuses() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_withdraw_preflight_mocks(
        &mut server,
        U256::from(u128::MAX),
        U256::from(u128::MAX),
        U256::ZERO,
    )
    .await;
    // base fee 10_000 gwei — far above the 100 gwei cap in Fixture's TOML.
    let huge_fee_history = r#"{
        "oldestBlock":"0x1",
        "baseFeePerGas":["0x9184e72a000","0x9184e72a000","0x9184e72a000","0x9184e72a000","0x9184e72a000","0x9184e72a000"],
        "gasUsedRatio":[0.5,0.5,0.5,0.5,0.5],
        "reward":[["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"]]
    }"#;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_feeHistory"})))
        .with_status(200)
        .with_body(jrpc_result_raw(huge_fee_history))
        .create_async()
        .await;
    install_route_mocks(&mut server, ROUTER).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_routed_withdrawal_body(U256::from(SHARES), U256::from(ASSETS_OUT)),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrFeeCapExceeded");
    // Fee-cap refusals happen after preflight, so they carry the snapshot.
    assert!(v["checks"].is_object());
}

/// Concurrent-lock path: the single-flight CLI lock. A second invocation
/// while one holds the agent lock must refuse, not queue or race.
#[tokio::test]
async fn withdraw_concurrent_invocation_locked() {
    use rust_payment_client::nonce::AgentLock;
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let held = AgentLock::acquire(&state_dir, &SIGNER_ADDRESS).expect("held");

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrConcurrentInvocation");
    assert_eq!(
        v["agent"].as_str().unwrap().to_lowercase(),
        format!("{SIGNER_ADDRESS:#x}")
    );
    drop(held);
}

/// Receipt-timeout path (AZ-RPC-1): timeout ≠ failure. The refusal must
/// surface the broadcast `tx_hash` so the operator can inspect it, and the
/// replay-cache entry must survive so a retry is refused rather than
/// broadcasting a second transaction for the same paymentId.
#[tokio::test]
async fn withdraw_receipt_timeout_refuses_and_keeps_the_replay_entry() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(r#"{"jsonrpc":"2.0","id":1,"result":null}"#)
        .expect_at_least(1)
        .create_async()
        .await;
    install_withdraw_happy_path(&mut server, chain_id).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--receipt-timeout-secs", "1"])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrRpcTransport");
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));

    let cache_file = state_dir.join("submitted_order_ids.json");
    let parsed: Value =
        serde_json::from_str(&std::fs::read_to_string(&cache_file).unwrap()).unwrap();
    assert_eq!(
        parsed["entries"].as_array().unwrap().len(),
        1,
        "a receipt timeout must NOT drop the replay entry (AZ-RPC-1)",
    );
}

/// Revert path (AZ-RPC-2): a confirmed on-chain failure means nothing was
/// recorded, so the optimistic replay entry is removed and the operator
/// can retry the same order.
#[tokio::test]
async fn withdraw_reverted_tx_emits_err_tx_reverted_and_clears_the_replay_entry() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_withdraw_preflight_mocks(
        &mut server,
        U256::from(u128::MAX),
        U256::from(u128::MAX),
        U256::ZERO,
    )
    .await;
    install_route_mocks(&mut server, ROUTER).await;
    install_post_preflight_mocks(&mut server, &reverted_receipt_body()).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--receipt-timeout-secs", "5"])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrTxReverted");
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));

    let cache_file = state_dir.join("submitted_order_ids.json");
    let parsed: Value =
        serde_json::from_str(&std::fs::read_to_string(&cache_file).unwrap()).unwrap();
    assert!(
        parsed["entries"].as_array().unwrap().is_empty(),
        "a confirmed revert must clear the optimistic replay entry (AZ-RPC-2)",
    );
}

/// Replay path: the same (chain_id, gateway, agent, order_id, shares,
/// idempotency_key) tuple must be refused locally, before signing.
#[tokio::test]
async fn withdraw_duplicate_retry_refused_before_broadcast() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out1 = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--receipt-timeout-secs", "5"])
        .assert()
        .success()
        .get_output()
        .clone();
    let v1: Value = serde_json::from_str(String::from_utf8(out1.stdout).unwrap().trim()).unwrap();
    let prior_tx = v1["tx_hash"].as_str().unwrap().to_string();

    let out2 = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--receipt-timeout-secs", "5"])
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out2.status.code(), Some(2));
    let v2: Value = serde_json::from_str(String::from_utf8(out2.stdout).unwrap().trim()).unwrap();
    assert_eq!(v2["status"], "refused");
    assert_eq!(v2["error"], "ErrOrderIdAlreadySubmitted");
    assert_eq!(v2["tx_hash"].as_str().unwrap(), prior_tx.as_str());
}

/// AC: the refusal JSON field set emitted by deposit, withdraw and
/// withdraw-router must be identical — one shape owned by `write_path`,
/// not three structs that happen to agree (issue #1285).
///
/// Compared on the `ErrSoftwareSignerDisallowed` refusal, because it is
/// the one refusal all three reach with no chain reads at all, so the
/// three documents are directly comparable.
#[test]
fn refusal_field_set_is_identical_across_the_three_write_commands() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    let cfg_text = std::fs::read_to_string(&fix.config_path).unwrap();
    std::fs::write(
        &fix.config_path,
        cfg_text.replace(
            "allow_software_fallback = true",
            "allow_software_fallback = false",
        ),
    )
    .unwrap();
    let config = fix.config_path.to_str().unwrap().to_string();

    let run = |extra: &[&str]| -> Vec<String> {
        let out = rmpc()
            .env(
                PASSPHRASE_ENV_VAR,
                std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
            )
            .env("RMPC_STATE_DIR", unique_state_dir())
            .args(extra)
            .assert()
            .failure()
            .get_output()
            .clone();
        assert_eq!(out.status.code(), Some(2));
        let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim())
            .expect("stdout is JSON");
        assert_eq!(v["error"], "ErrSoftwareSignerDisallowed");
        let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    };

    let order = format!("{ORDER_ID:#x}");
    let vault = format!("{VAULT:#x}");
    let deposit = run(&[
        "deposit",
        "--config",
        &config,
        "--amount",
        "1000",
        "--order-id",
        &order,
    ]);
    let withdraw = run(&[
        "withdraw",
        "--config",
        &config,
        "--shares",
        "1000",
        "--source-vault",
        &vault,
        "--order-id",
        &order,
    ]);
    let router = run(&[
        "withdraw-router",
        "--config",
        &config,
        "--shares-per-leg",
        "1000",
        "--vaults",
        &vault,
        // A router redemption must name its floors before it reaches the signer (QA plan D9). A single
        // 0 is the explicit "no floor", so the command goes on to the signer refusal this test compares.
        "--min-assets-per-leg",
        "0",
        "--order-id",
        &order,
    ]);

    assert_eq!(
        deposit, withdraw,
        "deposit and withdraw must emit the same refusal field set",
    );
    assert_eq!(
        deposit, router,
        "deposit and withdraw-router must emit the same refusal field set",
    );
    assert_eq!(deposit, ["error", "message", "order_id", "status"]);
}

/// Issue 1810: a redemption through the gateway proxy verifies the live
/// implementation too. The proxy code (and its pinned hash) is unchanged and
/// the approved implementation is configured, but the slot names another one.
/// A withdrawal is refused like a deposit, before anything is signed.
#[tokio::test]
async fn withdraw_refuses_an_unapproved_gateway_implementation() {
    use alloy_primitives::{address, Address};
    const IMPL_A: Address = address!("00000000000000000000000000000000000a11ce");
    const IMPL_B: Address = address!("00000000000000000000000000000000000b0b00");
    const IMPL_A_CODE: &[u8] = &[0x60, 0x01, 0xaa];
    const IMPL_B_CODE: &[u8] = &[0x60, 0x01, 0xbb];

    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;
    install_gateway_implementation(&mut server, IMPL_B, IMPL_B_CODE, None).await;

    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL_A, IMPL_A_CODE);
    let state_dir = unique_state_dir();
    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .assert()
        .failure()
        .get_output()
        .clone();
    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["error"], "ErrImplementationNotApproved");
    assert!(v["tx_hash"].is_null(), "nothing was sent: {v}");
}

/// The approved implementation lets the same redemption through.
#[tokio::test]
async fn withdraw_succeeds_under_the_approved_gateway_implementation() {
    use alloy_primitives::{address, Address};
    const IMPL_A: Address = address!("00000000000000000000000000000000000a11ce");
    const IMPL_A_CODE: &[u8] = &[0x60, 0x01, 0xaa];

    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_withdraw_happy_path(&mut server, chain_id).await;
    install_gateway_implementation(&mut server, IMPL_A, IMPL_A_CODE, None).await;

    let fix = Fixture::build_proxied(&server.url(), chain_id, IMPL_A, IMPL_A_CODE);
    let state_dir = unique_state_dir();
    let out = withdraw_args(fix.config_path.to_str().unwrap(), &state_dir)
        .args(["--receipt-timeout-secs", "5"])
        .assert()
        .success()
        .get_output()
        .clone();
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim()).unwrap();
    assert_eq!(v["status"], "success");
}
