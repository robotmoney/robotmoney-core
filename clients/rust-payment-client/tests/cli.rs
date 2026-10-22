//! Canonical: none — integration tests for the rmpc clap argument parser
//!
//! Integration tests for the `rmpc` CLI binary's argument parser.
//!
//! Each subcommand has its own dedicated integration target
//! (`cli_self_check`, `cli_status`, `cli_deposit`) that exercises the
//! happy-path JSON shape end-to-end. This file covers the small, fast
//! parser-level guarantees that don't need an RPC fixture.

use assert_cmd::Command;
use predicates::str::contains;

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

// ------------------------------------------------------------------
// Retired commands and options (issue 1889): clap rejects them before any I/O
// ------------------------------------------------------------------

#[test]
fn withdraw_and_withdraw_router_are_retired_subcommands() {
    for retired in ["withdraw", "withdraw-router"] {
        rmpc()
            .args([retired, "--config", "/nonexistent.toml"])
            .assert()
            .failure()
            .code(2)
            .stderr(contains("unrecognized subcommand"));
    }
}

#[test]
fn rmpc_help_lists_no_withdraw_command() {
    let out = rmpc().arg("--help").assert().success().get_output().clone();
    let s = String::from_utf8(out.stdout).unwrap();
    assert!(s.contains("deposit"), "{s}");
    assert!(!s.contains("withdraw"), "{s}");
}

#[test]
fn deposit_rejects_the_router_options() {
    for opt in [
        [
            "--destination",
            "0x0000000000000000000000000000000000000f00",
        ],
        ["--min-shares-per-leg", "1"],
        ["--allow-unavailable-legs", "x"],
    ] {
        rmpc()
            .args([
                "deposit",
                "--config",
                "/nonexistent.toml",
                "--amount",
                "1",
                "--order-id",
                "0x0000000000000000000000000000000000000000000000000000000000000001",
            ])
            .args(opt)
            .assert()
            .failure()
            .code(2)
            .stderr(contains("unexpected argument"));
    }
}

#[test]
fn deposit_subcommand_requires_config_amount_and_order_id() {
    // No flags at all — clap must reject before any I/O.
    rmpc()
        .args(["deposit"])
        .assert()
        .failure()
        .stderr(contains("--config"))
        .stderr(contains("--amount"))
        .stderr(contains("--order-id"));
}

#[test]
fn deposit_help_includes_idempotency_and_deadline_flags() {
    // Operator-discoverability: the optional flags must be in `--help`
    // output so a fresh user can find them without grepping the source.
    let out = rmpc()
        .args(["deposit", "--help"])
        .assert()
        .success()
        .get_output()
        .clone();
    let s = String::from_utf8(out.stdout).unwrap();
    assert!(s.contains("--idempotency-key"), "{s}");
    assert!(s.contains("--deadline-secs"), "{s}");
    assert!(s.contains("--receipt-timeout-secs"), "{s}");
    assert!(s.contains("--gas-limit"), "{s}");
    assert!(s.contains("--vault"), "{s}");
    assert!(s.contains("--pretty"), "{s}");
}

// ------------------------------------------------------------------
// rmpc-keystore-import helper (QA plan U7, finding DR-11)
// ------------------------------------------------------------------

/// Anvil/hardhat default account #1 key. NEVER use on a real chain.
const IMPORT_TEST_PRIVKEY_HEX: &str =
    "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

fn keystore_import() -> Command {
    Command::cargo_bin("rmpc-keystore-import").expect("rmpc-keystore-import binary built")
}

/// `RMPC_KEYSTORE_PASSPHRASE=""` used to encrypt the key under a key anyone
/// can derive. The helper must refuse it as bad input (exit 2), say why on
/// stderr, and write no keystore.
#[test]
fn keystore_import_rejects_empty_passphrase() {
    let tmp = tempfile::TempDir::new().unwrap();
    let out_path = tmp.path().join("agent.keystore.json");

    keystore_import()
        .env("RMPC_IMPORT_PRIVKEY_HEX", IMPORT_TEST_PRIVKEY_HEX)
        .env("RMPC_KEYSTORE_PASSPHRASE", "")
        .arg(&out_path)
        .assert()
        .code(2)
        .stdout("")
        .stderr(contains("RMPC_KEYSTORE_PASSPHRASE"))
        .stderr(contains("empty"));

    assert!(
        !out_path.exists(),
        "no keystore may be written under an empty passphrase"
    );
}

/// The keystore the helper writes is owner-only (0600), not the process
/// umask's 0644, and the helper prints the address it encrypted.
#[cfg(unix)]
#[test]
fn keystore_import_writes_owner_only_keystore() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::TempDir::new().unwrap();
    let out_path = tmp.path().join("agent.keystore.json");

    let out = keystore_import()
        .env("RMPC_IMPORT_PRIVKEY_HEX", IMPORT_TEST_PRIVKEY_HEX)
        .env("RMPC_KEYSTORE_PASSPHRASE", "correct horse battery staple")
        .arg(&out_path)
        .assert()
        .success()
        .get_output()
        .clone();

    let addr = String::from_utf8(out.stdout).unwrap();
    assert_eq!(
        addr.trim().to_lowercase(),
        "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
    );
    let mode = std::fs::metadata(&out_path)
        .expect("keystore written")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "keystore mode {mode:o}");
}
