//! Canonical: docs/implementation-plan.md §9 — Phase 3 Direct Chain-Read Query Tooling
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! `rmpc get-deposit --deposit-id 0x…` — gateway deposit lookup by id.
//!
//! The on-chain canonical id for a gateway deposit is the
//! `AgentDeposit.paymentId` topic (issue #16 / `commands/status.rs`).
//! `--deposit-id` is the operator-friendly alias `rmpc` exposes per §9.
//! Sub-reads:
//!   1. `eth_chainId`, `eth_blockNumber` — envelope header.
//!   2. `eth_getLogs` filtered on the gateway address + `AgentDeposit`
//!      topic0 + the deposit id as topic1. The first matching log wins
//!      (gateway rejects replays — at most one log can match).
//!
//! Per §9 a missing deposit is a typed error (`not_found`), not a
//! silent zero-value envelope: `--deposit-id` is operator input, and
//! agents need a deterministic refusal so they don't proceed with
//! stale state. Exit code 4 distinguishes "no such deposit" from
//! "RPC failed".
//!
//! Exit codes:
//! - 0 — exactly one matching log found, decoded.
//! - 2 — input parse failure (bad `--deposit-id`).
//! - 3 — config / RPC / decode failure.
//! - 4 — `ErrDepositNotFound`: no log matched the deposit id.

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, LogData, B256};
use alloy_sol_types::SolEvent;
use serde::Serialize;
use serde_json::json;

use crate::config::Config;
use crate::gateway::RobotMoneyGateway;
use crate::network_env::NetworkEnv;
use crate::read_output::{DecimalU256, Envelope, PartialBuilder};
use crate::rpc::{RawLog, RpcClient};

const EXIT_OK: i32 = 0;
const EXIT_INPUT_FAIL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;
const EXIT_NOT_FOUND: i32 = 4;

/// `data` payload for `get-deposit`. Mirrors the field set of
/// `commands/status.rs::StatusFound` but with §9-typed amounts and the
/// shared envelope.
#[derive(Debug, Serialize)]
pub struct DepositData {
    pub deposit_id: String,
    pub order_id: String,
    pub agent: String,
    pub share_receiver: String,
    pub amount: DecimalU256,
    pub shares_minted: DecimalU256,
    pub window_id: u64,
    pub log_block_number: u64,
    pub tx_hash: String,
}

/// Entry point invoked from `main.rs`. Returns the desired process exit code.
pub fn run(config_path: &Path, deposit_id_hex: &str, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-deposit: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let deposit_id = match B256::from_str(deposit_id_hex) {
        Ok(b) => b,
        Err(e) => {
            log::error!("rmpc get-deposit: --deposit-id not 32-byte hex: {e}");
            return EXIT_INPUT_FAIL;
        }
    };

    let gateway_addr = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-deposit: gateway_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc get-deposit: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-deposit: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let topic0 = RobotMoneyGateway::AgentDeposit::SIGNATURE_HASH;
    let filter = json!({
        "address": gateway_addr,
        "fromBlock": "earliest",
        "toBlock": "latest",
        "topics": [topic0, deposit_id],
    });

    type Outcome = Result<Option<Envelope<DepositData>>, String>;
    let outcome: Outcome = rt.block_on(async {
        let chain_id = rpc
            .chain_id()
            .await
            .map_err(|e| format!("eth_chainId: {e}"))?;
        let block_number = rpc
            .block_number()
            .await
            .map_err(|e| format!("eth_blockNumber: {e}"))?;
        let logs: Vec<RawLog> = rpc
            .get_logs(filter)
            .await
            .map_err(|e| format!("eth_getLogs: {e}"))?;
        if logs.is_empty() {
            return Ok(None);
        }
        let raw = &logs[0];
        let log_data = LogData::new_unchecked(raw.topics.clone(), raw.data.clone());
        let decoded = RobotMoneyGateway::AgentDeposit::decode_log_data(&log_data, true)
            .map_err(|e| format!("AgentDeposit decode: {e}"))?;
        let env = PartialBuilder::new(
            chain_id,
            block_number,
            DepositData {
                deposit_id: format!("{:#x}", decoded.paymentId),
                order_id: format!("{:#x}", decoded.orderId),
                agent: format!("{:#x}", decoded.agent),
                share_receiver: format!("{:#x}", decoded.shareReceiver),
                amount: DecimalU256(decoded.amount),
                shares_minted: DecimalU256(decoded.sharesMinted),
                window_id: decoded.windowId,
                log_block_number: raw.block_number.to::<u64>(),
                tx_hash: format!("{:#x}", raw.transaction_hash),
            },
        )
        .finish();
        Ok(Some(env))
    });

    match outcome {
        Ok(Some(env)) => {
            let network_env = NetworkEnv::from_chain_id(env.chain_id);
            log::info!(
                "rmpc get-deposit: network environment: {} (chain_id={})",
                network_env.human_label(),
                env.chain_id
            );
            emit(&env, pretty);
            EXIT_OK
        }
        Ok(None) => {
            log::error!(
                "rmpc get-deposit: ErrDepositNotFound: no AgentDeposit log for deposit_id={deposit_id_hex}"
            );
            EXIT_NOT_FOUND
        }
        Err(msg) => {
            log::error!("rmpc get-deposit: {msg}");
            EXIT_STARTUP_FAIL
        }
    }
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-deposit output serialises");
    println!("{json}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;

    #[test]
    fn deposit_data_amounts_serialize_as_strings() {
        let d = DepositData {
            deposit_id: "0x11".into(),
            order_id: "0x22".into(),
            agent: "0xaa".into(),
            share_receiver: "0xbb".into(),
            amount: DecimalU256(U256::from(1_000_000u64)),
            shares_minted: DecimalU256(U256::from(987_654u64)),
            window_id: 42,
            log_block_number: 16,
            tx_hash: "0x33".into(),
        };
        let v = serde_json::to_value(d).unwrap();
        assert!(v["amount"].is_string());
        assert!(v["shares_minted"].is_string());
        assert_eq!(v["amount"], "1000000");
        assert_eq!(v["window_id"], 42);
    }
}
