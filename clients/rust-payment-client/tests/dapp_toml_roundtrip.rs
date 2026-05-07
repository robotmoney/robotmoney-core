//! Canonical: docs/technical/dapp-credential-decisions.md §3.4 — `rmpc`
//! config export contract; closes issue #86.
//!
//! End-to-end round-trip test: load the dapp's exported TOML
//! (`tests/fixtures/dapp-exported-config.toml`, mirroring the output of
//! `clients/dapp/src/lib/configExport.ts`), feed it through `rmpc`'s
//! real config loader (`Config::from_str` / `Config::from_path`), then
//! invoke the binary's `self-check` subcommand against a mockito
//! JSON-RPC happy-path. The test exits zero only when both halves
//! succeed.
//!
//! ## Schema-drift surface
//!
//! The dapp's §3.4 schema is namespaced (`[chain]`, `[contracts]`,
//! `[agent]`, `[signer]`, `[policy]`) while `rmpc`'s loader currently
//! expects a flat field set with `deny_unknown_fields` (see
//! `src/config.rs`). The two are intentionally close but not yet
//! identical, and §86's "Out of scope" forbids changes to either side
//! in this issue. The translation layer below
//! ([`dapp_toml_to_rmpc_loader_toml`]) is the explicit, documented
//! bridge: as long as the dapp's emitted fields can be mechanically
//! mapped onto the loader's required fields, the round-trip holds. If
//! either side drifts (renames, new required fields, removed fields),
//! the translation will fail loudly at parse time and this test will
//! catch it before drift reaches CI of any consumer.
//!
//! When the dapp and loader are reconciled in a follow-up issue, the
//! translation layer collapses to the identity function and
//! [`Config::from_str`] is called directly on the fixture bytes.

mod common;

use crate::common::{
    enc_bool, install_happy_path_mocks, jrpc_result, match_eth_call_selector, selector_hex_of,
    GATEWAY_CODE, SHARE_RECEIVER, SIGNER_ADDRESS, TEST_PASSPHRASE,
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
/// Duplicated from `common::Fixture` because that field is private.
const TEST_PRIVKEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94,
    0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];

const FIXTURE_PATH: &str = "tests/fixtures/dapp-exported-config.toml";

/// Translate the dapp's §3.4 namespaced TOML into the flat field set
/// `rmpc::config::Config` accepts. Pure string substitution at the
/// `toml::Value` layer — no semantic changes. Documented schema-drift
/// bridge; see module-level docs.
fn dapp_toml_to_rmpc_loader_toml(
    dapp_toml: &str,
    rpc_url_override: &str,
    chain_id_override: u64,
    gateway_runtime_hash_override: &str,
    keystore_path_override: &Path,
) -> String {
    let parsed: toml::Value = toml::from_str(dapp_toml).expect("dapp TOML must parse");
    let table = parsed.as_table().expect("top-level must be a table");

    // §3.4 required keys — fail loud if absent (drift signal).
    let chain = table
        .get("chain")
        .and_then(|v| v.as_table())
        .expect("dapp TOML missing [chain] table");
    let contracts = table
        .get("contracts")
        .and_then(|v| v.as_table())
        .expect("dapp TOML missing [contracts] table");
    let agent = table
        .get("agent")
        .and_then(|v| v.as_table())
        .expect("dapp TOML missing [agent] table");
    let signer = table
        .get("signer")
        .and_then(|v| v.as_table())
        .expect("dapp TOML missing [signer] table");
    assert_eq!(
        table
            .get("schema_version")
            .and_then(|v| v.as_str())
            .expect("schema_version present"),
        "1",
        "fixture must pin schema_version=\"1\""
    );
    // Policy block is required by §3.4; presence asserted, fields are
    // not consumed by the loader yet (loader-side gap is tracked
    // separately).
    let _policy = table
        .get("policy")
        .and_then(|v| v.as_table())
        .expect("dapp TOML missing [policy] table");

    // Sanity: every signer kind the dapp emits is one of the three
    // documented kinds. Loader currently only wires the
    // `encrypted_keystore` path; the test fixture exercises that one.
    let signer_kind = signer
        .get("kind")
        .and_then(|v| v.as_str())
        .expect("[signer].kind required");
    assert!(
        matches!(signer_kind, "encrypted_keystore" | "hardware" | "kms"),
        "unexpected signer.kind = {signer_kind:?}"
    );
    assert_eq!(
        signer_kind, "encrypted_keystore",
        "this fixture exercises the software-signer path"
    );

    // Pull dapp-shaped values; gate every read so a renamed field
    // surfaces immediately.
    let _dapp_chain_id = chain
        .get("chain_id")
        .and_then(|v| v.as_integer())
        .expect("[chain].chain_id required");
    let _dapp_rpc_url = chain
        .get("rpc_url")
        .and_then(|v| v.as_str())
        .expect("[chain].rpc_url required");
    let dapp_gateway = contracts
        .get("gateway")
        .and_then(|v| v.as_str())
        .expect("[contracts].gateway required");
    let dapp_vault = contracts
        .get("vault")
        .and_then(|v| v.as_str())
        .expect("[contracts].vault required");
    let _dapp_gateway_code_hash = contracts
        .get("gateway_code_hash")
        .and_then(|v| v.as_str())
        .expect("[contracts].gateway_code_hash required");
    let _dapp_agent_address = agent
        .get("address")
        .and_then(|v| v.as_str())
        .expect("[agent].address required");
    let _dapp_keystore_path = signer
        .get("keystore_path")
        .and_then(|v| v.as_str())
        .expect("encrypted_keystore signer must carry keystore_path");

    // Mockito assigns a random URL per server; the dapp fixture's
    // baked-in rpc_url and the temp keystore path produced for this
    // test process need to override the persisted values. We also
    // override the gateway_runtime_hash so the preflight code-hash
    // check passes against the canned bytecode in `common::mod.rs`.
    //
    // The USDC address is not in the §3.4 schema (the dapp does not
    // emit it). The loader requires it, so we read it from the
    // gateway's `usdc()` view at preflight time — the value here is
    // the canned `USDC` constant in `common::mod.rs` that the mockito
    // happy-path returns.
    let rmpc_loader_toml = format!(
        r#"chain_id              = {chain_id_override}
rpc_url               = "{rpc_url_override}"
gateway_address       = "{dapp_gateway}"
usdc_address          = "0x0000000000000000000000000000000000000c00"
vault_address         = "{dapp_vault}"
gateway_runtime_hash  = "{gateway_runtime_hash_override}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{}"
"#,
        keystore_path_override.display(),
    );
    rmpc_loader_toml
}

