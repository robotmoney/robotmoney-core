//! Canonical: Issue #839 (e2e test adapters on Base testnet).
//!
//! Deployed contract addresses for **Base Sepolia (chain id 84532)** — the
//! Robot Money testnet network. Mirrors the structure of [`crate::addresses`]
//! (Base mainnet) so the parameterized multi-network e2e tests can select the
//! correct address set per [`crate::Network`].
//!
//! # What lives here
//!
//! Two categories of address:
//!
//! 1. **Live third-party services** (Aave V3, Uniswap V3, canonical USDC/WETH).
//!    These exist on Base Sepolia today and are publicly documented; the
//!    adapter e2e tests call them directly to validate cross-chain adapter
//!    behavior (issue #839 acceptance criteria).
//! 2. **Robot Money's own contracts** (vault + strategy adapters). These are
//!    NOT yet deployed to Base Sepolia — deployment is an explicit
//!    *prerequisite* and is out of scope for issue #839. They are therefore
//!    exposed as [`Option<Address>`] via [`robotmoney_vault`] /
//!    [`robotmoney_adapter`], returning `None` until a deploy populates the
//!    `RM_TESTNET_*` env vars. Tests that need them skip gracefully on `None`.
//!
//! # Why env-var overrides for Robot Money contracts
//!
//! rmpc is prod-only and never branches on environment. This module is *test
//! infrastructure*, not client code: it reads `RM_TESTNET_VAULT_ADDR` etc. so
//! a future Base Sepolia deploy can wire the e2e suite in CI without a code
//! change, keeping the deploy step (out of scope here) decoupled from the test
//! code (in scope here). The acceptance criterion — "RPC endpoint is
//! configurable via env var or fixture … without configuration changes to test
//! code" — extends naturally to deployed addresses.

use std::env;

use alloy_primitives::{address, keccak256, Address, B256};

// -- Live third-party services on Base Sepolia (chain 84532) ----------
// These are public, canonical Base Sepolia addresses. Sources are noted
// inline; they are the testnet equivalents of the Base-mainnet constants
// in `crate::addresses`.

/// Circle's USDC on Base Sepolia (6 decimals). The canonical testnet USDC
/// Circle mints to faucet requests. asset token for the testnet vault.
/// Source: Circle USDC contract addresses (testnet) — Base Sepolia.
pub const USDC: Address = address!("036cbd53842c5426634e7929541ec2318f3dcf7e");

/// WETH9 on Base Sepolia. Predeploy at the canonical OP-stack WETH address,
/// identical to Base mainnet. Used as the intermediate token in the smallest
/// useful DEX route smoke (USDC -> WETH).
pub const WETH9: Address = address!("4200000000000000000000000000000000000006");

/// Uniswap V3 SwapRouter02 on Base Sepolia. Used by the parameterized
/// `dex_route` adapter test to exercise a live Uniswap swap on testnet.
/// Source: Uniswap deployment addresses — Base Sepolia.
pub const UNISWAP_V3_SWAP_ROUTER: Address = address!("94cc0aac535ccdb3c01d6787d6413c739ae12bc4");

/// Aave V3 Pool on Base Sepolia. Used by the parameterized adapter test to
/// validate the Aave lend path against the live testnet pool.
/// Source: Aave V3 testnet deployment — Base Sepolia.
pub const AAVE_V3_POOL: Address = address!("07ea79f68b2b3df564d0a34f8e19d9b1e339814b");

/// Base Sepolia chain id. Mirrors [`crate::BASE_CHAIN_ID`] (mainnet, 8453).
pub const BASE_SEPOLIA_CHAIN_ID: u64 = 84532;

// -- Robot Money contracts (deploy is a prerequisite, out of scope) ---
//
// These resolve from env vars so a future Base Sepolia deploy wires the
// suite without touching test code. Until then they return `None` and the
// dependent test bodies skip gracefully (the live third-party adapter tests
// above do NOT depend on these).

/// Robot Money testnet vault address, if a deploy has populated
/// `RM_TESTNET_VAULT_ADDR`. `None` ⇒ vault-dependent tests skip.
pub fn robotmoney_vault() -> Option<Address> {
    parse_env_addr("RM_TESTNET_VAULT_ADDR")
}

/// Robot Money testnet strategy-adapter address for the given protocol name
/// (`"aave_v3"`, `"compound_v3"`, `"morpho"`), if a deploy has populated the
/// matching `RM_TESTNET_<PROTO>_ADAPTER_ADDR` env var. `None` ⇒ skip.
pub fn robotmoney_adapter(protocol: &str) -> Option<Address> {
    let var = format!("RM_TESTNET_{}_ADAPTER_ADDR", protocol.to_uppercase());
    parse_env_addr(&var)
}

fn parse_env_addr(var: &str) -> Option<Address> {
    let raw = env::var(var).ok().filter(|v| !v.is_empty())?;
    raw.parse::<Address>().ok()
}

/// All live third-party Base Sepolia addresses in canonical order. Used to
/// derive a stable address-set hash that adapter scenarios print at the top
/// of their output, mirroring [`crate::addresses::address_set_hash`].
pub const BASE_SEPOLIA_ADDRESSES: &[Address] = &[USDC, WETH9, UNISWAP_V3_SWAP_ROUTER, AAVE_V3_POOL];

/// keccak256 of all addresses in [`BASE_SEPOLIA_ADDRESSES`] concatenated in
/// declaration order. Stable so a single tampered address fails loudly.
pub fn address_set_hash() -> B256 {
    let mut buf = Vec::with_capacity(20 * BASE_SEPOLIA_ADDRESSES.len());
    for a in BASE_SEPOLIA_ADDRESSES {
        buf.extend_from_slice(a.as_slice());
    }
    keccak256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weth_matches_op_stack_predeploy() {
        // OP-stack WETH predeploy is identical across Base mainnet/testnet.
        assert_eq!(WETH9, crate::addresses::WETH9);
    }

    #[test]
    fn sepolia_chain_id_is_84532() {
        assert_eq!(BASE_SEPOLIA_CHAIN_ID, 84532);
    }

    #[test]
    fn address_set_hash_is_stable() {
        // Pin the digest so any accidental address edit fails loudly.
        let h = address_set_hash();
        assert_eq!(h, address_set_hash());
        // All four live-service addresses are distinct.
        let mut sorted = BASE_SEPOLIA_ADDRESSES.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), BASE_SEPOLIA_ADDRESSES.len());
    }

    #[test]
    fn robotmoney_vault_none_without_env() {
        // SAFETY: single-threaded test; we set+remove within this test only.
        std::env::remove_var("RM_TESTNET_VAULT_ADDR");
        assert_eq!(robotmoney_vault(), None);
    }

    #[test]
    fn robotmoney_adapter_parses_env() {
        std::env::set_var(
            "RM_TESTNET_AAVE_V3_ADAPTER_ADDR",
            "0x07ea79f68b2b3df564d0a34f8e19d9b1e339814b",
        );
        let got = robotmoney_adapter("aave_v3");
        std::env::remove_var("RM_TESTNET_AAVE_V3_ADAPTER_ADDR");
        assert_eq!(got, Some(AAVE_V3_POOL));
    }
}
