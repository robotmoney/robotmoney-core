//! Canonical: docs/implementation-plan.md §9 — Phase 3 Direct Chain-Read Query Tooling
//! ADR: docs/technical/rmpc-read-output-contract.md
//!
//! `rmpc get-balance --address 0x…` — ERC-20 token balance for an address.
//!
//! Single-read read command per §9. Wraps a single `eth_call` to the
//! configured USDC token's `balanceOf(address)`, plus an `eth_chainId`
//! and `eth_blockNumber` to populate the [`Envelope`] header. By
//! definition `partial: false` and `errors: []` always.
//!
//! Exit codes:
//! - 0 — balance read succeeded; JSON envelope emitted on stdout.
//! - 2 — input parse failure (bad `--address`).
//! - 3 — config / RPC / decode failure (operator-actionable).

use std::path::Path;
use std::str::FromStr;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use serde::Serialize;

use crate::config::Config;
use crate::gateway::MockUsdc;
use crate::network_env::NetworkEnv;
use crate::read_output::{DecimalU256, Envelope, PartialBuilder};
use crate::rpc::{CallRequest, RpcClient};

const EXIT_OK: i32 = 0;
const EXIT_INPUT_FAIL: i32 = 2;
const EXIT_STARTUP_FAIL: i32 = 3;

/// `data` payload for `get-balance`. The token address is echoed back so
/// callers can cross-check the read was issued against the expected
/// USDC; the holder address is what `--address` resolved to.
#[derive(Debug, Serialize)]
pub struct BalanceData {
    /// 0x-hex address that was queried.
    pub address: String,
    /// 0x-hex token contract address (the USDC configured in operator TOML).
    pub token: String,
    /// Decimal-string ERC-20 balance. Decimals are the token's intrinsic
    /// (USDC == 6); not normalized.
    pub balance: DecimalU256,
}

/// Entry point invoked from `main.rs`. Returns the desired process exit code.
pub fn run(config_path: &Path, address_hex: &str, pretty: bool) -> i32 {
    let cfg = match Config::from_path(config_path) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-balance: failed to load config: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let holder = match Address::from_str(address_hex) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-balance: --address is not a 20-byte hex address: {e}");
            return EXIT_INPUT_FAIL;
        }
    };

    let token = match Address::from_str(&cfg.usdc_address) {
        Ok(a) => a,
        Err(e) => {
            log::error!("rmpc get-balance: usdc_address parse error: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("rmpc get-balance: tokio runtime build failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let rpc = match RpcClient::new(&cfg.rpc_url) {
        Ok(c) => c,
        Err(e) => {
            log::error!("rmpc get-balance: rpc client init failed: {e}");
            return EXIT_STARTUP_FAIL;
        }
    };

    let result: Result<Envelope<BalanceData>, String> = rt.block_on(async {
        let chain_id = rpc
            .chain_id()
            .await
            .map_err(|e| format!("eth_chainId: {e}"))?;
        let block_number = rpc
            .block_number()
            .await
            .map_err(|e| format!("eth_blockNumber: {e}"))?;
        let balance = call_balance_of(&rpc, token, holder)
            .await
            .map_err(|e| format!("balanceOf: {e}"))?;
        Ok(PartialBuilder::new(
            chain_id,
            block_number,
            BalanceData {
                address: format!("{holder:#x}"),
                token: format!("{token:#x}"),
                balance: DecimalU256(balance),
            },
        )
        .finish())
    });

    match result {
        Ok(env) => {
            let network_env = NetworkEnv::from_chain_id(env.chain_id);
            log::info!(
                "rmpc get-balance: network environment: {} (chain_id={})",
                network_env.human_label(),
                env.chain_id
            );
            emit(&env, pretty);
            EXIT_OK
        }
        Err(msg) => {
            log::error!("rmpc get-balance: {msg}");
            EXIT_STARTUP_FAIL
        }
    }
}

async fn call_balance_of(
    rpc: &RpcClient,
    token: Address,
    holder: Address,
) -> Result<U256, crate::errors::RmpcError> {
    let data = MockUsdc::balanceOfCall { account: holder }.abi_encode();
    let out = rpc
        .eth_call(
            &CallRequest {
                to: token,
                from: None,
                data: data.into(),
            },
            None,
        )
        .await?;
    let decoded = MockUsdc::balanceOfCall::abi_decode_returns(&out, true)
        .map_err(|e| crate::errors::RmpcError::ErrRpcDecode(format!("balanceOf decode: {e}")))?;
    Ok(decoded._0)
}

fn emit<T: Serialize>(out: &T, pretty: bool) {
    let json = if pretty {
        serde_json::to_string_pretty(out)
    } else {
        serde_json::to_string(out)
    }
    .expect("get-balance output serialises");
    println!("{json}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn balance_data_serializes_with_decimal_string() {
        let d = BalanceData {
            address: "0xaa".into(),
            token: "0xbb".into(),
            balance: DecimalU256(U256::from(123_456_789_u64)),
        };
        let v = serde_json::to_value(d).unwrap();
        assert_eq!(v["address"], "0xaa");
        assert_eq!(v["token"], "0xbb");
        assert!(
            v["balance"].is_string(),
            "balance must be string per §9 contract"
        );
        assert_eq!(v["balance"], "123456789");
    }

    #[test]
    fn envelope_around_balance_data_has_required_fields() {
        let env: Envelope<BalanceData> = PartialBuilder::new(
            8453,
            17_000_000,
            BalanceData {
                address: "0xaa".into(),
                token: "0xbb".into(),
                balance: DecimalU256(U256::from(0u64)),
            },
        )
        .finish();
        let v: Value = serde_json::to_value(&env).unwrap();
        assert_eq!(v["chain_id"], 8453);
        assert_eq!(v["block_number"], 17_000_000);
        assert_eq!(v["source"], "json_rpc");
        assert_eq!(v["partial"], false);
        assert!(v["errors"].as_array().unwrap().is_empty());
        assert_eq!(v["data"]["balance"], "0");
    }
}
