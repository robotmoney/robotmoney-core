//! Canonical: none — integration tests for `rmpc deposit --destination`
//!
//! Integration tests for the router-deposit path added in issue #649.
//!
//! The happy-path test wires a mockito server with the full preflight
//! response set + fee / nonce / broadcast / receipt mocks (carrying a
//! synthetic `AgentDepositRouted` log, the event the gateway emits on the
//! router path), invokes the binary with `--destination <router>` and
//! `--min-shares-per-leg 0`, and asserts exit code 0 plus a non-zero
//! `payment_id` in stdout.
//!
//! QA plan U3: the router path reads `gateway.router()` and
//! `router.getEffectiveWeights()` to size the gas limit from the gateway's
//! entry floor (400_000 + 1_850_000 per leg). The gas tests decode the
//! broadcast envelope and check the refusal of a `--gas-limit` below the
//! floor. The real-EVM twin is `deposit_router_default_gas_clears_gateway_floor`
//! in `testing/fork-e2e-rust/tests/router.rs`.

mod common;

use crate::common::{
    enc_address, install_happy_path_mocks, jrpc_result, jrpc_result_raw, match_eth_call_selector,
    selector_hex_of, Fixture, GATEWAY, SHARE_RECEIVER, SIGNER_ADDRESS, TEST_PASSPHRASE,
};
use alloy_consensus::TxEnvelope;
use alloy_primitives::{address, b256, hex as ahex, Address, Bytes, LogData, B256, U256};
use alloy_rlp::Decodable;
use alloy_sol_types::{SolCall, SolEvent};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::commands::deposit::{router_deposit_gas_floor, DepositGas};
use rust_payment_client::gateway::{PortfolioRouter, RobotMoneyGateway};
use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// A PortfolioRouter address used as the `--destination` in tests.
const ROUTER: Address = address!("0000000000000000000000000000000000000e00");

const ORDER_ID: B256 = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const PAYMENT_ID: B256 = b256!("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
const TX_HASH: B256 = b256!("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");

fn fee_history_body() -> String {
    r#"{
        "oldestBlock":"0x1",
        "baseFeePerGas":["0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00"],
        "gasUsedRatio":[0.5,0.5,0.5,0.5,0.5],
        "reward":[["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"]]
    }"#
    .to_string()
}

/// Build a receipt body carrying an `AgentDeposit` event log, identical in
/// structure to the one used in the single-vault deposit tests.
fn receipt_with_agent_deposit_body(amount: U256, shares: U256) -> String {
    let ev = RobotMoneyGateway::AgentDeposit {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        agent: SIGNER_ADDRESS,
        shareReceiver: SHARE_RECEIVER,
        amount,
        sharesMinted: shares,
        windowId: 1u64,
    };
    receipt_with_event(&ev)
}

/// Build a receipt body carrying the `AgentDepositRouted` log the gateway
/// emits for a router-destination `depositTo`.
fn receipt_with_agent_deposit_routed_body(amount: U256, shares_per_leg: Vec<U256>) -> String {
    let ev = RobotMoneyGateway::AgentDepositRouted {
        paymentId: PAYMENT_ID,
        orderId: ORDER_ID,
        agent: SIGNER_ADDRESS,
        shareReceiver: SHARE_RECEIVER,
        router: ROUTER,
        amount,
        sharesPerLeg: shares_per_leg,
        windowId: 1u64,
    };
    receipt_with_event(&ev)
}

/// A mined, successful receipt whose one log is `ev`, emitted by the gateway.
fn receipt_with_event<E: SolEvent>(ev: &E) -> String {
    let topics = ev.encode_topics();
    let data: Vec<u8> = ev.encode_data();
    let log = LogData::new_unchecked(
        topics.iter().map(|t| B256::from(t.0)).collect(),
        Bytes::from(data),
    );
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
            "blockNumber":"0x10",
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
                "blockNumber":"0x10",
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
        .with_body(jrpc_result("0x1"))
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

/// `gateway.router()` returns [`ROUTER`] and `router.getEffectiveWeights()`
/// returns `legs` legs (equal weights; the gateway counts legs, not bps).
async fn install_router_weight_mocks(server: &mut mockito::ServerGuard, legs: usize) {
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            RobotMoneyGateway::routerCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_address(ROUTER)))
        .expect_at_least(0)
        .create_async()
        .await;
    let vaults: Vec<Address> = (0..legs)
        .map(|i| Address::with_last_byte(0x10 + i as u8))
        .collect();
    let bps: Vec<U256> = vec![U256::from(10_000u64 / legs.max(1) as u64); legs];
    let ret = PortfolioRouter::getEffectiveWeightsCall::abi_encode_returns(&(vaults, bps));
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            PortfolioRouter::getEffectiveWeightsCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{}", ahex::encode(ret))))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// Record every `eth_sendRawTransaction` payload and answer with [`TX_HASH`].
async fn install_recording_broadcast(server: &mut mockito::ServerGuard) -> Arc<Mutex<Vec<String>>> {
    let sent: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = sent.clone();
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body_from_request(move |req| {
            let v: Value = serde_json::from_slice(req.body().unwrap()).unwrap();
            sink.lock()
                .unwrap()
                .push(v["params"][0].as_str().unwrap().to_string());
            jrpc_result(&format!("{TX_HASH:#x}")).into_bytes()
        })
        .create_async()
        .await;
    sent
}

