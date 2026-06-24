//! Canonical: none — integration tests for `rmpc committee`
//! Implements: issue #1044 AC-3 (Test plan item 2)
//!
//! Tests:
//! - `test_committee_register_happy_path`: ADMIN_ROLE registers an agent via
//!   `rmpc committee register`. Asserts the tx is broadcast and a JSON
//!   receipt is printed on stdout.
//! - `test_committee_vote_submit_happy_path`: An allowlisted committee agent
//!   submits a signed allocation vote via `rmpc committee vote-submit`.
//!   Asserts the tx is broadcast and a JSON receipt is printed on stdout.
//! - `test_committee_vote_submit_unauthorized_rejected`: A non-allowlisted
//!   agent attempts to call vote-submit; the JSON-RPC returns a revert and
//!   the command exits non-zero.
//!
//! All three tests mock the JSON-RPC server with mockito. No live chain is
//! required.

mod common;

use crate::common::{jrpc_result, jrpc_result_raw, GATEWAY, SIGNER_ADDRESS, TEST_PASSPHRASE};
use alloy_primitives::{address, b256, hex as ahex, Address, B256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::json;
use std::path::PathBuf;
use tempfile::TempDir;

// ─── Test constants ───────────────────────────────────────────────────────────

/// Use local devnet chain ID so software signer passes the production-grade check.
const CHAIN_ID: u64 = 31337;

/// Fake IC policy contract address for tests.
const IC_POLICY: Address = address!("0000000000000000000000000000000000000e00");

/// Fake committee agent address.
const COMMITTEE_AGENT: Address = address!("0000000000000000000000000000000000000f00");

const TX_HASH: B256 = b256!("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");

const VOTE_JSON_HASH: B256 =
    b256!("abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");

const PROMPT_HASH: B256 = b256!("1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef");

const INPUTS_DIGEST: B256 =
    b256!("fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321");

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/// Build a committee-enabled config TOML in a temp dir.
struct CommitteeFixture {
    _tmp: TempDir,
    pub config_path: PathBuf,
    pub _keystore_path: PathBuf,
}

impl CommitteeFixture {
    fn build(rpc_url: &str) -> Self {
        use alloy_primitives::keccak256;
        use rust_payment_client::signer::software::SoftwareSigner;

        // Reuse the common test private key.
        const TEST_PRIVKEY: [u8; 32] = [
            0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38,
            0xff, 0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b,
            0xf4, 0xf2, 0xff, 0x80,
        ];

        let tmp = TempDir::new().expect("tempdir");
        let keystore_path = tmp.path().join("keystore.json");
        SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
            .expect("create keystore");

        // Minimal gateway_runtime_hash (same as common::GATEWAY_CODE pattern).
        const GATEWAY_CODE: &[u8] = &[0x60, 0x80, 0x60, 0x40, 0x52, 0xfe, 0xfe, 0xfe];
        let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));

        let config_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = {CHAIN_ID}
rpc_url               = "{rpc_url}"
gateway_address       = "{GATEWAY:#x}"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "0x0000000000000000000000000000000000000d00"
ic_policy_address     = "{IC_POLICY:#x}"
gateway_runtime_hash  = "{runtime_hash}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
            ks = keystore_path.display()
        );
        std::fs::write(&config_path, toml).expect("write config");

        Self {
            _tmp: tmp,
            config_path,
            _keystore_path: keystore_path,
        }
    }
}

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// One standard fee_history response.
fn fee_history_body() -> String {
    r#"{
        "oldestBlock":"0x1",
        "baseFeePerGas":["0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00","0x3b9aca00"],
        "gasUsedRatio":[0.5,0.5,0.5,0.5,0.5],
        "reward":[["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"],["0x3b9aca00"]]
    }"#
    .to_string()
}

