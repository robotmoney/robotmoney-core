//! Canonical: docs/architecture.md §4.8 — the shared write path
//! Implements: T23 — the reverted-transaction check in the shared write seam.
//!
//! # A MINED TRANSACTION IS NOT A SUCCESSFUL ONE, PROVED AGAINST A REAL EVM
//!
//! The rest of this crate's revert coverage mocks `eth_getTransactionReceipt`
//! and returns a hand-written body with `"status":"0x0"`. That proves the
//! branch is taken; it does not prove the branch describes anything a chain
//! does, and the run-1 code review's verdict on §E.4 was precisely that "the
//! only test coverage mocks `status: "0x1"`". This test mines a transaction
//! into a real EVM, lets it REVERT there, and reads the receipt an execution
//! client actually produced:
//!
//! * `anvil_setCode` puts `PUSH1 0 PUSH1 0 REVERT` at an address — a contract
//!   that reverts for every call, with no return data;
//! * a transaction is sent to it with an explicit gas limit, so the node mines
//!   it rather than refusing it at estimation time;
//! * [`wait_for_receipt_with`] returns that receipt, mined, with `status ==
//!   false` — which is the whole point: the transaction SUCCEEDED as far as the
//!   transport is concerned, and every command that stopped there reported
//!   `{"ok":true}`;
//! * [`wait_for_successful_receipt`], the seam, refuses it as `ErrTxReverted`
//!   naming the hash.
//!
//! # WHEN ANVIL IS ABSENT
//!
//! This test needs `anvil` on PATH (Foundry). The rmpc integration workflow
//! does not install Foundry, and adding it there is out of scope for this
//! change, so an absent `anvil` logs loudly and returns rather than failing the
//! build — with two guards against that becoming a quiet hole:
//!
//! 1. `RMPC_REQUIRE_ANVIL=1` turns the absence into a FAILURE, which is how the
//!    acceptance run executes it (the same shape as the indexer suite's
//!    `EXPLORER_INDEXER_REQUIRE_PG`);
//! 2. the mocked twins in `tests/committee.rs`, `tests/receipt.rs`,
//!    `tests/cli_deposit.rs`, `tests/cli_withdraw.rs` and
//!    `tests/cli_withdraw_router.rs` run unconditionally, so the seam is never
//!    at zero coverage on a runner without Foundry.

use alloy_primitives::B256;
use rust_payment_client::errors::RmpcError;
use rust_payment_client::rpc::FailoverRpcClient;
use rust_payment_client::tx::{wait_for_receipt_with, wait_for_successful_receipt};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// `PUSH1 0x00 PUSH1 0x00 REVERT` — reverts every call, returning no data.
const ALWAYS_REVERTS: &str = "0x60006000fd";
/// The address that code is installed at.
const REVERTER: &str = "0x00000000000000000000000000000000deadbeef";
/// anvil's unlocked account #0.
const SENDER: &str = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

struct Anvil {
    child: Child,
    url: String,
}

impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// An unused localhost port, released immediately before anvil binds it.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    listener.local_addr().expect("local addr").port()
}

async fn rpc_call(url: &str, method: &str, params: serde_json::Value) -> serde_json::Value {
    let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    let resp: serde_json::Value = reqwest::Client::new()
        .post(url)
        .json(&body)
        .send()
        .await
        .unwrap_or_else(|e| panic!("{method} request failed: {e}"))
        .json()
        .await
        .unwrap_or_else(|e| panic!("{method} response is not JSON: {e}"));
    assert!(
        resp.get("error").is_none(),
        "{method} returned an RPC error: {resp}"
    );
    resp["result"].clone()
}

