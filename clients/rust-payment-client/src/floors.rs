//! Canonical: docs/architecture.md §9 — Client Preflight
//!
//! `floors` layer module: the slippage floor and the gateway gas floors that
//! more than one command needs. A command module never imports from a sibling
//! command module (`commands::boundary_tests`), so an item two commands share
//! lives here.

use alloy_primitives::U256;

/// The default floor sits this far under `previewRedeem(shares)`, in basis
/// points (0.50%): the tolerance the dapp's router deposit and router redeem
/// use. ERC-4626 has `redeem` pay at least `previewRedeem` in the same block,
/// so the floor binds only on a move between the preflight read and
/// inclusion, such as a dragged TWAP on a basket leg (core 1793).
pub const DEFAULT_FLOOR_TOLERANCE_BPS: u64 = 50;

/// The default floor for a redemption whose `previewRedeem(shares)` is
/// `preview`: the preview less [`DEFAULT_FLOOR_TOLERANCE_BPS`], rounded
/// down. Split into quotient and remainder so no product can overflow.
pub fn floor_from_preview(preview: U256) -> U256 {
    let denom = U256::from(10_000u64);
    let keep = U256::from(10_000u64 - DEFAULT_FLOOR_TOLERANCE_BPS);
    (preview / denom) * keep + (preview % denom) * keep / denom
}

/// Gateway `withdrawFromRouter` entry floor: fixed part
/// (`ROUTER_WITHDRAW_BASE_GAS`) in gas.
pub const ROUTER_WITHDRAW_BASE_GAS: u64 = 400_000;
/// Gateway entry floor per non-zero leg (`ROUTER_WITHDRAW_GAS_PER_LEG`).
pub const ROUTER_WITHDRAW_GAS_PER_LEG: u64 = 1_850_000;

/// Gateway entry floor for a `withdrawFromRouter` with `legs` legs.
pub fn router_withdraw_gas_floor(legs: usize) -> u64 {
    ROUTER_WITHDRAW_BASE_GAS.saturating_add(ROUTER_WITHDRAW_GAS_PER_LEG.saturating_mul(legs as u64))
}
