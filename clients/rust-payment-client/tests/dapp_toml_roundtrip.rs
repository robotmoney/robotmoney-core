//! Canonical: docs/technical/dapp-credential-decisions.md §3.4 — `rmpc`
//! config export contract; closes issue #208.
//!
//! End-to-end round-trip test: load the dapp-exported TOML
//! (`tests/fixtures/dapp-exported-config.toml`, mirroring the output of
//! `clients/dapp/src/lib/configExport.ts`) directly through `rmpc`'s real
//! config loader (`Config::from_str` / `Config::from_path`), then invoke the
//! binary's `self-check` subcommand against a mockito JSON-RPC happy-path.
//!
//! No translation helper is used — the dapp exports and rmpc loads the same
//! flat schema. If either side renames, removes, or adds a required field
//! without updating the other, `Config::from_str` will fail at parse time and
//! the round-trip test will catch it before any consumer is affected.

mod common;

use crate::common::{
    enc_bool, install_happy_path_mocks, jrpc_result, match_eth_call_selector, selector_hex_of,
    GATEWAY, GATEWAY_CODE, SHARE_RECEIVER, SIGNER_ADDRESS, TEST_PASSPHRASE, USDC, VAULT,
};
use alloy_primitives::{hex as ahex, keccak256};
use assert_cmd::Command;
use mockito::Matcher;
use rust_payment_client::config::Config;
use rust_payment_client::gateway::RobotMoneyGateway;
use rust_payment_client::signer::software::{SoftwareSigner, PASSPHRASE_ENV_VAR};
use serde_json::{json, Value};
use std::path::Path;
use tempfile::TempDir;

/// 32-byte private key matching `SIGNER_ADDRESS` (anvil account #0).
const TEST_PRIVKEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94,
    0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];

const FIXTURE_PATH: &str = "tests/fixtures/dapp-exported-config.toml";

fn rmpc_bin() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// Patch the fixture's runtime-specific fields (RPC URL, keystore path,
/// gateway_runtime_hash) so the test can use an ephemeral mockito server
/// and a temp keystore without storing secrets in the fixture.
///
/// The fixture's chain_id, gateway_address, usdc_address, vault_address are
/// preserved — they must match the common test constants or the test fails.
fn patch_fixture_for_test(
    fixture_toml: &str,
    rpc_url: &str,
    keystore_path: &Path,
    gateway_runtime_hash: &str,
) -> String {
    let mut cfg: toml::Value = toml::from_str(fixture_toml).expect("fixture TOML must parse");
    let table = cfg.as_table_mut().expect("top-level is a table");

    // Override runtime-specific fields.
    table.insert(
        "rpc_url".to_string(),
        toml::Value::String(rpc_url.to_string()),
    );
    table.insert(
        "gateway_runtime_hash".to_string(),
        toml::Value::String(gateway_runtime_hash.to_string()),
    );

    // Override keystore_path inside [signer].
    if let Some(signer) = table.get_mut("signer").and_then(|v| v.as_table_mut()) {
        signer.insert(
            "keystore_path".to_string(),
            toml::Value::String(keystore_path.to_str().unwrap().to_string()),
        );
    }

    toml::to_string(&cfg).expect("re-serializes to TOML")
}

/// Step 1: the dapp-exported fixture is directly parseable by
/// `Config::from_str` with no translation helper.
#[test]
fn dapp_toml_loads_directly_through_rmpc_config_loader() {
    let fixture_toml =
        std::fs::read_to_string(FIXTURE_PATH).expect("fixture present at known path");

    let tmp = TempDir::new().unwrap();
    let keystore_path = tmp.path().join("agent.keystore.json");
    SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
        .expect("create keystore for fixture");

    let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));
    let patched = patch_fixture_for_test(
        &fixture_toml,
        "http://127.0.0.1:1",
        &keystore_path,
        &runtime_hash,
    );

    // Direct load — no translation helper.
    let cfg = Config::from_str(&patched)
        .expect("dapp-exported TOML must parse directly via Config::from_str");

    // Assert the fixture values are consistent with the common test constants.
    assert_eq!(cfg.chain_id, 31337);
    assert_eq!(
        cfg.gateway_address.to_lowercase(),
        format!("{GATEWAY:#x}").to_lowercase(),
    );
    assert_eq!(
        cfg.usdc_address.to_lowercase(),
        format!("{USDC:#x}").to_lowercase(),
    );
    assert_eq!(
        cfg.vault_address.to_lowercase(),
        format!("{VAULT:#x}").to_lowercase(),
    );
    assert_eq!(cfg.gateway_runtime_hash, runtime_hash);
    assert!(cfg.signer.allow_software_fallback);
    assert_eq!(cfg.signer.keystore_path, keystore_path);
}

