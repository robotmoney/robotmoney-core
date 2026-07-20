//! Canonical: Plan tracking issue #109 §8 — scenario 1
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

use alloy_primitives::{Address, U256};
use rmpc_fork_e2e::{scenarios, ForkFixture, IRobotMoneyVault, IERC20};

const DEPOSIT_USDC: u64 = 1_000_000; // 1 USDC (6 decimals)

#[test]
fn vault_deposit_redeem_smoke() {
    // The golden contains production vault state plus deterministic USDC funding.
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[vault_deposit_redeem_smoke] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deposit = U256::from(DEPOSIT_USDC);
    let vault = fixture_vault();
    fx.rpc()
        .evm_increase_time(24 * 60 * 60)
        .expect("advance past deposit-entry limiter window");

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

    // Approve the fixture vault, deposit, then assert shares were actually minted.
    scenarios::approve_usdc(&user, vault, deposit).expect("approve fixture vault");
    scenarios::vault_deposit_at(&user, vault, deposit, user.address).expect("deposit");

    let shares = scenarios::vault_read_u256_at(
        &user,
        vault,
        &IRobotMoneyVault::balanceOfCall {
            account: user.address,
        },
    )
    .expect("Vault.balanceOf after deposit");
    assert!(shares > U256::ZERO, "no vault shares minted after deposit");

    let max_redeem = scenarios::vault_read_u256_at(
        &user,
        vault,
        &IRobotMoneyVault::maxRedeemCall {
            owner: user.address,
        },
    )
    .expect("Vault.maxRedeem");
    assert!(
        max_redeem > U256::ZERO,
        "Vault.maxRedeem returned zero after deposit"
    );
    let to_redeem = if max_redeem < shares {
        max_redeem
    } else {
        shares
    };
    scenarios::vault_redeem_at(&user, vault, to_redeem, user.address, user.address)
        .expect("redeem");

    let usdc_after = scenarios::usdc_read_u256(
        &fx,
        &user,
        &IERC20::balanceOfCall {
            account: user.address,
        },
    )
    .expect("USDC.balanceOf after redeem");
    let exit_fee_bps =
        scenarios::vault_read_u256_at(&user, vault, &IRobotMoneyVault::exitFeeBpsCall {})
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

fn fixture_vault() -> Address {
    if let Ok(value) = std::env::var("RMPC_FIXTURE_VAULT") {
        return value.parse().expect("RMPC_FIXTURE_VAULT address");
    }
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../deployments/full-stack.json");
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("read full-stack deployment"))
            .expect("parse full-stack deployment");
    value["vault"]
        .as_str()
        .expect("deployment vault")
        .parse()
        .expect("deployment vault address")
}
