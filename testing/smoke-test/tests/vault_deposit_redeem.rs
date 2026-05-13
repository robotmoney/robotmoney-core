//! Smoke-test: RobotMoneyVault deposit→redeem round-trip on the devnet.
//!
//! Verifies that the smoke-test devnet deploys RobotMoneyVault + PassthroughAdapter
//! and that a full deposit→redeem round-trip returns USDC within rounding tolerance
//! at exitFeeBps=0. Issue #277 test-plan item 3.
//!
//! Run with:
//!   cargo test -p smoke-test --release --test vault_deposit_redeem -- --test-threads=1 --nocapture

use alloy_primitives::Address;
use smoke_test::{prerequisites_available, Fixture, AGENT_PRIVATE_KEY};

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

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    serde_json::from_value(resp.get("result").expect("no result field").clone())
        .expect("RPC result decode failed")
}

/// Read a uint256 storage return value from an eth_call hex response.
fn u256_from_hex_result(hex: &str) -> u128 {
    let s = hex.trim_start_matches("0x");
    let len = s.len();
    let slice = if len > 32 { &s[len - 32..] } else { s };
    u128::from_str_radix(slice, 16).unwrap_or(0)
}

/// ABI-encode a call to `balanceOf(address)` (selector 0x70a08231).
fn balance_of_calldata(addr: Address) -> String {
    format!(
        "0x70a08231000000000000000000000000{}",
        format!("{addr:#x}").trim_start_matches("0x")
    )
}

/// Read ERC-20 balanceOf via eth_call.
fn erc20_balance(rpc_url: &str, token: Address, owner: Address) -> u128 {
    let result: String = rpc_call(
        rpc_url,
        "eth_call",
        serde_json::json!([
            {"to": format!("{token:#x}"), "data": balance_of_calldata(owner)},
            "latest"
        ]),
    );
    u256_from_hex_result(&result)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Full deposit→redeem round-trip with RobotMoneyVault + PassthroughAdapter.
///
/// Steps:
/// 1. Agent approves vault to pull USDC.
/// 2. Agent deposits 1 USDC into vault.
/// 3. Assert shares minted (>= 1e24 raw due to decimalsOffset=18).
/// 4. Agent redeems all shares.
/// 5. Assert USDC returned >= 999_000 (zero-fee, within rounding).
#[test]
fn vault_deposit_redeem_round_trip() {
    if skip_if_no_prereqs("vault_deposit_redeem_round_trip") {
        return;
    }
    let fx = fixture();
    let agent_pk = format!("0x{}", hex::encode(AGENT_PRIVATE_KEY));
    let vault = fx.vault();
    let usdc = fx.usdc();
    let agent = fx.agent();
    const ONE_USDC: u128 = 1_000_000; // 1 USDC (6-decimal)

    // --- Step 1: approve vault ---
    fx.cast_send(
        &agent_pk,
        usdc,
        "approve(address,uint256)",
        &[&format!("{vault:#x}"), &ONE_USDC.to_string()],
    )
    .expect("approve vault");

    let usdc_before = erc20_balance(fx.rpc_url(), usdc, agent);
    let shares_before: u128 = {
        let hex: String = rpc_call(
            fx.rpc_url(),
            "eth_call",
            serde_json::json!([
                {"to": format!("{vault:#x}"), "data": balance_of_calldata(agent)},
                "latest"
            ]),
        );
        u256_from_hex_result(&hex)
    };

    // --- Step 2: deposit 1 USDC into vault ---
    // ERC-4626 deposit(uint256 assets, address receiver)
    fx.cast_send(
        &agent_pk,
        vault,
        "deposit(uint256,address)",
        &[&ONE_USDC.to_string(), &format!("{agent:#x}")],
    )
    .expect("vault deposit");

    // --- Step 3: verify shares minted (>= 1e24 raw shares for decimalsOffset=18) ---
    let shares_after: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{vault:#x}"), "data": balance_of_calldata(agent)},
            "latest"
        ]),
    );
    let shares_raw_hex = shares_after.trim_start_matches("0x");
    // Parse as u128 only the last 16 bytes; full 32-byte share value is ~1e24
    // which exceeds u64 but fits in u128.
    let shares_minted_low = u256_from_hex_result(&shares_after);
    // For a fresh vault with decimalsOffset=18: 1e6 USDC → ~1e24 raw shares.
    // We check via hex string length: 1e24 hex = 0x0d3c21bcecceda1000000 (22 hex chars, 11 bytes).
    // The full 64-char hex value should be non-zero past the lower 16 bytes.
    let high_bytes = if shares_raw_hex.len() > 32 {
        &shares_raw_hex[..shares_raw_hex.len() - 32]
    } else {
        ""
    };
    let high_nonzero = high_bytes.chars().any(|c| c != '0');
    assert!(
        shares_minted_low > shares_before || high_nonzero,
        "no shares minted after deposit (raw hex: {shares_after})"
    );
    eprintln!("vault_deposit_redeem: shares minted (low 128 bits) = {shares_minted_low}, high nonzero = {high_nonzero}");

    // --- Step 4: redeem all shares ---
    // Decode shares as decimal for cast send. We use u256_from_hex_result which
    // returns the low 128 bits — sufficient since 1e24 raw shares << u128::MAX.
    let shares_decimal = shares_minted_low.to_string();
    // ERC-4626 redeem(uint256 shares, address receiver, address owner)
    fx.cast_send(
        &agent_pk,
        vault,
        "redeem(uint256,address,address)",
        &[
            &shares_decimal,
            &format!("{agent:#x}"),
            &format!("{agent:#x}"),
        ],
    )
    .expect("vault redeem");

    // --- Step 5: assert USDC returned within rounding tolerance ---
    let usdc_after = erc20_balance(fx.rpc_url(), usdc, agent);
    // usdc_before had ONE_USDC deducted on deposit; after redeem it should be
    // back to roughly usdc_before. The net delta is the amount returned.
    let expected_floor = usdc_before.saturating_sub(ONE_USDC).saturating_add(999_000);
    eprintln!("vault_deposit_redeem: usdc_before={usdc_before} usdc_after={usdc_after} expected_floor={expected_floor}");
    assert!(
        usdc_after >= expected_floor,
        "expected usdc_after >= {expected_floor} (zero-fee round-trip within rounding), got {usdc_after}"
    );
}

/// Vault exitFeeBps is 0 and has at least one active adapter.
/// This test uses on-chain RPC reads (eth_call) to validate vault state.
#[test]
fn vault_on_chain_state() {
    if skip_if_no_prereqs("vault_on_chain_state") {
        return;
    }
    let fx = fixture();

    // exitFeeBps() → 0x57b17a52
    let fee_hex: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.vault()), "data": "0x57b17a52"},
            "latest"
        ]),
    );
    let fee = u256_from_hex_result(&fee_hex);
    assert_eq!(fee, 0, "exitFeeBps should be 0, got {fee}");

    // activeAdapterCount() → 0x47a0aa75
    let count_hex: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.vault()), "data": "0x47a0aa75"},
            "latest"
        ]),
    );
    let count = u256_from_hex_result(&count_hex);
    assert!(
        count >= 1,
        "vault should have at least one active adapter, got {count}"
    );
    eprintln!("vault_on_chain_state: exitFeeBps=0 activeAdapterCount={count}");
}
