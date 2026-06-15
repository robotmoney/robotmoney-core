//! Canonical: Issue #839 (e2e test adapters on Base testnet).
//!
//! **Dev-scout module:** No-op stubs and configuration for Base testnet
//! test account funding. Integration point discovery for fixture-based
//! automated seeding of native token and USDC balances.
//!
//! This module establishes:
//! - Base testnet RPC endpoint configuration (env var reading)
//! - Placeholder for account funding implementation (issue #839)
//! - Type-safe funding parameter passing to fixture builders
//! - Account state assertion helpers for CI validation
//!
//! # Design notes
//!
//! Base testnet fixture funding differs from devnet fixture funding:
//! - Devnet: deploys contracts fresh, funds via `forge script`
//! - Base testnet: contracts pre-deployed, accounts funded via faucet or seeded transfers
//!
//! The smoke-test `Fixture` is devnet-only (boots Geth+Lighthouse).
//! Base testnet tests use fork-e2e RPC directly or a future `BaseTestnetFixture`
//! that implements this module's seeding interface.
//!
//! # Future integration points (issue #839)
//!
//! - `BaseTestnetAccount::new()` — create and fund a test account
//! - `BaseTestnetAccount::fund_eth()` — seed native token
//! - `BaseTestnetAccount::fund_usdc()` — seed USDC via faucet or transfer
//! - `assert_account_funded()` — CI validation helper (eth_getBalance)
//! - Parameterized test macro with @network decorator
//!
//! See docs/scout/base-testnet-guide.md for the test environment setup,
//! known Robot Money Devnet divergences, and the issue #839 integration roadmap.

use std::env;

/// Base testnet RPC endpoint source. Allows both fixed configuration
/// and environment-variable override for test flexibility.
#[derive(Debug, Clone)]
pub enum RpcEndpoint {
    /// Fixed RPC endpoint (e.g. from config file).
    Fixed(String),
    /// Environment variable name to read at test time (e.g. "BASE_TESTNET_RPC_URL").
    EnvVar(String),
}

impl RpcEndpoint {
    /// Resolve the RPC endpoint, reading env var if needed.
    /// Returns `None` if the env var is unset (test should skip gracefully).
    pub fn resolve(&self) -> Option<String> {
        match self {
            RpcEndpoint::Fixed(url) => Some(url.clone()),
            RpcEndpoint::EnvVar(var_name) => env::var(var_name).ok(),
        }
    }
}

/// Account funding configuration for Base testnet.
///
/// Holds the seeding amounts and faucet parameters. Full implementation
/// in issue #839 will wire this to actual faucet calls or seeded transfers
/// on the Base testnet chain.
///
/// # Acceptance criteria link
/// "Fixture module provides automated Base testnet account funding with
/// sufficient native token and USDC balance"
#[derive(Debug, Clone)]
pub struct AccountFundingConfig {
    /// Native token (ETH) amount to seed per account, in wei.
    pub eth_amount_wei: u128,

    /// USDC amount to seed per account, in USDC units (6 decimals).
    pub usdc_amount_units: u128,

    /// Faucet URL or funding method identifier (stub for future implementation).
    pub funding_method: FundingMethod,
}

impl Default for AccountFundingConfig {
    fn default() -> Self {
        Self {
            // 5 ETH in wei (sufficient for ~50 transactions @ 100 gwei)
            eth_amount_wei: 5_000_000_000_000_000_000,
            // 1000 USDC (6 decimals = 1_000_000_000 units)
            usdc_amount_units: 1_000_000_000,
            funding_method: FundingMethod::Faucet,
        }
    }
}

/// Funding method identifier for Base testnet account seeding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FundingMethod {
    /// Faucet-based funding (requires testnet faucet availability).
    Faucet,
    /// Seeded transfer from a pre-funded account.
    SeededTransfer,
    /// Manual funding (tests skip if not pre-funded).
    Manual,
}

impl FundingMethod {
    /// Human-readable method name.
    pub fn name(&self) -> &'static str {
        match self {
            FundingMethod::Faucet => "faucet",
            FundingMethod::SeededTransfer => "seeded_transfer",
            FundingMethod::Manual => "manual",
        }
    }
}

