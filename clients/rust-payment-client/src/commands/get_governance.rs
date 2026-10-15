//! Canonical: docs/technical/governance-decisions.md §7 — Read surface
//! Implements: issue #309 (rmpc get-governance subprocess assertion)
//! Implements: issue #1698 — voting deleted; reads the weight setter's state
//!
//! `rmpc get-governance` — direct on-chain read of the router's weight setter,
//! `RouterGovernance`. There is no voting and there are no proposals: the Safe
//! applies a recorded consensus receipt by scheduling `applyReceipt` through
//! the timelock, which holds `WEIGHT_SETTER_ROLE`.
//!
//! Sub-reads (all `eth_call`, pinned to a single `eth_blockNumber` snapshot):
//!
//! - `RouterGovernance.router()` → the Portfolio Router whose weights it sets.
//! - `RouterGovernance.receipts()` → the consensus receipt register it applies.
//! - `RouterGovernance.currentWeights()` → the router's active weight vector.
//! - `PortfolioRouter.getDefaultWeights()` → the fallback vector (ADR-0002).
//! - `ADMIN_ROLE()` / `WEIGHT_SETTER_ROLE()` and `getRoleMember*` → who holds
//!   each role (the timelock after the deploy handover).
//!
//! Config field `governance_address` must be set; exits `EXIT_STARTUP_FAIL`
//! when absent.
//!
//! Exit codes:
//! - 0 — envelope emitted.
//! - 3 — config / RPC connectivity / address-parse failure.

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, B256, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::{PortfolioRouter, RouterGovernance};
use crate::network_env::NetworkEnv;
use crate::output::emit;
use crate::read_output::{Envelope, PartialBuilder};
use crate::rpc::{CallRequest, FailoverRpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

/// One entry in a weight vector.
#[derive(Debug, Default, Serialize)]
pub struct WeightEntry {
    pub vault: String,
    pub bps: u64,
}

/// The holders of one `RouterGovernance` role.
#[derive(Debug, Default, Serialize)]
pub struct RoleMembers {
    /// The role hash (0x-hex `bytes32`) read from the contract.
    pub hash: String,
    /// Every holder, from `getRoleMember(hash, i)`.
    pub members: Vec<String>,
}

/// `data` payload for `rmpc get-governance`.
#[derive(Debug, Default, Serialize)]
pub struct GovernanceData {
    /// RouterGovernance address (from operator config).
    pub address: String,
    /// The Portfolio Router this contract sets weights on.
    pub router: String,
    /// The ConsensusRecommendationReceipt register whose receipts it applies.
    pub receipts: String,
    /// The router's active weight vector. Empty until a receipt is applied.
    pub current_weights: Vec<WeightEntry>,
    /// The router's default (fallback) weight vector.
    pub default_weights: Vec<WeightEntry>,
    /// Holders of `ADMIN_ROLE` (sets default weights, clears the active vector).
    pub admin_role: RoleMembers,
    /// Holders of `WEIGHT_SETTER_ROLE` (may call `applyReceipt`).
    pub weight_setter_role: RoleMembers,
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

    match call(rpc, governance, &block_tag, RouterGovernance::routerCall {}).await {
        Ok(r) => {
            let router = r._0;
            b.data_mut().router = format!("{router:#x}");
            match call(
                rpc,
                router,
                &block_tag,
                PortfolioRouter::getDefaultWeightsCall {},
            )
            .await
            {
                Ok(w) => b.data_mut().default_weights = weight_entries(w.vaults, w.bps),
                Err(e) => b.record_err("default_weights".to_string(), e),
            }
        }
        Err(e) => {
            b.record_err("router".to_string(), e.clone());
            b.record_err("default_weights".to_string(), e);
        }
    }

    match call(
        rpc,
        governance,
        &block_tag,
        RouterGovernance::receiptsCall {},
    )
    .await
    {
        Ok(r) => b.data_mut().receipts = format!("{:#x}", r._0),
        Err(e) => b.record_err("receipts".to_string(), e),
    }

    match call(
        rpc,
        governance,
        &block_tag,
        RouterGovernance::currentWeightsCall {},
    )
    .await
    {
        Ok(w) => b.data_mut().current_weights = weight_entries(w.vaults, w.bps),
        Err(e) => b.record_err("current_weights".to_string(), e),
    }

    match call(
        rpc,
        governance,
        &block_tag,
        RouterGovernance::ADMIN_ROLECall {},
    )
    .await
    {
        Ok(r) => match read_role_members(rpc, governance, r._0, &block_tag).await {
            Ok(m) => b.data_mut().admin_role = m,
            Err(e) => b.record_err("admin_role".to_string(), e),
        },
        Err(e) => b.record_err("admin_role".to_string(), e),
    }

    match call(
        rpc,
        governance,
        &block_tag,
        RouterGovernance::WEIGHT_SETTER_ROLECall {},
    )
    .await
    {
        Ok(r) => match read_role_members(rpc, governance, r._0, &block_tag).await {
            Ok(m) => b.data_mut().weight_setter_role = m,
            Err(e) => b.record_err("weight_setter_role".to_string(), e),
        },
        Err(e) => b.record_err("weight_setter_role".to_string(), e),
    }

    Ok(b.finish())
}

fn weight_entries(vaults: Vec<Address>, bps: Vec<U256>) -> Vec<WeightEntry> {
    vaults
        .into_iter()
        .zip(bps)
        .map(|(v, bps_val)| WeightEntry {
            vault: format!("{v:#x}"),
            bps: bps_val.saturating_to::<u64>(),
        })
        .collect()
}

async fn read_role_members(
    rpc: &FailoverRpcClient,
    governance: Address,
    role: B256,
    block_tag: &str,
) -> Result<RoleMembers, String> {
    let count = call(
        rpc,
        governance,
        block_tag,
        RouterGovernance::getRoleMemberCountCall { role },
    )
    .await?
    ._0;
    let mut members = Vec::new();
    let mut index = U256::ZERO;
    while index < count {
        let m = call(
            rpc,
            governance,
            block_tag,
            RouterGovernance::getRoleMemberCall { role, index },
        )
        .await?;
        members.push(format!("{:#x}", m._0));
        index += U256::from(1u8);
    }
    Ok(RoleMembers {
        hash: format!("{role:#x}"),
        members,
    })
}

/// `eth_call` one view on `to` at `block_tag` and decode its returns.
async fn call<C: SolCall>(
    rpc: &FailoverRpcClient,
    to: Address,
    block_tag: &str,
    c: C,
) -> Result<C::Return, String> {
    let out = rpc
        .eth_call(
            &CallRequest {
                to,
                from: None,
                data: c.abi_encode().into(),
            },
            Some(block_tag),
        )
        .await
        .map_err(|e| format!("{} eth_call failed: {e}", C::SIGNATURE))?;
    C::abi_decode_returns(&out, true).map_err(|e| format!("{} abi decode: {e}", C::SIGNATURE))
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

    /// The payload carries no proposal or voting vocabulary: there is no
    /// voting on the deployed bytecode (issue #1698).
    #[test]
    fn governance_data_has_no_voting_fields() {
        let v: serde_json::Value = serde_json::to_value(GovernanceData::default()).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for key in &keys {
            assert!(
                !key.contains("proposal") && !key.contains("quorum") && !key.contains("voting"),
                "unexpected voting-era field {key}"
            );
        }
        assert!(keys.contains(&"current_weights"));
        assert!(keys.contains(&"weight_setter_role"));
    }
}
