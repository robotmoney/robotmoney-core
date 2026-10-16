//! Canonical: none — integration tests for `rmpc committee`
//! Implements: issue #1044 AC-3 (Test plan item 2)
//!
//! Tests:
//! - `test_rmpc_has_no_governance_signing_commands`: `committee register` and
//!   `propose` are gone (rmpc is not a governance signer, issue #1447 K).
//! - `test_committee_vote_submit_happy_path`: An allowlisted committee agent
//!   submits a signed allocation vote via `rmpc committee vote-submit`.
//!   Asserts the tx is broadcast and a JSON receipt is printed on stdout.
//! - `test_committee_vote_submit_unauthorized_rejected`: A non-allowlisted
//!   agent attempts to call vote-submit; the JSON-RPC returns a revert and
//!   the command exits non-zero.
//! - `committee_check_agent_*`: the read-only `check-agent` preflight the
//!   swarm skill's `check-preflight.sh` runs (review finding DR-1). A held
//!   role exits 0, a missing one exits 2 with `ErrNotAllowlisted`, and an
//!   unreachable RPC exits 3: never 0.
//!
//! The write tests mock the JSON-RPC server with mockito. No live chain is
//! required.

mod common;

use crate::common::{
    install_direct_gateway_code_mocks, install_gateway_implementation, jrpc_result,
    jrpc_result_raw, FIXTURE_BLOCK_TAG, GATEWAY, SIGNER_ADDRESS, TEST_PASSPHRASE,
};
use alloy_consensus::TxEip1559;
use alloy_primitives::TxKind;
use alloy_primitives::{address, b256, hex as ahex, Address, B256};
use alloy_sol_types::SolCall;
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::RobotMoneyGateway;
use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
use serde_json::json;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

// ─── Test constants ───────────────────────────────────────────────────────────

/// Local devnet chain id. A software keystore signs on every chain (owner
/// decision 2026-10-14); `committee_vote_submit_base_mainnet_*` covers 8453.
const CHAIN_ID: u64 = 31337;

