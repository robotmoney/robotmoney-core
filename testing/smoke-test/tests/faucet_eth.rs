//! Smoke-test for the native Base ETH faucet drip round-trip (issue #466).
//!
//! Verifies:
//!   1. The harness EOA holds non-zero native ETH at devnet boot (the
//!      precondition for any ETH drip preflight in the dapp).
//!   2. `Fixture::fund_eth_from_harness` performs a real signed value
//!      transfer and the recipient's native balance increases by the
//!      exact amount — same code path the dapp's `dripEth` exercises.
//!
//! Run with:
//!   cargo test -p smoke-test -- faucet_eth --test-threads=1 --nocapture
//!
//! Canonical: docs/architecture.md §5.3 — Human Dapp (faucet UX)

use alloy_primitives::{Address, U256};
use smoke_test::{prerequisites_available, Fixture, HARNESS_USDC_HOLDER_ADDRESS_HEX};

fn skip_if_no_prereqs(name: &str) -> bool {
    if !prerequisites_available() {
        eprintln!("[{name}] docker/forge/cast not on PATH; skipping.");
        return true;
    }
    false
}

fn fixture() -> &'static Fixture {
    use std::sync::OnceLock;
    static CELL: OnceLock<Fixture> = OnceLock::new();
    CELL.get_or_init(|| Fixture::new().expect("smoke-test fixture boot failed"))
}

fn eth_balance(fx: &Fixture, holder: Address) -> U256 {
    let raw: String = rpc_call(
        fx.rpc_url(),
        "eth_getBalance",
        serde_json::json!([format!("{holder:#x}"), "latest"]),
    );
    U256::from_str_radix(raw.trim_start_matches("0x"), 16).unwrap_or(U256::ZERO)
}

#[test]
fn harness_holds_nonzero_native_eth_at_boot() {
    if skip_if_no_prereqs("harness_holds_nonzero_native_eth_at_boot") {
        return;
    }
    let fx = fixture();
    let harness: Address = HARNESS_USDC_HOLDER_ADDRESS_HEX.parse().unwrap();
    let balance = eth_balance(fx, harness);
    assert!(
        balance > U256::ZERO,
        "harness EOA should hold a non-zero native ETH balance at boot, got 0"
    );
}

#[test]
fn faucet_eth_drip_increases_recipient_balance_by_exact_amount() {
    if skip_if_no_prereqs("faucet_eth_drip_increases_recipient_balance_by_exact_amount") {
        return;
    }
    let fx = fixture();
    let recipient = fx.agent();
    // 0.01 ETH — mirrors FAUCET_DRIP_AMOUNT_ETH in chainClassifier.ts.
    let amount_wei = "10000000000000000";

    let before = eth_balance(fx, recipient);
    let tx_hash = fx
        .fund_eth_from_harness(recipient, amount_wei)
        .expect("fund_eth_from_harness");
    assert!(
        tx_hash.starts_with("0x") && tx_hash.len() == 66,
        "tx_hash {tx_hash:?}"
    );
    let after = eth_balance(fx, recipient);
    let amount = U256::from_str_radix(amount_wei, 10).unwrap();
    assert_eq!(
        after,
        before + amount,
        "recipient native balance did not grow by exact FAUCET_DRIP_AMOUNT_ETH"
    );
}

fn rpc_call<T: for<'de> serde::Deserialize<'de>>(
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> T {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let body = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    client
        .post(url)
        .json(&body)
        .send()
        .expect("RPC request failed")
        .json::<serde_json::Value>()
        .expect("RPC response is not JSON")
        .get("result")
        .and_then(|r| serde_json::from_value(r.clone()).ok())
        .expect("no result field in RPC response")
}
