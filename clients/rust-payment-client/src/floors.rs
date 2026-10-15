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

/// Headroom above a gateway entry floor for intrinsic tx gas, calldata and the reads the entry
/// function makes before it checks the floor (the router's effective weights, the policy). None of
/// those is counted by the floor.
const GAS_MARGIN: u64 = 150_000;

/// The tx gas limit that makes a gateway entry floor hold. The gateway is an ERC-1967 proxy, and
/// a call forwards at most 63/64 of the gas it holds (EIP-150), so the implementation sees about
/// 1/64 less than the limit before it runs: at a 9.8M limit that is 150k, as much as the whole
/// margin. A limit of `floor + 150k` therefore reverted `InsufficientGas(9540386, 9650000)` on the
/// Twin chain for five router legs. The limit is the floor grossed up by 64/63, plus the margin.
pub fn default_gas_limit_for_floor(floor: u64) -> u64 {
    floor
        .saturating_add(floor / 63 + 1)
        .saturating_add(GAS_MARGIN)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the Twin chain measured for five router legs (core 1808 proxy hop): the implementation
    /// held 9,540,386 gas at the entry check of a 9.8M limit, 78,227 of which it had spent reading
    /// the router's weights first, so a limit needs to leave at least floor + 78k + that 1/64.
    #[test]
    fn default_limit_leaves_the_floor_after_the_proxy_hop_and_the_entry_reads() {
        let floor = router_withdraw_gas_floor(5);
        assert_eq!(floor, 9_650_000);
        let needed = (floor + 78_227) as f64 * 64.0 / 63.0 + 24_000.0;
        assert!(default_gas_limit_for_floor(floor) as f64 >= needed);
        assert!(default_gas_limit_for_floor(floor) > 9_800_000);
        assert_eq!(default_gas_limit_for_floor(u64::MAX), u64::MAX);
    }
}