/// The exported config must contain a non-zero gateway_runtime_hash.
#[test]
fn fixture_has_non_zero_gateway_runtime_hash() {
    let fixture_toml =
        std::fs::read_to_string(FIXTURE_PATH).expect("fixture present at known path");
    let parsed: toml::Value = toml::from_str(&fixture_toml).expect("fixture TOML parses");
    let hash = parsed
        .get("gateway_runtime_hash")
        .and_then(|v| v.as_str())
        .expect("gateway_runtime_hash field present");
    assert!(!hash.is_empty(), "gateway_runtime_hash must not be empty");
    let zero = format!("0x{}", "0".repeat(64));
    assert_ne!(hash, zero, "gateway_runtime_hash must not be the zero hash");
    let zero_bytes = format!("0x{}", "00".repeat(32));
    assert_ne!(
        hash, zero_bytes,
        "gateway_runtime_hash must not be all-zero bytes"
    );
}

/// The exported config must contain a usdc_address field.
#[test]
fn fixture_has_usdc_address() {
    let fixture_toml =
        std::fs::read_to_string(FIXTURE_PATH).expect("fixture present at known path");
    let parsed: toml::Value = toml::from_str(&fixture_toml).expect("fixture TOML parses");
    let usdc = parsed
        .get("usdc_address")
        .and_then(|v| v.as_str())
        .expect("usdc_address field present and is a string");
    assert!(!usdc.is_empty(), "usdc_address must not be empty");
}

/// Step 2: the loaded config drives a real `rmpc self-check` invocation
/// against a mockito JSON-RPC happy-path. Exit zero + `ok=true` is the
/// contract.
#[tokio::test]
async fn dapp_toml_drives_rmpc_self_check_to_success() {
    let fixture_toml =
        std::fs::read_to_string(FIXTURE_PATH).expect("fixture present at known path");

    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;

    let tmp = TempDir::new().unwrap();
    let keystore_path = tmp.path().join("agent.keystore.json");
    SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
        .expect("create keystore for self-check");

    let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));
    let patched =
        patch_fixture_for_test(&fixture_toml, &server.url(), &keystore_path, &runtime_hash);

    let config_path = tmp.path().join("rmpc.toml");
    std::fs::write(&config_path, &patched).expect("write patched config");

    // Sanity: the on-disk file also loads directly.
    Config::from_path(&config_path).expect("Config::from_path accepts the dapp-exported config");

    let out = rmpc_bin()
        .env(
            PASSPHRASE_ENV_VAR,
            std::str::from_utf8(TEST_PASSPHRASE).unwrap(),
        )
        .args(["self-check", "--config", config_path.to_str().unwrap()])
        .assert()
        .success()
        .get_output()
        .clone();

    let stdout = String::from_utf8(out.stdout).unwrap();
    let v: Value = serde_json::from_str(stdout.trim()).expect("self-check stdout is JSON");
    assert_eq!(v["ok"], true, "round-trip self-check must report ok=true");
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(v["selected_backend"], "software");
    assert_eq!(v["checks"]["chain_id_match"], true);
    assert_eq!(v["checks"]["gateway_code_hash_match"], true);
    assert_eq!(v["checks"]["agent_active"], true);
    assert_eq!(v["checks"]["gateway_paused"], false);
}

/// Negative drift-detector test: renaming a required flat field in the fixture
/// causes `Config::from_str` to fail. This is the mechanical check that
/// enforces the schema contract described in the issue.
#[test]
fn renamed_required_field_fails_direct_load() {
    let fixture_toml =
        std::fs::read_to_string(FIXTURE_PATH).expect("fixture present at known path");

    // Rename gateway_address → gateway_addr (rmpc expects gateway_address).
    let mutated = fixture_toml.replace("gateway_address", "gateway_addr");

    // Config::from_str must fail because gateway_address is missing and
    // gateway_addr is unknown (deny_unknown_fields).
    let result = Config::from_str(&mutated);
    assert!(
        result.is_err(),
        "renaming a required field must break Config::from_str"
    );

    // Suppress unused-import diag in some toolchains.
    let _ = SHARE_RECEIVER;
    let _ = (
        match_eth_call_selector,
        jrpc_result,
        enc_bool,
        selector_hex_of::<RobotMoneyGateway::pausedCall>,
        json!({}),
        Matcher::Any,
    );
}