/// Helper to check if a Base testnet account has been funded.
///
/// # Acceptance criteria link
/// "Assert by running fixture setup in CI and checking account balances via eth_getBalance"
///
/// Full implementation in issue #839 will call eth_getBalance via RPC.
#[derive(Debug, Clone)]
pub struct AccountFundingAssertion {
    /// Minimum ETH balance required to consider funding successful (wei).
    pub min_eth_wei: u128,
    /// Minimum USDC balance required to consider funding successful (units).
    pub min_usdc_units: u128,
}

impl Default for AccountFundingAssertion {
    fn default() -> Self {
        Self {
            // At least 0.1 ETH confirms funding
            min_eth_wei: 100_000_000_000_000_000,
            // At least 10 USDC confirms funding
            min_usdc_units: 10_000_000,
        }
    }
}

// ── Live funding + balance assertion (issue #839) ─────────────────────────────

use alloy_primitives::{Address, U256};

/// Error raised while funding or asserting a Base testnet account.
#[derive(Debug, thiserror::Error)]
pub enum FundingError {
    /// The RPC endpoint (or a required funder secret) is not configured. Treated
    /// as a graceful skip by callers — never a hard failure on a contributor
    /// laptop without the testnet secret.
    #[error("base testnet RPC/funder not configured; skipping")]
    Skip,
    /// JSON-RPC transport or decode error.
    #[error("rpc error: {0}")]
    Rpc(String),
    /// Account funding completed but the post-funding balance assertion failed.
    #[error("funding assertion failed: {0}")]
    Assertion(String),
}

impl FundingError {
    /// True when this error means "endpoint not configured; skip rather than
    /// fail" — the same contract the fork-e2e harness uses.
    pub fn is_skip(&self) -> bool {
        matches!(self, FundingError::Skip)
    }
}

/// A funded test account on Base testnet (Sepolia). Constructed against a live
/// RPC endpoint; provides the `eth_getBalance` validation the acceptance
/// criteria require ("assert by … checking account balances via eth_getBalance").
///
/// This is intentionally a *read + assert* surface over a real EOA address
/// rather than a key generator — the funder/key wiring (seeded transfers vs
/// faucet) lives in the fork-e2e harness's [`ForkFixture::ephemeral_testnet`].
/// Here we validate that whatever funding ran left the account above the
/// [`AccountFundingAssertion`] thresholds, which is the CI gate.
#[derive(Debug, Clone)]
pub struct BaseTestnetAccount {
    /// The account address whose balances we assert.
    pub address: Address,
    /// Resolved RPC endpoint (e.g. from `RpcEndpoint::EnvVar("BASE_TESTNET_RPC_URL")`).
    rpc_url: String,
    http: reqwest::blocking::Client,
}

