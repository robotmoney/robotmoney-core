//! Smoke-test governance round-trip — issue #364.
//!
//! Verifies that:
//!   - RouterGovernance is deployed at a non-zero address.
//!   - RouterGovernance has bytecode on-chain.
//!   - RouterGovernance releases from the deployed receipt register, which grants it ADMIN_ROLE
//!     (issue 1698: one `applyReceipt` call releases a receipt and applies its weights; there is no
//!     voting path, so there is no voting power to check).
//!   - The deployer holds no admin; the timelock is admin.
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

/// The weight setter applies receipts from the register the deploy wired (issue 1698, QA plan v1 C1).
/// `applyReceipt` releases the receipt on `receiptContract()` and then calls `setWeights`, so stage 11
/// must point `receiptContract()` at the deployed ConsensusRecommendationReceipt and the register must
/// grant the weight setter ADMIN_ROLE (its `releaseReceipt` gate). Either one missing makes every
/// `apply-receipt` revert. This replaces the pre-1698 voting-power check: there is no voting path.
#[test]
fn governance_releases_from_the_deployed_receipt_register() {
    require_prereqs("governance_releases_from_the_deployed_receipt_register");
    let fx = fixture();
    let register = fx.consensus_receipt();
    assert_ne!(
        register,
        Address::ZERO,
        "the ic-policy manifest names no ConsensusRecommendationReceipt"
    );
    assert_eq!(
        read_receipt_contract(fx),
        register,
        "RouterGovernance.receiptContract() must be the deployed receipt register"
    );
    assert!(
        has_admin_role(fx, register, fx.governance()),
        "the receipt register must grant RouterGovernance ADMIN_ROLE (the releaseReceipt gate)"
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
        !has_admin_role(fx, fx.governance(), deployer),
        "deployer must not hold ADMIN_ROLE on RouterGovernance"
    );
    assert!(
        has_admin_role(fx, fx.governance(), fx.timelock()),
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

/// Read `receiptContract()` from the RouterGovernance contract.
/// receiptContract() selector: keccak256("receiptContract()")[0..4] = 0xd435b3a3
/// (`cast sig "receiptContract()"`).
fn read_receipt_contract(fx: &Fixture) -> Address {
    let result: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.governance()), "data": "0xd435b3a3"},
            "latest"
        ]),
    );
    let word = result.trim_start_matches("0x");
    assert_eq!(
        word.len(),
        64,
        "receiptContract() returned {result:?}, not one word"
    );
    format!("0x{}", &word[24..])
        .parse()
        .expect("receiptContract() word is an address")
}

/// Check hasRole(ADMIN_ROLE, account) on `target` (RouterGovernance or the receipt register; both
/// define ADMIN_ROLE as keccak256("ADMIN_ROLE")).
/// hasRole(bytes32,address) selector: 0x91d14854
/// ADMIN_ROLE = keccak256("ADMIN_ROLE") = 0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775
fn has_admin_role(fx: &Fixture, target: Address, account: Address) -> bool {
    let admin_role = "a49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";
    let account_hex = format!("{account:x}");
    let data = format!("0x91d14854{admin_role}{account_hex:0>64}");
    let result: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{target:#x}"), "data": data},
            "latest"
        ]),
    );
    result.trim_start_matches("0x").ends_with('1')
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
