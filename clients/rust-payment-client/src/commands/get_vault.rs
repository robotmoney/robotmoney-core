//! Canonical: docs/implementation-plan.md §9 — Phase 3 Direct Chain-Read Query Tooling
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! `rmpc get-vault` — direct on-chain read of the vault the gateway
//! routes deposits to.
//!
//! Sub-reads (all `eth_call`, pinned to one block):
//!
//! - `gateway.vault()` → vault address (so we cross-check against the
//!   operator-pinned `vault_address` and surface the on-chain truth).
//! - `vault.asset()` / `assetToken()` — underlying ERC-20.
//! - `vault.name()` / `vault.symbol()` / `vault.decimals()` — share-token
//!   metadata.
//! - `vault.totalAssets()` / `vault.totalSupply()` — accounting state.
//!
//! `share_price` is computed in the client as
//! `totalAssets * 10^decimals / totalSupply`, in the underlying-asset's
//! smallest unit, on the §9 "decimal string" wire. When `totalSupply == 0`
//! the price is undefined and the field is reported as `null`.
//!
//! Per §9 acceptance criteria, fields the deployed `MockVault` ABI
//! does not expose (deposit caps, pause/shutdown, adapter info, fees)
//! are reported as the literal string `"not_onchain"` in a separate
//! `notes` map. Future vault ABIs that add those views will swap the
//! note for a real read in a follow-up batch — the contract surface
//! drives the schema, not the docs.
//!
//! Exit codes: 0 (envelope, possibly partial), 3 (pre-read setup fail).

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::{MockVault, RobotMoneyGateway};
use crate::network_env::NetworkEnv;
use crate::read_output::{DecimalU256, Envelope, PartialBuilder};
use crate::rpc::{CallRequest, RpcClient};

const EXIT_OK: i32 = 0;
const EXIT_STARTUP_FAIL: i32 = 3;

/// `data` payload for `rmpc get-vault`. Field order is the wire order;
/// snapshot tests assert on it.
#[derive(Debug, Default, Serialize)]
pub struct VaultData {
    /// Vault address as resolved from the operator config.
    pub address: String,
    /// `gateway.vault()` — what the gateway *actually* routes to. Empty
    /// when the cross-check sub-read failed; consumers can compare
    /// `gateway_vault` and `address` to detect drift between operator
    /// config and the deployed gateway.
    pub gateway_vault: String,
    /// `vault.asset()` lowercase 0x-hex.
    pub asset: String,
    /// `vault.name()`. Empty string when the read failed.
    pub name: String,
    /// `vault.symbol()`.
    pub symbol: String,
    /// `vault.decimals()` — ERC-20 share decimals.
    pub decimals: u8,
    /// `vault.totalAssets()` — `uint256` decimal string.
    pub total_assets: DecimalU256,
    /// `vault.totalSupply()` — `uint256` decimal string.
    pub total_supply: DecimalU256,
    /// Computed share price as `totalAssets * 10^decimals / totalSupply`,
    /// rendered as a decimal string. `null` when `totalSupply == 0`
    /// (price is undefined).
    pub share_price: Option<String>,
    /// Per §9: explicit markers for fields the deployed contract
    /// surface does not expose. The map values are the literal string
    /// `"not_onchain"`; future ABI extensions promote them to first-
    /// class fields in a follow-up batch.
    pub notes: VaultNotes,
}

/// Sentinel block: every entry is the literal `"not_onchain"`. A future
/// vault ABI that exposes these views replaces the sentinel with a real
/// field on `VaultData` and removes it from this struct.
#[derive(Debug, Serialize)]
pub struct VaultNotes {
    pub deposit_cap: &'static str,
    pub paused: &'static str,
    pub shutdown: &'static str,
    pub adapters: &'static str,
    pub fees: &'static str,
}

impl Default for VaultNotes {
    fn default() -> Self {
        Self {
            deposit_cap: "not_onchain",
            paused: "not_onchain",
            shutdown: "not_onchain",
            adapters: "not_onchain",
            fees: "not_onchain",
        }
    }
}

