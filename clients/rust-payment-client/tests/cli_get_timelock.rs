//! Canonical: docs/security-model.md §4 — Timelock bypass → Mitigated
//! Implements: issue #420 — complete test pyramid for on-chain timelocked multisig
//!
//! Integration tests for `rmpc get-timelock` (issue #414 / #420).
//!
//! Each test spins up a mockito JSON-RPC server, installs response fixtures
//! for the calls that `get_timelock::run` issues, then asserts on the
//! structured envelope emitted to stdout.  No live chain or fork devnet is
//! required.
//!
//! Coverage:
//! - Happy path: proposers, executors, minDelay, and one pending operation
//!   in the output after a scheduled operation.
//! - Missing `timelock_address` in config → `EXIT_STARTUP_FAIL`.

mod common;

use crate::common::{jrpc_result, jrpc_result_raw, match_eth_call_selector, selector_hex_of};
use alloy_primitives::{address, b256, hex as ahex, keccak256, Address, B256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::gateway::TimelockController;
use rust_payment_client::signer::software::SoftwareSigner;
use serde_json::{json, Value};
use tempfile::TempDir;

/// Addresses used as constants across tests.
const TIMELOCK: Address = address!("0000000000000000000000000000000000001234");
const SAFE: Address = address!("0000000000000000000000000000000000005afe");

/// keccak256("PROPOSER_ROLE") — matches the OZ TimelockController constant.
const PROPOSER_ROLE: B256 =
    b256!("b09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1");
/// keccak256("EXECUTOR_ROLE") — matches the OZ TimelockController constant.
const EXECUTOR_ROLE: B256 =
    b256!("d8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63");

/// Operation id used in the pending-op mock.
const OP_ID: B256 = b256!("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

/// Minimum delay in seconds (2 days).
const MIN_DELAY_SECS: u64 = 172_800;

/// Ready-timestamp for the mock pending op — far in the future so it is not
/// confused with the DONE sentinel (1) by `get_timelock`.
const READY_TS: u64 = 9_999_999_999;

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

fn enc_u64(v: u64) -> String {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    format!("0x{}", ahex::encode(w))
}

fn enc_b256(b: B256) -> String {
    format!("0x{}", ahex::encode(b.as_slice()))
}

/// Build a minimal RoleGranted log JSON for `account` holding `role` on
/// `timelock_addr`, with a dummy block number.
fn role_granted_log(timelock_addr: Address, role: B256, account: Address, block_no: u64) -> String {
    // RoleGranted(bytes32 indexed role, address indexed account, address sender)
    let event_topic0 = keccak256(b"RoleGranted(bytes32,address,address)");
    // topic[2] is account padded to 32 bytes.
    let mut acc_padded = [0u8; 32];
    acc_padded[12..].copy_from_slice(account.as_slice());
    format!(
        r#"[{{"address":"{addr:#x}","topics":["{t0}","{role}","0x{acc}"],"data":"0x{sender}","blockNumber":"0x{block:x}","transactionHash":"0x{hash}","logIndex":"0x0","blockHash":"0x{hash}","transactionIndex":"0x0","removed":false}}]"#,
        addr = timelock_addr,
        t0 = enc_b256(B256::from(event_topic0)),
        role = enc_b256(role),
        acc = ahex::encode(acc_padded),
        // sender field in data (not used by the scanner)
        sender = "00".repeat(32),
        block = block_no,
        hash = "bb".repeat(32),
    )
}

/// Build a CallScheduled log JSON.  The scanner reads `topic[1]` as the
/// operation id; topic[0] is the event selector.
fn call_scheduled_log(timelock_addr: Address, op_id: B256, block_no: u64) -> String {
    let event_topic0 =
        keccak256(b"CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)");
    // index = 0 (second indexed field in CallScheduled)
    let index = B256::ZERO;
    format!(
        r#"[{{"address":"{addr:#x}","topics":["{t0}","{op}","{idx}"],"data":"0x{data}","blockNumber":"0x{block:x}","transactionHash":"0x{hash}","logIndex":"0x0","blockHash":"0x{hash}","transactionIndex":"0x0","removed":false}}]"#,
        addr = timelock_addr,
        t0 = enc_b256(B256::from(event_topic0)),
        op = enc_b256(op_id),
        idx = enc_b256(index),
        // data encodes (target, value, data, delay) — not parsed by our scanner
        data = "00".repeat(128),
        block = block_no,
        hash = "cc".repeat(32),
    )
}

/// Build a temporary config TOML that includes `timelock_address`.
///
/// We cannot use `Fixture::build` directly because it does not expose a
/// `timelock_address` parameter; we construct the TOML inline instead.
struct TimelockFixture {
    _tmp: TempDir,
    pub config_path: std::path::PathBuf,
}

impl TimelockFixture {
    fn build(rpc_url: &str, chain_id: u64, timelock: Address) -> Self {
        const TEST_PRIVKEY: [u8; 32] = [
            0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38,
            0xff, 0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b,
            0xf4, 0xf2, 0xff, 0x80,
        ];
        const TEST_PASSPHRASE: &[u8] = b"correct horse battery staple";

        let tmp = TempDir::new().expect("tempdir");
        let keystore_path = tmp.path().join("keystore.json");
        SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
            .expect("create keystore");

        let runtime_hash = format!(
            "0x{}",
            ahex::encode(keccak256([
                0x60u8, 0x80, 0x60, 0x40, 0x52, 0xfe, 0xfe, 0xfe
            ]))
        );
        let config_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "0x0000000000000000000000000000000000000b00"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "0x0000000000000000000000000000000000000d00"
timelock_address      = "{timelock:#x}"
gateway_runtime_hash  = "{runtime_hash}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
            ks = keystore_path.display(),
        );
        std::fs::write(&config_path, toml).expect("write config");
        Self {
            _tmp: tmp,
            config_path,
        }
    }
}

/// Happy-path: proposers, executors, minDelay, and one pending operation in
/// the output after a scheduled operation.
#[tokio::test]
async fn get_timelock_clean_envelope_with_pending_op() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x200u64;

    // ── eth_chainId ──────────────────────────────────────────────────────────
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{chain_id:x}")))
        .expect_at_least(0)
        .create_async()
        .await;

    // ── eth_blockNumber ───────────────────────────────────────────────────────
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{block_no:x}")))
        .expect_at_least(0)
        .create_async()
        .await;

    // ── getMinDelay() ─────────────────────────────────────────────────────────
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            TimelockController::getMinDelayCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u64(MIN_DELAY_SECS)))
        .expect_at_least(0)
        .create_async()
        .await;

    // ── PROPOSER_ROLE() ───────────────────────────────────────────────────────
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            TimelockController::PROPOSER_ROLECall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_b256(PROPOSER_ROLE)))
        .expect_at_least(0)
        .create_async()
        .await;

    // ── EXECUTOR_ROLE() ───────────────────────────────────────────────────────
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            TimelockController::EXECUTOR_ROLECall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_b256(EXECUTOR_ROLE)))
        .expect_at_least(0)
        .create_async()
        .await;

    // ── eth_getLogs (all log queries share the same mock — mockito matches
    //    by method name only; the first matching mock wins for each call).
    //
    //    The command issues five eth_getLogs calls in order:
    //      1. RoleGranted for PROPOSER_ROLE  → [safe has role]
    //      2. RoleRevoked for PROPOSER_ROLE  → []
    //      3. RoleGranted for EXECUTOR_ROLE  → [safe has role]
    //      4. RoleRevoked for EXECUTOR_ROLE  → []
    //      5. CallScheduled                  → [one pending op]
    //
    //    We register each response individually using mockito's sequential
    //    call counting so the correct payload is returned for each call. ────

    // Call 1: RoleGranted PROPOSER_ROLE — safe holds the role.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&role_granted_log(
            TIMELOCK,
            PROPOSER_ROLE,
            SAFE,
            0x10,
        )))
        .expect(1)
        .create_async()
        .await;

    // Call 2: RoleRevoked PROPOSER_ROLE — none.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw("[]"))
        .expect(1)
        .create_async()
        .await;

    // Call 3: RoleGranted EXECUTOR_ROLE — safe holds the role.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&role_granted_log(
            TIMELOCK,
            EXECUTOR_ROLE,
            SAFE,
            0x11,
        )))
        .expect(1)
        .create_async()
        .await;

    // Call 4: RoleRevoked EXECUTOR_ROLE — none.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw("[]"))
        .expect(1)
        .create_async()
        .await;

    // Call 5: CallScheduled — one pending operation.
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_getLogs"})))
        .with_status(200)
        .with_body(jrpc_result_raw(&call_scheduled_log(TIMELOCK, OP_ID, 0x20)))
        .expect(1)
        .create_async()
        .await;

    // ── getTimestamp(OP_ID) ───────────────────────────────────────────────────
    server
        .mock("POST", "/")
        .match_body(match_eth_call_selector(&selector_hex_of::<
            TimelockController::getTimestampCall,
        >()))
        .with_status(200)
        .with_body(jrpc_result(&enc_u64(READY_TS)))
        .expect_at_least(0)
        .create_async()
        .await;

    // ── Run command and assert ────────────────────────────────────────────────
    let fix = TimelockFixture::build(&server.url(), chain_id, TIMELOCK);
    let out = rmpc()
        .args([
            "get-timelock",
            "--config",
            fix.config_path.to_str().unwrap(),
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();

    // Envelope shape.
    assert_eq!(v["chain_id"], chain_id, "chain_id mismatch");
    assert_eq!(v["block_number"], block_no, "block_number mismatch");
    assert_eq!(v["source"], "json_rpc", "source mismatch");
    assert_eq!(v["partial"], false, "envelope should not be partial");

    let d = &v["data"];

    // minDelay.
    assert_eq!(
        d["min_delay_secs"].as_u64().unwrap(),
        MIN_DELAY_SECS,
        "min_delay_secs mismatch"
    );

    // Proposers — safe is the sole proposer.
    let proposers = d["proposers"].as_array().unwrap();
    assert_eq!(proposers.len(), 1, "expected exactly 1 proposer");
    assert_eq!(
        proposers[0].as_str().unwrap().to_lowercase(),
        format!("{SAFE:#x}").to_lowercase(),
        "proposer address mismatch"
    );

    // Executors — safe is the sole executor.
    let executors = d["executors"].as_array().unwrap();
    assert_eq!(executors.len(), 1, "expected exactly 1 executor");
    assert_eq!(
        executors[0].as_str().unwrap().to_lowercase(),
        format!("{SAFE:#x}").to_lowercase(),
        "executor address mismatch"
    );

    // Pending ops — one operation with the correct id and ready timestamp.
    let ops = d["pending_ops"].as_array().unwrap();
    assert_eq!(ops.len(), 1, "expected exactly 1 pending op");
    assert_eq!(
        ops[0]["operation_id"].as_str().unwrap().to_lowercase(),
        format!("{OP_ID:#x}").to_lowercase(),
        "pending op id mismatch"
    );
    assert_eq!(
        ops[0]["ready_timestamp"].as_u64().unwrap(),
        READY_TS,
        "pending op ready_timestamp mismatch"
    );
}

/// When `timelock_address` is absent from the config the command must exit
/// with a non-zero code (EXIT_STARTUP_FAIL = 3).
#[test]
fn get_timelock_fails_fast_without_timelock_address() {
    const TEST_PRIVKEY: [u8; 32] = [
        0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff,
        0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2,
        0xff, 0x80,
    ];
    const TEST_PASSPHRASE: &[u8] = b"correct horse battery staple";

    let tmp = TempDir::new().expect("tempdir");
    let keystore_path = tmp.path().join("keystore.json");
    SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
        .expect("create keystore");

    let config_path = tmp.path().join("rmpc.toml");
    let toml = format!(
        r#"chain_id              = 31337
rpc_url               = "http://127.0.0.1:1"
gateway_address       = "0x0000000000000000000000000000000000000b00"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "0x0000000000000000000000000000000000000d00"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
        zeros = "0".repeat(64),
        ks = keystore_path.display(),
    );
    std::fs::write(&config_path, toml).expect("write config");

    rmpc()
        .args(["get-timelock", "--config", config_path.to_str().unwrap()])
        .assert()
        .failure()
        .code(3);
}
