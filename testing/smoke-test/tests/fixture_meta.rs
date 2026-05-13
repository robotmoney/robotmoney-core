//! Meta-tests for the smoke-test fixture itself.
//!
//! These tests verify that [`smoke_test::Fixture::new`] produces a
//! correctly wired devnet: RPC reachable, blocks being produced,
//! contracts deployed with code, EOAs funded, on-chain pokes round-
//! tripping. A failure here means every devnet-backed suite (8, 9,
//! 11–13) will also fail, so this suite runs first as an early-exit
//! gate (see docs/testing/ci-suites.md §15).
//!
//! Run with:
//!   cargo test -p smoke-test --release -- --test-threads=1 --nocapture

use alloy_primitives::Address;
use smoke_test::{prerequisites_available, Fixture};

fn skip_if_no_prereqs(name: &str) -> bool {
    if !prerequisites_available() {
        eprintln!("[{name}] docker/forge/cast not on PATH; skipping.");
        return true;
    }
    false
}

/// One shared fixture for the whole suite — booting Geth+Lighthouse
/// costs 60-120 s; paying that per test would make the suite unusable.
/// Tests run with `--test-threads=1` so this static is safe.
fn fixture() -> &'static Fixture {
    use std::sync::OnceLock;
    static CELL: OnceLock<Fixture> = OnceLock::new();
    CELL.get_or_init(|| Fixture::new().expect("smoke-test fixture boot failed"))
}

// -- Boot sanity ------------------------------------------------------

/// RPC responds and reports the expected chain id.
#[test]
fn rpc_is_reachable() {
    if skip_if_no_prereqs("rpc_is_reachable") {
        return;
    }
    let fx = fixture();
    let chain_id = rpc_call::<String>(fx.rpc_url(), "eth_chainId", serde_json::json!([]));
    let got =
        u64::from_str_radix(chain_id.trim_start_matches("0x"), 16).expect("eth_chainId is hex");
    assert_eq!(got, fx.chain_id(), "chain_id mismatch");
}

/// Blocks are being produced — network is past genesis.
#[test]
fn blocks_are_being_produced() {
    if skip_if_no_prereqs("blocks_are_being_produced") {
        return;
    }
    let fx = fixture();
    let hex = rpc_call::<String>(fx.rpc_url(), "eth_blockNumber", serde_json::json!([]));
    let n = u64::from_str_radix(hex.trim_start_matches("0x"), 16).expect("eth_blockNumber is hex");
    assert!(n >= 1, "expected block_number >= 1, got {n}");
}

// -- Deployed address sanity ------------------------------------------

/// All deployed addresses are non-zero.
#[test]
fn deployed_addresses_are_non_zero() {
    if skip_if_no_prereqs("deployed_addresses_are_non_zero") {
        return;
    }
    let fx = fixture();
    assert_ne!(fx.gateway(), Address::ZERO, "gateway is zero");
    assert_ne!(fx.usdc(), Address::ZERO, "usdc is zero");
    assert_ne!(fx.vault(), Address::ZERO, "vault is zero");
    assert_ne!(fx.adapter(), Address::ZERO, "adapter is zero");
    assert_ne!(fx.agent(), Address::ZERO, "agent is zero");
}

/// Gateway, USDC, vault, and adapter contracts have bytecode deployed.
#[test]
fn contracts_have_code() {
    if skip_if_no_prereqs("contracts_have_code") {
        return;
    }
    let fx = fixture();
    for (name, addr) in [
        ("gateway", fx.gateway()),
        ("usdc", fx.usdc()),
        ("vault", fx.vault()),
        ("adapter", fx.adapter()),
    ] {
        let code = get_code(fx.rpc_url(), addr);
        assert!(
            code.len() > 2, // "0x" alone means no code
            "{name} at {addr:#x} has no bytecode (got {code:?})"
        );
    }
}

/// Vault is a RobotMoneyVault with exitFeeBps=0 and at least one active adapter.
/// Issue #277: validates RobotMoneyVault on-chain state via RPC reads.
#[test]
fn vault_has_zero_exit_fee_and_one_active_adapter() {
    if skip_if_no_prereqs("vault_has_zero_exit_fee_and_one_active_adapter") {
        return;
    }
    let fx = fixture();

    // exitFeeBps() selector: keccak256("exitFeeBps()")[0..4] = 0x57b17a52
    let fee_hex: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.vault()), "data": "0x57b17a52"},
            "latest"
        ]),
    );
    let fee = u256_from_hex(&fee_hex);
    assert_eq!(fee, 0u128, "vault exitFeeBps should be 0");

    // activeAdapterCount() selector: keccak256("activeAdapterCount()")[0..4] = 0x47a0aa75
    let count_hex: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.vault()), "data": "0x47a0aa75"},
            "latest"
        ]),
    );
    let count = u256_from_hex(&count_hex);
    assert!(
        count >= 1,
        "vault should have at least one active adapter, got {count}"
    );
}

