//! Canonical: docs/implementation-plan.md §8 — issue #363 (devnet adapter
//! round-trip).
//!
//! Verifies that the real Aave V3, Compound V3, and Morpho adapters
//! registered with `RobotMoneyVault` on the forked Base mainnet each
//! correctly mediate a deposit → withdraw round-trip:
//!
//! 1. Fund an ephemeral wallet with forked USDC.
//! 2. Approve and deposit into the vault.
//! 3. Assert share receipt > 0.
//! 4. Redeem the deposited shares and assert USDC returned within
//!    the exit-fee tolerance.
//!
//! Exercises the full protocol path: USDC → vault → adapter →
//! Aave/Compound/Morpho pool → back to user. This requires a live
//! mainnet fork so the external protocol state is available.

use alloy_primitives::{Address, U256};
use rmpc_fork_e2e::{
    addresses, scenarios, skip_if_no_mainnet_fork, ForkFixture, IRobotMoneyVault, IERC20,
};

const DEPOSIT_USDC: u64 = 50_000_000; // 50 USDC (6 decimals)

/// Deposit into the vault and redeem through the real adapter stack.
/// The vault on the forked Base mainnet has all three adapters registered;
/// funds flow into the active adapters on each deposit. We assert:
/// - shares minted > 0
/// - maxRedeem > 0 immediately after deposit
/// - net USDC loss after redeem ≤ exitFeeBps + 10 bps slack + 1 wei
#[test]
fn devnet_adapter_round_trip() {
    // Requires a live Base mainnet fork — protocol storage (Aave pool,
    // Morpho vault, Compound Comet) must exist at the pinned block.
    skip_if_no_mainnet_fork!();

    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[devnet_adapter_round_trip] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deposit = U256::from(DEPOSIT_USDC);

    let user = fx
        .ephemeral(one_eth * U256::from(5u64), deposit)
        .expect("fund ephemeral");

    // Sanity: funded USDC balance matches the request.
    let usdc_before = scenarios::usdc_read_u256(
        &fx,
        &user,
        &IERC20::balanceOfCall {
            account: user.address,
        },
    )
    .expect("USDC.balanceOf before");
    assert!(
        usdc_before >= deposit,
        "pre-funding failed: USDC={usdc_before} < deposit={deposit}"
    );

    // Confirm the vault has real adapters registered (sanity guard so a
    // misconfigured fork doesn't silently succeed with a passthrough).
    let adapter_count =
        scenarios::vault_read_u256(&fx, &user, &IRobotMoneyVault::activeAdapterCountCall {})
            .expect("vault.activeAdapterCount");
    assert!(
        adapter_count >= U256::from(3u64),
        "vault must have ≥3 active adapters for devnet round-trip; got {adapter_count}"
    );

    // Verify the vault asset is USDC (sanity guard).
    let vault_asset_bytes = user
        .call(addresses::VAULT, &IRobotMoneyVault::assetCall {})
        .expect("vault.asset");
    assert_eq!(
        vault_asset_bytes.len(),
        32,
        "asset() return should be 32 bytes (ABI-encoded address)"
    );
    let asset_addr = Address::from_slice(&vault_asset_bytes[12..32]);
    assert_eq!(asset_addr, addresses::USDC, "vault.asset must be USDC");

    // Approve vault, deposit, assert shares.
    scenarios::approve_usdc(&user, addresses::VAULT, deposit).expect("approve");
    scenarios::vault_deposit(&user, deposit, user.address).expect("deposit");

    let shares = scenarios::vault_read_u256(
        &fx,
        &user,
        &IRobotMoneyVault::balanceOfCall {
            account: user.address,
        },
    )
    .expect("vault.balanceOf after deposit");
    assert!(shares > U256::ZERO, "no rmUSDC minted after deposit");

    let max_redeem = scenarios::vault_read_u256(
        &fx,
        &user,
        &IRobotMoneyVault::maxRedeemCall {
            owner: user.address,
        },
    )
    .expect("vault.maxRedeem");
    assert!(
        max_redeem > U256::ZERO,
        "maxRedeem returned 0 immediately after deposit"
    );

    let to_redeem = if max_redeem < shares {
        max_redeem
    } else {
        shares
    };
    scenarios::vault_redeem(&user, to_redeem, user.address, user.address).expect("redeem");

    let usdc_after = scenarios::usdc_read_u256(
        &fx,
        &user,
        &IERC20::balanceOfCall {
            account: user.address,
        },
    )
    .expect("USDC.balanceOf after redeem");

    let exit_fee_bps = scenarios::vault_read_u256(&fx, &user, &IRobotMoneyVault::exitFeeBpsCall {})
        .expect("exitFeeBps");

    let loss = usdc_before - usdc_after;
    // Allow exitFeeBps + 10 bps slack on the deposit, plus 1 wei rounding.
    let max_allowed =
        (deposit * (exit_fee_bps + U256::from(10u64))) / U256::from(10_000u64) + U256::from(1u64);
    assert!(
        loss <= max_allowed,
        "net USDC loss {loss} > allowed {max_allowed} \
        (exitFeeBps={exit_fee_bps}, deposit={deposit})"
    );

    eprintln!(
        "[devnet_adapter_round_trip] OK: shares={shares} loss={loss} \
        max_allowed={max_allowed} adapter_count={adapter_count}"
    );
}
