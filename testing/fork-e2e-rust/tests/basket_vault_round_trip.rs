//! Canonical: Plan tracking issue #109 §"Multi-vault devnet" line 280
//! (`[ ] Fork e2e: multi-vault round-trip including basket vaults`).
//!
//! End-to-end round-trip through `ProtocolAssetVault` and `AgentTokenVault`
//! against a live forked Base block. Both vaults are deployed transiently on
//! the fork (they are not yet deployed on Base) so the test exercises
//! the real basket-vault deposit/withdrawal logic — weighted-swap deposit and
//! proportional-sell redemption — against genuine Base Uniswap V3 pool
//! state and real TWAP oracle data.
//!
//! ## Test structure
//!
//! For each basket vault:
//!  1. Deploy the vault contract on the fork with the test account as admin.
//!  2. Add one Base asset with a deep Uniswap V3 USDC pool (cbBTC for
//!     ProtocolAssetVault, wETH for AgentTokenVault) so the basket is non-empty.
//!  3. Approve USDC → deposit → assert shares > 0.
//!  4. Redeem → assert net USDC delta within exitFeeBps + maxSlippageBps +
//!     10 bps slack + 1 wei rounding.
//!
//! ## Why one asset per vault
//!
//! The fork-e2e test uses a single asset per vault to keep the scenario
//! focused and fast: adding a second asset requires the TWAP oracle to have
//! ≥ 2 observation slots on that pool, and the pool cardinality check in
//! `BasketVault.addAsset` rejects pools with cardinality < 2. The single-
//! asset path fully exercises the deposit allocation and proportional-sell
//! code paths because `n=1` means 100% of the deposit is swapped into one
//! token and 100% is sold back on redemption.
//!
//! ## Skip behaviour
//!
//! The test is gated with `skip_if_no_devnet_fork!()` — it exits cleanly
//! when `RMPC_FORK_RPC_URL` is unset so contributors without an archive RPC
//! can still run `cargo test`.

use alloy_primitives::{Address, U256};
use rmpc_fork_e2e::{
    addresses, scenarios, skip_if_no_devnet_fork, ForkFixture, IBasketVault, IERC20,
};

// 50 USDC (6 decimals).
const DEPOSIT_USDC: u64 = 50_000_000;

// ── ABI-encode constructor arguments ─────────────────────────────────────────

/// ABI-encode the eight constructor arguments shared by both basket vault
/// subclasses. Each `address` is left-padded to 32 bytes; each `uint256`
/// is 32 bytes big-endian.
///
/// Constructor signature (BasketVault subclasses):
///   `(address usdc_, address swapRouter_, uint256 tvlCap_,
///     uint256 perDepositCap_, uint256 exitFeeBps_, address feeRecipient_,
///     address admin_, address emergencyResponder_)`
#[allow(clippy::too_many_arguments)]
fn encode_basket_constructor(
    usdc: Address,
    swap_router: Address,
    tvl_cap: U256,
    per_deposit_cap: U256,
    exit_fee_bps: U256,
    fee_recipient: Address,
    admin: Address,
    emergency_responder: Address,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(8 * 32);

    fn push_addr(buf: &mut Vec<u8>, a: Address) {
        buf.extend_from_slice(&[0u8; 12]);
        buf.extend_from_slice(a.as_slice());
    }
    fn push_u256(buf: &mut Vec<u8>, v: U256) {
        buf.extend_from_slice(&v.to_be_bytes::<32>());
    }

    push_addr(&mut buf, usdc);
    push_addr(&mut buf, swap_router);
    push_u256(&mut buf, tvl_cap);
    push_u256(&mut buf, per_deposit_cap);
    push_u256(&mut buf, exit_fee_bps);
    push_addr(&mut buf, fee_recipient);
    push_addr(&mut buf, admin);
    push_addr(&mut buf, emergency_responder);

    buf
}

// ── Generic basket vault round-trip helper ─────────────────────────────────────

