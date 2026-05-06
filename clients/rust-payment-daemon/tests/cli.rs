//! Integration tests for the `rmpd` CLI subcommands.
//!
//! Per issue #7 every subcommand must currently exit 0 with the stub JSON
//! payload `{"status":"unimplemented"}` on stdout.

use assert_cmd::Command;
use predicates::str::contains;

fn rmpd() -> Command {
    Command::cargo_bin("rmpd").expect("rmpd binary built")
}

#[test]
fn deposit_subcommand_prints_unimplemented_and_exits_zero() {
    rmpd()
        .args([
            "deposit",
            "--amount",
            "100.00",
            "--order-id",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        ])
        .assert()
        .success()
        .stdout(contains("\"status\":\"unimplemented\""));
}

#[test]
fn status_subcommand_prints_unimplemented_and_exits_zero() {
    rmpd()
        .args([
            "status",
            "--payment-id",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        ])
        .assert()
        .success()
        .stdout(contains("\"status\":\"unimplemented\""));
}

#[test]
fn self_check_subcommand_prints_unimplemented_and_exits_zero() {
    rmpd()
        .arg("self-check")
        .assert()
        .success()
        .stdout(contains("\"status\":\"unimplemented\""));
}
