//! Canonical: docs/implementation-plan.md §8 — scenario 2
//! (`dex_route_smoke`).
//!
//! Smallest meaningful DEX interaction: USDC -> WETH single-hop
//! exact-input swap on the live Uniswap V3 SwapRouter02 against
//! the pinned fork's pool state. Manually-triggered / post-merge
//! per ADR §3.4 because DEX state is more volatile than vault
//! state and a route failure should not block unrelated PRs.

use alloy_primitives::{Address, U256};
use alloy_sol_types::sol;
use rmpc_fork_e2e::{addresses, scenarios, skip_if_no_fork, ForkFixture, IERC20};

sol! {
    /// Subset of Uniswap V3 SwapRouter02 we exercise. Selector
    /// matches the deployed router.
    interface ISwapRouter {
        struct ExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint24 fee;
            address recipient;
            uint256 amountIn;
            uint256 amountOutMinimum;
            uint160 sqrtPriceLimitX96;
        }
        function exactInputSingle(ExactInputSingleParams calldata params)
            external payable returns (uint256 amountOut);
    }
}

const SWAP_USDC: u64 = 100_000_000; // 100 USDC

#[test]
fn dex_route_smoke() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[dex_route_smoke] {}", fx.summary_line());

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    let amount = U256::from(SWAP_USDC);
    let user = fx
        .ephemeral(one_eth, amount)
        .expect("fund ephemeral with ETH + USDC");

    // Approve the router to pull our USDC.
    scenarios::approve_usdc(&user, addresses::UNISWAP_V3_SWAP_ROUTER, amount)
        .expect("approve router");

    // exactInputSingle with the conservative 0.05% pool (fee=500),
    // amountOutMinimum=1 wei (we only assert non-zero output here —
    // slippage envelope assertion is out of scope for the smoke).
    let params = ISwapRouter::ExactInputSingleParams {
        tokenIn: addresses::USDC,
        tokenOut: addresses::WETH9,
        fee: alloy_primitives::Uint::<24, 1>::from(500u64),
        recipient: user.address,
        amountIn: amount,
        amountOutMinimum: U256::from(1u64),
        sqrtPriceLimitX96: alloy_primitives::Uint::<160, 3>::from(0u64),
    };
    let call = ISwapRouter::exactInputSingleCall { params };
    user.send(
        addresses::UNISWAP_V3_SWAP_ROUTER,
        &call,
        U256::ZERO,
        600_000,
    )
    .expect("router.exactInputSingle");

    // Assert WETH balance went up.
    let weth_balance =
        read_erc20_balance(&user, addresses::WETH9, user.address).expect("WETH.balanceOf");
    assert!(
        weth_balance > U256::ZERO,
        "DEX swap completed but WETH balance is zero — route or pool drift"
    );

    // And USDC went down by exactly `amount` (router pulls full amountIn).
    let usdc_balance =
        read_erc20_balance(&user, addresses::USDC, user.address).expect("USDC.balanceOf");
    assert_eq!(
        usdc_balance,
        U256::ZERO,
        "USDC balance after swap = {usdc_balance}, expected 0 (router should pull full amountIn)"
    );
}

fn read_erc20_balance(
    user: &rmpc_fork_e2e::Account<'_>,
    token: Address,
    holder: Address,
) -> Result<U256, rmpc_fork_e2e::HarnessError> {
    let bytes = user.call(token, &IERC20::balanceOfCall { account: holder })?;
    scenarios::decode_u256(&bytes)
}