/// Fake IC policy contract address for tests.
const IC_POLICY: Address = address!("0000000000000000000000000000000000000e00");

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
        Self::build_full(rpc_url, CHAIN_ID, "")
    }

    fn build_on(rpc_url: &str, chain_id: u64) -> Self {
        Self::build_full(rpc_url, chain_id, "")
    }

    /// [`Self::build`] with `extra` top-level TOML lines.
    fn build_with(rpc_url: &str, extra: &str) -> Self {
        Self::build_full(rpc_url, CHAIN_ID, extra)
    }

    fn build_full(rpc_url: &str, chain_id: u64, extra: &str) -> Self {
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
            r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "{GATEWAY:#x}"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "0x0000000000000000000000000000000000000d00"
ic_policy_address     = "{IC_POLICY:#x}"
gateway_runtime_hash  = "{runtime_hash}"
max_fee_per_gas_cap   = 100000000000
{extra}
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
            "to":"{GATEWAY:#x}",
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

/// Owner decision 2026-10-14 (QA plan U7, Decision D12): a committee write on
/// Base mainnet signs with the software keystore. The old gate refused it
/// with `ErrProductionSignerRequired` before the keystore was read. Now the
/// production warning prints and the command goes on to load the keystore;
/// with no passphrase in the environment that load is the startup failure
/// (exit 3), never a hardware refusal.
#[test]
fn committee_vote_submit_base_mainnet_signs_with_software_keystore() {
    let logs = TempDir::new().unwrap();
    let fix = CommitteeFixture::build_on("http://127.0.0.1:1", 8453);
    let vote_hash = format!("{VOTE_JSON_HASH:#x}");
    let prompt = format!("{PROMPT_HASH:#x}");
    let inputs = format!("{INPUTS_DIGEST:#x}");

    let output = rmpc()
        .env("RMPC_LOG_DIR", logs.path())
        .env("RMPC_STATE_DIR", fix._tmp.path().to_str().unwrap())
        .env_remove(PASSPHRASE_ENV_VAR)
        .args([
            "committee",
            "--config",
            fix.config_path.to_str().unwrap(),
            "vote-submit",
            "--vault",
            "0x2222222222222222222222222222222222222222",
            "--stance",
            "neutral",
            "--weight-bps",
            "2500",
            "--confidence",
            "50",
            "--rationale-uri",
            "https://gist.github.com/robotmoney/mainnet",
            "--vote-json-hash",
            &vote_hash,
            "--prompt-hash",
            &prompt,
            "--inputs-digest",
            &inputs,
            "--timestamp",
            "1750000000",
            "--order-id",
            "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        ])
        .output()
        .expect("rmpc ran");

    assert_eq!(output.status.code(), Some(3), "keystore load is the stop");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.contains("ErrProductionSignerRequired"),
        "no hardware refusal on 8453: {stdout}"
    );
    common::assert_mainnet_warning_precedes_keystore_load(logs.path());
}

#[tokio::test]
async fn test_committee_vote_submit_happy_path() {
    let mut server = mockito::Server::new_async().await;
    let fix = CommitteeFixture::build(&server.url());
    install_direct_gateway_code_mocks(&mut server).await;

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

    // eth_sendRawTransaction — capture the raw envelope so the test can
    // assert WHERE the vote was sent, not just that something was sent.
    let raw_tx: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let raw_tx_sink = Arc::clone(&raw_tx);
    let tx_hash_body = jrpc_result(&format!("{TX_HASH:#x}"));
    // Issue #1511: the signed tx must target the GATEWAY (not the IC policy,
    // whose `submitVote` is `onlyGateway`) and carry the `committeeVoteSubmit`
    // selector. The body regex pins both; a tx aimed at the policy matches no
    // mock and the command fails.
    let selector = ahex::encode(RobotMoneyGateway::committeeVoteSubmitCall::SELECTOR);
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_sendRawTransaction"})),
            Matcher::Regex(format!("{GATEWAY:x}[0-9a-f]{{0,12}}{selector}")),
        ]))
        .with_status(200)
        .with_body_from_request(move |req| {
            let body: serde_json::Value =
                serde_json::from_slice(req.body().expect("request body")).expect("JSON-RPC body");
            let raw = body["params"][0].as_str().expect("raw tx hex").to_string();
            *raw_tx_sink.lock().unwrap() = Some(raw);
            tx_hash_body.clone().into_bytes()
        })
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

    // Issue #1511: the IC policy's `submitVote` is `onlyGateway`, so a vote sent
    // straight to the policy reverts with `CallerNotGateway` on any real chain.
    // The envelope must target the GATEWAY and carry `committeeVoteSubmit`.
    let raw_hex = raw_tx
        .lock()
        .unwrap()
        .clone()
        .expect("a raw tx was broadcast");
    let raw = ahex::decode(raw_hex.trim_start_matches("0x")).expect("raw tx hex");
    assert_eq!(raw[0], 0x02, "EIP-1559 envelope");
    let signed = TxEip1559::decode_signed_fields(&mut &raw[1..]).expect("decode EIP-1559 tx");
    let tx = signed.tx();
    assert_eq!(
        tx.to,
        TxKind::Call(GATEWAY),
        "the vote must be sent to the gateway, never to the IC policy ({IC_POLICY:#x})"
    );
    assert_eq!(
        &tx.input[..4],
        RobotMoneyGateway::committeeVoteSubmitCall::SELECTOR.as_slice(),
        "the calldata must be gateway.committeeVoteSubmit, not policy.submitVote"
    );
    let call = RobotMoneyGateway::committeeVoteSubmitCall::abi_decode(&tx.input, true)
        .expect("decode committeeVoteSubmit calldata");
    assert_eq!(call.p.agent, SIGNER_ADDRESS, "agent is the signer");
    assert_eq!(
        call.p.vault,
        Address::from_str(vault_addr).unwrap(),
        "vault field"
    );
    assert_eq!(call.p.targetWeightBps, 6000, "weight field");
    assert_eq!(call.p.voteJsonHash, VOTE_JSON_HASH, "vote json hash field");
}

