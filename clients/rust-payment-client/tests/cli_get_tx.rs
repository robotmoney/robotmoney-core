//! Canonical: docs/implementation-plan.md §9 — `rmpc get-tx`
//!
//! Integration tests for `rmpc get-tx` (issue #50).

mod common;

use crate::common::{jrpc_result, jrpc_result_raw, Fixture};
use assert_cmd::Command;
use mockito::Matcher;
use serde_json::{json, Value};

fn rmpc() -> Command {
    Command::cargo_bin("rmpc").expect("rmpc binary built")
}

/// Build a JSON-RPC `eth_getTransactionReceipt` result body for a
/// successful EIP-1559 transaction with no logs. Field set is the
/// minimum that `alloy_rpc_types::TransactionReceipt` deserialises.
fn receipt_json(
    tx_hash: &str,
    status_one: bool,
    block_no: u64,
    from: &str,
    to: Option<&str>,
    gas_used: u128,
    eff_gas_price: u128,
) -> String {
    let to_field = match to {
        Some(t) => format!(r#""to":"{t}""#),
        None => r#""to":null"#.to_string(),
    };
    format!(
        r#"{{"transactionHash":"{tx_hash}","transactionIndex":"0x0","blockHash":"0x0000000000000000000000000000000000000000000000000000000000000001","blockNumber":"0x{block_no:x}","cumulativeGasUsed":"0x{gas:x}","gasUsed":"0x{gas:x}","effectiveGasPrice":"0x{egp:x}","from":"{from}",{to_field},"contractAddress":null,"logs":[],"logsBloom":"0x{bloom}","status":"{status}","type":"0x2"}}"#,
        gas = gas_used,
        egp = eff_gas_price,
        bloom = "00".repeat(256),
        status = if status_one { "0x1" } else { "0x0" },
    )
}

#[tokio::test]
async fn get_tx_clean_envelope_for_successful_receipt() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0xabcu64;
    let receipt_block = 0xab0u64;
    let tx_hash = "0x1111111111111111111111111111111111111111111111111111111111111111";
    let from = "0x00000000000000000000000000000000000000aa";
    let to = "0x00000000000000000000000000000000000000bb";
    let gas_used: u128 = 21_000;
    let egp: u128 = 1_500_000_000;

    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{chain_id:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{block_no:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(&receipt_json(
            tx_hash,
            true,
            receipt_block,
            from,
            Some(to),
            gas_used,
            egp,
        )))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    let out = rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            tx_hash,
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["chain_id"], chain_id);
    assert_eq!(v["block_number"], block_no);
    assert_eq!(v["source"], "json_rpc");
    assert_eq!(v["partial"], false);
    assert!(v["errors"].as_array().unwrap().is_empty());

    let d = &v["data"];
    assert_eq!(d["tx_hash"], tx_hash);
    assert_eq!(d["status"], "success");
    assert_eq!(d["block_number"], receipt_block);
    assert_eq!(d["from"].as_str().unwrap().to_lowercase(), from);
    assert_eq!(d["to"].as_str().unwrap().to_lowercase(), to);
    // Decimal-string contract.
    assert!(d["gas_used"].is_string());
    assert!(d["effective_gas_price"].is_string());
    assert_eq!(d["gas_used"], gas_used.to_string());
    assert_eq!(d["effective_gas_price"], egp.to_string());
}

#[tokio::test]
async fn get_tx_unknown_hash_returns_exit_4() {
    let mut server = mockito::Server::new_async().await;
    let chain_id = 31337u64;
    let block_no = 0x10u64;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{chain_id:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{block_no:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw("null"))
        .expect_at_least(0)
        .create_async()
        .await;

    let fix = Fixture::build(&server.url(), chain_id);
    rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ])
        .assert()
        .failure()
        .code(4);
}

// --- Finality (issue #676 — security-model.md §12 confirmation-depth policy) ---

const FIN_TX_HASH: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const FIN_FROM: &str = "0x00000000000000000000000000000000000000aa";

/// Wire the three JSON-RPC mocks `get-tx` needs: `eth_chainId`,
/// `eth_blockNumber` (returns `tip`), and `eth_getTransactionReceipt`
/// (successful receipt included at `inclusion_block`).
async fn install_finality_mocks(
    server: &mut mockito::ServerGuard,
    chain_id: u64,
    tip: u64,
    inclusion_block: u64,
) {
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_chainId"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{chain_id:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(json!({"method": "eth_blockNumber"})))
        .with_status(200)
        .with_body(jrpc_result(&format!("0x{tip:x}")))
        .expect_at_least(0)
        .create_async()
        .await;
    server
        .mock("POST", "/")
        .match_body(Matcher::PartialJson(
            json!({"method": "eth_getTransactionReceipt"}),
        ))
        .with_status(200)
        .with_body(jrpc_result_raw(&receipt_json(
            FIN_TX_HASH,
            true,
            inclusion_block,
            FIN_FROM,
            None,
            21_000,
            1_500_000_000,
        )))
        .expect_at_least(0)
        .create_async()
        .await;
}

