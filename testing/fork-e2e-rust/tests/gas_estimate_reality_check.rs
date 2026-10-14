//! Canonical: Plan tracking issue #109 §8 — scenario 3
//! (`gas_estimate_reality_check`).
//!
//! Executes the deposit path against the deployed vault and
//! asserts actual gas used falls inside a documented budget.
//! It runs in suite 05's `anvil-devnet-adapters` slot on every
//! ready PR and every push to `dev` (issue 1656; it had silently
//! skipped before). Gas budgets shift with EIP changes and strategy
//! rewrites, so a budget moves only by a deliberate edit here.
//!
//! The approve and redeem budgets are conservative upper bounds: they
//! catch a 2x regression, not a 10% drift. The deposit budget is tight
//! (the measured cost plus about 10%, issue 1683), so a deposit
//! regression above about 10% is red.
//!
//! Each leg prints `[gas_estimate_reality_check] <leg> gasUsed=N
//! budget=M` after its assertion passes. Suite 05 lists the deposit
//! line in `required_markers` (QA plan T3), so a run where the deposit
//! assertion never executed is red even when the slot's other tests
//! keep the executed count up.

use alloy_primitives::U256;
use rmpc_fork_e2e::{scenarios, skip_if_no_devnet_fork, ForkFixture};

const DEPOSIT_USDC: u64 = 50_000_000;

/// Conservative ceiling for the ERC-20 approve gas.
const MAX_GAS_APPROVE: u64 = 80_000;

/// Tight ceiling for the vault deposit gas. The real deposit traverses the strategy adapters and
/// may rebalance. Issue 1656 made this test actually run in CI (it had silently skipped) and
/// measured 833,900 gas on the current vault, above the old 700k; 1656 then raised the ceiling to
/// 1,000,000, which a regression of up to about 20% would still pass. Issue 1683 (owner decision
/// D6 in the QA plan): 920,000 is the measured cost plus about 10%. A deliberate deposit-path
/// change that costs more raises this number in the same change, citing the new
/// `deposit gasUsed=` line from CI.
const MAX_GAS_DEPOSIT: u64 = 920_000;

/// Conservative ceiling for the vault redeem gas.
const MAX_GAS_REDEEM: u64 = 1_100_000;

#[test]
fn gas_estimate_reality_check() {
    skip_if_no_devnet_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[gas_estimate_reality_check] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let amount = U256::from(DEPOSIT_USDC);
    let user = fx
        .ephemeral(one_eth * U256::from(5u64), amount)
        .expect("fund ephemeral");

    let approve_r = scenarios::approve_usdc(&user, fx.vault(), amount).expect("approve");
    assert!(
        approve_r.gas_used <= MAX_GAS_APPROVE,
        "approve gasUsed {} exceeded budget {MAX_GAS_APPROVE}",
        approve_r.gas_used
    );
    eprintln!(
        "\n[gas_estimate_reality_check] approve gasUsed={} budget={MAX_GAS_APPROVE}",
        approve_r.gas_used
    );

    let dep_r =
        scenarios::vault_deposit_at(&user, fx.vault(), amount, user.address).expect("deposit");
    assert!(
        dep_r.gas_used <= MAX_GAS_DEPOSIT,
        "deposit gasUsed {} exceeded budget {MAX_GAS_DEPOSIT}",
        dep_r.gas_used
    );
    // Required marker (suite 05 `anvil-devnet-adapters`): printed only after the deposit
    // assertion passed, on its own line, so the executed-test guard's line-start match sees it.
    eprintln!(
        "\n[gas_estimate_reality_check] deposit gasUsed={} budget={MAX_GAS_DEPOSIT}",
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
        scenarios::vault_redeem_at(&user, fx.vault(), redeem_amt, user.address, user.address)
            .expect("redeem");
    assert!(
        red_r.gas_used <= MAX_GAS_REDEEM,
        "redeem gasUsed {} exceeded budget {MAX_GAS_REDEEM}",
        red_r.gas_used
    );
    eprintln!(
        "\n[gas_estimate_reality_check] redeem gasUsed={} budget={MAX_GAS_REDEEM}",
        red_r.gas_used
    );
}