/// Deploy a basket vault contract, add one asset to it, and perform a
/// full deposit → redeem round-trip. Asserts:
///  - shares minted > 0
///  - maxRedeem > 0 immediately after deposit
///  - net USDC loss ≤ exitFeeBps + maxSlippageBps + 10 bps slack + 1 wei
///
/// Parameters:
///  `fx`            — running fork fixture
///  `contract_name` — Forge artifact name (`"ProtocolAssetVault"` or
///                    `"AgentTokenVault"`)
///  `asset_token`   — basket asset ERC-20 address
///  `asset_pool`    — Uniswap V3 pool pairing `asset_token` with USDC
///  `asset_fee`     — Uniswap V3 fee tier (e.g. 500 for 0.05%)
///  `label`         — display label for assertion messages
fn basket_round_trip(
    fx: &ForkFixture,
    contract_name: &str,
    asset_token: Address,
    asset_pool: Address,
    asset_fee: u32,
    label: &str,
) {
    // ── Fund test account ──────────────────────────────────────────────
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let deposit = U256::from(DEPOSIT_USDC);

    // Extra ETH for deployment + addAsset + approve + deposit + redeem gas.
    let admin = fx
        .ephemeral(one_eth * U256::from(10u64), deposit)
        .expect("fund admin ephemeral");

    eprintln!(
        "[basket_vault_round_trip/{label}] admin={:#x} deposit={deposit}",
        admin.address
    );

    // ── Sanity: funded USDC ────────────────────────────────────────────
    let usdc_before = scenarios::usdc_read_u256(
        fx,
        &admin,
        &IERC20::balanceOfCall {
            account: admin.address,
        },
    )
    .expect("USDC.balanceOf before");
    assert!(
        usdc_before >= deposit,
        "[{label}] USDC funding failed: {usdc_before} < {deposit}"
    );

    // ── Build initcode: bytecode + ABI-encoded constructor args ────────
    // Caps: 10M USDC TVL, 1M USDC per-deposit, 0 exit fee (simplifies
    // tolerance arithmetic). Admin = test account so it can call addAsset.
    let tvl_cap = U256::from(10_000_000u64) * U256::from(1_000_000u64); // 10M USDC
    let per_deposit_cap = U256::from(1_000_000u64) * U256::from(1_000_000u64); // 1M USDC
    let exit_fee_bps = U256::ZERO;

    let ctor_args = encode_basket_constructor(
        addresses::USDC,
        addresses::UNISWAP_V3_SWAP_ROUTER,
        tvl_cap,
        per_deposit_cap,
        exit_fee_bps,
        admin.address, // fee recipient
        admin.address, // admin — receives ADMIN_ROLE, can call addAsset
        admin.address, // emergency responder
    );

    // Core 1808: the basket vault is a governed proxy. Its `initialize(InitParams, timelock, mode)` takes
    // the old constructor words first (InitParams is an all-static struct, so it encodes inline).
    let vault_addr = rmpc_fork_e2e::governed::deploy_governed(
        &admin,
        &format!("{contract_name}.sol"),
        contract_name,
        &ctor_args,
        8_000_000,
    )
    .expect("deploy basket vault");
    eprintln!("[basket_vault_round_trip/{label}] vault deployed at {vault_addr:#x}");

    // ── Verify: vault.asset() == USDC ──────────────────────────────────
    let asset_bytes = admin
        .call(vault_addr, &IBasketVault::assetCall {})
        .expect("vault.asset()");
    let asset_addr = Address::from_slice(&asset_bytes[12..32]);
    assert_eq!(
        asset_addr,
        addresses::USDC,
        "[{label}] vault.asset() must be USDC"
    );

    // ── Add basket asset (admin role held by test account) ─────────────
    // venue_ = 0 corresponds to BasketVault.Venue.V3 (Uniswap V3 default path).
    let add_call = IBasketVault::addAssetCall {
        token_: asset_token,
        pool_: asset_pool,
        swapFee_: alloy_primitives::Uint::<24, 1>::from(asset_fee as u64),
        adapter_: Address::ZERO, // address(0) = built-in Uniswap V3 path
        venue_: 0u8,             // Venue.V3
    };
    admin
        .send(vault_addr, &add_call, U256::ZERO, 500_000)
        .expect("addAsset");

    // Confirm asset was registered.
    let active_bytes = admin
        .call(vault_addr, &IBasketVault::activeAssetCountCall {})
        .expect("activeAssetCount");
    let active_count = scenarios::decode_u256(&active_bytes).expect("decode activeAssetCount");
    assert_eq!(
        active_count,
        U256::from(1u64),
        "[{label}] expected 1 active asset after addAsset"
    );

    // ── Approve USDC → basket vault ────────────────────────────────────
    scenarios::approve_usdc(&admin, vault_addr, deposit).expect("approve USDC");

    // ── Deposit ────────────────────────────────────────────────────────
    scenarios::basket_deposit(&admin, vault_addr, deposit, admin.address).expect("basket deposit");

    // ── Assert shares > 0 ─────────────────────────────────────────────
    let shares = scenarios::basket_read_u256(
        &admin,
        vault_addr,
        &IBasketVault::balanceOfCall {
            account: admin.address,
        },
    )
    .expect("vault.balanceOf");
    assert!(
        shares > U256::ZERO,
        "[{label}] no shares minted after deposit"
    );
    eprintln!("[basket_vault_round_trip/{label}] shares minted: {shares}");

    // ── Assert maxRedeem > 0 immediately after deposit ─────────────────
    let max_redeem = scenarios::basket_read_u256(
        &admin,
        vault_addr,
        &IBasketVault::maxRedeemCall {
            owner: admin.address,
        },
    )
    .expect("vault.maxRedeem");
    assert!(
        max_redeem > U256::ZERO,
        "[{label}] maxRedeem returned 0 right after deposit"
    );

    // ── Redeem ────────────────────────────────────────────────────────
    let to_redeem = if max_redeem < shares {
        max_redeem
    } else {
        shares
    };
    scenarios::basket_redeem(&admin, vault_addr, to_redeem, admin.address, admin.address)
        .expect("basket redeem");

    // ── Assert net USDC delta within tolerance ─────────────────────────
    let usdc_after = scenarios::usdc_read_u256(
        fx,
        &admin,
        &IERC20::balanceOfCall {
            account: admin.address,
        },
    )
    .expect("USDC.balanceOf after redeem");

    let exit_fee =
        scenarios::basket_read_u256(&admin, vault_addr, &IBasketVault::exitFeeBpsCall {})
            .expect("exitFeeBps");

    let max_slippage =
        scenarios::basket_read_u256(&admin, vault_addr, &IBasketVault::maxSlippageBpsCall {})
            .expect("maxSlippageBps");

    let loss = usdc_before - usdc_after;
    // Tolerance: (exitFeeBps + maxSlippageBps + 10 bps slack) × deposit / 10_000 + 1 wei.
    // BasketVault.previewRedeem guarantees at least TWAP × (1 - maxSlippageBps) × (1 - exitFeeBps);
    // actual swap proceeds may differ from TWAP within maxSlippageBps so we allow the full band.
    let tolerance_bps = exit_fee + max_slippage + U256::from(10u64);
    let max_allowed = deposit * tolerance_bps / U256::from(10_000u64) + U256::from(1u64);

    assert!(
        loss <= max_allowed,
        "[{label}] net USDC loss {loss} > allowed {max_allowed} \
         (exitFeeBps={exit_fee} maxSlippageBps={max_slippage} deposit={deposit})"
    );

    eprintln!(
        "[basket_vault_round_trip/{label}] OK: shares={shares} loss={loss} \
         max_allowed={max_allowed}"
    );
}

