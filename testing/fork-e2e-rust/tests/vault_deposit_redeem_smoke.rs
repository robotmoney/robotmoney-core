//! Canonical: docs/implementation-plan.md §8 — scenario 1
//! (`vault_deposit_redeem_smoke`).
//!
//! End-to-end smoke through the deployed `RobotMoneyVault` ERC-4626:
//! fund an ephemeral wallet with forked USDC, approve the vault,
//! deposit, read back share balance, redeem all redeemable shares,
//! and assert net USDC delta stays within the configured
//! `exitFeeBps` plus a small rounding tolerance.
//!
//! This is the load-bearing PR-time scenario per ADR §3.4 — without
//! it, ABI/address checks alone could miss silent revert behavior
//! changes in the deployed bytecode.

use alloy_primitives::U256;
use rmpc_fork_e2e::{addresses, scenarios, skip_if_no_fork, ForkFixture, IRobotMoneyVault, IERC20};

const DEPOSIT_USDC: u64 = 50_000_000; // 50 USDC (6 decimals)

#[test]
fn vault_deposit_redeem_smoke() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[vault_deposit_redeem_smoke] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deposit = U256::from(DEPOSIT_USDC);

    let user = fx
        .ephemeral(one_eth * U256::from(5u64), deposit)
        .expect("fund ephemeral");

    // Sanity: funded USDC balance is what we asked for.
    let usdc_before = scenarios::usdc_read_u256(
        &fx,
        &user,
        &IERC20::balanceOfCall {
            account: user.address,
        },
    )
    .expect("USDC.balanceOf");
    assert!(
        usdc_before >= deposit,
        "funding failed: USDC={usdc_before} < deposit={deposit}"
    );

    // Approve vault, deposit, then assert shares minted.
    scenarios::approve_usdc(&user, addresses::VAULT, deposit).expect("approve");
    scenarios::vault_deposit(&user, deposit, user.address).expect("deposit");

    let shares = scenarios::vault_read_u256(
        &fx,
        &user,
        &IRobotMoneyVault::balanceOfCall {
            account: user.address,
        },
    )
    .expect("Vault.balanceOf");
    assert!(shares > U256::ZERO, "no rmUSDC minted after deposit");

    // Redeem maxRedeem (vault may cap below the user's full share
    // balance for liquidity reasons; redeeming the cap is the
    // adversarial case for share accounting).
    let max_redeem = scenarios::vault_read_u256(
        &fx,
        &user,
        &IRobotMoneyVault::maxRedeemCall {
            owner: user.address,
        },
    )
    .expect("Vault.maxRedeem");
    assert!(
        max_redeem > U256::ZERO,
        "Vault.maxRedeem returned 0 right after a successful deposit"
    );
    let to_redeem = if max_redeem < shares {
        max_redeem
    } else {
        shares
    };

    scenarios::vault_redeem(&user, to_redeem, user.address, user.address).expect("redeem");

    // Net loss must respect exitFeeBps + small rounding tolerance.
    let usdc_after = scenarios::usdc_read_u256(
        &fx,
        &user,
        &IERC20::balanceOfCall {
            account: user.address,
        },
    )
    .expect("USDC.balanceOf after");
    let exit_fee_bps = scenarios::vault_read_u256(&fx, &user, &IRobotMoneyVault::exitFeeBpsCall {})
        .expect("exitFeeBps");

    let loss = usdc_before - usdc_after;
    // (exitFeeBps + 10 bps slack) on the deposit, plus 1 wei rounding.
    let max_allowed =
        (deposit * (exit_fee_bps + U256::from(10u64))) / U256::from(10_000u64) + U256::from(1u64);
    assert!(
        loss <= max_allowed,
        "net USDC loss {loss} > allowed {max_allowed} (exitFeeBps={exit_fee_bps})"
    );
}