#[tokio::test]
async fn test_committee_vote_submit_unauthorized_rejected() {
    let mut server = mockito::Server::new_async().await;
    let fix = CommitteeFixture::build(&server.url());
    install_direct_gateway_code_mocks(&mut server).await;

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

    // Try `committee vote-submit` — must fail before any network call.
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
            "vote-submit",
            "--vault",
            "0x1111111111111111111111111111111111111111",
            "--stance",
            "overweight",
            "--weight-bps",
            "6000",
            "--confidence",
            "85",
            "--rationale-uri",
            "https://gist.github.com/robotmoney/test123",
            "--vote-json-hash",
            &format!("{VOTE_JSON_HASH:#x}"),
            "--prompt-hash",
            &format!("{PROMPT_HASH:#x}"),
            "--inputs-digest",
            &format!("{INPUTS_DIGEST:#x}"),
            "--schema-version",
            "1.0",
            "--timestamp",
            "1750000000",
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

// ─── T23 · a mined transaction is not a successful one ────────────────────────
//
// §E.4 recorded `committee.rs` as the symptom and the five hand-rolled copies of
// the status check as the cause. `rmpc committee vote-submit` (and the since
// removed `register`) were two of the seven write paths that had NO
// copy at all: both printed `{"ok":true, tx_hash, block_number}` and exited 0
// for a transaction the node mined and the EVM reverted — the false success
// AC-CORE-09 forbids, and the same one commit `1854fe6e` had just spent a commit
// removing from the anchoring path by adding a SIXTH copy rather than moving it.
//
// `consensusVoteSubmit` is role-gated, so this is
// not a hypothetical: an agent without `COMMITTEE_AGENT_ROLE` produces exactly
// this receipt, and the operator was told the vote was recorded.

/// The happy-path receipt with `status` flipped to `0x0` — mined, and reverted.
fn reverted_receipt_body() -> String {
    let body = simple_receipt_body();
    let flipped = body.replace(r#""status":"0x1""#, r#""status":"0x0""#);
    assert_ne!(
        flipped, body,
        "the status field must actually change, or this fixture tests nothing"
    );
    flipped
}

/// Install the five RPC mocks a committee write needs, with the receipt the
/// caller chooses.
async fn install_committee_mocks(server: &mut mockito::Server, receipt_body: &str) {
    install_direct_gateway_code_mocks(server).await;
    for (method, body) in [
        ("eth_chainId", jrpc_result(&format!("0x{CHAIN_ID:x}"))),
        ("eth_feeHistory", jrpc_result_raw(&fee_history_body())),
        ("eth_getTransactionCount", jrpc_result("0x0")),
        (
            "eth_sendRawTransaction",
            jrpc_result(&format!("{TX_HASH:#x}")),
        ),
        ("eth_getTransactionReceipt", jrpc_result_raw(receipt_body)),
    ] {
        server
            .mock("POST", "/")
            .match_body(Matcher::PartialJson(json!({ "method": method })))
            .with_status(200)
            .with_body(body)
            .expect_at_least(0)
            .create_async()
            .await;
    }
}

/// Assert a committee command refused a reverted transaction rather than
/// reporting it as a success.
fn assert_refused_as_reverted(output: &std::process::Output, action: &str) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    eprintln!("STDOUT: {stdout}");
    eprintln!("STDERR: {}", String::from_utf8_lossy(&output.stderr));
    assert!(
        !output.status.success(),
        "`committee {action}` exited 0 for a MINED-BUT-REVERTED transaction — that is the \
         false success AC-CORE-09 forbids, got {:?}",
        output.status
    );
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON on stdout");
    assert_eq!(v["ok"], false, "ok field");
    assert_eq!(
        v["error"], "ErrTxReverted",
        "the refusal must carry the shared write-seam error code"
    );
    assert_eq!(
        v["tx_hash"],
        format!("{TX_HASH:#x}"),
        "the refusal must name the transaction the operator has to inspect"
    );
}

#[tokio::test]
async fn test_committee_vote_submit_refuses_a_reverted_transaction() {
    let mut server = mockito::Server::new_async().await;
    install_committee_mocks(&mut server, &reverted_receipt_body()).await;
    let fix = CommitteeFixture::build(&server.url());

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
            "0x1111111111111111111111111111111111111111",
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

    assert_refused_as_reverted(&output, "vote-submit");
}

/// Issue 1810: the vote goes to the gateway proxy, so `vote-submit` verifies
/// the live implementation before signing. The proxy code (and its pinned
/// hash) is unchanged; the implementation slot names one nobody approved.
/// The command refuses and nothing is signed or sent.
#[tokio::test]
async fn test_committee_vote_submit_refuses_an_unapproved_implementation() {
    use alloy_primitives::keccak256;
    const IMPL_A: Address = address!("00000000000000000000000000000000000a11ce");
    const IMPL_B: Address = address!("00000000000000000000000000000000000b0b00");
    const IMPL_A_CODE: &[u8] = &[0x60, 0x01, 0xaa];
    const IMPL_B_CODE: &[u8] = &[0x60, 0x01, 0xbb];

    let mut server = mockito::Server::new_async().await;
    install_committee_mocks(&mut server, &simple_receipt_body()).await;
    install_gateway_implementation(&mut server, IMPL_B, IMPL_B_CODE, None).await;
    let fix = CommitteeFixture::build_with(
        &server.url(),
        &format!(
            "gateway_implementation = \"{IMPL_A:#x}\"\n\
             gateway_implementation_runtime_hash = \"0x{}\"\n",
            ahex::encode(keccak256(IMPL_A_CODE))
        ),
    );

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
            "0x1111111111111111111111111111111111111111",
            "--stance",
            "overweight",
            "--weight-bps",
            "6000",
            "--confidence",
            "85",
            "--rationale-uri",
            "https://gist.github.com/robotmoney/test123",
            "--vote-json-hash",
            &format!("{VOTE_JSON_HASH:#x}"),
            "--prompt-hash",
            &format!("{PROMPT_HASH:#x}"),
            "--inputs-digest",
            &format!("{INPUTS_DIGEST:#x}"),
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
    eprintln!("STDOUT: {stdout}");
    assert_eq!(output.status.code(), Some(2), "refusal exit code");
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON");
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrImplementationNotApproved");
    assert!(v["tx_hash"].is_null(), "nothing was sent: {v}");
}

/// Issue 1856: the gateway is verified before signing at the pinned block
/// (FIXTURE_BLOCK_TAG shows the approved IMPL_A), and again after signing at
/// `latest`, where the slot now names IMPL_B. The signed vote is discarded
/// unsent, exactly as `WriteSession::submit` does for a deposit.
#[tokio::test]
async fn test_committee_vote_submit_discards_the_signed_vote_when_the_implementation_changes_before_broadcast(
) {
    use alloy_primitives::keccak256;
    const IMPL_A: Address = address!("00000000000000000000000000000000000a11ce");
    const IMPL_B: Address = address!("00000000000000000000000000000000000b0b00");
    const IMPL_A_CODE: &[u8] = &[0x60, 0x01, 0xaa];
    const IMPL_B_CODE: &[u8] = &[0x60, 0x01, 0xbb];

    let mut server = mockito::Server::new_async().await;
    install_committee_mocks(&mut server, &simple_receipt_body()).await;
    install_gateway_implementation(&mut server, IMPL_A, IMPL_A_CODE, Some(FIXTURE_BLOCK_TAG)).await;
    install_gateway_implementation(&mut server, IMPL_B, IMPL_B_CODE, Some("latest")).await;
    let send = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await;
    let fix = CommitteeFixture::build_with(
        &server.url(),
        &format!(
            "gateway_implementation = \"{IMPL_A:#x}\"\n\
             gateway_implementation_runtime_hash = \"0x{}\"\n",
            ahex::encode(keccak256(IMPL_A_CODE))
        ),
    );

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
            "0x1111111111111111111111111111111111111111",
            "--stance",
            "overweight",
            "--weight-bps",
            "6000",
            "--confidence",
            "85",
            "--rationale-uri",
            "https://gist.github.com/robotmoney/test123",
            "--vote-json-hash",
            &format!("{VOTE_JSON_HASH:#x}"),
            "--prompt-hash",
            &format!("{PROMPT_HASH:#x}"),
            "--inputs-digest",
            &format!("{INPUTS_DIGEST:#x}"),
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
    eprintln!("STDOUT: {stdout}");
    eprintln!("STDERR: {}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(output.status.code(), Some(2), "refusal exit code");
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON");
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrImplementationChanged", "{v}");
    assert!(
        v["message"].as_str().unwrap().contains("discarded unsent"),
        "{v}"
    );
    assert!(v["tx_hash"].is_null(), "nothing was sent: {v}");
    send.assert_async().await;
}

// ─── rmpc is not a governance signer (issue #1447, workstream K) ──────────────

/// `committee register`, `propose` and `vote` signed as an EOA against
/// `onlyRole(ADMIN_ROLE)` / governance entry points that belong to the Safe
/// after handover. They must not exist, so no operator reaches for them.
/// `governance draft-proposal` built proposal calldata for a voting function
/// issue 1698 deleted; it is gone too (QA plan C1).
#[test]
fn test_rmpc_has_no_governance_signing_commands() {
    for argv in [
        vec!["committee", "--config", "x.toml", "register"],
        vec!["propose", "--config", "x.toml"],
        vec!["vote", "--config", "x.toml"],
        vec!["governance", "--config", "x.toml", "draft-proposal"],
    ] {
        let output = rmpc().args(&argv).output().expect("rmpc ran");
        assert!(
            !output.status.success(),
            "`rmpc {}` must be rejected, got {:?}",
            argv.join(" "),
            output.status
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("unrecognized subcommand"),
            "`rmpc {}` must be an unknown subcommand, stderr: {stderr}",
            argv.join(" ")
        );
    }
}

// ─── check-agent · the swarm preflight's role read (review finding DR-1) ──────
//
// `plugins/robotmoney-swarm/scripts/check-preflight.sh` guard 3 used to run
// `vote-submit --dry-run` (no such flag) and grep `AgentNotRegistered` (no such
// error), so it passed for every agent. It now runs `committee check-agent`,
// and these tests pin the three answers the script maps: held (0), not held
// (2, `ErrNotAllowlisted`) and unknown (3). The third is the one that matters:
// a read that did not happen must never look like a registered agent.

/// `keccak256("COMMITTEE_AGENT_ROLE")`, the constant
/// `InvestmentCommitteePolicy.COMMITTEE_AGENT_ROLE()` returns.
fn committee_agent_role() -> B256 {
    alloy_primitives::keccak256("COMMITTEE_AGENT_ROLE")
}

/// Wire `eth_chainId`, `eth_blockNumber`, `COMMITTEE_AGENT_ROLE()` and a
/// `hasRole(role, agent)` answer. Both calls must target the IC policy, and
/// `hasRole` must carry the deployed role and exactly `agent`: a request that
/// misses these matchers gets mockito's 501 and the command exits 3.
async fn install_check_agent_mocks(server: &mut mockito::Server, agent: Address, has_role: bool) {
    use rust_payment_client::gateway::InvestmentCommitteePolicy;

    let to_ic = Matcher::Regex(format!(r#"(?i)"to":"{IC_POLICY:#x}""#));
    let role = committee_agent_role();

    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{CHAIN_ID:x}")))
        .expect_at_least(1)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result("0x2a"))
        .expect_at_least(1)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            common::match_eth_call_selector(&common::selector_hex_of::<
                InvestmentCommitteePolicy::COMMITTEE_AGENT_ROLECall,
            >()),
            to_ic.clone(),
        ]))
        .with_status(200)
        .with_body(jrpc_result(&format!("{role:#x}")))
        .expect(1)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            common::match_eth_call_selector_with_first_arg(
                &common::selector_hex_of::<InvestmentCommitteePolicy::hasRoleCall>(),
                &format!("{}{}", ahex::encode(role), common::abi_addr_hex(agent)),
            ),
            to_ic,
        ]))
        .with_status(200)
        .with_body(jrpc_result(&common::enc_bool(has_role)))
        .expect(1)
        .create_async()
        .await;
}

