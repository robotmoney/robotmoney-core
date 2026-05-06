//! Canonical: docs/implementation-plan.md §4.7 — Fee policy
//!
//! `fees` — EIP-1559 fee policy.
//!
//! Per `docs/implementation-plan.md` §3.7 and issue #12. The daemon
//! always builds EIP-1559 transactions; legacy `gasPrice` selection is
//! intentionally not supported. Per-invocation behaviour:
//!
//! - Read `eth_feeHistory` for the last `N` blocks (5 in the MVP).
//! - `priorityFee = max(p50_reward, 1 gwei)` — a 1 gwei floor keeps the
//!   tx attractive to miners on quiet chains where the median tip is 0.
//! - `maxFeePerGas = min(2 * baseFeeNext + priorityFee, cap)`.
//! - If the *uncapped* `2 * baseFeeNext + priorityFee` already exceeds
//!   `cap`, the daemon refuses to broadcast with `ErrFeeCapExceeded` —
//!   the cap is operator policy, not best-effort. Silently clamping
//!   would broadcast a tx with a fee floor that may be too low for the
//!   current base fee, producing a stuck pending tx.
//!
//! This module is pure: it takes a [`FeeHistory`] (already fetched by
//! the caller via [`crate::rpc::RpcClient::fee_history`]) and a cap
//! and returns [`FeeBid`]. No I/O, easy to unit-test against canned
//! responses.

use alloy_rpc_types::FeeHistory;

use crate::errors::{Result, RmpcError};

/// 1 gwei in wei.
pub const ONE_GWEI: u128 = 1_000_000_000;

/// Minimum priority fee floor — 1 gwei. See module docs.
pub const PRIORITY_FEE_FLOOR_WEI: u128 = ONE_GWEI;

/// Reward percentile used to pick the priority fee. The MVP uses the
/// median (`p50`); operators on chains with bursty mempools can revisit.
pub const PRIORITY_FEE_PERCENTILE: f64 = 50.0;

/// EIP-1559 fee bid produced by [`compute_fees`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeBid {
    /// `maxFeePerGas` in wei.
    pub max_fee_per_gas: u128,
    /// `maxPriorityFeePerGas` (a.k.a. tip) in wei.
    pub max_priority_fee_per_gas: u128,
}

/// Compute an EIP-1559 fee bid from a `FeeHistory` response and the
/// operator-configured caps (in wei).
///
/// `fee_history` is expected to have been fetched with
/// `reward_percentiles = [50.0]`; the median of the per-block rewards is
/// used as the tip. If `reward` is missing or empty, the floor
/// (`PRIORITY_FEE_FLOOR_WEI`) is used.
///
/// The "next block" base fee is the *last* entry of
/// `base_fee_per_gas`: `eth_feeHistory` returns `N+1` base fees where
/// the trailing entry is the predicted base fee for the block after
/// `newestBlock`.
///
/// Returns [`RmpcError::ErrFeeCapExceeded`] when either:
/// - the observed median priority fee exceeds `priority_cap_wei`, OR
/// - `2 * baseFeeNext + priorityFee > max_fee_cap_wei`.
///
/// Both ceilings are operator policy: clamping silently could broadcast
/// a tx that's stuck in the mempool because the priority/total fee is
/// too low for the current congestion. Refusing surfaces it as a
/// stable named error.
pub fn compute_fees(
    fee_history: &FeeHistory,
    max_fee_cap_wei: u128,
    priority_cap_wei: u128,
) -> Result<FeeBid> {
    let base_fee_next = base_fee_for_next_block(fee_history)?;
    let priority_fee = priority_fee_from_history(fee_history);

    // Audit M3: refuse when the observed network tip already exceeds
    // the operator's policy ceiling.
    if priority_fee > priority_cap_wei {
        return Err(RmpcError::ErrFeeCapExceeded);
    }

    // Saturating because `2 * baseFee + tip` could in principle overflow
    // a u128 only on absurd networks; we'd still treat that as
    // cap-exceeded.
    let target = base_fee_next.saturating_mul(2).saturating_add(priority_fee);

    if target > max_fee_cap_wei {
        return Err(RmpcError::ErrFeeCapExceeded);
    }

    Ok(FeeBid {
        max_fee_per_gas: target,
        max_priority_fee_per_gas: priority_fee,
    })
}

/// Last entry of `base_fee_per_gas` is the predicted base fee for the
/// block after the newest one.
fn base_fee_for_next_block(fh: &FeeHistory) -> Result<u128> {
    fh.base_fee_per_gas
        .last()
        .copied()
        .ok_or_else(|| RmpcError::ErrRpcDecode("eth_feeHistory: empty base_fee_per_gas".into()))
}