/// JSON body for eth_getTransactionReceipt (no IC-specific logs needed for these tests).
fn simple_receipt_body() -> String {
    format!(
        r#"{{
            "transactionHash":"{TX_HASH:#x}",
            "transactionIndex":"0x0",
            "blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001",
            "blockNumber":"0x2a",
            "from":"{SIGNER_ADDRESS:#x}",
            "to":"{IC_POLICY:#x}",
            "cumulativeGasUsed":"0x5208",
            "gasUsed":"0x5208",
            "contractAddress":null,
            "logs":[],
            "status":"0x1",
            "logsBloom":"0x{bloom}",
            "type":"0x2",
            "effectiveGasPrice":"0x3b9aca00"
        }}"#,
        bloom = "00".repeat(256),
    )
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_committee_register_happy_path() {
    let mut server = mockito::Server::new_async().await;
    let fix = CommitteeFixture::build(&server.url());

    // eth_chainId
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{CHAIN_ID:x}")))
        .expect_at_least(0)
        .create_async()
        .await;

    // eth_feeHistory
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_feeHistory"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&fee_history_body()))
        .expect(1)
        .create_async()
        .await;

    // eth_getTransactionCount
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionCount"}),
        ))
        .with_status(200)
        .with_body(jrpc_result("0x0"))
        .expect(1)
        .create_async()
        .await;

    // eth_sendRawTransaction
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(1)
        .create_async()
        .await;

    // eth_getTransactionReceipt
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(&simple_receipt_body()))
        .expect_at_least(1)
        .create_async()
        .await;

    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .args([
            "committee",
            "--config",
            fix.config_path.to_str().unwrap(),
            "register",
            "--agent",
            &format!("{COMMITTEE_AGENT:#x}"),
            "--agent-id",
            "athena-v1",
            "--order-id",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ])
        .output()
        .expect("rmpc ran");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("STDOUT: {stdout}");
    eprintln!("STDERR: {stderr}");

    assert!(
        output.status.success(),
        "expected exit 0, got {:?}",
        output.status
    );

    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON");
    assert_eq!(v["ok"], true, "ok field");
    assert_eq!(v["action"], "register", "action field");
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"), "tx_hash field");
    assert_eq!(v["block_number"], 42, "block_number field");
}

#[tokio::test]
async fn test_committee_vote_submit_happy_path() {
    let mut server = mockito::Server::new_async().await;
    let fix = CommitteeFixture::build(&server.url());

    // eth_chainId
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{CHAIN_ID:x}")))
        .expect_at_least(0)
        .create_async()
        .await;

    // eth_feeHistory
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_feeHistory"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&fee_history_body()))
        .expect(1)
        .create_async()
        .await;

    // eth_getTransactionCount
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionCount"}),
        ))
        .with_status(200)
        .with_body(jrpc_result("0x1"))
        .expect(1)
        .create_async()
        .await;

    // eth_sendRawTransaction
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(1)
        .create_async()
        .await;

    // eth_getTransactionReceipt
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(&simple_receipt_body()))
        .expect_at_least(1)
        .create_async()
        .await;

    let vault_addr = "0x1111111111111111111111111111111111111111";
    let vote_hash = format!("{VOTE_JSON_HASH:#x}");
    let prompt = format!("{PROMPT_HASH:#x}");
    let inputs = format!("{INPUTS_DIGEST:#x}");

    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .args([
            "committee",
            "--config",
            fix.config_path.to_str().unwrap(),
            "vote-submit",
            "--vault",
            vault_addr,
            "--stance",
            "overweight",
            "--weight-bps",
            "6000",
            "--confidence",
            "85",
            "--rationale-uri",
            "https://gist.github.com/robotmoney/test123",
            "--vote-json-hash",
            &vote_hash,
            "--prompt-hash",
            &prompt,
            "--inputs-digest",
            &inputs,
            "--schema-version",
            "1.0",
            "--timestamp",
            "1750000000",
            "--order-id",
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ])
        .output()
        .expect("rmpc ran");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("STDOUT: {stdout}");
    eprintln!("STDERR: {stderr}");

    assert!(
        output.status.success(),
        "expected exit 0, got {:?}",
        output.status
    );

    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON");
    assert_eq!(v["ok"], true, "ok field");
    assert_eq!(v["action"], "vote-submit", "action field");
    assert_eq!(v["tx_hash"], format!("{TX_HASH:#x}"), "tx_hash field");
    assert_eq!(v["block_number"], 42, "block_number field");
}