impl BaseTestnetAccount {
    /// Bind to `address` on the network reachable at `endpoint`. Returns
    /// [`FundingError::Skip`] when the endpoint env var is unset.
    pub fn new(endpoint: &RpcEndpoint, address: Address) -> Result<Self, FundingError> {
        let rpc_url = endpoint.resolve().ok_or(FundingError::Skip)?;
        let http = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| FundingError::Rpc(format!("http client: {e}")))?;
        Ok(Self {
            address,
            rpc_url,
            http,
        })
    }

    /// Native ETH balance of [`Self::address`] in wei, via `eth_getBalance`.
    pub fn eth_balance(&self) -> Result<U256, FundingError> {
        let hex: String = self.rpc(
            "eth_getBalance",
            serde_json::json!([format!("{:#x}", self.address), "latest"]),
        )?;
        U256::from_str_radix(hex.trim_start_matches("0x"), 16)
            .map_err(|e| FundingError::Rpc(format!("eth_getBalance decode: {e}")))
    }

    /// ERC-20 balance of [`Self::address`] for `token` via an `eth_call` to
    /// `balanceOf(address)` (selector `0x70a08231`). Used to assert USDC funding.
    pub fn token_balance(&self, token: Address) -> Result<U256, FundingError> {
        // balanceOf(address) selector + 32-byte left-padded address.
        let mut data = vec![0x70u8, 0xa0, 0x82, 0x31];
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(self.address.as_slice());
        let call = serde_json::json!([
            {
                "to": format!("{:#x}", token),
                "data": format!("0x{}", hex::encode(&data)),
            },
            "latest"
        ]);
        let ret: String = self.rpc("eth_call", call)?;
        let bytes = hex::decode(ret.trim_start_matches("0x"))
            .map_err(|e| FundingError::Rpc(format!("balanceOf decode: {e}")))?;
        if bytes.len() < 32 {
            return Err(FundingError::Rpc(format!(
                "balanceOf returned {} bytes (<32)",
                bytes.len()
            )));
        }
        Ok(U256::from_be_slice(&bytes[..32]))
    }

    /// Assert the account is funded above the thresholds in `assertion` against
    /// `usdc_token`. This is the CI gate the acceptance criteria call for:
    /// "run fixture setup in CI and check account balances via eth_getBalance".
    pub fn assert_funded(
        &self,
        assertion: &AccountFundingAssertion,
        usdc_token: Address,
    ) -> Result<(), FundingError> {
        let eth = self.eth_balance()?;
        if eth < U256::from(assertion.min_eth_wei) {
            return Err(FundingError::Assertion(format!(
                "ETH balance {eth} wei < required {} wei for {:#x}",
                assertion.min_eth_wei, self.address
            )));
        }
        let usdc = self.token_balance(usdc_token)?;
        if usdc < U256::from(assertion.min_usdc_units) {
            return Err(FundingError::Assertion(format!(
                "USDC balance {usdc} units < required {} units for {:#x}",
                assertion.min_usdc_units, self.address
            )));
        }
        Ok(())
    }

    fn rpc<T: for<'de> serde::Deserialize<'de>>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, FundingError> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let resp: serde_json::Value = self
            .http
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| FundingError::Rpc(format!("{method}: {e}")))?;
        if let Some(err) = resp.get("error") {
            return Err(FundingError::Rpc(format!("{method}: {err}")));
        }
        let result = resp
            .get("result")
            .ok_or_else(|| FundingError::Rpc(format!("{method}: no result field")))?
            .clone();
        serde_json::from_value(result)
            .map_err(|e| FundingError::Rpc(format!("{method}: decode: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_testnet_account_skips_without_rpc() {
        let ep = RpcEndpoint::EnvVar("BASE_TESTNET_RPC_URL_UNSET_FOR_TEST".to_string());
        let err = BaseTestnetAccount::new(&ep, Address::ZERO).unwrap_err();
        assert!(err.is_skip(), "unset RPC env var must produce a Skip error");
    }

    #[test]
    fn funding_error_skip_classification() {
        assert!(FundingError::Skip.is_skip());
        assert!(!FundingError::Rpc("x".into()).is_skip());
        assert!(!FundingError::Assertion("x".into()).is_skip());
    }

    #[test]
    fn funding_method_name_faucet() {
        assert_eq!(FundingMethod::Faucet.name(), "faucet");
    }

    #[test]
    fn funding_method_name_seeded() {
        assert_eq!(FundingMethod::SeededTransfer.name(), "seeded_transfer");
    }

    #[test]
    fn account_funding_config_defaults() {
        let config = AccountFundingConfig::default();
        // 5 ETH
        assert_eq!(config.eth_amount_wei, 5_000_000_000_000_000_000);
        // 1000 USDC @ 6 decimals
        assert_eq!(config.usdc_amount_units, 1_000_000_000);
        assert_eq!(config.funding_method, FundingMethod::Faucet);
    }

    #[test]
    fn account_funding_assertion_defaults() {
        let assertion = AccountFundingAssertion::default();
        // 0.1 ETH
        assert_eq!(assertion.min_eth_wei, 100_000_000_000_000_000);
        // 10 USDC
        assert_eq!(assertion.min_usdc_units, 10_000_000);
    }

    #[test]
    fn rpc_endpoint_fixed() {
        let ep = RpcEndpoint::Fixed("http://localhost:8545".to_string());
        assert_eq!(ep.resolve(), Some("http://localhost:8545".to_string()));
    }

    #[test]
    fn rpc_endpoint_env_var_unset() {
        let ep = RpcEndpoint::EnvVar("NONEXISTENT_RPC_VAR".to_string());
        assert_eq!(ep.resolve(), None);
    }
}
