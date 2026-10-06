//! Integration tests for the Twin chain environment steps (core 1498, 1496): fund USDC, fund gas, warp.
//!
//! The Twin chain is a pinned lazy fork of real Base state. USDC is the real FiatToken: funding sets
//! the real `balanceAndBlacklistStates` slot, so the token's own `balanceOf` and `transfer` code
//! sees the balance. This is an environment step that may differ from production, and it is
//! the only way a test gets USDC.
//!
//!  1. `fund_usdc` raises the recipient's balance by the exact amount (a grant, not an overwrite).
//!  2. The funded balance spends through the real token's `transfer` (no cheat on the spend side).
//!  3. `fund_gas` sets the native balance exactly.
//!  4. The chain is the Twin chain: id 918453, an anvil fork, not Base mainnet.
//!  5. `warp` moves block time forward by at least the requested seconds, no real waiting.
//!
//! Run with a Twin fork reachable (TWIN_RPC_URL) or let the harness start one:
//!   cargo test -p smoke-test --release --test fund_usdc -- --test-threads=1 --nocapture

use alloy_primitives::{Address, U256};
use smoke_test::{prerequisites_available, Fixture};

fn skip_if_no_prereqs(name: &str) -> bool {
    if !prerequisites_available() {
        eprintln!("[{name}] anvil/bun/forge/cast not on PATH; skipping.");
        return true;
    }
    false
}

fn fixture() -> &'static Fixture {
    use std::sync::OnceLock;
    static CELL: OnceLock<Fixture> = OnceLock::new();
    CELL.get_or_init(|| Fixture::new().expect("smoke-test fixture boot failed"))
}

#[test]
fn fund_usdc_increases_recipient_balance_by_the_exact_amount() {
    if skip_if_no_prereqs("fund_usdc_increases_recipient_balance_by_the_exact_amount") {
        return;
    }
    let fx = fixture();
    let recipient = fx.agent();
    let amount: u128 = 12_345_678; // 12.345678 USDC (6-dp)

    let before = usdc_balance_of(fx, recipient);
    let after_reported = fx.fund_usdc(recipient, amount).expect("fund_usdc");
    let after = usdc_balance_of(fx, recipient);
    assert_eq!(
        after,
        before + U256::from(amount),
        "recipient USDC balance did not grow by the exact amount"
    );
    assert_eq!(
        U256::from(after_reported),
        after,
        "fund_usdc must report the new balance"
    );
}

#[test]
fn funded_usdc_spends_through_the_real_token_transfer() {
    if skip_if_no_prereqs("funded_usdc_spends_through_the_real_token_transfer") {
        return;
    }
    let fx = fixture();
    let to: Address = "0x00000000000000000000000000000000000000a1"
        .parse()
        .unwrap();
    let amount: u128 = 3_000_000;
    fx.fund_usdc(fx.agent(), amount).expect("fund_usdc");
    let before = usdc_balance_of(fx, to);
    let agent_pk = format!("0x{}", hex::encode(smoke_test::AGENT_PRIVATE_KEY));
    fx.cast_send(
        &agent_pk,
        fx.usdc(),
        "transfer(address,uint256)",
        &[&format!("{to:#x}"), &amount.to_string()],
    )
    .expect("real USDC transfer from the funded agent");
    assert_eq!(usdc_balance_of(fx, to), before + U256::from(amount));
}

#[test]
fn fund_gas_sets_the_native_balance_exactly() {
    if skip_if_no_prereqs("fund_gas_sets_the_native_balance_exactly") {
        return;
    }
    let fx = fixture();
    let who: Address = "0x00000000000000000000000000000000000000b2"
        .parse()
        .unwrap();
    let wei: u128 = 3_500_000_000_000_000_000; // 3.5 ETH
    fx.fund_gas(who, wei).expect("fund_gas");
    let raw: String = rpc_call(
        fx.rpc_url(),
        "eth_getBalance",
        serde_json::json!([format!("{who:#x}"), "latest"]),
    );
    assert_eq!(
        U256::from_str_radix(raw.trim_start_matches("0x"), 16).unwrap(),
        U256::from(wei)
    );
}

#[test]
fn chain_is_the_twin_fork_not_base_mainnet() {
    if skip_if_no_prereqs("chain_is_the_twin_fork_not_base_mainnet") {
        return;
    }
    let fx = fixture();
    let id: String = rpc_call(fx.rpc_url(), "eth_chainId", serde_json::json!([]));
    assert_eq!(
        u64::from_str_radix(id.trim_start_matches("0x"), 16).unwrap(),
        918_453
    );
    let version: String = rpc_call(fx.rpc_url(), "web3_clientVersion", serde_json::json!([]));
    assert!(
        version.to_lowercase().contains("anvil"),
        "expected an anvil fork, got {version:?}"
    );
    // Real Base state: the real USDC token answers symbol().
    let sym: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([{"to": format!("{:#x}", fx.usdc()), "data": "0x95d89b41"}, "latest"]),
    );
    assert!(
        sym.to_lowercase().contains("55534443"),
        "USDC symbol() not returned: {sym}"
    );
}

#[test]
fn warp_moves_block_time_without_waiting() {
    if skip_if_no_prereqs("warp_moves_block_time_without_waiting") {
        return;
    }
    let fx = fixture();
    let t0 = head_timestamp(fx);
    let started = std::time::Instant::now();
    fx.warp(48 * 3600).expect("warp 48h");
    let t1 = head_timestamp(fx);
    assert!(
        t1 >= t0 + 48 * 3600,
        "head timestamp {t1} did not move 48h past {t0}"
    );
    assert!(
        started.elapsed().as_secs() < 60,
        "warp must not wait in real time"
    );
}

// -- helpers -----------------------------------------------------------------

fn head_timestamp(fx: &Fixture) -> u64 {
    let b: serde_json::Value = rpc_call(
        fx.rpc_url(),
        "eth_getBlockByNumber",
        serde_json::json!(["latest", false]),
    );
    let ts = b
        .get("timestamp")
        .and_then(|v| v.as_str())
        .expect("timestamp");
    u64::from_str_radix(ts.trim_start_matches("0x"), 16).unwrap()
}

fn usdc_balance_of(fx: &Fixture, holder: Address) -> U256 {
    // balanceOf(address) selector = 0x70a08231
    let mut data = String::from("0x70a08231");
    data.push_str(&format!("{:0>64}", format!("{:x}", holder)));
    let raw: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.usdc()), "data": data},
            "latest"
        ]),
    );
    U256::from_str_radix(raw.trim_start_matches("0x"), 16).unwrap_or(U256::ZERO)
}

fn rpc_call<T: for<'de> serde::Deserialize<'de>>(
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> T {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap();
    let body = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    let resp: serde_json::Value = client
        .post(url)
        .json(&body)
        .send()
        .expect("RPC request failed")
        .json()
        .expect("RPC response is not JSON");
    serde_json::from_value(
        resp.get("result")
            .unwrap_or_else(|| panic!("no result field: {resp}"))
            .clone(),
    )
    .expect("RPC result decode failed")
}
