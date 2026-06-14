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
//! known mainnet divergences, and the issue #839 integration roadmap.

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

#[cfg(test)]
mod tests {
    use super::*;

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
