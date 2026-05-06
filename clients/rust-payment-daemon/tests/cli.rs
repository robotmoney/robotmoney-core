//! Integration tests for the `rmpd` CLI subcommands that are still stubs.
//!
//! `self-check` (issue #15) and `status` (issue #15) have their own test
//! files. `deposit` remains a stub until issue #16 lands; this file exists
//! to keep that contract green.

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
