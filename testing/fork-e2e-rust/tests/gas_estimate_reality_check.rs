//! Canonical: docs/implementation-plan.md §8 — scenario 3
//! (`gas_estimate_reality_check`).
//!
//! Executes the deposit path against the deployed vault and
//! asserts actual gas used falls inside a documented budget.
//! Manually-triggered / post-merge per ADR §3.4 because gas
//! budgets shift with EIP changes and base-fee dynamics, and a
//! tighter budget should be a deliberate review-time discussion
//! not an unrelated-PR-blocker.
//!
//! Budgets are conservative upper bounds — the goal is to catch
//! a 2x regression, not a 10% drift.

use alloy_primitives::U256;
use rmpc_fork_e2e::{addresses, scenarios, skip_if_no_fork, ForkFixture};

const DEPOSIT_USDC: u64 = 50_000_000;

/// Conservative ceiling for the ERC-20 approve gas.
const MAX_GAS_APPROVE: u64 = 80_000;

/// Conservative ceiling for the vault deposit gas. The real
/// deposit traverses the strategy adapters and may rebalance —
/// 700k leaves headroom over the typical observed cost.
const MAX_GAS_DEPOSIT: u64 = 700_000;

/// Conservative ceiling for the vault redeem gas.
const MAX_GAS_REDEEM: u64 = 1_100_000;

#[test]
fn gas_estimate_reality_check() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[gas_estimate_reality_check] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let amount = U256::from(DEPOSIT_USDC);
    let user = fx
        .ephemeral(one_eth * U256::from(5u64), amount)
        .expect("fund ephemeral");

    let approve_r = scenarios::approve_usdc(&user, addresses::VAULT, amount).expect("approve");
    assert!(
        approve_r.gas_used <= MAX_GAS_APPROVE,
        "approve gasUsed {} exceeded budget {MAX_GAS_APPROVE}",
        approve_r.gas_used
    );

    let dep_r = scenarios::vault_deposit(&user, amount, user.address).expect("deposit");
    assert!(
        dep_r.gas_used <= MAX_GAS_DEPOSIT,
        "deposit gasUsed {} exceeded budget {MAX_GAS_DEPOSIT}",
        dep_r.gas_used
    );

    let shares = scenarios::vault_read_u256(
        &fx,
        &user,
        &rmpc_fork_e2e::IRobotMoneyVault::balanceOfCall {
            account: user.address,
        },
    )
    .expect("Vault.balanceOf");
    let max_redeem = scenarios::vault_read_u256(
        &fx,
        &user,
        &rmpc_fork_e2e::IRobotMoneyVault::maxRedeemCall {
            owner: user.address,
        },
    )
    .expect("Vault.maxRedeem");
    let redeem_amt = if max_redeem < shares {
        max_redeem
    } else {
        shares
    };
    let red_r =
        scenarios::vault_redeem(&user, redeem_amt, user.address, user.address).expect("redeem");
    assert!(
        red_r.gas_used <= MAX_GAS_REDEEM,
        "redeem gasUsed {} exceeded budget {MAX_GAS_REDEEM}",
        red_r.gas_used
    );
}
