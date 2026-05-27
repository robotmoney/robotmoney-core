//! Canonical: docs/technical/security-model.md §4 — Timelock bypass → Mitigated
//! Implements: issue #414 — on-chain timelocked multisig enforcement
//!
//! `rmpc get-timelock` — direct on-chain read of TimelockController state.
//!
//! Sub-reads (all `eth_call`/`eth_getLogs`, pinned to a single
//! `eth_blockNumber` snapshot):
//!
//! - `TimelockController.getMinDelay()` → minimum delay in seconds.
//! - `TimelockController.PROPOSER_ROLE()` → proposer role hash.
//! - `TimelockController.EXECUTOR_ROLE()` → executor role hash.
//! - `eth_getLogs(RoleGranted/RoleRevoked)` for PROPOSER/EXECUTOR → member lists.
//! - `eth_getLogs(CallScheduled)` + `getTimestamp(id)` → pending operations.
//!
//! Config field `timelock_address` must be set; exits `EXIT_STARTUP_FAIL` when absent.
//!
//! Exit codes:
//! - 0 — envelope emitted.
//! - 3 — config / RPC connectivity / address-parse failure.

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{keccak256, Address, B256};
use alloy_sol_types::SolCall;
use serde::Serialize;
use serde_json::json;

use crate::config::Config;
use crate::gateway::TimelockController;
use crate::network_env::NetworkEnv;
use crate::read_output::{Envelope, PartialBuilder};
use crate::rpc::{CallRequest, RpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

/// Sentinel value used by `TimelockController` to mark a completed operation.
/// Operations with `getTimestamp(id) == 1` are done (not pending).
const DONE_TIMESTAMP: u64 = 1;

/// One pending operation discovered from on-chain `CallScheduled` logs.
#[derive(Debug, Serialize)]
pub struct PendingOp {
    /// 0x-hex operation id (`hashOperation` output).
    pub operation_id: String,
    /// Unix timestamp (seconds) after which the operation becomes executable.
    pub ready_timestamp: u64,
}

/// `data` payload for `rmpc get-timelock`.
#[derive(Debug, Default, Serialize)]
pub struct TimelockData {
    /// TimelockController address (from operator config).
    pub address: String,
    /// Minimum delay in seconds before a scheduled operation can execute.
    pub min_delay_secs: u64,
    /// Addresses that hold `PROPOSER_ROLE`.
    pub proposers: Vec<String>,
    /// Addresses that hold `EXECUTOR_ROLE`.
    pub executors: Vec<String>,
    /// Operations that have been scheduled but not yet executed or cancelled.
    pub pending_ops: Vec<PendingOp>,
}

/// Entry point invoked from `main.rs`. Returns the process exit code.
pub fn run(config_path: &Path, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-timelock: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let timelock_addr = match cfg.timelock_address.as_deref() {
        Some(s) => match Address::from_str(s) {
            Ok(a) => a,
            Err(e) => {
                log::error!("rmpc get-timelock: timelock_address parse error: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
        None => {
            log::error!(
                "rmpc get-timelock: timelock_address not set in config; \
                 add `timelock_address = \"0x...\"` to the operator TOML"
            );
            return EXIT_STARTUP_FAIL;
        }
    };

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc get-timelock: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-timelock: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let network_env = NetworkEnv::from_chain_id(cfg.chain_id);
    log::info!(
        "rmpc get-timelock: network environment: {} (chain_id={})",
        network_env.human_label(),
        cfg.chain_id
    );

    let env = match rt.block_on(read_timelock(&rpc, timelock_addr)) {
        Ok(e) => e,
        Err(e) => {
            log::error!("rmpc get-timelock: pre-read setup failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    emit(&env, pretty);
    EXIT_OK
}

async fn read_timelock(
    rpc: &RpcClient,
    timelock: Address,
) -> crate::errors::Result<Envelope<TimelockData>> {
    let chain_id = rpc.chain_id().await?;
    let block_number = rpc.block_number().await?;
    let block_tag = format!("0x{block_number:x}");

    let data = TimelockData {
        address: format!("{timelock:#x}"),
        ..Default::default()
    };
    let mut b = PartialBuilder::new(chain_id, block_number, data);

    // getMinDelay().
    match call_get_min_delay(rpc, timelock, &block_tag).await {
        Ok(delay) => b.data_mut().min_delay_secs = delay,
        Err(e) => b.record_err("min_delay".to_string(), e.to_string()),
    }

    // PROPOSER_ROLE hash.
    let proposer_role = match call_proposer_role(rpc, timelock, &block_tag).await {
        Ok(r) => Some(r),
        Err(e) => {
            b.record_err("proposer_role".to_string(), e.to_string());
            None
        }
    };

    // EXECUTOR_ROLE hash.
    let executor_role = match call_executor_role(rpc, timelock, &block_tag).await {
        Ok(r) => Some(r),
        Err(e) => {
            b.record_err("executor_role".to_string(), e.to_string());
            None
        }
    };

    // RoleGranted / RoleRevoked event topic0 constants.
    // keccak256("RoleGranted(bytes32,address,address)")
    let granted_topic0 = keccak256(b"RoleGranted(bytes32,address,address)");
    // keccak256("RoleRevoked(bytes32,address,address)")
    let revoked_topic0 = keccak256(b"RoleRevoked(bytes32,address,address)");

    // Fetch proposers and executors via RoleGranted/RoleRevoked log scan.
    if let Some(pr) = proposer_role {
        match fetch_role_members(
            rpc,
            timelock,
            pr,
            granted_topic0,
            revoked_topic0,
            &block_tag,
        )
        .await
        {
            Ok(members) => {
                b.data_mut().proposers = members.iter().map(|a| format!("{a:#x}")).collect()
            }
            Err(e) => b.record_err("proposers".to_string(), e),
        }
    }

    if let Some(er) = executor_role {
        match fetch_role_members(
            rpc,
            timelock,
            er,
            granted_topic0,
            revoked_topic0,
            &block_tag,
        )
        .await
        {
            Ok(members) => {
                b.data_mut().executors = members.iter().map(|a| format!("{a:#x}")).collect()
            }
            Err(e) => b.record_err("executors".to_string(), e),
        }
    }

    // Pending operations via CallScheduled log scan.
    let scheduled_topic0 =
        keccak256(b"CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)");
    match fetch_pending_ops(rpc, timelock, scheduled_topic0, &block_tag).await {
        Ok(ops) => b.data_mut().pending_ops = ops,
        Err(e) => b.record_err("pending_ops".to_string(), e),
    }

    Ok(b.finish())
}

async fn call_get_min_delay(
    rpc: &RpcClient,
    timelock: Address,
    block_tag: &str,
) -> crate::errors::Result<u64> {
    let data = TimelockController::getMinDelayCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: timelock,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = TimelockController::getMinDelayCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("getMinDelay abi decode: {e}"))
    })?;
    Ok(r._0.saturating_to::<u64>())
}

async fn call_proposer_role(
    rpc: &RpcClient,
    timelock: Address,
    block_tag: &str,
) -> crate::errors::Result<B256> {
    let data = TimelockController::PROPOSER_ROLECall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: timelock,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = TimelockController::PROPOSER_ROLECall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("PROPOSER_ROLE abi decode: {e}"))
    })?;
    Ok(r._0)
}

async fn call_executor_role(
    rpc: &RpcClient,
    timelock: Address,
    block_tag: &str,
) -> crate::errors::Result<B256> {
    let data = TimelockController::EXECUTOR_ROLECall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: timelock,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = TimelockController::EXECUTOR_ROLECall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("EXECUTOR_ROLE abi decode: {e}"))
    })?;
    Ok(r._0)
}