/// Median of the per-block rewards at the `[50.0]` percentile, with a
/// 1-gwei floor. We took the request shape on faith — the caller passes
/// `[50.0]` to `eth_feeHistory` — so each block has exactly one reward
/// entry. We sort and take the middle to avoid being skewed by a single
/// outlier block.
fn priority_fee_from_history(fh: &FeeHistory) -> u128 {
    let Some(rewards) = fh.reward.as_ref() else {
        return PRIORITY_FEE_FLOOR_WEI;
    };
    let mut tips: Vec<u128> = rewards
        .iter()
        .filter_map(|row| row.first().copied())
        .collect();
    if tips.is_empty() {
        return PRIORITY_FEE_FLOOR_WEI;
    }
    tips.sort_unstable();
    let median = tips[tips.len() / 2];
    median.max(PRIORITY_FEE_FLOOR_WEI)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fh(base_fees: &[u128], rewards: &[u128]) -> FeeHistory {
        FeeHistory {
            oldest_block: 1,
            base_fee_per_gas: base_fees.to_vec(),
            base_fee_per_blob_gas: vec![],
            blob_gas_used_ratio: vec![],
            gas_used_ratio: vec![0.5; base_fees.len().saturating_sub(1)],
            reward: Some(rewards.iter().map(|r| vec![*r]).collect()),
        }
    }

    #[test]
    fn happy_path_uses_predicted_base_fee_and_median_tip() {
        // 5 historical blocks plus the predicted next base fee = 30 gwei.
        // Tips (per-block, p50): 1, 2, 3, 4, 5 gwei. Median = 3 gwei.
        // maxFee = 2 * 30 + 3 = 63 gwei.
        let g = ONE_GWEI;
        let base: Vec<u128> = [10, 12, 14, 18, 22, 30].iter().map(|x| x * g).collect();
        let rewards: Vec<u128> = [1, 2, 3, 4, 5].iter().map(|x| x * g).collect();
        let history = fh(&base, &rewards);
        let bid = compute_fees(&history, 100 * g, u128::MAX).unwrap();
        assert_eq!(bid.max_priority_fee_per_gas, 3 * g);
        assert_eq!(bid.max_fee_per_gas, 63 * g);
    }

    #[test]
    fn priority_fee_has_one_gwei_floor() {
        // All historical tips are 0; we must still bid 1 gwei so the tx
        // gets included on quiet chains.
        let history = fh(&[5 * ONE_GWEI, 5 * ONE_GWEI], &[0]);
        let bid = compute_fees(&history, 100 * ONE_GWEI, u128::MAX).unwrap();
        assert_eq!(bid.max_priority_fee_per_gas, ONE_GWEI);
        // 2*5 + 1 = 11 gwei
        assert_eq!(bid.max_fee_per_gas, 11 * ONE_GWEI);
    }

    #[test]
    fn missing_rewards_falls_back_to_floor() {
        let history = FeeHistory {
            oldest_block: 1,
            base_fee_per_gas: vec![5 * ONE_GWEI, 5 * ONE_GWEI],
            base_fee_per_blob_gas: vec![],
            blob_gas_used_ratio: vec![],
            gas_used_ratio: vec![0.5],
            reward: None,
        };
        let bid = compute_fees(&history, 100 * ONE_GWEI, u128::MAX).unwrap();
        assert_eq!(bid.max_priority_fee_per_gas, ONE_GWEI);
    }

    #[test]
    fn cap_exceeded_refuses_with_named_error() {
        // Cap is 1 wei; computed maxFee will dwarf it. This is the
        // load-bearing operator-policy assertion.
        let history = fh(&[5 * ONE_GWEI, 5 * ONE_GWEI], &[ONE_GWEI]);
        let err = compute_fees(&history, 1, u128::MAX).unwrap_err();
        assert!(matches!(err, RmpcError::ErrFeeCapExceeded), "got {err:?}");
    }

    #[test]
    fn cap_at_target_accepts() {
        // baseFeeNext = 5 gwei, tip = 1 gwei → target = 11 gwei. Cap at
        // exactly the target must accept (boundary is inclusive).
        let history = fh(&[5 * ONE_GWEI, 5 * ONE_GWEI], &[ONE_GWEI]);
        let bid = compute_fees(&history, 11 * ONE_GWEI, u128::MAX).unwrap();
        assert_eq!(bid.max_fee_per_gas, 11 * ONE_GWEI);
    }

    #[test]
    fn priority_cap_exceeded_refuses_with_named_error() {
        // Audit M3: priority cap is 2 gwei but observed median tip is 5 gwei.
        let history = fh(&[5 * ONE_GWEI, 5 * ONE_GWEI], &[5 * ONE_GWEI]);
        let err = compute_fees(&history, 100 * ONE_GWEI, 2 * ONE_GWEI).unwrap_err();
        assert!(matches!(err, RmpcError::ErrFeeCapExceeded), "got {err:?}");
    }

    #[test]
    fn priority_cap_at_observed_tip_accepts() {
        // Boundary is inclusive: cap == observed tip must succeed.
        let history = fh(&[5 * ONE_GWEI, 5 * ONE_GWEI], &[3 * ONE_GWEI]);
        let bid = compute_fees(&history, 100 * ONE_GWEI, 3 * ONE_GWEI).unwrap();
        assert_eq!(bid.max_priority_fee_per_gas, 3 * ONE_GWEI);
    }

    #[test]
    fn empty_base_fees_is_decode_error() {
        let history = FeeHistory {
            oldest_block: 0,
            base_fee_per_gas: vec![],
            base_fee_per_blob_gas: vec![],
            blob_gas_used_ratio: vec![],
            gas_used_ratio: vec![],
            reward: None,
        };
        let err = compute_fees(&history, 100 * ONE_GWEI, u128::MAX).unwrap_err();
        assert!(matches!(err, RmpcError::ErrRpcDecode(_)), "got {err:?}");
    }
}