/// The gas limit of a broadcast EIP-1559 envelope.
fn envelope_gas_limit(raw_hex: &str) -> u64 {
    let raw = ahex::decode(raw_hex.trim_start_matches("0x")).expect("raw tx hex");
    match TxEnvelope::decode(&mut raw.as_slice()).expect("valid EIP-2718 envelope") {
        TxEnvelope::Eip1559(signed) => signed.tx().gas_limit,
        other => panic!("expected a type-2 envelope, got {other:?}"),
    }
}

fn router_deposit_cmd(config: &str, state_dir: &std::path::Path, order_id: B256) -> Command {
    let mut cmd = rmpc();
    cmd.env(
        PASSPHRASE_ENV_VAR,
        std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
    )
    .env("RMPC_STATE_DIR", state_dir)
    .args([
        "deposit",
        "--config",
        config,
        "--amount",
        "1000000",
        "--order-id",
        &format!("{order_id:#x}"),
        "--destination",
        &format!("{ROUTER:#x}"),
        "--receipt-timeout-secs",
        "5",
    ]);
    cmd
}

fn unique_state_dir() -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("rmpc-router-test-{stamp}-{}", std::process::id()))
}

/// Happy path: `rmpc deposit --destination <router> --min-shares-per-leg 0`
/// exits 0 and emits a non-empty `payment_id` in stdout JSON, decoded from
/// the `AgentDepositRouted` log (the gateway emits no `AgentDeposit` on the
/// router path).
#[tokio::test]
async fn deposit_router_happy_path_exits_zero_with_payment_id() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(1_000_000u64);
    let shares_per_leg = vec![U256::from(990_000u64)];

    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_router_weight_mocks(&mut server, 1).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_routed_body(amount, shares_per_leg),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            &amount.to_string(),
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--destination",
            &format!("{ROUTER:#x}"),
            "--min-shares-per-leg",
            "0",
            "--receipt-timeout-secs",
            "5",
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    assert_eq!(v["status"], "success");
    // payment_id must be present and non-empty
    let pid = v["payment_id"].as_str().expect("payment_id is string");
    assert!(!pid.is_empty(), "payment_id must be non-empty");
    assert_eq!(pid, format!("{PAYMENT_ID:#x}"));
    assert_eq!(v["order_id"], format!("{ORDER_ID:#x}"));
    assert_eq!(
        v["agent"].as_str().unwrap().to_lowercase(),
        format!("{SIGNER_ADDRESS:#x}")
    );
    assert_eq!(v["amount"], amount.to_string());
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"));
    assert_eq!(v["router"], format!("{ROUTER:#x}"));
    assert_eq!(v["shares_per_leg"], json!(["990000"]));
    // One leg's shares are not a total across vaults: the router path has none.
    assert!(v["shares_minted"].is_null(), "{v}");
}

/// QA plan U3: with no `--gas-limit` the router deposit is signed with the
/// gateway floor for the router's effective leg count plus the margin. Five
/// legs: 400_000 + 5 * 1_850_000 = 9_650_000, sent as 9_800_000. The old
/// fixed 3_000_000 default would revert `InsufficientGas` on chain.
#[tokio::test]
async fn deposit_router_default_gas_derives_from_effective_leg_count() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(1_000_000u64);
    let legs = 5usize;

    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_router_weight_mocks(&mut server, legs).await;
    let sent = install_recording_broadcast(&mut server).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_routed_body(amount, vec![U256::from(200_000u64); legs]),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();
    router_deposit_cmd(fix.config_path.to_str().unwrap(), &state_dir, ORDER_ID)
        .assert()
        .success();

    let raw = sent.lock().unwrap().first().cloned().expect("tx broadcast");
    let gas = envelope_gas_limit(&raw);
    assert_eq!(router_deposit_gas_floor(legs), 9_650_000);
    assert_eq!(gas, DepositGas::router(legs).default_limit);
    assert!(
        gas > router_deposit_gas_floor(legs),
        "default {gas} must clear the gateway floor"
    );
}