pub fn run(config_path: &Path, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-vault: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let gateway_addr = match Address::from_str(&cfg.gateway_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-vault: gateway_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let vault_addr = match Address::from_str(&cfg.vault_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-vault: vault_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc get-vault: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-vault: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let network_env = NetworkEnv::from_chain_id(cfg.chain_id);
    log::info!(
        "rmpc get-vault: network environment: {} (chain_id={})",
        network_env.human_label(),
        cfg.chain_id
    );
    let env = match rt.block_on(read_vault(&rpc, gateway_addr, vault_addr)) {
        Ok(e) => e,
        Err(e) => {
            log::error!("rmpc get-vault: pre-read setup failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };
    emit(&env, pretty);
    EXIT_OK
}

async fn read_vault(
    rpc: &RpcClient,
    gateway: Address,
    vault: Address,
) -> crate::errors::Result<Envelope<VaultData>> {
    let chain_id = rpc.chain_id().await?;
    let block_number = rpc.block_number().await?;
    let block_tag = format!("0x{block_number:x}");

    let data = VaultData {
        address: format!("{vault:#x}"),
        ..Default::default()
    };
    let mut b = PartialBuilder::new(chain_id, block_number, data);

    // gateway.vault()
    match call_vault_addr(rpc, gateway, &block_tag).await {
        Ok(addr) => b.data_mut().gateway_vault = format!("{addr:#x}"),
        Err(e) => b.record_err("gateway_vault", e),
    }

    // vault.asset()
    match call_asset(rpc, vault, &block_tag).await {
        Ok(addr) => b.data_mut().asset = format!("{addr:#x}"),
        Err(e) => b.record_err("asset", e),
    }

    // vault.name() / vault.symbol() / vault.decimals()
    match call_string(rpc, vault, &block_tag, MockVault::nameCall {}).await {
        Ok(s) => b.data_mut().name = s,
        Err(e) => b.record_err("name", e),
    }
    match call_string(rpc, vault, &block_tag, MockVault::symbolCall {}).await {
        Ok(s) => b.data_mut().symbol = s,
        Err(e) => b.record_err("symbol", e),
    }
    match call_decimals(rpc, vault, &block_tag).await {
        Ok(d) => b.data_mut().decimals = d,
        Err(e) => b.record_err("decimals", e),
    }

    // accounting
    let total_assets =
        match call_u256_view(rpc, vault, &block_tag, MockVault::totalAssetsCall {}).await {
            Ok(v) => {
                b.data_mut().total_assets = DecimalU256(v);
                Some(v)
            }
            Err(e) => {
                b.record_err("total_assets", e);
                None
            }
        };
    let total_supply =
        match call_u256_view(rpc, vault, &block_tag, MockVault::totalSupplyCall {}).await {
            Ok(v) => {
                b.data_mut().total_supply = DecimalU256(v);
                Some(v)
            }
            Err(e) => {
                b.record_err("total_supply", e);
                None
            }
        };

    // share_price: only computable when both reads succeeded.
    if let (Some(ta), Some(ts)) = (total_assets, total_supply) {
        let decimals = b.data_mut().decimals;
        let price = compute_share_price(ta, ts, decimals);
        b.data_mut().share_price = price;
    }

    Ok(b.finish())
}

/// Compute `totalAssets * 10^decimals / totalSupply` as a decimal
/// string. Returns `None` when `totalSupply == 0` — the price is
/// undefined there and surfacing `null` is the §9-correct way to
/// signal "no answer" for a single-cell field. Saturates on overflow
/// of the multiplication (vanishingly unlikely at sane decimals, but
/// the saturating boundary is defined behavior, not a panic).
fn compute_share_price(total_assets: U256, total_supply: U256, decimals: u8) -> Option<String> {
    if total_supply.is_zero() {
        return None;
    }
    let scale = U256::from(10u64).pow(U256::from(decimals as u64));
    let numerator = total_assets.saturating_mul(scale);
    let price = numerator / total_supply;
    Some(price.to_string())
}

// ---- typed view helpers --------------------------------------------------

async fn call_vault_addr(
    rpc: &RpcClient,
    gateway: Address,
    block_tag: &str,
) -> std::result::Result<Address, String> {
    let data = RobotMoneyGateway::vaultCall {}.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: gateway,
                from: None,
                data: data.into(),
            },
            Some(block_tag),
        )
        .await
        .map_err(|e| format!("eth_call failed: {e}"))?;
    let r = RobotMoneyGateway::vaultCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

async fn call_asset(
    rpc: &RpcClient,
    vault: Address,
    block_tag: &str,
) -> std::result::Result<Address, String> {
    let data = MockVault::assetCall {}.abi_encode();
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
    let r = MockVault::assetCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

async fn call_decimals(
    rpc: &RpcClient,
    vault: Address,
    block_tag: &str,
) -> std::result::Result<u8, String> {
    let data = MockVault::decimalsCall {}.abi_encode();
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
    let r = MockVault::decimalsCall::abi_decode_returns(&out, true)
        .map_err(|e| format!("abi decode: {e}"))?;
    Ok(r._0)
}

/// Generic helper for `() -> string` views on the vault.
async fn call_string<C>(
    rpc: &RpcClient,
    vault: Address,
    block_tag: &str,
    call: C,
) -> std::result::Result<String, String>
where
    C: SolCall,
    C::Return: ReturnString,
{
    let data = call.abi_encode();
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
    let r = C::abi_decode_returns(&out, true).map_err(|e| format!("abi decode: {e}"))?;
    Ok(r.into_string())
}

trait ReturnString {
    fn into_string(self) -> String;
}
impl ReturnString for MockVault::nameReturn {
    fn into_string(self) -> String {
        self._0
    }
}
impl ReturnString for MockVault::symbolReturn {
    fn into_string(self) -> String {
        self._0
    }
}

/// Generic helper for `() -> uint256` views on the vault.
async fn call_u256_view<C>(
    rpc: &RpcClient,
    vault: Address,
    block_tag: &str,
    call: C,
) -> std::result::Result<U256, String>
where
    C: SolCall,
    C::Return: ReturnU256,
{
    let data = call.abi_encode();
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
    let r = C::abi_decode_returns(&out, true).map_err(|e| format!("abi decode: {e}"))?;
    Ok(r.into_u256())
}

trait ReturnU256 {
    fn into_u256(self) -> U256;
}
impl ReturnU256 for MockVault::totalAssetsReturn {
    fn into_u256(self) -> U256 {
        self._0
    }
}
impl ReturnU256 for MockVault::totalSupplyReturn {
    fn into_u256(self) -> U256 {
        self._0
    }
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-vault output serialises");
    println!("{json}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_price_zero_supply_yields_none() {
        assert!(compute_share_price(U256::from(1u64), U256::ZERO, 6).is_none());
    }

    #[test]
    fn share_price_one_to_one_with_six_decimals() {
        // total_assets = total_supply = 1_000_000 (1.0 with 6 decimals)
        // expected share_price = 10^6 (one share is worth one unit)
        let p = compute_share_price(U256::from(1_000_000u64), U256::from(1_000_000u64), 6).unwrap();
        assert_eq!(p, "1000000");
    }

    #[test]
    fn share_price_premium_above_par() {
        // total_assets = 2_000_000, supply = 1_000_000, decimals = 6
        // → 2 * 10^6 = 2000000
        let p = compute_share_price(U256::from(2_000_000u64), U256::from(1_000_000u64), 6).unwrap();
        assert_eq!(p, "2000000");
    }

    /// Migrated from suite-05 (`testing/fork-e2e-rust/tests/rmpc_get_vault_fork.rs`).
    ///
    /// A malformed `vault_address` in the operator config must cause `run()` to
    /// return `EXIT_STARTUP_FAIL` (3) immediately, without touching the network.
    /// This exercises the `Address::from_str` guard in `get_vault::run()` and
    /// requires no chain or fork fixture.
    #[test]
    fn rmpc_get_vault_rejects_malformed_address() {
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let keystore = tmp.path().join("keystore.json");
        let cfg_path = tmp.path().join("rmpc.toml");
        let toml = format!(
            r#"chain_id              = 8453
rpc_url               = "http://127.0.0.1:1"
gateway_address       = "0x000000000000000000000000000000000000dEaD"
usdc_address          = "0x{usdc}"
vault_address         = "not-a-hex-address"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
            usdc = "00".repeat(20),
            zeros = "0".repeat(64),
            ks = keystore.display(),
        );
        std::fs::write(&cfg_path, &toml).expect("write rmpc.toml");

        // EXIT_STARTUP_FAIL = 3: the vault_address parse must fail before any
        // RPC attempt is made, so this test never touches the network.
        let code = run(&cfg_path, false);
        assert_eq!(
            code, EXIT_STARTUP_FAIL,
            "expected EXIT_STARTUP_FAIL ({EXIT_STARTUP_FAIL}) on malformed vault_address; got {code}"
        );
    }
}