fn run_check_agent(config_path: &std::path::Path, extra: &[&str]) -> std::process::Output {
    let mut args = vec![
        "committee",
        "--config",
        config_path.to_str().unwrap(),
        "check-agent",
    ];
    args.extend_from_slice(extra);
    // No passphrase in the environment: the read must not need one.
    rmpc()
        .env_remove(PASSPHRASE_ENV_VAR)
        .args(&args)
        .output()
        .expect("rmpc ran")
}

fn stdout_json(output: &std::process::Output) -> serde_json::Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    eprintln!("STDOUT: {stdout}");
    eprintln!("STDERR: {}", String::from_utf8_lossy(&output.stderr));
    serde_json::from_str(stdout.trim()).expect("valid JSON on stdout")
}

/// The default agent is the keystore's cleartext address, and a held role
/// exits 0 with the deployed role hash echoed back.
#[tokio::test]
async fn committee_check_agent_reports_a_registered_agent() {
    let mut server = mockito::Server::new_async().await;
    let fix = CommitteeFixture::build(&server.url());
    install_check_agent_mocks(&mut server, SIGNER_ADDRESS, true).await;

    let output = run_check_agent(&fix.config_path, &[]);
    let v = stdout_json(&output);

    assert_eq!(output.status.code(), Some(0), "a held role exits 0");
    assert_eq!(v["ok"], true);
    assert_eq!(v["action"], "check-agent");
    assert_eq!(v["has_role"], true);
    assert_eq!(v["block_number"], 42);
    assert_eq!(v["chain_id"], CHAIN_ID);
    assert_eq!(
        v["agent"].as_str().unwrap().to_lowercase(),
        format!("{SIGNER_ADDRESS:#x}").to_lowercase(),
        "the default agent is the keystore address vote-submit signs as"
    );
    assert_eq!(
        v["committee_agent_role"],
        format!("{:#x}", committee_agent_role())
    );
    assert!(v.get("error").is_none(), "no error on a held role: {v}");
}

