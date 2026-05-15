//! Smoke-test for the RM token faucet drip round-trip (issue #365).
//!
//! Verifies:
//!   1. RmToken is deployed at a non-zero address.
//!   2. The harness EOA holds a non-zero RM balance (initial supply).
//!   3. `fund_rm_token` performs a real signed ERC-20 transfer and the
//!      recipient's balance increases by the exact amount.
//!   4. The Transfer event is emitted from the RM token contract with
//!      correct from/to/value fields.
//!
//! Run with:
//!   cargo test -p smoke-test -- faucet_rm --test-threads=1 --nocapture

use alloy_primitives::{keccak256, Address, B256, U256};
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

// -- 1. RmToken deployment sanity -----------------------------------------

#[test]
fn rm_token_address_is_non_zero() {
    if skip_if_no_prereqs("rm_token_address_is_non_zero") {
        return;
    }
    let fx = fixture();
    assert_ne!(
        fx.rm_token(),
        Address::ZERO,
        "RmToken should be deployed at a non-zero address"
    );
}

// -- 2. Harness holds the initial supply -----------------------------------

#[test]
fn harness_holds_nonzero_rm_balance() {
    if skip_if_no_prereqs("harness_holds_nonzero_rm_balance") {
        return;
    }
    let fx = fixture();
    let harness: Address = HARNESS_USDC_HOLDER_ADDRESS_HEX.parse().unwrap();
    let balance = rm_balance_of(fx, harness);
    assert!(
        balance > U256::ZERO,
        "harness EOA should hold a non-zero RM balance after deploy, got 0"
    );
}

// -- 3. fund_rm_token increases the recipient's balance --------------------

#[test]
fn faucet_rm_drip_increases_recipient_balance() {
    if skip_if_no_prereqs("faucet_rm_drip_increases_recipient_balance") {
        return;
    }
    let fx = fixture();
    let recipient = fx.agent();
    // 100 RM = 100 * 10^18 base units (mirrors FAUCET_DRIP_AMOUNT_RM in chainClassifier.ts)
    let amount: u128 = 100_000_000_000_000_000_000; // 100 RM

    let before = rm_balance_of(fx, recipient);
    let tx_hash = fx.fund_rm_token(recipient, amount).expect("fund_rm_token");
    assert!(
        tx_hash.starts_with("0x") && tx_hash.len() == 66,
        "tx_hash {tx_hash:?}"
    );
    let after = rm_balance_of(fx, recipient);
    assert_eq!(
        after,
        before + U256::from(amount),
        "recipient RM balance did not grow by exact amount"
    );
    assert!(
        after > U256::ZERO,
        "recipient holds > 0 RM tokens after drip"
    );
}

// -- 4. Transfer event emitted with correct topics -------------------------

#[test]
fn faucet_rm_drip_emits_transfer_log() {
    if skip_if_no_prereqs("faucet_rm_drip_emits_transfer_log") {
        return;
    }
    let fx = fixture();
    let recipient = fx.agent();
    let amount: u128 = 10_000_000_000_000_000_000; // 10 RM

    let tx_hash = fx.fund_rm_token(recipient, amount).expect("fund_rm_token");
    let receipt = get_receipt(fx, &tx_hash);
    let logs = receipt
        .get("logs")
        .and_then(|v| v.as_array())
        .expect("logs array");

    let transfer_topic = B256::from(keccak256("Transfer(address,address,uint256)".as_bytes()));
    let harness_holder: Address = HARNESS_USDC_HOLDER_ADDRESS_HEX.parse().unwrap();

    let mut matching = 0usize;
    for log in logs {
        let addr_str = log.get("address").and_then(|v| v.as_str()).unwrap_or("");
        let log_addr: Address = addr_str.parse().unwrap_or(Address::ZERO);
        if log_addr != fx.rm_token() {
            continue;
        }
        let topics = log
            .get("topics")
            .and_then(|v| v.as_array())
            .expect("topics");
        if topics.len() != 3 {
            continue;
        }
        let t0 = topic_to_b256(&topics[0]);
        if t0 != transfer_topic {
            continue;
        }
        let from = topic_to_address(&topics[1]);
        let to = topic_to_address(&topics[2]);
        let value_hex = log.get("data").and_then(|v| v.as_str()).unwrap_or("0x0");
        let value = U256::from_str_radix(value_hex.trim_start_matches("0x"), 16)
            .expect("Transfer data is hex");
        assert_eq!(from, harness_holder, "Transfer.from != HARNESS_USDC_HOLDER");
        assert_eq!(to, recipient, "Transfer.to != recipient");
        assert_eq!(value, U256::from(amount), "Transfer.value != amount");
        matching += 1;
    }
    assert_eq!(
        matching, 1,
        "expected exactly one matching RM Transfer log, got {matching}"
    );
}

// -- helpers ---------------------------------------------------------------

fn rm_balance_of(fx: &Fixture, holder: Address) -> U256 {
    // balanceOf(address) selector = 0x70a08231
    let mut data = String::from("0x70a08231");
    data.push_str(&format!("{:0>64}", format!("{:x}", holder)));
    let raw: String = rpc_call(
        fx.rpc_url(),
        "eth_call",
        serde_json::json!([
            {"to": format!("{:#x}", fx.rm_token()), "data": data},
            "latest"
        ]),
    );
    U256::from_str_radix(raw.trim_start_matches("0x"), 16).unwrap_or(U256::ZERO)
}

fn get_receipt(fx: &Fixture, tx_hash: &str) -> serde_json::Value {
    rpc_call(
        fx.rpc_url(),
        "eth_getTransactionReceipt",
        serde_json::json!([tx_hash]),
    )
}

fn topic_to_b256(v: &serde_json::Value) -> B256 {
    let s = v.as_str().unwrap_or("0x0");
    let trimmed = s.trim_start_matches("0x");
    let padded = format!("{:0>64}", trimmed);
    let mut out = [0u8; 32];
    hex::decode_to_slice(padded, &mut out).expect("hex");
    B256::from(out)
}

fn topic_to_address(v: &serde_json::Value) -> Address {
    let b = topic_to_b256(v);
    Address::from_slice(&b.as_slice()[12..])
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