/// Scan `RoleGranted` and `RoleRevoked` logs for `role` on the `timelock`
/// contract to build the current member set.
///
/// In `RoleGranted(bytes32 indexed role, address indexed account, address sender)`:
/// - topic[0] = event selector
/// - topic[1] = role hash
/// - topic[2] = account (padded to 32 bytes)
async fn fetch_role_members(
    rpc: &RpcClient,
    timelock: Address,
    role: B256,
    granted_topic0: B256,
    revoked_topic0: B256,
    block_tag: &str,
) -> std::result::Result<Vec<Address>, String> {
    // Granted logs: topic[1] == role.
    let granted_filter = json!({
        "address": timelock,
        "fromBlock": "earliest",
        "toBlock": block_tag,
        "topics": [granted_topic0, role],
    });
    let granted_logs = rpc
        .get_logs(granted_filter)
        .await
        .map_err(|e| format!("eth_getLogs(RoleGranted) failed: {e}"))?;

    // Revoked logs: topic[1] == role.
    let revoked_filter = json!({
        "address": timelock,
        "fromBlock": "earliest",
        "toBlock": block_tag,
        "topics": [revoked_topic0, role],
    });
    let revoked_logs = rpc
        .get_logs(revoked_filter)
        .await
        .map_err(|e| format!("eth_getLogs(RoleRevoked) failed: {e}"))?;

    // Parse account addresses from topic[2].
    let mut members: std::collections::HashSet<Address> = std::collections::HashSet::new();

    for log in &granted_logs {
        // topic[2] = keccak256-padded address: last 20 bytes.
        if let Some(topic) = log.topics.get(2) {
            let bytes = topic.as_slice();
            if bytes.len() == 32 {
                members.insert(Address::from_slice(&bytes[12..]));
            }
        }
    }
    for log in &revoked_logs {
        if let Some(topic) = log.topics.get(2) {
            let bytes = topic.as_slice();
            if bytes.len() == 32 {
                members.remove(&Address::from_slice(&bytes[12..]));
            }
        }
    }

    let mut result: Vec<Address> = members.into_iter().collect();
    result.sort();
    Ok(result)
}