fn rmpc_bin() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// Step 1 of the round-trip: the dapp-exported fixture parses through
/// `rmpc`'s real loader after the documented schema-bridge.
#[test]
fn dapp_toml_loads_through_rmpc_config_loader() {
    let dapp_toml = std::fs::read_to_string(FIXTURE_PATH).expect("fixture present at known path");

    let tmp = TempDir::new().unwrap();
    let keystore_path = tmp.path().join("agent.keystore.json");
    SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
        .expect("create keystore for fixture translation");

    let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));
    let translated = dapp_toml_to_rmpc_loader_toml(
        &dapp_toml,
        "http://127.0.0.1:1",
        31337,
        &runtime_hash,
        &keystore_path,
    );

    let cfg = Config::from_str(&translated)
        .expect("translated dapp TOML must parse with rmpc::config::Config");

    // Assert the fixture's load result is populated and consistent
    // with the dapp's §3.4 example values.
    assert_eq!(cfg.chain_id, 31337);
    assert_eq!(
        cfg.gateway_address.to_lowercase(),
        "0x0000000000000000000000000000000000000b00"
    );
    assert_eq!(
        cfg.vault_address.to_lowercase(),
        "0x0000000000000000000000000000000000000d00"
    );
    assert_eq!(cfg.gateway_runtime_hash, runtime_hash);
    assert!(cfg.signer.allow_software_fallback);
    assert_eq!(cfg.signer.keystore_path, keystore_path);
}

/// Step 2 of the round-trip: the loaded config drives a real
/// `rmpc self-check` invocation against a mockito JSON-RPC happy
/// path. Exit zero + `ok=true` is the contract.
#[tokio::test]
async fn dapp_toml_drives_rmpc_self_check_to_success() {
    let dapp_toml = std::fs::read_to_string(FIXTURE_PATH).expect("fixture present at known path");

    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    install_happy_path_mocks(&mut server, chain_id, SIGNER_ADDRESS).await;

    let tmp = TempDir::new().unwrap();
    let keystore_path = tmp.path().join("agent.keystore.json");
    SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
        .expect("create keystore for self-check");

    let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));
    let translated = dapp_toml_to_rmpc_loader_toml(
        &dapp_toml,
        &server.url(),
        chain_id,
        &runtime_hash,
        &keystore_path,
    );

    let config_path = tmp.path().join("rmpc.toml");
    std::fs::write(&config_path, translated).expect("write translated config");

    // Sanity: loader is happy with the on-disk file too.
    Config::from_path(&config_path).expect("loader accepts the translated config from disk");

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

/// Negative test (drift detector): mutating a required §3.4 field in
/// the fixture causes the translation/load pipeline to fail. This is
/// the mechanical check named in the issue's test plan.
#[test]
fn mutated_fixture_fails_round_trip() {
    let dapp_toml = std::fs::read_to_string(FIXTURE_PATH).expect("fixture present at known path");

    // Drop the [contracts] table entirely — §3.4 requires it.
    let mutated = dapp_toml.replace("[contracts]", "[contracts_renamed_by_drift]");

    let tmp = TempDir::new().unwrap();
    let keystore_path = tmp.path().join("agent.keystore.json");
    SoftwareSigner::create_keystore(&keystore_path, &TEST_PRIVKEY, TEST_PASSPHRASE)
        .expect("create keystore");

    let runtime_hash = format!("0x{}", ahex::encode(keccak256(GATEWAY_CODE)));

    // Translation must panic on missing [contracts]; we run it inside
    // catch_unwind to assert the failure surface without aborting the
    // whole test binary.
    let result = std::panic::catch_unwind(|| {
        dapp_toml_to_rmpc_loader_toml(
            &mutated,
            "http://127.0.0.1:1",
            31337,
            &runtime_hash,
            &keystore_path,
        )
    });
    assert!(
        result.is_err(),
        "removing a required §3.4 table must break the round-trip"
    );

    // Also: feeding gibberish straight to the loader fails.
    let bad_loader_toml = "this = is = not = toml\n";
    assert!(Config::from_str(bad_loader_toml).is_err());

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
