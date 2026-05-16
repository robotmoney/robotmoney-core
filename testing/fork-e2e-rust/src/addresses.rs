//! Canonical: docs/technical/smart-contracts.md §2 (Base mainnet
//! deployed addresses) and docs/technical/fork-e2e-decisions.md §3.1
//! (chain target = Base mainnet).
//!
//! Hard-coded contract addresses for the Phase 2 fork harness.
//! Every address here is verified against the source of truth in
//! `docs/technical/smart-contracts.md`. The `address_set_hash`
//! helper lets the harness print a stable digest of the full
//! address set so accidental drift is loud (see ADR §3.2).

use alloy_primitives::{address, keccak256, Address, B256};

/// `RobotMoneyVault` (ERC-4626) — canonical Robot Money product
/// vault on Base mainnet. asset = USDC, share token symbol =
/// rmUSDC.
pub const VAULT: Address = address!("4f835c9f54bcf17daf9040f60cb72951ccbb49dd");

/// USDC on Base mainnet (Circle's native USDC).
pub const USDC: Address = address!("833589fcd6edb6e08f4c7c32d4f71b54bda02913");

/// Morpho strategy adapter registered with [`VAULT`].
pub const MORPHO_ADAPTER: Address = address!("a6ed7b03bc82d7c6d4ac4feb971a06550a7817e9");

/// Aave V3 strategy adapter registered with [`VAULT`].
pub const AAVE_V3_ADAPTER: Address = address!("218695bdab0fe4f8d0a8ee590bc6f35820fc0bea");

/// Compound V3 strategy adapter registered with [`VAULT`].
pub const COMPOUND_V3_ADAPTER: Address = address!("8247da22a59fce074c102431048d0ce7294c2652");

/// Admin / fee-recipient Safe multisig.
pub const ADMIN_SAFE: Address = address!("88ba7364cc6ce5054981d571b33f8fb3e91475a0");

// -- Protocol-level contract addresses (Base mainnet) -----------------
// These are the underlying protocol contracts that the Robot Money
// strategy adapters delegate to. Used by Deploy.s.sol when deploying
// fresh adapter instances against a new vault (e.g. smoke-test devnet).

/// Aave V3 Pool on Base mainnet. Used by [`AAVE_V3_ADAPTER`] and by
/// Deploy.s.sol to construct new AaveV3Adapter instances.
pub const AAVE_V3_POOL: Address = address!("a238dd80c259a72e81d7e4664a9801593f98d1c5");

/// aBasUSDC — Aave V3 interest-bearing USDC token on Base. Held by
/// AaveV3Adapter instances as the receipt token for supplied USDC.
pub const AAVE_V3_A_TOKEN: Address = address!("4e65fe4dba92790696d040ac24aa414708f5c0ab");

/// Morpho Gauntlet USDC Prime ERC-4626 vault on Base. The underlying
/// yield venue for [`MORPHO_ADAPTER`] and newly deployed MorphoAdapter
/// instances.
pub const MORPHO_GAUNTLET_USDC_PRIME: Address =
    address!("c1256ae5ff1cf2719d4937adb3bbccab2e00a2ca");

/// Compound V3 (Comet) USDC market on Base. The underlying venue for
/// [`COMPOUND_V3_ADAPTER`] and newly deployed CompoundV3Adapter instances.
/// Verified against `cast call <compound-adapter> "COMET()(address)"` on Base mainnet.
pub const COMPOUND_V3_COMET: Address = address!("b125e6687d4313864e53df431d5425969c15eb2f");

/// USDC whale on Base used for funding ephemeral test accounts via
/// `anvil_impersonateAccount`. This address holds a large enough
/// USDC balance to cover all per-test funding amounts at any
/// reasonable fork pin.
///
/// Source: known Aave-V3 USDC reserve / lending pool address on
/// Base. Picked over Coinbase / Circle treasury addresses because
/// it has stable, predictable balance through fork-block refresh
/// cadence (a lending pool's USDC sits there as protocol state,
/// not user inflow/outflow). If a future pin makes this whale dry,
/// the runbook in the README documents how to swap it.
pub const USDC_WHALE: Address = address!("0b25c51637c43decd6cc1c1e3da4518d54ddb528");

/// Uniswap V3 SwapRouter02 on Base. Used by the `dex_route_smoke`
/// scenario; not a Robot Money contract, but pinning it here keeps
/// the address surface in one place.
pub const UNISWAP_V3_SWAP_ROUTER: Address = address!("2626664c2603336e57b271c5c0b26f421741e481");

/// WETH9 on Base. Used as the intermediate token in the smallest
/// useful DEX route smoke (USDC -> WETH).
pub const WETH9: Address = address!("4200000000000000000000000000000000000006");

/// All Robot Money contract addresses in canonical order. Used to
/// derive the address-set hash that scenarios print at the top of
/// their output (ADR §3.2).
pub const ROBOTMONEY_ADDRESSES: &[Address] = &[
    VAULT,
    MORPHO_ADAPTER,
    AAVE_V3_ADAPTER,
    COMPOUND_V3_ADAPTER,
    ADMIN_SAFE,
];

/// Re-export the ROBOTMONEY_ADDRESSES list together with USDC and
/// WETH9 — the full surface tested by the harness.
pub const BASE_ADDRESSES: &[Address] = &[
    VAULT,
    MORPHO_ADAPTER,
    AAVE_V3_ADAPTER,
    COMPOUND_V3_ADAPTER,
    ADMIN_SAFE,
    USDC,
    WETH9,
    UNISWAP_V3_SWAP_ROUTER,
];

/// keccak256 of all addresses in [`BASE_ADDRESSES`] concatenated in
/// declaration order. Stable so a single tampered address fails
/// loudly even if the test for that one address still incidentally
/// passes.
pub fn address_set_hash() -> B256 {
    let mut buf = Vec::with_capacity(20 * BASE_ADDRESSES.len());
    for a in BASE_ADDRESSES {
        buf.extend_from_slice(a.as_slice());
    }
    keccak256(&buf)
}