/// QA plan U3: a `--gas-limit` under the gateway floor is refused before
/// anything is signed. Four legs need 7_800_000; the old 3_000_000 default
/// is refused with `ErrGasLimitBelowFloor`, exit 2, and no broadcast.
#[tokio::test]
async fn deposit_router_refuses_gas_limit_below_gateway_floor() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;

    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_router_weight_mocks(&mut server, 4).await;
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
    let state_dir = unique_state_dir();
    let out = router_deposit_cmd(fix.config_path.to_str().unwrap(), &state_dir, ORDER_ID)
        .args(["--gas-limit", "3000000"])
        .assert()
        .failure()
        .get_output()
        .clone();

    assert_eq!(out.status.code(), Some(2));
    let v: Value = serde_json::from_str(String::from_utf8(out.stdout).unwrap().trim())
        .expect("stdout is JSON");
    assert_eq!(v["status"], "refused");
    assert_eq!(v["error"], "ErrGasLimitBelowFloor");
    let message = v["message"].as_str().expect("message");
    assert!(message.contains("7800000"), "{message}");
    broadcast.assert_async().await;
}

/// An explicit `--gas-limit` at or above the floor is sent unchanged.
#[tokio::test]
async fn deposit_router_explicit_gas_limit_above_floor_is_used() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(1_000_000u64);

    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_router_weight_mocks(&mut server, 2).await;
    let sent = install_recording_broadcast(&mut server).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_routed_body(amount, vec![U256::from(500_000u64); 2]),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();
    router_deposit_cmd(fix.config_path.to_str().unwrap(), &state_dir, ORDER_ID)
        .args(["--gas-limit", "6000000"])
        .assert()
        .success();

    let raw = sent.lock().unwrap().first().cloned().expect("tx broadcast");
    assert_eq!(envelope_gas_limit(&raw), 6_000_000);
}

/// When `--destination` is omitted the existing single-vault path is used
/// and the binary still exits 0 with a valid `payment_id`. This asserts
/// that the router-deposit branch does not regress the default path.
#[tokio::test]
async fn deposit_without_destination_still_uses_single_vault_path() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let amount = U256::from(500_000u64);
    let shares = U256::from(495_000u64);

    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;
    install_post_preflight_mocks(
        &mut server,
        &receipt_with_agent_deposit_body(amount, shares),
    )
    .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let state_dir = unique_state_dir();

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", &state_dir)
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            &amount.to_string(),
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--receipt-timeout-secs",
            "5",
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("stdout is JSON");
    assert_eq!(v["status"], "success");
    let pid = v["payment_id"].as_str().expect("payment_id is string");
    assert!(!pid.is_empty(), "payment_id must be non-empty");
    assert_eq!(v["shares_minted"], shares.to_string());
    assert!(v.get("router").is_none(), "{v}");
    assert!(v.get("shares_per_leg").is_none(), "{v}");
}

/// An invalid `--destination` address must cause exit code 3 (startup fail),
/// not a panic or silent wrong address.
#[test]
fn deposit_router_bad_destination_exits_startup_fail() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--destination",
            "not-an-address",
        ])
        .assert()
        .failure()
        .get_output()
        .clone();

    // Exit 3 = startup fail (bad flag value).
    assert_eq!(out.status.code(), Some(3));
}

/// An invalid `--min-shares-per-leg` value must cause exit code 3 (startup
/// fail), not a panic.
#[test]
fn deposit_router_bad_min_shares_exits_startup_fail() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);

    let out = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args([
            "deposit",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--amount",
            "1000000",
            "--order-id",
            &format!("{ORDER_ID:#x}"),
            "--destination",
            &format!("{ROUTER:#x}"),
            "--min-shares-per-leg",
            "not-a-number",
        ])
        .assert()
        .failure()
        .get_output()
        .clone();

    // Exit 3 = startup fail (bad flag value).
    assert_eq!(out.status.code(), Some(3));
}