/// AC (issue #676): a high-value operation hash at block N reports
/// `l2_included` at `tip = N + 1`.
#[tokio::test]
async fn finality_high_value_op_l2_included_at_tip_n_plus_1() {
    let mut server = mockito::Server::new_async().await;
    let n = 0x100u64;
    install_finality_mocks(&mut server, 31337, n + 1, n).await;

    let fix = Fixture::build(&server.url(), 31337);
    let out = rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            FIN_TX_HASH,
            "--op-class",
            "admin_governance",
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let fin = &v["data"]["finality"];
    assert_eq!(fin["status"], "l2_included");
    assert_eq!(fin["confirmations"], 1);
    assert_eq!(fin["required_confirmations"], 64);
    assert_eq!(fin["op_class"], "admin_governance");
}

/// AC (issue #676): `l1_finalized` is reported only after the configured
/// L1-finality depth (64 blocks) is reached — at 63 confirmations the
/// status is still `l2_included`.
#[tokio::test]
async fn finality_high_value_op_still_l2_included_one_block_below_l1_depth() {
    let mut server = mockito::Server::new_async().await;
    let n = 0x100u64;
    install_finality_mocks(&mut server, 31337, n + 63, n).await;

    let fix = Fixture::build(&server.url(), 31337);
    let out = rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            FIN_TX_HASH,
            "--op-class",
            "admin_governance",
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let fin = &v["data"]["finality"];
    assert_eq!(fin["status"], "l2_included");
    assert_eq!(fin["confirmations"], 63);
}

/// AC (issue #676): once the configured L1-finality depth (64 blocks) is
/// reached, the high-value operation reports `l1_finalized` and
/// `--require-finality l1_finalized` exits 0.
#[tokio::test]
async fn finality_high_value_op_l1_finalized_at_configured_depth() {
    let mut server = mockito::Server::new_async().await;
    let n = 0x100u64;
    install_finality_mocks(&mut server, 31337, n + 64, n).await;

    let fix = Fixture::build(&server.url(), 31337);
    let out = rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            FIN_TX_HASH,
            "--op-class",
            "admin_governance",
            "--require-finality",
            "l1_finalized",
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let fin = &v["data"]["finality"];
    assert_eq!(fin["status"], "l1_finalized");
    assert_eq!(fin["confirmations"], 64);
    assert_eq!(fin["required_confirmations"], 64);
}

/// AC (issue #676): `rmpc` exits non-zero (code 5, ErrFinalityNotMet) when
/// `--require-finality l1_finalized` is requested and the confirmation
/// threshold for the class has not yet been met. The JSON output is still
/// emitted so callers can inspect the observed confirmation count.
#[tokio::test]
async fn finality_require_l1_finalized_exits_5_below_threshold() {
    let mut server = mockito::Server::new_async().await;
    let n = 0x100u64;
    install_finality_mocks(&mut server, 31337, n + 1, n).await;

    let fix = Fixture::build(&server.url(), 31337);
    let out = rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            FIN_TX_HASH,
            "--op-class",
            "admin_governance",
            "--require-finality",
            "l1_finalized",
        ])
        .assert()
        .failure()
        .code(5)
        .get_output()
        .clone();

    // JSON is still emitted on the finality-not-met path.
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let fin = &v["data"]["finality"];
    assert_eq!(fin["status"], "l2_included");
    assert_eq!(fin["confirmations"], 1);
    assert_eq!(fin["required_confirmations"], 64);
}

/// Default op-class is `deposit` (1 confirmation, l2_included) — a deposit
/// at tip = N + 1 meets `--require-finality l2_included` and exits 0.
#[tokio::test]
async fn finality_default_deposit_class_require_l2_included_passes_at_1_conf() {
    let mut server = mockito::Server::new_async().await;
    let n = 0x100u64;
    install_finality_mocks(&mut server, 31337, n + 1, n).await;

    let fix = Fixture::build(&server.url(), 31337);
    let out = rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            FIN_TX_HASH,
            "--require-finality",
            "l2_included",
        ])
        .assert()
        .success()
        .get_output()
        .clone();

    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    let fin = &v["data"]["finality"];
    assert_eq!(fin["status"], "l2_included");
    assert_eq!(fin["op_class"], "deposit");
    assert_eq!(fin["required_confirmations"], 1);
}

/// Unknown `--op-class` values are rejected with exit code 2 (input parse
/// failure) before any RPC traffic.
#[test]
fn finality_rejects_unknown_op_class() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            FIN_TX_HASH,
            "--op-class",
            "mystery",
        ])
        .assert()
        .failure()
        .code(2);
}

#[test]
fn get_tx_rejects_malformed_hash() {
    let fix = Fixture::build("http://127.0.0.1:1", 31337);
    rmpc()
        .args([
            "get-tx",
            "--config",
            fix.config_path.to_str().unwrap(),
            "--tx-hash",
            "0xnothex",
        ])
        .assert()
        .failure()
        .code(2);
}
