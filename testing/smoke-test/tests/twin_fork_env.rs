//! The Twin chain environment steps, driven straight through `TwinFork` (core 1498, 1496): fund gas,
//! fund USDC and warp. No publish run and no vault: this proves the three steps that may differ from
//! production, on the real Base USDC token, before any suite relies on them.
//!
//! Needs a running Twin fork (the CI action `.github/actions/twin-fork` exports `TWIN_RPC_URL`), so it
//! reports a loud SKIP line without one rather than starting a fork that would outlive the test
//! process (Rust never drops a static fixture). CI always sets `TWIN_RPC_URL`.
//!
//!   bun scripts/devnet/twin-fork.ts start --port 8545
//!   TWIN_RPC_URL=http://127.0.0.1:8545 cargo test -p smoke-test --release --test twin_fork_env -- --test-threads=1

use smoke_test::twin_fork::{TwinFork, BASE_USDC_ADDR, TWIN_CHAIN_ID, TWIN_RPC_URL_ENV};
use smoke_test::{locate_repo_root, prerequisites_available};

fn twin() -> Option<TwinFork> {
    if !prerequisites_available() {
        eprintln!("[twin_fork_env] SKIP: anvil/bun/forge/cast not on PATH");
        return None;
    }
    if std::env::var(TWIN_RPC_URL_ENV)
        .map(|v| v.is_empty())
        .unwrap_or(true)
    {
        eprintln!("[twin_fork_env] SKIP: {TWIN_RPC_URL_ENV} is not set (start a fork with scripts/devnet/twin-fork.ts)");
        return None;
    }
    let root = locate_repo_root().expect("repo root");
    Some(TwinFork::boot(&root, 0).expect("reuse the running Twin fork"))
}

fn rpc(url: &str, method: &str, params: serde_json::Value) -> serde_json::Value {
    let body = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    let resp: serde_json::Value = reqwest::blocking::Client::new()
        .post(url)
        .json(&body)
        .send()
        .expect("rpc request")
        .json()
        .expect("rpc json");
    resp.get("result")
        .cloned()
        .unwrap_or_else(|| panic!("no result: {resp}"))
}

#[test]
fn the_fork_is_the_twin_chain_on_real_base_state() {
    let Some(t) = twin() else { return };
    assert!(
        !t.is_owned(),
        "a fork named by {TWIN_RPC_URL_ENV} must be reused, never owned"
    );
    let id = rpc(t.rpc_url(), "eth_chainId", serde_json::json!([]));
    assert_eq!(
        u64::from_str_radix(id.as_str().unwrap().trim_start_matches("0x"), 16).unwrap(),
        TWIN_CHAIN_ID
    );
    let head = rpc(t.rpc_url(), "eth_blockNumber", serde_json::json!([]));
    let head = u64::from_str_radix(head.as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
    assert!(head > 1_000_000, "head {head} is not a forked Base block");
    // The real USDC token answers symbol() and decimals().
    let sym = rpc(
        t.rpc_url(),
        "eth_call",
        serde_json::json!([{"to": BASE_USDC_ADDR, "data": "0x95d89b41"}, "latest"]),
    );
    assert!(
        sym.as_str().unwrap().to_lowercase().contains("55534443"),
        "USDC symbol() not returned: {sym}"
    );
}

#[test]
fn fund_usdc_sets_the_real_balance_slot() {
    let Some(t) = twin() else { return };
    let who = "0x00000000000000000000000000000000000000c3";
    t.set_usdc_balance(who, 7_654_321).expect("fund usdc");
    assert_eq!(t.usdc_balance(who).unwrap(), 7_654_321);
    // Absolute on the slot: a second write replaces, it does not add.
    t.set_usdc_balance(who, 1_000_000).expect("fund usdc again");
    assert_eq!(t.usdc_balance(who).unwrap(), 1_000_000);
}

#[test]
fn fund_gas_sets_the_native_balance_exactly() {
    let Some(t) = twin() else { return };
    let who = "0x00000000000000000000000000000000000000d4";
    t.fund_gas(who, 2_500_000_000_000_000_000)
        .expect("fund gas");
    let bal = rpc(
        t.rpc_url(),
        "eth_getBalance",
        serde_json::json!([who, "latest"]),
    );
    assert_eq!(
        u128::from_str_radix(bal.as_str().unwrap().trim_start_matches("0x"), 16).unwrap(),
        2_500_000_000_000_000_000
    );
}

#[test]
fn warp_moves_block_time_forward_without_waiting() {
    let Some(t) = twin() else { return };
    let ts = |t: &TwinFork| {
        let b = rpc(
            t.rpc_url(),
            "eth_getBlockByNumber",
            serde_json::json!(["latest", false]),
        );
        u64::from_str_radix(
            b["timestamp"].as_str().unwrap().trim_start_matches("0x"),
            16,
        )
        .unwrap()
    };
    let t0 = ts(&t);
    let started = std::time::Instant::now();
    t.warp(48 * 3600).expect("warp 48h");
    assert!(ts(&t) >= t0 + 48 * 3600, "block time did not move 48h");
    assert!(
        started.elapsed().as_secs() < 60,
        "warp must not wait in real time"
    );
}
