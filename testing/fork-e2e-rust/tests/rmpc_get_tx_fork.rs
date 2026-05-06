//! Canonical: docs/implementation-plan.md §9 — fork test for
//! `rmpc get-tx`. Issue #50.
//!
//! Sends a no-op USDC `approve(0,0)` transaction on the fork to
//! mint a real receipt, then drives `rmpc get-tx --tx-hash` and
//! asserts the envelope reports `status: success` along with the
//! observed gas and effective gas price. Also asserts that an
//! unknown tx hash produces exit code 4.

mod rmpc_bin;

use std::process::Command;

use alloy_primitives::{Address, U256};
use rmpc_fork_e2e::{addresses, skip_if_no_fork, ForkFixture, IERC20};
use serde_json::Value;
use tempfile::TempDir;

#[test]
fn rmpc_get_tx_against_fork() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[rmpc_get_tx_fork] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let user = fx.ephemeral(one_eth, U256::ZERO).expect("fund ETH");

    // Send a cheap, no-side-effect tx so we have a real receipt on
    // the fork. `approve(spender, 0)` always succeeds and uses
    // bounded gas.
    let receipt = user
        .send(
            addresses::USDC,
            &IERC20::approveCall {
                spender: addresses::VAULT,
                amount: U256::ZERO,
            },
            U256::ZERO,
            120_000,
        )
        .expect("send approve(0)");
    let tx_hash = receipt.tx_hash;

    let tmp = TempDir::new().expect("tempdir");
    let cfg = rmpc_bin::write_config(
        tmp.path(),
        &fx.rpc_url,
        rmpc_fork_e2e::BASE_CHAIN_ID,
        addresses::USDC,
        Address::ZERO,
    );

    // Happy path: known tx hash mints a successful envelope.
    let out = Command::new(rmpc_bin::rmpc_path())
        .args([
            "get-tx",
            "--config",
            cfg.to_str().unwrap(),
            "--tx-hash",
            &format!("{tx_hash:#x}"),
        ])
        .output()
        .expect("spawn rmpc");
    assert!(
        out.status.success(),
        "rmpc get-tx failed: status={:?}\nstdout={}\nstderr={}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );

    let v: Value = serde_json::from_slice(&out.stdout).expect("rmpc stdout is JSON");
    assert_eq!(v["chain_id"], rmpc_fork_e2e::BASE_CHAIN_ID);
    assert_eq!(v["partial"], false);
    let d = &v["data"];
    assert_eq!(d["tx_hash"], format!("{tx_hash:#x}"));
    assert_eq!(d["status"], "success");
    assert!(d["block_number"].as_u64().unwrap() > 0);
    assert_eq!(
        d["from"].as_str().unwrap().to_lowercase(),
        format!("{:#x}", user.address)
    );
    assert_eq!(
        d["to"].as_str().unwrap().to_lowercase(),
        format!("{:#x}", addresses::USDC)
    );
    // Decimal-string contract.
    assert!(d["gas_used"].is_string());
    assert!(d["effective_gas_price"].is_string());
    let gas_used: u128 = d["gas_used"].as_str().unwrap().parse().unwrap();
    assert!(gas_used > 0 && gas_used <= 120_000);

    // Negative path: a hash that nobody has sent must exit 4.
    let unknown = Command::new(rmpc_bin::rmpc_path())
        .args([
            "get-tx",
            "--config",
            cfg.to_str().unwrap(),
            "--tx-hash",
            "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ])
        .output()
        .expect("spawn rmpc (unknown)");
    assert_eq!(
        unknown.status.code(),
        Some(4),
        "rmpc get-tx must exit 4 for unknown tx hash (got {:?}): stderr={}",
        unknown.status,
        String::from_utf8_lossy(&unknown.stderr),
    );
}