// ── Test entrypoints ──────────────────────────────────────────────────────────

/// Full deposit/withdrawal round-trip through `ProtocolAssetVault` and
/// `AgentTokenVault` against a live forked Base block.
///
/// Requires `RMPC_FORK_RPC_URL` + anvil on PATH. Skips cleanly when
/// the archive RPC is not configured.
#[test]
fn basket_vault_round_trip() {
    skip_if_no_devnet_fork!();

    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[basket_vault_round_trip] {}", fx.summary_line());

    // ── ProtocolAssetVault: single asset = cbBTC/USDC (0.05% fee) ─────
    // cbBTC is the highest-TVL ProtocolAssetVault basket asset and its
    // Uniswap V3 pool on Base is heavily traded with high TWAP cardinality.
    basket_round_trip(
        &fx,
        "ProtocolAssetVault",
        addresses::CBBTC,
        addresses::BASKET_PROTO_POOL_CBBTC,
        addresses::BASKET_PROTO_POOL_CBBTC_FEE,
        "ProtocolAssetVault/cbBTC",
    );

    // ── AgentTokenVault: single asset = wETH/USDC (0.05% fee) ─────────
    // The old JUNO/USDC leg was removed from the launch shortlist (no usable pool: its
    // TWAP cardinality is far below the guard's floor). The launch asset, RM, trades
    // on a Uniswap V4 pool that needs the V4 adapter and recorder, which this harness
    // does not deploy. The wETH/USDC V3 pool exercises the same BasketVault
    // deposit/redeem path with real Base liquidity and TWAP history.
    basket_round_trip(
        &fx,
        "AgentTokenVault",
        addresses::WETH9,
        addresses::POOL_WETH_USDC,
        500,
        "AgentTokenVault/wETH",
    );
}