/// Scan `CallScheduled` logs to discover operation ids, then call
/// `getTimestamp(id)` for each. Operations with timestamp > 1 (DONE sentinel)
/// and non-zero are pending.
async fn fetch_pending_ops(
    rpc: &RpcClient,
    timelock: Address,
    scheduled_topic0: B256,
    block_tag: &str,
) -> std::result::Result<Vec<PendingOp>, String> {
    let filter = json!({
        "address": timelock,
        "fromBlock": "earliest",
        "toBlock": block_tag,
        "topics": [scheduled_topic0],
    });

    let logs = rpc
        .get_logs(filter)
        .await
        .map_err(|e| format!("eth_getLogs(CallScheduled) failed: {e}"))?;

    // Collect unique operation ids from topic[1].
    // CallScheduled(bytes32 indexed id, uint256 indexed index, ...)
    let mut seen: std::collections::HashSet<B256> = std::collections::HashSet::new();
    for log in &logs {
        if let Some(topic) = log.topics.get(1) {
            seen.insert(*topic);
        }
    }

    let mut pending = Vec::new();

    for op_id in seen {
        let ts = call_get_timestamp(rpc, timelock, block_tag, op_id)
            .await
            .unwrap_or(0);

        // ts == 0: cancelled or never existed (skip).
        // ts == 1 (DONE_TIMESTAMP): operation is done (skip).
        // ts > 1: pending (waiting or ready).
        if ts > DONE_TIMESTAMP {
            pending.push(PendingOp {
                operation_id: format!("{op_id:#x}"),
                ready_timestamp: ts,
            });
        }
    }

    // Sort by ready_timestamp ascending so earliest-ready is first.
    pending.sort_by_key(|op| op.ready_timestamp);
    Ok(pending)
}

async fn call_get_timestamp(
    rpc: &RpcClient,
    timelock: Address,
    block_tag: &str,
    id: B256,
) -> crate::errors::Result<u64> {
    let data = TimelockController::getTimestampCall { id }.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: timelock,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = TimelockController::getTimestampCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("getTimestamp abi decode: {e}"))
    })?;
    Ok(r._0.saturating_to::<u64>())
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-timelock output serialises");
    println!("{json}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_fails_fast_without_timelock_address() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let keystore = tmp.path().join("keystore.json");
        let cfg_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = 31337
rpc_url               = "http://127.0.0.1:1"
gateway_address       = "0x000000000000000000000000000000000000dEaD"
usdc_address          = "0x{usdc}"
vault_address         = "0x{vault}"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
            usdc = "00".repeat(20),
            vault = "00".repeat(20),
            zeros = "0".repeat(64),
            ks = keystore.display(),
        );
        std::fs::write(&cfg_path, &toml).expect("write rmpc.toml");
        let code = run(&cfg_path, false);
        assert_eq!(code, EXIT_STARTUP_FAIL);
    }

    #[test]
    fn timelock_data_serialises_with_no_ops() {
        let data = TimelockData {
            address: "0x0000000000000000000000000000000000000001".to_string(),
            min_delay_secs: 172800,
            proposers: vec!["0x0000000000000000000000000000000000000002".to_string()],
            executors: vec!["0x0000000000000000000000000000000000000002".to_string()],
            pending_ops: vec![],
        };
        let v: serde_json::Value = serde_json::to_value(&data).unwrap();
        assert_eq!(v["min_delay_secs"].as_u64().unwrap(), 172800);
        assert_eq!(v["proposers"].as_array().unwrap().len(), 1);
        assert_eq!(v["executors"].as_array().unwrap().len(), 1);
        assert_eq!(v["pending_ops"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn timelock_data_serialises_with_pending_op() {
        let data = TimelockData {
            address: "0x0000000000000000000000000000000000000001".to_string(),
            min_delay_secs: 86400,
            proposers: vec!["0x0000000000000000000000000000000000000002".to_string()],
            executors: vec!["0x0000000000000000000000000000000000000002".to_string()],
            pending_ops: vec![PendingOp {
                operation_id: "0x1111111111111111111111111111111111111111111111111111111111111111"
                    .to_string(),
                ready_timestamp: 1_700_000_000,
            }],
        };
        let v: serde_json::Value = serde_json::to_value(&data).unwrap();
        let ops = v["pending_ops"].as_array().unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0]["ready_timestamp"].as_u64().unwrap(), 1_700_000_000);
    }
}
