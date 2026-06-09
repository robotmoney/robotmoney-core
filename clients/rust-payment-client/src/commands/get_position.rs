//! Canonical: docs/implementation-plan.md §5.1 — Account-scope vault position reads
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! `rmpc get-position --address <addr>` — positions across all registered
//! vaults for a given holder address.
//!
//! Per Architecture §5.1:
//! > `get-position <address>` — positions across all registered vaults:
//! > receipt token balance, USDC value, share of vault TVL, and composite
//! > portfolio total. Suitable for an agent checking its treasury exposure.
//!
//! Sub-reads (all `eth_call`, pinned to a single `eth_blockNumber` snapshot):
//!
//! - `VaultRegistry.listVaults()` → `address[]` of all registered vaults.
//! - For each vault address:
//!   - `vault.balanceOf(address)` → receipt token balance.
//!   - `vault.previewRedeem(balance)` → USDC value (assets out for shares).
//!   - `vault.totalAssets()` → vault TVL for share-of-TVL computation.
//!   - `VaultRegistry.getVault(address)` → `receiptToken` address.
//! - Sum of all per-vault USDC values → `portfolio_total_usdc`.
//!
//! `partial: true` when one or more sub-reads fail; `partial: false` when all
//! succeed. The `errors` array enumerates each failed sub-read's field path
//! and error message.
//!
//! Exit codes:
//! - 0 — envelope emitted (including `partial: true` envelopes).
//! - 2 — malformed `--address` argument.
//! - 3 — config / RPC connectivity / registry missing / decode failure.

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::{MockVault, VaultRegistry};
use crate::network_env::NetworkEnv;
use crate::read_output::{DecimalU256, Envelope, PartialBuilder};
use crate::rpc::{CallRequest, FailoverRpcClient};

const EXIT_OK: i32 = 0;
const EXIT_INPUT_FAIL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;

/// Per-vault position entry.
#[derive(Debug, Default, Serialize)]
pub struct VaultPosition {
    /// Vault contract address (lowercase 0x-hex).
    pub vault_address: String,
    /// Receipt token address (== vault address for ERC-4626).
    pub receipt_token_address: String,
    /// Holder's receipt token balance — decimal string.
    pub receipt_token_balance: DecimalU256,
    /// USDC value of the balance via `previewRedeem(balance)` — decimal string.
    pub usdc_value: DecimalU256,
    /// Holder's share of vault TVL in basis points (0 when `totalAssets == 0`).
    pub vault_tvl_share_bps: u64,
}

/// `data` payload for `rmpc get-position`.
#[derive(Debug, Serialize)]
pub struct PositionData {
    /// The queried holder address (0x-hex, lowercase).
    pub address: String,
    /// Per-vault position entries (one per registered vault, including zero-balance vaults).
    pub vaults: Vec<VaultPosition>,
    /// Sum of all per-vault `usdc_value` fields — decimal string.
    pub portfolio_total_usdc: DecimalU256,
}

