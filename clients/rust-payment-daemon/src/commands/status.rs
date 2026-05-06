//! `rmpd status --payment-id 0x…` — read-only payment lookup.
//!
//! Issues a single `eth_getLogs` filtered on the gateway address +
//! `AgentDeposit` topic0 + `paymentId` topic1, decodes the matching log
//! through the `RobotMoneyGateway::AgentDeposit` binding, and emits a
//! stable JSON document on stdout.
//!
//! Exit codes:
//! - 0 — exactly one matching log found, decoded successfully.
//! - 0 — no matching log found (output JSON carries `status: "not_found"`;
//!   absence is a valid query result, not an error).
//! - 3 — config / RPC / decode failure (operator-actionable).

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, LogData, B256};
use alloy_sol_types::SolEvent;
use serde::Serialize;
use serde_json::json;

use crate::config::Config;
use crate::gateway::RobotMoneyGateway;
use crate::rpc::{RawLog, RpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

/// Stable JSON shape on a successful (found) lookup. Field names are
/// part of the operator-visible contract — downstream e2e tests (#19)
/// match on them. Numeric values that may exceed `u64` are decimal
/// strings to preserve precision through `JSON.parse`.
#[derive(Debug, Serialize)]
pub struct StatusFound {
    pub payment_id: String,
    pub order_id: String,
    pub agent: String,
    pub share_receiver: String,
    pub amount: String,
    pub shares_minted: String,
    pub block_number: u64,
    pub tx_hash: String,
}

/// Stable JSON shape when no matching `AgentDeposit` log exists.
#[derive(Debug, Serialize)]
pub struct StatusNotFound {
    pub payment_id: String,
    pub status: &'static str,
}

/// Entry point invoked from `main.rs`. Returns the desired process exit code.
pub fn run(config_path: &Path, payment_id_hex: &str, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("rmpd status: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let payment_id = match B256::from_str(payment_id_hex) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("rmpd status: --payment-id is not a 32-byte hex string: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let gateway_addr = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("rmpd status: gateway_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("rmpd status: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("rmpd status: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let topic0 = RobotMoneyGateway::AgentDeposit::SIGNATURE_HASH;

    let filter = json!({
        "address": gateway_addr,
        "fromBlock": "earliest",
        "toBlock": "latest",
        "topics": [topic0, payment_id],
    });

    let logs: Vec<RawLog> = match rt.block_on(rpc.get_logs(filter)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("rmpd status: eth_getLogs failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let pid_hex = format!("{payment_id:#x}");

    if logs.is_empty() {
        let out = StatusNotFound {
            payment_id: pid_hex,
            status: "not_found",
        };
        emit(&out, pretty);
        return EXIT_OK;
    }

    // The first matching log wins. (paymentId is indexed and the gateway
    // rejects replays, so at most one log can ever match — but we don't
    // assert on that here; e2e tests cover the invariant.)
    let raw = &logs[0];
    let log_data = LogData::new_unchecked(raw.topics.clone(), raw.data.clone());
    let decoded = match RobotMoneyGateway::AgentDeposit::decode_log_data(&log_data, true) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("rmpd status: failed to decode AgentDeposit log: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let out = StatusFound {
        payment_id: format!("{:#x}", decoded.paymentId),
        order_id: format!("{:#x}", decoded.orderId),
        agent: format!("{:#x}", decoded.agent),
        share_receiver: format!("{:#x}", decoded.shareReceiver),
        amount: decoded.amount.to_string(),
        shares_minted: decoded.sharesMinted.to_string(),
        block_number: raw.block_number.to::<u64>(),
        tx_hash: format!("{:#x}", raw.transaction_hash),
    };
    emit(&out, pretty);
    EXIT_OK
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("status output serialises");
    println!("{json}");
}
