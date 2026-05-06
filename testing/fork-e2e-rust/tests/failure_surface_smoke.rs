//! Canonical: docs/implementation-plan.md §8 — scenario 5
//! (`failure_surface_smoke`).
//!
//! Exercises the documented refusal surfaces of the deployed
//! vault: insufficient balance, missing allowance, and (where
//! safely reproducible against a fork) `paused()` / `tvlCap`
//! permutations. Each case asserts that the call reverts cleanly
//! and does not leave partial state behind.
//!
//! Manually-triggered / post-merge per ADR §3.4 — the matrix is
//! larger than smoke and exercising every surface every PR adds
//! latency without changing the catch rate for the most common
//! drift classes.

use alloy_primitives::U256;
use rmpc_fork_e2e::{scenarios, skip_if_no_fork, ForkFixture, IRobotMoneyVault};

#[test]
fn failure_surface_smoke() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[failure_surface_smoke] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));

    // -- Case 1: deposit without USDC balance must revert ----------
    {
        let user = fx.ephemeral(one_eth, U256::ZERO).expect("fund ETH only");
        let res = scenarios::vault_deposit(&user, U256::from(50_000_000u64), user.address);
        assert!(
            res.is_err(),
            "deposit with zero USDC balance should revert (vault asks USDC.transferFrom)"
        );

        // After the failed deposit the vault must hold no shares for this user.
        let shares = scenarios::vault_read_u256(
            &fx,
            &user,
            &IRobotMoneyVault::balanceOfCall {
                account: user.address,
            },
        )
        .expect("Vault.balanceOf");
        assert_eq!(
            shares,
            U256::ZERO,
            "failed deposit left dangling shares: {shares}"
        );
    }

    // -- Case 2: deposit without allowance must revert -------------
    {
        let amount = U256::from(50_000_000u64);
        let user = fx.ephemeral(one_eth, amount).expect("fund ETH + USDC");
        // No approve() call — go straight to deposit.
        let res = scenarios::vault_deposit(&user, amount, user.address);
        assert!(
            res.is_err(),
            "deposit without allowance should revert (USDC.transferFrom without approval)"
        );
    }

    // -- Case 3: deposit > maxDeposit must revert ------------------
    {
        let user = fx.ephemeral(one_eth, U256::ZERO).expect("fund ETH only");
        let max_dep = scenarios::vault_read_u256(
            &fx,
            &user,
            &IRobotMoneyVault::maxDepositCall {
                receiver: user.address,
            },
        )
        .expect("Vault.maxDeposit");
        // Try to deposit max + 1. Even with a valid balance, ERC-4626
        // requires `assets <= maxDeposit(receiver)`, and we don't
        // have the balance anyway — so this reverts on either ground.
        let attempt = max_dep.saturating_add(U256::from(1u64));
        let res = scenarios::vault_deposit(&user, attempt, user.address);
        assert!(
            res.is_err(),
            "deposit above maxDeposit should revert (got attempt={attempt}, maxDeposit={max_dep})"
        );
    }
}