/// Entry point invoked from `main.rs`. Returns the process exit code.
pub fn run(config_path: &Path, address_hex: &str, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-position: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let holder = match Address::from_str(address_hex) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-position: --address is not a 20-byte hex address: {e}");
            return EXIT_INPUT_FAIL;
        }
    };

    let registry_addr = match cfg.registry_address.as_deref() {
        Some(s) => match Address::from_str(s) {
            Ok(a) => a,
            Err(e) => {
                log::error!("rmpc get-position: registry_address parse error: {e}");
                return EXIT_STARTUP_FAIL;
            }
        },
        None => {
            log::error!(
                "rmpc get-position: registry_address not set in config; \
                 add `registry_address = \"0x...\"` to the operator TOML"
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
            log::error!("rmpc get-position: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rpc = match cfg.rpc_client() {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-position: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let network_env = NetworkEnv::from_chain_id(cfg.chain_id);
    log::info!(
        "rmpc get-position: network environment: {} (chain_id={})",
        network_env.human_label(),
        cfg.chain_id
    );

    let env = match rt.block_on(read_position(&rpc, registry_addr, holder)) {
        Ok(e) => e,
        Err(e) => {
            log::error!("rmpc get-position: pre-read setup failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    emit(&env, pretty);
    EXIT_OK
}

/// Drive the position read against a pinned block. Pre-read setup failures
/// (chain id, block number, `listVaults()`) propagate as `Err`; per-vault
/// sub-read failures are captured via `record_err` on the builder.
async fn read_position(
    rpc: &FailoverRpcClient,
    registry: Address,
    holder: Address,
) -> crate::errors::Result<Envelope<PositionData>> {
    let chain_id = rpc.chain_id().await?;
    let block_number = rpc.block_number().await?;
    let block_tag = format!("0x{block_number:x}");

    // listVaults() — load-bearing call; if it fails propagate so caller gets
    // EXIT_STARTUP_FAIL (not a partial envelope).
    let vault_addrs = call_list_vaults(rpc, registry, &block_tag).await?;

    let data = PositionData {
        address: format!("{holder:#x}"),
        vaults: Vec::with_capacity(vault_addrs.len()),
        portfolio_total_usdc: DecimalU256(U256::ZERO),
    };
    let mut b = PartialBuilder::new(chain_id, block_number, data);

    let mut portfolio_total = U256::ZERO;

    for (i, vault_addr) in vault_addrs.iter().enumerate() {
        let prefix = format!("vaults[{i}]");

        // Fetch registry record for receipt_token_address.
        let receipt_token_addr = match call_get_vault(rpc, registry, *vault_addr, &block_tag).await
        {
            Ok(r) => format!("{:#x}", r.receiptToken),
            Err(e) => {
                b.record_err(format!("{prefix}.registry_record"), e.to_string());
                // Fall back to vault address as receipt token (standard ERC-4626).
                format!("{vault_addr:#x}")
            }
        };

        // Fetch receipt token balance.
        let balance = match call_balance_of(rpc, *vault_addr, holder, &block_tag).await {
            Ok(v) => v,
            Err(e) => {
                b.record_err(format!("{prefix}.receipt_token_balance"), e);
                U256::ZERO
            }
        };

        // Fetch USDC value via previewRedeem(balance).
        let usdc_value = if balance.is_zero() {
            // Skip the RPC call for zero-balance — previewRedeem(0) == 0.
            U256::ZERO
        } else {
            match call_preview_redeem(rpc, *vault_addr, balance, &block_tag).await {
                Ok(v) => v,
                Err(e) => {
                    b.record_err(format!("{prefix}.usdc_value"), e);
                    U256::ZERO
                }
            }
        };

        // Fetch vault totalAssets for share-of-TVL.
        let total_assets = match call_total_assets(rpc, *vault_addr, &block_tag).await {
            Ok(v) => v,
            Err(e) => {
                b.record_err(format!("{prefix}.vault_tvl_share_bps"), e);
                U256::ZERO
            }
        };

        // Compute vault_tvl_share_bps = usdc_value * 10_000 / total_assets.
        // When totalAssets == 0, share is 0 per spec.
        let vault_tvl_share_bps: u64 = if total_assets.is_zero() || usdc_value.is_zero() {
            0
        } else {
            // Multiply first to preserve precision.
            let numerator = usdc_value.saturating_mul(U256::from(10_000u64));
            let bps = numerator / total_assets;
            // Clamp to u64::MAX (can't exceed 10_000 in practice unless previewRedeem > totalAssets).
            u64::try_from(bps).unwrap_or(10_000)
        };

        portfolio_total = portfolio_total.saturating_add(usdc_value);

        b.data_mut().vaults.push(VaultPosition {
            vault_address: format!("{vault_addr:#x}"),
            receipt_token_address: receipt_token_addr,
            receipt_token_balance: DecimalU256(balance),
            usdc_value: DecimalU256(usdc_value),
            vault_tvl_share_bps,
        });
    }

    b.data_mut().portfolio_total_usdc = DecimalU256(portfolio_total);

    Ok(b.finish())
}

// ---- typed view helpers --------------------------------------------------

/// Call `VaultRegistry.listVaults()` and return the decoded `address[]`.
async fn call_list_vaults(
    rpc: &FailoverRpcClient,
    registry: Address,
    block_tag: &str,
) -> crate::errors::Result<Vec<Address>> {
    let data = VaultRegistry::listVaultsCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: registry,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = VaultRegistry::listVaultsCall::abi_decode_returns(&out, true).map_err(|e| {
        crate::errors::RmpcError::ErrRpcDecode(format!("listVaults abi decode: {e}"))
    })?;
    Ok(r._0)
}

/// Call `VaultRegistry.getVault(address)` and return the decoded `VaultRecord`.
async fn call_get_vault(
    rpc: &FailoverRpcClient,
    registry: Address,
    vault: Address,
    block_tag: &str,
) -> crate::errors::Result<VaultRegistry::VaultRecord> {
    let data = VaultRegistry::getVaultCall { vault }.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: registry,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await?;
    let r = VaultRegistry::getVaultCall::abi_decode_returns(&out, true)
        .map_err(|e| crate::errors::RmpcError::ErrRpcDecode(format!("getVault abi decode: {e}")))?;
    Ok(r._0)
}

/// Call `vault.balanceOf(holder)` and return the decoded `U256`.
async fn call_balance_of(
    rpc: &FailoverRpcClient,
    vault: Address,
    holder: Address,
    block_tag: &str,
) -> std::result::Result<U256, String> {
    let data = MockVault::balanceOfCall { account: holder }.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: vault,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    let r = MockVault::balanceOfCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

/// Call `vault.previewRedeem(shares)` and return the decoded `U256`.
async fn call_preview_redeem(
    rpc: &FailoverRpcClient,
    vault: Address,
    shares: U256,
    block_tag: &str,
) -> std::result::Result<U256, String> {
    let data = MockVault::previewRedeemCall { shares }.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: vault,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    let r = MockVault::previewRedeemCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

/// Call `vault.totalAssets()` and return the decoded `U256`.
async fn call_total_assets(
    rpc: &FailoverRpcClient,
    vault: Address,
    block_tag: &str,
) -> std::result::Result<U256, String> {
    let data = MockVault::totalAssetsCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: vault,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    let r = MockVault::totalAssetsCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-position output serialises");
    println!("{json}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Unit test: PositionData and Envelope<PositionData> serialise to the
    /// §9 output contract shape (decimal strings for U256 fields, required
    /// envelope header fields present).
    #[test]
    fn get_position_serializes() {
        let pos = VaultPosition {
            vault_address: "0x0000000000000000000000000000000000000001".to_string(),
            receipt_token_address: "0x0000000000000000000000000000000000000001".to_string(),
            receipt_token_balance: DecimalU256(U256::from(500_000u64)),
            usdc_value: DecimalU256(U256::from(1_000_000u64)),
            vault_tvl_share_bps: 5000,
        };
        let data = PositionData {
            address: "0x0000000000000000000000000000000000000002".to_string(),
            vaults: vec![pos],
            portfolio_total_usdc: DecimalU256(U256::from(1_000_000u64)),
        };
        let env: Envelope<PositionData> = PartialBuilder::new(8453, 17_000_000, data).finish();
        let v: Value = serde_json::to_value(&env).unwrap();

        // Envelope header fields
        assert_eq!(v["chain_id"], 8453, "chain_id must be present");
        assert_eq!(
            v["block_number"], 17_000_000,
            "block_number must be present"
        );
        assert_eq!(v["source"], "json_rpc", "source must be json_rpc");
        assert_eq!(v["partial"], false, "partial must be false");
        assert!(
            v["errors"].as_array().unwrap().is_empty(),
            "errors must be empty"
        );

        // Data fields
        let d = &v["data"];
        assert_eq!(d["address"], "0x0000000000000000000000000000000000000002");
        assert!(
            d["portfolio_total_usdc"].is_string(),
            "portfolio_total_usdc must be string"
        );
        assert_eq!(d["portfolio_total_usdc"], "1000000");

        // Vault entry
        let vault = &d["vaults"][0];
        assert_eq!(
            vault["vault_address"],
            "0x0000000000000000000000000000000000000001"
        );
        assert_eq!(
            vault["receipt_token_address"],
            "0x0000000000000000000000000000000000000001"
        );
        assert!(
            vault["receipt_token_balance"].is_string(),
            "receipt_token_balance must be decimal string"
        );
        assert_eq!(vault["receipt_token_balance"], "500000");
        assert!(
            vault["usdc_value"].is_string(),
            "usdc_value must be decimal string"
        );
        assert_eq!(vault["usdc_value"], "1000000");
        assert_eq!(vault["vault_tvl_share_bps"], 5000);
    }

    #[test]
    fn position_data_empty_vaults_serialises_as_array() {
        let data = PositionData {
            address: "0x0000000000000000000000000000000000000001".to_string(),
            vaults: vec![],
            portfolio_total_usdc: DecimalU256(U256::ZERO),
        };
        let v: Value = serde_json::to_value(&data).unwrap();
        assert!(v["vaults"].as_array().unwrap().is_empty());
        assert_eq!(v["portfolio_total_usdc"], "0");
    }

    #[test]
    fn vault_tvl_share_bps_zero_when_total_assets_zero() {
        // When totalAssets == 0, share must be 0.
        let total_assets = U256::ZERO;
        let usdc_value = U256::from(1_000_000u64);
        let bps: u64 = if total_assets.is_zero() || usdc_value.is_zero() {
            0
        } else {
            let numerator = usdc_value.saturating_mul(U256::from(10_000u64));
            let bps_val = numerator / total_assets;
            u64::try_from(bps_val).unwrap_or(10_000)
        };
        assert_eq!(bps, 0);
    }

    #[test]
    fn vault_tvl_share_bps_correct() {
        // 1_000_000 value out of 2_000_000 TVL → 5000 bps (50%)
        let total_assets = U256::from(2_000_000u64);
        let usdc_value = U256::from(1_000_000u64);
        let numerator = usdc_value.saturating_mul(U256::from(10_000u64));
        let bps = u64::try_from(numerator / total_assets).unwrap_or(10_000);
        assert_eq!(bps, 5000);
    }

    /// When registry_address is absent from config, run() must return
    /// EXIT_STARTUP_FAIL without touching the network.
    #[test]
    fn run_fails_fast_without_registry_address() {
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
        let code = run(
            &cfg_path,
            "0x0000000000000000000000000000000000000001",
            false,
        );
        assert_eq!(code, EXIT_STARTUP_FAIL);
    }

    /// A malformed address must return EXIT_INPUT_FAIL (2).
    #[test]
    fn run_fails_on_malformed_address() {
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
registry_address      = "0x{reg}"

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
            usdc = "00".repeat(20),
            vault = "00".repeat(20),
            zeros = "0".repeat(64),
            reg = "00".repeat(20),
            ks = keystore.display(),
        );
        std::fs::write(&cfg_path, &toml).expect("write rmpc.toml");
        let code = run(&cfg_path, "not-an-address", false);
        assert_eq!(code, EXIT_INPUT_FAIL);
    }
}
