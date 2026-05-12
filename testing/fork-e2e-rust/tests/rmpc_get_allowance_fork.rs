//! Canonical: docs/implementation-plan.md §9 — fork test for
//! `rmpc get-allowance`. Issue #50.
//!
//! Boots an anvil-fork, has the ephemeral user `approve(spender, X)`
//! on real Base USDC, then drives `rmpc get-allowance` and asserts
//! the envelope reports `X` as a decimal string.

mod rmpc_bin;

use std::process::Command;

use alloy_primitives::{Address, U256};
use rmpc_fork_e2e::{addresses, skip_if_no_fork, ForkFixture, IERC20};
use serde_json::Value;
use tempfile::TempDir;

const APPROVAL_AMOUNT: u64 = 11_223_344;

// Fixed in #249: the fork fixture writes a non-zero sentinel into the Base
// USDC transparent-proxy admin slot during `ForkFixture::new`, so the
// default `from: address(0)` used by rmpc's `eth_call` no longer collides
// with the admin and reverts. rmpc continues to call with `from: None`.
#[test]
fn rmpc_get_allowance_against_fork() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[rmpc_get_allowance_fork] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let owner = fx.ephemeral(one_eth, U256::ZERO).expect("fund ETH");
    // Use the canonical vault address as the spender (any address
    // works — what matters is that allowance round-trips through
    // rmpc).
    let spender = addresses::VAULT;

    let amount = U256::from(APPROVAL_AMOUNT);
    owner
        .send(
            addresses::USDC,
            &IERC20::approveCall { spender, amount },
            U256::ZERO,
            120_000,
        )
        .expect("USDC.approve");

    let tmp = TempDir::new().expect("tempdir");
    let cfg = rmpc_bin::write_config(
        tmp.path(),
        &fx.rpc_url,
        rmpc_fork_e2e::BASE_CHAIN_ID,
        addresses::USDC,
        Address::ZERO,
    );

    let log_dir = tmp.path().join("rmpc-logs");
    let out = Command::new(rmpc_bin::rmpc_path())
        .args([
            "get-allowance",
            "--config",
            cfg.to_str().unwrap(),
            "--owner",
            &format!("{:#x}", owner.address),
            "--spender",
            &format!("{spender:#x}"),
        ])
        .env("RMPC_LOG_DIR", &log_dir)
        .env("RMPC_LOG_LEVEL", "error")
        .output()
        .expect("spawn rmpc");
    let log_content = std::fs::read_dir(&log_dir)
        .ok()
        .and_then(|mut d| d.next())
        .and_then(|e| e.ok())
        .and_then(|e| std::fs::read_to_string(e.path()).ok())
        .unwrap_or_default();
    assert!(
        out.status.success(),
        "rmpc get-allowance failed: status={:?}\nstdout={}\nstderr={}\nrmpc_log={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
        log_content,
    );

    let v: Value = serde_json::from_slice(&out.stdout).expect("rmpc stdout is JSON");
    assert_eq!(v["chain_id"], rmpc_fork_e2e::BASE_CHAIN_ID);
    assert_eq!(v["partial"], false);
    assert_eq!(
        v["data"]["owner"].as_str().unwrap().to_lowercase(),
        format!("{:#x}", owner.address)
    );
    assert_eq!(
        v["data"]["spender"].as_str().unwrap().to_lowercase(),
        format!("{spender:#x}")
    );
    assert_eq!(v["data"]["allowance"], APPROVAL_AMOUNT.to_string());
}