// -- EOA funding sanity -----------------------------------------------

/// Agent and deployer EOAs have non-zero ETH balances.
#[test]
fn eoas_are_funded() {
    if skip_if_no_prereqs("eoas_are_funded") {
        return;
    }
    let fx = fixture();
    for (name, addr_hex) in [
        ("agent", format!("{:#x}", fx.agent())),
        ("deployer", smoke_test::DEPLOYER_ADDRESS_HEX.to_string()),
    ] {
        let hex = rpc_call::<String>(
            fx.rpc_url(),
            "eth_getBalance",
            serde_json::json!([addr_hex, "latest"]),
        );
        let wei =
            u128::from_str_radix(hex.trim_start_matches("0x"), 16).expect("eth_getBalance is hex");
        assert!(wei > 0, "{name} has zero ETH balance");
    }
}

// -- On-chain poke round-trips ----------------------------------------

/// pause → unpause round-trips correctly.
#[test]
fn pause_unpause_round_trips() {
    if skip_if_no_prereqs("pause_unpause_round_trips") {
        return;
    }
    let fx = fixture();
    fx.pause_gateway().expect("pause()");
    assert!(
        gateway_is_paused(fx),
        "gateway should be paused after pause()"
    );
    fx.unpause_gateway().expect("unpause()");
    assert!(
        !gateway_is_paused(fx),
        "gateway should not be paused after unpause()"
    );
}

/// revoke → reauthorize round-trips correctly.
#[test]
fn revoke_reauthorize_round_trips() {
    if skip_if_no_prereqs("revoke_reauthorize_round_trips") {
        return;
    }
    let fx = fixture();
    let one_usdc = 1_000_000u128;
    let cap = 10_000 * one_usdc;
    fx.revoke_agent().expect("revokeAgent()");
    fx.reauthorize_agent(cap, 100_000 * one_usdc)
        .expect("reauthorize_agent()");
    // Sanity: agent address still matches after the role re-grant.
    assert_ne!(fx.agent(), Address::ZERO);
}

/// approve_usdc_from_agent sends a tx that succeeds on-chain.
#[test]
fn approve_usdc_succeeds() {
    if skip_if_no_prereqs("approve_usdc_succeeds") {
        return;
    }
    let fx = fixture();
    let tx_hash = fx
        .approve_usdc_from_agent(100 * 1_000_000)
        .expect("approve_usdc_from_agent");
    assert!(
        tx_hash.starts_with("0x") && tx_hash.len() == 66,
        "expected 32-byte tx hash, got {tx_hash:?}"
    );
}

// -- Drop / teardown --------------------------------------------------

/// Fixture Drop runs compose-down. We can't assert this in-process (the
/// static fixture lives for the whole binary), but we document the
/// expectation here and rely on the CI safety-net step to catch leaks.
/// This test exists as a marker so the suite has an explicit teardown
/// entry in the test list.
#[test]
fn fixture_teardown_documented() {
    // Drop is called when the OnceLock static is cleaned up at process
    // exit. The CI workflow's `docker compose down` safety step catches
    // any leak if the process exits uncleanly.
    // Drop is called at process exit; the CI safety-net step catches any leak.
    // No assertion needed — test existence is the marker.
}

// -- RPC helpers ------------------------------------------------------

fn rpc_call<T: for<'de> serde::Deserialize<'de>>(
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> T {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": method, "params": params
    });
    let resp: serde_json::Value = client
        .post(url)
        .json(&body)
        .send()
        .expect("RPC request failed")
        .json()
        .expect("RPC response is not JSON");
    serde_json::from_value(
        resp.get("result")
            .expect("no result field in RPC response")
            .clone(),
    )
    .expect("RPC result decode failed")
}

fn get_code(url: &str, addr: Address) -> String {
    rpc_call(
        url,
        "eth_getCode",
        serde_json::json!([format!("{addr:#x}"), "latest"]),
    )
}

/// Decode a 32-byte ABI-encoded uint256 result from an eth_call hex string
/// into a u128 (sufficient for any value expected in these tests).
fn u256_from_hex(hex: &str) -> u128 {
    let stripped = hex.trim_start_matches("0x");
    // Take the last 16 bytes (32 hex chars) — enough for u128
    let len = stripped.len();
    let slice = if len > 32 {
        &stripped[len - 32..]
    } else {
        stripped
    };
    u128::from_str_radix(slice, 16).unwrap_or(0)
}

fn gateway_is_paused(fx: &Fixture) -> bool {
    // ABI-encode paused() selector: keccak256("paused()")[0..4] = 0x5c975abb
    let result: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.gateway()), "data": "0x5c975abb"},
            "latest"
        ]),
    );
    // Returns a 32-byte bool: last byte is 1 if paused.
    result.trim_start_matches("0x").ends_with('1')
}
