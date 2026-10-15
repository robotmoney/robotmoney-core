//! Canonical: Plan tracking issue #109 — "Router-weight governance" phase
//! Canonical: docs/technical/governance-decisions.md §7 — read surface
//! Implements: issue #309 (rmpc get-governance subprocess assertion)
//! Implements: issue #1698 (no proposal or voter state is left to read)
//!
//! `rmpc get-governance` — direct on-chain read of RouterGovernance state.
//!
//! Sub-reads (all `eth_call`, pinned to a single `eth_blockNumber` snapshot):
//!
//! - `RouterGovernance.router()` → the Portfolio Router it sets weights on.
//! - `RouterGovernance.receiptContract()` → the receipt register
//!   `applyReceipt` releases from (zero until stage 11 sets it).
//! - `RouterGovernance.currentWeights()` → the router weights the weight
//!   setter last applied (the router's applied vector).
//!
//! Issue 1698 deleted the voting path (`propose`, `vote`, `execute`,
//! `currentProposalId`, `activeProposal`, `cadenceParams`), so there is no
//! proposal, voter, quorum or voting-period field to report. A weight change
//! is one Safe-scheduled timelock call, `applyReceipt`.
//!
//! Config field `governance_address` must be set; exits `EXIT_STARTUP_FAIL`
//! when absent.
//!
//! Exit codes:
//! - 0 — envelope emitted.
//! - 3 — config / RPC connectivity / address-parse failure.

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::RouterGovernance;
use crate::network_env::NetworkEnv;
use crate::output::emit;
use crate::read_output::{Envelope, PartialBuilder};
use crate::rpc::{CallRequest, FailoverRpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

/// One entry in the weight vector as read from governance.
#[derive(Debug, Default, Serialize)]
pub struct WeightEntry {
    pub vault: String,
    pub bps: u64,
}

/// `data` payload for `rmpc get-governance`.
#[derive(Debug, Default, Serialize)]
pub struct GovernanceData {
    /// RouterGovernance address (from operator config).
    pub address: String,
    /// The Portfolio Router this contract sets weights on. `null` when the
    /// read failed (the failure is in the envelope's `errors`).
    pub router: Option<String>,
    /// The receipt register `applyReceipt` releases from. `null` while it is
    /// unset (the zero address) or when the read failed.
    pub receipt_contract: Option<String>,
    /// The router weights the weight setter last applied. Empty when no
    /// receipt has been applied (the router routes by its default vector).
    pub current_weights: Vec<WeightEntry>,
}

/// Entry point invoked from `main.rs`. Returns the process exit code.
pub fn run(config_path: &Path, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-governance: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let governance_addr = match cfg.governance_address.as_deref() {
        Some(s) => match Address::from_str(s) {
            Ok(a) => a,
            Err(e) => {
                log::error!("rmpc get-governance: governance_address parse error: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
        None => {
            log::error!(
                "rmpc get-governance: governance_address not set in config; \
                 add `governance_address = \"0x...\"` to the operator TOML"
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
            log::error!("rmpc get-governance: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rpc = match cfg.rpc_client() {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-governance: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let network_env = NetworkEnv::from_chain_id(cfg.chain_id);
    log::info!(
        "rmpc get-governance: network environment: {} (chain_id={})",
        network_env.human_label(),
        cfg.chain_id
    );

    let env = match rt.block_on(read_governance(&rpc, governance_addr)) {
        Ok(e) => e,
        Err(e) => {
            log::error!("rmpc get-governance: pre-read setup failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    emit(&env, pretty);
    EXIT_OK
}

async fn read_governance(
    rpc: &FailoverRpcClient,
    governance: Address,
) -> crate::errors::Result<Envelope<GovernanceData>> {
    let chain_id = rpc.chain_id().await?;
    let block_number = rpc.block_number().await?;
    let block_tag = format!("0x{block_number:x}");

    let data = GovernanceData {
        address: format!("{governance:#x}"),
        ..Default::default()
    };
    let mut b = PartialBuilder::new(chain_id, block_number, data);

    // router().
    match call_address(rpc, governance, &block_tag, Read::Router).await {
        Ok(a) => b.data_mut().router = Some(format!("{a:#x}")),
        Err(e) => b.record_err("router".to_string(), e.to_string()),
    }

    // receiptContract().
    match call_address(rpc, governance, &block_tag, Read::ReceiptContract).await {
        Ok(a) if a == Address::ZERO => {}
        Ok(a) => b.data_mut().receipt_contract = Some(format!("{a:#x}")),
        Err(e) => b.record_err("receipt_contract".to_string(), e.to_string()),
    }

    // currentWeights().
    match call_current_weights(rpc, governance, &block_tag).await {
        Ok((vaults, bps)) => {
            let entries: Vec<WeightEntry> = vaults
                .into_iter()
                .zip(bps)
                .map(|(v, bps_val)| WeightEntry {
                    vault: format!("{v:#x}"),
                    bps: bps_val.saturating_to::<u64>(),
                })
                .collect();
            b.data_mut().current_weights = entries;
        }
        Err(e) => {
            b.record_err("current_weights".to_string(), e.to_string());
        }
    }

    Ok(b.finish())
}

/// The two single-address reads `get-governance` makes.
#[derive(Debug, Clone, Copy)]
enum Read {
    Router,
    ReceiptContract,
}

async fn call_address(
    rpc: &FailoverRpcClient,
    governance: Address,
    block_tag: &str,
    read: Read,
) -> crate::errors::Result<Address> {
    let data = match read {
        Read::Router => RouterGovernance::routerCall {}.abi_encode(),
        Read::ReceiptContract => RouterGovernance::receiptContractCall {}.abi_encode(),
    };
    let out = rpc
        .eth_call(
            &CallRequest {
                to: governance,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let decoded = match read {
        Read::Router => RouterGovernance::routerCall::abi_decode_returns(&out, true).map(|r| r._0),
        Read::ReceiptContract => {
            RouterGovernance::receiptContractCall::abi_decode_returns(&out, true).map(|r| r._0)
        }
    };
    decoded.map_err(|e| crate::errors::RmpcError::ErrRpcDecode(format!("{read:?} abi decode: {e}")))
}

async fn call_current_weights(
    rpc: &FailoverRpcClient,
    governance: Address,
    block_tag: &str,
) -> crate::errors::Result<(Vec<Address>, Vec<U256>)> {
    let data = RouterGovernance::currentWeightsCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: governance,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = RouterGovernance::currentWeightsCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("currentWeights abi decode: {e}"))
    })?;
    Ok((r.vaults, r.bps))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_fails_fast_without_governance_address() {
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

    /// Issue 1698: the envelope carries no proposal, voter or cadence field.
    #[test]
    fn governance_data_has_no_voting_fields() {
        let data = GovernanceData {
            address: "0x0000000000000000000000000000000000000001".to_string(),
            router: Some("0x0000000000000000000000000000000000000002".to_string()),
            receipt_contract: None,
            current_weights: vec![WeightEntry {
                vault: "0x0000000000000000000000000000000000000003".to_string(),
                bps: 10_000,
            }],
        };
        let v: serde_json::Value = serde_json::to_value(&data).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["address", "current_weights", "receipt_contract", "router"],
            "get-governance reads the applied weights and the receipt register only"
        );
        assert!(v["receipt_contract"].is_null());
        assert_eq!(v["current_weights"][0]["bps"], 10_000);
    }
}
