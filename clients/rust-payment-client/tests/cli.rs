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
    assert!(s.contains("--pretty"), "{s}");
}
