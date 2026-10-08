//! Canonical: docs/technical/security-model.md §4 — Timelock bypass → Mitigated; §16 (rmpc CLI
//! integration tests: no mocking)
//! Implements: issue #420 — test pyramid for on-chain timelocked multisig; issue #1647 — no mocks
//!
//! Offline test for `rmpc get-timelock` (issue #414 / #420).
//!
//! Only the startup-failure path lives here: it needs no chain and fakes nothing. The data path
//! (proposers, executors, minDelay, pending operations) runs against the REAL Safe and timelock on
//! the Twin chain in `testing/fork-e2e-rust/tests/rmpc_get_timelock_fork.rs`. The mock JSON-RPC fixture
//! with a fake Safe that used to be here is gone, because security-model §16 forbids mocking in
//! rmpc integration tests.
//!
//! Coverage:
//! - Missing `timelock_address` in config → `EXIT_STARTUP_FAIL`.

use assert_cmd::Command;
use rust_payment_client::signer::software::SoftwareSigner;
use tempfile::TempDir;

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
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
