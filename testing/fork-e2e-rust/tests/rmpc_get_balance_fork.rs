//! Canonical: docs/implementation-plan.md §9 — fork test for
//! `rmpc get-balance`. Implements the issue #50 acceptance criterion
//! "Fork tests cover every command against pinned contracts".
//!
//! Boots an anvil-fork against Base mainnet and shells out to the
//! `rmpc get-balance` binary, asserting the JSON envelope shape and
//! that the on-chain USDC balance round-trips through the read
//! command.

mod rmpc_bin;

use std::process::Command;

use alloy_primitives::{Address, U256};
use rmpc_fork_e2e::{addresses, scenarios, skip_if_no_fork, ForkFixture, IERC20};
use serde_json::Value;
use tempfile::TempDir;

const FUND_USDC: u64 = 7_777_777; // 7.777777 USDC (6 decimals)

// TODO(#249): fork fixture USDC proxy-admin collision -- see #249.
#[test]
#[ignore = "blocked on #249: fork fixture USDC proxy-admin collision"]
fn rmpc_get_balance_against_fork() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[rmpc_get_balance_fork] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let user = fx
        .ephemeral(one_eth, U256::from(FUND_USDC))
        .expect("fund ephemeral");

    // Sanity check via direct ABI: the funded balance is what we asked.
    let raw = scenarios::usdc_read_u256(
        &fx,
        &user,
        &IERC20::balanceOfCall {
            account: user.address,
        },
    )
    .expect("USDC.balanceOf");
    assert_eq!(raw, U256::from(FUND_USDC), "fork funding drift");

    // Now drive the rmpc CLI against the same fork and the same address.
    let tmp = TempDir::new().expect("tempdir");
    let cfg = rmpc_bin::write_config(
        tmp.path(),
        &fx.rpc_url,
        rmpc_fork_e2e::BASE_CHAIN_ID,
        addresses::USDC,
        Address::ZERO,
    );

    let out = Command::new(rmpc_bin::rmpc_path())
        .args([
            "get-balance",
            "--config",
            cfg.to_str().unwrap(),
            "--address",
            &format!("{:#x}", user.address),
        ])
        .output()
        .expect("spawn rmpc");
    assert!(
        out.status.success(),
        "rmpc get-balance failed: status={:?}\nstdout={}\nstderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );

    let v: Value = serde_json::from_slice(&out.stdout).expect("rmpc stdout is JSON");
    assert_eq!(v["chain_id"], rmpc_fork_e2e::BASE_CHAIN_ID);
    assert_eq!(v["source"], "json_rpc");
    assert_eq!(v["partial"], false);
    assert!(v["errors"].as_array().unwrap().is_empty());
    assert_eq!(
        v["data"]["address"].as_str().unwrap().to_lowercase(),
        format!("{:#x}", user.address)
    );
    assert_eq!(
        v["data"]["token"].as_str().unwrap().to_lowercase(),
        format!("{:#x}", addresses::USDC)
    );
    // §9 contract: balance is a decimal string equal to the funded amount.
    assert_eq!(v["data"]["balance"], FUND_USDC.to_string());
}
