//! Canonical: docs/implementation-plan.md §5.1 — Router-weight governance reads
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! `rmpc get-router` — direct on-chain read of the configured
//! `PortfolioRouter` contract's observable state.
//!
//! Sub-reads (all `eth_call`, pinned to a single `eth_blockNumber` snapshot):
//!
//! - `PortfolioRouter.getWeights()` → ordered vault addresses and parallel
//!   weight bps array.
//! - `PortfolioRouter.routerCap()` → global USDC ceiling per deposit call
//!   (0 = uncapped).
//!
//! Both commands require no signer key; the config field `router_address`
//! must be set or the command exits `EXIT_STARTUP_FAIL`.
//!
//! Exit codes:
//! - 0 — envelope emitted (including `partial: true` envelopes).
//! - 3 — config / RPC connectivity / address-parse failure.

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::PortfolioRouter;
use crate::network_env::NetworkEnv;
use crate::read_output::{DecimalU256, Envelope, PartialBuilder};
use crate::rpc::{CallRequest, RpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

/// One vault leg in the current weight vector.
#[derive(Debug, Default, Serialize)]
pub struct WeightEntry {
    /// Vault contract address (lowercase 0x-hex).
    pub vault: String,
    /// Weight in basis points (max 10 000 = 100%).
    pub weight_bps: DecimalU256,
}

/// `data` payload for `rmpc get-router`.
#[derive(Debug, Default, Serialize)]
pub struct GetRouterData {
    /// Router contract address (from operator config).
    pub router: String,
    /// Ordered vault addresses with their weight bps.
    pub weights: Vec<WeightEntry>,
    /// Global router cap in USDC base units (0 = uncapped).
    pub router_cap: DecimalU256,
}

/// Entry point invoked from `main.rs`. Returns the process exit code.
pub fn run(config_path: &Path, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-router: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let router_addr = match cfg.router_address.as_deref() {
        Some(s) => match Address::from_str(s) {
            Ok(a) => a,
            Err(e) => {
                log::error!("rmpc get-router: router_address parse error: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
        None => {
            log::error!(
                "rmpc get-router: router_address not set in config; \
                 add `router_address = \"0x...\"` to the operator TOML"
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
            log::error!("rmpc get-router: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-router: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let network_env = NetworkEnv::from_chain_id(cfg.chain_id);
    log::info!(
        "rmpc get-router: network environment: {} (chain_id={})",
        network_env.human_label(),
        cfg.chain_id
    );

    let env = match rt.block_on(read_router(&rpc, router_addr)) {
        Ok(e) => e,
        Err(e) => {
            log::error!("rmpc get-router: pre-read setup failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    emit(&env, pretty);
    EXIT_OK
}

/// Drive the router sub-reads against a pinned block. Pre-read setup
/// failures (chain id, block number) propagate as `Err`; per-field
/// sub-read failures are captured via `record_err` on the builder.
async fn read_router(
    rpc: &RpcClient,
    router: Address,
) -> crate::errors::Result<Envelope<GetRouterData>> {
    let chain_id = rpc.chain_id().await?;
    let block_number = rpc.block_number().await?;
    let block_tag = format!("0x{block_number:x}");

    let data = GetRouterData {
        router: format!("{router:#x}"),
        weights: Vec::new(),
        router_cap: DecimalU256::default(),
    };
    let mut b = PartialBuilder::new(chain_id, block_number, data);

    // getWeights() → (address[], uint256[])
    match call_get_weights(rpc, router, &block_tag).await {
        Ok((vaults, bps)) => {
            b.data_mut().weights = vaults
                .into_iter()
                .zip(bps)
                .map(|(vault, bps)| WeightEntry {
                    vault: format!("{vault:#x}"),
                    weight_bps: DecimalU256(bps),
                })
                .collect();
        }
        Err(e) => b.record_err("weights", e.to_string()),
    }

    // routerCap() → uint256
    match call_router_cap(rpc, router, &block_tag).await {
        Ok(cap) => b.data_mut().router_cap = DecimalU256(cap),
        Err(e) => b.record_err("router_cap", e.to_string()),
    }

    Ok(b.finish())
}

// ---- typed view helpers --------------------------------------------------

/// Call `PortfolioRouter.getWeights()` and return (vaults, bps) arrays.
async fn call_get_weights(
    rpc: &RpcClient,
    router: Address,
    block_tag: &str,
) -> crate::errors::Result<(Vec<Address>, Vec<U256>)> {
    let data = PortfolioRouter::getWeightsCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: router,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = PortfolioRouter::getWeightsCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("getWeights abi decode: {e}"))
    })?;
    Ok((r.vaults, r.bps))
}

/// Call `PortfolioRouter.routerCap()` and return the decoded `U256`.
async fn call_router_cap(
    rpc: &RpcClient,
    router: Address,
    block_tag: &str,
) -> crate::errors::Result<U256> {
    let data = PortfolioRouter::routerCapCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: router,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = PortfolioRouter::routerCapCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("routerCap abi decode: {e}"))
    })?;
    Ok(r._0)
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-router output serialises");
    println!("{json}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::U256;
    use serde_json::Value;

    #[test]
    fn get_router_data_empty_weights_serialises_as_array() {
        let data = GetRouterData {
            router: "0x0000000000000000000000000000000000000001".to_string(),
            weights: vec![],
            router_cap: DecimalU256::default(),
        };
        let v: Value = serde_json::to_value(&data).unwrap();
        assert!(v["weights"].as_array().unwrap().is_empty());
        assert_eq!(v["router_cap"].as_str().unwrap(), "0");
    }

    #[test]
    fn weight_entry_bps_is_decimal_string() {
        let entry = WeightEntry {
            vault: "0x0000000000000000000000000000000000000001".to_string(),
            weight_bps: DecimalU256(U256::from(6000u64)),
        };
        let v: Value = serde_json::to_value(&entry).unwrap();
        assert!(
            v["weight_bps"].is_string(),
            "weight_bps must be a JSON string"
        );
        assert_eq!(v["weight_bps"].as_str().unwrap(), "6000");
    }

    #[test]
    fn router_cap_is_decimal_string() {
        let data = GetRouterData {
            router: "0x0000000000000000000000000000000000000001".to_string(),
            weights: vec![],
            router_cap: DecimalU256(U256::from(500_000_000u64)),
        };
        let v: Value = serde_json::to_value(&data).unwrap();
        assert_eq!(v["router_cap"].as_str().unwrap(), "500000000");
    }

    /// When router_address is absent from config, run() must return
    /// EXIT_STARTUP_FAIL without touching the network.
    #[test]
    fn run_fails_fast_without_router_address() {
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
}
