//! Canonical: docs/implementation-plan.md §9 — fork test for
//! `rmpc get-deposit`. Issue #50, negative-path acceptance criterion
//! ("unknown deposit id … produces typed errors").
//!
//! The fork harness does not deploy a Robot Money gateway (the
//! gateway is a v0 component that does not yet have a Base
//! deployment), so this fork test exercises the not-found path
//! against the configured gateway address: an arbitrary deposit id
//! cannot have a matching `AgentDeposit` log against an empty
//! contract address, so `rmpc get-deposit` must exit 4
//! (`ErrDepositNotFound`).

mod rmpc_bin;

use std::process::Command;

use alloy_primitives::{Address, U256};
use rmpc_fork_e2e::{addresses, skip_if_no_fork, ForkFixture};
use tempfile::TempDir;

#[test]
fn rmpc_get_deposit_unknown_id_against_fork() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[rmpc_get_deposit_fork] {}", fx.summary_line());

    // A non-contract address has no AgentDeposit logs, ever — we
    // only need the fork RPC to actually answer eth_getLogs.
    let dummy_gateway = Address::ZERO;
    let _ = U256::ZERO; // silence unused import in trimmed builds

    let tmp = TempDir::new().expect("tempdir");
    let cfg = rmpc_bin::write_config(
        tmp.path(),
        &fx.rpc_url,
        rmpc_fork_e2e::BASE_CHAIN_ID,
        addresses::USDC,
        dummy_gateway,
    );

    let out = Command::new(rmpc_bin::rmpc_path())
        .args([
            "get-deposit",
            "--config",
            cfg.to_str().unwrap(),
            "--deposit-id",
            "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ])
        .output()
        .expect("spawn rmpc");
    assert_eq!(
        out.status.code(),
        Some(4),
        "rmpc get-deposit must exit 4 for unknown id (got {:?}): stderr={}",
        out.status,
        String::from_utf8_lossy(&out.stderr),
    );
}
