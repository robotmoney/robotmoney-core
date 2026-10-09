//! Smoke-test governance round-trip — issue #364.
//!
//! Verifies that:
//!   - RouterGovernance is deployed at a non-zero address.
//!   - RouterGovernance has bytecode on-chain.
//!   - The deployer holds no voting power and no admin; the timelock is admin.
//!
//! Run with:
//!   cargo test -p smoke-test --release -- governance --test-threads=1 --nocapture

use alloy_primitives::Address;
use smoke_test::{require_prereqs, Fixture};

/// One shared fixture for the whole suite.
fn fixture() -> &'static Fixture {
    use std::sync::OnceLock;
    static CELL: OnceLock<Fixture> = OnceLock::new();
    CELL.get_or_init(|| Fixture::new().expect("smoke-test fixture boot failed"))
}

// -- RouterGovernance deployment sanity -----------------------------------

/// RouterGovernance is deployed at a non-zero address (issue #364 AC).
#[test]
fn governance_address_is_non_zero() {
    require_prereqs("governance_address_is_non_zero");
    let fx = fixture();
    assert_ne!(
        fx.governance(),
        Address::ZERO,
        "RouterGovernance should be deployed at a non-zero address"
    );
}

/// RouterGovernance has bytecode deployed on-chain.
#[test]
fn governance_has_code() {
    require_prereqs("governance_has_code");
    let fx = fixture();
    let code = get_code(fx.rpc_url(), fx.governance());
    assert!(
        code.len() > 2,
        "RouterGovernance at {:#x} has no bytecode (got {code:?})",
        fx.governance()
    );
}

/// Voting power is not set by the deployer. A fresh address has none, and the
/// deployer's own power is zero: quorum and voters come through the real Safe
/// and the timelock (the stage 13 govern matrix).
#[test]
fn deployer_holds_no_voting_power() {
    require_prereqs("deployer_holds_no_voting_power");
    let fx = fixture();
    let deployer: Address = fx
        .published()
        .keys
        .address("ADMIN_ADDRESS")
        .expect("deployer address")
        .parse()
        .expect("parse deployer address");
    assert_eq!(
        read_voting_power(fx, deployer),
        0,
        "the deployer must not hold voting power"
    );
}

/// The deployer does NOT hold ADMIN_ROLE on RouterGovernance after handover; the timelock does.
#[test]
fn deployer_holds_no_admin_role_timelock_does() {
    require_prereqs("deployer_holds_no_admin_role_timelock_does");
    let fx = fixture();
    let deployer: Address = fx
        .published()
        .keys
        .address("ADMIN_ADDRESS")
        .expect("deployer address")
        .parse()
        .expect("parse deployer address");
    assert!(
        !deployer_has_admin_role(fx, deployer),
        "deployer must not hold ADMIN_ROLE on RouterGovernance"
    );
    assert!(
        deployer_has_admin_role(fx, fx.timelock()),
        "the timelock must hold ADMIN_ROLE on RouterGovernance"
    );
}

// -- Helpers --------------------------------------------------------------

fn get_code(url: &str, addr: Address) -> String {
    rpc_call(
        url,
        "eth_getCode",
        serde_json::json!([format!("{addr:#x}"), "latest"]),
    )
}

/// Read votingPower(addr) from the RouterGovernance contract.
/// votingPower(address) selector: keccak256("votingPower(address)")[0..4] = 0xc07473f6
/// (verified via `cast sig "votingPower(address)"` — issue #1311 found this
/// target had never executed anywhere, so the previously-hardcoded 0x13c8a7f5
/// selector, which does not match any function on RouterGovernance, had never
/// been caught).
fn read_voting_power(fx: &Fixture, voter: Address) -> u128 {
    // ABI-encode: selector + left-padded address (12 zero bytes + 20 addr bytes)
    let voter_hex = format!("{voter:x}");
    let data = format!("0xc07473f6{voter_hex:0>64}");
    let result: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.governance()), "data": data},
            "latest"
        ]),
    );
    u256_from_hex(&result)
}

/// Check hasRole(ADMIN_ROLE, account) on the governance contract.
/// hasRole(bytes32,address) selector: 0x91d14854
/// ADMIN_ROLE = keccak256("ADMIN_ROLE") = 0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775
fn deployer_has_admin_role(fx: &Fixture, account: Address) -> bool {
    let admin_role = "a49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";
    let account_hex = format!("{account:x}");
    let data = format!("0x91d14854{admin_role}{account_hex:0>64}");
    let result: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.governance()), "data": data},
            "latest"
        ]),
    );
    result.trim_start_matches("0x").ends_with('1')
}

fn u256_from_hex(hex: &str) -> u128 {
    let stripped = hex.trim_start_matches("0x");
    let len = stripped.len();
    let slice = if len > 32 {
        &stripped[len - 32..]
    } else {
        stripped
    };
    u128::from_str_radix(slice, 16).unwrap_or(0)
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
