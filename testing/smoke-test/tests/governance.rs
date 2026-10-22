//! Smoke-test governance round-trip — issue #364.
//!
//! Verifies that:
//!   - RouterGovernance is deployed at a non-zero address.
//!   - RouterGovernance has bytecode on-chain.
//!   - RouterGovernance releases from the deployed receipt register, which grants it RECEIPT_RELEASER_ROLE
//!     (one `applyReceipt` call releases a receipt and applies its weights).
//!   - The deployer holds no admin; the timelock is admin.
//!   - The deployer cannot apply a consensus receipt: the timelock holds
//!     `WEIGHT_SETTER_ROLE` (the `applyReceipt` gate) and the deployer does not.
//!     There is no voting power to check: voting was deleted (issue 1698).
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
/// `applyReceipt` releases the receipt on `receipts()` and then calls `setWeights`, so the deploy must
/// initialize `receipts()` with the deployed ConsensusRecommendationReceipt and the register must
/// grant the weight setter RECEIPT_RELEASER_ROLE (its `releaseReceipt` gate, never ADMIN_ROLE). Either one missing makes every
/// `apply-receipt` revert.
#[test]
fn governance_releases_from_the_deployed_receipt_register() {
    require_prereqs("governance_releases_from_the_deployed_receipt_register");
    let fx = fixture();
    let register = fx.consensus_receipt();
    assert_ne!(
        register,
        Address::ZERO,
        "the receipt manifest names no ConsensusRecommendationReceipt"
    );
    assert_eq!(
        read_receipts(fx),
        register,
        "RouterGovernance.receipts() must be the deployed receipt register"
    );
    assert!(
        has_role(fx, register, RECEIPT_RELEASER_ROLE, fx.governance()),
        "the receipt register must grant RouterGovernance RECEIPT_RELEASER_ROLE (the releaseReceipt gate)"
    );
    assert!(
        !has_role(fx, register, ADMIN_ROLE, fx.governance()),
        "RouterGovernance must not hold the receipt ADMIN_ROLE"
    );
    assert!(
        has_role(fx, register, ADMIN_ROLE, fx.timelock()),
        "the timelock holds the receipt ADMIN_ROLE"
    );
}

/// The deployer cannot apply a consensus receipt after handover. Only the
/// timelock holds `WEIGHT_SETTER_ROLE` on RouterGovernance, the gate on
/// `applyReceipt` (issue 1698), so a receipt reaches the router only through the
/// Safe scheduling the call on the timelock.
#[test]
fn deployer_holds_no_weight_setter_role_timelock_does() {
    require_prereqs("deployer_holds_no_weight_setter_role_timelock_does");
    let fx = fixture();
    let deployer: Address = fx
        .published()
        .keys
        .address("ADMIN_ADDRESS")
        .expect("deployer address")
        .parse()
        .expect("parse deployer address");
    assert!(
        !governance_has_role(fx, WEIGHT_SETTER_ROLE, deployer),
        "deployer must not hold WEIGHT_SETTER_ROLE on RouterGovernance"
    );
    assert!(
        governance_has_role(fx, WEIGHT_SETTER_ROLE, fx.timelock()),
        "the timelock must hold WEIGHT_SETTER_ROLE on RouterGovernance"
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
        !governance_has_role(fx, ADMIN_ROLE, deployer),
        "deployer must not hold ADMIN_ROLE on RouterGovernance"
    );
    assert!(
        governance_has_role(fx, ADMIN_ROLE, fx.timelock()),
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

/// `keccak256("ADMIN_ROLE")`.
const ADMIN_ROLE: &str = "a49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";

/// `keccak256("RECEIPT_RELEASER_ROLE")`, the narrow release gate on the receipt register.
const RECEIPT_RELEASER_ROLE: &str =
    "6f1c85956a8a3bd80f9a05609a81c97597fa00224fb9de0fe0d596558d8c8fe1";

/// `keccak256("WEIGHT_SETTER_ROLE")`, the gate on `applyReceipt`.
const WEIGHT_SETTER_ROLE: &str = "a2edfd05c0c1cda238b1c99a8a31252998b19153c63b3f9e5b7048bc4b5f4a3f";

/// Check hasRole(role, account) on the governance contract. `role` is the
/// 32-byte role id as 64 hex chars without a `0x` prefix.
fn governance_has_role(fx: &Fixture, role: &str, account: Address) -> bool {
    has_role(fx, fx.governance(), role, account)
}

/// Check hasRole(role, account) on `target` (RouterGovernance or the receipt register; both
/// define ADMIN_ROLE as keccak256("ADMIN_ROLE")). `role` is 64 hex chars without a `0x` prefix.
/// hasRole(bytes32,address) selector: 0x91d14854
fn has_role(fx: &Fixture, target: Address, role: &str, account: Address) -> bool {
    let account_hex = format!("{account:x}");
    let data = format!("0x91d14854{role}{account_hex:0>64}");
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

/// Read `receipts()` (the receipt register) from the RouterGovernance contract.
/// receipts() selector: keccak256("receipts()")[0..4] = 0xf400b10e (`cast sig "receipts()"`).
fn read_receipts(fx: &Fixture) -> Address {
    let result: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.governance()), "data": "0xf400b10e"},
            "latest"
        ]),
    );
    let word = result.trim_start_matches("0x");
    assert_eq!(
        word.len(),
        64,
        "receipts() returned {result:?}, not one word"
    );
    format!("0x{}", &word[24..])
        .parse()
        .expect("receipts() word is an address")
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