/// A role the policy says is not held is a refusal under the same name
/// `vote-submit` uses, and `--agent` names the address that is read.
#[tokio::test]
async fn committee_check_agent_refuses_an_unregistered_agent_as_not_allowlisted() {
    let other = address!("00000000000000000000000000000000000000a1");
    let mut server = mockito::Server::new_async().await;
    let fix = CommitteeFixture::build(&server.url());
    install_check_agent_mocks(&mut server, other, false).await;

    let output = run_check_agent(&fix.config_path, &["--agent", &format!("{other:#x}")]);
    let v = stdout_json(&output);

    assert_eq!(output.status.code(), Some(2), "a missing role exits 2");
    assert_eq!(v["ok"], false);
    assert_eq!(v["has_role"], false);
    assert_eq!(v["error"], "ErrNotAllowlisted");
    assert!(
        v["message"]
            .as_str()
            .unwrap()
            .contains("COMMITTEE_AGENT_ROLE"),
        "the refusal names the role: {v}"
    );
}

/// The DR-1 regression. An RPC nobody answers is not a registered agent: the
/// read exits 3 with a transport error and prints no `has_role` at all.
#[tokio::test]
async fn committee_check_agent_unreachable_rpc_is_unknown_not_registered() {
    // Port 1 (tcpmux) has no listener on a CI runner: connection refused.
    let fix = CommitteeFixture::build("http://127.0.0.1:1");

    let output = run_check_agent(&fix.config_path, &[]);
    let v = stdout_json(&output);

    assert_eq!(output.status.code(), Some(3), "an unknown answer exits 3");
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "ErrRpcTransport");
    assert!(
        v.get("has_role").is_none(),
        "an unread role must not be reported: {v}"
    );
}