/// Boot anvil, or `None` when it is not installed (see the module header).
async fn start_anvil() -> Option<Anvil> {
    if Command::new("anvil")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_err()
    {
        let required = std::env::var("RMPC_REQUIRE_ANVIL").as_deref() == Ok("1");
        assert!(
            !required,
            "RMPC_REQUIRE_ANVIL=1 but `anvil` is not on PATH — this test is the only \
             coverage of the write seam against a real EVM and must not be skipped here"
        );
        eprintln!(
            "SKIPPING the anvil-backed write-seam test: `anvil` is not on PATH. \
             Install Foundry, or set RMPC_REQUIRE_ANVIL=1 to make this a failure."
        );
        return None;
    }

    let port = free_port();
    // OWNED BEFORE ANYTHING CAN PANIC. The readiness loop below asserts, and a
    // child spawned outside the guard would be left running by the unwind.
    let anvil = Anvil {
        child: Command::new("anvil")
            .args(["--port", &port.to_string(), "--silent"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn anvil"),
        url: format!("http://127.0.0.1:{port}"),
    };
    let url = anvil.url.clone();

    // Wait for the node to answer rather than sleeping a guessed interval.
    for attempt in 0..100 {
        let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]});
        if reqwest::Client::new()
            .post(&url)
            .json(&body)
            .send()
            .await
            .is_ok()
        {
            return Some(anvil);
        }
        assert!(attempt < 99, "anvil never answered eth_chainId on {url}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    unreachable!("the loop above either returns or asserts")
}

#[tokio::test]
async fn the_write_seam_refuses_a_transaction_a_real_evm_mined_and_reverted() {
    let Some(anvil) = start_anvil().await else {
        return;
    };

    // A contract that reverts for every call, installed on the live chain.
    rpc_call(
        &anvil.url,
        "anvil_setCode",
        serde_json::json!([REVERTER, ALWAYS_REVERTS]),
    )
    .await;

    // An EXPLICIT gas limit: without one the node estimates first, the
    // estimation reverts, and the transaction is refused before it is ever
    // mined — which is a different (and already-handled) failure from the one
    // under test.
    let tx_hash = rpc_call(
        &anvil.url,
        "eth_sendTransaction",
        serde_json::json!([{"from": SENDER, "to": REVERTER, "gas": "0x186a0"}]),
    )
    .await;
    let tx_hash: B256 = tx_hash
        .as_str()
        .expect("eth_sendTransaction returns a hash")
        .parse()
        .expect("a 32-byte transaction hash");

    let rpc = FailoverRpcClient::new(vec![anvil.url.clone()]).expect("rpc client");

    // THE TRANSACTION IS MINED. This is the fact the five hand-rolled call
    // sites stopped at, and it is why the false success was invisible: nothing
    // failed, timed out, or was rejected.
    let receipt = wait_for_receipt_with(&rpc, tx_hash, Duration::from_millis(100), 50)
        .await
        .expect("the transaction is mined — a revert is not a transport failure");
    assert!(
        !receipt.inner.status(),
        "the fixture contract must actually revert, or this test proves nothing"
    );
    assert!(
        receipt.block_number.is_some(),
        "a reverted transaction still lands in a block"
    );

    // THE SEAM REFUSES IT.
    let err = wait_for_successful_receipt(&rpc, tx_hash, Duration::from_millis(100), 50)
        .await
        .expect_err(
            "a mined-but-reverted transaction must be refused by the shared write seam — \
             reporting it as a success is the AC-CORE-09 silent failure",
        );
    match &err {
        RmpcError::ErrTxReverted { tx_hash: named } => assert_eq!(
            named,
            &format!("{tx_hash:#x}"),
            "the refusal must name the transaction the operator has to inspect"
        ),
        other => panic!("expected ErrTxReverted, got {other}"),
    }
    assert_eq!(err.name(), "ErrTxReverted");
}

#[tokio::test]
async fn the_write_seam_returns_the_receipt_of_a_transaction_that_succeeded() {
    // NON-VACUITY: the seam must not refuse everything. A plain value transfer
    // on the same node is mined with status 1 and passes through.
    let Some(anvil) = start_anvil().await else {
        return;
    };

    let tx_hash = rpc_call(
        &anvil.url,
        "eth_sendTransaction",
        serde_json::json!([{
            "from": SENDER,
            // A PLAIN EOA, NOT A PRECOMPILE. `0x…01` is ecrecover: anvil
            // estimates the intrinsic 21000 for a valueless-data transfer, the
            // precompile's own gas is then unavailable, and the transfer
            // reverts with status 0 — which would make this non-vacuity test
            // assert the opposite of what it means to.
            "to": "0x000000000000000000000000000000000000c0de",
            "value": "0x1",
        }]),
    )
    .await;
    let tx_hash: B256 = tx_hash
        .as_str()
        .expect("eth_sendTransaction returns a hash")
        .parse()
        .expect("a 32-byte transaction hash");

    let rpc = FailoverRpcClient::new(vec![anvil.url.clone()]).expect("rpc client");
    let receipt = wait_for_successful_receipt(&rpc, tx_hash, Duration::from_millis(100), 50)
        .await
        .expect("a successful transfer passes the seam unchanged");
    assert!(receipt.inner.status());
}