#[tokio::test]
async fn test_committee_vote_submit_unauthorized_rejected() {
    let mut server = mockito::Server::new_async().await;
    let fix = CommitteeFixture::build(&server.url());

    // eth_chainId
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{CHAIN_ID:x}")))
        .expect_at_least(0)
        .create_async()
        .await;

    // eth_feeHistory
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_feeHistory"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&fee_history_body()))
        .expect(1)
        .create_async()
        .await;

    // eth_getTransactionCount
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionCount"}),
        ))
        .with_status(200)
        .with_body(jrpc_result("0x2"))
        .expect(1)
        .create_async()
        .await;

    // eth_sendRawTransaction — simulate a pre-inclusion revert
    // (the node simulates the tx and returns AgentNotAllowlisted as a
    // JSON-RPC error, not a successful tx hash).
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"execution reverted"}}"#,
        )
        .expect(1)
        .create_async()
        .await;

    let vault_addr = "0x2222222222222222222222222222222222222222";
    let vote_hash = format!("{VOTE_JSON_HASH:#x}");
    let prompt = format!("{PROMPT_HASH:#x}");
    let inputs = format!("{INPUTS_DIGEST:#x}");

    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .args([
            "committee",
            "--config",
            fix.config_path.to_str().unwrap(),
            "vote-submit",
            "--vault",
            vault_addr,
            "--stance",
            "underweight",
            "--weight-bps",
            "2000",
            "--confidence",
            "50",
            "--rationale-uri",
            "https://gist.github.com/robotmoney/unauthorized",
            "--vote-json-hash",
            &vote_hash,
            "--prompt-hash",
            &prompt,
            "--inputs-digest",
            &inputs,
            "--schema-version",
            "1.0",
            "--timestamp",
            "1750000000",
            "--order-id",
            "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ])
        .output()
        .expect("rmpc ran");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("STDOUT: {stdout}");
    eprintln!("STDERR: {stderr}");

    // The command must exit non-zero when the transaction is rejected.
    assert!(
        !output.status.success(),
        "expected non-zero exit for unauthorized agent, got {:?}",
        output.status
    );

    // stdout should contain a JSON failure envelope.
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON on stdout");
    assert_eq!(v["ok"], false, "ok must be false for failure");
    // AC-3: the named error variant must be ErrNotAllowlisted.
    assert_eq!(
        v["error"], "ErrNotAllowlisted",
        "expected ErrNotAllowlisted, got {:?}",
        v["error"]
    );
}

/// AC-4: missing `ic_policy_address` in operator config produces
/// `IcContractNotConfigured` error before any on-chain write.
///
/// No RPC mocks are registered — this test asserts the command fails closed
/// at config-validation time, before it touches the network.
#[tokio::test]
async fn test_committee_missing_ic_contract_address() {
    use alloy_primitives::keccak256;
    use rust_payment_client::signer::software::SoftwareSigner;

    const TEST_PRIVKEY: [u8; 32] = [
        0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff,
        0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2,
        0xff, 0x80,
    ];

    let tmp = tempfile::TempDir::new().expect("tempdir");
    let keystore_path = tmp.path().join("keystore.json");
    SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
        .expect("create keystore");

    const GATEWAY_CODE: &[u8] = &[0x60, 0x80, 0x60, 0x40, 0x52, 0xfe, 0xfe, 0xfe];
    let runtime_hash = format!(
        "0x{}",
        alloy_primitives::hex::encode(keccak256(GATEWAY_CODE))
    );

    // Config WITHOUT ic_policy_address.
    let config_path = tmp.path().join("rmpc-no-ic.toml");
    let toml = format!(
        r#"chain_id              = {CHAIN_ID}
rpc_url               = "http://127.0.0.1:9999"
gateway_address       = "{GATEWAY:#x}"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "0x0000000000000000000000000000000000000d00"
gateway_runtime_hash  = "{runtime_hash}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
        ks = keystore_path.display()
    );
    std::fs::write(&config_path, toml).expect("write config");

    // Try `committee register` — must fail before any network call.
    let output = rmpc()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .env("RMPC_STATE_DIR", tmp.path().to_str().unwrap())
        .args([
            "committee",
            "--config",
            config_path.to_str().unwrap(),
            "register",
            "--agent",
            &format!("{COMMITTEE_AGENT:#x}"),
            "--agent-id",
            "athena-v1",
            "--order-id",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ])
        .output()
        .expect("rmpc ran");

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("STDOUT: {stdout}");
    eprintln!("STDERR: {stderr}");

    // Must exit non-zero.
    assert!(
        !output.status.success(),
        "expected non-zero exit for missing ic_policy_address, got {:?}",
        output.status
    );

    // stdout must contain a JSON failure with ErrIcContractNotConfigured.
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON on stdout");
    assert_eq!(v["ok"], false, "ok must be false");
    assert_eq!(
        v["error"], "ErrIcContractNotConfigured",
        "expected ErrIcContractNotConfigured, got {:?}",
        v["error"]
    );
}