/// A config without `ic_policy_address` cannot be asked the question.
#[test]
fn committee_check_agent_without_ic_policy_address_is_unknown() {
    let fix = CommitteeFixture::build("http://127.0.0.1:1");
    let body = std::fs::read_to_string(&fix.config_path).unwrap();
    let without_ic: String = body
        .lines()
        .filter(|l| !l.starts_with("ic_policy_address"))
        .map(|l| format!("{l}\n"))
        .collect();
    std::fs::write(&fix.config_path, without_ic).unwrap();

    let output = run_check_agent(&fix.config_path, &[]);
    let v = stdout_json(&output);

    assert_eq!(output.status.code(), Some(3));
    assert_eq!(v["error"], "ErrIcContractNotConfigured");
}

// ─── Issue 1810: the gateway is checked before a committee write signs ──────

/// The gateway is an ERC-1967 proxy and the config pins no implementation.
/// `vote-submit` refuses with `ErrImplementationNotApproved` (exit 2) after
/// checks 1 and 2 pass, and no transaction is signed or sent.
#[tokio::test]
async fn committee_vote_submit_refuses_an_unpinned_gateway_implementation() {
    let mut server = mockito::Server::new_async().await;
    let fix = CommitteeFixture::build(&server.url());
    let implementation = address!("00000000000000000000000000000000000001a1");
    install_committee_mocks(&mut server, &simple_receipt_body()).await;
    // Registered after the direct-gateway set, so these answer.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getStorageAt"})))
        .with_status(200)
        .with_body(jrpc_result(&format!(
            "0x{}",
            common::abi_addr_hex(implementation)
        )))
        .expect_at_least(1)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::AllOf(vec![
            Matcher::PartialJson(json!({"method": "eth_getCode"})),
            Matcher::Regex(format!(r#"(?i)"params":\["{implementation:#x}""#)),
        ]))
        .with_status(200)
        .with_body(jrpc_result("0x6001600055"))
        .expect_at_least(1)
        .create_async()
        .await;
    let send = server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_sendRawTransaction"}),
        ))
        .with_status(200)
        .with_body(jrpc_result(&format!("{TX_HASH:#x}")))
        .expect(0)
        .create_async()
        .await;

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
            "0x1111111111111111111111111111111111111111",
            "--stance",
            "neutral",
            "--weight-bps",
            "2500",
            "--confidence",
            "50",
            "--rationale-uri",
            "https://gist.github.com/robotmoney/pin",
            "--vote-json-hash",
            &vote_hash,
            "--prompt-hash",
            &prompt,
            "--inputs-digest",
            &inputs,
            "--timestamp",
            "1750000000",
            "--order-id",
            "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ])
        .output()
        .expect("rmpc ran");

    assert_eq!(output.status.code(), Some(2), "a refusal, not a send");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("ErrImplementationNotApproved"),
        "names the refusal: {stdout}"
    );
    send.assert_async().await;
}
