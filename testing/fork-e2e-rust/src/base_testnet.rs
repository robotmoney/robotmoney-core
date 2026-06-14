//! Canonical: Issue #839 (e2e test adapters on Base testnet).
//!
//! **Dev-scout module:** No-op stubs and configuration seams for Base testnet
//! e2e test support. Integration point discovery and documented entry points
//! for full implementation in issue #839.
//!
//! This module establishes:
//! - Base testnet RPC endpoint configuration (env var with fallback)
//! - Network identifier and parameter seams for multi-network test templates
//! - Placeholder for fixture-based account funding (implemented in #839)
//! - Type-safe network parameter passing to test runners
//!
//! # Design notes
//!
//! Base testnet is a separate network from Base mainnet. Contracts must be
//! deployed to Base testnet addresses (not the mainnet addresses in [`crate::addresses`]).
//! RPC configuration is separate from fork mode to enable direct testnet connections
//! when faucet funding is available.
//!
//! # Future integration points (issue #839)
//!
//! - `BaseTestnetFixture::new()` — boot account, fund native token + USDC
//! - `parameterized_e2e!()` — macro for @network.each style test templates
//! - Contract address registry for deployed Base testnet adapters
//!
//! See docs/scout/base-testnet-guide.md for the test environment setup,
//! known mainnet divergences, and the issue #839 integration roadmap.

use std::env;

/// Network identifier for parameterized test templates.
/// Used to select RPC endpoint, contract addresses, and fixture behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Network {
    /// Base mainnet (forked via anvil or direct RPC).
    BaseMainnet,
    /// Base testnet (Sepolia-linked, faucet-funded).
    BaseTestnet,
}

impl Network {
    /// Get the RPC endpoint for this network from environment or defaults.
    ///
    /// # Base mainnet
    /// Reads `RMPC_FORK_RPC_URL` (for anvil-fork); falls back to bundled
    /// fixture if env var not set.
    ///
    /// # Base testnet
    /// Reads `BASE_TESTNET_RPC_URL` (required for real testnet connection).
    /// Returns `None` if not set; tests using this should skip gracefully.
    ///
    /// # Acceptance criteria link
    /// "e2e test harness accepts Base testnet RPC endpoint via env var or config"
    pub fn rpc_url(&self) -> Option<String> {
        match self {
            Network::BaseMainnet => {
                // Mainnet mode: return RMPC_FORK_RPC_URL if set, None otherwise
                // (tests skip on None). Implementation in issue #839 will wire
                // this to fork logic or fixture.
                env::var("RMPC_FORK_RPC_URL").ok()
            }
            Network::BaseTestnet => {
                // Testnet mode: return BASE_TESTNET_RPC_URL if set.
                // Required for live testnet connectivity.
                env::var("BASE_TESTNET_RPC_URL").ok()
            }
        }
    }

    /// Human-readable network name for logging and error messages.
    pub fn name(&self) -> &'static str {
        match self {
            Network::BaseMainnet => "Base mainnet",
            Network::BaseTestnet => "Base testnet",
        }
    }
}

/// Testnet account funding configuration (dev-scout stub).
///
/// This struct holds the seeding parameters for automated test account funding.
/// Full implementation in issue #839 will wire this to a fixture module that
/// calls the faucet or performs seeded transfers.
///
/// # Acceptance criteria link
/// "Fixture module provides automated Base testnet account funding with
/// sufficient native token and USDC balance"
#[derive(Debug, Clone)]
pub struct TestnetFundingConfig {
    /// Native token (ETH) amount to seed per test account, in wei.
    /// Default: 10 ETH (10_000_000_000_000_000_000 wei).
    pub eth_amount: u128,

    /// USDC amount to seed per test account, in USDC units (6 decimals).
    /// Default: 1000 USDC.
    pub usdc_amount: u128,
}

impl Default for TestnetFundingConfig {
    fn default() -> Self {
        Self {
            // 10 ETH in wei
            eth_amount: 10_000_000_000_000_000_000,
            // 1000 USDC (6 decimals)
            usdc_amount: 1_000_000_000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_name_mainnet() {
        assert_eq!(Network::BaseMainnet.name(), "Base mainnet");
    }

    #[test]
    fn network_name_testnet() {
        assert_eq!(Network::BaseTestnet.name(), "Base testnet");
    }

    #[test]
    fn testnet_funding_default_values() {
        let config = TestnetFundingConfig::default();
        // 10 ETH
        assert_eq!(config.eth_amount, 10_000_000_000_000_000_000);
        // 1000 USDC @ 6 decimals
        assert_eq!(config.usdc_amount, 1_000_000_000);
    }
}
