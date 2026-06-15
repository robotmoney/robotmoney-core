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
    /// An env var that is present but **empty** is treated as unset and yields
    /// `None`. GitHub Actions injects an absent `${{ secrets.X }}` as the empty
    /// string, so without this an unprovisioned secret would otherwise resolve
    /// to `Some("")` — pointing the harness at an empty URL, which fails the
    /// connection (`eth_blockNumber: builder error`) instead of skipping. This
    /// matches the empty-string filtering used throughout the rest of the
    /// harness (e.g. [`crate::ForkFixture::new`]).
    ///
    /// # Acceptance criteria link
    /// "e2e test harness accepts Base testnet RPC endpoint via env var or config"
    pub fn rpc_url(&self) -> Option<String> {
        match self {
            Network::BaseMainnet => {
                // Mainnet mode: return RMPC_FORK_RPC_URL if set (and non-empty),
                // None otherwise (tests skip on None).
                env::var("RMPC_FORK_RPC_URL").ok().filter(|v| !v.is_empty())
            }
            Network::BaseTestnet => {
                // Testnet mode: return BASE_TESTNET_RPC_URL if set and non-empty.
                // Required for live testnet connectivity.
                env::var("BASE_TESTNET_RPC_URL")
                    .ok()
                    .filter(|v| !v.is_empty())
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

    /// EVM chain id for this network. Base mainnet = 8453, Base Sepolia
    /// (testnet) = 84532. The parameterized adapter tests assert the
    /// connected RPC reports this chain id before exercising any adapter,
    /// so a misconfigured endpoint fails loudly rather than silently
    /// testing the wrong chain.
    pub fn chain_id(&self) -> u64 {
        match self {
            Network::BaseMainnet => crate::BASE_CHAIN_ID,
            Network::BaseTestnet => crate::base_testnet_addresses::BASE_SEPOLIA_CHAIN_ID,
        }
    }

    /// USDC token address for this network — the ERC-4626 vault asset and
    /// the input token for the DEX route adapter test.
    pub fn usdc(&self) -> alloy_primitives::Address {
        match self {
            Network::BaseMainnet => crate::addresses::USDC,
            Network::BaseTestnet => crate::base_testnet_addresses::USDC,
        }
    }

    /// WETH9 address for this network — the DEX route adapter test's output
    /// token.
    pub fn weth9(&self) -> alloy_primitives::Address {
        match self {
            Network::BaseMainnet => crate::addresses::WETH9,
            Network::BaseTestnet => crate::base_testnet_addresses::WETH9,
        }
    }

    /// Uniswap V3 SwapRouter02 address for this network.
    pub fn uniswap_v3_swap_router(&self) -> alloy_primitives::Address {
        match self {
            Network::BaseMainnet => crate::addresses::UNISWAP_V3_SWAP_ROUTER,
            Network::BaseTestnet => crate::base_testnet_addresses::UNISWAP_V3_SWAP_ROUTER,
        }
    }

    /// Aave V3 Pool address for this network — used by the Aave adapter test.
    pub fn aave_v3_pool(&self) -> alloy_primitives::Address {
        match self {
            Network::BaseMainnet => crate::addresses::AAVE_V3_POOL,
            Network::BaseTestnet => crate::base_testnet_addresses::AAVE_V3_POOL,
        }
    }

    /// Every network the parameterized e2e tests iterate over. The macro
    /// [`crate::parameterized_e2e`] runs a single test body once per entry,
    /// skipping any network whose RPC endpoint is unset.
    pub const ALL: &'static [Network] = &[Network::BaseMainnet, Network::BaseTestnet];
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
    fn chain_ids_distinct_and_correct() {
        assert_eq!(Network::BaseMainnet.chain_id(), 8453);
        assert_eq!(Network::BaseTestnet.chain_id(), 84532);
    }

    #[test]
    fn all_networks_covers_both() {
        assert_eq!(Network::ALL.len(), 2);
        assert!(Network::ALL.contains(&Network::BaseMainnet));
        assert!(Network::ALL.contains(&Network::BaseTestnet));
    }

    #[test]
    fn per_network_addresses_differ_for_usdc() {
        // USDC differs across chains; WETH (OP-stack predeploy) is shared.
        assert_ne!(
            Network::BaseMainnet.usdc(),
            Network::BaseTestnet.usdc(),
            "Base mainnet and Sepolia USDC must be different contracts"
        );
        assert_eq!(
            Network::BaseMainnet.weth9(),
            Network::BaseTestnet.weth9(),
            "WETH9 is the same OP-stack predeploy on both networks"
        );
    }

    #[test]
    fn rpc_url_empty_env_resolves_to_none() {
        // GitHub Actions injects an absent `${{ secrets.X }}` as the empty
        // string. An empty value MUST be treated as unset so the parameterized
        // e2e skips gracefully instead of connecting to an empty URL (which
        // fails with `eth_blockNumber: builder error`). Regression for the
        // base-testnet-adapters CI job (issue #839).
        // SAFETY: single-threaded test; set+remove within this test only.
        std::env::set_var("BASE_TESTNET_RPC_URL", "");
        assert_eq!(
            Network::BaseTestnet.rpc_url(),
            None,
            "empty BASE_TESTNET_RPC_URL must resolve to None (graceful skip)"
        );
        std::env::set_var("BASE_TESTNET_RPC_URL", "https://example.invalid");
        assert_eq!(
            Network::BaseTestnet.rpc_url(),
            Some("https://example.invalid".to_string()),
            "non-empty BASE_TESTNET_RPC_URL must resolve to the URL"
        );
        std::env::remove_var("BASE_TESTNET_RPC_URL");
        assert_eq!(
            Network::BaseTestnet.rpc_url(),
            None,
            "unset BASE_TESTNET_RPC_URL must resolve to None"
        );
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
